import type { Action } from '../action/index'
import type { ServedRetrievalTraceV1 } from '../brief/retrieval-trace'
import type { RecordedRetrievalRung } from '../brief/retrieval-rung'
import type { ServedBrief } from '../brief/served-brief'
import type { RecordId } from '../ids/record-id'
import type { WorkingMemoryEntry } from '../memory/working-memory-entry'
import type { RecordedActionResult } from '../result/index'
import type { ConditionVerdictsEvidence } from './condition-evidence'
import type { LimitStopEvidence, StepLimitUsage } from './limit-evidence'
import type { DeclaredModelProfile, ModelIdentity } from './model-call-profile'
import type { OperationCaptureAvailability } from './operation-evidence'
import type { CycleEvidence, StagnationEvidence } from './progress-evidence'
import type { SubActionEvidence } from './sub-action-evidence'
import type { PlanningFailureEvidence } from './tool-exchange'
import type {
  AiJudgmentEvidence,
  AssertValueEvidence,
  ReportedValueEvidence,
  TerminationEvidence,
  VerdictSource,
} from './verb-evidence'

export interface VerifierVerdict {
  pass: boolean
  reasoning: string
}

// `procedure-replay` actions came from a guarded replay; `procedure-hint` was served, not replayed.
export type StepPlanSource =
  | {
      kind: 'procedure-replay'
      procedureId: RecordId
      guard: {
        // Ranges over this step's attempted actions only; the cross-flow position lives in `flow`.
        checksPassed: number
        total: number
        miss?: {
          procedureStepIndex: number
          reason:
            | 'descriptor-ambiguous'
            | 'descriptor-missing'
            | 'page-anchor-mismatch'
            | 'gate-refused'
            // A bind-time availability gap, distinct from an invalid action shape.
            | 'parameter-unbound'
            | 'non-replayable-action'
        }
        /**
         * The adapter failed after this stored action passed the full replay guard. This is
         * execution evidence, not a staleness signal, and it blocks positive procedure
         * attribution even if a later live-planned recovery makes the step verdict pass.
         */
        executionFailure?: {
          procedureStepIndex: number
        }
        /**
         * The stored action executed after passing its replay guards, but the verifier rejected
         * its result. This blocks positive procedure attribution even when live-planned recovery
         * later makes the step verdict pass; attributable rejection is negative evidence.
         */
        verifierRejection?: {
          procedureStepIndex: number
        }
      }
      // `cursor` is the body-step index this step attempted and `length` the body's step count.
      flow?: {
        cursor: number
        length: number
      }
    }
  | {
      kind: 'procedure-hint'
      procedureId: RecordId
      // Only on a demoted replay, which then never looks like an ordinary hint; keep it closed.
      demotion?: 'body-unreadable' | 'body-unparseable' | 'body-empty'
    }

// The stored target matched no element strictly, matched several, or cannot replay at all.
export type CacheMissReason = 'strict-absent' | 'strict-not-unique' | 'non-replayable'

export interface Decision {
  plan: string
  plannedAction: Action
  result: RecordedActionResult
}

// Interpolation runs before planning, so this pair is the only record of the bound name.
export interface InterpolatedVariable {
  name: string
  value: string
}

export interface StepEvidence {
  stepIndex: number
  stepText: string
  /** `disabled` means no cache was bound for the step's test. */
  cacheStatus: 'hit' | 'miss' | 'bypass' | 'disabled'
  /**
   * The first cache key hit in this step whose stored target was not the only strict match, or
   * could not replay. Present only when `cacheStatus` is 'miss'.
   */
  cacheMiss?: { reason: CacheMissReason }
  servedBrief: ServedBrief
  // Planner input recorded beside the brief, never a `ServedBrief` channel; entries are masked.
  workingMemory?: WorkingMemoryEntry[]
  // Beside `servedBrief`: a trace inside it would change every brief digest and its cassettes.
  retrievalTrace?: ServedRetrievalTraceV1
  // Run-constant: the rung the host was on for this run, folded once in knowledge-local.
  retrievalRung?: RecordedRetrievalRung
  // Optional only for port-less harnesses; every real run records it.
  modelProfile?: DeclaredModelProfile
  // Its own receipt component, because tool surface and model identity attribute independently.
  toolSchemaDigest?: string
  subActions: SubActionEvidence[]
  verifierVerdict: VerifierVerdict
  // Recorded beside the verdict so the widely built `VerifierVerdict` value stays unchanged.
  verifierIdentity?: ModelIdentity
  conditionVerdicts?: ConditionVerdictsEvidence
  planningFailure?: PlanningFailureEvidence
  stagnation?: StagnationEvidence
  cycle?: CycleEvidence
  selfHeal?: {
    failedDecision: Decision
    recoveringDecision: Decision
  }
  // Present when the step reported a value; masked before it is recorded.
  reportedValue?: ReportedValueEvidence
  // Set when a turn declared the step infeasible; distinct from a plain `stepFailed`.
  termination?: TerminationEvidence
  /** The typed limit stop; present only when a per-step limit refused a dispatch. */
  limitStop?: LimitStopEvidence
  /** The configured per-step limits and what this step used against them. */
  limitUsage?: StepLimitUsage
  /** Whether this step's platform could capture downloads and clipboard writes at all. */
  operationCapture?: OperationCaptureAvailability
  /**
   * Present when the step ran assertAI or extractAI through the verifier's model lane: the
   * verdict and rationale, or why the model could not judge or extract.
   */
  aiJudgment?: AiJudgmentEvidence
  // Present when a deterministic `assertValue` comparison ran; masked before it is recorded.
  assertOutcome?: AssertValueEvidence
  verdictSource?: VerdictSource
  // Kept apart from `cacheStatus` so cassette readers of cached semantics never see it.
  planSource?: StepPlanSource
  // Not masked: the values sit unmasked in `stepText`, and masking breaks the exact-match fold.
  interpolatedVariables?: InterpolatedVariable[]
}
