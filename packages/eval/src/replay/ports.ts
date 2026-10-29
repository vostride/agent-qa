// Runner symbols are imported as types only, so no runner runtime crosses into this package.

import type { NonActionToolMap, PlanResult, StepContext } from '@vostride/agent-qa-runner'
import type { ScreenState } from '@vostride/agent-qa-schema'
import type { CassetteReceipt } from '../cassette/receipt-leg'
import type { CassetteSidecarLeg } from '../cassette/sidecar-leg'
import type { ReplaySample } from './result'

// `model` is indexed off `StepContext` so this package never imports the provider SDK.
export interface ReplayPlannerHandle {
  plan(stepText: string, screenState: ScreenState, context: StepContext): Promise<PlanResult>
  model: StepContext['plannerModel']
  replayedModel: { provider: string; modelId: string }
}

// `create` runs once per sample so consume-once exchange budgets and token counts stay per sample.
export interface ReplayPlannerFactory {
  create(input: {
    platform: ScreenState['platform']
    nonActionTools: NonActionToolMap
  }): ReplayPlannerHandle
}

// Per-decision recorded context supplied to the escalation seam.
export interface ReplayEscalationContext {
  /** Cassette owning the replayed decision. */
  cassetteId: string
  /** Live-decision position within the recorded step. */
  decisionOrdinal: number
  /** Procedure-step position; structurally absent for leaf cassettes. */
  stepIndex?: number
  /** This decision's own gold sidecar, never another procedure step's leg. */
  sidecar: CassetteSidecarLeg
  /** This decision's reproducibility receipt. */
  receipt: CassetteReceipt
}

// Scores the first sample against its decision context, then decides whether to sample more.
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
