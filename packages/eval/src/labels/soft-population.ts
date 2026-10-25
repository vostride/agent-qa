import { actionDidNotFail, screenStateHash, sha256hex } from '@vostride/agent-qa-schema'
import type { Action, CompletedRunHandoff, PerTestOutcome, StepEvidence, SubActionEvidence } from '@vostride/agent-qa-schema'
import { canonicalJson } from '../canonical-json'
import { resolveProductPartition } from './corpus-entry'
import { deriveLeafCassetteId, deriveRunSlug } from '../extract/ids'
import type { GoldMark } from './golden-plan'
import type { LabelProvenance } from './label-record'
import type { SoftRecoveringDecisionEvidence } from './soft-weight'

export type SoftEvidenceSkipReason = 'missing-original' | 'missing-failed-state' | 'missing-action'
  | 'unverified-success' | 'ambiguous-decision' | 'conflicting-observation' | 'missing-attempt'
export interface SoftEvidenceSkip {
  product: string
  runId: string
  testIndex: number
  stepIndex: number
  attempt: number
  reason: SoftEvidenceSkipReason
}
export interface SoftObservation {
  id: string
  product: string
  runId: string
  testId: string
  testIndex: number
  stepIndex: number
  attempt: number
  failedScreenStateHash: string
  recoveringAction: Action
  recoveringCassetteId: string
  recoveringDecision: SoftRecoveringDecisionEvidence
  rerun?: LabelProvenance['rerun']
}
export interface SoftPopulation {
  observations: SoftObservation[]
  skips: SoftEvidenceSkip[]
  missingEvidenceCounts: Partial<Record<SoftEvidenceSkipReason, number>>
  evidenceDigest: string
}
export interface CollectSoftPopulationInput {
  handoffs: readonly CompletedRunHandoff[]
  /** Validated receipts; only the latest receipt at its actual address may govern. */
  marks?: readonly GoldMark[]
}

function actionKey(action: unknown): string | undefined {
  if (!action || typeof action !== 'object' || !('type' in action) || typeof action.type !== 'string') return undefined
  try { return canonicalJson(action) } catch { return undefined }
}

function plannerEvidence(step: StepEvidence, recovering: SubActionEvidence): SoftRecoveringDecisionEvidence {
  // Live exchanges identify the actual producing turn; a verifier or a failed turn
  // cannot supply a missing recovering planner identity.
  if (Array.isArray(recovering.exchanges)) {
    const profile = step.modelProfile
    const modelId = recovering.callRecord?.resolvedModelId ?? profile?.modelId
    return profile && typeof profile.provider === 'string' && profile.provider.trim()
      && typeof modelId === 'string' && modelId.trim()
      ? { modelIdentity: { provider: profile.provider, modelId } } : {}
  }
  const source = step.planSource
  return source?.kind === 'procedure-replay' && source.guard.checksPassed > 0
    && source.guard.checksPassed === source.guard.total && !source.guard.miss
    && !source.guard.executionFailure && !source.guard.verifierRejection
    ? { deterministicPath: true } : {}
}

function latestMarks(marks: readonly GoldMark[]): GoldMark[] {
  const latest = new Map<string, GoldMark>()
  for (const mark of marks) {
    const key = canonicalJson([mark.runId, mark.testIndex, mark.stepIndex ?? null])
    if ((latest.get(key)?.ordinal ?? 0) < mark.ordinal) latest.set(key, mark)
  }
  return [...latest.values()]
}

function governingMark(marks: readonly GoldMark[], handoff: CompletedRunHandoff,
  test: PerTestOutcome, step: StepEvidence, cassetteId: string): GoldMark | undefined {
  return marks.filter(mark => mark.runId === handoff.runId && mark.testIndex === test.testIndex
    && (mark.testId === undefined || mark.testId === test.testId)
    && (mark.stepIndex === undefined || mark.stepIndex === step.stepIndex)
    // A run mark covers its actual frozen decision set, never every step in the run.
    && mark.gold.some(gold => gold.sourceCassetteId === cassetteId))
    .sort((a, b) => b.ordinal - a.ordinal)[0]
}

function observe(handoff: CompletedRunHandoff, test: PerTestOutcome, step: StepEvidence,
  attempt: number, marks: readonly GoldMark[]): SoftObservation | SoftEvidenceSkipReason {
  const failedKey = actionKey(step.selfHeal?.failedDecision?.plannedAction)
  const recoveringKey = actionKey(step.selfHeal?.recoveringDecision?.plannedAction)
  if (failedKey === undefined || recoveringKey === undefined) return 'missing-action'
  const failed = step.subActions.filter(sub => actionKey(sub.plannedAction) === failedKey)
  if (failed.length !== 1) return 'ambiguous-decision'
  const recovering = step.subActions.filter(sub => sub !== failed[0] && actionKey(sub.plannedAction) === recoveringKey)
  if (recovering.length !== 1) return 'ambiguous-decision'
  const state = failed[0]!.stateBefore
  if (!state || !Array.isArray(state.elements) || typeof state.platform !== 'string') return 'missing-failed-state'
  let failedScreenStateHash: string
  try { failedScreenStateHash = screenStateHash(state) } catch { return 'missing-failed-state' }
  // A skipped tap can recover a step (437 D-05): the recovering action only has to not fail.
  if (!step.selfHeal || !actionDidNotFail(step.selfHeal.recoveringDecision.result)
    || !actionDidNotFail(recovering[0]!.result)
    || step.verifierVerdict?.pass !== true) return 'unverified-success'
  const product = resolveProductPartition(handoff.scope)
  const recoveringCassetteId = deriveLeafCassetteId({ runSlug: deriveRunSlug(handoff.runId),
    testIndex: test.testIndex, stepIndex: step.stepIndex, decisionOrdinal: step.subActions.indexOf(recovering[0]!) })
  const mark = governingMark(marks, handoff, test, step, recoveringCassetteId)
  const identity = { product, runId: handoff.runId, testIndex: test.testIndex, stepIndex: step.stepIndex, attempt, failedScreenStateHash }
  return { ...identity, id: sha256hex(canonicalJson(identity)), testId: test.testId,
    recoveringAction: step.selfHeal.recoveringDecision.plannedAction, recoveringCassetteId,
    recoveringDecision: { ...plannerEvidence(step, recovering[0]!), verifierVerdict: { pass: true },
      ...(mark ? { governingMark: { markId: mark.markId, kind: mark.kind } } : {}) },
    ...(attempt > 0 ? { rerun: { attempt,
      ...(test.rerunOrigin ? { originalAttempt: test.rerunOrigin.attempt, originalEvidenceDigest: test.rerunOrigin.evidenceDigest } : {}) } } : {}) }
}

/** Count handoff facts, never label copies or derived weights. Conflicting identities fail closed. */
export function collectSoftPopulation(input: CollectSoftPopulationInput): SoftPopulation {
  const observations = new Map<string, SoftObservation>()
  const conflicts = new Set<string>()
  const skips = new Map<string, SoftEvidenceSkip>()
  const marks = latestMarks(input.marks ?? [])
  const record = (handoff: CompletedRunHandoff, test: PerTestOutcome, step: StepEvidence, attempt: number, original = false) => {
    if (step.selfHeal === undefined) return
    const address = { product: resolveProductPartition(handoff.scope), runId: handoff.runId,
      testIndex: test.testIndex, stepIndex: step.stepIndex, attempt }
    const skip = (reason: SoftEvidenceSkipReason) => {
      const row = { ...address, reason }; skips.set(canonicalJson(row), row)
    }
    if (test.isRerun && test.rerunAttempt === undefined) { skip('missing-attempt'); return }
    if (test.isRerun && !test.rerunOrigin) skip('missing-original')
    const observation = observe(handoff, test, step, attempt, original ? [] : marks)
    if (typeof observation === 'string') { skip(observation); return }
    const prior = observations.get(observation.id)
    if (prior && canonicalJson(prior) !== canonicalJson(observation)) {
      conflicts.add(observation.id); observations.delete(observation.id); skip('conflicting-observation')
    } else if (!conflicts.has(observation.id)) observations.set(observation.id, observation)
  }
  for (const handoff of input.handoffs) for (const test of handoff.tests) {
    for (const step of test.steps) record(handoff, test, step, test.rerunAttempt ?? 0)
    // Origin captures repeat a complete step once per decision: the identity set folds them once.
    for (const original of test.rerunOrigin?.decisions ?? []) {
      record(handoff, { ...test, isRerun: undefined, rerunAttempt: undefined, rerunOrigin: undefined },
        original.evidence, test.rerunOrigin!.attempt, true)
    }
  }
  const ordered = [...observations.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const orderedSkips = [...skips.values()].sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)))
  const missingEvidenceCounts: SoftPopulation['missingEvidenceCounts'] = {}
  for (const skip of orderedSkips) missingEvidenceCounts[skip.reason] = (missingEvidenceCounts[skip.reason] ?? 0) + 1
  return { observations: ordered, skips: orderedSkips, missingEvidenceCounts,
    evidenceDigest: sha256hex(canonicalJson({ observations: ordered, skips: orderedSkips })) }
}
