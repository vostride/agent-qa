// The ONE sanctioned replay-composition helper (Phase 368, D-04/D-05/D-06). This is the single
// host binding that wires the pure eval-core replay engine to the production runner/model/safety
// stack — eval-local deliberately becomes the SECOND package (after cli) importing both `model`
// and `runner`, a contract-visible arch change recorded in ownership-contract.ts. Phase 372's
// CLI wraps exactly this function.
//
// Composition law (RPLY-02):
//   - `createModel` is the ONLY egress path and the ONLY call site here — every replayed prompt
//     rides its pinned-last mask/guardrail middleware (safety package tests enforce it). A FRESH
//     ModelProfile copy is built before the call because createModel mutates `profile.capabilities`
//     (RESEARCH Pitfall 8); the handle is shared across samples (RESEARCH A3).
//   - The replay planner runs at temperature 0 via the 366 sampling seam
//     (DeclaredModelProfile.sampling), with a FRESH createTokenAccounting + LLMPlanner per sample
//     (RESEARCH Pitfall 6) — the 368-01 `nonActionTools` ctor seam threads the recorded-exchange
//     server through unmodified production planner code.
//   - Model selection derives ONLY from the caller-supplied profile, never the recorded id (D-03):
//     recorded vs replayed ids are both stamped on the result, neither is enforced.
//   - Every model request is masked with the caller's declared mask (441 D-06).

import {
  adjudicateCassetteScore,
  assessJudgeEligibility,
  assessPanelEligibility,
  createPanelIdentity,
  buildDecisionDiff,
  computeReplayProfileFingerprint,
  createScoringContext,
  effectiveGold,
  neverEscalate,
  replayCassette,
  scoreCassetteReplay,
} from '@vostride/agent-qa-eval'
import type {
  ArtifactSource,
  Cassette,
  CassetteScore,
  DecisionDiff,
  DeclaredBriefDelta,
  ReplayCassetteInput,
  ReplayCassetteOutcome,
  ReplayClock,
  ReplayEscalationPredicate,
  ReplayPlannerFactory,
  ReplayPlannerHandle,
  ReplayResult,
  SeedPolicy,
  StandaloneLabelRecord,
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
  /** Authoritative score metadata; never included in replayCassette's planner inputs. */
  labelRecord?: StandaloneLabelRecord
  /** 417 D-01 / 415 D-05: already applied by the caller; the engine reverses it only before hashing. */
  declaredBriefDelta?: DeclaredBriefDelta
  /** Blob source for full-capture screenshot reconstruction (normally a DirArtifactSource). */
  artifacts: ArtifactSource
  /** The currently-configured model profile — the SOLE source of model selection (D-03). */
  profile: ModelProfile
  /** Resolved provider auth for the configured model. */
  auth: ResolvedModelAuth
  /** Optional provider overrides — the captured-boundary stub seam for tests (createModel passthrough). */
  modelOverrides?: ModelProviderOverrides
  /** Whole-run counter shared by planner and judge, including provider retries. */
  modelCallObservation?: ModelCallObservation
  /** Optional deterministic timing port for repeatable measurement fixtures. */
  clock?: ReplayClock
  /** Sample budget (D-10). Defaults to the engine's k=1. */
  k?: number
  /** Optional replay seed applied through the 366 sampling seam when the provider supports it. */
  seed?: number
  /** k-sample escalation seam (D-10). Defaults to the imported neverEscalate — never re-minted. */
  escalationPredicate?: ReplayEscalationPredicate
  /** Optional persistence: when supplied, the outcome is saved after the replay returns (D-12). */
  recordStore?: FsReplayRecordStore
  /**
   * Optional D-13 score persistence: when supplied and the outcome is a ReplayResult (refusals are
   * never scored — reports count them instead), the score + per-decision diffs are computed in
   * eval core and saved AFTER recordStore.save (record-then-score ordering, OQ-2).
   */
  scoreStore?: FsScoreStore
  /**
   * Optional D-06 tier-4 judge bag: an EXPLICIT second ModelProfile plus its auth and stub seam
   * (372's CLI surfaces it as config). No auto-pick from configured models, no fallback scanning —
   * absence is a first-class configuration, in which case every unresolved tie is stamped
   * not-invoked{no-judge-configured} whenever the score leg runs (D-05/D-10).
   * allowSameFamily (owner override of D-10, 2026-07-12): explicit default-off opt-in threaded
   * verbatim into assessJudgeEligibility — it lifts ONLY known-same-family refusal and stamps
   * the D-16 identity block with familyOverride; unknown families stay forbidden.
   */
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

/**
 * The matcher-constitution stamp already minted inside the eval-core score — read for the persisted
 * record's attribution field, never computed here (F9).
 */
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

/**
 * The recorded model identity from the cassette's reproducibility receipt — the D-14 recorded-side
 * eligibility input. Declared identity wins over the provider-resolved id; a procedure reads its
 * first decision record's receipt; absence is typed (the recorded side of the family check is then
 * skipped, D-14 "when resolvable").
 */
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

/**
 * Orchestrate eval core's buildDecisionDiff over every scored decision entry — joining each entry
 * back to its recorded sidecar/elements and its replayed decision result. Pure plumbing: the diff
 * content itself is computed entirely in eval core (F9).
 */
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

/**
 * Name the resolved temperature-zero replay profile without auth resolution or model creation.
 * D-11: keep these inputs aligned with the single createModel site below. Override names are
 * the injected provider identities; seed values and provider disclosures never enter the key.
 */
export function computeReplayProfileFingerprintFor(input: {
  profile: ModelProfile
  seedPolicy: SeedPolicy
  modelOverrides?: ModelProviderOverrides
}): string {
  const profileCopy: ModelProfile = {
    ...input.profile,
    ...(input.profile.capabilities !== undefined
      ? { capabilities: { ...input.profile.capabilities } }
      : {}),
  }
  const capabilities = resolveCapabilities(profileCopy)
  return computeReplayProfileFingerprint({
    provider: input.profile.provider,
    modelId: input.profile.model,
    temperature: 0,
    seedPolicy: input.seedPolicy,
    capabilities: {
      vision: capabilities.vision,
      ...(capabilities.maxOutput !== undefined ? { maxOutputTokens: capabilities.maxOutput } : {}),
    },
    modelOverrideKeys: Object.keys(input.modelOverrides?.languageModels ?? {}).sort(),
  })
}

/**
 * Run one loaded cassette through the pure replay engine bound to the production planner/model/
 * safety stack, optionally persisting the typed outcome. The one sanctioned model+runner
 * composition in eval-local (D-04).
 */
export async function runCassetteReplay(
  input: RunCassetteReplayInput,
): Promise<ReplayCassetteOutcome> {
  // Fresh ModelProfile copy: createModel mutates `profile.capabilities` (RESEARCH Pitfall 8), so
  // the caller's object is never touched and the one call site owns its own copy.
  const profileCopy: ModelProfile = {
    ...input.profile,
    ...(input.profile.capabilities !== undefined
      ? { capabilities: { ...input.profile.capabilities } }
      : {}),
  }
  const capabilities = resolveCapabilities(profileCopy)

  // Temp-0 declared profile via the 366 sampling seam — model identity comes ONLY from the caller
  // profile (D-03), sampling pins temperature 0 with an optional caller-supplied seed.
  const replayProfile: DeclaredModelProfile = {
    provider: input.profile.provider,
    modelId: input.profile.model,
    vision: capabilities.vision,
    maxOutputTokens: capabilities.maxOutput,
    sampling: { temperature: 0, ...(input.seed !== undefined ? { seed: input.seed } : {}) },
  }

  // The ONLY createModel call site and the ONLY egress path. The handle is shared across samples
  // (RESEARCH A3); per-sample freshness is confined to accounting + planner + exchange server.
  // D-11: computeReplayProfileFingerprintFor must read these same resolved profile values.
  const model = createModel(profileCopy, input.auth, input.mask, input.modelOverrides ?? {}, input.modelCallObservation)
  const replayedModel = { provider: input.profile.provider, modelId: input.profile.model }

  const plannerFactory: ReplayPlannerFactory = {
    create({ platform, nonActionTools }): ReplayPlannerHandle {
      // Fresh accounting per sample so clamp/degrade + per-sample token cost stay attributable.
      const accounting = createTokenAccounting({
        getCapabilities: () => resolveCapabilities(profileCopy),
      })
      // Fresh unmodified LLMPlanner per sample; the 368-01 nonActionTools ctor seam threads the
      // recorded-exchange server through the real bounded tool-loop.
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

  // The action slice a recorded exchange may never shadow (RESEARCH Open Q2): derived here in the
  // host from buildTools so the engine stays pure. plan() rebuilds the same slice internally.
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
    ...(input.declaredBriefDelta !== undefined ? { declaredBriefDelta: input.declaredBriefDelta } : {}),
    escalationPredicate: input.escalationPredicate ?? neverEscalate,
  }

  const outcome: ReplayCassetteOutcome = await replayCassette(engineInput)

  if (input.recordStore !== undefined) {
    input.recordStore.save(outcome)
  }

  // Write ordering is strict and load-bearing (OQ-2/D-05, Pitfall 2): recordStore.save → score
  // (sync, eval core) → adjudicate (async) → diffs over the FINAL score →
  // exactly ONE scoreStore.save. The record store recreates the cassette dir in full (rm + mkdir),
  // so the file-scoped score write MUST land after it — never before — or a re-run would wipe the
  // fresh score.json. Refusals save a record but never a score (they are counted in reports
  // instead). Score, adjudication, and diffs are computed in eval core (F9); this composition
  // only orchestrates and saves.
  if (input.scoreStore !== undefined && isReplayResult(outcome)) {
    const score = scoreCassetteReplay(input.cassette, outcome, input.labelRecord)
    const effective = input.cassette.granularity === 'leaf' ? effectiveGold(input.cassette, input.labelRecord) : undefined
    const scoringCassette = effective?.kind === 'eligible' ? effective.cassette : input.cassette

    // D-12/D-14 two-sided family eligibility, assessed ONCE at composition time against BOTH the
    // replayed profile's model and the cassette receipt's recorded identity. Ineligible ⇒ the
    // judge port never binds and the batch proceeds deterministically (soft-but-loud: the refusal
    // is data on every tie's stamp, never a thrown error).
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

    // Adjudication runs UNCONDITIONALLY so every tie is stamped with its disposition even when
    // no port exists (D-06/D-10/D-12); the pure scoreCassetteReplay output itself stays untouched.
    const adjudicated = await adjudicateCassetteScore({
      cassette: scoringCassette,
      outcome,
      score,
      eligibility,
      ...(port !== undefined ? { port } : {}),
    })

    input.scoreStore.save({
      cassetteId: input.cassette.id,
      matcherVersion: scoreMatcherVersion(adjudicated.score),
      score: adjudicated.score,
      diffs: decisionDiffs(scoringCassette, outcome, adjudicated.score),
      scoringContext: createScoringContext({ cassette: input.cassette, outcome, labelRecord: input.labelRecord,
        ...adjudicated, judgeRequest: replayJudgeRequest(input.judge) }),
      ...(adjudicated.judge !== undefined ? { judge: adjudicated.judge } : {}),
    })
  }

  return outcome
}
