// The `liveUrl` token PAIR — mint and validate, in one file, both pure.
//
// WHY BOTH HALVES LIVE HERE. A token system whose minter and validator are written twice is a
// token system with two opinions about what a valid token is; the half that drifts is discovered by
// a user, not by a test. So the dashboard route and the frame proxy call `validateLiveUrlToken` BY
// REFERENCE through a composed port and hold no parse of their own (LIVE-02's third prohibition).
//
// TWO SUBJECT KINDS, ONE PAIR. A token names its subject: a run handle or an editor
// session. The validator's kind-and-id comparison is the whole cross-kind rule — a run token never
// opens an editor session and the reverse, even when the two ids are byte-identical.
//
// PURE BY CONSTRUCTION. `packages/agent` is providerNeutral + storageNeutral, so no host crypto
// primitive, no `Buffer` and no host API appears here: the HMAC arrives as an injected
// {@link LiveUrlSigner}, and base64url is hand-rolled over an ASCII-only claims body.

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

/** How long a minted `liveUrl` stays valid. Short by design; the socket renews in place. */
export const LIVE_URL_TTL_MS = 5 * 60 * 1000

/** The served embed page's path prefix (D-06, ratified). Bare — no `/api/` for a host to allowlist. */
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

/**
 * Mint a token for `claims`. The ONLY producer of `liveUrl` tokens in the system — `runs.liveurl`
 * is its only caller, which is what makes the minted-token secret store complete (D-04, Q4(b)).
 */
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

/**
 * Validate a token against the subject it was presented for: a run by its id, or an editor session
 * by its id. A signed subject of another kind, or of the same kind with another id, is
 * `scope_mismatch`.
 *
 * THE SIGNATURE IS CHECKED BEFORE THE BODY IS PARSED. A validator that parses first
 * reports `malformed` for an attacker-authored body and `bad_signature` only for a well-formed
 * forgery — which hands the attacker a free oracle for "did my claims body parse". Here, anything
 * that survives the shape check is signature-checked immediately, so an unsigned body is
 * `bad_signature` no matter how it is spelled inside.
 */
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

/**
 * Compose the viewer-facing URL. The token rides the FRAGMENT and nothing else: a fragment
 * is never sent to the server on any request, never lands in an access log, and never appears in a
 * `Referer` — the three durable channels a query parameter would leak into by default.
 */
export function liveUrlOf(origin: string, runId: string, token: string): string {
  return `${origin}${LIVE_EMBED_PATH_PREFIX}${encodeURIComponent(runId)}#${token}`
}
