// the deterministic half of runs.mark, shared by the writer and its preview.
// Nothing here opens an intent, lease, model or audit dir, mints an id or time, or writes.
import { dirname, join, resolve } from 'node:path'
import { chainJobIdsForRun, type KnowledgeReaderPort } from '@vostride/agent-qa-agent'
import { createKnowledgeReader, DIGEST_JOB_ID_SOURCE, FsMarkLedger, HANDOFF_FILE, latestMarkReceiptFor, loadCompletedRunHandoff, LOCAL_CURATION_CAPABILITIES, RUNS_SUBDIR, type LocalCurationCapabilities } from '@vostride/agent-qa-agent-local'
import { MARK_TARGET_REASONS, projectRecordContent, RunsMarkInputSchema, slugBranch, type CompletedRunHandoff, type ImprovementPlan, type KnowledgeRecordShowResult, type KnowledgeTargetRef, type Mark, type MarkAddress, type MarkPreviewKnowledge, type MarkPreviewKnowledgeRecord, type MarkQuarantineClass, type MarkReceipt, type NoDraftableFixChecked, type RunsMarkInput, type RunsMarkOutcome } from '@vostride/agent-qa-schema'
import { resolveConfig, resolveConfiguredKnowledgeRoot } from '../config.js'

export type MarkPlanCuration = Pick<LocalCurationCapabilities, 'triageMark' | 'servedIdsOn' | 'procedureReadOn' | 'applyFeedback' | 'readFeedbackRecord' | 'planMarkEvidence' | 'projectMarkEvidenceOutcome'>
type MarkMember = CompletedRunHandoff['tests'][number]
type MarkStep = MarkMember['steps'][number]
export type ServedRecordFacts = NonNullable<ReturnType<LocalCurationCapabilities['readFeedbackRecord']>>

export type MarkTargetRefusal = Extract<RunsMarkOutcome, { kind: 'run-not-found' | 'member-not-found' | 'ambiguous-address' }>
export type MarkPlanRefusal = Extract<RunsMarkOutcome, { kind: 'step-not-found' }>

export function resolveMarkMember(handoff: CompletedRunHandoff, testId?: string) {
  const matches = testId === undefined ? handoff.tests : handoff.tests.filter(test => test.testId === testId)
  const candidates = matches.map(member => ({ testIndex: member.testIndex,
    ...(member.testId === undefined ? {} : { testId: member.testId }) }))
  if (candidates.length > 1) {
    return { kind: 'ambiguous-address' as const, runId: handoff.runId, candidates }
  }
  const member = matches[0]
  if (member === undefined) return { kind: 'member-not-found' as const, runId: handoff.runId,
    ...(testId === undefined ? {} : { testId }) }
  return { kind: 'member' as const, member }
}

export type MarkTarget =
  | { kind: 'target'; handoff: CompletedRunHandoff; member: MarkMember; address: MarkAddress }
  | MarkTargetRefusal

export function loadMarkTarget(agentQaRoot: string, input: RunsMarkInput): MarkTarget {
  let handoff: CompletedRunHandoff
  try { handoff = loadCompletedRunHandoff(join(agentQaRoot, RUNS_SUBDIR, slugBranch(input.runId), HANDOFF_FILE)) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'run-not-found', runId: input.runId }
    throw error
  }
  const resolved = resolveMarkMember(handoff, input.testId)
  if (resolved.kind !== 'member') return resolved
  const { member } = resolved
  return { kind: 'target', handoff, member, address: { runId: input.runId, testIndex: member.testIndex,
    ...(member.testId === undefined ? {} : { testId: member.testId }),
    ...(input.stepIndex === undefined ? {} : { stepIndex: input.stepIndex }) } }
}

/** The curation job whose positives a false-pass may overturn; the writer and its preview pass the same ids. */
export function markEvidenceCurationJobIds(runId: string): string[] {
  return [chainJobIdsForRun(runId, DIGEST_JOB_ID_SOURCE).curateMemory]
}

/** The note is deliberately not compared: only the kind makes a mark a repeat. */
export function isIdenticalRepeat(prior: MarkReceipt, input: RunsMarkInput): boolean {
  return prior.kind === input.kind
}

/** A read-time observation, not a lock: the writer re-plans under its own transaction. */
export interface MarkPlanBasis { ledgerOrdinal: number; priorOrdinal?: number }
export type MarkLatest = { kind: 'first' } | { kind: 'supersedes'; markId: string; ordinal: number }
export interface MarkResolvedStep { stepIndex: number; reason: (typeof MARK_TARGET_REASONS)[number] }

export type MarkFeedbackPlan =
  | { kind: 'already-marked'; receipt: MarkReceipt; basis: MarkPlanBasis }
  | { kind: 'refused'; outcome: MarkPlanRefusal; basis: MarkPlanBasis }
  | { kind: 'quarantined'; class: MarkQuarantineClass; resolvedStep: MarkResolvedStep; latest: MarkLatest; basis: MarkPlanBasis }
  | { kind: 'effects'; resolvedStep: MarkResolvedStep
    knowledge: { servedRecordIds: string[]; appendsEvidence: boolean }
    latest: MarkLatest; basis: MarkPlanBasis }

export interface PlanMarkFeedbackInput {
  input: RunsMarkInput
  handoff: CompletedRunHandoff
  member: MarkMember
  address: MarkAddress
  prior: MarkReceipt | undefined
  ledgerOrdinal: number
  curation: Pick<MarkPlanCuration, 'triageMark' | 'servedIdsOn'>
}

type MarkStepResolution =
  | { kind: 'resolved'; stepIndex: number; reason: (typeof MARK_TARGET_REASONS)[number] }
  | { kind: 'step-not-found'; stepCount: number }

/** The addressed step, else the first failing step (never for a false-pass), else the last step. */
function resolveMarkStep(handoff: CompletedRunHandoff, address: MarkAddress, kind: Mark): MarkStepResolution {
  if (address.runId !== handoff.runId) throw new Error('mark run does not match handoff')
  const members = handoff.tests.filter(member => member.testIndex === address.testIndex)
  const member = members[0]
  if (members.length !== 1 || member === undefined ||
    (address.testId !== undefined && address.testId !== member.testId)) {
    throw new Error('mark member does not match handoff')
  }
  if (address.stepIndex !== undefined) {
    if (!Number.isInteger(address.stepIndex) || address.stepIndex < 0 || address.stepIndex >= member.steps.length) {
      return { kind: 'step-not-found', stepCount: member.steps.length }
    }
    return { kind: 'resolved', stepIndex: address.stepIndex, reason: 'step-mark' }
  }
  if (member.steps.length === 0) return { kind: 'step-not-found', stepCount: 0 }
  const failing = kind === 'false-pass' ? -1 : member.steps.findIndex(step => step.verifierVerdict?.pass === false)
  return {
    kind: 'resolved',
    stepIndex: failing < 0 ? member.steps.length - 1 : failing,
    reason: failing < 0 ? 'passing-verdict' : 'failing-step',
  }
}

/** The writer's refusal order: repeat, unresolvable step, then quarantine. */
export function planMarkFeedback({ input, handoff, member, address, prior, ledgerOrdinal, curation }: PlanMarkFeedbackInput): MarkFeedbackPlan {
  const basis: MarkPlanBasis = { ledgerOrdinal, ...(prior === undefined ? {} : { priorOrdinal: prior.ordinal }) }
  if (prior !== undefined && isIdenticalRepeat(prior, input)) return { kind: 'already-marked', receipt: prior, basis }
  const triage = curation.triageMark(member)
  const resolution = resolveMarkStep(handoff, address, input.kind)
  if (resolution.kind === 'step-not-found') {
    // The outcome schema exposes the numeric address only.
    return { kind: 'refused', basis, outcome: { kind: 'step-not-found', runId: address.runId, testIndex: address.testIndex,
      stepIndex: input.stepIndex ?? 0, stepCount: resolution.stepCount } }
  }
  const resolvedStep: MarkResolvedStep = { stepIndex: resolution.stepIndex, reason: resolution.reason }
  const latest: MarkLatest = prior === undefined ? { kind: 'first' } : { kind: 'supersedes', markId: prior.markId, ordinal: prior.ordinal }
  if (triage.kind === 'quarantined') return { kind: 'quarantined', class: triage.class, resolvedStep, latest, basis }
  const servedRecordIds = curation.servedIdsOn(member.steps[resolvedStep.stepIndex]!)
  return { kind: 'effects', resolvedStep,
    knowledge: { servedRecordIds, appendsEvidence: servedRecordIds.length > 0 || input.kind === 'false-pass' },
    latest, basis }
}

export async function readMarkDraftFacts(input: { reader: KnowledgeReaderPort
  curation: Pick<MarkPlanCuration, 'servedIdsOn' | 'procedureReadOn' | 'readFeedbackRecord'>
  knowledgeRoot: string; member: MarkMember; step: MarkStep }): Promise<{ served: ServedRecordFacts[]; procedure?: ServedRecordFacts }> {
  const { reader, curation, knowledgeRoot, member, step } = input
  const evidenceRef = step.subActions.find(action => action.decisionScreenshotRef !== undefined)?.decisionScreenshotRef
  const readFacts = async (recordId: string) => {
    // showRecord supplies the existing guarded read. The private capability adds only
    // fields needed to construct a draft; unresolved/corrupt records are not counted.
    if ((await reader.showRecord({ recordId })).kind !== 'found') return undefined
    return curation.readFeedbackRecord({ knowledgeRoot, recordId, evidenceRef })
  }
  const served = (await Promise.all(curation.servedIdsOn(step).map(readFacts))).filter(value => value !== undefined)
  const procedureId = curation.procedureReadOn(member, step.stepIndex)
  const procedure = procedureId === undefined ? undefined : await readFacts(procedureId)
  return { served, ...(procedure === undefined ? {} : { procedure }) }
}

type ApplyFeedbackInput = Parameters<MarkPlanCuration['applyFeedback']>[0]

export function markFeedbackInput(mark: ApplyFeedbackInput['mark'], input: { handoff: CompletedRunHandoff
  member: MarkMember; step: MarkStep; served: ServedRecordFacts[]; procedure?: ServedRecordFacts }): ApplyFeedbackInput {
  const { handoff, member, step, served, procedure } = input
  return { mark, handoff, resolvedStepIndex: step.stepIndex, served,
    ...(procedure === undefined ? {} : { procedure }),
    ...(member.filePath && member.testName ? { testRef: `${member.filePath}::${member.testName}` } : {}) }
}

export type MarkDraftDecision =
  | { kind: 'knowledge'; plan: Extract<ImprovementPlan, { kind: 'knowledge' }> }
  | { kind: 'test-edit'; plan: Extract<ImprovementPlan, { kind: 'test-edit' }> }
  | { kind: 'no-draftable-fix'; checked: NoDraftableFixChecked }

/** A test edit is applied only by a host that can invoke the authoring edit; otherwise it records drift. */
export function decideMarkDraft(plan: ImprovementPlan, input: { servedRecords: number; procedureRead: boolean
  member: MarkMember; canDraftTestEdit: boolean }): MarkDraftDecision {
  if (plan.kind === 'knowledge') return { kind: 'knowledge', plan }
  if (plan.kind === 'test-edit' && input.canDraftTestEdit) return { kind: 'test-edit', plan }
  return { kind: 'no-draftable-fix', checked: plan.kind === 'no-draftable-fix' ? plan.checked
    : { servedRecords: input.servedRecords, procedureReads: input.procedureRead ? 1 : 0, assertionDrift: true,
      ...(input.member.rootCause === undefined ? {} : { rootCause: input.member.rootCause.class }) } }
}

export type MarkDraftPreview =
  | { kind: 'confirmed-bug' }
  | { kind: 'knowledge'; fix: Extract<ImprovementPlan, { kind: 'knowledge' }>['fix']; target: KnowledgeTargetRef }
  | { kind: 'test-edit'; testRef: string }
  | { kind: 'no-draftable-fix'; checked: NoDraftableFixChecked }

export interface MarkPreviewMember { testIndex: number; testId?: string }

export type MarkConsequencePreview =
  | MarkTargetRefusal
  | MarkPlanRefusal
  | Extract<MarkFeedbackPlan, { kind: 'already-marked' }>
  | (Extract<MarkFeedbackPlan, { kind: 'quarantined' }> & { member: MarkPreviewMember })
  | { kind: 'consequences'; member: MarkPreviewMember; resolvedStep: MarkResolvedStep
    /** Unmasked: the op masks joined content and evidence tokens at its boundary. */
    knowledge: MarkPreviewKnowledge
    draft: MarkDraftPreview; latest: MarkLatest; basis: MarkPlanBasis }

export interface MarkPreviewDeps {
  configPath: string
  agentQaRoot: string
  curation?: MarkPlanCuration
  reader?: KnowledgeReaderPort
  /** Mirrors a writer host that binds invokeAuthoringDraftEdit; the preview never invokes it. */
  canDraftTestEdit?: boolean
}

// applyFeedback's plan schema requires a mark id. This planning-only value never leaves the
// preview: only the draft kind, fix and target are projected, never deltas or feedback sources.
const PLANNING_MARK_ID = 'mark_000000000000'

type RecordJoin = Pick<MarkPreviewKnowledgeRecord, 'recordContent' | 'contentAbsence'>

/**
 * D-17 via D-20's batch join: one maintenance scan over every reached record. No batch read is a
 * named `not-bound`, an unfinished scan is `scan-incomplete` for all, a miss is `not-found`.
 */
async function joinReachedRecords(reader: KnowledgeReaderPort, recordIds: readonly string[]): Promise<(recordId: string) => RecordJoin> {
  const showRecords = reader.showRecords
  if (showRecords === undefined) return () => ({ contentAbsence: { reason: 'not-bound' } })
  if (recordIds.length === 0) return () => ({ contentAbsence: { reason: 'not-found' } })
  let results: readonly KnowledgeRecordShowResult[]
  try {
    results = await showRecords.call(reader, { recordIds })
  } catch (error) {
    // Read by name, as runs.knowledge does: only the store's own incomplete-scan refusal folds.
    if (!(error instanceof Error && error.name === 'KnowledgeMaintenanceScanError')) throw error
    return () => ({ contentAbsence: { reason: 'scan-incomplete' } })
  }
  const found = new Map(results.flatMap(result => result.kind === 'found' ? [[result.record.recordId, projectRecordContent(result)] as const] : []))
  return recordId => {
    const recordContent = found.get(recordId)
    return recordContent === undefined ? { contentAbsence: { reason: 'not-found' } } : { recordContent }
  }
}

export async function previewMarkConsequences(deps: MarkPreviewDeps, raw: unknown): Promise<MarkConsequencePreview> {
  const input = RunsMarkInputSchema.parse(raw)
  const curation = deps.curation ?? LOCAL_CURATION_CAPABILITIES
  const target = loadMarkTarget(deps.agentQaRoot, input)
  if (target.kind !== 'target') return target
  const { handoff, member, address } = target
  const ledger = new FsMarkLedger({ root: deps.agentQaRoot, runId: input.runId })
  // One read. A corrupt ledger throws runs.mark's own MarkLedgerCorruptError, uncaught: the
  // preview has exactly the writer's refusal arms and mints no ledger-corrupt arm of its own.
  const receipts = ledger.read()
  const plan = planMarkFeedback({ input, handoff, member, address, prior: latestMarkReceiptFor(receipts, input.runId, address),
    ledgerOrdinal: receipts.length, curation })
  if (plan.kind === 'refused') return plan.outcome
  const previewMember: MarkPreviewMember = { testIndex: member.testIndex, ...(member.testId === undefined ? {} : { testId: member.testId }) }
  if (plan.kind === 'quarantined') return { ...plan, member: previewMember }
  if (plan.kind !== 'effects') return plan
  let store: { knowledgeRoot: string; reader: KnowledgeReaderPort } | undefined
  const storeOf = async () => {
    if (store !== undefined) return store
    const config = await resolveConfig({ configPath: deps.configPath, loadAuthPlugins: false })
    const knowledgeRoot = resolveConfiguredKnowledgeRoot(config, dirname(resolve(deps.configPath)))
    store = { knowledgeRoot, reader: deps.reader ?? createKnowledgeReader(() => knowledgeRoot) }
    return store
  }

  let knowledge: MarkPreviewKnowledge = { ...plan.knowledge, records: [], evidence: { confirmed: 0, overturned: 0 } }
  if (plan.knowledge.appendsEvidence) {
    const { knowledgeRoot, reader } = await storeOf()
    // The writer's append plans these exact inputs under its lease; here the plan is only read.
    const evidencePlan = curation.planMarkEvidence({ knowledgeRoot, mark: { runId: input.runId, kind: input.kind },
      servedRecordIds: plan.knowledge.servedRecordIds, handoff, curationJobIds: markEvidenceCurationJobIds(input.runId) })
    const joinFor = await joinReachedRecords(reader, evidencePlan.targets.map(target => target.recordId))
    const records = evidencePlan.targets.map((target): MarkPreviewKnowledgeRecord => ({
      recordId: target.recordId,
      ...joinFor(target.recordId),
      served: target.kind === 'effects' ? target.served : plan.knowledge.servedRecordIds.includes(target.recordId),
      evidence: target.kind === 'unreadable' ? { kind: 'unreadable' } : { kind: 'effects', effects: target.effects.map(effect =>
        effect.direction === 'confirm' ? { direction: 'confirm' as const } : { direction: 'overturn' as const,
          overturnsEvidenceToken: effect.overturnsEvidenceToken, overturnsCurationJobId: effect.overturnsCurationJobId }) },
    }))
    // A resumed writer reports its complete logical effect, so duplicates inside one plan still count.
    const { confirmed, overturned } = curation.projectMarkEvidenceOutcome(evidencePlan, { includeAlreadyAppended: true })
    knowledge = { ...plan.knowledge, records, evidence: { confirmed, overturned } }
  }

  let draft: MarkDraftPreview = { kind: 'confirmed-bug' }
  if (input.kind !== 'confirmed-bug') {
    const { knowledgeRoot, reader } = await storeOf()
    const step = member.steps[plan.resolvedStep.stepIndex]!
    const { served, procedure } = await readMarkDraftFacts({ reader, curation, knowledgeRoot, member, step })
    const improvement = curation.applyFeedback(markFeedbackInput({ markId: PLANNING_MARK_ID, runId: input.runId,
      runSlug: slugBranch(input.runId), testIndex: member.testIndex,
      ...(member.testId === undefined ? {} : { testId: member.testId }),
      ...(input.stepIndex === undefined ? {} : { stepIndex: input.stepIndex }),
      kind: input.kind, ...(input.note === undefined ? {} : { note: input.note }) },
    { handoff, member, step, served, ...(procedure === undefined ? {} : { procedure }) }))
    const decided = decideMarkDraft(improvement, { servedRecords: served.length, procedureRead: procedure !== undefined,
      member, canDraftTestEdit: deps.canDraftTestEdit === true })
    draft = decided.kind === 'knowledge' ? { kind: 'knowledge', fix: decided.plan.fix, target: decided.plan.target }
      : decided.kind === 'test-edit' ? { kind: 'test-edit', testRef: decided.plan.testRef }
        : { kind: 'no-draftable-fix', checked: decided.checked }
  }
  return { kind: 'consequences', member: previewMember, resolvedStep: plan.resolvedStep,
    knowledge, draft, latest: plan.latest, basis: plan.basis }
}
