// Type-only and storage-neutral; the one exported value bounds the post-verdict port.

import type {
  PostProcessingDisposition,
  RunEventEnvelope,
  RunId,
  RunStatus,
  ScopeKey,
  ExecutionContext,
  CompletedRunHandoff,
  HookStartedPayload,
  HookFinishedPayload,
  DeclaredModelProfile,
  ModelIdentity,
  QuarantineAppliedEntry,
  PlannerLimitsRecord,
  TestRetryScheduledPayload,
  RunArtifactStageInput,
  RunArtifactFinalizeInput,
} from '@vostride/agent-qa-schema'
import type { TestResult } from '../result.js'
import type { EvidenceArtifactStorePort, LoopEventEmitPort, SecretRedactorPort } from '../loop/ports.js'
import type { HookDefinition, HookResult } from '../hooks/types.js'
import type { LiveStreamCapability, RuntimeAuthStateConfig } from '../platform.js'
import type { LanguageModel } from 'ai'
import type { Planner, Verifier } from '../loop/types.js'

/** Structurally compatible with model-owner reports; no provider implementation dependency. */
export interface StepModelCallReport {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  respondingModelId?: string
}
export type StepModelCallEvent =
  | { kind: 'start' }
  | { kind: 'success'; report: StepModelCallReport }
  | { kind: 'failure' }
export interface StepModelObservation { onCall(event: StepModelCallEvent): void }
export interface StepModelScopeKey { runId: RunId; testIndex: number; stepIndex: number }
export interface StepModelRoleFacts {
  declared?: ModelIdentity
  respondingModelIds: string[]
}
export interface StepModelAttempt {
  invocation: number
  role: 'planner' | 'verifier'
  kind: StepModelCallEvent['kind']
  report?: StepModelCallReport
}
export interface StepModelSnapshot extends StepModelScopeKey {
  attempts: StepModelAttempt[]
  started: number
  succeeded: number
  failed: number
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  roles: { planner: StepModelRoleFacts; verifier: StepModelRoleFacts }
}
export interface StepModelConsumers {
  planner: Planner
  verifier?: Verifier
  plannerModel: LanguageModel
  verifierModel: LanguageModel
}
export interface StepModelScope extends StepModelConsumers {
  readonly key: StepModelScopeKey
  snapshot(): StepModelSnapshot
  /** Freeze after extraction, before terminal publication. Pending attempts remain uncovered. */
  finish(): StepModelSnapshot
  /** Called only after the final event; retained callbacks cannot affect another step. */
  dispose(): void
}
export type StepModelScopeFactory = (key: StepModelScopeKey) => StepModelScope

export interface StepModelBinding {
  /** Resolved handle supplies metadata; it is never mutated or double-wrapped. */
  model: Exclude<LanguageModel, string>
  /**
   * Bind a fresh observer for ONE SDK invocation. Reuse host conversation/accounting state,
   * but never a model bound to another observer. Model-owner middleware emits every actual
   * retry start/terminal; the runner must not synthesize dispatches around generateText.
   */
  bind(observation: StepModelObservation): LanguageModel
}
export interface StepModelScopeOptions {
  key: StepModelScopeKey
  models: { planner: StepModelBinding; verifier: StepModelBinding }
  profiles?: { planner: ModelIdentity; verifier?: ModelIdentity }
  mask(text: string): string
  createConsumers(models: Pick<StepModelConsumers, 'plannerModel' | 'verifierModel'>):
    Pick<StepModelConsumers, 'planner' | 'verifier'>
}

// Computed once at the CLI root and carried verbatim, so run and handoff identity cannot fork.
export interface ConfigDigests {
  suiteConfigDigest: string
  testConfigDigest: string
}

// One GET at the CLI root; every probe failure arrives as a value and never aborts the run.
export interface BaselineProbeResult {
  status?: number
  elapsedMs: number
  error?: string
}

// Both legs are sync and fire-and-forget; an append throw degrades the bus to memory-only.
export interface EventLogPort {
  append(envelope: RunEventEnvelope): void
  read(fromSeq: number): RunEventEnvelope[]
}

// Secret values also filter hook output variables; sandbox redaction stays inside the impl.
export interface HookExecuteOptions {
  env: Record<string, string>
  secretEnv: Record<string, string>
  secretRedactor?: SecretRedactorPort
  authState?: RuntimeAuthStateConfig
}

// A per-hook timeout resolves a failed result, never a throw; fail-fast skips rely on it.
export interface HookExecutorPort {
  execute(hook: HookDefinition, opts: HookExecuteOptions): Promise<HookResult>
}

// Sync persist of the one handoff at run end; a failure warns and never gates the verdict.
export interface HandoffStorePort {
  save(handoff: CompletedRunHandoff): void
}

// Markers come from the assembled RunConfig, never ambient state; absent stays absent.
export interface PostVerdictStepInput {
  readonly runId: RunId
  readonly verdict: RunStatus
  readonly gateRun?: true
  readonly excludedFromOutcomes?: true
}

// When the consult cannot decide, `detached` plus a named `runWarning` carries the cause.
export interface PostVerdictOutcome {
  readonly disposition: PostProcessingDisposition
  readonly warning?: { readonly code: string; readonly message: string }
}

// The host owns the lease; a throw, overrun or absent port yields `detached` and a named warning.
export interface PostVerdictPort {
  run(input: PostVerdictStepInput): Promise<PostVerdictOutcome>
}

// A busy enqueue can stall, and without this bound `runFinished` and `done` slide behind it.
export const POST_VERDICT_STEP_BUDGET_MS = 5_000

// Sync and fire-and-forget; a staged artifact survives a crash because finalize merges later.
export interface RunArtifactStorePort {
  stage(document: RunArtifactStageInput): void
  finalize(patch: RunArtifactFinalizeInput): void
}

/**
 * Injectable timer seam for the bus heartbeat, the frame hub's bounds and the post-verdict bound.
 * `schedule(delayMs, fn)` arms a one-shot and returns a cancel handle; `now()` supplies the
 * envelope `ts`. The default impl wraps global setTimeout/clearTimeout (unref'd so it never
 * keeps the process alive); unit pins inject a deterministic fake — no real timers, no watch
 * mode.
 */
export interface RunTimerPort {
  schedule(delayMs: number, fn: () => void): () => void
  now(): number
}

// A failed member skips the rest of its `failFastGroup`; the shell derives the index itself.
export interface RunMemberDescriptor {
  testId: string
  testIndex?: number
  name: string
  failFastGroup?: string
  // Checkout-independent identity, because the committed quarantine ledger matches it with `===`.
  filePath: string
  // Optional parity fields for reporters; absent values are omitted from the payload.
  suiteId?: string
  suiteName?: string
  suiteIndex?: number
  suiteTotal?: number
  totalSteps?: number
  // The raw authored step texts, the same `memberStepText` announces; the shell masks them.
  stepTexts?: readonly string[]
  // Per member, because members may name different targets; absent means no probe applies.
  baselineProbe?: BaselineProbeResult
  // Members sharing a lane share a resource, so the pool runs them one at a time in index order.
  exclusiveLane?: string
}

// The shell binds `runId`, `testIndex` and masking; `loopEmitFor` curries `stepIndex`.
export interface MemberEventSink {
  stepStarted(input: { stepIndex: number; stepText: string }): void
  loopEmitFor(stepIndex: number): LoopEventEmitPort
  // Each leg goes through its projection and the sink mask, never a raw `bus.publish`.
  hookStarted(input: HookStartedPayload): void
  hookFinished(input: HookFinishedPayload): void
  testRetryScheduled(input: TestRetryScheduledPayload): void
}

/** Immutable member-start decision context used when the shell must synthesize step evidence. */
export interface MemberEvidenceContext {
  modelProfile?: DeclaredModelProfile
  verifierIdentity?: ModelIdentity
  toolSchemaDigest?: string
}

/** The per-member execution context threaded into the injected {@link MemberTestExecutor}. */
export interface MemberTestRunContext {
  /** Canonical shell identity. Legacy executors without a shell cannot certify scoped usage. */
  runId?: RunId
  abortSignal: AbortSignal
  testIndex: number
  events: MemberEventSink
  setEvidenceContext(context: MemberEvidenceContext): void
  // The shell's one store, threaded onto `LoopPorts.evidenceArtifacts`; absent, nothing persists.
  evidenceArtifacts?: EvidenceArtifactStorePort
  // `undefined` withdraws the producer; `fallback` takes over when the primary fails to start.
  registerLiveStream?(
    capability: LiveStreamCapability | undefined,
    fallback?: LiveStreamCapability,
  ): void
}

// The CLI wraps core's `runTest` here, because core depends on runner and never the reverse.
export type MemberTestExecutor = (
  member: RunMemberDescriptor,
  ctx: MemberTestRunContext,
) => Promise<TestResult>

// All optional: an absent leg means no persistence, memory-only telemetry or the default clock.
export interface RunPorts {
  handoffStore?: HandoffStorePort
  eventLog?: EventLogPort
  // Staged after `runStarted`, finalized before `runFinished`; absent, no artifact.json is written.
  runArtifactStore?: RunArtifactStorePort
  /**
   * The clock the post-verdict step's bound and the frame hub's bounds run on. It is NOT routed
   * into the bus heartbeat: the clocks stay apart so a fake timer drives those bounds
   * deterministically.
   */
  timer?: RunTimerPort
  // Constructed at the CLI root; the shell hands the same instance to every member.
  evidenceArtifacts?: EvidenceArtifactStorePort
  // A viewer's fault lands here, never on the bus; absent, it is reported nowhere.
  onSubscriberFault?: (code: string, message: string) => void
  // Awaited between artifact finalize and `runFinished`; absent means `detached` with no warning.
  postVerdict?: PostVerdictPort
}

// `startRun` never touches fs or providers, so nothing fs- or provider-shaped belongs here.
export interface RunConfig {
  runId: RunId
  scope: ScopeKey
  executionContext: ExecutionContext
  configDigests: ConfigDigests
  buildOrdinal: number
  // Only literal true excludes; absence is an ordinary counted run and stays absent in JSON.
  excludedFromOutcomes?: true
  // A gate run still folds into curation candidates, but the post-verdict step enqueues nothing.
  gateRun?: true
  members: readonly RunMemberDescriptor[]
  executor: MemberTestExecutor
  // Every bus event is masked with this redactor and nothing else; absent, events go as written.
  secretRedactor?: SecretRedactorPort
  ports?: RunPorts
  // Staged into `artifact.json` after `runStarted`; absent stages a schema-version-only document.
  runArtifact?: RunArtifactStageInput
  // Plain data resolved once at run start, matched on `(filePath, name)`, never `testId`.
  quarantined?: readonly QuarantineAppliedEntry[]
  // Copied verbatim onto the handoff; absent stays absent.
  plannerLimits?: PlannerLimitsRecord
  // Config-resolved, never request-supplied, so no caller can raise concurrency; below 1 means 1.
  workers?: number
}
