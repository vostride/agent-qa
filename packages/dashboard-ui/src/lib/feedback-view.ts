// THE FEEDBACK COMPOSER'S COPY AND RULES (426 D-01, D-11, D-12, D-14, D-16, D-19, D-21, D-22).
//
// Pure and total: no I/O, no clock, no React. Every sentence a person reads in the composer is an
// exported constant or a pure function here, so cells assert against the constant and copy moves in
// one place.

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
  MarkPreviewGroundTruth,
  MarkPreviewKnowledge,
  MarkPreviewKnowledgeRecord,
  MarkPreviewLabel,
  MarkQuarantineClass,
  MemberTestOutcome,
  RunDetailMember,
  RunDetailProjection,
  RunDetailStep,
  RunKnowledgeContentAbsence,
  RunsMarkInput,
  RunsMarkPreviewResult,
} from '@vostride/agent-qa-schema'

import type { FeedbackReadFailure, MarksHistoryRead } from './api'
import { UNNAMED_STEP_LABEL } from './display-step'
import { memberDisplayName, memberHandleLabel } from './run-detail-view'

/** A UI pointer to a mark address, never a new identity (419 D-11). */
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

/**
 * A place the composer can name (D-08, D-09): a step by number, a test by name and handle. `member`
 * is given only in a suite; without it a test is "this test".
 */
export interface FeedbackPlace {
  stepIndex?: number
  member?: Pick<RunDetailMember, 'testIndex' | 'name'>
}

export function placeText({ stepIndex, member }: FeedbackPlace): string {
  const test = member === undefined ? undefined : `${memberDisplayName(member)} ${memberHandleLabel(member.testIndex)}`
  if (stepIndex === undefined) return test ?? 'this test'
  return test === undefined ? `step ${String(stepIndex + 1)}` : `step ${String(stepIndex + 1)} of ${test}`
}

/** Tests are named only when the viewed and the targeted test differ. */
export function pinnedTargetText(viewing: FeedbackPlace, target: FeedbackPlace): string {
  const differ =
    viewing.member !== undefined && target.member !== undefined && viewing.member.testIndex !== target.member.testIndex
  const viewed = differ ? viewing : { stepIndex: viewing.stepIndex }
  const about = target.stepIndex === undefined || differ ? target : { stepIndex: target.stepIndex }
  return `You're viewing ${placeText(viewed)} — this feedback is about ${placeText(about)}.`
}

export function switchTargetLabel(to: FeedbackPlace): string {
  return `Switch to ${placeText(to)}`
}

export function unsentDraftLabel(place: FeedbackPlace): string {
  return `Unsent draft: ${placeText(place)}`
}

export const NOTE_LABEL = 'Note (optional)'
/** UTF-16 code units, the textarea's own maxLength rule. */
export const NOTE_MAX_LENGTH = 2000
export const NOTE_COUNTER_FROM = 1800

export function noteCounterText(length: number): string {
  return `${String(length)} / ${String(NOTE_MAX_LENGTH)}`
}

export const CHOICE_LABELS = {
  'false-fail': 'This should have passed',
  'false-pass': 'This should have failed',
  'confirmed-bug': 'This is a real product bug',
} satisfies Record<Mark, string>

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
  failed: {
    'false-fail': 'The app behaved correctly; the test was wrong to fail.',
    'confirmed-bug': 'The failure is real — the app is broken here.',
    'false-pass': 'The test missed a problem it should have caught.',
  },
  passed: {
    'false-fail': 'The pass is right; this confirms the test.',
    'confirmed-bug': 'The app has a real bug here, even though the test passed.',
    'false-pass': 'The app was broken here, but the test passed anyway.',
  },
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

/** The target's own recorded result: a step reads its verifier verdict, a test its outcome (D-11). */
export function feedbackOutcomeClass({ member, step, runStatus }: FeedbackOutcomeInput): FeedbackOutcomeClass {
  // verifierVerdict is required by the schema, but fetchRunDetail does not parse (UI-SPEC U9).
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

export const WHOLE_TEST_SCOPE_TEXT = 'Whole test'
export const ONE_STEP_SCOPE_TEXT = 'One step'

export const RECORDED_RESULT_TEXT = {
  passed: 'recorded: passed',
  healed: 'recorded: healed — counts as passed',
  failed: 'recorded: failed',
  timeout: 'recorded: timed out — counts as failed',
  cancelled: 'recorded: cancelled — counts as failed',
  skipped: 'recorded: skipped — counts as failed',
} satisfies Record<MemberTestOutcome, string>

export function NO_STEP_VERDICT_TEXT(testRecordedText: string): string {
  return `no step verdict recorded — using the test's result (${testRecordedText})`
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

/** D-14: the exact step or test the composer is about; step numbers are stepIndex + 1. */
export function composerHeading({ member, step, stepCount, suite }: ComposerHeadingInput): FeedbackTextParts {
  if (step !== undefined) {
    return {
      prefix: `Feedback on step ${String(step.stepIndex + 1)} of ${String(stepCount)} · `,
      name: step.stepText ?? UNNAMED_STEP_LABEL,
    }
  }
  return suite
    ? { prefix: 'Feedback on ', name: memberDisplayName(member), suffix: ` ${memberHandleLabel(member.testIndex)}` }
    : { prefix: 'Feedback on ', name: memberDisplayName(member) }
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
    return { prefix: `${WHOLE_TEST_SCOPE_TEXT} · ${memberRecordedText(member, runStatus)}` }
  }
  const recorded = stepRecordedText(step, member, runStatus)
  return suite
    ? {
        prefix: `${ONE_STEP_SCOPE_TEXT} in `,
        name: memberDisplayName(member),
        suffix: ` ${memberHandleLabel(member.testIndex)} · ${recorded}`,
      }
    : { prefix: `${ONE_STEP_SCOPE_TEXT} · ${recorded}` }
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

/**
 * D-03: the test the header entry means. A suite resolves, in order, to the selected step's test, the
 * member filter's test, the first failed member, then the first member — "first" in handle order.
 * The page auto-selects the first visible step, so on load rung 1 wins (RESEARCH Pitfall 5).
 */
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

/**
 * D-01, inherited from onMark's refusal: the wire addresses a suite member by testId, so a member
 * needs a truthy testId no other member holds. A single-test run needs none.
 */
export function hasUniqueAddress(detail: Pick<RunDetailProjection, 'members'> | null | undefined, testIndex: number): boolean {
  const members = detail?.members ?? []
  const member = members.find((entry) => entry.testIndex === testIndex)
  if (member === undefined) return false
  if (members.length <= 1) return true
  return Boolean(member.testId) && members.filter((entry) => entry.testId === member.testId).length === 1
}

// 2026-10-01 (432-14, D-14): the state a mark sat in while its approval was asked is deleted with
// the approval. A submission is composing, in flight, recorded or retained, and nothing else.
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

/** 48rem, 425's first header step (the header moved to 64rem for #480): below it the open composer stacks under the evidence (D-10). */
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

/**
 * Each arrangement has its own panel ids (RESEARCH Pattern 3), so react-resizable-panels keeps a
 * remembered layout per orientation and the Group never needs a key change to reset.
 */
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

/** The preview input, composed exactly as the page's onMark composes its markRun body (D-16). */
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

/**
 * First match wins; '' means Send feedback is available (D-19, UI-SPEC S6). Only a current
 * consequences or quarantined read gets past the preview rows: there is no blind submit.
 */
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
  const base =
    scope === 'step'
      ? `Give feedback on step ${String(stepNumber)}`
      : handle === undefined
        ? FEEDBACK_ENTRY_TEST_LABEL
        : `Give feedback on ${memberName ?? ''} ${handle}`
  return markedChoice === undefined ? base : `${base} — already marked: ${CHOICE_LABELS[markedChoice]}`
}

export function stepTriggerTooltip(stepNumber: number, marked: boolean): string {
  return marked
    ? `Step ${String(stepNumber)} is already marked — review or change`
    : `Give feedback on step ${String(stepNumber)}`
}

/** D-06: a passive trace names the plain choice, never the internal word. */
export function markGlyphLabel(kind: Mark): string {
  return `Marked: ${CHOICE_LABELS[kind]}`
}

// 2026-09-30, 432-09 (D-04/D-25): a mark applies its fix in the call, so a receipt says what was
// added or edited. `drafted` is a pre-432 receipt read back from an existing ledger.
export const DISPOSITION_TEXT = {
  applied: {
    fact: 'Recorded — a knowledge fact was added',
    caution: 'Recorded — a caution was added',
    'procedure-hint': 'Recorded — a procedure hint was added',
    'test-edit': 'Recorded — the test file was edited',
  } satisfies Record<MarkFixKind, string>,
  // 2026-10-03 (quick 261003-cpv, 432-UI-REVIEW pillar 1): a historical reader's wording.
  drafted: 'Recorded — a fix was drafted (older mark)',
  'no-draftable-fix': 'Recorded — no fix could be drafted',
  'confirmed-bug': 'Recorded — kept as a real product bug; nothing changed',
  // 2026-10-03 (quick 261003-mqc): the mark stands; its planned fix was refused, nothing changed.
  'not-applied': {
    'target-not-found': 'Recorded — the fix was not applied: the knowledge it replaces is gone',
    'policy-materialize-refused': 'Recorded — the fix was not applied: its policy text was refused',
    'outside-workspace': 'Recorded — the fix was not applied: the test file is outside the workspace',
  } satisfies Record<MarkFixRefusal, string>,
} as const

export function dispositionText(disposition: MarkDisposition): string {
  switch (disposition.kind) {
    case 'quarantined':
      return `Recorded — quarantined (${disposition.class})`
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

export function feedbackRecordedText(disposition: MarkDisposition): string {
  return `Feedback recorded — ${dispositionText(disposition).replace(/^Recorded — /, '')}.`
}

// 426 D-16..D-19: the consequence preview. Every line is one runs.mark.preview field in plain words.

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

export const PREVIEW_LINE_LABELS = {
  result: 'Result',
  labels: 'Eval labels',
  knowledge: 'Knowledge',
  change: 'Change',
} as const

const VERDICT_WORD = { pass: 'passed', fail: 'failed' } as const

/** D-17: n is stepIndex + 1; the reasoning is the producer part and is dropped with its quote when empty. */
export function groundTruthLine(entry: MarkPreviewGroundTruth): FeedbackTextParts {
  const head = `Step ${String(entry.stepIndex + 1)} will count as ${VERDICT_WORD[entry.verdict]} (recorded: ${
    VERDICT_WORD[entry.recordedVerdict.pass ? 'pass' : 'fail']
  }`
  const { reasoning } = entry.recordedVerdict
  return reasoning === '' ? { prefix: `${head})` } : { prefix: `${head} — "`, name: reasoning, suffix: '")' }
}

export const NO_GROUND_TRUTH_TEXT = 'No step verdict changes.'

export function labelsLine(count: number): string {
  if (count === 0) return 'No eval labels change'
  return count === 1 ? '1 decision becomes a held-out eval label' : `${String(count)} decisions become held-out eval labels`
}

/**
 * Zero-count clauses are omitted. Records reached with no effect at all are all unreadable (a record
 * with effects carries at least one), so that line says so instead of printing nothing.
 */
export function knowledgeLine(evidence: MarkPreviewKnowledge['evidence'], recordCount: number): string {
  if (recordCount === 0) return 'No knowledge records are reached'
  const clauses = [
    evidence.confirmed === 0 ? undefined : `${String(evidence.confirmed)} ${evidence.confirmed === 1 ? 'record' : 'records'} confirmed`,
    evidence.overturned === 0 ? undefined : `${String(evidence.overturned)} counted against`,
  ].filter((clause) => clause !== undefined)
  if (clauses.length > 0) return clauses.join(' · ')
  return recordCount === 1 ? "1 record reached — it can't be read" : `${String(recordCount)} records reached — none can be read`
}

export function showRecordsLabel(count: number): string {
  return `Show records (${String(count)})`
}

export const RECORD_EFFECT_TEXT = {
  confirm: 'confirms',
  overturn: 'counts against',
} satisfies Record<MarkPreviewEvidenceEffect['direction'], string>

export const UNREADABLE_RECORD_TEXT = "This record can't be read — it keeps its place, and nothing is applied to it."

/** The muted line under a reached record: its planned effects, or why none can apply. */
export function recordEffectLine(record: MarkPreviewKnowledgeRecord): string {
  if (record.evidence.kind === 'unreadable') return UNREADABLE_RECORD_TEXT
  const { effects } = record.evidence
  const overturns = effects.filter((effect) => effect.direction === 'overturn').length
  return [
    effects.some((effect) => effect.direction === 'confirm') ? RECORD_EFFECT_TEXT.confirm : undefined,
    overturns === 0 ? undefined : overturns === 1 ? RECORD_EFFECT_TEXT.overturn : `${RECORD_EFFECT_TEXT.overturn} × ${String(overturns)}`,
  ]
    .filter((part) => part !== undefined)
    .join(' · ')
}

export const CONTENT_ABSENCE_TEXT = {
  'not-found': 'Record content not found',
  'scan-incomplete': 'Record content could not be fully read',
  'not-bound': "Record content isn't available on this host",
} satisfies Record<RunKnowledgeContentAbsence['reason'], string>

// 432-09 (D-04): the preview says what sending will change, in the future tense of an applied fix.
export const PREVIEW_FIX_TEXT = {
  knowledge: {
    fact: 'A knowledge fact will be added',
    caution: 'A caution will be added',
    'procedure-hint': 'A procedure hint will be added',
  } satisfies Record<Extract<MarkPreviewDraft, { kind: 'knowledge' }>['fix'], string>,
  'test-edit': 'The test file will be edited',
  'no-draftable-fix': 'No fix can be made from this run',
  'confirmed-bug': 'Nothing changes — a real product bug needs a product fix, not a test or knowledge change',
} as const

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
 * 432-09 (D-11): a later mark replaces the earlier one's gold case, and what it changed stays.
 */
export function replacesLine(ordinal: number, time: string | undefined): string {
  const at = time === undefined ? `#${String(ordinal)}` : `#${String(ordinal)}, ${time}`
  return `Replaces your earlier mark (${at}); what it changed stays`
}

export type MarkTargetReason = Extract<RunsMarkPreviewResult, { kind: 'consequences' }>['resolvedStep']['reason']

/** D-14: keyed on the read's reason and the kind, never re-derived; a step mark needs no line. */
export function resolvedStepText(reason: MarkTargetReason, kind: Mark, stepNumber: number, total: number): string | undefined {
  const lead = `This marks step ${String(stepNumber)} of ${String(total)} — `
  switch (reason) {
    case 'failing-step':
      return `${lead}the first step that failed.`
    case 'passing-verdict':
      return kind === 'false-pass' ? `${lead}the last step, where the test finished.` : `${lead}the last step, because no step failed.`
    case 'step-mark':
      return undefined
    default:
      return reason satisfies never
  }
}

export function showStepLabel(stepNumber: number): string {
  return `Show step ${String(stepNumber)}`
}

// D-18: the two arms that are not consequences. A quarantined mark still records; an identical repeat
// does not, because a note alone never changes what a mark does (isIdenticalRepeat).

export const QUARANTINE_CAUSE_TEXT = {
  timeout: 'a timeout',
  flake: 'a flaky run',
  environment: 'an environment problem',
} satisfies Record<MarkQuarantineClass, string>

export function quarantinedText(cls: MarkQuarantineClass): string {
  return `This test failed from ${QUARANTINE_CAUSE_TEXT[cls]}, so your mark is recorded but quarantined — no labels, knowledge or tests change.`
}

/** The time is the prior mark's history entry; without history the parenthetical drops. */
export function alreadyMarkedText(time?: string): string {
  return `You already said this${time === undefined ? '' : ` (${time})`}. A new note alone isn't recorded.`
}

// D-19: a refusal is runs.mark's own arm, read from its own fields; a failed read names why.

export type PreviewRefusalKind = (typeof MARK_PREVIEW_REFUSALS)[number]
export type PreviewRefusalArm<K extends PreviewRefusalKind = PreviewRefusalKind> = Extract<RunsMarkPreviewResult, { kind: K }>

export const PREVIEW_REFUSAL_TEXT = {
  'run-not-found': () => "This run is no longer in the run store, so feedback can't be recorded.",
  'member-not-found': () => "This test can't be found in the run, so feedback can't be recorded.",
  'step-not-found': (arm) =>
    arm.stepCount === 0
      ? 'This test recorded no steps, so there is nothing to mark.'
      : `This test recorded ${String(arm.stepCount)} ${arm.stepCount === 1 ? 'step' : 'steps'}, so there is no step ${String(arm.stepIndex + 1)} to mark.`,
  'ambiguous-address': (arm) =>
    `${String(arm.candidates.length)} tests in this run share this address, so the mark can't be placed.`,
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

export const FEEDBACK_READ_FAILURE_TEXT = {
  network: "the dashboard server didn't answer",
  'ledger-corrupt': "this run's feedback ledger is damaged",
  'ledger-unavailable': "this run's feedback ledger can't be read right now",
  refused: 'the server refused the request',
  shape: "the server's answer didn't match the expected shape",
} satisfies Record<FeedbackReadFailure, string>

/** The error's name never reaches the page; each failure is one product sentence. */
export function feedbackReadFailureReason(failure: FeedbackReadFailure): string {
  return FEEDBACK_READ_FAILURE_TEXT[failure]
}

export function PREVIEW_READ_FAILED_TEXT(reason: string): string {
  return `Couldn't check what this will do — ${reason}.`
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

// D-13: the one place the internal mark words and the ids appear as text.

export const TECHNICAL_DETAILS_LABEL = 'Technical details'

export const TECHNICAL_DETAILS_ROW_LABELS = {
  kind: 'Mark kind',
  address: 'Address',
  testId: 'Test id',
  records: 'Reached records',
  labels: 'Labels',
  basis: 'Basis',
} as const

export type TechnicalDetailsRow = keyof typeof TECHNICAL_DETAILS_ROW_LABELS

export function labelDetailText(label: Pick<MarkPreviewLabel, 'decisionOrdinal' | 'stepIndex' | 'channel'>): string {
  return `decision ${String(label.decisionOrdinal)} · step ${String(label.stepIndex + 1)} · ${label.channel}`
}

export function basisDetailText(basis: MarkPreviewBasis): string {
  const prior = basis.priorMarkOrdinal === undefined ? '' : ` · prior mark #${String(basis.priorMarkOrdinal)}`
  return `ledger ordinal ${String(basis.ledgerOrdinal)}${prior}`
}

// D-22: the history. Each entry is one receipt; its disposition is what happened then. 432-09
// (D-25): an applied fix states in one line what it changed, and nothing is offered for review.

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

export const HISTORY_TITLE_TEXT = {
  step: 'Feedback on this step',
  test: 'Feedback on this test',
} satisfies Record<FeedbackEntryScope, string>

export function historyTitle(scope: FeedbackEntryScope, count: number): string {
  return `${HISTORY_TITLE_TEXT[scope]} (${String(count)})`
}

export function runHistoryLabel(count: number): string {
  return `All feedback on this run (${String(count)})`
}

export const ACTIVE_TEXT = 'Active'

/** The time is the superseding entry's own; without it the clause drops rather than guessing. */
export function replacedByText(time?: string): string {
  return time === undefined ? 'Replaced by your later mark' : `Replaced by your later mark at ${time}`
}

export const REPLACEMENT_EXPLANATION = 'Only your latest mark on a test or step counts.'

/** What one history line shows about an applied fix: the changed record content, or the written file. */
export type AppliedChangeView =
  | { kind: 'knowledge'; records: { recordId: string; content?: string }[] }
  | { kind: 'test-file'; filePath: string }
  /** A pre-432 drafted receipt: its change was never recorded, and none is invented. */
  | { kind: 'unavailable' }

export const APPLIED_KNOWLEDGE_PREFIX = 'Changed knowledge: '
export const APPLIED_TEST_FILE_PREFIX = 'Edited the test file '
export const APPLIED_UNAVAILABLE_TEXT = 'What this mark changed was not recorded.'

export function appliedRecordUnavailableText(recordId: string): string {
  return `${recordId} (content unavailable)`
}

/** Projected from the receipt and its joined records; every other disposition changed nothing. */
export function appliedChangeView(
  entry: Pick<MarkHistoryEntry, 'disposition' | 'changedRecords'>,
): AppliedChangeView | undefined {
  const { disposition } = entry
  if (disposition.kind === 'drafted') return { kind: 'unavailable' }
  if (disposition.kind !== 'applied') return undefined
  if (disposition.change.kind === 'test-file') return { kind: 'test-file', filePath: disposition.change.filePath }
  // 2026-10-03 (quick 261003-cpv, 432 review IN-32): a knowledge receipt that read back no record
  // (the records were tombstoned since, or none was read) names no content, so it says the content
  // was not recorded rather than printing a bare prefix.
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
      return APPLIED_KNOWLEDGE_PREFIX + view.records
        .map((record) => (record.content === undefined ? appliedRecordUnavailableText(record.recordId) : `“${record.content}”`))
        .join('; ')
    case 'test-file':
      return APPLIED_TEST_FILE_PREFIX + view.filePath
    case 'unavailable':
      return APPLIED_UNAVAILABLE_TEXT
    default:
      return view satisfies never
  }
}

/** How an applied or drafted entry's one line ends when its change was not recorded (261003-cpv). */
export const APPLIED_CONTENT_NOT_RECORDED_TEXT = 'its content was not recorded.'
export const DRAFTED_CHANGE_NOT_RECORDED_TEXT = 'what it changed was not recorded.'

/**
 * The ONE history line for an entry (2026-10-03, quick 261003-cpv, 432-UI-REVIEW fix 2, D-25): what
 * the mark did, with what an applied fix changed after a colon. It replaces a disposition line plus
 * a second applied line, which said the same change twice and could contradict itself. The history
 * component renders exactly this text, with record content and paths as text nodes.
 */
export function historyChangeText(entry: Pick<MarkHistoryEntry, 'disposition' | 'changedRecords'>): string {
  const lead = dispositionText(entry.disposition)
  const view = appliedChangeView(entry)
  if (view === undefined) return lead
  switch (view.kind) {
    case 'knowledge':
      return `${lead}: ${view.records
        .map((record) => (record.content === undefined ? appliedRecordUnavailableText(record.recordId) : `“${record.content}”`))
        .join('; ')}`
    case 'test-file':
      return `${lead}: ${view.filePath}`
    case 'unavailable':
      return `${lead}; ${entry.disposition.kind === 'drafted' ? DRAFTED_CHANGE_NOT_RECORDED_TEXT : APPLIED_CONTENT_NOT_RECORDED_TEXT}`
    default:
      return view satisfies never
  }
}

/**
 * How an applied change is corrected (D-09/D-11), shown once above the history when an entry applied
 * a fix. Marking again replaces the mark, not the fix, so the pointer says so.
 */
export const APPLIED_CORRECTION_TEXT
  = 'A fix stays when you mark again: correct knowledge with new feedback or by forgetting it, and revert a test edit with git.'

export const HISTORY_EMPTY_TEXT = {
  step: 'No feedback on this step yet.',
  test: 'No feedback on this test yet.',
  run: 'No feedback on this run yet.',
} satisfies Record<FeedbackEntryScope | 'run', string>

export function historyStateText(state: 'run-not-found' | 'ledger-corrupt' | 'ledger-unavailable', line?: number): string {
  switch (state) {
    case 'run-not-found':
      return "This run's feedback history can't be found."
    case 'ledger-corrupt':
      return `This run's feedback history is damaged at line ${String(line)}, so it can't be shown.`
    case 'ledger-unavailable':
      return "This run's feedback history can't be read right now."
    default:
      return state satisfies never
  }
}

export function HISTORY_READ_FAILED_TEXT(reason: string): string {
  return `Couldn't load this run's feedback history — ${reason}.`
}

export const HISTORY_RETRY_ACCESSIBLE_NAME = `${RETRY_LABEL} loading feedback history`

const MARK_TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/** The browser's own short date and 24-hour time; cells compare through this, never a clock literal. */
export function formatMarkTime(markedAt: number | undefined): string | undefined {
  return markedAt === undefined || !Number.isFinite(markedAt) ? undefined : MARK_TIME_FORMAT.format(new Date(markedAt))
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
    return { prefix: `Step ${String(entry.stepIndex + 1)} of ${String(view.stepCount)} · `, name: view.heading.name }
  }
  const member = detail?.members.find((candidate) => candidate.testIndex === entry.testIndex) ?? { testIndex: entry.testIndex }
  return { prefix: '', name: memberDisplayName(member), suffix: ` ${memberHandleLabel(entry.testIndex)} · whole test` }
}
