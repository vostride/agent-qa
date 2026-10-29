import type { Action } from '../action/index'
import type { ArtifactRef } from '../ids/artifact-ref'
import type { RecordedActionResult } from '../result/index'
import type { GroundingEvidence } from '../screen/target-descriptor'
import type { ScopeKey } from '../identity/scope-key'
import type { MemberTestOutcome } from './member-outcome'
import type { ExecutionContext, RunStatus } from './run-status'
import type { RecordedRetrievalRung } from '../brief/retrieval-rung'
import type { VerifierVerdict } from '../handoff/step-evidence'
import type { AriaEvidenceEntry, StepEvidenceEntries, VariableSnapshot } from './evidence'
import type { ModelTokenUsage, ModelUsage } from './model-usage'
import type { RecordingEntry } from './recording'

/** The bus schema version, declared once per run in `runStarted.payload.busSchemaVersion`. */
export const CURRENT_BUS_SCHEMA_VERSION = 2

// Append-only: a consumer of a shipped producer must never lose a name it could receive.
export const RUN_EVENT_TYPES = [
  // Run lifecycle
  'runStarted',
  'runFinished',
  // Member-test lifecycle
  'testStarted',
  'testFinished',
  // Step lifecycle
  'stepStarted',
  'stepFinalized',
  // Sub-action evidence tick
  'subActionRecorded',
  // Verdict
  'verdict',
  // Diagnostics
  'runWarning',
  'runError',
  // Liveness
  'heartbeat',
  // Post-processing / status chips, appended by the post-run tail rather than the bus
  'analysisStarted',
  'analysisCompleted',
  'analysisFailed',
  'curationStarted',
  'curationCompleted',
  'curationFailed',
  // `testRetryScheduled` marks a per-test attempt reset so subscribers do not double-count retries.
  'hookStarted',
  'hookFinished',
  'testRetryScheduled',
] as const

export type RunEventType = (typeof RUN_EVENT_TYPES)[number]

// --- Run lifecycle payloads -------------------------------------------------

/** `runStarted`: the {@link CompletedRunHandoff} header fields + the bus schema version. */
export interface RunStartedPayload {
  busSchemaVersion: number
  scope: ScopeKey
  executionContext: ExecutionContext
  buildOrdinal: number
  configDigests: {
    suiteConfigDigest: string
    testConfigDigest: string
  }
  memberTestCount: number
  // Lists the attachable per-member streams, so a `?handle=` request is checked against it.
  handles?: readonly number[]
}

// The posture decided at the verdict: who owns the chain, never how it ended; chip truth says that.
export type PostProcessingDisposition = 'drained' | 'handedOff' | 'detached'

export interface RunFinishedPayload {
  aggregateVerdict: RunStatus
  disposition: PostProcessingDisposition
  finalSeq: number
}

/** `verdict`: exactly once, the terminal aggregate {@link RunStatus} — the exit-code moment. */
export interface VerdictPayload {
  verdict: RunStatus
}

// --- Diagnostics payloads ---------------------------------------------------

/** `runWarning` / `runError`: non-terminal diagnostics. */
export interface RunWarningPayload {
  code: string
  message: string
  context?: Record<string, string>
}

export type RunErrorPayload = RunWarningPayload

/** `heartbeat`: empty payload, emitted after ~10 s of bus silence (the v1 cadence). */
export type HeartbeatPayload = Record<string, never>

// --- Member-test lifecycle payloads -----------------------------------------

// Suite grouping rides `testStarted`; reporters derive suite boundaries from a change in grouping.
export interface TestStartedPayload {
  testId: string
  testIndex: number
  name: string
  filePath?: string
  suiteId?: string
  suiteName?: string
  suiteIndex?: number
  suiteTotal?: number
  totalSteps?: number
  // Masked like `stepStarted.stepText`, so entry i equals step i's announced text.
  stepTexts?: readonly string[]
}

export interface TestFinishedPayload {
  testId: string
  testIndex: number
  outcome: MemberTestOutcome
  // From the runner's `TestResult`, not `PerTestOutcome`; `failureSummary` is masked at the sink.
  durationMs?: number
  failureSummary?: string
  retryCount?: number
  recording?: RecordingEntry
  // Set only on a skipped member, which has no `testStarted` to name it.
  name?: string
  filePath?: string
  readonly steps?: never
}

// --- Step lifecycle payloads ------------------------------------------------

/** `stepStarted`: the owning `testIndex`, `stepIndex`, and `stepText`. */
export interface StepStartedPayload {
  testIndex: number
  stepIndex: number
  stepText: string
}

// Only `briefDigest` travels; the `ServedBrief` body never rides the bus.
export interface StepFinalizedPayload {
  testIndex: number
  stepIndex: number
  cacheStatus: 'hit' | 'miss' | 'bypass' | 'disabled'
  verifierVerdict: VerifierVerdict
  selfHealOccurred: boolean
  briefDigest: string
  // Sourced from the runner's `StepResult`, not `StepEvidence`; `error` is masked at the sink.
  status?: 'passed' | 'failed' | 'healed' | 'skipped' | 'cancelled'
  durationMs?: number
  error?: string
  // Absent when no call was measured, never zero-filled; downstream reads absence as unmeasured.
  tokenUsage?: ModelTokenUsage
  // Selected profiles and authoritative provider observations, never backfilled.
  modelUsage?: ModelUsage
  // Capture facts only; record bodies stay in evidence blobs.
  evidence?: StepEvidenceEntries
  variableSnapshot?: VariableSnapshot
  // Read off the step evidence; absent when the evidence names no rung.
  retrievalRung?: RecordedRetrievalRung
  readonly servedBrief?: never
}

// --- Sub-action evidence tick payload ----------------------------------------

// Raw `stateBefore` and `screenshot` are type errors here, not stripped at runtime.
export interface SubActionRecordedPayload {
  testIndex: number
  stepIndex: number
  subActionIndex: number
  plan: string
  plannedAction: Action
  grounding?: GroundingEvidence
  result: RecordedActionResult
  // `screenStateHashAfter` is present only when the action recorded a distinct post-action state.
  screenStateHash: string
  screenStateHashAfter?: string
  artifactRefs?: readonly ArtifactRef[]
  // Before-tree capture state; its ref also rides `artifactRefs`.
  ariaEvidence?: AriaEvidenceEntry
  recordingOffsetMs?: number
  readonly stateBefore?: never
  readonly screenshot?: never
}

/**
 * `hookStarted`: the hook identity fields (mirrors core `HookEvent`, reporter/types.ts
 * lines 25-32). `phase` distinguishes suite/test setup·teardown from `inline` hooks;
 * `scope`/`testIndex`/`stepIndex` locate the hook in the run tree when present.
 */
export interface HookStartedPayload {
  hookName: string
  phase: 'setup' | 'teardown' | 'inline'
  hookExecutionId: string
  hookId?: string
  scope?: 'suite' | 'test' | 'step'
  testIndex?: number
  stepIndex?: number
}

// Each `variables` value, `stdout`, `stderr` and `error` are masked; `variables` keys pass through.
export interface HookFinishedPayload extends HookStartedPayload {
  status: 'passed' | 'failed' | 'skipped'
  durationMs: number
  stdout: string
  stderr: string
  variables: Record<string, string>
  error?: string
  kind?: 'hook' | 'appium-script' | 'runjs'
}

// Only the final attempt emits `testFinished`; this resets a subscriber's per-test counts.
export interface TestRetryScheduledPayload {
  testId: string
  testIndex: number
  attempt: number
  maxAttempts: number
  reason?: string
}

// --- Post-processing chip payloads -----------------------------------------

// Appended to `events.jsonl` by the post-run tail, continuing `runFinished.finalSeq`.
export interface ChipEventPayload {
  runId: string
  error?: string
  willRetry?: boolean
}

export type AnalysisStartedPayload = ChipEventPayload
export type AnalysisCompletedPayload = ChipEventPayload
export type AnalysisFailedPayload = ChipEventPayload
export type CurationStartedPayload = ChipEventPayload
export type CurationCompletedPayload = ChipEventPayload
export type CurationFailedPayload = ChipEventPayload

// --- Envelope + event union --------------------------------------------------

/** The union of every §2.2 payload projection an envelope can carry. */
export type RunEventPayload =
  | RunStartedPayload
  | RunFinishedPayload
  | VerdictPayload
  | RunWarningPayload
  | RunErrorPayload
  | HeartbeatPayload
  | TestStartedPayload
  | TestFinishedPayload
  | StepStartedPayload
  | StepFinalizedPayload
  | SubActionRecordedPayload
  | HookStartedPayload
  | HookFinishedPayload
  | TestRetryScheduledPayload
  | ChipEventPayload

// `seq` is the per-run gap-free order and resume token; `ts` is wall-clock, for audit only.
export interface RunEventEnvelope {
  seq: number
  ts: number
  runId: string
  type: RunEventType
  payload: RunEventPayload
}

/** A per-type envelope binding each event `type` to its payload projection. */
interface RunEventOf<T extends RunEventType, P extends RunEventPayload> {
  seq: number
  ts: number
  runId: string
  type: T
  payload: P
}

export type RunEvent =
  | RunEventOf<'runStarted', RunStartedPayload>
  | RunEventOf<'runFinished', RunFinishedPayload>
  | RunEventOf<'verdict', VerdictPayload>
  | RunEventOf<'runWarning', RunWarningPayload>
  | RunEventOf<'runError', RunErrorPayload>
  | RunEventOf<'heartbeat', HeartbeatPayload>
  | RunEventOf<'testStarted', TestStartedPayload>
  | RunEventOf<'testFinished', TestFinishedPayload>
  | RunEventOf<'stepStarted', StepStartedPayload>
  | RunEventOf<'stepFinalized', StepFinalizedPayload>
  | RunEventOf<'subActionRecorded', SubActionRecordedPayload>
  | RunEventOf<'hookStarted', HookStartedPayload>
  | RunEventOf<'hookFinished', HookFinishedPayload>
  | RunEventOf<'testRetryScheduled', TestRetryScheduledPayload>
  | RunEventOf<'analysisStarted', AnalysisStartedPayload>
  | RunEventOf<'analysisCompleted', AnalysisCompletedPayload>
  | RunEventOf<'analysisFailed', AnalysisFailedPayload>
  | RunEventOf<'curationStarted', CurationStartedPayload>
  | RunEventOf<'curationCompleted', CurationCompletedPayload>
  | RunEventOf<'curationFailed', CurationFailedPayload>
