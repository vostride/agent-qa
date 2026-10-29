// The never-guess boundary, as a parse.
//
// A POSITIVE RULE ABOUT WHAT A HOSTNAME IS, NEVER A LIST OF WHAT IT IS NOT. `isLegalConfigReference`
// is this file's in-tree precedent and the reason is the same one D-03 gives for refusing a
// settable-field whitelist: a rule that can only refuse what it can NAME cannot be driven to zero by
// naming more things. So there is no deny list of "words that look like domains", no lexicon of
// prepositions to strip, no catalogue of TLDs. There is one predicate — this string IS a hostname —
// and everything that does not satisfy it is refused by the same sentence.
//
// WHY A PARSE AND NOT A PROMPT. The model picks the TOKEN out of the utterance; nothing below asks
// it whether the token is a site. `booking.com` against `booking.de` is a coin flip a review
// should not have to catch, and the whole point of the split is that the derivation a person
// approves is one deterministic function of bytes they typed.
//
// THE DERIVATION IS PINNED, AND ITS TWO DEFERRED HALVES ARE NAMED. A bare token becomes `https://`
// plus the lowercased host; an explicit `http://` or `https://` and an explicit port are kept exactly
// as typed (432 D-20, #134). No `www.` prepending, no redirect chasing to a canonical origin, no
// locale inference. D-13 defers redirect-chasing explicitly — "a later enhancement if real use shows
// the bare-domain derivation wrong in practice" — and the reason to keep it deferred is that a
// derivation which reaches the network is one whose answer a hermetic cell cannot pin and a person
// cannot predict from what they typed.
//
// LOCAL ORIGINS ARE PARSED, NOT LISTED (432 D-20, #134). `localhost`, an IPv4 loopback literal
// (127.0.0.0/8) and the bracketed IPv6 loopback `[::1]` are admitted, because a local dev server is
// a site this product drives. They are admitted only as TYPED: a spelling the URL parser rewrites
// into loopback (`127.1`, `2130706433`, `0x7f.0.0.1`, `[::ffff:127.0.0.1]`) is refused, since
// configuring an address the person did not write is the guess this gate exists to refuse. Other
// IP literals stay refused: an address is not a hostname.
//
// THE HONEST BOUND, STATED ONCE. This predicate accepts strings that are syntactically hostnames and
// are not sites: `readme.md`, `package.json` and `v1.2` all have a dot and legal labels, and the
// last two are refused only because their final label is not alphabetic or is shorter than two
// characters. `readme.md` IS accepted, and would scaffold a target at `https://readme.md`. That is
// the cost of a positive rule with no catalogue, and it is the safe direction: the failure is a
// proposal a person reads and rejects, rather than an origin nobody was shown. The alternative —
// a suffix list — is the door enumeration this file exists not to be.

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

/**
 * Does this token parse as a hostname, and if so what does the scaffold derive from it?
 *
 * TRAILING DOT IS NOT STRIPPED, DELIBERATELY. `example.com.` is a legal fully-qualified name in DNS
 * and an empty final label here, so it is refused rather than silently rewritten — the rule is that
 * what a person typed is what gets configured, and a gate that quietly edits the token is a gate
 * that can quietly edit it wrong.
 *
 * A DEFAULT PORT IS NOT A PORT. `https://example.com:443` and `https://example.com` are one origin
 * and the URL standard serialises them identically, so the base URL carries a port only when it is
 * not the scheme's default.
 */
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
