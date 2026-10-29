// Takes only the read route's bytes, so a chip can never show a state the store did not say.

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

// The stages the chain runs.
export type PostProcessingStage = 'analysis' | 'curation'

/** The read route's own bytes, narrowed to the arm that answered. */
export type PostProcessingReadBody = Extract<PostProcessingRead, { kind: 'read' }>

// Presentation states the store never spells live in a separate set, so producers cannot emit them.
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

// The stage name alone when nothing needs doing; the name plus the state word when something does.
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

// One root for both stages, because an unreadable store says nothing about either one.
export const POST_PROCESSING_UNAVAILABLE_WORD = 'Post-processing unavailable'

/**
 * What the ellipsis before the first read says out loud (UI-SPEC S3).
 *
 * `…` is nothing at all to a screen reader, and "the read has not landed" is genuinely different
 * from `pending` — collapsing it into silence is the same lie as collapsing it into a chip word.
 */
export const POST_PROCESSING_LOADING_LABEL = 'Post-processing status loading'

// The em dash splits the state from its clause, as the accessible name does.
export const ANALYSIS_COMPLETE_NO_ISSUES_TEXT = 'Analysis complete — no issues found'

// Neutral, not a failure; total over the reasons, so a new reason fails to compile here.
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

/** A stage that is still moving says so, and says nothing else. */
export const ANALYSIS_RUNNING_TEXT = 'Analysis running'
export const CURATION_RUNNING_TEXT = 'Curation running'

/** Whether the chain intends to try that stage again — its own line, never a parenthetical. */
export const WILL_RETRY_TEXT = 'Will retry'

// The door lines are plain muted text, because the indicator itself is the control.
export const OPEN_KNOWLEDGE_TAB_TEXT = 'Open Knowledge tab'
export const OPEN_VERDICT_TEXT = 'Open verdict'

// A curation pass that touched nothing, named as the outcome rather than as zeros.
export const NO_MEMORY_CHANGES_TEXT = 'no memory changes'

// A legacy pair is a coarser measurement, so five buckets are never synthesized from it.
export const BREAKDOWN_NOT_RECORDED_TEXT = 'Breakdown not recorded for this run'

// Why a recorded snapshot is withheld: the category, never a guess at counts.
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

/** Where activating an indicator goes. Absent → the indicator is not a control. */
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
  // Every fact beside the chip lives in this card; no card means nothing to say.
  readonly card?: StageCardView
}

export type PostProcessingView =
  | {
      readonly kind: 'chips'
      readonly analysis: PostProcessingChipView
      readonly curation: PostProcessingChipView
      // Present only when the read carried `status.skipped`; a sibling of the chip words, not one.
      readonly skipped?: { readonly reason: PostProcessingSkipReason }
    }
  | { readonly kind: 'unavailable'; readonly error: string; readonly reason?: string }

// The word is chip state; the parenthetical is the disposition, so `detached` says who moves it.
export const PENDING_POSTURE_TEXT: Record<PostProcessingDisposition, string> = {
  handedOff: 'daemon draining',
  drained: 'draining',
  detached: 'not queued for drain — the next CLI run or agent-qa daemon drains it',
}

// A daemon or later drain records no failure reason, so the text names the posture instead.
export const FAILED_REASON_ABSENT_TEXT: Record<PostProcessingDisposition | 'unknown', string> = {
  handedOff: 'reason not recorded — drained by the daemon',
  detached: 'reason not recorded — drained by a later process',
  drained: 'reason not recorded',
  unknown: 'reason not recorded',
}

/** The chip area's heading when chip truth could not be read at all. */
export const CHIPS_UNAVAILABLE_TEXT = 'post-processing status unavailable'

type ReadBody = PostProcessingReadBody

// Never a zero: a stage that never committed reports status only, which differs from no changes.
export const COUNTS_NOT_RECORDED_TEXT = 'counts not recorded for this run'

// A thin call into the one name function, so the header and the Knowledge tab cannot drift.
export function curationChipAccessibleName(chip: PostProcessingChipView): string {
  return stageIndicatorAccessibleName('curation', chip.state, chip.card?.outcome, 'knowledge')
}

// Bucket order is the schema's, shared with the CLI; zeros are omitted here, kept in the log line.
export function curationBreakdownLine(breakdown: CurationBreakdown): string {
  const parts = CURATION_BREAKDOWN_BUCKETS
    .filter(bucket => breakdown[bucket] > 0)
    .map(bucket => `${String(breakdown[bucket])} ${bucket}`)
  return parts.length === 0 ? NO_MEMORY_CHANGES_TEXT : parts.join(' · ')
}

// An older row's pair, rendered as two coarse counts, not a breakdown.
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

// SQLite's `CURRENT_TIMESTAMP` form parses as local time, so `normalizeTimestamp` fixes it first.
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

// Timed from `startedAt`, never the lease, with no clock; each clause needs its field to exist.
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
    // Attempts show only past one, because `1 attempts` on every stage is noise.
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

// `byClass` omits absent classes, so a zero never names a root cause; ties use schema order.
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

/** `{Stage} queued`, plus who is going to move it when the run recorded a disposition. */
export function stageQueuedText(stage: PostProcessingStage, posture?: string): string {
  const queued = `${STAGE_INDICATOR_WORDS[stage].complete} queued`
  return posture === undefined ? queued : `${queued} — ${posture}`
}

/** `{Stage} failed — {reason}`. The reason is the producer's, masked and unsliced. */
export function stageFailedText(stage: PostProcessingStage, reason: string): string {
  return `${STAGE_INDICATOR_WORDS[stage].complete} failed — ${reason}`
}

// The snapshot outranks the legacy pair, and a row with only one of the pair says nothing.
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

  // A settled row that committed no counts says so, as a recorded absence.
  if (notification !== undefined) return { outcome: `${complete} — ${COUNTS_NOT_RECORDED_TEXT}` }

  // No terminal row at all: the chip word came from `chips.curation` with nothing behind it. The
  // chain contract makes that unreachable, but the type permits it, and inventing a sentence about
  // a row that does not exist is the one thing this module never does.
  return undefined
}

// A closed switch with no default, so a new chip word fails to compile here.
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
    // The counted `verdictSummary` is the only source, so no sentence parses another's prose.
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

// The chip word is still quoted verbatim, and a never-enqueued stage gets no timing.
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

// A refusal is its own state: showing an unreadable store as `pending` would make a person wait.
export function projectPostProcessingView(read: PostProcessingRead): PostProcessingView {
  if (read.kind === 'unavailable') {
    return {
      kind: 'unavailable',
      error: read.error,
      ...(read.reason === undefined ? {} : { reason: read.reason }),
    }
  }
  // Only the read's `skipped` field reaches here; missing job rows look the same before enqueue.
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
