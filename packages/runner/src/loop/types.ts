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
 * A planned action plus its plan envelope, produced by the tool registry.
 */
export interface ActionPlan {
  reasoning: string
  action: { type: string; [key: string]: unknown }
  confidence: number
  stepComplete: boolean
  stepFailed?: boolean
  // The in-turn gate's attempt trail; absent when no grounding callback ran or recorded nothing.
  groundingAttempts?: GroundingAttempt[]
  // The element the planner meant per element lane, judged before dispatch.
  statedTargets?: StatedTargets
  // Facts the planner captured this turn via `remember[]`, for the run-scoped store.
  remember?: WorkingMemoryEntry[]
  // Declared on a do-X-to-all step and restated each turn; the verifier backstops.
  bulkCompletionPredicate?: string
  // Declares the step infeasible, unlike a plain `stepFailed`; absent for an ordinary failure.
  failureKind?: 'infeasible'
  // Required whenever `failureKind` is set, and recorded verbatim in the termination block.
  failureReason?: string
}

// Debits one planner model call before it is made; false refuses the call.
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
  // Absent for cache-replay results, which have no live planning turn.
  exchanges?: ToolExchangeEvidence[]
  // Absent when the provider exposes no call record or no live model call occurred.
  callRecord?: ModelCallRecord
}

/** One condition as the verifier judged it; the runner decides what it counts for. */
export interface ConditionJudgment {
  quote: string
  verdict: ConditionVerdict
  needs: 'none' | ConditionNeed
  controlRef: string
  file: { name: string; match: 'none' | 'exact' | 'lines'; text: string }
  citations: { source: CitationSource; quote: string }[]
  reasoning: string
}

/** An open dialog as the verifier accounted for it. */
export interface DialogAccount {
  name: string
  account: 'bears-on-condition' | 'requested' | 'unrelated'
  reasoning: string
}

// No overall success: the runner computes the pass; `verifierError` marks a failed model call.
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
  // Stamped verbatim onto `StepEvidence.interpolatedVariables`; masking would break exact matches.
  interpolatedVariables?: readonly InterpolatedVariable[]
  // A directly supplied learned brief; reader-backed runs use the structured fields below.
  knowledgeBrief?: string
  // Authored policy, kept apart from learned spans so only it enters the cached prefix.
  knowledgePolicyL0?: string
  // Learned caution summaries rendered under the volatile hypotheses frame.
  knowledgeBriefL1?: string
  // Learned procedure and high-trust-fact summaries rendered in the volatile tier.
  knowledgeBriefL2?: string
  // The reader's clipping signal; empty means no signal is rendered.
  knowledgeBriefTruncation?: string
  // UTC date for prompt evidence, captured once per step as `YYYY-MM-DD`.
  promptDate?: string
  // Injected verbatim as its own turn message; empty means the message is omitted.
  workingMemory?: WorkingMemoryEntry[]
  // Restated each turn while a do-X-to-all loop runs; absent for other steps.
  bulkCompletionPredicate?: string
  failureContext?: string
  // Outcomes decide; screen change is not recorded here.
  subActionHistory?: { action: string; reasoning?: string; result: 'success' | 'failure' | 'no-input'; error?: string; verifierRejection?: string; data?: string; evidence?: string }[]
  plannerConfig?: PlannerConfig
  // The step's planning-call meter, bound by the loop before each `plan()` call.
  planningCallGate?: PlanningCallGate
  screenshot?: Buffer
  // Non-empty only for text-only models; injected into the planner prompt when present.
  promptNote?: string
  // A re-run carries full context plus the run-level flag and the prior failure summary.
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

// Kept in the runner vocabulary so the asserter imports only runner-local modules.
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
