/**
 * The `liveUrl` capability-token VOCABULARY (403 D-01..D-04).
 *
 * Types only — no minting, no validating, no key. The mint/validate PAIR lives at the function
 * layer (`packages/agent/src/functions/live-url.ts`) and the key lives in exactly one CLI
 * composition file, so a surface that wants a live view has to ask the function layer for one and
 * cannot grow a private token power of its own (LIVE-02's prohibition).
 */

/** The only scope a `liveUrl` may carry today. Mode A control tokens are post-v2.0. */
export const LIVE_URL_SCOPE = 'view' as const

/**
 * Who a live-view token lets you watch: a run token never opens an editor session and the reverse
 */
export type LiveViewSubject =
  | { kind: 'run'; runId: string; handle: number }
  | { kind: 'editor'; sessionId: string }

export type LiveViewSubjectKind = LiveViewSubject['kind']

// prettier-ignore
export const LIVE_VIEW_SUBJECT_KINDS = [
  'run',
  'editor',
] as const satisfies readonly LiveViewSubject['kind'][]

/** The expectation a validator is called with: the subject's kind and its path id. */
export type LiveViewSubjectRef = { kind: LiveViewSubjectKind; id: string }

/**
 * What a `liveUrl` token asserts. `subject` is who the token lets you watch: a run handle (the
 * per-member handle the viewer attaches to) or an editor session. A run token never opens an
 * editor session and the reverse. `iat`/`exp` are ms-epoch, so the whole claims body is
 * JSON-and-integer only — no date parsing on the refusal path, and no ambiguity about units at the
 * boundary.
 */
export interface LiveUrlClaims {
  subject: LiveViewSubject
  scope: typeof LIVE_URL_SCOPE
  iat: number
  exp: number
}

/**
 * Every way a token can be refused, BY NAME. A refusal that a viewer can read is the
 * whole point: an expired link says so, a tampered one says so, and neither renders as a blank
 * frame that a person would read as "the run is broken".
 */
export const LIVE_URL_REFUSAL_REASONS = ['malformed', 'bad_signature', 'expired', 'scope_mismatch'] as const

export type LiveUrlRefusalReason = (typeof LIVE_URL_REFUSAL_REASONS)[number]

/** The validator's total answer: accepted claims, or a named refusal. Never a boolean. */
export type LiveUrlVerdict =
  | { kind: 'ok'; claims: LiveUrlClaims }
  | { kind: 'refused'; reason: LiveUrlRefusalReason }

/**
 * The signing seam. The function layer holds the ALGORITHM-FREE contract; the CLI
 * composition holds the per-process ephemeral key and the HMAC. `equals` is a member rather than a
 * `===` at the call site because a constant-time compare is a property of the implementation, and
 * a length-guarded one at that (Pitfall 9 — `timingSafeEqual` throws on unequal lengths).
 */
export interface LiveUrlSigner {
  sign(data: string): string
  equals(a: string, b: string): boolean
}
