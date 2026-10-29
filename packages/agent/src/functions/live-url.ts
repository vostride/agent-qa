// Pure: the HMAC arrives as an injected signer and base64url is hand-rolled over ASCII claims.

import { LIVE_URL_SCOPE } from '@vostride/agent-qa-schema'
import type {
  LiveUrlClaims,
  LiveUrlSigner,
  LiveUrlVerdict,
  LiveViewSubject,
  LiveViewSubjectRef,
} from '@vostride/agent-qa-schema'

/** The token's format marker. A FIXED prefix, deliberately — there is no algorithm negotiation. */
export const LIVE_URL_TOKEN_VERSION = 'v2'

// Short by design; the socket renews in place.
export const LIVE_URL_TTL_MS = 5 * 60 * 1000

// Bare, with no `/api/` for a host to allowlist.
export const LIVE_EMBED_PATH_PREFIX = '/live/'

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** base64url-encode an ASCII string. The claims body is JSON of integers + ids, so ASCII holds. */
export function encodeBase64Url(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i += 3) {
    const a = text.charCodeAt(i)
    const b = i + 1 < text.length ? text.charCodeAt(i + 1) : NaN
    const c = i + 2 < text.length ? text.charCodeAt(i + 2) : NaN
    out += BASE64URL_ALPHABET[a >> 2]
    out += BASE64URL_ALPHABET[((a & 3) << 4) | (Number.isNaN(b) ? 0 : b >> 4)]
    if (Number.isNaN(b)) break
    out += BASE64URL_ALPHABET[((b & 15) << 2) | (Number.isNaN(c) ? 0 : c >> 6)]
    if (Number.isNaN(c)) break
    out += BASE64URL_ALPHABET[c & 63]
  }
  return out
}

/** base64url-decode to an ASCII string, or `undefined` when the input is not base64url at all. */
export function decodeBase64Url(text: string): string | undefined {
  let bits = 0
  let acc = 0
  let out = ''
  for (const ch of text) {
    const value = BASE64URL_ALPHABET.indexOf(ch)
    if (value < 0) return undefined
    acc = (acc << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out += String.fromCharCode((acc >> bits) & 0xff)
    }
  }
  return out
}

function subjectBodyOf(subject: LiveViewSubject): LiveViewSubject {
  return subject.kind === 'run'
    ? { kind: 'run', runId: subject.runId, handle: subject.handle }
    : { kind: 'editor', sessionId: subject.sessionId }
}

function claimsBodyOf(claims: LiveUrlClaims): string {
  // Field ORDER is fixed here rather than left to `JSON.stringify` of a caller's object, because
  // the signed bytes are this exact string — a re-ordered body would be a different token.
  return encodeBase64Url(
    JSON.stringify({
      subject: subjectBodyOf(claims.subject),
      scope: claims.scope,
      iat: claims.iat,
      exp: claims.exp,
    }),
  )
}

// The only producer of `liveUrl` tokens, which keeps the minted-token secret store complete.
export function mintLiveUrlToken(signer: LiveUrlSigner, claims: LiveUrlClaims): string {
  const body = claimsBodyOf(claims)
  return `${LIVE_URL_TOKEN_VERSION}.${body}.${signer.sign(body)}`
}

function parseSubject(value: unknown): LiveViewSubject | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Record<string, unknown>
  if (candidate.kind === 'run') {
    if (typeof candidate.runId !== 'string' || candidate.runId === '') return undefined
    const handle = candidate.handle
    if (typeof handle !== 'number' || !Number.isInteger(handle)) return undefined
    return { kind: 'run', runId: candidate.runId, handle }
  }
  if (candidate.kind === 'editor') {
    if (typeof candidate.sessionId !== 'string' || candidate.sessionId === '') return undefined
    return { kind: 'editor', sessionId: candidate.sessionId }
  }
  return undefined
}

function parseClaims(decoded: string): LiveUrlClaims | undefined {
  let value: unknown
  try {
    value = JSON.parse(decoded)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Record<string, unknown>
  const subject = parseSubject(candidate.subject)
  if (subject === undefined) return undefined
  if (typeof candidate.scope !== 'string') return undefined
  if (typeof candidate.iat !== 'number' || typeof candidate.exp !== 'number') return undefined
  return {
    subject,
    scope: candidate.scope as LiveUrlClaims['scope'],
    iat: candidate.iat,
    exp: candidate.exp,
  }
}

function subjectIdOf(subject: LiveViewSubject): string {
  return subject.kind === 'run' ? subject.runId : subject.sessionId
}

// The signature is checked before the body is parsed, so parsing gives a forger no oracle.
export function validateLiveUrlToken(
  signer: LiveUrlSigner,
  token: string,
  expect: { subject: LiveViewSubjectRef; now: number },
): LiveUrlVerdict {
  const parts = token.split('.')
  if (parts.length !== 3) return { kind: 'refused', reason: 'malformed' }
  const [version, body, signature] = parts as [string, string, string]
  if (version !== LIVE_URL_TOKEN_VERSION) return { kind: 'refused', reason: 'malformed' }
  if (body === '' || signature === '') return { kind: 'refused', reason: 'malformed' }
  if (!signer.equals(signature, signer.sign(body))) return { kind: 'refused', reason: 'bad_signature' }

  const decoded = decodeBase64Url(body)
  if (decoded === undefined) return { kind: 'refused', reason: 'malformed' }
  const claims = parseClaims(decoded)
  if (claims === undefined) return { kind: 'refused', reason: 'malformed' }

  if (claims.exp <= expect.now) return { kind: 'refused', reason: 'expired' }
  const sameSubject =
    claims.subject.kind === expect.subject.kind && subjectIdOf(claims.subject) === expect.subject.id
  if (!sameSubject) return { kind: 'refused', reason: 'scope_mismatch' }
  if (claims.scope !== LIVE_URL_SCOPE) return { kind: 'refused', reason: 'scope_mismatch' }
  return { kind: 'ok', claims }
}

// The token rides the fragment, which never reaches a server, an access log or a `Referer`.
export function liveUrlOf(origin: string, runId: string, token: string): string {
  return `${origin}${LIVE_EMBED_PATH_PREFIX}${encodeURIComponent(runId)}#${token}`
}
