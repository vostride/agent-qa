// Mechanical drafting over recorded data only.
import {
  IMPROVEMENT_PLAN_SCHEMA_VERSION,
  ImprovementPlanSchema,
  MARK_QUARANTINE_CLASSES,
  actionDidNotFail,
  asEvidenceToken,
  asRecordId,
  type Anchor,
  type ArtifactRef,
  type BundleDraft,
  type BundleKind,
  type CompletedRunHandoff,
  type Delta,
  type FactSubtype,
  type ImprovementPlan,
  type Mark,
  type MarkQuarantineClass,
  type MarkReceipt,
  type NoDraftableFixChecked,
  type OriginStage,
  type PerTestOutcome,
  type ScopeKey,
  type StepEvidence,
  type VerdictClass,
} from '@vostride/agent-qa-schema'
import { floorProse } from './floor-prose.js'

export type MarkTriage =
  | { kind: 'quarantined'; class: MarkQuarantineClass; producer: string }
  | { kind: 'learnable'; rootCause?: { class: VerdictClass; producer: string } }

export function triageMark(member: PerTestOutcome): MarkTriage {
  const root = member.rootCause
  const quarantine = MARK_QUARANTINE_CLASSES.find((value) => value === root?.class)
  if (quarantine !== undefined && root !== undefined) {
    return { kind: 'quarantined', class: quarantine, producer: root.producer }
  }
  return { kind: 'learnable', ...(root === undefined ? {} : {
    rootCause: { class: root.class, producer: root.producer },
  }) }
}

export function servedIdsOn(step: StepEvidence): string[] {
  return [...new Set([...step.servedBrief.channel1, ...step.servedBrief.channel3]
    .map((line) => line.id))]
}

export function procedureReadOn(member: PerTestOutcome, stepIndex: number): string | undefined {
  return member.steps.filter((step) => step.stepIndex <= stepIndex)
    .flatMap((step) => step.servedBrief.channel2)[0]?.id
}

export function assertionDrift(member: PerTestOutcome, step: StepEvidence): boolean {
  // Every sub-action did not fail (actionDidNotFail): a skipped tap sent no input but did not fail.
  return member.rootCause?.class === 'test_bug'
    || (step.verifierVerdict.pass === false
      && step.subActions.every((action) => actionDidNotFail(action.result)))
}

export interface ServedRecordFacts {
  recordId: string
  kind: BundleKind
  subtype?: FactSubtype
  anchors: Anchor[]
  scope: ScopeKey
  summary: string
  distilledEvidenceRef: ArtifactRef
  originStage: OriginStage
}

export type FixSelection =
  | { fix: 'fact' | 'caution'; target: ServedRecordFacts }
  | { fix: 'procedure-hint'; target: ServedRecordFacts }
  | { fix: 'test-edit' }
  | { fix: 'none'; checked: NoDraftableFixChecked }

export function selectFixKind(input: {
  kind: Mark
  member: PerTestOutcome
  step: StepEvidence
  stepIndex: number
  served: ServedRecordFacts[]
  procedure?: ServedRecordFacts
}): FixSelection {
  if (input.kind === 'confirmed-bug') throw new TypeError('confirmed-bug has no drafted fix')
  const target = input.served[0]
  if (target !== undefined && input.kind === 'false-fail'
    && (target.kind !== 'fact' || target.subtype === undefined)) {
    // A recorded caution/unknown does not establish any fact subtype. Do not offer
    // a broad draft that the actual kind-specific commit contract cannot accept.
    return { fix: 'none', checked: { servedRecords: input.served.length,
      procedureReads: input.procedure === undefined ? 0 : 1,
      assertionDrift: assertionDrift(input.member, input.step),
      ...(input.member.rootCause === undefined ? {} : { rootCause: input.member.rootCause.class }),
    } }
  }
  if (target !== undefined) return { fix: input.kind === 'false-fail' ? 'fact' : 'caution', target }
  if (input.procedure !== undefined) return { fix: 'procedure-hint', target: input.procedure }
  if (assertionDrift(input.member, input.step)) return { fix: 'test-edit' }
  return { fix: 'none', checked: {
    servedRecords: input.served.length, procedureReads: 0, assertionDrift: false,
    ...(input.member.rootCause === undefined ? {} : { rootCause: input.member.rootCause.class }),
  } }
}

export interface ApplyFeedbackInput {
  mark: Pick<MarkReceipt, 'markId' | 'runId' | 'runSlug' | 'testIndex' | 'testId' | 'stepIndex' | 'kind' | 'note'>
  handoff: CompletedRunHandoff
  resolvedStepIndex: number
  served: ServedRecordFacts[]
  procedure?: ServedRecordFacts
  testRef?: string
}

export function applyFeedback(input: ApplyFeedbackInput): ImprovementPlan {
  const { mark } = input
  const members = input.handoff.tests.filter((member) => member.testIndex === mark.testIndex)
  const member = members[0]
  if (input.handoff.runId !== mark.runId || members.length !== 1 || member === undefined
    || (mark.testId !== undefined && mark.testId !== member.testId)) {
    throw new TypeError('mark does not address the supplied handoff member')
  }
  const steps = member.steps.filter((step) => step.stepIndex === input.resolvedStepIndex)
  const step = steps[0]
  if (steps.length !== 1 || step === undefined
    || (mark.stepIndex !== undefined && mark.stepIndex !== step.stepIndex)) {
    throw new TypeError('mark does not address the supplied step')
  }
  if (triageMark(member).kind === 'quarantined') throw new TypeError('quarantined marks cannot draft')
  const selection = selectFixKind({ ...input, kind: mark.kind, member, step,
    stepIndex: input.resolvedStepIndex })
  const base = {
    schemaVersion: IMPROVEMENT_PLAN_SCHEMA_VERSION, markId: mark.markId,
    feedbackSource: { runId: mark.runId, testIndex: mark.testIndex, kind: mark.kind,
      ...(mark.testId === undefined ? {} : { testId: mark.testId }),
      ...(mark.stepIndex === undefined ? {} : { stepIndex: mark.stepIndex }) },
    runTraceRef: { runId: mark.runId, runSlug: mark.runSlug },
  }
  if (selection.fix === 'none') {
    return ImprovementPlanSchema.parse({ ...base, kind: 'no-draftable-fix', checked: selection.checked })
  }
  if (selection.fix === 'test-edit') {
    const testRef = input.testRef || (member.filePath && member.testName
      ? `${member.filePath}::${member.testName}` : undefined)
    if (testRef === undefined) {
      // The closed checked contract records drift but cannot carry an address-missing reason.
      return ImprovementPlanSchema.parse({ ...base, kind: 'no-draftable-fix', checked: {
        servedRecords: 0, procedureReads: 0, assertionDrift: true,
        ...(member.rootCause === undefined ? {} : { rootCause: member.rootCause.class }),
      } })
    }
    return ImprovementPlanSchema.parse({ ...base, kind: 'test-edit', fix: 'test-edit', testRef,
      intent: floorProse({ kind: mark.kind, fix: 'fact', stepText: step.stepText,
        verifierReasoning: step.verifierVerdict.reasoning, note: mark.note }).body, wording: 'floor' })
  }
  const target = selection.target
  const prose = floorProse({ kind: mark.kind, fix: selection.fix, stepText: step.stepText,
    verifierReasoning: step.verifierVerdict.reasoning, servedSummary: target.summary, note: mark.note })
  const bundle: BundleDraft = {
    kind: selection.fix === 'caution' ? 'caution' : 'fact',
    ...(selection.fix === 'procedure-hint' ? { subtype: 'navigational' as const }
      : selection.fix === 'fact' && target.subtype !== undefined ? { subtype: target.subtype } : {}),
    anchors: target.anchors, scope: target.scope, ...prose,
    distilledEvidenceRef: step.subActions.find((action) => action.decisionScreenshotRef !== undefined)
      ?.decisionScreenshotRef ?? target.distilledEvidenceRef,
    // OriginStage is closed to run-curation; user authorship lives on the delta envelope.
    originStage: target.originStage,
  }
  const envelope = { origin: 'user' as const, scope: target.scope, citedIds: [asRecordId(target.recordId)] }
  const delta: Delta = selection.fix === 'fact'
    ? { ...envelope, kind: 'Supersede', victimId: asRecordId(target.recordId), newBundle: bundle,
      evidenceToken: asEvidenceToken(`mark:${mark.markId}`) }
    : { ...envelope, kind: 'Add', bundle }
  return ImprovementPlanSchema.parse({ ...base, kind: 'knowledge', fix: selection.fix,
    target: { grain: 'record', recordId: target.recordId }, deltas: [delta], wording: 'floor' })
}
