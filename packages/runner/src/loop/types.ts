// Re-derived loop type vocabulary for the runner-owned step-execution spine (D-02).
// CRITICAL: provider-neutral + storage-neutral. No node:* imports, no fs/sharp,
// no core/model/adapter package imports. Types only — from @vostride/agent-qa-schema,
// the sibling runner modules, and the neutral orchestration SDK (`ai`, D-04).
// Re-derived from v1 core/src/agent/types.ts; the v1 healing config type and the
// per-step attempt-limit fields are D-10 deletion targets and are intentionally
// absent here.

import type { LanguageModel } from 'ai'
import type {
  CitationSource,
  ConditionNeed,
  ConditionVerdict,
  GroundingAttempt,
  InterpolatedVariable,
  ModelCallRecord,
  OperationEvidence,
  ScreenState,
  ToolExchangeEvidence,
  WorkingMemoryEntry,
} from '@vostride/agent-qa-schema'
import type { Action } from '../platform.js'
import type { TokenUsage } from '../result.js'
import type { StatedTargets } from '../grounding/stated-target.js'
import type { VerifierStepRecord } from './step-record.js'

/**
 * A planned action plus the frozen v45 plan envelope (D-09). Structural mirror of
 * core's ActionPlanSchema output; the v45 tool registry (this plan, task 3) produces it.
 */
export interface ActionPlan {
  reasoning: string
  action: { type: string; [key: string]: unknown }
  confidence: number
  stepComplete: boolean
  stepFailed?: boolean
  /**
   * D-09/GROUND-01 grounding-attempts carriage. When the planning turn grounds the
   * action in-turn (via the injected groundability callback), the gate's §A8
   * GroundingAttempt trail rides here so the resolved-descriptor evidence reaches
   * executeStep (threaded onto StepEvidence in Plan 07). Absent when no grounding
   * callback is injected or the gate recorded no attempts.
   */
  groundingAttempts?: GroundingAttempt[]
  /** D-01: the element the planner meant per element lane, judged before dispatch. */
  statedTargets?: StatedTargets
  /**
   * WM-01 write channel (spec §12.15, ratified 2026-07-05). Verbatim facts the planner captured
   * this turn via the `remember[]` plan-field; the loop hands them to the run-scoped
   * `WorkingMemoryStore` (Plan 08 wiring). Absent when the planner captured nothing this turn.
   */
  remember?: WorkingMemoryEntry[]
  /**
   * D-09 bulk-loop completion predicate. On a "do X to all" step the planner declares the positive
   * completion predicate here and re-states it each turn; the verifier backstops. Absent for
   * non-bulk steps.
   */
  bulkCompletionPredicate?: string
  /**
   * D-04 infeasible terminal outcome (EXEC-05, spec §12.10). The additive plan-field envelope
   * (358 remember[] precedent) by which a turn declares the step terminally infeasible — the
   * requested capability/screen does not exist in this build. Closed literal union ('infeasible'
   * today, extensible later); machine-distinguishable from a plain `stepFailed`. When set, the
   * loop routes it into a typed StepEvidence.termination block and a distinct verdict outcome
   * (Plan 10 seam). Absent for an ordinary failure.
   */
  failureKind?: 'infeasible'
  /**
   * D-04 infeasible reason — required whenever `failureKind` is set (enforced at the
   * toolCallToActionPlan parse boundary). The human-readable why, recorded verbatim in the
   * termination evidence block. Absent unless `failureKind` is present.
   */
  failureReason?: string
}

/** 436 D-08: debits one planner model call before it is made; false refuses the call. */
export interface PlanningCallGate {
  tryDebitPlanningCall(): boolean
}

export interface PlannerConfig {
  maxActions: number
  maxPlanningTurns: number
  previousStepCount: number
}

export interface PlanResult {
  plan: ActionPlan
  tokenUsage?: TokenUsage
  /**
   * Ordered non-action exchanges from this live planning decision (D-01).
   * Absent for cache-replay-produced results, which have no live planning turn.
   */
  exchanges?: ToolExchangeEvidence[]
  /**
   * Observed final-response metadata for this live planning decision (D-05/D-08).
   * Absent when the provider exposes no call record or no live model call occurred.
   */
  callRecord?: ModelCallRecord
}

/** One condition as the verifier judged it (439 D-02, D-10); the runner decides what it counts for. */
export interface ConditionJudgment {
  quote: string
  verdict: ConditionVerdict
  needs: 'none' | ConditionNeed
  controlRef: string
  file: { name: string; match: 'none' | 'exact' | 'lines'; text: string }
  citations: { source: CitationSource; quote: string }[]
  reasoning: string
}

/** An open dialog as the verifier accounted for it (439 D-16). */
export interface DialogAccount {
  name: string
  account: 'bears-on-condition' | 'requested' | 'unrelated'
  reasoning: string
}

/**
 * The verifier's per-condition output. There is no overall success: the runner computes the pass
 * (439 D-10). `verifierError` is set only by the fallback when the model call failed.
 */
export interface VerificationResult {
  conditions: ConditionJudgment[]
  dialogs: DialogAccount[]
  isAppError: boolean
  reasoning: string
  verifierError?: string
}

export interface VerifyResult {
  verification: VerificationResult
  tokenUsage?: TokenUsage
}

export interface StepContext {
  stepInstruction: string
  testName: string
  testContext?: string
  suiteContext?: string
  stepNumber?: number
  stepCount?: number
  previousSteps: { instruction: string; outcome: string; reasoning?: string; plannedAction?: string; verifierResponse?: string }[]
  contextWindow?: number
  plannerModel: LanguageModel
  verifierModel: LanguageModel
  modelId?: string
  variables?: Record<string, string>
  /**
   * The `{{env:NAME}}` bindings that interpolated into `stepInstruction` before this step
   * was planned (PROC-01 · 381 D-03/D-08). DESTINATION: stamped verbatim onto
   * `StepEvidence.interpolatedVariables` at finalize, where the procedure-extraction emit
   * fold reads it to classify a trajectory value slot back to its source binding NAME.
   *
   * Carried VERBATIM end to end — never masked (unlike `variables` above, which is
   * secret-redacted for the planner). See the masking prohibition documented on
   * `StepEvidence.interpolatedVariables`: masking would break the consumer's exact-match
   * classification for email-valued and credential-named bindings.
   *
   * Absent/empty when the step's text interpolated nothing — finalize then stamps nothing.
   */
  interpolatedVariables?: readonly InterpolatedVariable[]
  /**
   * D-12/D-13 compatibility slot for a directly supplied learned brief. Reader-backed runs use
   * the structured L1/L2/truncation fields below; buildVolatileTier applies the same hypotheses
   * frame to either source. Empty/undefined omits the learned section entirely.
   */
  knowledgeBrief?: string
  /**
   * BRIF-01 human-authored/sovereign L0 policy material. It is isolated from learned spans so
   * buildContextTier can keep only this byte-stable material in the cached-prefix region.
   */
  knowledgePolicyL0?: string
  /** BRIF-01 learned caution summaries rendered under the volatile hypotheses frame. */
  knowledgeBriefL1?: string
  /** BRIF-01 learned procedure/high-trust-fact summaries rendered in the volatile tier. */
  knowledgeBriefL2?: string
  /** BRIF-01 reader-provided clipping signal; empty/undefined means no signal is rendered. */
  knowledgeBriefTruncation?: string
  /**
   * CR-08 immutable UTC date for planner prompt evidence, captured once per step as
   * `YYYY-MM-DD`. When absent, direct legacy prompt-builder callers retain the current
   * UTC-date fallback. Bound values cross this type unchanged; the production capture
   * boundary validates the closed date form before persistence.
   */
  promptDate?: string
  /**
   * D-12/D-13 working-memory channel (structured turn content). The run-scoped
   * `WorkingMemoryStore` set, injected verbatim as its own turn message by `composeTurnMessages`
   * — the second v2 channel replacing the retired single memory-context string. Phase 358
   * SANCTIONED BREAK (D-12/D-13): this was a plain `string` slot; it is now `WorkingMemoryEntry[]`
   * (no shim, no string overload) so the planner receives the structured verbatim set. Empty
   * array/undefined ⇒ omitted from the turn entirely (empty-slot omission).
   */
  workingMemory?: WorkingMemoryEntry[]
  /**
   * D-09 active bulk-completion predicate (per-turn VOLATILE turn content). While a bulk
   * "do X to all" loop is running, the planner's declared positive predicate is re-stated each
   * turn with the re-evaluate/cite-positive-evidence instruction. Absent for non-bulk steps.
   */
  bulkCompletionPredicate?: string
  failureContext?: string
  /**
   * Sub-actions already attempted in this step (multi-action mode), with each outcome and any
   * returned data. Screen change is not recorded here: outcomes decide (HARN-01).
   */
  subActionHistory?: { action: string; reasoning?: string; result: 'success' | 'failure' | 'no-input'; error?: string; verifierRejection?: string; data?: string; evidence?: string }[]
  plannerConfig?: PlannerConfig
  /** 436 D-08: the step's planning-call meter, bound by the loop before each plan() call. */
  planningCallGate?: PlanningCallGate
  screenshot?: Buffer
  /**
   * Vision-gate prompt note for this run (D-11). Non-empty only for text-only
   * models; injected into the planner prompt when present.
   */
  promptNote?: string
  /**
   * D-13 re-run-after-failure context (LOOP-03). A re-run carries everything (full
   * memory/context, no ablation) plus an explicit run-level flag and the prior
   * attempt's failure summary, surfaced to the planner as prompt context.
   */
  isRerun?: boolean
  rerunAttempt?: number
  previousFailureSummary?: string
}

export interface Planner {
  plan(step: string, screenState: ScreenState, context: StepContext, abortSignal?: AbortSignal): Promise<PlanResult>
}

export interface VerifierAuthorContext {
  suiteContext?: string
  testContext?: string
  stepNumber?: number
  stepCount?: number
}

export type AiJudgment =
  | { outcome: 'judged'; verdict: boolean; rationale: string }
  | { outcome: 'unresolved'; reason: string }

export type AssertAiMode = Extract<Action, { type: 'assertAI' }>['mode']

export const VISUAL_CLAIM_WITHOUT_SCREENSHOT = 'no screenshot to judge a visual claim'

export type ExtractField = Extract<Action, { type: 'extractAI' }>['schema'][number]

export type AiExtraction =
  | { outcome: 'extracted'; fields: Record<string, unknown> }
  | { outcome: 'unresolved'; reason: string }

export interface Verifier {
  verify(step: string, before: ScreenState, after: ScreenState, action: Action, screenshot?: Buffer, abortSignal?: AbortSignal, promptNote?: string, bulkCompletionPredicate?: string, authorContext?: VerifierAuthorContext, operationEvidence?: OperationEvidence, record?: VerifierStepRecord): Promise<VerifyResult>
  /**
   * One structured judgment of the claim over the current observation. Returns the verdict and
   * rationale, or unresolved with the reason when the model call failed or its answer was not a
   * valid verdict. An abort rethrows.
   * multimodal judges from the screen text, plus the screenshot when there is one.
   * visual judges from the screen text and the screenshot, and is unresolved without a call when
   * there is no screenshot.
   * text judges from the screen text only and never sends the screenshot.
   */
  judgeClaim?(
    claim: string,
    screen: ScreenState,
    opts: { mode: AssertAiMode; screenshot?: Buffer; abortSignal?: AbortSignal },
  ): Promise<AiJudgment>
  /**
   * One structured extraction of the declared fields over the current observation. Returns the
   * fields, or unresolved with the reason when the model call failed or its answer did not match
   * the declared fields. An abort rethrows.
   */
  extractData?(
    query: string,
    screen: ScreenState,
    opts: { fields: readonly ExtractField[]; screenshot?: Buffer; abortSignal?: AbortSignal },
  ): Promise<AiExtraction>
}

// Assertion vocabulary (re-derived from v1 core/src/agent/types.ts). The asserter
// and buildAssertionPrompt (this plan, 353-03) are the sole consumers; kept in the
// runner loop vocabulary so asserter.ts imports resolve to runner-local modules only.
export type AssertionType = 'text-presence' | 'element-visibility' | 'url-match' | 'element-count' | 'ai'

export interface AssertionInput {
  type: AssertionType
  value: string
  expected?: string
}

export interface AssertionResult {
  passed: boolean
  assertionType: AssertionType
  expected: string
  actual: string
  reasoning: string
}

export interface Asserter {
  evaluate(assertion: AssertionInput, screenState: ScreenState): Promise<AssertionResult>
}

// Extraction vocabulary (Phase 363 D-07) — the runner owns the full capture surface:
// buildExtractionPrompt (prompts.ts), the ExplicitExtractor + createExtractor factory
// (variables/extractor.ts), and the LLMVariableExtractor (loop/llm-variable-extractor.ts).
export type ExtractionMethod = 'regex' | 'selector' | 'ai'

export interface ExtractorInput {
  method: ExtractionMethod
  variableName: string
  pattern?: string
  selector?: string
  description?: string
}

export interface CaptureResult {
  success: boolean
  variableName: string
  value?: string
  reasoning: string
}

export interface VariableExtractor {
  extract(input: ExtractorInput, screenState: ScreenState): Promise<CaptureResult>
}
