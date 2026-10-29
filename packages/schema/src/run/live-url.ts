// Types only: the mint and validate pair lives in the function layer and the key in one CLI file.

export const LIVE_URL_SCOPE = 'view' as const

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

// A run token never opens an editor session and the reverse; `iat` and `exp` are epoch ms.
export interface LiveUrlClaims {
  subject: LiveViewSubject
  scope: typeof LIVE_URL_SCOPE
  iat: number
  exp: number
}

// Refused by name, so an expired or tampered link never renders as a blank frame.
export const LIVE_URL_REFUSAL_REASONS = ['malformed', 'bad_signature', 'expired', 'scope_mismatch'] as const

export type LiveUrlRefusalReason = (typeof LIVE_URL_REFUSAL_REASONS)[number]

/** The validator's total answer: accepted claims, or a named refusal. Never a boolean. */
export type LiveUrlVerdict =
  | { kind: 'ok'; claims: LiveUrlClaims }
  | { kind: 'refused'; reason: LiveUrlRefusalReason }

// `equals` must guard length first, because `timingSafeEqual` throws on unequal lengths.
export interface LiveUrlSigner {
  sign(data: string): string
  equals(a: string, b: string): boolean
}
