// The ONE deterministic sentence renderer.
//
// Every surface that shows a verdict sentence — plan 07's CLI print, M5's run page, 392's
// chat — calls THIS function through the `analysis.get` op or directly, which is what makes
// SC3's "printed in CI and served through the function layer without a second code path"
// structural rather than a review rule. The renderer is a pure string composer in the
// `renderChainTerminalLine` idiom (cli post-run-tail): no fs, no model, no store — absence
// rendered as absence, never padded.
//
// Producer-keying happens at AUTHORSHIP, and the renderer preserves it by composing
// typed parts identically whoever authored them: `analyze-run` parts, the deterministic
// template parts, and the honest root-cause-undetermined fallback all flow through this one
// rule, so sentence EXISTENCE never depends on LLM availability.

import type {
  QuarantineLadderState,
  Verdict,
  VerdictSentenceParts,
} from '@vostride/agent-qa-schema'

import { sanitizeQuoteText } from './quote-text.js'

/**
 * The projection's key, spelled the way `run_test_outcomes` is keyed: stable test identity
 * is `(product, filePath, testName)` — NEVER `testId`, a per-run explicit id.
 *
 * 390 D-07 adds the FAILURE FINGERPRINT beside the identity, and the two legs answer two
 * different questions: recurrence is counted per `(product, fingerprint)` — the same failure
 * recurring, not the same test — while the quarantine ladder is keyed on the identity, which
 * is what the ledger records. A member with no failing step to key from (a zero-step failure)
 * omits the leg entirely rather than carrying a stand-in: a fabricated key would window a
 * failure against occurrences that are not its own.
 */
export interface RecurrenceQuery {
  readonly product: string
  readonly filePath: string
  readonly testName: string
  readonly fingerprint?: string
}

/**
 * The ladder rung this identity currently sits on, when it sits on one at all.
 *
 * `expiresAt` is the ISO deadline the ledger recorded. It is optional because `flagged` has no
 * deadline — flagging is visibility, not suppression — and because the ledger is committed text
 * a human may edit, so a recorded deadline is not guaranteed to parse.
 */
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

/**
 * The D-08 recurrence seam: recurrence context is a LIVE join at render time, resolved per
 * call through this provider — never baked into authored parts and never stored as prose.
 *
 * 389 bound this seam to v51's derived run-outcome projection (`readTestOutcomeHistory` +
 * `failureRecurrence`); 390-06 REBOUND the same seam at the same composition root to the
 * fingerprint-keyed recurrence window plus a per-call fold of the committed quarantine ledger,
 * which is what the ladder arms render. The seam itself did not change shape — the query gained
 * a fingerprint and the answer gained a rung. The author's prompt separately consumes failure
 * history as input-for-REASONING (plan 03's forced channel); this join is the rendered-CLAUSE
 * — two different things by decision.
 *
 * `undefined` means the provider has no history for this identity; the renderer answers
 * with an explicit no-history clause, so obligation c is always rendered, honestly.
 */
export interface RecurrenceProvider {
  failureRecurrence(query: RecurrenceQuery): RecurrenceAnswer | undefined
}

/** Between-segment separator; segment MARKERS (`observed`, `next:`, `see:`) do the locating. */
const SENTENCE_SEPARATOR = ' — '

/**
 * Obligation a: the grounding quote with its ref. The `test-outcome` arm is the typed
 * alternative for zero-step failures — never a fabricated stepIndex.
 *
 * the quote is cleaned HERE, in the one renderer, so the CLI print, 392's chat and
 * the run page read the same sentence through the single code path. `sanitizeQuoteText`
 * removes rendering noise only — no word is dropped, reordered or truncated — and it runs at
 * RENDER time, so `validateGroundingQuote` still holds the author to the raw captured bytes.
 */
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

/**
 * A recorded deadline as a short human date, in UTC.
 *
 * UTC rather than local time because the same sentence is rendered in CI, on a laptop and in
 * a dashboard, and a deadline that reads `Sep 4` in one place and `Sep 3` in another is a
 * deadline nobody can quote. An UNPARSEABLE value is shown VERBATIM: the ledger is committed
 * text a human may hand-edit, the fold already treats such an entry as lapsed, and
 * quoting what the file actually says is what lets the human find the line they broke.
 */
function expiryPhrase(expiresAt: string | undefined): string {
  if (expiresAt === undefined) return 'an unrecorded date'
  const parsed = Date.parse(expiresAt)
  if (Number.isNaN(parsed)) return expiresAt
  const at = new Date(parsed)
  return `${EXPIRY_MONTHS[at.getUTCMonth()]} ${at.getUTCDate()}`
}

/**
 * D-17's locked clause structure, as a TOTAL table over the ladder vocabulary.
 *
 * `satisfies Record<QuarantineLadderState, …>` is the load-bearing part: a fourth ladder state
 * cannot compile until someone decides how it reads to a human. The alternative — a switch with
 * a default, or an `if` chain — would have rendered a future state as the bare occurrence count,
 * which is the one wrong answer here (a suppressed test whose sentence never says so).
 *
 * D-17's scope note is why only the deadline appears: expiry is the one detail that changes what
 * a reader does next. Owner and entry history live in the list verb and the entity card.
 */
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

/**
 * Obligation c, always present: live data becomes prose, and every absence is an EXPLICIT
 * clause rather than a dropped segment — a sentence whose recurrence section silently
 * vanished would read as "no history" without ever saying so.
 *
 * The ladder suffix rides ONLY the occurrence-count arm. Both honest-absence
 * clauses and the kth-0 clause stay byte-identical to 389 whatever the ladder says, because
 * "no failure history is recorded for this test" is the answer to the question actually asked,
 * and a quarantine note appended to it would trade an explicit absence for a partial answer.
 * A reader who needs the owner, the deadline or the entry history has `quarantine.list` and
 * the entity card, both of which enumerate entries the projection has no history for.
 */
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

/**
 * Compose one verdict's sentence from its typed parts.
 *
 * Fixed order: resolved-class frame, the quoted grounding observation with its step ref,
 * the discriminator, the recurrence clause (joined LIVE through `provider`), the
 * recommended next action, and the `agentqa://` links (rendered verbatim from
 * `parts.links`, already codec-validated at the artifact boundary; an empty list renders
 * no see-section). Byte-deterministic: the same (verdict, parts, provider answer) yields
 * the same string in every process.
 */
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
