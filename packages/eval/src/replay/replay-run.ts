// The pure replay engine. `replayCassette` is the single entry point behind the one
// replay surface: it filters incomplete cassettes to a typed refusal, invokes the real
// planner through the injected factory port once PER SAMPLE (RESEARCH Pitfall 6), classifies
// every outcome faithful-or-loud, runs the k-sample escalation seam with agreement
// aggregation, stamps drift + model ids + unconsumed exchanges, and
// teacher-forces procedure cassettes per step.
//
// Purity: the ONLY time source is the injected `clock` port — no host time API, no host IO, no
// randomness. Outcome classification is by `instanceof` on the typed error classes, NEVER by
// matching an error message string. A cassette-shaped problem resolves to a typed
// ReplayRefusal — replayCassette never throws for it; only a genuine engine bug may propagate.

import type { Action } from '@vostride/agent-qa-schema'
import { PlanningTurnError } from '@vostride/agent-qa-runner'
import type { Cassette, LeafCassette, ProcedureCassette } from '../cassette/cassette'
import type { CassetteInputLeg } from '../cassette/input-leg'
import type { CassetteReceipt } from '../cassette/receipt-leg'
import type { CassetteSidecarLeg } from '../cassette/sidecar-leg'
import type { ArtifactSource } from '../ports'
import { computeReplayDrift } from './drift'
import { UnrenderableBriefError } from './brief-tiers'
import type { BriefSource, TurnMatch } from './brief-tiers'
import { computeDecisionIdentity, decisionIdentityKey } from './identity'
import type { DecisionIdentity } from './identity'
import {
  ActionToolCollisionError,
  UnservableDivergenceError,
  buildRecordedExchangeServer,
} from './exchange-server'
import {
  MissingDecisionBlobError,
  reconstructDecisionContext,
} from './reconstruct'
import { neverEscalate } from './ports'
import type {
  ReplayClock,
  ReplayEscalationContext,
  ReplayEscalationPredicate,
  ReplayPlannerFactory,
} from './ports'
import type {
  DecisionReplayResult,
  LeafReplayResult,
  ProcedureReplayResult,
  ProcedureStepReplay,
  ReplayAgreement,
  ReplayCassetteOutcome,
  ReplayRefusal,
  ReplaySample,
  ReplaySampleOutcome,
  UnconsumedExchange,
} from './result'

/**
 * The replay engine input. `k` defaults to 1 (a single deterministic sample); the
 * `escalationPredicate` defaults to the built-in `neverEscalate` — the ONE seam Phases 369/370
 * bind their settle/escalation policy onto. `actionToolNames` is the platform action slice a
 * recorded exchange may never shadow.
 */
export interface ReplayCassetteInput {
  cassette: Cassette
  artifacts: ArtifactSource
  plannerFactory: ReplayPlannerFactory
  actionToolNames: ReadonlySet<string>
  clock: ReplayClock
  k?: number
  escalationPredicate?: ReplayEscalationPredicate
}

interface DecisionReplayContext {
  cassetteId: string
  decisionOrdinal: number
  stepIndex?: number
  leg: CassetteInputLeg
  sidecar: CassetteSidecarLeg
  receipt: CassetteReceipt
  artifacts: ArtifactSource
  plannerFactory: ReplayPlannerFactory
  actionToolNames: ReadonlySet<string>
  clock: ReplayClock
  k: number
  escalationPredicate: ReplayEscalationPredicate
}

type SampleRun =
  | {
      kind: 'sample'
      sample: ReplaySample
      replayedModel: { provider: string; modelId: string }
      briefSource: BriefSource
      turnMatch?: TurnMatch
      unconsumed: () => UnconsumedExchange[]
    }
  | { kind: 'refusal'; refusal: ReplayRefusal }

function refusal(
  cassetteId: string,
  reason: ReplayRefusal['reason'],
  detail: string,
): ReplayRefusal {
  return { kind: 'integrity-refusal', cassetteId, reason, detail }
}

/** True for a typed ReplayRefusal; DecisionReplayResult carries no `kind`, so this discriminates. */
function isReplayRefusal(value: DecisionReplayResult | ReplayRefusal): value is ReplayRefusal {
  return 'kind' in value && value.kind === 'integrity-refusal'
}

export async function replayCassette(input: ReplayCassetteInput): Promise<ReplayCassetteOutcome> {
  const { cassette } = input

  // Refusal filter (the 367 D-11 completeness vocabulary IS the filter). Guard/version failures
  // were already mapped at load by 368-05; the engine trusts a guarded Cassette but re-checks
  // completeness so an incomplete cassette is never replayed.
  if (cassette.completeness.status !== 'complete') {
    return {
      kind: 'integrity-refusal',
      cassetteId: cassette.id,
      reason: 'completeness',
      detail: `cassette completeness is ${cassette.completeness.status}`,
      completenessStatus: cassette.completeness.status,
    }
  }

  if (cassette.granularity === 'leaf') {
    return replayLeaf(cassette, input)
  }
  return replayProcedure(cassette, input)
}

async function replayLeaf(
  cassette: LeafCassette,
  input: ReplayCassetteInput,
): Promise<LeafReplayResult | ReplayRefusal> {
  const outcome = await replayDecision({
    cassetteId: cassette.id,
    decisionOrdinal: cassette.decisionOrdinal,
    leg: cassette.input,
    sidecar: cassette.sidecar,
    receipt: cassette.receipt,
    artifacts: input.artifacts,
    plannerFactory: input.plannerFactory,
    actionToolNames: input.actionToolNames,
    clock: input.clock,
    k: input.k ?? 1,
    escalationPredicate: input.escalationPredicate ?? neverEscalate,
  })
  if (isReplayRefusal(outcome)) return outcome
  return { granularity: 'leaf', ...outcome }
}

async function replayProcedure(
  cassette: ProcedureCassette,
  input: ReplayCassetteInput,
): Promise<ProcedureReplayResult | ReplayRefusal> {
  const start = input.clock.now()
  const steps: ProcedureStepReplay[] = []

  for (const step of cassette.steps) {
    if (step.kind === 'decision') {
      // Teacher-forced: each decision step replays independently against its OWN recorded
      // stateBefore. No cross-step state is synthesized (CASS-03 forbids free-running).
      const decision = await replayDecision({
        cassetteId: cassette.id,
        decisionOrdinal: step.decisionOrdinal,
        stepIndex: step.stepIndex,
        leg: step.record.input,
        sidecar: step.record.sidecar,
        receipt: step.record.receipt,
        artifacts: input.artifacts,
        plannerFactory: input.plannerFactory,
        actionToolNames: input.actionToolNames,
        clock: input.clock,
        k: input.k ?? 1,
        escalationPredicate: input.escalationPredicate ?? neverEscalate,
      })
      if (isReplayRefusal(decision)) return decision
      steps.push({
        kind: 'decision',
        stepIndex: step.stepIndex,
        decisionOrdinal: step.decisionOrdinal,
        result: decision,
      })
    } else if (step.kind === 'cache-served') {
      steps.push({
        kind: 'skipped',
        stepIndex: step.stepIndex,
        reason: 'cache-served',
        decisionOrdinal: step.decisionOrdinal,
      })
    } else {
      steps.push({ kind: 'skipped', stepIndex: step.stepIndex, reason: 'synthesized' })
    }
  }

  const totalDurationMs = input.clock.now() - start
  // The recorded endState is carried through UNTOUCHED for Phase 369 to score.
  return {
    granularity: 'procedure',
    cassetteId: cassette.id,
    steps,
    endState: cassette.endState,
    totalDurationMs,
  }
}

async function replayDecision(
  context: DecisionReplayContext,
): Promise<DecisionReplayResult | ReplayRefusal> {
  const decisionStart = context.clock.now()
  const samples: ReplaySample[] = []
  let replayedModel: { provider: string; modelId: string } | undefined
  // The LAST sample's leftover exchanges stamp the result. Per-sample servers are identical at
  // construction, so unconsumed is a per-sample signal; stamping the final sample's leftovers is
  // the deterministic convention.
  let lastUnconsumed: (() => UnconsumedExchange[]) | undefined

  const first = await runSample(context, 0)
  if (first.kind === 'refusal') return first.refusal
  samples.push(first.sample)
  replayedModel = first.replayedModel
  lastUnconsumed = first.unconsumed

  const escalationContext: ReplayEscalationContext = {
    cassetteId: context.cassetteId,
    decisionOrdinal: context.decisionOrdinal,
    ...(context.stepIndex === undefined ? {} : { stepIndex: context.stepIndex }),
    sidecar: context.sidecar,
    receipt: context.receipt,
  }
  if (context.k > 1 && context.escalationPredicate(first.sample, escalationContext)) {
    for (let sampleIndex = 1; sampleIndex < context.k; sampleIndex++) {
      const run = await runSample(context, sampleIndex)
      if (run.kind === 'refusal') return run.refusal
      samples.push(run.sample)
      replayedModel = run.replayedModel
      lastUnconsumed = run.unconsumed
    }
  }

  const totalDurationMs = context.clock.now() - decisionStart
  const agreement = aggregateAgreement(samples)
  const promptDrift = computeReplayDrift(context.leg, context.receipt.promptInputHash)
  const recordedModel = deriveRecordedModel(context.receipt)
  const unconsumedExchanges = lastUnconsumed !== undefined ? lastUnconsumed() : []

  return {
    cassetteId: context.cassetteId,
    samples,
    agreement,
    ...(agreement.modal !== undefined ? { modalDecision: agreement.modal.identity } : {}),
    promptDrift,
    briefSource: first.briefSource,
    ...(first.turnMatch !== undefined ? { turnMatch: first.turnMatch } : {}),
    ...(recordedModel !== undefined ? { recordedModel } : {}),
    // replayedModel is stamped by every sample identically; the loop guarantees at least one ran.
    replayedModel: replayedModel as { provider: string; modelId: string },
    unconsumedExchanges,
    totalDurationMs,
  }
}

async function runSample(context: DecisionReplayContext, sampleIndex: number): Promise<SampleRun> {
  const { leg, artifacts, plannerFactory, actionToolNames, clock } = context

  // (1) Fresh exchange server per sample (consume-once budgets stay per-sample).
  let server: ReturnType<typeof buildRecordedExchangeServer>
  try {
    server = buildRecordedExchangeServer({ exchanges: leg.exchanges, actionToolNames })
  } catch (error) {
    if (error instanceof ActionToolCollisionError) {
      return { kind: 'refusal', refusal: refusal(context.cassetteId, 'action-tool-collision', error.message) }
    }
    throw error
  }

  // (2) Fresh planner handle per sample, fed this sample's recorded non-action tools.
  const handle = plannerFactory.create({
    platform: leg.stateBefore.platform,
    nonActionTools: server.nonActionTools,
  })

  // (3) Reconstruct the decision context strictly from the leg (captureMode + screenshot ref
  //     derive from the recorded observation; missing-blob / brief shapes are typed refusals).
  let reconstructed
  try {
    reconstructed = reconstructDecisionContext({
      leg,
      captureMode: leg.stateBefore.metadata.captureMode,
      ...(leg.decisionScreenshotRef !== undefined ? { screenshotRef: leg.decisionScreenshotRef } : {}),
      artifacts,
      model: handle.model,
    })
  } catch (error) {
    if (error instanceof MissingDecisionBlobError) {
      return { kind: 'refusal', refusal: refusal(context.cassetteId, 'missing-blob', error.message) }
    }
    if (error instanceof UnrenderableBriefError) {
      return { kind: 'refusal', refusal: refusal(context.cassetteId, 'unrenderable-brief', error.message) }
    }
    throw error
  }

  // (4) Invoke the real planner and classify faithful-or-loud.
  const started = clock.now()
  const outcome = await classifyPlan(context, handle, reconstructed)
  const durationMs = clock.now() - started

  const sample: ReplaySample = {
    sampleIndex,
    outcome: outcome.outcome,
    durationMs,
    ...(outcome.tokenUsage !== undefined ? { tokenUsage: outcome.tokenUsage } : {}),
    ...(outcome.unsupportedFeatures !== undefined
      ? { unsupportedFeatures: outcome.unsupportedFeatures }
      : {}),
    ...(outcome.providerFingerprint !== undefined
      ? { providerFingerprint: outcome.providerFingerprint }
      : {}),
  }
  return {
    kind: 'sample',
    sample,
    replayedModel: handle.replayedModel,
    unconsumed: server.unconsumed,
    briefSource: reconstructed.briefSource,
    ...(reconstructed.turnMatch !== undefined ? { turnMatch: reconstructed.turnMatch } : {}),
  }
}

async function classifyPlan(
  context: DecisionReplayContext,
  handle: ReturnType<ReplayPlannerFactory['create']>,
  reconstructed: ReturnType<typeof reconstructDecisionContext>,
): Promise<{
  outcome: ReplaySampleOutcome
  tokenUsage?: ReplaySample['tokenUsage']
  unsupportedFeatures?: ReplaySample['unsupportedFeatures']
  providerFingerprint?: ReplaySample['providerFingerprint']
}> {
  try {
    const planResult = await handle.plan(
      context.leg.stepText,
      reconstructed.screenState,
      reconstructed.stepContext,
    )
    // The grounding gate already swapped the resolved ref onto the action in-turn.
    const action = planResult.plan.action as unknown as Action
    const identity = computeDecisionIdentity(action, context.leg.stateBefore.elements)
    return {
      outcome: { kind: 'decision', action, identity },
      ...(planResult.tokenUsage !== undefined ? { tokenUsage: planResult.tokenUsage } : {}),
      ...(planResult.callRecord?.unsupportedFeatures !== undefined
        ? { unsupportedFeatures: planResult.callRecord.unsupportedFeatures }
        : {}),
      ...(planResult.callRecord?.fingerprint !== undefined
        ? { providerFingerprint: planResult.callRecord.fingerprint }
        : {}),
    }
  } catch (error) {
    // Classification by instanceof identity ONLY — never by message string.
    if (error instanceof PlanningTurnError) {
      return {
        outcome: { kind: 'planner-failure', reason: error.reason, message: error.message },
        // A structured failure still carries observed call metadata; dropping it would erase
        // an unsupported-seed warning and incorrectly change the batch's seed regime.
        ...(error.callRecord?.unsupportedFeatures !== undefined
          ? { unsupportedFeatures: error.callRecord.unsupportedFeatures }
          : {}),
        ...(error.callRecord?.fingerprint !== undefined
          ? { providerFingerprint: error.callRecord.fingerprint }
          : {}),
      }
    }
    if (error instanceof UnservableDivergenceError) {
      return { outcome: { kind: 'unservable-divergence', tool: error.tool, args: error.canonicalArgs } }
    }
    // Other throws are infra (provider outage / auth) — reported, never scored, never aborting.
    const message = error instanceof Error ? error.message : String(error)
    return { outcome: { kind: 'harness-error', message } }
  }
}

/**
 * Recorded model identity from the receipt. Prefer the declared identity; when the
 * provider resolved a more specific model id, stamp that as the modelId. Absent when the receipt
 * declares no model — typed-absent, never fabricated (a bare resolvedModelId has no provider).
 */
function deriveRecordedModel(
  receipt: CassetteReceipt,
): { provider: string; modelId: string } | undefined {
  const declared = receipt.model.declared
  if (declared === undefined) return undefined
  return { provider: declared.provider, modelId: receipt.model.resolvedModelId ?? declared.modelId }
}

interface AggregationClass {
  count: number
  kind: ReplaySampleOutcome['kind']
  identity?: DecisionIdentity
}

/**
 * k-sample agreement. Non-harness samples group by class key: `decision` samples by
 * decisionIdentityKey, `planner-failure` by reason (failures ARE candidate decisions, D-09),
 * `unservable-divergence` by tool. `harness-error` samples are EXCLUDED from grouping and tallied
 * in harnessErrorCount — they can never join a modal class, which visibly depresses agreement.
 *
 * agreementRate = modal class size / samples run (always stamped, RPLY-03 first-class). Modal is
 * the largest class. Deterministic no-consensus rule: true when the largest class has size 1 while
 * more than one sample ran, or when two or more classes tie for largest. A DecisionIdentity modal
 * is exposed only when the winning class is a decision class (never fabricated for failures).
 */
function aggregateAgreement(samples: readonly ReplaySample[]): ReplayAgreement {
  const k = samples.length
  const classes = new Map<string, AggregationClass>()
  let harnessErrorCount = 0

  for (const sample of samples) {
    const outcome = sample.outcome
    if (outcome.kind === 'harness-error') {
      harnessErrorCount++
      continue
    }
    let key: string
    let identity: DecisionIdentity | undefined
    if (outcome.kind === 'decision') {
      key = `decision:${decisionIdentityKey(outcome.identity)}`
      identity = outcome.identity
    } else if (outcome.kind === 'planner-failure') {
      key = `planner-failure:${outcome.reason}`
    } else {
      key = `unservable-divergence:${outcome.tool}`
    }
    const existing = classes.get(key)
    if (existing !== undefined) {
      existing.count++
    } else {
      classes.set(key, { count: 1, kind: outcome.kind, ...(identity !== undefined ? { identity } : {}) })
    }
  }

  let maxSize = 0
  for (const group of classes.values()) {
    if (group.count > maxSize) maxSize = group.count
  }
  const winners = [...classes.values()].filter(group => group.count === maxSize && maxSize > 0)
  const agreementRate = k > 0 ? maxSize / k : 0

  let noConsensus: boolean
  let modal: ReplayAgreement['modal']
  if (winners.length === 0) {
    noConsensus = false
  } else if (winners.length > 1 || (maxSize === 1 && k > 1)) {
    noConsensus = true
  } else {
    noConsensus = false
    const winner = winners[0]
    if (winner.kind === 'decision' && winner.identity !== undefined) {
      modal = { identity: winner.identity, count: winner.count }
    }
  }

  return {
    k,
    agreementRate,
    noConsensus,
    harnessErrorCount,
    ...(modal !== undefined ? { modal } : {}),
  }
}
