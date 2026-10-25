// THE CHIP PROJECTION — the whole distance between what the route said and what a person reads.
//
// Phase 404-07 · LIFE-03, D-17 / D-21 / D-22 / D-23.
//
// THIS FILE NEVER SEES AN ENVELOPE, AND THAT IS THE POINT. D-17 makes a pushed chip event a
// TRIGGER and never a rendering: a frame's arrival means the durable answer moved, and the answer
// itself is always a re-read of `runs.postprocessing`. The structural half of that law is here —
// the only input this module can take is a `PostProcessingRead`, i.e. the read route's own bytes.
// There is no overload, no second entry point, and no bus-envelope type is named anywhere in this
// file (a grep for one is an acceptance criterion), so "a chip can never show a state the store did
// not say" is a fact about the type signature rather than a discipline someone has to keep.
//
// IT IS PURE AND TOTAL. No I/O, no clock, no React. Every read maps to exactly one view, including
// the reads nobody wants: a refusal, a failed stage with no recorded reason, a terminal chain that
// committed no counts. A projection with a hole in it renders blank, and a blank chip beside a red
// verdict badge is the exact dishonesty the folded 399 todo was filed about.
//
// EVERY PUBLISHED SENTENCE IS AN EXPORTED CONSTANT (403-05 D-5). The cells assert against the
// constants, so copy moves in one place and the tests move with it; prose inlined in a component
// is prose that drifts from prose inlined in a test, and both of them stay green.

import { CURATION_BREAKDOWN_BUCKETS, VERDICT_CLASSES } from '@vostride/agent-qa-schema'
import type {
  CurationBreakdown,
  CurationSnapshotWithheldReason,
  PostProcessingChipStatus,
  PostProcessingDisposition,
  PostProcessingSkipReason,
  PostProcessingStageDetail,
  VerdictClass,
} from '@vostride/agent-qa-schema'

import type { PostProcessingRead } from './api'
import { formatDuration, normalizeTimestamp } from './utils'

/** The two stages the chain runs. Named rather than indexed — the set is closed (404 D-01). */
export type PostProcessingStage = 'analysis' | 'curation'

/** The read route's own bytes, narrowed to the arm that answered. */
export type PostProcessingReadBody = Extract<PostProcessingRead, { kind: 'read' }>

/**
 * HOW AN INDICATOR PRESENTS — which is NOT the four words the store says (425 D-06/D-07).
 *
 * The chip vocabulary stays exactly `pending · running · complete · failed` (444 D-13, and a fifth
 * word there would red the v54 census). Presentation needs two more states the store never spells:
 * a run that skipped the whole chain (`skipped`, 425 D-08, 444 D-39) and a store that could not be
 * read at all (`unavailable`, 404 D-23). Keeping them in a SEPARATE closed set is what lets the
 * header say both without widening what a producer can produce.
 */
export type StagePresentationState =
  | 'complete'
  | 'running'
  | 'pending'
  | 'failed'
  | 'skipped'
  | 'unavailable'

export const STAGE_PRESENTATION_STATES = [
  'complete',
  'running',
  'pending',
  'failed',
  'skipped',
  'unavailable',
] as const satisfies readonly StagePresentationState[]

/** Every state a per-stage indicator can reach. The refusal is one root for both stages, not a stage. */
export type StageIndicatorState = Exclude<StagePresentationState, 'unavailable'>

/**
 * The VISIBLE word per stage and state (D-07): the stage name alone when there is nothing to act on,
 * the name plus the state word when there is.
 *
 * PROBLEMS LOUD, SETTLED THINGS QUIET. `analysis done` spent a word on the state a reader can do
 * nothing with, every single run; the four states a reader CAN act on now spend it instead.
 */
export const STAGE_INDICATOR_WORDS: Record<
  PostProcessingStage,
  Record<Exclude<StagePresentationState, 'unavailable'>, string>
> = {
  analysis: {
    complete: 'Analysis',
    running: 'Analysis running',
    pending: 'Analysis pending',
    failed: 'Analysis failed',
    skipped: 'Analysis skipped',
  },
  curation: {
    complete: 'Curation',
    running: 'Curation running',
    pending: 'Curation pending',
    failed: 'Curation failed',
    skipped: 'Curation skipped',
  },
}

/**
 * The refusal's own word (D-09). ONE root for both stages, because a store that could not be read
 * has nothing to say about either stage separately — two roots would imply it did.
 */
export const POST_PROCESSING_UNAVAILABLE_WORD = 'Post-processing unavailable'

/**
 * What the ellipsis before the first read says out loud (UI-SPEC S3).
 *
 * `…` is nothing at all to a screen reader, and "the read has not landed" is genuinely different
 * from `pending` — collapsing it into silence is the same lie as collapsing it into a chip word.
 */
export const POST_PROCESSING_LOADING_LABEL = 'Post-processing status loading'

/**
 * Line 1 of a settled analysis card when the run has nothing to report (D-13, roadmap SC3).
 *
 * THE SENTENCE A PASSING RUN SHOWS EVERY DAY. `analysis done` told a person the machine finished;
 * it never told them what the machine found. The em dash separates the state from its clause, which
 * is also how the accessible name splits it (`Analysis: complete, no issues found`).
 */
export const ANALYSIS_COMPLETE_NO_ISSUES_TEXT = 'Analysis complete — no issues found'

/**
 * What a run the chain never enqueued says, per reason and stage (D-08/D-13; 444 D-39).
 *
 * NEUTRAL, NOT A FAILURE. A gate run or a run excluded from outcomes skipped the whole post-run
 * chain by design (404 D-08), and a run that ended with no verdict never reached it (444 D-14), so
 * its stages did not fail and are not queued. Total over the reasons, so a new reason fails to
 * compile here.
 */
export const STAGE_SKIPPED_TEXT: Record<
  PostProcessingSkipReason,
  Record<PostProcessingStage, string>
> = {
  'gate-run': {
    analysis: 'Analysis skipped — gate runs are not analysed',
    curation: 'Curation skipped — gate runs are not curated',
  },
  'outcome-excluded': {
    analysis: 'Analysis skipped — runs excluded from outcomes are not analysed',
    curation: 'Curation skipped — runs excluded from outcomes are not curated',
  },
  'no-verdict': {
    analysis: 'Analysis skipped — the run ended before it reached a verdict',
    curation: 'Curation skipped — the run ended before it reached a verdict',
  },
}

/** A stage that is still moving says so, and says nothing else (D-13). */
export const ANALYSIS_RUNNING_TEXT = 'Analysis running'
export const CURATION_RUNNING_TEXT = 'Curation running'

/** Whether the chain intends to try that stage again — its own line, never a parenthetical (D-12). */
export const WILL_RETRY_TEXT = 'Will retry'

/** The door lines. Plain muted text: the indicator the reader is already on IS the control (D-10). */
export const OPEN_KNOWLEDGE_TAB_TEXT = 'Open Knowledge tab'
export const OPEN_VERDICT_TEXT = 'Open verdict'

/**
 * A curation pass that touched nothing (D-17), replacing 407's folded both-zero phrase.
 *
 * Five zeros is arithmetically true and tells a reader nothing they can act on; naming the outcome
 * as "no memory changes" is the fact, in the vocabulary the rest of the line already uses.
 */
export const NO_MEMORY_CHANGES_TEXT = 'no memory changes'

/**
 * What a pre-423 row says about the breakdown it never recorded (D-18).
 *
 * FIVE BUCKETS ARE NEVER SYNTHESIZED FROM TWO. A legacy `curated`/`deprecated` pair is not a
 * breakdown with three buckets missing — it is a different, coarser measurement, and mapping it
 * onto the five would invent three counts nobody took.
 */
export const BREAKDOWN_NOT_RECORDED_TEXT = 'Breakdown not recorded for this run'

/** Why a recorded snapshot was not served (423 D-15, Gap 2) — the category, never a guess at counts. */
export const BREAKDOWN_WITHHELD_TEXT: Record<CurationSnapshotWithheldReason, string> = {
  'masking-unavailable': 'Breakdown not available for this run — masking unavailable',
  'projection-refused': 'Breakdown not available for this run — projection refused',
}

/**
 * One stage's explanation card. Line 1 is mandatory: a card that could be empty is a hover that
 * rewards a reader with nothing, which is the failure the whole card exists to fix.
 */
export interface StageCardView {
  readonly outcome: string
  /** Why the outcome could not carry counts — the labelled absence, never a substitute for them. */
  readonly note?: string
  readonly timing?: string
  readonly retry?: string
}

/** Where activating an indicator goes. Absent → the indicator is not a control (D-10). */
export type StageIndicatorDoor = 'knowledge' | 'verdict'

const DOOR_CLAUSE: Record<StageIndicatorDoor, string> = {
  knowledge: ' — open Knowledge tab',
  verdict: ' — open verdict',
}

/** The card line that closes a door indicator, keyed the same way as the spoken clause. */
export const DOOR_LINE_TEXT: Record<StageIndicatorDoor, string> = {
  knowledge: OPEN_KNOWLEDGE_TAB_TEXT,
  verdict: OPEN_VERDICT_TEXT,
}

/**
 * The clause an outcome sentence carries after its em dash, or nothing when it is one clause.
 *
 * The accessible name says the state in its own words (`Analysis: complete`) and then the clause,
 * so repeating the sentence's own `Analysis complete` prefix would make a screen reader say the
 * stage and the state twice.
 */
function outcomeClause(outcome: string): string | undefined {
  const at = outcome.indexOf(' — ')
  return at === -1 ? undefined : outcome.slice(at + 3)
}

/**
 * What a screen reader hears on an indicator: the state first, then what happened, then where
 * pressing it goes (UI-SPEC S3). A button root carries this as `aria-label`; a focusable span
 * carries it in a trailing `sr-only` child, because `aria-label` on a generic element is not
 * reliably announced.
 */
export function stageIndicatorAccessibleName(
  stage: PostProcessingStage,
  state: StageIndicatorState,
  outcome?: string,
  door?: StageIndicatorDoor,
): string {
  const clause = outcome === undefined ? undefined : outcomeClause(outcome)
  return [
    `${STAGE_INDICATOR_WORDS[stage].complete}: ${state}`,
    clause === undefined ? '' : `, ${clause}`,
    door === undefined ? '' : DOOR_CLAUSE[door],
  ].join('')
}

/**
 * One chip, ready to paint.
 *
 * Every optional field is a fact the read either carried or did not. Nothing here is derived from
 * anything the page knows about itself: no process state, no elapsed time, no "it has been pending
 * a while so it is probably stuck".
 */
export interface PostProcessingChipView {
  /** The chip word, VERBATIM from the store. Never re-derived, never defaulted. */
  readonly status: PostProcessingChipStatus
  /** How the indicator presents. A presentation concern, never a claim about what the store said. */
  readonly state: StageIndicatorState
  /** The visible word, from {@link STAGE_INDICATOR_WORDS}. The component composes no sentence. */
  readonly word: string
  /**
   * The explanation card. EVERY fact that used to sit beside the chip lives here now (D-09/D-12):
   * the drain posture, the committed counts, the masked failure reason and the retry intent. The
   * absence of a card is the absence of anything to say — never a fact that was dropped.
   */
  readonly card?: StageCardView
}

export type PostProcessingView =
  | {
      readonly kind: 'chips'
      readonly analysis: PostProcessingChipView
      readonly curation: PostProcessingChipView
      /**
       * Present iff the READ carried `status.skipped` (D-08, 444 D-39). A SIBLING of the chip words,
       * never a fifth one: the raw words survive underneath, so a surface that does not know about
       * the fact still renders exactly what the store said.
       */
      readonly skipped?: { readonly reason: PostProcessingSkipReason }
    }
  | { readonly kind: 'unavailable'; readonly error: string; readonly reason?: string }

/**
 * What a `pending` chip says about who will move it (D-22).
 *
 * 388-04 D-3's split applied to the dashboard: the WORD is durable chip state and the parenthetical
 * is the run's own `runFinished.disposition`, read through the route. A `detached` chain's chips
 * would otherwise read `pending` forever with no hint that nothing in this process — or any process
 * currently running — is ever going to touch them.
 */
export const PENDING_POSTURE_TEXT: Record<PostProcessingDisposition, string> = {
  handedOff: 'daemon draining',
  drained: 'draining',
  detached: 'not queued for drain — the next CLI run or agent-qa daemon drains it',
}

/**
 * What a `failed` chip says when nobody recorded a reason (D-21 as narrowed in 404-03).
 *
 * THE DURABLE NOTIFICATION ROW CARRIES NO FAILURE TEXT, deliberately: it is stamped by whichever
 * process drains the chain, INCLUDING the daemon's pump, which folds with no run masking context at
 * all (388 D-06's no-masker posture), so a reason stored there could not be guaranteed masked at the
 * moment it was written — and this row is read by surfaces that render it directly. The masked,
 * bounded reason lives instead on the in-process `*Failed` chip envelope, which is durable in the
 * run's `events.jsonl` and reaches the page through the read route's `failures` fold.
 *
 * WHICH LEAVES A REAL GAP, and this constant is what fills it honestly. A chain drained by the
 * daemon (`handedOff`) or by some later process (`detached`) emits no chip envelopes at all, so a
 * failure there has no reason ANYWHERE. The three renderings available are the truth, a blank, and
 * `pending`. Blank is a lie by omission; `pending` is a lie outright. The posture is included
 * because "nobody wrote it down" is only actionable when you know who was holding the pen.
 */
export const FAILED_REASON_ABSENT_TEXT: Record<PostProcessingDisposition | 'unknown', string> = {
  handedOff: 'reason not recorded — drained by the daemon',
  detached: 'reason not recorded — drained by a later process',
  drained: 'reason not recorded',
  unknown: 'reason not recorded',
}

/** The chip area's heading when chip truth could not be read at all (D-23). */
export const CHIPS_UNAVAILABLE_TEXT = 'post-processing status unavailable'

type ReadBody = PostProcessingReadBody

/**
 * RETIRED 425-06 (D-16). The folded legacy sentence that stood here served one count line in two
 * wordings of the SAME coarse pair; its last reader, the Knowledge tab's Learned heading, now
 * takes {@link curationBreakdownLine} beside a recorded snapshot and {@link legacyCurationPairText}
 * beside a pre-423 one. One function per measurement, and a pair that reads as a pair.
 */

/**
 * What a settled curation row says when it committed no counts (D-12).
 *
 * NEVER A ZERO. The notification row's counts are optional, and a stage that never got as far as
 * committing reports its status and nothing else. Rendering `0` there would claim somebody counted
 * and found none — which is what {@link NO_MEMORY_CHANGES_TEXT} says, about a genuinely
 * different row.
 */
export const COUNTS_NOT_RECORDED_TEXT = 'counts not recorded for this run'

/**
 * The curation door's accessible name, kept as its own export (407 D-01's idiom) and now a thin
 * call into the one name function, so the header and the Knowledge tab cannot drift apart.
 */
export function curationChipAccessibleName(chip: PostProcessingChipView): string {
  return stageIndicatorAccessibleName('curation', chip.state, chip.card?.outcome, 'knowledge')
}

/**
 * THE BREAKDOWN LINE, IN THE WORDING OF RECORD (D-17) — one function, two surfaces.
 *
 * The bucket ORDER is the schema's, shared with the CLI's chain-terminal line, so a person reading
 * the terminal and the header sees the same run described the same way. Zeros are omitted HERE and
 * kept THERE by decision: a log line is a record, a glance is a glance.
 */
export function curationBreakdownLine(breakdown: CurationBreakdown): string {
  const parts = CURATION_BREAKDOWN_BUCKETS
    .filter(bucket => breakdown[bucket] > 0)
    .map(bucket => `${String(breakdown[bucket])} ${bucket}`)
  return parts.length === 0 ? NO_MEMORY_CHANGES_TEXT : parts.join(' · ')
}

/** A pre-423 row's pair, rendered as what it is: two coarse counts, not a breakdown (D-18). */
export function legacyCurationPairText(curated: number, deprecated: number): string {
  return `${String(curated)} curated · ${String(deprecated)} deprecated`
}

/**
 * Seconds included because stage durations are seconds (UI-SPEC S4). `undefined` locale so the
 * reader's own machine decides the wording, and `h23` so a 24-hour reader never sees `12:41:02 AM`
 * where the log says `00:41:02`.
 */
const CLOCK_FORMAT = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

/**
 * A STORED string as an instant, or nothing at all (T-425-08-03, RESEARCH A6).
 *
 * Two shapes reach this module and both are the store's: the ISO-8601 instant the injected clock
 * writes, and SQLite's `CURRENT_TIMESTAMP` space form, which JS would otherwise read as
 * LOCAL time and silently shift by the reader's offset — `normalizeTimestamp` is what closes that.
 * Anything that still does not parse yields `undefined` here, so its clause is OMITTED upstream.
 * `NaN` rendered into a sentence is a number a reader would believe.
 */
function instantOf(stored: string | undefined): number | undefined {
  if (stored === undefined) return undefined
  const at = Date.parse(normalizeTimestamp(stored))
  return Number.isNaN(at) ? undefined : at
}

/** The queue moment as a local wall clock, or nothing when the stored string does not parse. */
export function formatClockTime(iso: string): string | undefined {
  const at = instantOf(iso)
  return at === undefined ? undefined : CLOCK_FORMAT.format(at)
}

/**
 * A duration between two stored instants, or nothing when either is missing or unreadable.
 *
 * A NEGATIVE SPAN IS NOT A DURATION. Two columns written by different processes can land out of
 * order under clock skew, and `-2.5s` is worse than silence: it describes a run that finished
 * before it started. The clause is dropped, exactly as it is for an unparseable field.
 */
function spanText(from: number | undefined, to: number | undefined): string | undefined {
  if (from === undefined || to === undefined || to < from) return undefined
  return formatDuration(to - from)
}

/**
 * THE JOB ROW'S OWN TIMING, CLAUSE BY CLAUSE (D-12).
 *
 * EVERY CLAUSE ONLY WHEN ITS FIELD EXISTS, and no line at all when the stage has no row. A stage
 * that was never enqueued has no queue moment; printing `Queued 00:00:00 · started after 0ms` would
 * be five facts nobody measured. Absent is not zero, one clause at a time.
 *
 * NO CLOCK. A running stage ends at `running` rather than at "running for 4m", because the elapsed
 * figure would be this page's arithmetic against the present moment rather than something the store
 * said — which is how a card starts claiming a chain is stuck (404 D-17's rule, applied to time).
 * This module reads no current time by any spelling, and a grep for one is an acceptance criterion.
 *
 * TIMED FROM THE START, NEVER FROM THE LEASE (425-13). Both durations read `startedAt`, the instant
 * the work first began. The claim lease is released by every terminal transition, so a card that
 * timed from `claimedAt` could never say how long a settled stage took — which was the whole of
 * the SC3 gap. A row carrying only a lease times nothing: a lease is not a measurement.
 */
export function stageTimingLine(
  detail: PostProcessingStageDetail | undefined,
  state: StageIndicatorState,
): string | undefined {
  if (detail === undefined) return undefined

  const created = instantOf(detail.createdAt)
  const started = instantOf(detail.startedAt)
  const updated = instantOf(detail.updatedAt)
  const queuedAt = detail.createdAt === undefined ? undefined : formatClockTime(detail.createdAt)
  const startedAfter = spanText(created, started)
  // ONLY A SETTLED STAGE FINISHED. A row queued to retry keeps its write-once start and its
  // failure's update instant, and the span between them is an attempt that failed, not a finish.
  const settled = state === 'complete' || state === 'failed'
  const finishedIn = settled ? spanText(started, updated) : undefined

  const clauses = [
    ...(queuedAt === undefined ? [] : [`Queued ${queuedAt}`]),
    ...(startedAfter === undefined ? [] : [`started after ${startedAfter}`]),
    ...(state === 'running' ? ['running'] : finishedIn === undefined ? [] : [`finished in ${finishedIn}`]),
    // ONLY PAST ONE (D-12). `1 attempts` on every settled stage is a number that never varies,
    // which is the definition of a fact a reader learns to skip.
    ...(detail.attempts !== undefined && detail.attempts > 1
      ? [`${String(detail.attempts)} attempts`]
      : []),
  ]

  return clauses.length === 0 ? undefined : clauses.join(' · ')
}

/**
 * A closed class key, re-spelled for reading (UI-SPEC S4).
 *
 * A RE-SPELLING, NOT A SECOND CLOSED SET. A `Record<VerdictClass, string>` here would be a second
 * place a new class has to be registered, and the one that fails silently — the schema's list is
 * the vocabulary, and this is only how its underscores read out loud.
 */
export function verdictClassLabel(cls: VerdictClass): string {
  return cls.replace(/_/g, ' ')
}

/** `Analysis complete — root cause: {class} ({n} verdict|verdicts)`, or the classless form. */
export function analysisCompleteWithVerdictsText(cls: VerdictClass | undefined, n: number): string {
  const complete = `${STAGE_INDICATOR_WORDS.analysis.complete} complete`
  const counted = `${String(n)} ${n === 1 ? 'verdict' : 'verdicts'}`
  return cls === undefined
    ? `${complete} — ${counted}`
    : `${complete} — root cause: ${verdictClassLabel(cls)} (${counted})`
}

/**
 * The class the run's verdicts most often landed on, from COUNTS rather than from prose (D-13).
 *
 * `byClass` is partial on purpose (422): a class that did not occur is ABSENT, not zero — so a
 * recorded zero is read the same way an absence is, and never named as this run's root cause. Ties
 * break by the schema's own declaration order, so the answer does not depend on the order a
 * producer happened to serialize its keys in.
 */
function dominantVerdictClass(byClass: Partial<Record<VerdictClass, number>>): VerdictClass | undefined {
  let dominant: VerdictClass | undefined
  let highest = 0
  for (const cls of VERDICT_CLASSES) {
    const count = byClass[cls]
    if (count !== undefined && count > highest) {
      dominant = cls
      highest = count
    }
  }
  return dominant
}

/** `{Stage} queued`, plus who is going to move it when the run recorded a disposition (D-12/D-13). */
export function stageQueuedText(stage: PostProcessingStage, posture?: string): string {
  const queued = `${STAGE_INDICATOR_WORDS[stage].complete} queued`
  return posture === undefined ? queued : `${queued} — ${posture}`
}

/** `{Stage} failed — {reason}`. The reason is the producer's, masked and unsliced (T-404-01). */
export function stageFailedText(stage: PostProcessingStage, reason: string): string {
  return `${STAGE_INDICATOR_WORDS[stage].complete} failed — ${reason}`
}

/**
 * Curation's committed counts, as one sentence — or as the labelled absence of one.
 *
 * THE SNAPSHOT OUTRANKS THE PAIR (D-17/D-18). A run that recorded five buckets is described by
 * them; a run that recorded only the legacy pair is described by the pair AND told, on its own
 * line, that no breakdown exists — because a reader who sees two numbers where five usually live
 * would otherwise conclude three buckets were empty.
 *
 * BOTH COUNTS OR NEITHER. The notification contract says a stage that never got as far as
 * committing reports its status and no counts at all, because zeros would claim it curated nothing,
 * which is a different thing from never having tried. Half a pair is the same ambiguity one field
 * down, so a row carrying one count and not the other says nothing here rather than implying a zero.
 */
export function curationCompleteText(read: ReadBody): StageCardView | undefined {
  const complete = `${STAGE_INDICATOR_WORDS.curation.complete} complete`
  const { notification, curationSnapshot, curationSnapshotWithheld } = read.status

  if (curationSnapshot !== undefined) {
    return { outcome: `${complete} — ${curationBreakdownLine(curationSnapshot.breakdown)}` }
  }

  const legacy = notification?.stages.curation
  if (legacy?.curated !== undefined && legacy.deprecated !== undefined) {
    return {
      outcome: `${complete} — ${legacyCurationPairText(legacy.curated, legacy.deprecated)}`,
      note: BREAKDOWN_NOT_RECORDED_TEXT,
    }
  }

  if (curationSnapshotWithheld !== undefined) {
    return { outcome: complete, note: BREAKDOWN_WITHHELD_TEXT[curationSnapshotWithheld.reason] }
  }

  // A SETTLED ROW THAT COMMITTED NO COUNTS SAYS SO (D-12). There IS a terminal row here — the chain
  // reached its end and froze one — so the absence is a recorded absence.
  if (notification !== undefined) return { outcome: `${complete} — ${COUNTS_NOT_RECORDED_TEXT}` }

  // No terminal row at all: the chip word came from `chips.curation` with nothing behind it. The
  // chain contract makes that unreachable, but the type permits it, and inventing a sentence about
  // a row that does not exist is the one thing this module never does.
  return undefined
}

/**
 * The store's word, as the state an indicator presents (D-06).
 *
 * A closed switch with no default: the chip vocabulary is ratified at four, and a fifth word must
 * fail to compile here rather than fall through to a shape nobody chose.
 */
export function stagePresentationState(
  read: ReadBody,
  stage: PostProcessingStage,
): StageIndicatorState {
  switch (read.status.chips[stage]) {
    case 'complete':
      return 'complete'
    case 'running':
      return 'running'
    case 'pending':
      return 'pending'
    case 'failed':
      return 'failed'
  }
}

const STAGE_RUNNING_TEXT: Record<PostProcessingStage, string> = {
  analysis: ANALYSIS_RUNNING_TEXT,
  curation: CURATION_RUNNING_TEXT,
}

/**
 * The card's first line, per state — the whole distance between a word and a sentence.
 *
 * The `complete` arm covers the two settled shapes this plan owns: analysis with nothing to report,
 * and curation's counts. A settled analysis WITH verdicts gets its root-cause sentence in 425-08
 * alongside the timing lines, and `skipped` gets its neutral sentence there too; until then those
 * two reads keep their word and their glyph rather than a sentence this plan would have to invent.
 */
function stageCard(
  stage: PostProcessingStage,
  state: StageIndicatorState,
  read: ReadBody,
): StageCardView | undefined {
  if (state === 'running') return { outcome: STAGE_RUNNING_TEXT[stage] }

  if (state === 'pending') {
    const posture = read.disposition === undefined ? undefined : PENDING_POSTURE_TEXT[read.disposition]
    return { outcome: stageQueuedText(stage, posture) }
  }

  if (state === 'failed') {
    const failure = read.failures?.[stage]
    // No `*Failed` envelope in the record. See FAILED_REASON_ABSENT_TEXT — this is the honest
    // rendering of an absence, not a fallback for a value we failed to look up.
    const reason = failure?.error ?? FAILED_REASON_ABSENT_TEXT[read.disposition ?? 'unknown']
    return {
      outcome: stageFailedText(stage, reason),
      ...(failure?.willRetry === true ? { retry: WILL_RETRY_TEXT } : {}),
    }
  }

  if (state === 'complete' && stage === 'curation') return curationCompleteText(read)

  if (state === 'complete') {
    // THE SUMMARY IS THE SOURCE, AND THE ONLY ONE (D-13, UI-SPEC S4 recommendation 4). It is on the
    // read the header already holds — no second fetch from a presentational surface — and it is
    // counted rather than written, so the sentence never parses another surface's prose (406).
    const summary = read.status.notification?.verdictSummary
    if (summary === undefined) return undefined
    return {
      outcome:
        summary.total === 0
          ? ANALYSIS_COMPLETE_NO_ISSUES_TEXT
          : analysisCompleteWithVerdictsText(dominantVerdictClass(summary.byClass), summary.total),
    }
  }

  return undefined
}

/**
 * One indicator on a run the chain never enqueued (D-08, 444 D-39).
 *
 * THE CHIP WORD IS STILL QUOTED VERBATIM. `status` carries whatever the store said — `pending` on
 * every skipped run — because skipped is a SIBLING fact and not a fifth word.
 *
 * NO TIMING, EVER. There is no job row to time; a stage that was never enqueued has no queue
 * moment, and rendering one would be the zero-for-an-absence this phase exists to remove.
 */
function skippedChipView(
  stage: PostProcessingStage,
  reason: PostProcessingSkipReason,
  read: ReadBody,
): PostProcessingChipView {
  return {
    status: read.status.chips[stage],
    state: 'skipped',
    word: STAGE_INDICATOR_WORDS[stage].skipped,
    card: { outcome: STAGE_SKIPPED_TEXT[reason][stage] },
  }
}

/**
 * The recorded lines that hang beneath an outcome — timing on every stage.
 *
 * FOLDED ONTO AN EXISTING CARD, never used to conjure one. `outcome` is the card's mandatory line,
 * so a stage with a job row but nothing to say about its outcome has no card to hang timing from —
 * and a card whose only content was a clock would be a hover that explains nothing.
 */
function withRecordedLines(
  card: StageCardView,
  stage: PostProcessingStage,
  state: StageIndicatorState,
  read: ReadBody,
): StageCardView {
  const timing = stageTimingLine(read.status.stageDetails?.[stage], state)
  return {
    ...card,
    ...(timing === undefined ? {} : { timing }),
  }
}

function chipView(stage: PostProcessingStage, read: ReadBody): PostProcessingChipView {
  const state = stagePresentationState(read, stage)
  const outcome = stageCard(stage, state, read)
  const card = outcome === undefined ? undefined : withRecordedLines(outcome, stage, state, read)
  return {
    status: read.status.chips[stage],
    state,
    word: STAGE_INDICATOR_WORDS[stage][state],
    ...(card === undefined ? {} : { card }),
  }
}

/**
 * The read, as two chips — or as the refusal that stopped there being any.
 *
 * A REFUSAL IS ITS OWN STATE (D-23). The 399.1 render contract says `refused` is distinct from
 * `failed`, and neither of them is "not started yet" either. Collapsing an unreadable store into
 * `pending` would tell a person their chain is queued when in fact this build cannot read the queue
 * — which is the one reading that makes them wait instead of acting.
 */
export function projectPostProcessingView(read: PostProcessingRead): PostProcessingView {
  if (read.kind === 'unavailable') {
    return {
      kind: 'unavailable',
      error: read.error,
      ...(read.reason === undefined ? {} : { reason: read.reason }),
    }
  }
  // THE SKIPPED GATE, AND ITS ONE INPUT (D-08, T-425-08-01). The op folds this field from the
  // run's durable `gateRun` / `excludedFromOutcomes` markers — the same markers the post-verdict
  // enqueue skip reads — so the CLI exit line, the digest and this header say ONE thing. Nothing
  // else may reach this branch: not the absence of job rows (a chain polled before its first
  // enqueue looks identical), not the run's status, not a pushed frame.
  const skipped = read.status.skipped
  if (skipped !== undefined) {
    return {
      kind: 'chips',
      analysis: skippedChipView('analysis', skipped.reason, read),
      curation: skippedChipView('curation', skipped.reason, read),
      skipped: { reason: skipped.reason },
    }
  }

  return {
    kind: 'chips',
    analysis: chipView('analysis', read),
    curation: chipView('curation', read),
  }
}
