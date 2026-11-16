// Every composer sentence is an exported constant or pure function here.

import { MARK_PREVIEW_REFUSALS, markAddressKey } from '@vostride/agent-qa-schema'
import type {
  Mark,
  MarkDisposition,
  MarkFixKind,
  MarkFixRefusal,
  MarkHistoryEntry,
  MarkPreviewBasis,
  MarkPreviewDraft,
  MarkPreviewEvidenceEffect,
  MarkPreviewKnowledge,
  MarkPreviewKnowledgeRecord,
  MarkQuarantineClass,
  MemberTestOutcome,
  RunDetailMember,
  RunDetailProjection,
  RunDetailStep,
  RunKnowledgeContentAbsence,
  RunsMarkInput,
  RunsMarkPreviewResult,
} from '@vostride/agent-qa-schema'

import { t } from '@/i18n'
import { textTable } from '@/i18n/text-table'

import type { FeedbackReadFailure, MarksHistoryRead } from './api'
import { UNNAMED_STEP_LABEL } from './display-step'
import { formatRegionalDateTime } from './format'
import { memberDisplayName, memberHandleLabel } from './run-detail-view'

/** A UI pointer to a mark address, never a new identity. */
export interface FeedbackTarget {
  testIndex: number
  stepIndex?: number
}

/** What the composer holds for one address while it is retargeted or closed. */
export interface FeedbackDraft {
  kind?: Mark
  note: string
}

export const EMPTY_DRAFT: FeedbackDraft = { note: '' }

export function feedbackAddress(target: FeedbackTarget): string {
  return markAddressKey(target)
}

export function isDraftEmpty(draft: FeedbackDraft): boolean {
  return draft.kind === undefined && draft.note === ''
}

// `member` is given only in a suite; without it a test is `this test`.
export interface FeedbackPlace {
  stepIndex?: number
  member?: Pick<RunDetailMember, 'testIndex' | 'name'>
}

export function placeText({ stepIndex, member }: FeedbackPlace): string {
  const test =
    member === undefined
      ? undefined
      : t('feedback.place.test', {
          name: memberDisplayName(member),
          handle: memberHandleLabel(member.testIndex),
        })
  if (stepIndex === undefined) return test ?? t('feedback.place.thisTest')
  const number = String(stepIndex + 1)
  return test === undefined
    ? t('feedback.place.step', { number })
    : t('feedback.place.stepOfTest', { number, test })
}

/** Tests are named only when the viewed and the targeted test differ. */
export function pinnedTargetText(viewing: FeedbackPlace, target: FeedbackPlace): string {
  const differ =
    viewing.member !== undefined && target.member !== undefined && viewing.member.testIndex !== target.member.testIndex
  const viewed = differ ? viewing : { stepIndex: viewing.stepIndex }
  const about = target.stepIndex === undefined || differ ? target : { stepIndex: target.stepIndex }
  return t('feedback.composer.pinnedTarget', { viewed: placeText(viewed), about: placeText(about) })
}

export function switchTargetLabel(to: FeedbackPlace): string {
  return t('feedback.composer.switchTarget', { place: placeText(to) })
}

export function unsentDraftLabel(place: FeedbackPlace): string {
  return t('feedback.composer.unsentDraft', { place: placeText(place) })
}

export const NOTE_LABEL = 'Note (optional)'
/** UTF-16 code units, the textarea's own maxLength rule. */
export const NOTE_MAX_LENGTH = 2000
export const NOTE_COUNTER_FROM = 1800

export function noteCounterText(length: number): string {
  return `${String(length)} / ${String(NOTE_MAX_LENGTH)}`
}

export const CHOICE_LABELS = textTable({
  'false-fail': () => t('feedback.choice.falseFail'),
  'false-pass': () => t('feedback.choice.falsePass'),
  'confirmed-bug': () => t('feedback.choice.confirmedBug'),
}) satisfies Record<Mark, string>

export type FeedbackOutcomeClass = 'passed' | 'failed'

// prettier-ignore
export const FEEDBACK_OUTCOME_CLASSES = [
  'passed',
  'failed',
] as const satisfies readonly FeedbackOutcomeClass[]

// prettier-ignore
export const FEEDBACK_CHOICE_ORDER = {
  failed: [
    'false-fail',
    'confirmed-bug',
    'false-pass',
  ],
  passed: [
    'false-pass',
    'confirmed-bug',
    'false-fail',
  ],
} as const satisfies Record<FeedbackOutcomeClass, readonly [Mark, Mark, Mark]>

export const CHOICE_LEGEND = 'Which is true?'

export const CHOICE_MEANINGS = {
  failed: textTable({
    'false-fail': () => t('feedback.choiceMeaning.failed.falseFail'),
    'confirmed-bug': () => t('feedback.choiceMeaning.failed.confirmedBug'),
    'false-pass': () => t('feedback.choiceMeaning.failed.falsePass'),
  }),
  passed: textTable({
    'false-fail': () => t('feedback.choiceMeaning.passed.falseFail'),
    'confirmed-bug': () => t('feedback.choiceMeaning.passed.confirmedBug'),
    'false-pass': () => t('feedback.choiceMeaning.passed.falsePass'),
  }),
} satisfies Record<FeedbackOutcomeClass, Record<Mark, string>>

function statusClass(status: string | undefined): FeedbackOutcomeClass {
  return status === 'passed' || status === 'healed' ? 'passed' : 'failed'
}

/**
 * Healed counts as passed; anything that did not pass orders as failed. A member with no recorded
 * outcome takes the run row's status the same way, and failed when that is not a verdict either.
 */
export function memberOutcomeClass(
  outcome: MemberTestOutcome | undefined,
  runStatus?: string,
): FeedbackOutcomeClass {
  return statusClass(outcome ?? runStatus)
}

export interface FeedbackOutcomeInput {
  member: Pick<RunDetailMember, 'outcome'> | undefined
  step?: Partial<Pick<RunDetailStep, 'verifierVerdict'>>
  runStatus: string | undefined
}

/** The target's own recorded result: a step reads its verifier verdict, a test its outcome. */
export function feedbackOutcomeClass({ member, step, runStatus }: FeedbackOutcomeInput): FeedbackOutcomeClass {
  // `verifierVerdict` is required by the schema, but `fetchRunDetail` does not parse.
  const verdict = step?.verifierVerdict
  if (verdict != null) return verdict.pass ? 'passed' : 'failed'
  return memberOutcomeClass(member?.outcome, runStatus)
}

/**
 * A sentence with one producer string in it. The product words stay constants and `name` is a
 * text node, so a step or test name can never become markup.
 */
export interface FeedbackTextParts {
  prefix: string
  name?: string
  suffix?: string
}

export function feedbackPartsText(parts: FeedbackTextParts): string {
  return `${parts.prefix}${parts.name ?? ''}${parts.suffix ?? ''}`
}

type NamePartsKey =
  | 'feedback.composer.headingStep'
  | 'feedback.composer.headingTest'
  | 'feedback.composer.headingSuiteTest'
  | 'feedback.scope.oneStepInTest'
  | 'feedback.history.targetStep'
  | 'feedback.history.targetTest'

// The sentence is split before its slots are filled, so a step or test name is never read for slots.
function nameParts(
  key: NamePartsKey,
  values: Readonly<Record<string, string>> & { name: string },
): FeedbackTextParts {
  const pieces = String(t(key, { skipInterpolation: true } as never)).split(/\{\{\s*(\w+)\s*\}\}/u)
  let prefix = ''
  let suffix = ''
  let named = false
  pieces.forEach((piece, index) => {
    if (index % 2 === 1 && piece === 'name') {
      named = true
      return
    }
    const text = index % 2 === 1 ? (values[piece] ?? '') : piece
    if (named) suffix += text
    else prefix += text
  })
  return {
    prefix,
    ...(named ? { name: values.name } : {}),
    ...(suffix === '' ? {} : { suffix }),
  }
}

export const RECORDED_RESULT_TEXT = textTable({
  passed: () => t('feedback.scope.recorded.passed'),
  healed: () => t('feedback.scope.recorded.healed'),
  failed: () => t('feedback.scope.recorded.failed'),
  timeout: () => t('feedback.scope.recorded.timeout'),
  cancelled: () => t('feedback.scope.recorded.cancelled'),
  skipped: () => t('feedback.scope.recorded.skipped'),
}) satisfies Record<MemberTestOutcome, string>

export function NO_STEP_VERDICT_TEXT(testRecordedText: string): string {
  return t('feedback.scope.noStepVerdict', { recorded: testRecordedText })
}

function recordedKey(status: string | undefined): MemberTestOutcome | undefined {
  return status !== undefined && Object.hasOwn(RECORDED_RESULT_TEXT, status) ? (status as MemberTestOutcome) : undefined
}

export type FeedbackScopeMember = Pick<RunDetailMember, 'testIndex' | 'name' | 'outcome'>
export type FeedbackScopeStep = Pick<RunDetailStep, 'stepIndex'> &
  Partial<Pick<RunDetailStep, 'stepText' | 'verifierVerdict' | 'status'>>

export interface ComposerHeadingInput {
  member: Pick<RunDetailMember, 'testIndex' | 'name'>
  step?: Pick<FeedbackScopeStep, 'stepIndex' | 'stepText'>
  stepCount: number
  suite: boolean
}

// The exact step or test the composer is about; step numbers are `stepIndex + 1`.
export function composerHeading({ member, step, stepCount, suite }: ComposerHeadingInput): FeedbackTextParts {
  if (step !== undefined) {
    return nameParts('feedback.composer.headingStep', {
      number: String(step.stepIndex + 1),
      total: String(stepCount),
      name: step.stepText ?? UNNAMED_STEP_LABEL(),
    })
  }
  return suite
    ? nameParts('feedback.composer.headingSuiteTest', {
        name: memberDisplayName(member),
        handle: memberHandleLabel(member.testIndex),
      })
    : nameParts('feedback.composer.headingTest', { name: memberDisplayName(member) })
}

export interface ScopeLineInput {
  member: FeedbackScopeMember
  step?: FeedbackScopeStep
  suite: boolean
  runStatus: string | undefined
}

function memberRecordedText(member: Pick<RunDetailMember, 'outcome'>, runStatus: string | undefined): string {
  return RECORDED_RESULT_TEXT[recordedKey(member.outcome ?? runStatus) ?? memberOutcomeClass(member.outcome, runStatus)]
}

/** The step's own word when it agrees with its verdict, else the verdict's class — never a contradiction. */
function stepRecordedText(step: FeedbackScopeStep, member: FeedbackScopeMember, runStatus: string | undefined): string {
  const verdict = step.verifierVerdict
  if (verdict == null) return NO_STEP_VERDICT_TEXT(memberRecordedText(member, runStatus))
  const cls: FeedbackOutcomeClass = verdict.pass ? 'passed' : 'failed'
  const own = recordedKey(step.status)
  return RECORDED_RESULT_TEXT[own !== undefined && memberOutcomeClass(own) === cls ? own : cls]
}

export function scopeLine({ member, step, suite, runStatus }: ScopeLineInput): FeedbackTextParts {
  if (step === undefined) {
    return { prefix: t('feedback.scope.wholeTest', { recorded: memberRecordedText(member, runStatus) }) }
  }
  const recorded = stepRecordedText(step, member, runStatus)
  return suite
    ? nameParts('feedback.scope.oneStepInTest', {
        name: memberDisplayName(member),
        handle: memberHandleLabel(member.testIndex),
        recorded,
      })
    : { prefix: t('feedback.scope.oneStep', { recorded }) }
}

export interface FeedbackTargetViewInput {
  detail: Pick<RunDetailProjection, 'members' | 'steps'> | null | undefined
  target: FeedbackTarget
  runStatus: string | undefined
}

export interface FeedbackTargetView {
  outcomeClass: FeedbackOutcomeClass
  heading: FeedbackTextParts
  scopeLine: FeedbackTextParts
  /** The target member's step count from runs.detail. */
  stepCount: number
}

/** Everything the composer states about its target, read from the projection the page already holds. */
export function feedbackTargetView({ detail, target, runStatus }: FeedbackTargetViewInput): FeedbackTargetView {
  const found = detail?.members.find((entry) => entry.testIndex === target.testIndex)
  const member: FeedbackScopeMember = found ?? { testIndex: target.testIndex }
  const memberSteps = detail?.steps.filter((entry) => entry.testIndex === target.testIndex) ?? []
  const step: FeedbackScopeStep | undefined =
    target.stepIndex === undefined
      ? undefined
      : (memberSteps.find((entry) => entry.stepIndex === target.stepIndex) ?? { stepIndex: target.stepIndex })
  const suite = (detail?.members.length ?? 0) > 1
  const stepCount = Math.max(found?.totalSteps ?? memberSteps.length, step === undefined ? 0 : step.stepIndex + 1)
  return {
    outcomeClass: feedbackOutcomeClass({ member, step, runStatus }),
    heading: composerHeading({ member, step, stepCount, suite }),
    scopeLine: scopeLine({ member, step, suite, runStatus }),
    stepCount,
  }
}

export interface HeaderFeedbackTargetInput {
  detail: Pick<RunDetailProjection, 'members'> | null | undefined
  selectedStep: { testIndex: number; stepIndex: number } | null
  memberFilter: number | undefined
  runStatus: string | undefined
}

// Resolves to the selected step's test, the filtered member, the first failed, then the first.
export function resolveHeaderFeedbackTarget({
  detail,
  selectedStep,
  memberFilter,
  runStatus,
}: HeaderFeedbackTargetInput): FeedbackTarget | undefined {
  const members = detail?.members ?? []
  const named = (testIndex: number | undefined) =>
    testIndex === undefined ? undefined : members.find((entry) => entry.testIndex === testIndex)
  const chosen =
    members.length === 1
      ? members[0]
      : (named(selectedStep?.testIndex) ??
        named(memberFilter) ??
        members.find((entry) => memberOutcomeClass(entry.outcome, runStatus) === 'failed') ??
        members[0])
  return chosen === undefined ? undefined : { testIndex: chosen.testIndex }
}

export const TEST_SWITCHER_LABEL = 'Test'
export const NO_UNIQUE_ADDRESS_TEXT = "This test has no unique address in this run, so feedback can't be recorded for it."

// The wire addresses a suite member by `testId`, so it needs a truthy one no other member holds.
export function hasUniqueAddress(detail: Pick<RunDetailProjection, 'members'> | null | undefined, testIndex: number): boolean {
  const members = detail?.members ?? []
  const member = members.find((entry) => entry.testIndex === testIndex)
  if (member === undefined) return false
  if (members.length <= 1) return true
  return Boolean(member.testId) && members.filter((entry) => entry.testId === member.testId).length === 1
}

export type FeedbackComposerState =
  | 'composing'
  | 'submitting'
  | 'recorded'
  | 'retained'

// prettier-ignore
export const FEEDBACK_COMPOSER_STATES = [
  'composing',
  'submitting',
  'recorded',
  'retained',
] as const satisfies readonly FeedbackComposerState[]

export const PREVIEW_DEBOUNCE_MS = 300

export type FeedbackLayout = 'docked' | 'stacked'

// prettier-ignore
export const FEEDBACK_LAYOUTS = [
  'docked',
  'stacked',
] as const satisfies readonly FeedbackLayout[]

// 48rem: below it the open composer stacks under the evidence.
export const FEEDBACK_STACK_BELOW_PX = 768

/** An unmeasured page (width 0) and a closed composer are always docked, so the closed layout never moves. */
export function feedbackLayout(width: number, open: boolean): FeedbackLayout {
  return open && width > 0 && width < FEEDBACK_STACK_BELOW_PX ? 'stacked' : 'docked'
}

export interface FeedbackPanelIds {
  tree: string
  evidence: string
  feedback: string
}

export const FEEDBACK_PANEL_IDS = {
  tree: 'run-tree',
  evidence: 'run-evidence',
  feedback: 'run-feedback',
} as const satisfies FeedbackPanelIds

const FEEDBACK_STACKED_PANEL_IDS = {
  tree: 'run-tree-stacked',
  evidence: 'run-evidence-stacked',
  feedback: 'run-feedback-stacked',
} as const satisfies FeedbackPanelIds

// Each arrangement has its own panel ids, so each orientation keeps a remembered layout.
export function feedbackPanelIds(layout: FeedbackLayout): FeedbackPanelIds {
  return layout === 'stacked' ? FEEDBACK_STACKED_PANEL_IDS : FEEDBACK_PANEL_IDS
}

/**
 * The open three-panel seed, in percent. Numeric panel sizes are pixels in react-resizable-panels 4,
 * so docked converts the composer's 384px target against the measured width and tree and evidence
 * split the rest in the shipped 35:65 ratio; stacked is 30/30/40 at any width.
 */
export function feedbackDefaultLayout(layout: FeedbackLayout, width: number): Record<string, number> {
  const ids = feedbackPanelIds(layout)
  if (layout === 'stacked') return { [ids.tree]: 30, [ids.evidence]: 30, [ids.feedback]: 40 }
  const feedback = width > 0 ? Math.min(Math.max((384 / width) * 100, (320 / width) * 100), 50) : 30
  const tree = (100 - feedback) * 0.35
  return {
    [ids.tree]: tree,
    [ids.evidence]: 100 - feedback - tree,
    [ids.feedback]: feedback,
  }
}

/** The preview input, composed exactly as the page's onMark composes its markRun body. */
export function previewInputFor(
  member: Pick<RunDetailMember, 'testId'>,
  target: FeedbackTarget,
  kind: Mark,
): Omit<RunsMarkInput, 'runId' | 'note'> {
  return {
    kind,
    ...(member.testId ? { testId: member.testId } : {}),
    ...(target.stepIndex === undefined ? {} : { stepIndex: target.stepIndex }),
  }
}

export interface PreviewRequest extends FeedbackTarget {
  kind: Mark
}

/** Excludes the note: a note alone never changes what a mark does (isIdenticalRepeat). */
export function previewRequestKey(input: PreviewRequest): string {
  return JSON.stringify([
    input.kind,
    input.testIndex,
    input.stepIndex ?? 'run',
  ])
}

const PREVIEW_REFUSAL_KINDS: ReadonlySet<string> = new Set(MARK_PREVIEW_REFUSALS)

export const SUBMIT_REASON_NO_UNIQUE_ADDRESS = "This test can't be marked from the dashboard."
export const SUBMIT_REASON_NO_CHOICE = 'Choose one of the three options.'
export const SUBMIT_REASON_CHECKING = 'Checking what this will do…'
export const SUBMIT_REASON_PREVIEW_FAILED = "Consequences couldn't be checked — retry above."
export const SUBMIT_REASON_REFUSED = "This mark can't be recorded — see above."
export const SUBMIT_REASON_ALREADY_MARKED = "You already said this — there's nothing new to record."
export const SUBMIT_REASON_SENDING = 'Sending…'

export interface SubmitBlockInput {
  kind: Mark | undefined
  currentKey: string
  landedKey: string | undefined
  landedOutcome: RunsMarkPreviewResult['kind'] | 'failed' | undefined
  inFlight: boolean
  noUniqueAddress?: boolean
}

// First match wins and `''` means sendable; only a current consequences or quarantined read passes.
export function submitBlockedReason(input: SubmitBlockInput): string {
  if (input.noUniqueAddress === true) return SUBMIT_REASON_NO_UNIQUE_ADDRESS
  if (input.kind === undefined) return SUBMIT_REASON_NO_CHOICE
  const outcome = input.landedOutcome
  if (outcome === undefined || input.landedKey !== input.currentKey) return SUBMIT_REASON_CHECKING
  if (outcome === 'failed') return SUBMIT_REASON_PREVIEW_FAILED
  if (PREVIEW_REFUSAL_KINDS.has(outcome)) return SUBMIT_REASON_REFUSED
  if (outcome !== 'consequences' && outcome !== 'quarantined') return SUBMIT_REASON_ALREADY_MARKED
  if (input.inFlight) return SUBMIT_REASON_SENDING
  return ''
}

export const SEND_FEEDBACK_LABEL = 'Send feedback'
export const PREVIEW_TITLE = 'What this will do'
export const SENDING_STATUS = 'Sending feedback…'
export const FEEDBACK_ENTRY_TEST_LABEL = 'Give feedback on this test'
export const CLOSE_FEEDBACK_LABEL = 'Close feedback'
export const CLOSE_FEEDBACK_TOOLTIP = 'Close (Esc)'
export const DRAFT_KEPT_STATUS = 'Draft kept. Check the message above before sending again.'

export type FeedbackEntryScope = 'test' | 'step'

// prettier-ignore
export const FEEDBACK_ENTRY_SCOPES = [
  'test',
  'step',
] as const satisfies readonly FeedbackEntryScope[]

export const FEEDBACK_ENTRY_TOOLTIP = 'Give feedback'
export const FEEDBACK_ENTRY_MARKED_TOOLTIP = 'Already marked — review or change'

export interface FeedbackEntryLabelInput {
  scope: FeedbackEntryScope
  stepNumber?: number
  memberName?: string
  handle?: string
  markedChoice?: Mark
}

/** A step is named by number, a suite test by name and handle; a marked target says how, in plain words. */
export function feedbackEntryLabel({ scope, stepNumber, memberName, handle, markedChoice }: FeedbackEntryLabelInput): string {
  if (scope === 'step') {
    const number = String(stepNumber)
    return markedChoice === undefined
      ? t('feedback.entry.step', { number })
      : t('feedback.entry.stepMarked', { number, choice: CHOICE_LABELS[markedChoice] })
  }
  if (handle === undefined) {
    return markedChoice === undefined
      ? FEEDBACK_ENTRY_TEST_LABEL
      : t('feedback.entry.testMarked', { choice: CHOICE_LABELS[markedChoice] })
  }
  const name = memberName ?? ''
  return markedChoice === undefined
    ? t('feedback.entry.member', { name, handle })
    : t('feedback.entry.memberMarked', { name, handle, choice: CHOICE_LABELS[markedChoice] })
}

export function stepTriggerTooltip(stepNumber: number, marked: boolean): string {
  const number = String(stepNumber)
  return marked
    ? t('feedback.entry.stepMarkedTooltip', { number })
    : t('feedback.entry.step', { number })
}

// A passive trace names the plain choice, never the internal word.
export function markGlyphLabel(kind: Mark): string {
  return t('feedback.entry.markGlyph', { choice: CHOICE_LABELS[kind] })
}

// A mark applies its fix in the call; `drafted` is an older receipt read back from a ledger.
const APPLIED_DISPOSITION_TEXT = textTable({
  fact: () => t('feedback.disposition.applied.fact'),
  caution: () => t('feedback.disposition.applied.caution'),
  'procedure-hint': () => t('feedback.disposition.applied.procedureHint'),
  'test-edit': () => t('feedback.disposition.applied.testEdit'),
}) satisfies Record<MarkFixKind, string>

// The mark stands; its planned fix is refused and nothing changes.
const NOT_APPLIED_DISPOSITION_TEXT = textTable({
  'target-not-found': () => t('feedback.disposition.notApplied.targetNotFound'),
  'policy-materialize-refused': () => t('feedback.disposition.notApplied.policyMaterializeRefused'),
  'outside-workspace': () => t('feedback.disposition.notApplied.outsideWorkspace'),
}) satisfies Record<MarkFixRefusal, string>

export const DISPOSITION_TEXT = textTable({
  applied: () => APPLIED_DISPOSITION_TEXT,
  drafted: () => t('feedback.disposition.drafted'),
  'no-draftable-fix': () => t('feedback.disposition.noDraftableFix'),
  'confirmed-bug': () => t('feedback.disposition.confirmedBug'),
  'not-applied': () => NOT_APPLIED_DISPOSITION_TEXT,
})

export function dispositionText(disposition: MarkDisposition): string {
  switch (disposition.kind) {
    case 'quarantined':
      return t('feedback.disposition.quarantined', { cause: disposition.class })
    case 'applied':
      return DISPOSITION_TEXT.applied[disposition.fix]
    case 'drafted':
      return DISPOSITION_TEXT.drafted
    case 'no-draftable-fix':
      return DISPOSITION_TEXT['no-draftable-fix']
    case 'confirmed-bug':
      return DISPOSITION_TEXT['confirmed-bug']
    case 'not-applied':
      return DISPOSITION_TEXT['not-applied'][disposition.reason]
    default:
      return disposition satisfies never
  }
}

const APPLIED_RECORDED_TEXT = textTable({
  fact: () => t('feedback.recorded.applied.fact'),
  caution: () => t('feedback.recorded.applied.caution'),
  'procedure-hint': () => t('feedback.recorded.applied.procedureHint'),
  'test-edit': () => t('feedback.recorded.applied.testEdit'),
}) satisfies Record<MarkFixKind, string>

const NOT_APPLIED_RECORDED_TEXT = textTable({
  'target-not-found': () => t('feedback.recorded.notApplied.targetNotFound'),
  'policy-materialize-refused': () => t('feedback.recorded.notApplied.policyMaterializeRefused'),
  'outside-workspace': () => t('feedback.recorded.notApplied.outsideWorkspace'),
}) satisfies Record<MarkFixRefusal, string>

export function feedbackRecordedText(disposition: MarkDisposition): string {
  switch (disposition.kind) {
    case 'quarantined':
      return t('feedback.recorded.quarantined', { cause: disposition.class })
    case 'applied':
      return APPLIED_RECORDED_TEXT[disposition.fix]
    case 'drafted':
      return t('feedback.recorded.drafted')
    case 'no-draftable-fix':
      return t('feedback.recorded.noDraftableFix')
    case 'confirmed-bug':
      return t('feedback.recorded.confirmedBug')
    case 'not-applied':
      return NOT_APPLIED_RECORDED_TEXT[disposition.reason]
    default:
      return disposition satisfies never
  }
}

// The consequence preview: every line is one `runs.mark.preview` field in plain words.

export type FeedbackPreviewState =
  | 'idle'
  | 'loading'
  | 'consequences'
  | 'quarantined'
  | 'already-marked'
  | 'refused'
  | 'failed'

// prettier-ignore
export const FEEDBACK_PREVIEW_STATES = [
  'idle',
  'loading',
  'consequences',
  'quarantined',
  'already-marked',
  'refused',
  'failed',
] as const satisfies readonly FeedbackPreviewState[]

export interface FeedbackPreviewStateInput {
  kind: Mark | undefined
  /** The read on screen; its currency is the caller's (previewRequestKey). */
  landed: { kind: 'read'; result: RunsMarkPreviewResult } | { kind: 'failed'; reason: string } | undefined
}

/** Nothing landed is loading whether the request is still debounced or already in flight. */
export function feedbackPreviewState({ kind, landed }: FeedbackPreviewStateInput): FeedbackPreviewState {
  if (kind === undefined) return 'idle'
  if (landed === undefined) return 'loading'
  if (landed.kind === 'failed') return 'failed'
  const arm = landed.result.kind
  if (PREVIEW_REFUSAL_KINDS.has(arm)) return 'refused'
  return arm === 'consequences' || arm === 'quarantined' ? arm : 'already-marked'
}

export const PREVIEW_UPDATING_TEXT = 'Updating…'
export const PREVIEW_IDLE_TEXT = 'Choose an option above to see what this will do.'

export const PREVIEW_LINE_LABELS = textTable({
  knowledge: () => t('feedback.preview.lineLabel.knowledge'),
  change: () => t('feedback.preview.lineLabel.change'),
})

/**
 * Zero-count clauses are omitted. Records reached with no effect at all are all unreadable (a record
 * with effects carries at least one), so that line says so instead of printing nothing.
 */
export function knowledgeLine(evidence: MarkPreviewKnowledge['evidence'], recordCount: number): string {
  if (recordCount === 0) return t('feedback.preview.noRecordsReached')
  const { confirmed, overturned } = evidence
  if (confirmed > 0 && overturned > 0) {
    return t('feedback.preview.confirmedAndCountedAgainst', {
      confirmed: t('feedback.preview.confirmed', { count: confirmed }),
      countedAgainst: t('feedback.preview.countedAgainst', { count: overturned }),
    })
  }
  if (confirmed > 0) return t('feedback.preview.confirmed', { count: confirmed })
  if (overturned > 0) return t('feedback.preview.countedAgainst', { count: overturned })
  return t('feedback.preview.unreadableRecords', { count: recordCount })
}

export function showRecordsLabel(count: number): string {
  return t('feedback.preview.showRecords', { number: String(count) })
}

export const RECORD_EFFECT_TEXT = textTable({
  confirm: () => t('feedback.preview.effect.confirm'),
  overturn: () => t('feedback.preview.effect.overturn'),
}) satisfies Record<MarkPreviewEvidenceEffect['direction'], string>

export const UNREADABLE_RECORD_TEXT = "This record can't be read — it keeps its place, and nothing is applied to it."

/** The muted line under a reached record: its planned effects, or why none can apply. */
export function recordEffectLine(record: MarkPreviewKnowledgeRecord): string {
  if (record.evidence.kind === 'unreadable') return UNREADABLE_RECORD_TEXT
  const { effects } = record.evidence
  const overturns = effects.filter((effect) => effect.direction === 'overturn').length
  const confirms = effects.some((effect) => effect.direction === 'confirm')
  const overturn =
    overturns === 0
      ? undefined
      : overturns === 1
        ? RECORD_EFFECT_TEXT.overturn
        : t('feedback.preview.effect.overturnTimes', { times: String(overturns) })
  if (overturn === undefined) return confirms ? RECORD_EFFECT_TEXT.confirm : ''
  return confirms
    ? t('feedback.preview.effect.confirmAndOverturn', { confirm: RECORD_EFFECT_TEXT.confirm, overturn })
    : overturn
}

export const CONTENT_ABSENCE_TEXT = textTable({
  'not-found': () => t('feedback.preview.contentAbsence.notFound'),
  'scan-incomplete': () => t('feedback.preview.contentAbsence.scanIncomplete'),
  'not-bound': () => t('feedback.preview.contentAbsence.notBound'),
}) satisfies Record<RunKnowledgeContentAbsence['reason'], string>

const KNOWLEDGE_FIX_TEXT = textTable({
  fact: () => t('feedback.preview.fix.fact'),
  caution: () => t('feedback.preview.fix.caution'),
  'procedure-hint': () => t('feedback.preview.fix.procedureHint'),
}) satisfies Record<Extract<MarkPreviewDraft, { kind: 'knowledge' }>['fix'], string>

// The preview says what sending will change, in the future tense of an applied fix.
export const PREVIEW_FIX_TEXT = textTable({
  knowledge: () => KNOWLEDGE_FIX_TEXT,
  'test-edit': () => t('feedback.preview.fix.testEdit'),
  'no-draftable-fix': () => t('feedback.preview.fix.noDraftableFix'),
  'confirmed-bug': () => t('feedback.preview.fix.confirmedBug'),
})

export function previewFixText(draft: MarkPreviewDraft): string {
  switch (draft.kind) {
    case 'knowledge':
      return PREVIEW_FIX_TEXT.knowledge[draft.fix]
    case 'test-edit':
      return PREVIEW_FIX_TEXT['test-edit']
    case 'no-draftable-fix':
      return PREVIEW_FIX_TEXT['no-draftable-fix']
    case 'confirmed-bug':
      return PREVIEW_FIX_TEXT['confirmed-bug']
    default:
      return draft satisfies never
  }
}

/** The preview never calls the model, so the fix is named but its wording is not shown. */
export const DRAFT_WORDING_NOT_SHOWN_TEXT = "The exact wording isn't shown here — it's written when you send."

export function draftHasWording(draft: MarkPreviewDraft): boolean {
  return draft.kind === 'knowledge' || draft.kind === 'test-edit'
}

/**
 * The time is the history entry's own; without history the clause drops rather than guessing.
 * A later mark replaces the earlier one, and what it changed stays.
 */
export function replacesLine(ordinal: number, time: string | undefined): string {
  const mark = String(ordinal)
  return time === undefined
    ? t('feedback.preview.replaces', { mark })
    : t('feedback.preview.replacesAt', { mark, time })
}

export type MarkTargetReason = Extract<RunsMarkPreviewResult, { kind: 'consequences' }>['resolvedStep']['reason']

// Keyed on the read's reason and the kind, never re-derived; a step mark needs no line.
export function resolvedStepText(reason: MarkTargetReason, kind: Mark, stepNumber: number, total: number): string | undefined {
  const values = { number: String(stepNumber), total: String(total) }
  switch (reason) {
    case 'failing-step':
      return t('feedback.preview.resolvedStep.failingStep', values)
    case 'passing-verdict':
      return kind === 'false-pass'
        ? t('feedback.preview.resolvedStep.lastStepFinished', values)
        : t('feedback.preview.resolvedStep.lastStepNoFailure', values)
    case 'step-mark':
      return undefined
    default:
      return reason satisfies never
  }
}

export function showStepLabel(stepNumber: number): string {
  return t('feedback.preview.showStep', { number: String(stepNumber) })
}

// A quarantined mark still records; an identical repeat does not, as a note alone changes nothing.

const QUARANTINED_TEXT = textTable({
  timeout: () => t('feedback.preview.quarantined.timeout'),
  flake: () => t('feedback.preview.quarantined.flake'),
  environment: () => t('feedback.preview.quarantined.environment'),
}) satisfies Record<MarkQuarantineClass, string>

export function quarantinedText(cls: MarkQuarantineClass): string {
  return QUARANTINED_TEXT[cls]
}

/** The time is the prior mark's history entry; without history the parenthetical drops. */
export function alreadyMarkedText(time?: string): string {
  return time === undefined
    ? t('feedback.preview.alreadyMarked')
    : t('feedback.preview.alreadyMarkedAt', { time })
}

// A refusal is `runs.mark`'s own arm, read from its fields; a failed read names why.

export type PreviewRefusalKind = (typeof MARK_PREVIEW_REFUSALS)[number]
export type PreviewRefusalArm<K extends PreviewRefusalKind = PreviewRefusalKind> = Extract<RunsMarkPreviewResult, { kind: K }>

export const PREVIEW_REFUSAL_TEXT = {
  'run-not-found': () => t('feedback.preview.refusal.runNotFound'),
  'member-not-found': () => t('feedback.preview.refusal.memberNotFound'),
  'step-not-found': (arm) =>
    arm.stepCount === 0
      ? t('feedback.preview.refusal.noSteps')
      : t('feedback.preview.refusal.stepNotFound', {
          count: arm.stepCount,
          number: String(arm.stepIndex + 1),
        }),
  'ambiguous-address': (arm) =>
    t('feedback.preview.refusal.ambiguousAddress', { count: arm.candidates.length }),
} satisfies Record<(typeof MARK_PREVIEW_REFUSALS)[number], unknown> & {
  [K in PreviewRefusalKind]: (arm: PreviewRefusalArm<K>) => string
}

export function isPreviewRefusal(read: RunsMarkPreviewResult): read is PreviewRefusalArm {
  return PREVIEW_REFUSAL_KINDS.has(read.kind)
}

export function previewRefusalText(arm: PreviewRefusalArm): string {
  switch (arm.kind) {
    case 'run-not-found':
      return PREVIEW_REFUSAL_TEXT[arm.kind]()
    case 'member-not-found':
      return PREVIEW_REFUSAL_TEXT[arm.kind]()
    case 'step-not-found':
      return PREVIEW_REFUSAL_TEXT[arm.kind](arm)
    case 'ambiguous-address':
      return PREVIEW_REFUSAL_TEXT[arm.kind](arm)
    default:
      return arm satisfies never
  }
}

export const FEEDBACK_READ_FAILURE_TEXT = textTable({
  network: () => t('feedback.readFailure.network'),
  'ledger-corrupt': () => t('feedback.readFailure.ledgerCorrupt'),
  'ledger-unavailable': () => t('feedback.readFailure.ledgerUnavailable'),
  refused: () => t('feedback.readFailure.refused'),
  shape: () => t('feedback.readFailure.shape'),
}) satisfies Record<FeedbackReadFailure, string>

/** The error's name never reaches the page; each failure is one product sentence. */
export function feedbackReadFailureReason(failure: FeedbackReadFailure): string {
  return FEEDBACK_READ_FAILURE_TEXT[failure]
}

export function PREVIEW_READ_FAILED_TEXT(reason: string): string {
  return t('feedback.preview.readFailed', { reason })
}

/** The command is its own part so it paints in mono without splitting the sentence. */
export const CLI_ESCAPE_PARTS = {
  prefix: 'You can still record feedback from the CLI (',
  name: 'agent-qa runs mark',
  suffix: ') or over MCP.',
} as const satisfies Required<FeedbackTextParts>

export const CLI_ESCAPE_TEXT = feedbackPartsText(CLI_ESCAPE_PARTS)

export const RETRY_LABEL = 'Retry'
/** Label-in-name: the accessible name starts with the visible word and says what it retries. */
export const PREVIEW_RETRY_ACCESSIBLE_NAME = `${RETRY_LABEL} checking what this will do`

// The one place the internal mark words and the ids appear as text.

export const TECHNICAL_DETAILS_LABEL = 'Technical details'

export const TECHNICAL_DETAILS_ROW_LABELS = textTable({
  kind: () => t('feedback.details.row.kind'),
  address: () => t('feedback.details.row.address'),
  testId: () => t('feedback.details.row.testId'),
  records: () => t('feedback.details.row.records'),
  basis: () => t('feedback.details.row.basis'),
})

export type TechnicalDetailsRow = keyof typeof TECHNICAL_DETAILS_ROW_LABELS

export function basisDetailText(basis: MarkPreviewBasis): string {
  const ledger = String(basis.ledgerOrdinal)
  return basis.priorMarkOrdinal === undefined
    ? t('feedback.details.basis', { ledger })
    : t('feedback.details.basisWithPrior', { ledger, prior: String(basis.priorMarkOrdinal) })
}

// Each history entry is one receipt; its disposition is what happened then.

export type FeedbackHistoryState =
  | 'loading'
  | 'history'
  | 'empty'
  | 'run-not-found'
  | 'ledger-corrupt'
  | 'ledger-unavailable'
  | 'failed'

// prettier-ignore
export const FEEDBACK_HISTORY_STATES = [
  'loading',
  'history',
  'empty',
  'run-not-found',
  'ledger-corrupt',
  'ledger-unavailable',
  'failed',
] as const satisfies readonly FeedbackHistoryState[]

/** Nothing read yet is loading; every absence keeps its own state, and only a readable empty ledger is empty. */
export function feedbackHistoryState(read: MarksHistoryRead | undefined): FeedbackHistoryState {
  if (read === undefined) return 'loading'
  if (read.kind === 'failed') return 'failed'
  const { result } = read
  if (result.kind !== 'history') return result.kind
  return result.entries.length === 0 ? 'empty' : 'history'
}

export const HISTORY_TITLE_TEXT = textTable({
  step: () => t('feedback.history.title.step'),
  test: () => t('feedback.history.title.test'),
}) satisfies Record<FeedbackEntryScope, string>

export function historyTitle(scope: FeedbackEntryScope, count: number): string {
  const number = String(count)
  return scope === 'step'
    ? t('feedback.history.titleCount.step', { number })
    : t('feedback.history.titleCount.test', { number })
}

export function runHistoryLabel(count: number): string {
  return t('feedback.history.runLabel', { number: String(count) })
}

export const ACTIVE_TEXT = 'Active'

/** The time is the superseding entry's own; without it the clause drops rather than guessing. */
export function replacedByText(time?: string): string {
  return time === undefined
    ? t('feedback.history.replacedBy')
    : t('feedback.history.replacedByAt', { time })
}

export const REPLACEMENT_EXPLANATION = 'Only your latest mark on a test or step counts.'

/** What one history line shows about an applied fix: the changed record content, or the written file. */
export type AppliedChangeView =
  | { kind: 'knowledge'; records: { recordId: string; content?: string }[] }
  | { kind: 'test-file'; filePath: string }
  /** An older drafted receipt: its change is not recorded, and none is invented. */
  | { kind: 'unavailable' }

export const APPLIED_UNAVAILABLE_TEXT = 'What this mark changed was not recorded.'

export function appliedRecordUnavailableText(recordId: string): string {
  return t('feedback.history.recordUnavailable', { recordId })
}

function appliedRecordsText(records: readonly { recordId: string; content?: string }[]): string {
  return records
    .map((record) =>
      record.content === undefined
        ? appliedRecordUnavailableText(record.recordId)
        : t('feedback.history.quoted', { content: record.content }),
    )
    .join('; ')
}

/** Projected from the receipt and its joined records; every other disposition changed nothing. */
export function appliedChangeView(
  entry: Pick<MarkHistoryEntry, 'disposition' | 'changedRecords'>,
): AppliedChangeView | undefined {
  const { disposition } = entry
  if (disposition.kind === 'drafted') return { kind: 'unavailable' }
  if (disposition.kind !== 'applied') return undefined
  if (disposition.change.kind === 'test-file') return { kind: 'test-file', filePath: disposition.change.filePath }
  // A receipt that read back no record says its content is unrecorded, never a bare prefix.
  if (disposition.change.recordIds.length === 0) return { kind: 'unavailable' }
  const joined = new Map((entry.changedRecords ?? []).map((record) => [record.recordId, record.recordContent?.content]))
  return {
    kind: 'knowledge',
    records: disposition.change.recordIds.map((recordId) => {
      const content = joined.get(recordId)
      return content === undefined ? { recordId } : { recordId, content }
    }),
  }
}

/** The line as plain text: the record content quoted, or the id with its absence, one line in all. */
export function appliedChangeText(view: AppliedChangeView): string {
  switch (view.kind) {
    case 'knowledge':
      return t('feedback.history.appliedKnowledge', { records: appliedRecordsText(view.records) })
    case 'test-file':
      return t('feedback.history.appliedTestFile', { file: view.filePath })
    case 'unavailable':
      return APPLIED_UNAVAILABLE_TEXT
    default:
      return view satisfies never
  }
}

/** How an applied or drafted entry's one line ends when its change was not recorded. */
export const APPLIED_CONTENT_NOT_RECORDED_TEXT = 'its content was not recorded.'
export const DRAFTED_CHANGE_NOT_RECORDED_TEXT = 'what it changed was not recorded.'

// One line per entry: what the mark did, then what an applied fix changed, so it cannot contradict.
export function historyChangeText(entry: Pick<MarkHistoryEntry, 'disposition' | 'changedRecords'>): string {
  const disposition = dispositionText(entry.disposition)
  const view = appliedChangeView(entry)
  if (view === undefined) return disposition
  switch (view.kind) {
    case 'knowledge':
      return t('feedback.history.change.records', {
        disposition,
        records: appliedRecordsText(view.records),
      })
    case 'test-file':
      return t('feedback.history.change.file', { disposition, file: view.filePath })
    case 'unavailable':
      return entry.disposition.kind === 'drafted'
        ? t('feedback.history.change.draftedNotRecorded', { disposition })
        : t('feedback.history.change.contentNotRecorded', { disposition })
    default:
      return view satisfies never
  }
}

// Marking again replaces the mark, not the fix, so the pointer says how to correct a change.
export const APPLIED_CORRECTION_TEXT
  = 'A fix stays when you mark again: correct knowledge with new feedback or by forgetting it, and revert a test edit with git.'

export const HISTORY_EMPTY_TEXT = textTable({
  step: () => t('feedback.history.empty.step'),
  test: () => t('feedback.history.empty.test'),
  run: () => t('feedback.history.empty.run'),
}) satisfies Record<FeedbackEntryScope | 'run', string>

export function historyStateText(state: 'run-not-found' | 'ledger-corrupt' | 'ledger-unavailable', line?: number): string {
  switch (state) {
    case 'run-not-found':
      return t('feedback.history.state.runNotFound')
    case 'ledger-corrupt':
      return t('feedback.history.state.ledgerCorrupt', { line: String(line) })
    case 'ledger-unavailable':
      return t('feedback.history.state.ledgerUnavailable')
    default:
      return state satisfies never
  }
}

export function HISTORY_READ_FAILED_TEXT(reason: string): string {
  return t('feedback.history.readFailed', { reason })
}

export const HISTORY_RETRY_ACCESSIBLE_NAME = `${RETRY_LABEL} loading feedback history`

const MARK_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
}

/** A short date and 24-hour time in the dashboard's language and the browser's region; cells compare through this, never a clock literal. */
export function formatMarkTime(markedAt: number | undefined): string | undefined {
  return markedAt === undefined || !Number.isFinite(markedAt) ? undefined : formatRegionalDateTime(markedAt, MARK_TIME_OPTIONS)
}

/** Where a run-list entry landed: a step by number and name, a test by name and handle. */
export function historyTargetLabel(
  entry: Pick<MarkHistoryEntry, 'testIndex' | 'stepIndex'>,
  detail: Pick<RunDetailProjection, 'members' | 'steps'> | null | undefined,
): FeedbackTextParts {
  const target: FeedbackTarget =
    entry.stepIndex === undefined ? { testIndex: entry.testIndex } : { testIndex: entry.testIndex, stepIndex: entry.stepIndex }
  const view = feedbackTargetView({ detail, target, runStatus: undefined })
  if (entry.stepIndex !== undefined) {
    return nameParts('feedback.history.targetStep', {
      number: String(entry.stepIndex + 1),
      total: String(view.stepCount),
      name: view.heading.name ?? '',
    })
  }
  const member = detail?.members.find((candidate) => candidate.testIndex === entry.testIndex) ?? { testIndex: entry.testIndex }
  return nameParts('feedback.history.targetTest', {
    name: memberDisplayName(member),
    handle: memberHandleLabel(entry.testIndex),
  })
}
