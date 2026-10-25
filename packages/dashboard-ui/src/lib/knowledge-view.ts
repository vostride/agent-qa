// THE KNOWLEDGE PROJECTION — the whole distance between what `runs.knowledge` said and what a
// person reads in the Knowledge tab.
//
// Phase 407-02 · LERN-01, D-01 / D-03 / D-04 / D-06 / D-16.
//
// IT IS PURE AND TOTAL. No I/O, no clock, no React. Its only input is a `KnowledgeRead` — the
// client's own bytes — so a state the panel paints can never be one the op did not say, and every
// read maps to exactly one view, including the reads nobody wants: a refused door, a pruned
// handoff, a project with no knowledge root, a run that served nothing. A projection with a hole
// in it renders blank, and a blank pane behind a tab someone pressed `7` to reach is the exact
// dishonesty D-04 was written against.
//
// THE SUMMARY LINE IS A DERIVATION, NEVER A SECOND READ (D-03). Every count below is folded from
// the step rows this same view already carries. Asking the op for an aggregate it could compute
// from rows already on the wire would create a second number that can disagree with the first.
//
// EVERY PUBLISHED SENTENCE IS AN EXPORTED CONSTANT (403-05 D-5). The cells assert against the
// constants and the components import them, so copy moves in one place; prose inlined in a
// component is prose that drifts from prose inlined in a test, and both of them stay green while
// the two disagree.
//
// SOME CONSTANTS BELOW HAVE NO READER YET, ON PURPOSE. The channel eyebrows, the why-trigger, the
// trace line and the cut-candidates label are the words 407-06 / 407-09 / 407-10 will paint.
// Publishing them here — with the shape of the `ready` arm they hang off — is what keeps those
// plans pure additions to a proven module rather than three private spellings of one contract.

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

/**
 * What the tab says when this project has no knowledge store at all (D-16).
 *
 * NOT A RUNG, AND NOT AN EMPTY RESULT. A run executed with no reader bound never asked retrieval
 * anything, so "nothing was served" would describe a search that came back empty — a different
 * fact, and one that would send an operator looking for a broken index instead of a missing
 * config key.
 */
export const NO_STORE_HEADING = 'No knowledge store configured for this project'

/** The no-store body: what this means, and the one thing that changes it. */
export const NO_STORE_BODY =
  'Runs in this project are executed without a brief. Add a knowledge root to your config to start serving one.'

/** What the tab says when the read itself failed or was refused — never a blank pane. */
export const READ_FAILED_HEADING = 'Knowledge could not be read'

/**
 * The read-failed body: the producer's own masked reason, then what to do about it.
 *
 * THE ERROR IS FORWARDED WITHOUT A SINGLE SLICE (T-407-07). It is the client's masked `request()`
 * message — a status name, never a stack and never a path — and truncating it here would leave a
 * reader with half a word to search for. The component renders it as a text node inside a
 * `break-words` paragraph, so a long one wraps rather than eating the doctor pointer.
 */
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

/** The Knowledge used section's heading — one `<h4>`, 16px/500 (UI-SPEC Typography). */
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

/** The fact badge on a step whose plan came from a replayed procedure (D-07). */
export const REPLAY_FACT = 'replay'

/** The fact badge on a step whose plan was hinted by a procedure (D-07). */
export const HINT_FACT = 'hint'

/** One step row's title: the ONE-BASED ordinal a person counts by, then the step's own text. */
export function stepRowTitle(stepIndex: number, stepText: string): string {
  return `Step ${String(stepIndex + 1)} — ${stepText}`
}

/** The four derived counts the summary line is folded from (D-03). */
export interface UsedCounts {
  readonly stepsBriefed: number
  readonly canaryLines: number
  readonly replays: number
  readonly hints: number
}

/**
 * The run-level count line, DERIVED from the rows the panel already holds (D-03).
 *
 * A ZERO SEGMENT IS OMITTED, not printed as a zero. `0 canary lines served` claims somebody
 * measured canary attribution on this run and found none; the absent segment says the subject
 * never came up. The whole-line fallback exists for exactly the case where every segment would
 * have been dropped, because a bare `·` separator with nothing around it is not a sentence.
 */
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

// ─────────────────────────────────────────────────────────────────────────────
// The four-section tab and its grouped used rows (427 · D-02, D-04, D-05, D-07, D-19)
// ─────────────────────────────────────────────────────────────────────────────

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

// 427 D-03: the page's side of a step reference. The tab only calls back; selection, playhead and
// scroll stay page state.
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

// The schema's record-kind enum, derived rather than re-spelled (C427-RECORD-KINDS-EXACT).
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

// The render order of anchor phrases (D-08): whatever order the anchors array holds, a line reads
// platform, page, flow, element, selector, error, then anything that did not parse.
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

// The schema's status enum, derived rather than re-spelled (C427-STATUS-WORDS-SHAPE).
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

// Steps are sorted explicitly rather than trusting wire order (RESEARCH A3); within a step the
// serving order is channel 1, channel 3, plan source, channel 2 (UI-SPEC S1). A Map keeps first use.
// The Effect section reads the same map, so both sections name a record the same way.
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
  /** How retrieval ran for this run, stated under the heading; absent at memidex or with no rung (D-20). */
  readonly retrieval?: RetrievalStatementView
}

// 427 · D-11..D-14 — the Effect section: measured effects only. The two folds are the shipped
// canaryOutcomeWord and brokeAt; this block re-words their answers and never re-derives them.

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

// The order entries group in (D-11): problems first, unknowns last.
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

// Every entry names its steps (D-11), so pending and unknown carry them too.
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
      // A skipped canary is no trial and is not uncounted either: the uncounted line says post-run
      // processing finished, and a skipped run's never ran. It falls to the unmeasured records (444 D-61).
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

// ─────────────────────────────────────────────────────────────────────────────
// Reserved copy — published now, painted by 407-06 / 407-09 / 407-10
// ─────────────────────────────────────────────────────────────────────────────

/** The three served channels, as the eyebrow captions inside an expanded step row (407-06). */
export const CHANNEL_EYEBROWS = {
  1: 'CHANNEL 1 · BRIEF',
  2: 'CHANNEL 2 · READ TRACES',
  3: 'CHANNEL 3 · CAUTIONS',
} as const

/**
 * One answered trace line: which leg ranked it, where, and how strongly (D-04, 407-06).
 *
 * Three decimal places because that is the resolution at which two adjacent candidates stop
 * looking identical; rendered `tabular-nums` so a column of them does not jitter.
 */
export function traceLineText(leg: string, rank: number, score: number): string {
  return `leg ${leg} · rank ${String(rank)} · score ${score.toFixed(3)}`
}

/**
 * The truncated-ledger disclosure (D-04, 407-06).
 *
 * THE CAP IS IMPORTED, NEVER TYPED. `TRACE_TRUNCATION_TOP_K` is the producer's own bound; a
 * literal `20` here would be a second copy of it that goes silently wrong the day the producer
 * moves.
 */
export function cutCandidatesLabel(count: number): string {
  return `Cut candidates (${String(count)} of top ${String(TRACE_TRUNCATION_TOP_K)})`
}

/** The `pre-trace-run` no-trace arm, stated rather than dropped (D-04). */
export const PRE_TRACE_TEXT = 'no trace was captured for this run'

/** The `step-not-found` no-trace arm, stated rather than dropped (D-04). */
export const STEP_NOT_FOUND_TEXT = 'no evidence recorded for this step'

/** The serve-time canary marker, worn by every canary line whatever curation did with it (D-08). */
export const CANARY_BADGE_TEXT = 'canary'

/** The canary marker as Retrieval details states it, beside the line's record id (427 D-19). */
export const LEDGER_ON_TRIAL_TEXT = 'on trial (canary)'

/** The four outcomes the store can attribute to a canary line, as opposed to the three non-answers. */
export type AttributedOutcomeWord = Extract<CanaryOutcomeWord, 'confirmed' | 'contradicted' | 'helpful' | 'harmful'>

/** The store's attribution word for a canary line, in plain text (427 D-19). */
export function attributionWordText(outcome: AttributedOutcomeWord): string {
  return `attribution: ${outcome}`
}

/** A served line's serve-time facts as one mono meta line (427 D-19). */
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

/**
 * The retrieval level one step recorded, stated only below `memidex` (427 D-19). A step whose rung
 * differs from the run's therefore says so on its own ledger row.
 */
export function ledgerRungLine(rung: Exclude<RetrievalRung, 'memidex'>, reason?: RetrievalRungReason): string {
  const cause = reason === undefined ? '' : ` — ${RUNG_CAUSE_LABELS[reason]}`
  return `Retrieval level: ${RUNG_LABELS[rung]}${cause}`
}

/**
 * What a canary line says while curation is still `pending` or `running` (D-08).
 *
 * NOT BLANK, AND NOT AN OUTCOME. "Nobody has decided yet" is a different fact from "the fold ran
 * and attributed nothing", and a line that rendered neither would read as though the canary had
 * simply not mattered.
 */
export const ATTRIBUTION_PENDING_TEXT = 'attribution pending'

/**
 * What a canary line says when curation was skipped and served no row for it (444 D-61).
 *
 * A WORD ABOUT THE LINE, NOT A REASON. Nobody will ever decide this line's attribution, which is a
 * different fact from `pending` (nobody has decided yet) and from `not attributed` (the fold ran
 * and found nothing). The reason is stated once on the tab, in Memory changes, from the
 * post-processing card's own sentence map.
 */
export const ATTRIBUTION_SKIPPED_TEXT = 'attribution skipped'

/**
 * What a canary line says when the store was consulted and answered no (D-08 · 407-22).
 *
 * ONE WORLD ONLY, AND IT IS A MEASUREMENT: the curation chain SETTLED, the store walk COMPLETED,
 * and no surviving outcome carried this line's observation id. It no longer covers a failed chain
 * — a chain that fell over is a fact about the chain, reported by the chip, and it cannot
 * un-commit an outcome the store already served (owner ruling 2026-08-30, UAT item 11). Nor does
 * it cover a partial read; {@link ATTRIBUTION_UNKNOWN_TEXT} is the word for the absence of an
 * answer.
 */
export const NOT_ATTRIBUTED_TEXT = 'not attributed'

/**
 * What a canary line says when the read that would have answered it was PARTIAL (407-18 · WR-02).
 *
 * THE SIBLING ABOVE IS A POSITIVE CLAIM. `not attributed` says the store was consulted and no
 * outcome survived for this line — a fact somebody measured. This one says the opposite kind of
 * thing: nobody could finish looking. 407-14's op ships `canaryAttributions: []` whenever the
 * attribution scan folded a `KnowledgeMaintenanceScanError`, so without this word every served
 * canary on a partial read asserted a `no` the store never gave — while the same projection was
 * telling the Learned half that nobody could look. One wire member, one story on both halves.
 *
 * A SECOND WORLD REACHES IT SINCE 407-22: a FAILED chain over an unreadable part of the store,
 * with no row served. A failed chain is exactly as unable to answer "was anything attributed?" as
 * a settled one when nobody could finish the walk — so it is the FLAG that decides the word here,
 * never the chip. The chain's failure is evidence about the chain; how much of the store could be
 * read is a separate fact, and it is the one this word reports.
 */
export const ATTRIBUTION_UNKNOWN_TEXT = 'attribution unknown'

/** The plan-source sentence for a step whose plan a procedure only HINTED at (D-07). */
export const PROCEDURE_HINT_TEXT = 'procedure hint'

/**
 * The hint sentence for a hint that was a REPLAY RECOMMENDATION first (D-07, G-381-4).
 *
 * The distinction is the whole reason `demotion` is on the wire: a demoted replay and an ordinary
 * served hint are byte-identical in what they served, and only the recorded demotion tells a
 * reader that the procedure was trusted enough to replay and then was not.
 */
export const PROCEDURE_HINT_DEMOTED_TEXT = 'procedure hint (demoted from replay)'

/** The replay sentence when the guard passed every check it had (D-07). */
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

/** How many lines of one channel render before the rest go behind a disclosure (UI-SPEC). */
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

/** The Memory changes section's heading — one `<h4>`, 16px/500 (427 D-02, was the Learned half). */
export const MEMORY_CHANGES_HEADING = 'Memory changes'

// ─────────────────────────────────────────────────────────────────────────────
// The Learned half's copy (407-09 · LERN-02, D-09 / D-10 / D-11 / D-12)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the half says while curation has not settled (D-12; re-copied in the section's words, 427).
 *
 * A SENTENCE, NOT A SKELETON. A skeleton claims bytes are on their way and will arrive shortly;
 * curation is a chain a daemon may not have picked up yet, and 404's own posture text exists
 * because "pending" can mean hours. The sentence names the CONDITION the changes depend on, which
 * is the only thing a reader can act on — and it is the same sentence for `pending` and `running`
 * because the reader is waiting on one fact either way.
 */
export const CHANGES_PENDING_TEXT = 'Memory changes appear after post-run processing finishes.'

/**
 * What the half says when curation failed (D-12).
 *
 * IT STATES THE CONSEQUENCE, not just the failure. An empty record list under a `failed` chip
 * reads as "curation ran and changed nothing" to anyone not staring at the chip — the exact
 * collapse between a failure and a settled no-op that D-12 was written against.
 */
export const CURATION_FAILED_TEXT = 'Curation failed — nothing was learned from this run.'

/**
 * The note that rides BESIDE records a failed chain had already committed (407-26 · G-407-12).
 *
 * A NOTE, NEVER A REPLACEMENT. It is published in {@link LearnedView.chainNote} rather than in
 * `sentence`, whose own contract is "absent exactly when rows is non-empty": a sentence printed
 * over painted rows is a second, quieter account of the same records, which is the thing CR-04
 * forbids. This one rides UNDER them, exactly as {@link STORE_READ_INCOMPLETE_TEXT} rides under
 * an answer whose read was partial.
 *
 * ITS SIBLING ABOVE COULD NOT SIMPLY BE REUSED. `Curation failed — nothing was learned from this
 * run.` is a positive, falsifiable claim; printed over records the same `RunKnowledgeProjection`
 * carries, it is a claim that projection disproves (REVIEW CR-01). Relocating it beside the rows
 * would relocate the falsehood, not retire it. So the stronger sentence is kept for the one arm
 * where nothing falsifies it — `rows.length === 0` — and this weaker pair of facts, both true at
 * once, is what a reader gets when there is something to list.
 *
 * ITS WORDING IS NOT SETTLED. The string is the round-3 review's own proposed wording, verbatim,
 * so the owner rules on a sentence already in front of them — but it JOINS UAT item 10's open
 * copy decision rather than arriving approved, and the UI-SPEC row it belongs beside is still to
 * be written (407-27).
 */
export const CURATION_FAILED_PARTIAL_TEXT =
  'Curation failed — these records were committed before it stopped.'

/**
 * The heading's sentence when a settled row committed no counts (D-12).
 *
 * The chip's {@link COUNTS_NOT_RECORDED_TEXT} says the same fact as a fragment beside a badge;
 * this is the sentence form, in the half that has room for one. Both are published, neither is
 * derived from the other by casing, and the cells pin both — a sentence built by upper-casing a
 * fragment is a sentence that breaks the day the fragment gains a leading noun.
 */
export const COUNTS_NOT_RECORDED_SENTENCE = 'Counts not recorded for this run.'

/**
 * What the half says when the counts moved but no change record reached this run (D-10).
 *
 * `yet` is load-bearing. The run link is stamped on the change record by the reader's own
 * `diffSince`, and a change whose attribution is not derivable carries no run id at all rather
 * than a guessed one. So "no rows" here is an absence of ATTRIBUTION, not an absence of change —
 * and the counts beside it, which did move, stay on screen to say so.
 */
export const CHANGES_NOT_AVAILABLE_TEXT = 'Change records for this run are not available yet.'

/**
 * What the half says when the knowledge store could not be READ at all (407-14 · 407-15).
 *
 * A DIFFERENT ABSENCE FROM ITS SIBLING ABOVE, and the distinction is the whole reason it exists.
 * {@link CHANGES_NOT_AVAILABLE_TEXT} names an absence of ATTRIBUTION — the store answered and no
 * change carried this run's id. This one names an absence of a READABLE STORE: 407-14's op folded
 * a `KnowledgeMaintenanceScanError` and published `learned.scanIncomplete` rather than letting the
 * failure masquerade as an empty list. Telling that reader to wait — `yet` — would send them back
 * to a page that will never fill on its own, so this sentence sends them to the one door that
 * grades the same fold instead.
 */
export const CHANGES_UNREADABLE_TEXT = 'Change records could not be read from the knowledge store. Run `agent-qa doctor`.'

/**
 * The note that rides BESIDE an answer whose read was only partly successful (407-18 · CR-01).
 *
 * A DIFFERENT CLAIM FROM ITS SIBLING ABOVE, and the difference is the whole point.
 * {@link CHANGES_UNREADABLE_TEXT} stands ALONE: there was nothing to list and nobody could look,
 * so the sentence IS the answer. This one never stands alone — it rides under rows the store did
 * serve, or under an unsettled-chain sentence, and says the answer on screen is real while the
 * read behind it was partial. 407-14's op folds its two Learned enrichments INDEPENDENTLY, so
 * `{ scanIncomplete: true, changes: [<a row>] }` is a sanctioned shape; the flag DECORATES the
 * answer and never replaces it. Same door as every other degradation in this tab, because it is
 * the same fold `doctor` grades.
 */
export const STORE_READ_INCOMPLETE_TEXT = 'The knowledge store could not be fully read. Run `agent-qa doctor`.'

/** What the half says when curation settled having changed nothing (D-12; the section's words, 427). */
export const NO_MEMORY_CHANGES_SENTENCE = 'Post-run processing finished and changed nothing in memory.'

/**
 * The reconciliation's LAST cause, when the read justifies none of the others (425-06 · D-19).
 *
 * NEVER SILENT, NEVER A GUESS. A snapshot that counted more changes than the half can show is a
 * disagreement between two producers, and the one thing this module must not do is pick whichever
 * number looks tidier. Its two siblings — {@link CURATION_FAILED_PARTIAL_TEXT} and
 * {@link CHANGES_UNREADABLE_TEXT} — are causes the read PROVED; this one is what honest ignorance
 * sounds like, and it is a sentence rather than an absence precisely because a reader who can see
 * the gap deserves to be told nobody could account for it.
 */
export const RECONCILIATION_UNATTRIBUTED_TEXT =
  "The difference could not be attributed to this run's rows."

/**
 * `{counted} changes counted · {shown} shown` — the gap itself, before its cause (D-19).
 *
 * THE NOUN AGREES WITH THE COUNT and the second number is bare, the same idiom the breakdown line
 * uses: `1 change counted · 0 shown` reads as a sentence, and `1 changes` reads as a bug.
 */
export function reconciliationCountText(counted: number, shown: number): string {
  return `${String(counted)} ${counted === 1 ? 'change' : 'changes'} counted · ${String(shown)} shown`
}

/**
 * The change kinds the Learned half paints — FIVE of the record's six (D-10, widened by 407-15).
 *
 * `added` IS WHAT THE RUN TAUGHT THE STORE. 407-04 stamps `sourceRunId` onto the synthetic `added`
 * change from the bundle's own `provenance.runId` precisely so a run-linked record's birth is
 * attributable to the run that produced it: a fact that exists because this run ran is this run's
 * teaching, not the store's bookkeeping. Under the earlier four-kind table the commonest curation
 * outcome — one new fact, nothing deprecated — was served by the op, correctly attributed, then
 * dropped here, and the half printed `Change records for this run are not available yet.` beside
 * a count line saying one fact had been curated (REVIEW CR-04, VERIFICATION gap 2).
 *
 * `purged` stays out: a deletion is a maintenance action taken ON the store, never something a run
 * taught it. `promoted` is in — it is the promotions kind D-10 names.
 *
 * THE WIDENING BENDS A LOCKED DECISION and says so. D-10 enumerates four kinds; this table carries
 * five as reconciliation R-407-15-01, pending the user's ruling alongside UAT items 6–8. If the
 * ruling goes the other way the revert is this entry, one `KIND_LOOK` arm and one sentence arm —
 * the widening was made only at the view, never in the schema, the op or the store.
 *
 * A closed `as const` table rather than a predicate, so the component's badge switch and the cells
 * both spell the vocabulary once and a sixth kind is a compile error rather than a silent drop.
 */
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

// 427 · D-15..D-17 — Memory changes speak 425's five words. Lower-cased, each label IS the bucket
// key `curationBreakdownLine` prints, so the rows and the heading share one vocabulary (SC3).
export const BUCKET_LABELS = {
  added: 'Added',
  confirmed: 'Confirmed',
  superseded: 'Superseded',
  deprecated: 'Deprecated',
  proposed: 'Proposed',
} as const satisfies Record<CurationBucket, string>

// 427 D-16 — what each bucket word means, as its label's tooltip and sr-only text.
export const BUCKET_MEANINGS = {
  added: 'New knowledge recorded from this run.',
  confirmed: 'Existing knowledge this run backed up, including knowledge promoted to trusted.',
  superseded: 'Replaced by a newer version; agents are given the new one.',
  deprecated: 'Retired; agents are no longer given it.',
  // 2026-10-03 (quick 261003-cpv, 432-UI-REVIEW fix 1): nothing reviews a proposed record. Learning
  // stays proposed in CI (D-08) and where delta validation refused it; it is recorded, not applied.
  proposed: 'Recorded, but not applied: agents are not given it.',
} as const satisfies Record<CurationBucket, string>

// A change seen without a snapshot maps onto the same words; Proposed is never synthesized (425 D-18).
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

// 427 · D-19 part 2 — the Retrieval details rows for one changed record, in render order.
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

// ─────────────────────────────────────────────────────────────────────────────
// The expanded step row — channels, why-traces, cut ledger, plan source (407-06)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WHY this line was served — the trace's own answer, or the NAMED absence of one (D-04).
 *
 * EXACTLY TWO KINDS. Either the serve-time trace recorded this record and the panel prints what it
 * recorded, or it did not and the panel prints which of the three absences applies. There is no
 * third kind, because a third kind would be a rendering with no evidence behind it — and the one
 * thing this surface must never do is compute a rank or a score of its own. The numbers below are
 * READ from `trace.servedLines`; re-deriving them would answer about the index as it stands now
 * rather than about the moment the brief was assembled (KREV-02's founding argument).
 */
export type LineWhy =
  | {
      readonly kind: 'answered'
      readonly leg: RetrievalTraceLeg
      readonly rank: number
      readonly score: number
    }
  | { readonly kind: 'no-trace'; readonly reason: BriefWhyNoTraceReason }

/**
 * The word a canary line wears — one of EIGHT, and never blank (D-08, widened by REVIEW WR-02).
 *
 * `unknown` is the seventh and it is not a shade of `not-attributed`: one says the fold answered
 * and found nothing, the other says the read behind the answer was partial (407-18). `skipped` is
 * the eighth: curation never ran for this run, so nobody will answer (444 D-61).
 */
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

/** One channel-2 read trace, as the Retrieval details row renders it (427 D-19 shows the digest). */
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

/** The truncated ledger — the answer to "why did it NOT say X" (D-04). */
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

/** A step's recorded retrieval level, present only when it was below `memidex` (427 D-19). */
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

/**
 * The channel-1 lines with their trace answers, matched by `recordId` (D-04, LERN-01).
 *
 * THE TRACE IS PASSED EXPLICITLY, beside the step it belongs to, so the join is visible at every
 * call site rather than buried one dereference deep.
 *
 * THE `step-not-found` MAPPING IS THE ONE JUDGEMENT HERE. A trace that ANSWERED the step but
 * carries no `servedLines` entry for this record is a PER-LINE absence: the run recorded evidence
 * for the step and none for the line. That is the same situation `step-not-found` names one level
 * up — evidence exists, the thing being asked about is not in it — so the line borrows that arm
 * rather than inventing a fourth word no other surface renders. It is deliberately NOT
 * `artifact-missing` (nothing was pruned) and NOT `pre-trace-run` (a trace plainly exists).
 */
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

/**
 * The cut ledger, present ONLY where a trace answered (D-04).
 *
 * An answered trace that truncated nothing still gets the disclosure, reading `(0 of top 20)`:
 * "the budget cut nothing" is a fact the trace recorded, and it is a different answer from "there
 * is no trace to ask". Where there is no trace there is no ledger at all — an empty one would
 * claim a measurement nobody took.
 */
export function cutCandidates(trace: RunKnowledgeTrace): CutCandidatesView | undefined {
  if (trace.kind === 'no-trace') return undefined
  return { label: cutCandidatesLabel(trace.trace.truncated.length), lines: trace.trace.truncated }
}

/**
 * What a canary line says, from the curation word, the attribution and the READ — never blank.
 *
 * ORDER MATTERS, AND THERE ARE FOUR ARMS (D-08 · REVIEW WR-02 · 407-22, owner ruling 2026-08-30;
 * 444 D-61). The chain's own word is consulted on two lines of this function — the first, for an
 * unsettled chain, and the third, for a skipped one — and the row decides between them. Four
 * movements, in this order:
 *
 *   1. AN UNSETTLED CHAIN IS READ FIRST. `pending` and `running` mean nobody has decided yet, and
 *      that outranks both a stale row from an earlier fold and a partial read: presenting a
 *      previous fold's attribution as this run's answer while the current one is still working
 *      would be the page answering a question that is still open.
 *
 *   2. THEN A ROW THAT WAS READ WINS — ON EITHER SETTLED ARM, WITH NO STATUS CONJUNCT. An
 *      attribution the store served is a real answer whatever else the scan could not reach, and a
 *      chain that fell over cannot un-commit an outcome event it already appended. The chip beside
 *      this line is where the chain's fate is reported; repeating it here as `not attributed`
 *      would be a SECOND and different claim — that the store was consulted and said no — made
 *      while this very projection holds the row that disproves it. Same `rows win` law the Learned
 *      half follows — a claim this sentence made from 407-22 until 407-26, when
 *      {@link learnedView}'s own `failed` arm was finally moved below its rows fold and the two
 *      halves stopped disagreeing (REVIEW CR-01 · G-407-12).
 *
 *   3. THEN, WITH NO ROW, A SKIPPED CHAIN SAYS `skipped`. Curation never ran, so neither of the
 *      read's words below applies: nobody looked, and nobody will (444 D-61).
 *
 *   4. OTHERWISE, WITH NO ROW, THE READ DECIDES. `unknown` when the flag is set, because nobody
 *      could finish looking; `not attributed` when it is clear, because the walk completed and no
 *      surviving outcome carried this line's observation id — a fact somebody measured.
 *
 * THE FOURTH ARM WAS DELETED, NOT REORDERED. From 407-06 (`a795316e`) to 407-21 a standalone arm
 * answered `not attributed` for a FAILED chain, and 407-18's must_haves restated it. Once the row
 * is consulted first, the only case that arm still governed is the NO-row case — and that case is
 * properly decided by the READ, which is the fact that actually determines whether anybody was
 * able to answer, where the chain's failure is evidence about the chain. The owner ruled the arm
 * out on 2026-08-30 (UAT item 11 / G-407-11 / REVIEW CR-01); this function's own law, two
 * paragraphs above, had said as much since 407-06 while the code below it said otherwise.
 *
 * `scanIncomplete` DEFAULTS TO FALSE so every existing caller keeps the word it had.
 */
export function canaryOutcomeWord(
  curation: CurationWord,
  attribution: RunKnowledgeCanaryAttribution | undefined,
  scanIncomplete = false,
): CanaryOutcomeWord {
  // 2026-10-18 (444-29, D-61): the first parameter is the tab's curation word, so a gate run or an
  // outcome-excluded run no longer reads `pending` from its defaulted chip. A served row still wins.
  if (curation === 'pending' || curation === 'running') return 'pending'
  if (attribution !== undefined) return attribution.outcome
  if (curation === 'skipped') return 'skipped'
  return scanIncomplete ? 'unknown' : 'not-attributed'
}

/**
 * The replay or hint sentence a step's plan source states (D-07).
 *
 * A GUARD MEMBER BEATS THE COUNT. `checksPassed === total` alongside a recorded `verifierRejection`
 * is a guard that got through its checks and was refused anyway; printing `replayed 5/5` there
 * would report a replay that did not happen. Precedence is miss → adapter → verifier: the earliest
 * point at which the replay stopped being possible is the one worth naming.
 */
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

/** The plan-source row: its sentence and the tone the UI-SPEC tints its badge by. */
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
  /** Channel-1 lines carrying the serve-time canary marker (D-08). */
  readonly canaryLines: number
  readonly planSource: StepPlanSourceWord
  /** The outline badges, in render order. Empty exactly when {@link noBrief} is set. */
  readonly facts: readonly string[]
  /** Present only on a step that served nothing; the row renders {@link STEP_NO_BRIEF_TEXT}. */
  readonly noBrief?: true
  /**
   * What the row shows when it is EXPANDED (407-06).
   *
   * Required, not optional: a row whose detail could be absent is a row a component has to guard,
   * and the guard would render blank for the one case D-04 exists to prevent. A step that served
   * nothing carries three empty channels — an answer, not a hole.
   */
  readonly detail: StepDetailView
}

/**
 * The six words the Learned half's root can carry (D-12; 444 D-61).
 *
 * FOUR OF THEM MIRROR THE CURATION CHIP and two are words the chip cannot say. A reader
 * looking at the header and the panel at once must not see two different accounts of the same
 * chain; `counts-absent` is an extra state because "settled, and nobody wrote the numbers down"
 * is a fact about the frozen row rather than about the chain, and collapsing it into `complete` would
 * make an unrecorded run indistinguishable from one that changed nothing. `skipped` is the other:
 * the run's own record says curation never ran (444 D-39), and the chip beside it is a defaulted
 * `pending` no job will move — see {@link curationWord}.
 */
export type LearnedState = 'pending' | 'running' | 'complete' | 'failed' | 'counts-absent' | 'skipped'

export type LearnedLeadSource = 'joined' | 'absent' | 'not-recorded'

/** The old record beneath a supersession row: its summary, or why it cannot be shown. */
export interface SupersededWasView {
  readonly primary: string
  readonly leadSource: LearnedLeadSource
}

/**
 * One record this run's curation affected, in its strongest bucket (427 D-15).
 *
 * NO ID, REFERENCE OR RECEIPT RIDES ON A ROW (D-19). Those live in the matching
 * {@link ChangeLedgerView}, which only Retrieval details renders. `key` is the row's position
 * across the whole list (curation rows, then since-then rows), rebuilt on every render.
 */
export interface LearnedRowView {
  readonly key: string
  readonly bucket: CurationBucket
  /**
   * Which of the op's two sections this row is in (423 D-15). Present only beside a recorded
   * snapshot: without one there is nothing to section against, and the half says so instead.
   */
  readonly section?: LearnedRowSection
  readonly primary: string
  readonly leadSource: LearnedLeadSource
  readonly kind?: RecordKind
  readonly content?: RunKnowledgeRecordContent
  readonly contentAbsence?: RunKnowledgeContentAbsence
  readonly applicability?: ApplicabilityView
  /** A supersession's old record; the row itself leads with the new version. */
  readonly was?: SupersededWasView
  /** Proposed rows only (D-16). */
  readonly note?: string
  /** Since-then rows only (D-17): what happened later. */
  readonly sinceDetail?: string
}

export type LearnedRowSection = 'curation' | 'since-then'

/** The fixed curation snapshot, as far as this half reads it (423 D-15). */
export interface LearnedSnapshotView {
  /** Copied verbatim from the checkpoint; never re-counted from rows. */
  readonly breakdown: CurationBreakdown
  /** `learned.sinceThen.count`, verbatim. Absent when the op served no since-then section. */
  readonly sinceThenCount?: number
  /**
   * The snapshot's total against the curation rows this half can show (425-06 · D-19).
   *
   * PRESENT EXACTLY WHEN THEY DISAGREE. A heading that quietly printed five counted changes over
   * two painted rows would leave the reader to spot the arithmetic themselves — and to guess at
   * the reason if they did. So the gap is stated in `count` and accounted for in `cause`, and when
   * the two numbers agree the member is absent rather than a line saying so: a reconciliation
   * nobody needs is noise on every healthy run in the project.
   */
  readonly reconciliation?: { readonly count: string; readonly cause: string }
}

/**
 * The Learned half, as the panel paints it (407-09).
 *
 * `rows` IS REQUIRED AND `sentence` IS NOT, which is the shape of the contract rather than a
 * convenience: every state has a list (empty for four of them) and exactly the states with nothing
 * to list carry a sentence. A half with neither would render blank, and a blank half beside a
 * populated Used half is the dishonesty D-12 exists to forbid — so `learnedView` below is total
 * and every arm sets one or the other.
 */
export interface LearnedView {
  readonly state: LearnedState
  /** The chip's own count line, from the chip's own function — one number, one wording (D-09). */
  readonly countLine?: string
  /**
   * What the count line above could NOT record, labelled (425-06 · D-18).
   *
   * A SECOND ELEMENT, NOT A SECOND CLAUSE. `2 curated · 0 deprecated` is a measurement; `Breakdown
   * not recorded for this run` is a fact about the measurement, and a reader scanning counts should
   * not have to parse the second out of the first. Present only beside a coarser or withheld
   * record; absent beside a recorded breakdown, which needs no apology.
   */
  readonly countNote?: string
  /** The state sentence. Absent exactly when {@link LearnedView.rows} is non-empty. */
  readonly sentence?: string
  readonly rows: readonly LearnedRowView[]
  /**
   * Present only when the op could not READ the knowledge store (407-14).
   *
   * True or absent, never `false` — the same idiom the wire flag it mirrors is typed with
   * (`z.literal(true).optional()`). The component stamps `data-learned-read="incomplete"` from it,
   * so a degraded half is addressable by a cell rather than inferred from its sentence.
   */
  readonly scanIncomplete?: true
  /**
   * {@link STORE_READ_INCOMPLETE_TEXT}, for the renderings where a PERSON must see the partiality.
   *
   * Present exactly when {@link LearnedView.scanIncomplete} is true AND the half is not already
   * printing {@link CHANGES_UNREADABLE_TEXT} — that sentence names the store itself, and a note
   * repeating the same door beneath it would be a nag rather than news. Absent otherwise, never
   * an empty string: `data-learned-read` is the cell-visible half of this fact, and the note is
   * the person-visible half (D-04, D-12).
   */
  readonly readNote?: string
  /**
   * {@link CURATION_FAILED_PARTIAL_TEXT}, when a SETTLED-AND-FAILED chain has rows to list.
   *
   * THE SIBLING OF {@link LearnedView.readNote}, AND DELIBERATELY NOT THAT SLOT. The chain's fate
   * and the store's readability are two independent producers — 407-14's op folds `curation` and
   * `learned` separately, and the conformance file's `attributed-failed` world carries
   * `{ status: 'failed', scanIncomplete: true }` at once — so one slot could only ever report one
   * of them, and whichever it reported would be silently speaking for the other. That is the
   * coupling round-2 WR-03 named; two notes is the fix, not one flag with two meanings.
   *
   * The chain's fate beside rows, for a failed or a skipped chain. Present exactly when `state` is
   * `failed` or `skipped` AND {@link LearnedView.rows} is non-empty; absent everywhere else,
   * including the no-rows `failed` and `skipped` arms, which keep their sentence in `sentence`. A
   * failed chain's note is {@link CURATION_FAILED_PARTIAL_TEXT}; a skipped chain's is the
   * post-processing card's own curation sentence for the reason, from `STAGE_SKIPPED_TEXT` (444
   * D-61). It never carries a fact about the store read (407-26 · G-407-12).
   */
  readonly chainNote?: string
  /**
   * Present exactly when the op served curation's fixed snapshot (423 D-15). Absent for a failed
   * or pre-423 chain, and the component states that absence rather than painting zero counts.
   */
  readonly curationSnapshot?: LearnedSnapshotView
}

/** The rung that served THIS run, if the evidence recorded one (D-13). */
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

/** The per-step ledger Retrieval details holds — the shipped summary line and step rows, moved (D-19). */
export interface LedgerView {
  readonly summary: string
  readonly steps: readonly StepRowView[]
  /** One entry per Memory changes row, in row order (427 D-19 part 2). */
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
    // A step that served nothing keeps its row and says so. Dropping it would make a run look
    // shorter than it was, and D-04's whole posture is that nothing silently drops.
    ...(briefLines === 0 ? { noBrief: true as const } : {}),
    detail: stepDetail(step, curation, attributions, scanIncomplete),
  }
}

/**
 * The expanded body of one step row — THE ONLY PLACE THE CANARY OUTCOME WORD IS DECIDED.
 *
 * The join is on all three of `testIndex`, `stepIndex` and `recordId`. `stepIndex` is numbered per
 * member test, so a run with two tests has two step 0s; joining on the pair alone would attribute
 * one member's canary outcome to another member's line, which is the exact wrong-attribution
 * failure D-10 was written against one layer down.
 *
 * `scanIncomplete` IS A FACT ABOUT THE STORE READ, AND IT REACHES BOTH HALVES FROM ONE WIRE MEMBER
 * (REVIEW WR-02). `learned.scanIncomplete` is where the op records that it could not finish
 * looking, and the empty `canaryAttributions` list beside it is a CONSEQUENCE of that, not an
 * answer. Threading the flag down here is what stops this half asserting a `no` the other half is
 * simultaneously saying nobody was able to give.
 */
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

/**
 * The canonical entity URI for a changed record, or nothing (D-10).
 *
 * BUILT BY THE SCHEMA'S CODEC, NEVER BY CONCATENATION. `formatEntityUri` is the one place the
 * scheme, the kind segment and the short-ID canonicalisation live; a template literal here would
 * be a second spelling of an address format that three other surfaces already publish, and it
 * would go on producing well-formed-looking URIs after the codec moved.
 *
 * MOST RECORD IDS ARE NOT ENTITY ADDRESSES, and this is the honest answer to that. A change record
 * carries a record-grain id — content-derived, like `fact-page-https-example-com-0f9a` — while the
 * entity URI scheme names a MEM-ordinal short-ID minted by the entity ledger, which this
 * dashboard has no access to. So the reference is built only for an id that ALREADY is a MEM
 * short-ID, and every other row renders its id and no reference. Feeding a bundle id to the codec
 * would throw; guessing an ordinal for it would mint an address to a different record.
 */
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

// D-15: with a snapshot the rows ARE its rows, so they equal the breakdown; later changes follow as
// their own rows (D-17). Without one, changes group per record in first-appearance order, and a
// replacement's Add folds into the supersession it completes.
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

/** The tab's one word for curation: the chip's four, or `skipped` (444 D-61). */
export type CurationWord = PostProcessingChipStatus | 'skipped'

// 2026-10-18 (444-29, D-61): the one place the Knowledge tab reads the curation chip. A gate run
// and an outcome-excluded run never enqueue curation, so their chip is a defaulted `pending` that no
// job will ever move; `runs.knowledge` carries the skipped fact beside it (444-26), and that fact
// outranks the chip. Every reader below takes this word, and the tab states the reason only through
// `STAGE_SKIPPED_TEXT`, the post-processing card's own sentence map.
export function curationWord(projection: Extract<RunKnowledgeProjection, { kind: 'ready' }>): CurationWord {
  return projection.curation.skipped === undefined ? projection.curation.status : 'skipped'
}

/**
 * Retrieval details' memory-changes part: one entry per Memory changes row, in the same order
 * (D-19 part 2). An unsettled chain lists no rows, so it has no entries either (D-12). A skipped
 * chain is not unsettled: it lists exactly the rows its Memory changes half paints (444 D-61).
 */
export function changeLedgerViews(
  projection: Extract<RunKnowledgeProjection, { kind: 'ready' }>,
): readonly ChangeLedgerView[] {
  const status = curationWord(projection)
  if (status === 'pending' || status === 'running') return []
  const joins = contentById(projection)
  return changeDrafts(projection).map((draft, index) => ledgerEntry(draft, index, joins))
}

/**
 * The Learned half, as one of six states — and every one of them says something (D-12; 444 D-61).
 *
 * THE ORDER OF THE ARMS IS THE ORDER OF THE QUESTIONS. Is the chain still moving? Did it fail?
 * Could the store even be read? Did any of it reach this run? Did the frozen row record what it
 * did? Did it do anything? Each answer stops there, because each sends a reader somewhere
 * different, and a single collapsed "no rows" arm would send all of them to the same shrug.
 *
 * ROWS COME BEFORE SENTENCES, once curation has settled (407-15 · REVIEW CR-04). The earlier arm
 * order asked the COUNTS first and only reached the rows if the counts had moved, so a run whose
 * settled row recorded `0 / 0` — or recorded nothing at all — silently discarded change records
 * the op had already served and attributed. A half that denies a record it was handed is worse
 * than one that shows a disagreement between two producers: the disagreement is the news.
 *
 * THE COUNTS COME ONLY FROM THE SETTLED ROW (D-09). An unsettled chain has no counts to show — not
 * zeros, not a stale pair from a previous read — so `countLine` is absent for `pending`, `running`
 * and `failed`, and the chip beside it is silent for exactly the same reason. TWO of those arms —
 * `pending` and `running` — also list NOTHING even when the projection carries rows: a chain that
 * has not settled has not finished deciding what it changed, so listing its interim rows would
 * date-stamp a claim it has not made (D-12).
 *
 * A SETTLED-AND-FAILED CHAIN IS NOT ONE OF THEM, AND USED TO BE TREATED AS IF IT WERE (407-26 ·
 * REVIEW CR-01 · G-407-12, owner ruling 2026-08-31). `failed` HAS settled, so the justification
 * above never described it; the arm nonetheless returned `rows: []` eleven lines above the fold
 * and printed {@link CURATION_FAILED_TEXT} — `nothing was learned from this run` — over change
 * records the op had served and stamped with this run's own id. `learned.changes` comes from the
 * `diffSince` walk over the COMMITTED store; `curation.status` comes from a different sibling op;
 * a stage that committed records and then fell over later in the chain produces exactly that
 * shape. A chain that fell over cannot un-commit what it already wrote, so the records are
 * PAINTED and the failure is stated beside them in {@link LearnedView.chainNote}. This is the
 * third instance of one rule, now consistent across the tab: 407-18 moved the fold above the
 * scan-incomplete FLAG arm, 407-22 made a served attribution row beat `canaryOutcomeWord`'s
 * settled arms, and this moves it above the CHAIN-STATUS arm.
 *
 * WHICH IS WHY THE FOLD IS HOISTED RATHER THAN COPIED INTO THE ARM. An arm that returns before
 * the fold is an arm that can deny a record without ever having looked at it; the only way to
 * make that structurally impossible is to leave no code between the fold and the returns. Every
 * arm below therefore chooses only WHAT TO SAY about rows it can already see.
 *
 * THE STORE READ IS A FACT ABOUT THE READ, AND IT DECORATES EVERY ARM (407-18 · REVIEW CR-01 /
 * WR-05). `learned.scanIncomplete` used to be asked ABOVE the row fold and answered with
 * `rows: []` plus {@link CHANGES_UNREADABLE_TEXT} unconditionally — but 407-14's op folds its two
 * Learned enrichments INDEPENDENTLY, so `{ scanIncomplete: true, changes: [<this run's record>] }`
 * is a sanctioned, op-tested output. On it the half asserted the store could not be read while
 * holding the record that proves it could: the same denial 407-15's `rows win` law was written
 * against, committed by the commit that wrote the law. So the flag is now computed ONCE and spread
 * into every return, including the three unsettled arms it used to return past (WR-05), and the
 * SENTENCE form is reached only where there is genuinely nothing to list. A view handed rows
 * paints them, whatever else it was told; the degradation rides beside them as the flag and
 * {@link STORE_READ_INCOMPLETE_TEXT}.
 */
export function learnedView(
  projection: Extract<RunKnowledgeProjection, { kind: 'ready' }>,
): LearnedView {
  const status = curationWord(projection)
  const { counts, skipped } = projection.curation

  // COMPUTED ONCE, SPREAD EVERYWHERE (WR-05). Absent rather than `false` on a clean read — the
  // same true-or-absent idiom the wire flag it mirrors is typed with.
  const degraded = projection.learned.scanIncomplete === true ? { scanIncomplete: true as const } : {}
  const readNote =
    projection.learned.scanIncomplete === true ? { readNote: STORE_READ_INCOMPLETE_TEXT } : {}

  // ALREADY FILTERED TO THIS RUN by `runs.knowledge` (407-04's run-link stamping and canary
  // observation join, never a since-ordinal window). This module narrows the KINDS and nothing
  // else — re-filtering by run here would be a second, weaker copy of that join.
  //
  // HOISTED ABOVE THE WHOLE STATUS LADDER (407-26 · REVIEW CR-01 · G-407-12). An arm that returns
  // before this fold is an arm that can deny a record without having looked at it, and no comment
  // prevents the next arm from being written above it — leaving no code between the fold and the
  // returns does.
  //
  // ONE ROW PER AFFECTED RECORD (427 D-15). With a snapshot the curation rows are its rows, in
  // its order, so they equal the breakdown; the op's since-then changes follow as their own
  // section (423 D-15, 427 D-17). Content is joined by record id from the whole read.
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

  // THE TWO NUMBERS THE HEADING PUTS SIDE BY SIDE (425-06 · D-19).
  //
  // `counted` IS THE SNAPSHOT'S, NEVER RE-DERIVED. The breakdown is curation's own fixed record
  // (423 D-15); re-counting it from rows would replace the producer's measurement with this
  // module's, and then there would be no disagreement left to report.
  //
  // `shown` IS THE CURATION SECTION ONLY. 423 D-15 gives since-then rows their own counted line,
  // so folding them in here would let a later promotion quietly close a gap it had nothing to do
  // with — the exact silence D-19 was written against.
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

  // A SKIPPED CHAIN NEVER RAN, so it is neither waiting nor settled (444 D-61). Below the fold like
  // every arm: rows it was handed are painted and the skip rides beside them in `chainNote`; with
  // none, the skip is the sentence. No count line — no row settled, the same absence `pending` states.
  // `skipped` is present exactly when `status` is the `skipped` word, so this is that arm.
  if (skipped !== undefined) {
    const skipText = STAGE_SKIPPED_TEXT[skipped.reason].curation
    return rows.length > 0
      ? { state: 'skipped', rows, chainNote: skipText, ...degraded, ...readNote, ...snapshot }
      : { state: 'skipped', sentence: skipText, rows: [], ...degraded, ...readNote, ...snapshot }
  }

  if (status === 'pending' || status === 'running') {
    // `rows: []` here is now a STATEMENT, not a consequence of ordering: the rows are in scope and
    // this arm declines to list them, because an unsettled chain has not finished deciding (D-12).
    return { state: status, sentence: CHANGES_PENDING_TEXT, rows: [], ...degraded, ...readNote, ...snapshot }
  }

  if (status === 'failed') {
    // A SETTLED chain that fell over cannot un-commit what it already wrote. With records to list,
    // the failure is a note BESIDE them; with none, the arm is the object that shipped before.
    // THE CAUSE THE READ ALREADY PROVED (425-06 · D-19). A chain that stopped mid-commit is the
    // plainest account there is of a snapshot that counted more than the half can list, and it is
    // the same fact `chainNote` already states beneath the rows — so the reconciliation borrows it
    // rather than falling to the sentence for a gap nobody could explain.
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

  // A SETTLED ARM'S CAUSE, IN THE ORDER THE READ JUSTIFIES THEM (425-06 · D-19). An incomplete
  // store scan is a proven reason rows are missing; with a clean read there is no proven reason at
  // all, and the half says exactly that rather than picking one.
  const settledCause = projection.learned.scanIncomplete === true
    ? CHANGES_UNREADABLE_TEXT
    : RECONCILIATION_UNATTRIBUTED_TEXT

  // THE HEADING AND THE CURATION CARD SPELL ONE NUMBER ONE WAY (425-06 · D-16/D-17). The line is
  // `curationBreakdownLine` over the SAME persisted snapshot the card reads (423 D-15), so the two
  // surfaces agree by construction rather than by two spellings that happen to match today.
  //
  // THE LADDER IS THE CARD'S LADDER, IN THE CARD'S ORDER (D-18, `curationCompleteText`). Snapshot
  // outranks the legacy pair; the pair is printed AS a pair and told, on its own line, that no
  // breakdown exists; a withheld snapshot names the category the read refused on; a settled row
  // with neither keeps its own fragment. FIVE BUCKETS ARE NEVER SYNTHESIZED FROM TWO — a pre-423
  // pair is a coarser measurement, not a breakdown with three buckets missing.
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

  // ROWS BEFORE SENTENCES, AND BEFORE THE FLAG (REVIEW CR-01). A record the store served is the
  // answer; the partial read is a note beside it.
  if (rows.length > 0) {
    return { state, countLine, ...countNote, rows, ...degraded, ...readNote, ...reconciled(settledCause) }
  }

  // NOTHING TO LIST AND NOBODY COULD LOOK — the one arm where the sentence IS the answer, so it
  // carries no note: a second door beneath a sentence that already names one is a nag (407-14).
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

  // Below here the read was CLEAN — the flag would have been answered above — so no spread is
  // needed on the three-sentence ladder, and adding one would only suggest it could be reached.
  //
  // THE SENTENCE FOLLOWS THE SAME RECORD THE COUNT LINE DID (425-06). A snapshot-bearing run whose
  // buckets are all zero HAS a record saying curation changed nothing, whether or not the legacy
  // pair was also written — so it reads its own sentence rather than falling to the counts-absent
  // one, which describes a row that recorded no measurement at all.
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

/**
 * The read, as the tab — or as the named state that stopped there being one.
 *
 * FOUR ARMS, AND THREE OF THEM ARE ABSENCES. That ratio is the point: `runs.knowledge` answers
 * `evidence-incomplete` as a RESULT (D-06), a project with no store answers `ready` with an
 * unbound reader (D-16), and a refused door answers through the client's `unavailable` arm. Each
 * sends a reader somewhere different, so each keeps its own sentence.
 */
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

  // 432-09 (D-25): the tab shows what changed; no pending-proposals line or review command remains.
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

// ─────────────────────────────────────────────────────────────────────────────
// The rung banner's copy of record (407-10 · TRST-01, D-13/D-14/D-15/D-16)
// ─────────────────────────────────────────────────────────────────────────────

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

/**
 * WHY the ladder degraded, as a person reads it — a TOTAL map, never a switch with a default.
 *
 * BYTE-IDENTICAL TO `cli/src/commands/doctor-knowledge-checks.ts`, ON PURPOSE AND BY NECESSITY.
 * The dashboard and the CLI share no UI module — `packages/cli` cannot import a React package's
 * lib — so the labels are spelled twice and 407-11 asserts the two tables equal. Three of
 * them (`model-not-downloaded`, `embedder-load-failed`, `profile-static-configured`) are NOT in
 * UI-SPEC's five: the recorded enum has eight arms because `cold-artifact`, `load-failure` and a
 * `static` PREFERRED profile are three distinct operator situations, and 407-08 chose the wording
 * for them first. This table follows that one rather than the spec where the two differ.
 *
 * A new `RetrievalRungReason` becomes a compile error here instead of a blank cause printed
 * after an em dash.
 *
 * 423 D-22: a banner states what a run RECORDED. The three index causes are what post-423 runs
 * record; `index-unavailable` is only ever read off a pre-423 run and says so ("cause not
 * recorded") rather than guessing which of the three it was. Current health is `agent-qa doctor`.
 */
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

/**
 * Where the banner sends a reader who wants to know more.
 *
 * ONE DOOR, AND IT IS THE ONE THAT GRADES THE SAME FOLD (D-18). The banner states a fact about a
 * run that already happened; `doctor` reads the host as it is now. Sending the reader there is
 * what makes the banner actionable without letting it pretend to be a live probe (D-13).
 */
export const DOCTOR_HINT_TEXT = 'Run `agent-qa doctor`.'

// 427 · D-20..D-23 — the recorded (rung, reason) as a presentation class, a tone and one sentence.
// The class is derived from the recorded reason only; it is never stored and nothing probes for it.

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

/** The tab's retrieval statement; `pointer` is present on the two warning classes only (D-23). */
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

/**
 * The header strip's sentence, or `undefined` when there is no strip to render (427 D-20).
 *
 * ONLY THE WARNING CLASSES PAINT A STRIP. A fresh store's bootstrap, a cause that was never
 * recorded and a level the project configured are information the tab states; putting them in an
 * amber strip across the header would present each as a fault. `memidex` is not a degradation and
 * `undefined` is "nobody has said yet" — both render no element. The sentence is the tab's own
 * statement followed by the doctor pointer, so the strip and the tab never word one record twice.
 */
export function rungBannerText(rung: RungView | undefined): string | undefined {
  const statement = retrievalStatementView(rung)
  if (statement?.pointer === undefined) return undefined
  return `${statement.sentence} ${statement.pointer}`
}

/**
 * The rung the run-detail header should paint, read off the DURABLE projection (D-13).
 *
 * THE JOIN LIVES HERE AND NOT IN THE PAGE, because three of its four silences are judgements
 * about the read rather than about the header. A refused door and a pruned handoff have said
 * nothing about retrieval; a project with no knowledge store bound never asked retrieval anything
 * at all, so it was not served on a rung and a "degraded" strip would send an operator hunting a
 * broken index instead of a missing config key (D-16). The tab states that case in its own words;
 * the header stays silent.
 *
 * IT NEVER PROBES. The value is the one the evidence recorded at serve time, so a run served on
 * the static floor stays labelled that way after the host is fixed. Fixing the machine must not
 * rewrite what a past run's header says.
 */
export function bannerRung(read: KnowledgeRead | undefined): RecordedRetrievalRung | undefined {
  if (read === undefined || read.kind !== 'read') return undefined
  const projection = read.projection
  if (projection.kind !== 'ready' || projection.knowledgeStore === 'unbound') return undefined
  return projection.retrievalRung
}
