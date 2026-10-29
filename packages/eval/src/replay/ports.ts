// D-04 replay ports. CRITICAL: eval core stays pure — runner symbols are imported as TYPES
// ONLY, never as values, so no runner runtime crosses into this neutral package. The concrete
// implementations (the production LLMPlanner wrapper, the monotonic clock) live in eval-local;
// this module only declares the seams the replay engine consumes.

import type { NonActionToolMap, PlanResult, StepContext } from '@vostride/agent-qa-runner'
import type { ScreenState } from '@vostride/agent-qa-schema'
import type { CassetteReceipt } from '../cassette/receipt-leg'
import type { CassetteSidecarLeg } from '../cassette/sidecar-leg'
import type { ReplaySample } from './result'

/**
 * A per-sample planner handle wrapping a production LLMPlanner constructed for one sample.
 * `model` is the underlying language-model handle (indexed off StepContext to avoid importing
 * the provider SDK here); `replayedModel` feeds the D-03 replayed-model id stamp on the result.
 */
export interface ReplayPlannerHandle {
  plan(stepText: string, screenState: ScreenState, context: StepContext): Promise<PlanResult>
  model: StepContext['plannerModel']
  replayedModel: { provider: string; modelId: string }
}

/**
 * The planner-factory port. `create` is called once PER SAMPLE so consume-once exchange budgets
 * and token accounting stay per-sample (RESEARCH Pitfall 6). The eval-local composition helper
 * implements it.
 */
export interface ReplayPlannerFactory {
  create(input: {
    platform: ScreenState['platform']
    nonActionTools: NonActionToolMap
  }): ReplayPlannerHandle
}

/** Per-decision recorded context supplied to the ONE escalation seam (369 F1 / D-10). */
export interface ReplayEscalationContext {
  /** Cassette owning the replayed decision (369 F1). */
  cassetteId: string
  /** Live-decision position within the recorded step (369 F1). */
  decisionOrdinal: number
  /** Procedure-step position; structurally absent for leaf cassettes (369 F1). */
  stepIndex?: number
  /** This decision's own gold sidecar — never another procedure step's leg (369 F1). */
  sidecar: CassetteSidecarLeg
  /** This decision's reproducibility receipt (369 F1). */
  receipt: CassetteReceipt
}

/**
 * The ONE escalation seam: score the first sample against its positional decision
 * context, then decide whether to run more samples. Phase 369 binds tiers-settle and Phase 370
 * binds judge escalation onto this same breaking-signature seam; the legacy signature is removed.
 */
export type ReplayEscalationPredicate = (
  firstSample: ReplaySample,
  context: ReplayEscalationContext,
) => boolean

/** The built-in default under the evolved seam: still never spend beyond the first sample. */
export const neverEscalate: ReplayEscalationPredicate = () => false

/**
 * Monotonic millisecond time source — the ONLY time source eval core may use (the
 * module-discipline test bans wall-clock functions). Implemented in eval-local.
 */
export interface ReplayClock {
  now(): number
}
