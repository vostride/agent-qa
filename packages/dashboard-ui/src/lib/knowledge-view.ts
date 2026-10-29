// Pure and total: every read maps to one view, and the summary line is folded from the step rows.

import {
  CURATION_BREAKDOWN_BUCKETS,
  CURATION_BUCKET_PRECEDENCE,
  RecordAnchorsSchema,
  TRACE_TRUNCATION_TOP_K,
  formatEntityUri,
  parseShortId,
} from '@vostride/agent-qa-schema'
import type {
  BriefWhyNoTraceReason,
  CurationBreakdown,
  CurationBucket,
  InspectRecordView,
  PostProcessingChipStatus,
  PromotionPath,
  RecordChange,
  RecordedRetrievalRung,
  RetrievalRung,
  RetrievalRungReason,
  RetrievalTraceLeg,
  RunKnowledgeCanaryAttribution,
  RunKnowledgeContentAbsence,
  RunKnowledgePlanSource,
  RunKnowledgeProjection,
  RunKnowledgeRecordContent,
  RunKnowledgeStep,
  RunKnowledgeTrace,
  TraceLine,
} from '@vostride/agent-qa-schema'

import { entityRefRoute } from '@/lib/entity-routes'
import {
  BREAKDOWN_NOT_RECORDED_TEXT,
  BREAKDOWN_WITHHELD_TEXT,
  COUNTS_NOT_RECORDED_TEXT,
  STAGE_SKIPPED_TEXT,
  curationBreakdownLine,
  legacyCurationPairText,
} from './post-processing-view'

import type { KnowledgeRead } from './api'

// ─────────────────────────────────────────────────────────────────────────────
// Page-level copy
// ─────────────────────────────────────────────────────────────────────────────

// A run with no reader bound asked retrieval nothing, so it is neither a rung nor an empty result.
export const NO_STORE_HEADING = 'No knowledge store configured for this project'

/** The no-store body: what this means, and the one thing that changes it. */
export const NO_STORE_BODY =
  'Runs in this project are executed without a brief. Add a knowledge root to your config to start serving one.'

/** What the tab says when the read itself failed or was refused — never a blank pane. */
export const READ_FAILED_HEADING = 'Knowledge could not be read'

// The masked error is forwarded whole, because a truncated one leaves half a word to search for.
export function readFailedBody(error: string): string {
  return `${error}. Try reloading the page; if it persists, run \`agent-qa doctor\`.`
}

/**
 * What the Used half says when the run has NO STEPS to describe at all.
 *
 * Deliberately a different sentence from {@link NO_BRIEF_LINES_TEXT}. This one says nothing ever
 * asked; that one says retrieval ran on every step and served nothing back. One is a run with no
 * briefed work in it, the other is an empty store or a failing retriever — two different things
 * to go and look at.
 */
export const NO_BRIEF_SERVED_TEXT = 'This run used no stored knowledge: no step asked for a brief.'

// ─────────────────────────────────────────────────────────────────────────────
// Used half
// ─────────────────────────────────────────────────────────────────────────────

/** The Knowledge used section's heading, one `<h4>` at 16px/500. */
export const USED_HEADING = 'Knowledge used'

/** The summary line when every derived segment is zero. See {@link NO_BRIEF_SERVED_TEXT}. */
export const NO_BRIEF_LINES_TEXT = 'This run used no stored knowledge: retrieval ran and found nothing that applied.'

/** What a step row says instead of badges when that step served nothing (muted, not a Badge). */
export const STEP_NO_BRIEF_TEXT = 'no brief served'

/** The fact badge counting a row's served lines. */
export function briefLinesFact(count: number): string {
  return `${String(count)} brief ${count === 1 ? 'line' : 'lines'}`
}

/**
 * The fact badge counting a row's canary lines.
 *
 * `canary` does not inflect: it is the MARKER's name being counted, not a plural noun phrase, and
 * the Copywriting Contract spells it `{k} canary` at every k.
 */
export function canaryFact(count: number): string {
  return `${String(count)} canary`
}

/** The fact badge on a step whose plan came from a replayed procedure. */
export const REPLAY_FACT = 'replay'

/** The fact badge on a step whose plan was hinted by a procedure. */
export const HINT_FACT = 'hint'

/** One step row's title: the ONE-BASED ordinal a person counts by, then the step's own text. */
export function stepRowTitle(stepIndex: number, stepText: string): string {
  return `Step ${String(stepIndex + 1)} — ${stepText}`
}

// The derived counts the summary line is folded from.
export interface UsedCounts {
  readonly stepsBriefed: number
  readonly canaryLines: number
  readonly replays: number
  readonly hints: number
}

// A zero segment is omitted, not printed, because a zero claims someone measured it.
export function usedSummaryLine(counts: UsedCounts): string {
  const segments: string[] = []

  if (counts.stepsBriefed > 0) {
    segments.push(`${String(counts.stepsBriefed)} ${counts.stepsBriefed === 1 ? 'step' : 'steps'} briefed`)
  }
  if (counts.canaryLines > 0) {
    segments.push(`${String(counts.canaryLines)} canary ${counts.canaryLines === 1 ? 'line' : 'lines'} served`)
  }

  // Replays and hints share ONE segment separated by a comma — the sentence of record reads
  // `1 procedure replay, 2 hints`, so a run with both does not spend two middots on one subject.
  const procedure: string[] = []
  if (counts.replays > 0) {
    procedure.push(`${String(counts.replays)} procedure ${counts.replays === 1 ? 'replay' : 'replays'}`)
  }
  if (counts.hints > 0) {
    procedure.push(`${String(counts.hints)} ${counts.hints === 1 ? 'hint' : 'hints'}`)
  }
  if (procedure.length > 0) segments.push(procedure.join(', '))

  if (segments.length === 0) return NO_BRIEF_LINES_TEXT
  return segments.join(' · ')
}

// The sectioned tab and its grouped used rows

export type KnowledgeSection = 'used' | 'effect' | 'changes' | 'retrieval-details'

// prettier-ignore
export const KNOWLEDGE_SECTIONS = [
  'used',
  'effect',
  'changes',
  'retrieval-details',
] as const satisfies readonly KnowledgeSection[]

export type UseVerb = 'given' | 'opened' | 'caution' | 'replayed' | 'hint'

// prettier-ignore
export const USE_VERBS = [
  'given',
  'opened',
  'caution',
  'replayed',
  'hint',
] as const satisfies readonly UseVerb[]

export const USE_VERB_PHRASES = {
  given: { lead: 'Given in', follow: 'given in' },
  opened: { lead: 'Opened by the agent in', follow: 'opened in' },
  caution: { lead: 'Given as a caution in', follow: 'given as a caution in' },
  replayed: { lead: 'Replayed in', follow: 'replayed in' },
  hint: { lead: 'Used as a hint in', follow: 'used as a hint in' },
} satisfies Record<UseVerb, { readonly lead: string; readonly follow: string }>

export const EFFECT_HEADING = 'Effect on this run'

export const RETRIEVAL_DETAILS_LABEL = 'Retrieval details'

export const EFFECT_NOTHING_MEASURED_TEXT = 'Nothing was measured on this run. Only knowledge on trial and procedure replays are measured.'

export const EFFECT_NOTHING_USED_TEXT = 'Nothing to measure: this run used no stored knowledge.'

export function usedCountLine(count: number): string {
  return count === 1 ? '1 record' : `${String(count)} records`
}

export interface StepAddress {
  readonly testIndex: number
  readonly stepIndex: number
  readonly stepText: string
}

// The page's side of a step reference; selection, playhead and scroll stay page state.
export interface StepRefContext {
  readonly onSelect: (address: StepAddress) => void
  readonly resolvable: (address: StepAddress) => boolean
  readonly testNames: ReadonlyMap<number, string>
}

export function stepRefAccessibleName(address: StepAddress, testName?: string): string {
  const tail = `${String(address.stepIndex + 1)} · ${address.stepText}`
  return testName === undefined ? `Go to step ${tail}` : `Go to ${testName} · step ${tail}`
}

export type StepRefSegment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'step'; readonly address: StepAddress; readonly label: string }

function compareAddresses(a: StepAddress, b: StepAddress): number {
  return a.testIndex - b.testIndex || a.stepIndex - b.stepIndex
}

function stepSegment(address: StepAddress): StepRefSegment {
  return { kind: 'step', address, label: String(address.stepIndex + 1) }
}

// Every number is its own segment so a later plan can make it a control without re-parsing text.
// Only a contiguous run of three or more compresses to a range; two neighbours read "1 and 2".
// With test names (a suite) each member reads "{test} · {steps}", members joined by "; "; a
// single-test run passes no names and never prints one.
export function formatStepRefs(
  addresses: readonly StepAddress[],
  testNames?: ReadonlyMap<number, string>,
): readonly StepRefSegment[] {
  if (testNames === undefined || testNames.size === 0) return formatStepList(addresses)
  const byTest = new Map<number, StepAddress[]>()
  for (const address of [...addresses].sort(compareAddresses)) {
    const group = byTest.get(address.testIndex)
    if (group === undefined) byTest.set(address.testIndex, [address])
    else group.push(address)
  }
  const segments: StepRefSegment[] = []
  for (const [testIndex, group] of byTest) {
    if (segments.length > 0) segments.push({ kind: 'text', text: '; ' })
    segments.push({ kind: 'text', text: testNames.get(testIndex) ?? `Test ${String(testIndex + 1)}` })
    segments.push({ kind: 'text', text: ' · ' })
    segments.push(...formatStepList(group))
  }
  return segments
}

function formatStepList(addresses: readonly StepAddress[]): readonly StepRefSegment[] {
  const sorted = [...addresses]
    .sort(compareAddresses)
    .filter((address, index, all) => index === 0 || compareAddresses(all[index - 1]!, address) !== 0)
  if (sorted.length === 0) return []

  const runs: StepAddress[][] = []
  for (const address of sorted) {
    const run = runs.at(-1)
    const last = run?.at(-1)
    const continues =
      last !== undefined &&
      last.testIndex === address.testIndex &&
      address.stepIndex === last.stepIndex + 1
    if (run !== undefined && continues) {
      run.push(address)
    } else {
      runs.push([address])
    }
  }
  const items = runs.flatMap(run => (run.length >= 3 ? [run] : run.map(address => [address])))

  const segments: StepRefSegment[] = [{ kind: 'text', text: sorted.length === 1 ? 'step ' : 'steps ' }]
  items.forEach((item, index) => {
    if (index > 0) segments.push({ kind: 'text', text: index === items.length - 1 ? ' and ' : ', ' })
    segments.push(stepSegment(item[0]!))
    if (item.length > 1) {
      segments.push({ kind: 'text', text: '–' })
      segments.push(stepSegment(item.at(-1)!))
    }
  })
  return segments
}

export interface UseView {
  readonly verb: UseVerb
  readonly addresses: readonly StepAddress[]
}

// The schema's record-kind enum, derived rather than re-spelled.
export type RecordKind = InspectRecordView['kind']

export const RECORD_KIND_LABELS = {
  fact: 'Fact',
  caution: 'Caution',
  procedure: 'Procedure',
  policy: 'Policy',
  unknown: 'Open question',
} as const satisfies Record<RecordKind, string>

const RECORD_KINDS: ReadonlySet<string> = new Set(Object.keys(RECORD_KIND_LABELS))

function isRecordKind(kind: string): kind is RecordKind {
  return RECORD_KINDS.has(kind)
}

export const RECORD_UNREADABLE_LEAD = 'A record that can no longer be read'

export const CONTENT_ABSENCE_REASON_TEXT = {
  'not-found': 'It is no longer in the knowledge store.',
  'scan-incomplete': 'The knowledge store could not be fully read.',
  'not-bound': 'This dashboard has no record reader for this project.',
} as const satisfies Record<RunKnowledgeContentAbsence['reason'], string>

export const PROCEDURE_CONTENT_NOT_RECORDED_LEAD = "A procedure whose content isn't part of this run's record"

export const USED_PAGE_SIZE = 50

export function showAllRecordsLabel(total: number): string {
  return `Show all ${String(total)} records`
}

export interface RecordJoin {
  readonly content?: RunKnowledgeRecordContent
  readonly absence?: RunKnowledgeContentAbsence
}

// Every joined row in the read, folded by record id: the first content wins, an absence stands
// only where no row carried content. Steps are walked in (test, step) order, channels 1, 3, 2.
export function contentById(
  projection: Extract<RunKnowledgeProjection, { kind: 'ready' }>,
): ReadonlyMap<string, RecordJoin> {
  const joined = new Map<string, RecordJoin>()
  const fold = (id: string, row: { recordContent?: RunKnowledgeRecordContent; contentAbsence?: RunKnowledgeContentAbsence }) => {
    if (joined.get(id)?.content !== undefined) return
    if (row.recordContent !== undefined) joined.set(id, { content: row.recordContent })
    else if (row.contentAbsence !== undefined && !joined.has(id)) joined.set(id, { absence: row.contentAbsence })
  }
  for (const step of [...projection.steps].sort(compareAddresses)) {
    for (const line of step.served.channel1) fold(line.id, line)
    for (const line of step.served.channel3) fold(line.id, line)
    for (const line of step.served.channel2) fold(line.id, line)
  }
  for (const row of projection.learned.changes) fold(row.recordId, row)
  for (const row of projection.learned.sinceThen?.changes ?? []) fold(row.recordId, row)
  return joined
}

export type AnchorPhraseType = 'platform' | 'page' | 'flow' | 'el' | 'selector' | 'error' | 'unparsed'

// Order: platform, page, flow, element, selector, error, then the rest, whatever the input order.
// prettier-ignore
export const ANCHOR_PHRASE_TYPES = [
  'platform',
  'page',
  'flow',
  'el',
  'selector',
  'error',
  'unparsed',
] as const satisfies readonly AnchorPhraseType[]

const ANCHOR_SHAPE = RecordAnchorsSchema.element.shape.normalized

type SchemaAnchor = Extract<ReturnType<typeof ANCHOR_SHAPE.safeParse>, { success: true }>['data']

export type ParsedAnchor = SchemaAnchor | { readonly t: 'unparsed'; readonly raw: string }

// Anchors arrive as canonical-JSON strings, masked by the op. The schema owns the shapes; one that
// is not JSON, or is JSON of no anchor shape, comes back unparsed so the line keeps it verbatim.
export function parseAnchor(raw: string): ParsedAnchor {
  try {
    const parsed = ANCHOR_SHAPE.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : { t: 'unparsed', raw }
  } catch {
    return { t: 'unparsed', raw }
  }
}

export interface AnchorPhraseView {
  readonly type: AnchorPhraseType
  readonly text: string
  readonly literal?: string
}

export interface ApplicabilityView {
  readonly lead: string
  readonly phrases: readonly AnchorPhraseView[]
}

export const APPLIES_TO_PREFIX = 'Applies to'

function anchorPhrase(anchor: ParsedAnchor): AnchorPhraseView {
  switch (anchor.t) {
    case 'platform':
      return { type: 'platform', text: anchor.platform }
    case 'page':
      return { type: 'page', text: `page ${anchor.route}` }
    case 'flow':
      return { type: 'flow', text: `flow ${anchor.name}` }
    case 'el':
      return {
        type: 'el',
        text: `element ${anchor.role} "${anchor.name}"${anchor.ordinal === undefined ? '' : ` #${String(anchor.ordinal)}`}`,
      }
    case 'selector':
      return { type: 'selector', text: 'selector', literal: anchor.literal }
    case 'error':
      return { type: 'error', text: `error "${anchor.message}"` }
    case 'unparsed':
      return { type: 'unparsed', text: anchor.raw }
  }
}

// Validity ordinals never appear here; they belong to Retrieval details.
export function applicabilityView(applicability: RunKnowledgeRecordContent['applicability']): ApplicabilityView {
  const place = applicability.product === applicability.scope
    ? applicability.scope
    : `${applicability.product} · ${applicability.scope}`
  const rank = (type: AnchorPhraseType) => ANCHOR_PHRASE_TYPES.indexOf(type)
  const phrases = applicability.anchors
    .map(raw => anchorPhrase(parseAnchor(raw)))
    .sort((a, b) => rank(a.type) - rank(b.type))
  return { lead: `${APPLIES_TO_PREFIX} ${place}`, phrases }
}

export function applicabilityText(view: ApplicabilityView): string {
  return [view.lead, ...view.phrases.map(phrase => (phrase.literal === undefined ? phrase.text : `${phrase.text} ${phrase.literal}`))]
    .join(' · ')
}

export const ON_TRIAL_TAG = 'on trial'

export const ON_TRIAL_TOOLTIP =
  "New knowledge that isn't proven yet is given to the agent on trial, so a run can show whether it holds up. This run's result counts for or against it."

// The schema's status enum, derived rather than re-spelled.
export type BundleStatus = RunKnowledgeRecordContent['currentStatus']

export const SINCE_STATUS_TAGS = {
  active: 'since proven',
  candidate: 'since put back on trial',
  superseded: 'since superseded',
  deprecated: 'since retired',
} as const satisfies Record<BundleStatus, string>

export const CURRENT_STATUS_WORDS = {
  active: 'in use',
  candidate: 'on trial',
  superseded: 'superseded',
  deprecated: 'retired',
} as const satisfies Record<BundleStatus, string>

const BUNDLE_STATUSES: ReadonlySet<string> = new Set(Object.keys(CURRENT_STATUS_WORDS))

function isBundleStatus(status: string): status is BundleStatus {
  return BUNDLE_STATUSES.has(status)
}

// A since tag needs a serve-time status to compare against; only channel 1 carries one.
export function sinceStatusFor(served: string | undefined, current: BundleStatus | undefined): BundleStatus | undefined {
  if (served === undefined || current === undefined || !isBundleStatus(served)) return undefined
  return served === current ? undefined : current
}

export function currentStatusLine(status: BundleStatus): string {
  return `Current status: ${CURRENT_STATUS_WORDS[status]}`
}

function timesText(count: number): string {
  return count === 1 ? 'once' : `${String(count)} times`
}

export function trustCountsLine(confirmations: number, contradictions: number): string {
  return `Confirmed ${timesText(confirmations)} · contradicted ${timesText(contradictions)}`
}

export const SHOW_FULL_RECORD_LABEL = 'Show full record'

export const EVIDENCE_NOTE_LABEL = "Curator's note — written by the curator, not verified"

export type UsedLeadSource = 'served' | 'joined' | 'absent' | 'not-recorded'

// `key` is the record's first-use position, never its id: no id leaves the grouping map.
export interface UsedRecordView {
  readonly key: string
  readonly primary: string
  readonly leadSource: UsedLeadSource
  readonly kind?: RecordKind
  readonly content?: RunKnowledgeRecordContent
  readonly applicability?: ApplicabilityView
  readonly contentAbsence?: RunKnowledgeContentAbsence
  readonly onTrial?: true
  readonly sinceStatus?: BundleStatus
  readonly uses: readonly UseView[]
}

interface UsedRecordEntry {
  served?: string
  servedKind?: string
  servedStatus?: string
  onTrial?: true
  readonly uses: Map<UseVerb, StepAddress[]>
}

export function usedRecordViews(
  projection: Extract<RunKnowledgeProjection, { kind: 'ready' }>,
): readonly UsedRecordView[] {
  return [...usedRecordsById(projection).values()]
}

// Steps sort explicitly, never by wire order; a step serves channel 1, 3, plan source, then 2.
function usedRecordsById(
  projection: Extract<RunKnowledgeProjection, { kind: 'ready' }>,
): ReadonlyMap<string, UsedRecordView> {
  const byId = new Map<string, UsedRecordEntry>()
  const use = (id: string, verb: UseVerb, address: StepAddress): UsedRecordEntry => {
    let entry = byId.get(id)
    if (entry === undefined) {
      entry = { uses: new Map() }
      byId.set(id, entry)
    }
    const addresses = entry.uses.get(verb)
    if (addresses === undefined) entry.uses.set(verb, [address])
    else if (compareAddresses(addresses.at(-1)!, address) !== 0) addresses.push(address)
    return entry
  }

  for (const step of [...projection.steps].sort(compareAddresses)) {
    const address: StepAddress = { testIndex: step.testIndex, stepIndex: step.stepIndex, stepText: step.stepText }
    for (const line of step.served.channel1) {
      const entry = use(line.id, 'given', address)
      if (entry.served === undefined) entry.served = line.summary
      if (entry.servedKind === undefined) entry.servedKind = line.kind
      if (entry.servedStatus === undefined) entry.servedStatus = line.status
      if (line.servedAsCanary) entry.onTrial = true
    }
    for (const line of step.served.channel3) {
      const entry = use(line.id, 'caution', address)
      if (entry.served === undefined) entry.served = line.summary
    }
    if (step.planSource !== undefined) {
      use(step.planSource.procedureId, step.planSource.kind === 'procedure-replay' ? 'replayed' : 'hint', address)
    }
    for (const line of step.served.channel2) use(line.id, 'opened', address)
  }

  const joins = contentById(projection)
  const views = new Map<string, UsedRecordView>()
  let index = 0
  for (const [id, entry] of byId) {
    const join = joins.get(id)
    const content = join?.content
    const absence = content === undefined ? join?.absence : undefined
    const planSourceOnly = [...entry.uses.keys()].every(verb => verb === 'replayed' || verb === 'hint')
    const [primary, leadSource]: [string, UsedLeadSource] =
      entry.served !== undefined
        ? [entry.served, 'served']
        : content !== undefined
          ? [content.summary, 'joined']
          : absence !== undefined || !planSourceOnly
            ? [RECORD_UNREADABLE_LEAD, 'absent']
            : [PROCEDURE_CONTENT_NOT_RECORDED_LEAD, 'not-recorded']
    const kind =
      content !== undefined
        ? content.kind
        : entry.servedKind !== undefined && isRecordKind(entry.servedKind)
          ? entry.servedKind
          : undefined
    const sinceStatus = sinceStatusFor(entry.servedStatus, content?.currentStatus)
    views.set(id, {
      key: String(index),
      primary,
      leadSource,
      ...(kind === undefined ? {} : { kind }),
      ...(content === undefined ? {} : { content, applicability: applicabilityView(content.applicability) }),
      ...(absence === undefined ? {} : { contentAbsence: absence }),
      ...(entry.onTrial === undefined ? {} : { onTrial: entry.onTrial }),
      ...(sinceStatus === undefined ? {} : { sinceStatus }),
      uses: [...entry.uses].map(([verb, addresses]) => ({ verb, addresses })),
    })
    index += 1
  }
  return views
}

export interface UsedSectionView {
  readonly records: readonly UsedRecordView[]
  readonly countLine?: string
  readonly absence?: string
  /** How retrieval ran for this run, stated under the heading; absent at memidex or with no rung. */
  readonly retrieval?: RetrievalStatementView
}

// The Effect section re-words `canaryOutcomeWord` and `brokeAt` answers and never re-derives them.

export type EffectOutcome =
  | 'contradicted'
  | 'harmful'
  | 'replay-stopped'
  | 'confirmed'
  | 'helpful'
  | 'replay-complete'
  | 'pending'
  | 'unknown'

// prettier-ignore
export const EFFECT_OUTCOMES = [
  'contradicted',
  'harmful',
  'replay-stopped',
  'confirmed',
  'helpful',
  'replay-complete',
  'pending',
  'unknown',
] as const satisfies readonly EffectOutcome[]

export type EffectTone = 'problem' | 'positive' | 'pending' | 'unknown'

// The order entries group in: problems first, unknowns last.
// prettier-ignore
export const EFFECT_TONES = [
  'problem',
  'positive',
  'pending',
  'unknown',
] as const satisfies readonly EffectTone[]

export const EFFECT_TONE_OF = {
  contradicted: 'problem',
  harmful: 'problem',
  'replay-stopped': 'problem',
  confirmed: 'positive',
  helpful: 'positive',
  'replay-complete': 'positive',
  pending: 'pending',
  unknown: 'unknown',
} as const satisfies Record<EffectOutcome, EffectTone>

export interface EffectSentenceParts {
  readonly lead: string
  readonly tail: string
}

type TrialOutcome = Exclude<EffectOutcome, 'replay-stopped' | 'replay-complete'>

// Every entry names its steps, so pending and unknown carry them too.
export const EFFECT_SENTENCES = {
  contradicted: { lead: "Didn't hold up in", tail: ' — the run saw something different' },
  harmful: { lead: 'Misled the agent in', tail: '' },
  confirmed: { lead: 'Held up in', tail: ' — the run saw the same thing' },
  helpful: { lead: 'Helped in', tail: '' },
  pending: { lead: 'On trial in', tail: ' — waiting for post-run processing' },
  unknown: { lead: "Couldn't be checked in", tail: " — part of the knowledge store couldn't be read" },
} as const satisfies Record<TrialOutcome, EffectSentenceParts>

type ReplayGuard = Extract<RunKnowledgePlanSource, { kind: 'procedure-replay' }>['guard']

type ReplayMissReason = NonNullable<ReplayGuard['miss']>['reason']

export type ReplayStopCause = ReplayMissReason | 'execution-failure' | 'verifier-rejection'

export const REPLAY_STOP_CAUSES = {
  'descriptor-ambiguous': 'more than one element matched',
  'descriptor-missing': "the element wasn't found",
  'page-anchor-mismatch': "the page didn't match",
  'gate-refused': 'a safety check refused the action',
  'parameter-unbound': "a value it needed wasn't provided",
  'non-replayable-action': "that action can't be replayed",
  'execution-failure': 'the action failed to run',
  'verifier-rejection': "the result didn't pass verification",
} as const satisfies Record<ReplayStopCause, string>

// `length` is the procedure's recorded size (flow.length); `replayed` counts its distinct body steps.
export function replayCompleteParts(replayed: number | undefined, length: number | undefined): EffectSentenceParts {
  if (replayed === undefined || length === undefined || replayed === 0) {
    return { lead: 'Replayed in', tail: ' — every replayed action was accepted' }
  }
  if (replayed === length) {
    return { lead: length === 1 ? 'Replayed its only step in' : `Replayed all ${String(length)} of its steps in`, tail: '' }
  }
  return { lead: `Replayed ${String(replayed)} of its ${String(length)} steps in`, tail: '' }
}

// `step` is one-based: the procedure's own step a person counts by. `length` is flow.length.
export function replayStoppedParts(step: number, length: number | undefined, cause: ReplayStopCause): EffectSentenceParts {
  const tail = `: ${REPLAY_STOP_CAUSES[cause]}`
  if (length === 1 && step === 1) return { lead: 'Replay stopped at its only step in', tail }
  if (length !== undefined && step <= length) {
    return { lead: `Replay stopped at its step ${String(step)} of ${String(length)} in`, tail }
  }
  return { lead: `Replay stopped at its step ${String(step)} in`, tail }
}

const BROKE_STOP_CAUSES = {
  executionFailure: 'execution-failure',
  verifierRejection: 'verifier-rejection',
} as const satisfies Record<Exclude<BrokeCause, 'miss'>, ReplayStopCause>

// brokeAt's precedence, with the miss reason kept verbatim; `step` is one-based.
export function replayStop(guard: ReplayGuard): { readonly step: number; readonly cause: ReplayStopCause } | undefined {
  const broke = brokeAt(guard)
  if (broke === undefined) return undefined
  return {
    step: broke.step + 1,
    cause: broke.cause === 'miss' ? broke.reason : BROKE_STOP_CAUSES[broke.cause],
  }
}

// A policy-denied replayed action is recorded with no break member and an unpassed check.
export function isReplayComplete(guard: ReplayGuard): boolean {
  return replayStop(guard) === undefined && guard.total > 0 && guard.checksPassed === guard.total
}

export function effectSentenceText(parts: EffectSentenceParts, stepsText: string): string {
  return `${parts.lead} ${stepsText}${parts.tail}`
}

export function uncountedTrialsLine(count: number): string {
  return count === 1
    ? "1 record on trial wasn't counted for or against by this run"
    : `${String(count)} records on trial weren't counted for or against by this run`
}

export const UNCOUNTED_TRIALS_TOOLTIP = "Post-run processing finished without counting this run's result toward it."

export function unmeasuredRecordsLine(count: number): string {
  return count === 1
    ? '1 other record has no measured effect.'
    : `${String(count)} other records have no measured effect.`
}

export interface EffectEntryView {
  readonly key: string
  readonly outcome: EffectOutcome
  readonly tone: EffectTone
  readonly parts: EffectSentenceParts
  readonly addresses: readonly StepAddress[]
  // The record's Knowledge used primary text, so both sections name it the same way.
  readonly record: string
}

export interface EffectCountLine {
  readonly count: number
  readonly line: string
}

export interface EffectSectionView {
  readonly entries: readonly EffectEntryView[]
  readonly absence?: string
  readonly uncounted?: EffectCountLine
  readonly unmeasured?: EffectCountLine
}

interface EffectDraft {
  readonly recordId: string
  readonly outcome: EffectOutcome
  readonly parts: EffectSentenceParts
  readonly addresses: StepAddress[]
}

interface ReplayDraft {
  readonly recordId: string
  readonly length: number | undefined
  readonly stop: ReturnType<typeof replayStop>
  readonly addresses: StepAddress[]
  readonly cursors: Set<number>
}

export function effectSectionView(
  projection: Extract<RunKnowledgeProjection, { kind: 'ready' }>,
): EffectSectionView {
  const used = usedRecordsById(projection)
  const position = new Map([...used.keys()].map((id, index) => [id, index]))
  const status = curationWord(projection)
  const scanIncomplete = projection.learned.scanIncomplete === true

  const trials = new Map<string, EffectDraft>()
  const replays = new Map<string, ReplayDraft>()
  const flows = new Map<string, { readonly stepIndex: number; readonly cursor: number; readonly start: number }>()
  const uncountedIds = new Set<string>()

  for (const step of [...projection.steps].sort(compareAddresses)) {
    const address: StepAddress = { testIndex: step.testIndex, stepIndex: step.stepIndex, stepText: step.stepText }
    for (const line of step.served.channel1) {
      if (!line.servedAsCanary) continue
      const attribution = projection.learned.canaryAttributions.find(
        row => row.testIndex === step.testIndex && row.stepIndex === step.stepIndex && row.recordId === line.id,
      )
      const word = canaryOutcomeWord(status, attribution, scanIncomplete)
      // A skipped canary is neither a trial nor uncounted, so it falls to the unmeasured records.
      if (word === 'skipped') continue
      if (word === 'not-attributed') {
        uncountedIds.add(line.id)
        continue
      }
      const groupKey = `${word}\u0000${line.id}`
      const draft = trials.get(groupKey)
      if (draft === undefined) {
        trials.set(groupKey, { recordId: line.id, outcome: word, parts: EFFECT_SENTENCES[word], addresses: [address] })
      } else if (compareAddresses(draft.addresses.at(-1)!, address) !== 0) {
        draft.addresses.push(address)
      }
    }
    if (step.planSource?.kind === 'procedure-replay') {
      const { guard, procedureId, flow } = step.planSource
      const stop = replayStop(guard)
      // The runner carries a flow only into the very next test step at the next cursor.
      const flowKey = `${String(step.testIndex)}\u0000${procedureId}`
      const tracked = flows.get(flowKey)
      const continues =
        tracked !== undefined && flow !== undefined &&
        step.stepIndex === tracked.stepIndex + 1 && flow.cursor === tracked.cursor + 1
      const start = continues ? tracked.start : step.stepIndex
      if (flow === undefined) flows.delete(flowKey)
      else flows.set(flowKey, { stepIndex: step.stepIndex, cursor: flow.cursor, start })
      const flowInstance = flow === undefined ? '' : `${String(step.testIndex)}:${String(start)}`
      if (stop !== undefined || isReplayComplete(guard)) {
        // The procedure's size is its recorded flow; the guard fold only counts this test step's actions.
        const groupKey = stop === undefined
          ? [procedureId, flow?.length ?? '', flowInstance].join('\u0000')
          : [procedureId, flow?.length ?? '', stop.step, stop.cause].join('\u0000')
        const draft = replays.get(groupKey) ?? {
          recordId: procedureId,
          length: flow?.length,
          stop,
          addresses: [],
          cursors: new Set<number>(),
        }
        replays.set(groupKey, draft)
        const last = draft.addresses.at(-1)
        if (last === undefined || compareAddresses(last, address) !== 0) draft.addresses.push(address)
        if (stop === undefined && flow !== undefined && flow.cursor < flow.length) draft.cursors.add(flow.cursor)
      }
    }
  }

  const merged = new Map<string, ReplayDraft>()
  for (const [groupKey, draft] of replays) {
    const mergeKey = draft.stop === undefined
      ? [draft.recordId, draft.length ?? '', draft.cursors.size].join('\u0000')
      : groupKey
    const into = merged.get(mergeKey)
    if (into === undefined) {
      merged.set(mergeKey, draft)
      continue
    }
    for (const address of draft.addresses) {
      if (compareAddresses(into.addresses.at(-1)!, address) !== 0) into.addresses.push(address)
    }
  }

  const replayDrafts = [...merged.values()].map((draft): EffectDraft => ({
    recordId: draft.recordId,
    outcome: draft.stop === undefined ? 'replay-complete' : 'replay-stopped',
    parts:
      draft.stop === undefined
        ? replayCompleteParts(draft.cursors.size, draft.length)
        : replayStoppedParts(draft.stop.step, draft.length, draft.stop.cause),
    addresses: draft.addresses,
  }))

  const rank = (draft: EffectDraft) => EFFECT_TONES.indexOf(EFFECT_TONE_OF[draft.outcome])
  const drafts = [...trials.values(), ...replayDrafts].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      compareAddresses(a.addresses[0]!, b.addresses[0]!) ||
      (position.get(a.recordId) ?? 0) - (position.get(b.recordId) ?? 0),
  )
  const entries: EffectEntryView[] = drafts.map((draft, index) => ({
    key: String(index),
    outcome: draft.outcome,
    tone: EFFECT_TONE_OF[draft.outcome],
    parts: draft.parts,
    addresses: draft.addresses,
    record: used.get(draft.recordId)?.primary ?? RECORD_UNREADABLE_LEAD,
  }))

  const measured = new Set(drafts.map(draft => draft.recordId))
  const uncountedCount = [...uncountedIds].filter(id => !measured.has(id)).length
  const unmeasuredCount = [...used.keys()].filter(id => !measured.has(id) && !uncountedIds.has(id)).length
  const uncounted = uncountedCount === 0 ? {} : { uncounted: { count: uncountedCount, line: uncountedTrialsLine(uncountedCount) } }

  if (entries.length === 0) {
    return { entries, absence: used.size === 0 ? EFFECT_NOTHING_USED_TEXT : EFFECT_NOTHING_MEASURED_TEXT, ...uncounted }
  }
  return {
    entries,
    ...uncounted,
    ...(unmeasuredCount === 0 ? {} : { unmeasured: { count: unmeasuredCount, line: unmeasuredRecordsLine(unmeasuredCount) } }),
  }
}

// Channel, trace and cut-ledger copy

// The served channels, as the eyebrow captions inside an expanded step row.
export const CHANNEL_EYEBROWS = {
  1: 'CHANNEL 1 · BRIEF',
  2: 'CHANNEL 2 · READ TRACES',
  3: 'CHANNEL 3 · CAUTIONS',
} as const

// Three decimals separate adjacent candidates; `tabular-nums` keeps a column from jittering.
export function traceLineText(leg: string, rank: number, score: number): string {
  return `leg ${leg} · rank ${String(rank)} · score ${score.toFixed(3)}`
}

// The cap is the producer's `TRACE_TRUNCATION_TOP_K`, imported so it cannot drift.
export function cutCandidatesLabel(count: number): string {
  return `Cut candidates (${String(count)} of top ${String(TRACE_TRUNCATION_TOP_K)})`
}

/** The `pre-trace-run` no-trace arm, stated rather than dropped. */
export const PRE_TRACE_TEXT = 'no trace was captured for this run'

/** The `step-not-found` no-trace arm, stated rather than dropped. */
export const STEP_NOT_FOUND_TEXT = 'no evidence recorded for this step'

/** The serve-time canary marker, worn by every canary line whatever curation did with it. */
export const CANARY_BADGE_TEXT = 'canary'

/** The canary marker as Retrieval details states it, beside the line's record id. */
export const LEDGER_ON_TRIAL_TEXT = 'on trial (canary)'

/** The four outcomes the store can attribute to a canary line, as opposed to the three non-answers. */
export type AttributedOutcomeWord = Extract<CanaryOutcomeWord, 'confirmed' | 'contradicted' | 'helpful' | 'harmful'>

/** The store's attribution word for a canary line, in plain text. */
export function attributionWordText(outcome: AttributedOutcomeWord): string {
  return `attribution: ${outcome}`
}

/** A served line's serve-time facts as one mono meta line. */
export function trustMetaLine(trust: number, tier: string, status: string): string {
  return `trust ${trust.toFixed(2)} · tier ${tier} · status ${status}`
}

/** The accessible name of the copy button beside a record id in Retrieval details. */
export function copyRecordIdLabel(id: string): string {
  return `Copy record id ${id}`
}

/** Announced when a record id reached the clipboard. */
export const RECORD_ID_COPIED_TEXT = 'Record id copied to the clipboard'

/** Announced when it did not, with the id spelled out so it can still be selected. */
export function recordIdCopyFailedText(id: string): string {
  return `Could not copy — select the id to copy it: ${id}`
}

// Stated only below `memidex`, so a step whose rung differs from the run's says so on its row.
export function ledgerRungLine(rung: Exclude<RetrievalRung, 'memidex'>, reason?: RetrievalRungReason): string {
  const cause = reason === undefined ? '' : ` — ${RUNG_CAUSE_LABELS[reason]}`
  return `Retrieval level: ${RUNG_LABELS[rung]}${cause}`
}

// Not deciding yet differs from attributing nothing, so a pending canary line says so.
export const ATTRIBUTION_PENDING_TEXT = 'attribution pending'

// Nobody will decide this line, which differs from `pending` and from `not attributed`.
export const ATTRIBUTION_SKIPPED_TEXT = 'attribution skipped'

// Only when the chain settled, the store walk completed and no outcome carried this observation.
export const NOT_ATTRIBUTED_TEXT = 'not attributed'

// The partial read decides this, not the chip: nobody could finish looking, whatever the chain did.
export const ATTRIBUTION_UNKNOWN_TEXT = 'attribution unknown'

// The plan-source sentence for a step whose plan a procedure only hinted at.
export const PROCEDURE_HINT_TEXT = 'procedure hint'

// Only the recorded demotion tells a demoted replay apart from an ordinary served hint.
export const PROCEDURE_HINT_DEMOTED_TEXT = 'procedure hint (demoted from replay)'

/** The replay sentence when the guard passed every check it had. */
export function replayedText(checksPassed: number, total: number): string {
  return `replayed ${String(checksPassed)}/${String(total)}`
}

/**
 * The three ways a replay guard can break, in the words the Copywriting Contract spells.
 *
 * `executionFailure` reads `adapter failure` rather than its member name because the member names
 * the layer that failed and the sentence names what a person can act on — an adapter that could
 * not perform the recorded action.
 */
export const BROKE_CAUSE_LABELS = {
  miss: 'miss',
  executionFailure: 'adapter failure',
  verifierRejection: 'verifier rejection',
} as const

export type BrokeCause = keyof typeof BROKE_CAUSE_LABELS

/** The replay sentence when the guard broke — `k` is ONE-BASED, the ordinal a person counts by. */
export function brokeAtText(step: number, cause: BrokeCause): string {
  return `broke at step ${String(step)}: ${BROKE_CAUSE_LABELS[cause]}`
}

/** How many lines of one channel render before the rest go behind a disclosure. */
export const CHANNEL_PAGE_SIZE = 50

/**
 * The paging trigger, counting the WHOLE channel rather than the hidden remainder.
 *
 * A reader deciding whether to open it is deciding how much they are about to be shown, which is
 * the total; the remainder is arithmetic they would have to do against a number that is not on
 * screen.
 */
export function showAllLinesLabel(total: number): string {
  return `Show all ${String(total)} lines`
}

// The Memory changes section's heading, one `<h4>` at 16px/500.
export const MEMORY_CHANGES_HEADING = 'Memory changes'

// The Learned half's copy

// A sentence, not a skeleton: curation may wait hours on a daemon, so name what the changes await.
export const CHANGES_PENDING_TEXT = 'Memory changes appear after post-run processing finishes.'

// An empty list under a failed chip would read as a settled no-op, so the sentence states the loss.
export const CURATION_FAILED_TEXT = 'Curation failed — nothing was learned from this run.'

// Rides under rows a failed chain committed; the stronger failed sentence is false beside them.
export const CURATION_FAILED_PARTIAL_TEXT =
  'Curation failed — these records were committed before it stopped.'

// Published separately from the chip fragment, never derived from it by casing.
export const COUNTS_NOT_RECORDED_SENTENCE = 'Counts not recorded for this run.'

// `yet` matters: no rows here is an absence of attribution, and the moved counts stay on screen.
export const CHANGES_NOT_AVAILABLE_TEXT = 'Change records for this run are not available yet.'

// An unreadable store differs from no attribution, so it points to `doctor` rather than `yet`.
export const CHANGES_UNREADABLE_TEXT = 'Change records could not be read from the knowledge store. Run `agent-qa doctor`.'

// Never stands alone: it rides under real rows or a pending sentence when the read is partial.
export const STORE_READ_INCOMPLETE_TEXT = 'The knowledge store could not be fully read. Run `agent-qa doctor`.'

// What the half says when curation settled having changed nothing.
export const NO_MEMORY_CHANGES_SENTENCE = 'Post-run processing finished and changed nothing in memory.'

// The cause when the read proves no other: a counted gap nobody can account for, said aloud.
export const RECONCILIATION_UNATTRIBUTED_TEXT =
  "The difference could not be attributed to this run's rows."

// The noun agrees with the count and the second number is bare, as in the breakdown line.
export function reconciliationCountText(counted: number, shown: number): string {
  return `${String(counted)} ${counted === 1 ? 'change' : 'changes'} counted · ${String(shown)} shown`
}

// `added` is what the run taught the store; `purged` is store maintenance, so it stays out.
export const LEARNED_CHANGE_KINDS = ['added', 'confirmed', 'superseded', 'deprecated', 'promoted'] as const

export type LearnedChangeKind = (typeof LEARNED_CHANGE_KINDS)[number]

const PROMOTION_PATH_LABELS = {
  'deterministic-verdict-floor': 'deterministic-verdict-floor',
  'user-sovereign': 'user-sovereign',
} satisfies Record<PromotionPath, string>

export function promotionPathLabel(path: PromotionPath): string {
  return PROMOTION_PATH_LABELS[path]
}

const LEARNED_CHANGE_KIND_SET: ReadonlySet<string> = new Set(LEARNED_CHANGE_KINDS)

function isLearnedChangeKind(kind: RecordChange['change']): kind is LearnedChangeKind {
  return LEARNED_CHANGE_KIND_SET.has(kind)
}

// Lower-cased, each label is the key `curationBreakdownLine` prints, so rows and heading agree.
export const BUCKET_LABELS = {
  added: 'Added',
  confirmed: 'Confirmed',
  superseded: 'Superseded',
  deprecated: 'Deprecated',
  proposed: 'Proposed',
} as const satisfies Record<CurationBucket, string>

// What each bucket word means, as its label's tooltip and sr-only text.
export const BUCKET_MEANINGS = {
  added: 'New knowledge recorded from this run.',
  confirmed: 'Existing knowledge this run backed up, including knowledge promoted to trusted.',
  superseded: 'Replaced by a newer version; agents are given the new one.',
  deprecated: 'Retired; agents are no longer given it.',
  // Nothing reviews a proposed record; it stays proposed in CI or where validation refused it.
  proposed: 'Recorded, but not applied: agents are not given it.',
} as const satisfies Record<CurationBucket, string>

// A change seen without a snapshot maps onto the same words; Proposed is never synthesized.
const CHANGE_BUCKETS = {
  added: 'added',
  confirmed: 'confirmed',
  promoted: 'confirmed',
  superseded: 'superseded',
  deprecated: 'deprecated',
} as const satisfies Record<LearnedChangeKind, CurationBucket>

export const PROPOSED_NOTE = 'recorded, not applied'

export const OPEN_QUESTION_NOTE = 'open question recorded'

export const WAS_PREFIX = 'Was:'

export const RECORD_CONTENT_NOT_RECORDED_LEAD = "A record whose content isn't part of this run's record"

export function sinceThisRunHeading(count: number): string {
  return `Since this run · ${String(count)} ${count === 1 ? 'change' : 'changes'}`
}

export const SINCE_THEN_DETAILS = {
  added: 'added later',
  confirmed: 'confirmed again, later',
  promoted: 'promoted to trusted, later',
  superseded: 'superseded later',
  deprecated: 'retired later',
} as const satisfies Record<LearnedChangeKind, string>

export function sinceThenDetail(change: LearnedChangeKind): string {
  return SINCE_THEN_DETAILS[change]
}

// The Retrieval details rows for one changed record, in render order.
export type LedgerRow =
  | 'bucket'
  | 'record'
  | 'events'
  | 'promotion'
  | 'receipt'
  | 'evidence'
  | 'observation'
  | 'sourceRun'
  | 'validity'
  | 'link'

export const LEDGER_ROW_LABELS = {
  bucket: 'Bucket',
  record: 'Record',
  events: 'Events',
  promotion: 'Promotion path',
  receipt: 'Receipt digest',
  evidence: 'Evidence',
  observation: 'Observation',
  sourceRun: 'Source run',
  validity: 'Validity',
  link: 'Reference',
} as const satisfies Record<LedgerRow, string>

export interface LedgerEvent {
  readonly change: RecordChange['change']
  readonly atOrdinal: number
}

export function ledgerEventText(event: LedgerEvent): string {
  return `${event.change} @ ${String(event.atOrdinal)}`
}

export interface LedgerValidity {
  readonly openedAtOrdinal: number
  readonly closedAtOrdinal?: number
}

export function ledgerValidityText(validity: LedgerValidity): string {
  const opened = `opened @ ${String(validity.openedAtOrdinal)}`
  return validity.closedAtOrdinal === undefined ? opened : `${opened} · closed @ ${String(validity.closedAtOrdinal)}`
}

/** Every technical fact behind one Memory changes row; rendered only inside Retrieval details. */
export interface ChangeLedgerView {
  readonly key: string
  readonly bucket: CurationBucket
  readonly section?: LearnedRowSection
  /** The row's subject first; a supersession's old record second. */
  readonly recordIds: readonly string[]
  readonly events: readonly LedgerEvent[]
  readonly promotionPath?: PromotionPath
  readonly promotionReceiptDigest?: string
  readonly evidenceTokens: readonly string[]
  readonly observationIds: readonly string[]
  readonly sourceRunIds: readonly string[]
  readonly validity?: LedgerValidity
  readonly ref?: string
  readonly href?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// The view
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where a step's plan came from, flattened to the RAW WORD the row's `data-plan-source` carries.
 *
 * `none` is a member of the vocabulary rather than an absent attribute, because a DOM cell
 * asserting "this step replayed nothing" needs something to read; an absent attribute is
 * indistinguishable from a row the component forgot to stamp.
 */
export type StepPlanSourceWord = 'none' | 'procedure-replay' | 'procedure-hint'

// The expanded step row: channels, why-traces, cut ledger, plan source

// The numbers are read from the serve-time trace; re-deriving them would describe the index today.
export type LineWhy =
  | {
      readonly kind: 'answered'
      readonly leg: RetrievalTraceLeg
      readonly rank: number
      readonly score: number
    }
  | { readonly kind: 'no-trace'; readonly reason: BriefWhyNoTraceReason }

// `unknown` means the read is partial and `skipped` that curation never ran; neither is blank.
export type CanaryOutcomeWord =
  | 'confirmed'
  | 'contradicted'
  | 'helpful'
  | 'harmful'
  | 'pending'
  | 'not-attributed'
  | 'unknown'
  | 'skipped'

/** One channel-1 line, with its trace answer and (if it is a canary) its outcome word. */
export interface BriefLineView {
  readonly id: string
  readonly kind: string
  readonly summary: string
  readonly trust: number
  readonly status: string
  readonly servedAsCanary: boolean
  readonly tier: string
  readonly why: LineWhy
  /** Present exactly when {@link servedAsCanary} — a non-canary line has no outcome to report. */
  readonly canaryOutcome?: CanaryOutcomeWord
}

// One read trace as its Retrieval details row renders it, digest included.
export interface ReadTraceView {
  readonly id: string
  readonly detailLevel: string
  readonly bodyDigest: string
}

/** One channel-3 caution, as the row renders it. */
export interface CautionView {
  readonly id: string
  readonly summary: string
}

// The truncated ledger, which answers why a record is left out.
export interface CutCandidatesView {
  readonly label: string
  readonly lines: readonly TraceLine[]
}

/** The replay/hint row: the procedure, the sentence of record, and the outcome it states. */
export interface PlanSourceView {
  readonly kind: 'procedure-replay' | 'procedure-hint'
  readonly procedureId: string
  readonly sentence: string
  readonly tone: 'ok' | 'broke' | 'hint'
  /** The guard's recorded reason code, present only on a replay that broke on a miss. */
  readonly missReason?: ReplayMissReason
}

/** A step's recorded retrieval level, present only when it was below `memidex`. */
export interface LedgerRungView {
  readonly rung: Exclude<RetrievalRung, 'memidex'>
  readonly reason?: RetrievalRungReason
}

/** Everything an EXPANDED step row shows. Empty channels are empty arrays, never absent. */
export interface StepDetailView {
  readonly channel1: readonly BriefLineView[]
  readonly channel2: readonly ReadTraceView[]
  readonly channel3: readonly CautionView[]
  /** Present only on an `answered` trace — see {@link cutCandidates}. */
  readonly cut?: CutCandidatesView
  /** Present only on a step whose evidence recorded a procedure plan source. */
  readonly planSource?: PlanSourceView
  /** Present only on a step that recorded a rung below `memidex`. */
  readonly rung?: LedgerRungView
}

/** One page of a channel, plus the trigger that reveals the rest. */
export interface ChannelPage<T> {
  readonly lines: readonly T[]
  /** Absent when nothing is held back — an absent key, never a zero somebody counted. */
  readonly hiddenCount?: number
  readonly showAllLabel?: string
}

// A trace that answered the step but has no entry for this line maps to `step-not-found`.
export function briefLineViews(
  step: RunKnowledgeStep,
  trace: RunKnowledgeTrace,
): readonly BriefLineView[] {
  return step.served.channel1.map(line => ({ ...line, why: lineWhy(line.id, trace) }))
}

function lineWhy(recordId: string, trace: RunKnowledgeTrace): LineWhy {
  if (trace.kind === 'no-trace') return { kind: 'no-trace', reason: trace.reason }

  const served = trace.trace.servedLines.find(candidate => candidate.recordId === recordId)
  if (served === undefined) return { kind: 'no-trace', reason: 'step-not-found' }

  return { kind: 'answered', leg: served.leg, rank: served.rank, score: served.score }
}

// An answered trace that cut nothing still discloses `(0 of top 20)`; no trace means no ledger.
export function cutCandidates(trace: RunKnowledgeTrace): CutCandidatesView | undefined {
  if (trace.kind === 'no-trace') return undefined
  return { label: cutCandidatesLabel(trace.trace.truncated.length), lines: trace.trace.truncated }
}

// Order: an unsettled chain, then a served row, then a skipped chain, then the read decides.
export function canaryOutcomeWord(
  curation: CurationWord,
  attribution: RunKnowledgeCanaryAttribution | undefined,
  scanIncomplete = false,
): CanaryOutcomeWord {
  // Takes the tab's curation word, so a skipped run never reads a defaulted `pending`.
  if (curation === 'pending' || curation === 'running') return 'pending'
  if (attribution !== undefined) return attribution.outcome
  if (curation === 'skipped') return 'skipped'
  return scanIncomplete ? 'unknown' : 'not-attributed'
}

// A recorded guard failure beats the check count; precedence is miss, then adapter, then verifier.
export function planSourceSentence(planSource: RunKnowledgePlanSource): string {
  if (planSource.kind === 'procedure-hint') {
    return planSource.demotion === undefined ? PROCEDURE_HINT_TEXT : PROCEDURE_HINT_DEMOTED_TEXT
  }

  const broke = brokeAt(planSource.guard)
  if (broke !== undefined) return brokeAtText(broke.step + 1, broke.cause)

  return replayedText(planSource.guard.checksPassed, planSource.guard.total)
}

type BrokeAt =
  | { readonly step: number; readonly cause: 'miss'; readonly reason: ReplayMissReason }
  | { readonly step: number; readonly cause: Exclude<BrokeCause, 'miss'> }

function brokeAt(guard: ReplayGuard): BrokeAt | undefined {
  if (guard.miss !== undefined) return { step: guard.miss.procedureStepIndex, cause: 'miss', reason: guard.miss.reason }
  if (guard.executionFailure !== undefined) {
    return { step: guard.executionFailure.procedureStepIndex, cause: 'executionFailure' }
  }
  if (guard.verifierRejection !== undefined) {
    return { step: guard.verifierRejection.procedureStepIndex, cause: 'verifierRejection' }
  }
  return undefined
}

/** The plan-source row: its sentence and the tone its badge is tinted by. */
export function planSourceView(planSource: RunKnowledgePlanSource): PlanSourceView {
  const sentence = planSourceSentence(planSource)
  const procedureId = planSource.procedureId
  if (planSource.kind === 'procedure-hint') {
    return { kind: 'procedure-hint', procedureId, sentence, tone: 'hint' }
  }
  const broke = brokeAt(planSource.guard)
  return {
    kind: 'procedure-replay',
    procedureId,
    sentence,
    tone: broke === undefined ? 'ok' : 'broke',
    ...(broke?.cause === 'miss' ? { missReason: broke.reason } : {}),
  }
}

/**
 * The first {@link CHANNEL_PAGE_SIZE} lines of a channel, and the trigger for the rest.
 *
 * NO VIRTUALISATION, by design (UI-SPEC): step rows render collapsed, so the tab's DOM is bounded
 * by the number of steps rather than by the number of lines. This bounds the one case that is not
 * — a single step served hundreds of lines — without introducing a scroll owner inside a scroll
 * owner.
 */
export function channelPage<T>(lines: readonly T[]): ChannelPage<T> {
  if (lines.length <= CHANNEL_PAGE_SIZE) return { lines }
  return {
    lines: lines.slice(0, CHANNEL_PAGE_SIZE),
    hiddenCount: lines.length - CHANNEL_PAGE_SIZE,
    showAllLabel: showAllLinesLabel(lines.length),
  }
}

/** One collapsed step row, ready to paint. */
export interface StepRowView {
  readonly testIndex: number
  readonly stepIndex: number
  /** {@link stepRowTitle} applied — one-based ordinal, em dash, the step's own text. */
  readonly title: string
  /** Lines this step was served across ALL THREE channels — the same fold "briefed" is judged by. */
  readonly briefLines: number
  /** Channel-1 lines carrying the serve-time canary marker. */
  readonly canaryLines: number
  readonly planSource: StepPlanSourceWord
  /** The outline badges, in render order. Empty exactly when {@link noBrief} is set. */
  readonly facts: readonly string[]
  /** Present only on a step that served nothing; the row renders {@link STEP_NO_BRIEF_TEXT}. */
  readonly noBrief?: true
  // Required, so a component never guards it; a step that served nothing has empty channels.
  readonly detail: StepDetailView
}

// `counts-absent` and `skipped` are facts the chip cannot say; the other words mirror the chip.
export type LearnedState = 'pending' | 'running' | 'complete' | 'failed' | 'counts-absent' | 'skipped'

export type LearnedLeadSource = 'joined' | 'absent' | 'not-recorded'

/** The old record beneath a supersession row: its summary, or why it cannot be shown. */
export interface SupersededWasView {
  readonly primary: string
  readonly leadSource: LearnedLeadSource
}

// No id, reference or receipt rides on a row; `key` is the row's position, rebuilt each render.
export interface LearnedRowView {
  readonly key: string
  readonly bucket: CurationBucket
  // Present only beside a recorded snapshot; without one there is nothing to section against.
  readonly section?: LearnedRowSection
  readonly primary: string
  readonly leadSource: LearnedLeadSource
  readonly kind?: RecordKind
  readonly content?: RunKnowledgeRecordContent
  readonly contentAbsence?: RunKnowledgeContentAbsence
  readonly applicability?: ApplicabilityView
  /** A supersession's old record; the row itself leads with the new version. */
  readonly was?: SupersededWasView
  /** Proposed rows only. */
  readonly note?: string
  /** Since-then rows only: what happened later. */
  readonly sinceDetail?: string
}

export type LearnedRowSection = 'curation' | 'since-then'

/** The fixed curation snapshot, as far as this half reads it. */
export interface LearnedSnapshotView {
  /** Copied verbatim from the checkpoint; never re-counted from rows. */
  readonly breakdown: CurationBreakdown
  /** `learned.sinceThen.count`, verbatim. Absent when the op served no since-then section. */
  readonly sinceThenCount?: number
  // Present only when the snapshot total and the shown rows disagree; a match is not a line.
  readonly reconciliation?: { readonly count: string; readonly cause: string }
}

// Every state has a list and exactly the empty ones a sentence, so the half is never blank.
export interface LearnedView {
  readonly state: LearnedState
  /** The chip's own count line, from the chip's own function — one number, one wording. */
  readonly countLine?: string
  // Separate from the count line: a fact about the measurement, absent beside a breakdown.
  readonly countNote?: string
  /** The state sentence. Absent exactly when {@link LearnedView.rows} is non-empty. */
  readonly sentence?: string
  readonly rows: readonly LearnedRowView[]
  // True or absent, as the wire flag is; the component stamps `data-learned-read` from it.
  readonly scanIncomplete?: true
  // Absent when `CHANGES_UNREADABLE_TEXT` already names the store, never an empty string.
  readonly readNote?: string
  // Chain fate and store readability fold independently, so this note never speaks for the read.
  readonly chainNote?: string
  // Absent for a failed or older chain, and the component states that absence, not zero counts.
  readonly curationSnapshot?: LearnedSnapshotView
}

/** The rung that served THIS run, if the evidence recorded one. */
export interface RungView {
  readonly rung: RetrievalRung
  readonly reason?: RetrievalRungReason
}

/**
 * The whole tab, as one of four states — and `loading` is not among them.
 *
 * THE FIFTH STATE IS THE PAGE'S `undefined`, deliberately. "The first read has not landed" is a
 * fact about the client, not about the run: this module never sees a pending read because there
 * is nothing in a pending read to project. The component renders skeletons for `undefined` and
 * this union for everything else, which is why no arm here can be mistaken for "not yet known".
 */
export type KnowledgeView =
  | { readonly state: 'error'; readonly heading: string; readonly body: string }
  | { readonly state: 'evidence-incomplete' }
  | { readonly state: 'empty-no-store'; readonly heading: string; readonly body: string }
  | {
      readonly state: 'ready'
      readonly used: UsedSectionView
      readonly effect: EffectSectionView
      readonly ledger: LedgerView
      readonly rung?: RungView
      readonly learned: LearnedView
    }

// The per-step ledger Retrieval details holds: the summary line and step rows.
export interface LedgerView {
  readonly summary: string
  readonly steps: readonly StepRowView[]
  // One entry per Memory changes row, in row order.
  readonly changes: readonly ChangeLedgerView[]
}

/** Did this step get served anything at all, on any channel? The one fold "briefed" means. */
function servedLineCount(step: RunKnowledgeStep): number {
  return step.served.channel1.length + step.served.channel2.length + step.served.channel3.length
}

function canaryLineCount(step: RunKnowledgeStep): number {
  return step.served.channel1.filter(line => line.servedAsCanary).length
}

function stepRow(
  step: RunKnowledgeStep,
  curation: CurationWord,
  attributions: readonly RunKnowledgeCanaryAttribution[],
  scanIncomplete: boolean,
): StepRowView {
  const briefLines = servedLineCount(step)
  const canaryLines = canaryLineCount(step)
  const planSource: StepPlanSourceWord = step.planSource?.kind ?? 'none'

  const facts: string[] = []
  if (briefLines > 0) facts.push(briefLinesFact(briefLines))
  if (canaryLines > 0) facts.push(canaryFact(canaryLines))
  if (planSource === 'procedure-replay') facts.push(REPLAY_FACT)
  if (planSource === 'procedure-hint') facts.push(HINT_FACT)

  return {
    testIndex: step.testIndex,
    stepIndex: step.stepIndex,
    title: stepRowTitle(step.stepIndex, step.stepText),
    briefLines,
    canaryLines,
    planSource,
    facts,
    // A step that served nothing keeps its row, so a run never looks shorter than it is.
    ...(briefLines === 0 ? { noBrief: true as const } : {}),
    detail: stepDetail(step, curation, attributions, scanIncomplete),
  }
}

// Joined on test, step and record, because `stepIndex` restarts per member test.
function stepDetail(
  step: RunKnowledgeStep,
  curation: CurationWord,
  attributions: readonly RunKnowledgeCanaryAttribution[],
  scanIncomplete: boolean,
): StepDetailView {
  const channel1 = briefLineViews(step, step.trace).map(line =>
    line.servedAsCanary
      ? {
          ...line,
          canaryOutcome: canaryOutcomeWord(
            curation,
            attributions.find(
              row =>
                row.testIndex === step.testIndex &&
                row.stepIndex === step.stepIndex &&
                row.recordId === line.id,
            ),
            scanIncomplete,
          ),
        }
      : line,
  )

  const cut = cutCandidates(step.trace)
  const rung = step.retrievalRung === undefined ? undefined : rungView(step.retrievalRung)

  return {
    channel1,
    channel2: step.served.channel2.map(line => ({ id: line.id, detailLevel: line.detailLevel, bodyDigest: line.bodyDigest })),
    channel3: step.served.channel3.map(line => ({ id: line.id, summary: line.summary })),
    ...(cut === undefined ? {} : { cut }),
    ...(step.planSource === undefined ? {} : { planSource: planSourceView(step.planSource) }),
    ...(rung === undefined || rung.rung === 'memidex'
      ? {}
      : { rung: { rung: rung.rung, ...(rung.reason === undefined ? {} : { reason: rung.reason }) } }),
  }
}

// Only an id that already is a MEM short-ID gets a URI; the codec would throw on any other.
function learnedRecordRef(recordId: string): string | undefined {
  return parseShortId(recordId)?.kind === 'MEM' ? formatEntityUri('MEM', recordId) : undefined
}

/** One Memory changes row before it is split into what a reader sees and what the ledger holds. */
interface ChangeDraft {
  readonly bucket: CurationBucket
  readonly section?: LearnedRowSection
  /** The record the row leads with: a supersession's replacement, else the record itself. */
  readonly subjectId: string
  readonly wasId?: string
  readonly changes: readonly RecordChange[]
  readonly later?: LearnedChangeKind
}

function strongestBucket(buckets: readonly CurationBucket[]): CurationBucket {
  return CURATION_BUCKET_PRECEDENCE.find(bucket => buckets.includes(bucket)) ?? buckets[0]!
}

function replacementOf(changes: readonly RecordChange[]): string | undefined {
  return [...changes].reverse().find(change => change.change === 'superseded' && change.byRecordId !== undefined)?.byRecordId
}

// With a snapshot the rows are its rows; without one, changes group per record in first-seen order.
function changeDrafts(projection: Extract<RunKnowledgeProjection, { kind: 'ready' }>): readonly ChangeDraft[] {
  const { curationSnapshot, sinceThen, changes } = projection.learned

  if (curationSnapshot !== undefined) {
    const curation = curationSnapshot.rows.map((row): ChangeDraft => {
      const replaced = row.bucket === 'superseded' && row.byRecordId !== undefined
      return {
        bucket: row.bucket,
        section: 'curation',
        subjectId: replaced ? row.byRecordId! : row.recordId,
        ...(replaced ? { wasId: row.recordId } : {}),
        changes: row.changes.map(entry => entry.change),
      }
    })
    const later = (sinceThen?.changes ?? []).flatMap((change): ChangeDraft[] => {
      if (!isLearnedChangeKind(change.change)) return []
      const replaced = change.change === 'superseded' && change.byRecordId !== undefined
      return [{
        bucket: CHANGE_BUCKETS[change.change],
        section: 'since-then',
        subjectId: replaced ? change.byRecordId! : change.recordId,
        ...(replaced ? { wasId: change.recordId } : {}),
        changes: [change],
        later: change.change,
      }]
    })
    return [...curation, ...later]
  }

  const kept = changes.filter(change => isLearnedChangeKind(change.change))
  const victimOf = new Map<string, string>()
  for (const change of kept) {
    if (change.change === 'superseded' && change.byRecordId !== undefined) victimOf.set(change.byRecordId, change.recordId)
  }
  const groups = new Map<string, RecordChange[]>()
  for (const change of kept) {
    const id = change.change === 'added' ? victimOf.get(change.recordId) ?? change.recordId : change.recordId
    const group = groups.get(id)
    if (group === undefined) groups.set(id, [change])
    else group.push(change)
  }
  return [...groups].map(([id, group]): ChangeDraft => {
    const bucket = strongestBucket(group.map(change => CHANGE_BUCKETS[change.change as LearnedChangeKind]))
    const replacement = bucket === 'superseded' ? replacementOf(group) : undefined
    return {
      bucket,
      subjectId: replacement ?? id,
      ...(replacement === undefined ? {} : { wasId: id }),
      changes: group,
    }
  })
}

function leadOf(join: RecordJoin | undefined): { primary: string; leadSource: LearnedLeadSource } {
  if (join?.content !== undefined) return { primary: join.content.summary, leadSource: 'joined' }
  if (join?.absence !== undefined) return { primary: RECORD_UNREADABLE_LEAD, leadSource: 'absent' }
  return { primary: RECORD_CONTENT_NOT_RECORDED_LEAD, leadSource: 'not-recorded' }
}

function learnedRow(draft: ChangeDraft, index: number, joins: ReadonlyMap<string, RecordJoin>): LearnedRowView {
  const join = joins.get(draft.subjectId)
  const content = join?.content
  const absence = content === undefined ? join?.absence : undefined
  const note = draft.bucket !== 'proposed' ? undefined : content?.kind === 'unknown' ? OPEN_QUESTION_NOTE : PROPOSED_NOTE
  return {
    key: String(index),
    bucket: draft.bucket,
    ...(draft.section === undefined ? {} : { section: draft.section }),
    ...leadOf(join),
    ...(content === undefined ? {} : { kind: content.kind, content, applicability: applicabilityView(content.applicability) }),
    ...(absence === undefined ? {} : { contentAbsence: absence }),
    ...(draft.wasId === undefined ? {} : { was: leadOf(joins.get(draft.wasId)) }),
    ...(note === undefined ? {} : { note }),
    ...(draft.later === undefined ? {} : { sinceDetail: sinceThenDetail(draft.later) }),
  }
}

function distinct(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => value !== undefined))]
}

function ledgerEntry(draft: ChangeDraft, index: number, joins: ReadonlyMap<string, RecordJoin>): ChangeLedgerView {
  const ref = learnedRecordRef(draft.subjectId)
  const href = ref === undefined ? undefined : entityRefRoute(ref)
  const promotion = draft.changes.find(change => change.promotionPath !== undefined)
  const applicability = joins.get(draft.subjectId)?.content?.applicability
  return {
    key: String(index),
    bucket: draft.bucket,
    ...(draft.section === undefined ? {} : { section: draft.section }),
    recordIds: draft.wasId === undefined ? [draft.subjectId] : [draft.subjectId, draft.wasId],
    events: draft.changes.map(change => ({ change: change.change, atOrdinal: change.atOrdinal })),
    ...(promotion?.promotionPath === undefined ? {} : { promotionPath: promotion.promotionPath }),
    ...(promotion?.promotionReceiptDigest === undefined ? {} : { promotionReceiptDigest: promotion.promotionReceiptDigest }),
    evidenceTokens: distinct(draft.changes.map(change => change.evidenceToken)),
    observationIds: distinct(draft.changes.map(change => change.observationId)),
    sourceRunIds: distinct(draft.changes.map(change => change.sourceRunId)),
    ...(applicability === undefined
      ? {}
      : {
          validity: {
            openedAtOrdinal: applicability.openedAtOrdinal,
            ...(applicability.closedAtOrdinal === undefined ? {} : { closedAtOrdinal: applicability.closedAtOrdinal }),
          },
        }),
    ...(ref === undefined ? {} : { ref }),
    ...(href === undefined ? {} : { href }),
  }
}

// The tab's one word for curation: a chip word, or `skipped`.
export type CurationWord = PostProcessingChipStatus | 'skipped'

// Gate and outcome-excluded runs never enqueue curation, so the skipped fact outranks the chip.
export function curationWord(projection: Extract<RunKnowledgeProjection, { kind: 'ready' }>): CurationWord {
  return projection.curation.skipped === undefined ? projection.curation.status : 'skipped'
}

// One entry per Memory changes row, in the same order; an unsettled chain lists none.
export function changeLedgerViews(
  projection: Extract<RunKnowledgeProjection, { kind: 'ready' }>,
): readonly ChangeLedgerView[] {
  const status = curationWord(projection)
  if (status === 'pending' || status === 'running') return []
  const joins = contentById(projection)
  return changeDrafts(projection).map((draft, index) => ledgerEntry(draft, index, joins))
}

// The fold is hoisted above every arm, so no arm can deny a record it never looked at.
export function learnedView(
  projection: Extract<RunKnowledgeProjection, { kind: 'ready' }>,
): LearnedView {
  const status = curationWord(projection)
  const { counts, skipped } = projection.curation

  // Absent rather than `false` on a clean read, as the wire flag is typed.
  const degraded = projection.learned.scanIncomplete === true ? { scanIncomplete: true as const } : {}
  const readNote =
    projection.learned.scanIncomplete === true ? { readNote: STORE_READ_INCOMPLETE_TEXT } : {}

  // Already filtered to this run by `runs.knowledge`; this narrows the kinds and nothing else.
  const { curationSnapshot, sinceThen } = projection.learned
  const joins = contentById(projection)
  const rows = changeDrafts(projection).map((draft, index) => learnedRow(draft, index, joins))
  const snapshotView: LearnedSnapshotView | undefined = curationSnapshot === undefined
    ? undefined
    : {
        breakdown: curationSnapshot.breakdown,
        ...(sinceThen === undefined ? {} : { sinceThenCount: sinceThen.count }),
      }
  const snapshot = snapshotView === undefined ? {} : { curationSnapshot: snapshotView }

  // `counted` is the snapshot's own; `shown` is the curation section, without since-then rows.
  const counted = snapshotView === undefined
    ? 0
    : CURATION_BREAKDOWN_BUCKETS.reduce((total, bucket) => total + snapshotView.breakdown[bucket], 0)
  const shown = rows.filter(row => row.section === 'curation').length

  /**
   * The snapshot spread, with the gap stated when there is one and the member absent when there
   * is not. The CAUSE is passed in by the arm, because only the arm knows which fact the read
   * already proved — this function never picks one.
   */
  const reconciled = (cause: string) =>
    snapshotView === undefined || counted === shown
      ? snapshot
      : {
          curationSnapshot: {
            ...snapshotView,
            reconciliation: { count: reconciliationCountText(counted, shown), cause },
          },
        }

  // A skipped chain never ran: any rows paint with `chainNote`, else the skip is the sentence.
  if (skipped !== undefined) {
    const skipText = STAGE_SKIPPED_TEXT[skipped.reason].curation
    return rows.length > 0
      ? { state: 'skipped', rows, chainNote: skipText, ...degraded, ...readNote, ...snapshot }
      : { state: 'skipped', sentence: skipText, rows: [], ...degraded, ...readNote, ...snapshot }
  }

  if (status === 'pending' || status === 'running') {
    // An unsettled chain has not finished deciding, so its rows in scope are not listed.
    return { state: status, sentence: CHANGES_PENDING_TEXT, rows: [], ...degraded, ...readNote, ...snapshot }
  }

  if (status === 'failed') {
    // A failed chain's records paint with the failure beside them, which also explains the gap.
    return rows.length > 0
      ? {
          state: 'failed',
          rows,
          chainNote: CURATION_FAILED_PARTIAL_TEXT,
          ...degraded,
          ...readNote,
          ...reconciled(CURATION_FAILED_PARTIAL_TEXT),
        }
      : { state: 'failed', sentence: CURATION_FAILED_TEXT, rows: [], ...degraded, ...readNote, ...snapshot }
  }

  const state: LearnedState = counts === undefined ? 'counts-absent' : 'complete'

  // Only an incomplete scan proves why rows are missing; on a clean read no cause is known.
  const settledCause = projection.learned.scanIncomplete === true
    ? CHANGES_UNREADABLE_TEXT
    : RECONCILIATION_UNATTRIBUTED_TEXT

  // The heading runs `curationBreakdownLine` on the card's snapshot, so the two always agree.
  const breakdown = curationSnapshot?.breakdown
  const withheld = projection.learned.curationSnapshotWithheld
  const countLine =
    breakdown !== undefined
      ? curationBreakdownLine(breakdown)
      : counts !== undefined
        ? legacyCurationPairText(counts.curated, counts.deprecated)
        : COUNTS_NOT_RECORDED_TEXT
  const countNote =
    breakdown !== undefined
      ? {}
      : counts !== undefined
        ? { countNote: BREAKDOWN_NOT_RECORDED_TEXT }
        : withheld !== undefined
          ? { countNote: BREAKDOWN_WITHHELD_TEXT[withheld.reason] }
          : {}

  // A record the store served is the answer; the partial read is a note beside it.
  if (rows.length > 0) {
    return { state, countLine, ...countNote, rows, ...degraded, ...readNote, ...reconciled(settledCause) }
  }

  // Nothing to list and nobody could look: the sentence is the answer, so it carries no note.
  if (projection.learned.scanIncomplete === true) {
    return {
      state,
      countLine,
      ...countNote,
      sentence: CHANGES_UNREADABLE_TEXT,
      rows: [],
      scanIncomplete: true,
      ...reconciled(CHANGES_UNREADABLE_TEXT),
    }
  }

  // A snapshot whose buckets are all zero reads its own sentence, not the counts-absent one.
  if (breakdown !== undefined) {
    return counted === 0
      ? { state, countLine, ...countNote, sentence: NO_MEMORY_CHANGES_SENTENCE, rows: [], ...reconciled(settledCause) }
      : { state, countLine, ...countNote, sentence: CHANGES_NOT_AVAILABLE_TEXT, rows: [], ...reconciled(settledCause) }
  }

  if (counts === undefined) {
    return { state, countLine, ...countNote, sentence: COUNTS_NOT_RECORDED_SENTENCE, rows: [], ...snapshot }
  }

  return counts.curated === 0 && counts.deprecated === 0
    ? { state, countLine, ...countNote, sentence: NO_MEMORY_CHANGES_SENTENCE, rows: [], ...snapshot }
    : { state, countLine, ...countNote, sentence: CHANGES_NOT_AVAILABLE_TEXT, rows: [], ...snapshot }
}

// Each absence sends a reader somewhere different, so each keeps its own sentence.
export function projectKnowledgeView(read: KnowledgeRead): KnowledgeView {
  if (read.kind === 'unavailable') {
    return { state: 'error', heading: READ_FAILED_HEADING, body: readFailedBody(read.error) }
  }

  const projection = read.projection
  if (projection.kind === 'evidence-incomplete') return { state: 'evidence-incomplete' }

  // Checked BEFORE the steps are read: a run with no reader bound may still have steps, and every
  // one of them served nothing. Describing that as "retrieval served no lines" would be true and
  // useless — the actionable fact is that there is no store to serve from.
  if (projection.knowledgeStore === 'unbound') {
    return { state: 'empty-no-store', heading: NO_STORE_HEADING, body: NO_STORE_BODY }
  }

  const steps = projection.steps.map(step =>
    stepRow(
      step,
      curationWord(projection),
      projection.learned.canaryAttributions,
      projection.learned.scanIncomplete === true,
    ),
  )
  const summary = steps.length === 0
    ? NO_BRIEF_SERVED_TEXT
    : usedSummaryLine({
        stepsBriefed: steps.filter(row => row.briefLines > 0).length,
        canaryLines: steps.reduce((total, row) => total + row.canaryLines, 0),
        replays: steps.filter(row => row.planSource === 'procedure-replay').length,
        hints: steps.filter(row => row.planSource === 'procedure-hint').length,
      })

  const records = usedRecordViews(projection)
  const rung = projection.retrievalRung === undefined ? undefined : rungView(projection.retrievalRung)
  const retrieval = retrievalStatementView(rung)
  const used: UsedSectionView = {
    ...(records.length > 0
      ? { records, countLine: usedCountLine(records.length) }
      : { records, absence: steps.length === 0 ? NO_BRIEF_SERVED_TEXT : NO_BRIEF_LINES_TEXT }),
    ...(retrieval === undefined ? {} : { retrieval }),
  }
  const effect = effectSectionView(projection)

  return {
    state: 'ready',
    used,
    effect,
    ledger: { summary, steps, changes: changeLedgerViews(projection) },
    ...(rung === undefined ? {} : { rung }),
    learned: learnedView(projection),
  }
}

/**
 * The recorded rung, minus its storage stamp.
 *
 * `schemaVersion` is dropped rather than carried: it states which contract the value was WRITTEN
 * under, which is a fact about the handoff and not about the run, and a view member nothing
 * paints is a member a component can accidentally paint.
 */
function rungView(recorded: RecordedRetrievalRung): RungView {
  return {
    rung: recorded.rung,
    ...(recorded.reason === undefined ? {} : { reason: recorded.reason }),
  }
}

// The rung banner's copy of record

/**
 * The three degraded rungs, as a person reads them — and `memidex` is deliberately not a key.
 *
 * TYPED WITHOUT THE TOP RUNG so the absence is structural rather than remembered. A table with a
 * `memidex` label in it is a table a future caller can print, and printing anything for the top
 * rung would put an amber strip across every healthy run's header. `Exclude` makes "there is no
 * label for memidex" a compile error at the call site instead of a judgement call.
 */
export const RUNG_LABELS: Record<Exclude<RetrievalRung, 'memidex'>, string> = {
  'bundle-scan': 'bundle scan',
  'static-floor': 'static-floor embeddings',
  'lexical-only': 'lexical-only retrieval',
}

// Spelled here and in `doctor-knowledge-checks.ts`, because the CLI cannot import this package.
export const RUNG_CAUSE_LABELS: Record<RetrievalRungReason, string> = {
  'native-runtime-unavailable': 'native ONNX runtime unavailable',
  'profile-unresolved': 'embedder profile unresolved (deferred)',
  'model-not-downloaded': 'embedding model not downloaded',
  'embedder-load-failed': 'embedder failed to load',
  'index-unavailable': 'knowledge index unavailable (cause not recorded), scanning bundles',
  'floor-disabled': 'static floor disabled',
  'profile-static-configured': 'static profile configured',
  'index-not-built': 'knowledge index not built yet, scanning bundles',
  'index-locked': 'knowledge index locked by another process, scanning bundles',
  'index-corrupt': 'knowledge index corrupt, rebuild requested, scanning bundles',
}

// `doctor` reads the host as it is, so the banner points there rather than probing itself.
export const DOCTOR_HINT_TEXT = 'Run `agent-qa doctor`.'

// The class is derived from the recorded rung and reason only; it is never stored or probed.

export type RetrievalClass =
  | 'fresh-index'
  | 'cause-not-recorded'
  | 'index-problem'
  | 'semantic-search-unavailable'
  | 'by-configuration'

// prettier-ignore
export const RETRIEVAL_CLASSES = [
  'fresh-index',
  'cause-not-recorded',
  'index-problem',
  'semantic-search-unavailable',
  'by-configuration',
] as const satisfies readonly RetrievalClass[]

export type RetrievalTone = 'info' | 'warning'

// One `'key': 'value',` entry per line: the shipped-binary cells read both tables by that shape.
// prettier-ignore
export const RETRIEVAL_CLASS_BY_REASON = {
  'index-not-built': 'fresh-index',
  'index-unavailable': 'cause-not-recorded',
  'index-locked': 'index-problem',
  'index-corrupt': 'index-problem',
  'native-runtime-unavailable': 'semantic-search-unavailable',
  'model-not-downloaded': 'semantic-search-unavailable',
  'embedder-load-failed': 'semantic-search-unavailable',
  'profile-unresolved': 'semantic-search-unavailable',
  'profile-static-configured': 'by-configuration',
  'floor-disabled': 'by-configuration',
} as const satisfies Record<RetrievalRungReason, RetrievalClass>

// prettier-ignore
export const RETRIEVAL_CLASS_TONES = {
  'fresh-index': 'info',
  'cause-not-recorded': 'info',
  'index-problem': 'warning',
  'semantic-search-unavailable': 'warning',
  'by-configuration': 'info',
} as const satisfies Record<RetrievalClass, RetrievalTone>

/** Where a warning sends the reader. No backticks: `agent-qa doctor` renders in a code element. */
export const DOCTOR_POINTER_TEXT =
  "To check the store's health now, run agent-qa doctor. It reports current health and doesn't change what this run recorded."

/** `undefined` at memidex; a lower rung with no recorded reason claims neither a fault nor health. */
export function retrievalClassFor(rung: RungView): RetrievalClass | undefined {
  return rung.rung === 'memidex' ? undefined : classOfReason(rung.reason)
}

function classOfReason(reason: RetrievalRungReason | undefined): RetrievalClass {
  return reason === undefined ? 'cause-not-recorded' : RETRIEVAL_CLASS_BY_REASON[reason]
}

export function retrievalStatement(rung: Exclude<RetrievalRung, 'memidex'>, reason?: RetrievalRungReason): string {
  const retrievalClass = classOfReason(reason)
  switch (retrievalClass) {
    case 'fresh-index':
      return "The knowledge index hadn't been built yet, so this run read knowledge straight from the bundles. Nothing was missed. The index is built after the run finishes, and later runs use it."
    case 'cause-not-recorded':
      return `This run used ${RUNG_LABELS[rung]} instead of full knowledge retrieval. The reason wasn't recorded for this run.`
    case 'index-problem':
      return `This run couldn't use the knowledge index, so it read knowledge straight from the bundles — ${causeLabel(reason)}.`
    case 'semantic-search-unavailable':
      return rung === 'static-floor'
        ? `This run's knowledge retrieval used the lightweight static-floor embeddings instead of the full model — ${causeLabel(reason)}.`
        : `This run's knowledge retrieval ran without semantic search, on keyword and anchor matching only — ${causeLabel(reason)}.`
    case 'by-configuration':
      return reason === 'profile-static-configured'
        ? "This run's knowledge retrieval used the static-floor embeddings, as this project is configured to."
        : "This run's knowledge retrieval used keyword and anchor matching only, as this project is configured to."
    default: {
      const unreachable: never = retrievalClass
      return unreachable
    }
  }
}

function causeLabel(reason: RetrievalRungReason | undefined): string {
  return reason === undefined ? '' : RUNG_CAUSE_LABELS[reason]
}

// The tab's retrieval statement; `pointer` is present on the warning classes only.
export interface RetrievalStatementView {
  readonly retrievalClass: RetrievalClass
  readonly tone: RetrievalTone
  readonly rung: Exclude<RetrievalRung, 'memidex'>
  readonly reason?: RetrievalRungReason
  readonly sentence: string
  readonly pointer?: string
}

export function retrievalStatementView(rung: RungView | undefined): RetrievalStatementView | undefined {
  if (rung === undefined || rung.rung === 'memidex') return undefined
  const retrievalClass = classOfReason(rung.reason)
  const tone = RETRIEVAL_CLASS_TONES[retrievalClass]
  return {
    retrievalClass,
    tone,
    rung: rung.rung,
    ...(rung.reason === undefined ? {} : { reason: rung.reason }),
    sentence: retrievalStatement(rung.rung, rung.reason),
    ...(tone === 'warning' ? { pointer: DOCTOR_POINTER_TEXT } : {}),
  }
}

// Only warning classes paint a strip; information in an amber strip would read as a fault.
export function rungBannerText(rung: RungView | undefined): string | undefined {
  const statement = retrievalStatementView(rung)
  if (statement?.pointer === undefined) return undefined
  return `${statement.sentence} ${statement.pointer}`
}

// Never probes: the rung is the one recorded at serve time, so a host fix rewrites no past header.
export function bannerRung(read: KnowledgeRead | undefined): RecordedRetrievalRung | undefined {
  if (read === undefined || read.kind !== 'read') return undefined
  const projection = read.projection
  if (projection.kind !== 'ready' || projection.knowledgeStore === 'unbound') return undefined
  return projection.retrievalRung
}
