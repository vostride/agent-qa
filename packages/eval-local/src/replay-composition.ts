// `createModel` is the only egress and mutates `profile.capabilities`, so it gets a fresh copy.

import {
  adjudicateCassetteScore,
  assessJudgeEligibility,
  assessPanelEligibility,
  createPanelIdentity,
  buildDecisionDiff,
  createScoringContext,
  neverEscalate,
  replayCassette,
  scoreCassetteReplay,
} from '@vostride/agent-qa-eval'
import type {
  ArtifactSource,
  Cassette,
  CassetteScore,
  DecisionDiff,
  ReplayCassetteInput,
  ReplayCassetteOutcome,
  ReplayClock,
  ReplayEscalationPredicate,
  ReplayPlannerFactory,
  ReplayPlannerHandle,
  ReplayResult,
  ScoringJudgeRequest,
} from '@vostride/agent-qa-eval'
import {
  createModel,
  createTokenAccounting,
  resolveCapabilities,
} from '@vostride/agent-qa-model'
import type {
  ModelCallObservation,
  ModelProfile,
  ModelProviderOverrides,
  ResolvedModelAuth,
} from '@vostride/agent-qa-model'
import { LLMPlanner, buildTools, defaultRegistry } from '@vostride/agent-qa-runner'
import type { DeclaredModelProfile, MaskFn, ScreenState } from '@vostride/agent-qa-schema'

import { bindJudgePanel, bindJudgePort } from './judge-binding.js'
import type { JudgeBindingInput } from './judge-binding.js'
import type { FsReplayRecordStore } from './replay-record-store.js'
import type { FsScoreStore } from './score-store.js'

type JudgeDeclaration = Omit<JudgeBindingInput, 'mask'>

export interface RunCassetteReplayInput {
  /** A loaded, guarded cassette (leaf or procedure) — normally from loadCassetteBundle. */
  cassette: Cassette
  /** Blob source for full-capture screenshot reconstruction (normally a DirArtifactSource). */
  artifacts: ArtifactSource
  // The configured model profile, the sole source of model selection.
  profile: ModelProfile
  /** Resolved provider auth for the configured model. */
  auth: ResolvedModelAuth
  /** Optional provider overrides — the captured-boundary stub seam for tests (createModel passthrough). */
  modelOverrides?: ModelProviderOverrides
  /** Whole-run counter shared by planner and judge, including provider retries. */
  modelCallObservation?: ModelCallObservation
  /** Optional deterministic timing port for repeatable measurement fixtures. */
  clock?: ReplayClock
  /** Sample budget. Defaults to the engine's k=1. */
  k?: number
  /** Optional replay seed, applied through the sampling seam when the provider supports it. */
  seed?: number
  /** k-sample escalation seam. Defaults to the imported neverEscalate — never re-minted. */
  escalationPredicate?: ReplayEscalationPredicate
  /** Optional persistence: when supplied, the outcome is saved after the replay returns. */
  recordStore?: FsReplayRecordStore
  // Saved after `recordStore.save`; refusals are never scored.
  scoreStore?: FsScoreStore
  // An explicit second profile; absent, every unresolved tie is stamped not-invoked.
  judge?: (JudgeDeclaration & { allowSameFamily?: boolean }) |
    { members: readonly JudgeDeclaration[]; allowSameFamily?: boolean }
  mask: MaskFn
}

/** Persist the declared identity, including a refused panel; singletons retain old bytes. */
export function replayJudgeRequest(judge: RunCassetteReplayInput['judge']): ScoringJudgeRequest {
  if (judge === undefined) return null
  if ('members' in judge) {
    if (judge.members.length === 0) return null
    return { judgeModelId: createPanelIdentity(judge.members.map(member => member.profile.model)).judgeModelId,
      allowSameFamily: judge.members.length === 1 && judge.allowSameFamily === true }
  }
  return { judgeModelId: judge.profile.model, allowSameFamily: judge.allowSameFamily === true }
}

/** The platform the action-tool slice is derived for — the cassette's recorded observation platform. */
function cassettePlatform(cassette: Cassette): ScreenState['platform'] {
  if (cassette.granularity === 'leaf') {
    return cassette.input.stateBefore.platform
  }
  for (const step of cassette.steps) {
    if (step.kind === 'decision') {
      return step.record.input.stateBefore.platform
    }
  }
  return 'web'
}

function isReplayResult(outcome: ReplayCassetteOutcome): outcome is ReplayResult {
  return 'granularity' in outcome
}

// Read from the eval-core score for attribution, never computed here.
function scoreMatcherVersion(score: CassetteScore): number {
  if (score.kind === 'shape-mismatch') return score.matcherVersion
  const entries =
    score.kind === 'leaf' ? [score.entry] : score.kind === 'procedure' ? score.entries : []
  for (const entry of entries) {
    if (entry.kind === 'decision') return entry.score.matcherVersion
    if (entry.kind === 'never-scored') return entry.matcherVersion
  }
  // Unreachable through this composition: refusal outcomes are guarded before scoring, and every
  // extracted cassette carries at least one decision entry.
  throw new Error('cassette score carries no matcher-version stamp')
}

// Declared identity wins over the resolved id; a procedure reads its first decision's receipt.
function recordedReceiptModelId(cassette: Cassette): string | undefined {
  if (cassette.granularity === 'leaf') {
    return cassette.receipt.model.declared?.modelId ?? cassette.receipt.model.resolvedModelId
  }
  for (const step of cassette.steps) {
    if (step.kind === 'decision') {
      return (
        step.record.receipt.model.declared?.modelId ?? step.record.receipt.model.resolvedModelId
      )
    }
  }
  return undefined
}

// Joins each scored entry to its sidecar and replayed result; eval core computes the diff.
function decisionDiffs(
  cassette: Cassette,
  outcome: ReplayResult,
  score: CassetteScore,
): DecisionDiff[] {
  if (score.kind === 'leaf') {
    if (cassette.granularity !== 'leaf' || outcome.granularity !== 'leaf') return []
    const entry = score.entry
    if (entry.kind !== 'decision') return []
    return [
      buildDecisionDiff({
        cassetteId: cassette.id,
        decisionOrdinal: entry.decisionOrdinal,
        sidecar: cassette.sidecar,
        elements: cassette.input.stateBefore.elements,
        result: outcome,
        score: entry.score,
      }),
    ]
  }

  if (score.kind !== 'procedure') return []
  if (cassette.granularity !== 'procedure' || outcome.granularity !== 'procedure') return []
  const diffs: DecisionDiff[] = []
  for (const entry of score.entries) {
    if (entry.kind !== 'decision') continue
    const step = outcome.steps.find(
      candidate =>
        candidate.kind === 'decision' &&
        candidate.stepIndex === entry.stepIndex &&
        candidate.decisionOrdinal === entry.decisionOrdinal,
    )
    const record = cassette.steps.find(
      candidate =>
        candidate.kind === 'decision' &&
        candidate.stepIndex === entry.stepIndex &&
        candidate.decisionOrdinal === entry.decisionOrdinal,
    )
    if (step?.kind !== 'decision' || record?.kind !== 'decision') continue
    diffs.push(
      buildDecisionDiff({
        cassetteId: cassette.id,
        ...(entry.stepIndex === undefined ? {} : { stepIndex: entry.stepIndex }),
        decisionOrdinal: entry.decisionOrdinal,
        sidecar: record.record.sidecar,
        elements: record.record.input.stateBefore.elements,
        result: step.result,
        score: entry.score,
      }),
    )
  }
  return diffs
}

// The one model and runner composition in eval-local, optionally persisting the outcome.
export async function runCassetteReplay(
  input: RunCassetteReplayInput,
): Promise<ReplayCassetteOutcome> {
  // A fresh copy, because `createModel` mutates `profile.capabilities`.
  const profileCopy: ModelProfile = {
    ...input.profile,
    ...(input.profile.capabilities !== undefined
      ? { capabilities: { ...input.profile.capabilities } }
      : {}),
  }
  const capabilities = resolveCapabilities(profileCopy)

  // Model identity comes only from the caller profile; sampling pins temperature 0.
  const replayProfile: DeclaredModelProfile = {
    provider: input.profile.provider,
    modelId: input.profile.model,
    vision: capabilities.vision,
    maxOutputTokens: capabilities.maxOutput,
    sampling: { temperature: 0, ...(input.seed !== undefined ? { seed: input.seed } : {}) },
  }

  // The only `createModel` call and egress path; the handle is shared across samples.
  const model = createModel(profileCopy, input.auth, input.mask, input.modelOverrides ?? {}, input.modelCallObservation)
  const replayedModel = { provider: input.profile.provider, modelId: input.profile.model }

  const plannerFactory: ReplayPlannerFactory = {
    create({ platform, nonActionTools }): ReplayPlannerHandle {
      // Fresh accounting per sample so clamp/degrade + per-sample token cost stay attributable.
      const accounting = createTokenAccounting({
        getCapabilities: () => resolveCapabilities(profileCopy),
      })
      // A fresh unmodified `LLMPlanner` per sample; `nonActionTools` threads the exchange server.
      const planner = new LLMPlanner(
        model,
        platform,
        undefined,
        undefined,
        accounting,
        replayProfile,
        nonActionTools,
      )
      return {
        plan: (stepText, screenState, context) => planner.plan(stepText, screenState, context),
        model,
        replayedModel,
      }
    },
  }

  // The action slice a recorded exchange may never shadow, derived here so the engine stays pure.
  const actionToolNames: ReadonlySet<string> = new Set(
    Object.keys(buildTools(defaultRegistry, { platform: cassettePlatform(input.cassette) })),
  )

  // Host wall-clock behind the eval-core ReplayClock port (eval core bans host time APIs).
  const clock: ReplayClock = input.clock ?? { now: () => performance.now() }

  const engineInput: ReplayCassetteInput = {
    cassette: input.cassette,
    artifacts: input.artifacts,
    plannerFactory,
    actionToolNames,
    clock,
    ...(input.k !== undefined ? { k: input.k } : {}),
    escalationPredicate: input.escalationPredicate ?? neverEscalate,
  }

  const outcome: ReplayCassetteOutcome = await replayCassette(engineInput)

  if (input.recordStore !== undefined) {
    input.recordStore.save(outcome)
  }

  // The record store recreates the dir, so the one score write must land after it.
  if (input.scoreStore !== undefined && isReplayResult(outcome)) {
    const score = scoreCassetteReplay(input.cassette, outcome)

    // Eligibility is assessed once; an ineligible judge never binds, and each tie records why.
    const recordedModelId = recordedReceiptModelId(input.cassette)
    const declaration = input.judge
    const members = declaration !== undefined && 'members' in declaration ? declaration.members : undefined
    const single = members === undefined ? declaration as (JudgeDeclaration & { allowSameFamily?: boolean }) | undefined
      : members.length === 1 ? { ...members[0], allowSameFamily: declaration?.allowSameFamily } : undefined
    const panel = members !== undefined && members.length > 1 ? members : undefined
    const eligibilityInput = {
      replayedModelId: input.profile.model,
      ...(recordedModelId !== undefined ? { recordedModelId } : {}),
      ...(declaration?.allowSameFamily !== undefined
        ? { allowSameFamily: declaration.allowSameFamily }
        : {}),
    }
    const eligibility = panel === undefined
      ? assessJudgeEligibility({ ...eligibilityInput, judgeModelId: single?.profile.model })
      : assessPanelEligibility({ ...eligibilityInput, memberModelIds: panel.map(member => member.profile.model) })
    const observedBinding = (member: JudgeDeclaration): JudgeBindingInput => {
      const hooks = [...new Set([
        input.modelCallObservation?.onProviderCall,
        member.modelCallObservation?.onProviderCall,
      ].filter(hook => hook !== undefined))]
      return { ...member, mask: input.mask, modelCallObservation: { onProviderCall: () => {
        for (const hook of hooks) {
          try { hook() } catch { /* Observation cannot interrupt another counter or provider call. */ }
        }
      } } }
    }
    const port = !eligibility.eligible ? undefined : panel !== undefined
      ? bindJudgePanel(panel.map(observedBinding))
      : single === undefined ? undefined
      : bindJudgePort(observedBinding(single))

    // Adjudication runs even with no port, so every tie is stamped with its disposition.
    const adjudicated = await adjudicateCassetteScore({
      cassette: input.cassette,
      outcome,
      score,
      eligibility,
      ...(port !== undefined ? { port } : {}),
    })

    input.scoreStore.save({
      cassetteId: input.cassette.id,
      matcherVersion: scoreMatcherVersion(adjudicated.score),
      score: adjudicated.score,
      diffs: decisionDiffs(input.cassette, outcome, adjudicated.score),
      scoringContext: createScoringContext({ cassette: input.cassette, outcome, ...adjudicated,
        judgeRequest: replayJudgeRequest(input.judge) }),
      ...(adjudicated.judge !== undefined ? { judge: adjudicated.judge } : {}),
    })
  }

  return outcome
}
