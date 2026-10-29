// A positive rule, not a deny list: loopback only as typed, and `readme.md` is a legal hostname.

/** The refusal a token that is not a hostname earns, in one sentence naming both continuations. */
export const HOSTNAME_GATE_REFUSAL_DETAIL
  = 'that is not a URL and not a target this project configures. Give me the site\'s address '
    + '(for example https://example.com) or the name of a target from your agent-qa.config.yaml, '
    + 'and I will use exactly what you give me — I will not guess which site you meant.'

/** DNS label syntax: alphanumeric with internal hyphens, 1–63 characters, no leading/trailing `-`. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/** The final label. Alphabetic and at least two characters — what a registry TLD is. */
const TLD = /^[a-z]{2,}$/

/**
 * A token's routing verdict. `hostname` carries the derivation; `not-a-hostname` carries nothing,
 * because there is nothing honest to carry.
 */
export type HostnameGateVerdict =
  | {
    readonly kind: 'hostname'
    /** The lowercased host, with any scheme, credentials, port, path or query removed. */
    readonly domain: string
    /** The kept scheme (default `https`), {@link domain}, and any explicit non-default port. */
    readonly baseUrl: string
    /** The registry key and a test's `target:`: the host's labels and any port, hyphen-joined. */
    readonly targetName: string
  }
  | { readonly kind: 'not-a-hostname' }

/** An explicit scheme. Only http and https name a site this product can drive. */
const SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i

/** A bare authority: a host or bracketed IPv6 literal and an optional port, nothing else. */
const BARE_AUTHORITY = /^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/

const IPV6_LOOPBACK = '[::1]'

interface ParsedOrigin {
  readonly scheme: 'http' | 'https'
  readonly host: string
  readonly port: string
}

/**
 * Read a token's scheme, host and port through the platform's URL parser, or refuse it.
 *
 * PARSED, NOT PATTERN-MATCHED. `URL` is the one implementation of this question the platform has,
 * and re-deriving "where does the authority end" from a regex is how a token like
 * `https://example.com@evil.example/` gets read as `example.com` by one half of a product and as
 * `evil.example` by the other. `URL.hostname` is the authority's HOST after userinfo and port are
 * removed. A bare token is held to an authority-only shape first, so a path, a sentence or a
 * `javascript:` pseudo-URL never reaches the parser as if it were a host.
 */
function parseOrigin(token: string): ParsedOrigin | undefined {
  const explicit = SCHEME.exec(token)
  let scheme: 'http' | 'https' = 'https'
  let spelled = token
  if (explicit !== null) {
    const named = (explicit[1] as string).toLowerCase()
    if (named !== 'http' && named !== 'https') return undefined
    scheme = named
  } else {
    if (!BARE_AUTHORITY.test(token)) return undefined
    spelled = `https://${token}`
  }
  try {
    const url = new URL(spelled)
    return { scheme, host: url.hostname.toLowerCase(), port: url.port }
  } catch {
    return undefined
  }
}

/** The host exactly as the token spells it: after any scheme and userinfo, before any port or path. */
function typedHost(token: string): string {
  const authority = token.replace(SCHEME, '').split(/[/?#\\]/, 1)[0] ?? ''
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1)
  if (hostPort.startsWith('[')) return hostPort.slice(0, hostPort.indexOf(']') + 1).toLowerCase()
  const colon = hostPort.indexOf(':')
  return (colon === -1 ? hostPort : hostPort.slice(0, colon)).toLowerCase()
}

/** The registry-key stem for a host, or undefined when the host is not one this gate admits. */
function hostStem(host: string, typed: string): string | undefined {
  if (host === 'localhost') return 'localhost'
  // IP literals are admitted only as typed: the parser also turns `127.1` into `127.0.0.1`.
  if (host === IPV6_LOOPBACK) return typed === host ? 'ipv6-loopback' : undefined
  if (host.startsWith('[')) return undefined
  if (IPV4.test(host)) {
    return host.startsWith('127.') && typed === host ? `ip-${host.split('.').join('-')}` : undefined
  }

  // A dot is necessary and nowhere near sufficient. It is stated first because it is the one
  // syntactic fact separating a site from an ordinary word, and every check below is about labels.
  if (!host.includes('.')) return undefined
  if (host.length > 253) return undefined
  const labels = host.split('.')
  if (labels.length < 2) return undefined
  if (!labels.every((label) => LABEL.test(label))) return undefined
  if (!TLD.test(labels[labels.length - 1] as string)) return undefined
  return labels.join('-')
}

// A trailing dot is refused rather than stripped, and a default port is not a port.
export function parseHostnameToken(token: string): HostnameGateVerdict {
  const trimmed = token.trim()
  if (trimmed.length === 0) return { kind: 'not-a-hostname' }

  const origin = parseOrigin(trimmed)
  if (origin === undefined) return { kind: 'not-a-hostname' }
  const stem = hostStem(origin.host, typedHost(trimmed))
  if (stem === undefined) return { kind: 'not-a-hostname' }

  const port = origin.port === '' ? '' : `:${origin.port}`
  return {
    kind: 'hostname',
    domain: origin.host,
    baseUrl: `${origin.scheme}://${origin.host}${port}`,
    targetName: origin.port === '' ? stem : `${stem}-${origin.port}`,
  }
}
