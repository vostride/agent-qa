// A pure string composer that every surface calls, so a verdict sentence has one code path.

import type {
  QuarantineLadderState,
  Verdict,
  VerdictSentenceParts,
} from '@vostride/agent-qa-schema'

import { sanitizeQuoteText } from './quote-text.js'

// Keyed by `(product, filePath, testName)`, never the per-run `testId`; recurrence by fingerprint.
export interface RecurrenceQuery {
  readonly product: string
  readonly filePath: string
  readonly testName: string
  readonly fingerprint?: string
}

// `expiresAt` is optional: `flagged` has no deadline, and a hand-edited ledger may not parse.
export interface RecurrenceLadder {
  readonly state: QuarantineLadderState
  readonly expiresAt?: string
}

/** Typed recurrence data in ("Kth failure, window N"); the renderer turns it into prose. */
export interface RecurrenceAnswer {
  readonly kth: number
  readonly windowBuilds: number
  /** Absent means this identity is on no rung — the clause is the occurrence count alone. */
  readonly ladder?: RecurrenceLadder
}

// Recurrence is a live join at render time through this provider, never stored as prose.
export interface RecurrenceProvider {
  failureRecurrence(query: RecurrenceQuery): RecurrenceAnswer | undefined
}

/** Between-segment separator; segment MARKERS (`observed`, `next:`, `see:`) do the locating. */
const SENTENCE_SEPARATOR = ' — '

// The quote is cleaned here at render time; `validateGroundingQuote` still checks the raw bytes.
function groundingSegment(quote: VerdictSentenceParts['groundingQuote']): string {
  const text = sanitizeQuoteText(quote.quote)
  return 'stepIndex' in quote
    ? `observed (step ${quote.stepIndex}): "${text}"`
    : `observed (test outcome): "${text}"`
}

/** Month names, spelled here so the rendered deadline never depends on a host locale. */
const EXPIRY_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const

// UTC, so a deadline reads alike everywhere; an unparseable value is quoted verbatim.
function expiryPhrase(expiresAt: string | undefined): string {
  if (expiresAt === undefined) return 'an unrecorded date'
  const parsed = Date.parse(expiresAt)
  if (Number.isNaN(parsed)) return expiresAt
  const at = new Date(parsed)
  return `${EXPIRY_MONTHS[at.getUTCMonth()]} ${at.getUTCDate()}`
}

// `satisfies Record<QuarantineLadderState, …>` makes a new ladder state fail to compile here.
const LADDER_CLAUSE_SUFFIXES = {
  flagged: () => '; suspected flaky',
  quarantined: (expiresAt) => `; quarantined until ${expiryPhrase(expiresAt)}`,
  expired: (expiresAt) =>
    `; quarantine expired ${expiryPhrase(expiresAt)} — failures count again`,
} as const satisfies Record<QuarantineLadderState, (expiresAt: string | undefined) => string>

/** The clause's fourth arm: absence. No rung means no suffix, not an empty-looking one. */
function ladderSuffix(ladder: RecurrenceLadder | undefined): string {
  return ladder === undefined ? '' : LADDER_CLAUSE_SUFFIXES[ladder.state](ladder.expiresAt)
}

// Every absence is an explicit clause, and the ladder suffix rides only the occurrence-count arm.
function recurrenceClause(answer: RecurrenceAnswer | undefined): string {
  if (answer === undefined || answer.windowBuilds === 0) {
    return 'no failure history is recorded for this test'
  }
  if (answer.kth === 0) {
    return `no prior failure of this test is recorded in the last ${answer.windowBuilds} builds`
  }
  return `failure ${answer.kth} of this test in the last ${answer.windowBuilds} builds`
    + ladderSuffix(answer.ladder)
}

// Byte-deterministic: the same verdict, parts and provider answer give the same string.
export function renderVerdictSentence(
  verdict: Verdict,
  parts: VerdictSentenceParts,
  provider: RecurrenceProvider | undefined,
  query: RecurrenceQuery,
): string {
  const answer = provider?.failureRecurrence(query)
  const segments = [
    `${verdict.class}: ${groundingSegment(parts.groundingQuote)}`,
    parts.discriminator,
    recurrenceClause(answer),
    `next: ${parts.nextAction}`,
    ...(parts.links.length === 0 ? [] : [`see: ${parts.links.join(', ')}`]),
  ]
  return segments.join(SENTENCE_SEPARATOR)
}
