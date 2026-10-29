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

/**
 * The complete §2.2 event vocabulary M1 ships: every group EXCEPT the reserved
 * control/arbiter group (Live view / M5). Eleven lifecycle/diagnostic events plus the
 * six post-processing chip events — camelCase, names verbatim per spec §2.2
 * (Ratified 2026-07-05). The enum is append-only; the chip group is DEFINED here but
 * emitted by no M1 producer.
 *
 * the three reserved `issues*` chip names (started/completed/
 * failed) were REMOVED from this enum, from the payload aliases, from the {@link RunEvent}
 * union and from `handle-scope.ts`. They are spelled by pattern rather than verbatim here
 * on purpose: D-04's chip-side grep-clean bar treats a literal occurrence of any of the
 * three as a live reference, and a comment is not an exception worth carving. They were defined in bus schema 1 and emitted by no producer,
 * ever; they are removed after the 2026-08-25 amendment of `live-view.md` §4.3 and
 * `runner.md` §2.2 retired the reserved third chip. The append-only law protects
 * consumers of SHIPPED producers and therefore did not bind here — no reader on any wire
 * loses a name it could have received. Consumers now get a six-arm exhaustive switch
 * with no dead arms.
 */
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
  // Post-processing / status chips — DEFINED in v1, emitted by no M1 producer
  'analysisStarted',
  'analysisCompleted',
  'analysisFailed',
  'curationStarted',
  'curationCompleted',
  'curationFailed',
  // Phase 363 D-01/Q-3 parity appends (append-only per spec §2.2): hook lifecycle
  // (hookStarted/hookFinished) closes the reporter-parity gap before the v1 Reporter
  // interface is deleted; testRetryScheduled (resolves RESEARCH Open Q-3) marks a
  // per-test attempt reset so subscribers don't corrupt accumulation on retries.
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
  /**
   * 402-04 D-10/D-14 additive-optional append (§2.2 payload-additive; the envelope shape and the
   * event-type list are both untouched): the run's HANDLE ROSTER — each member's derived
   * `testIndex`, in member order.
   *
   * This is the run announcing which per-member streams are attachable, so a client can validate
   * a `?handle=` request against a roster rather than against a guess, and so the roster is
   * announced by a PAYLOAD field rather than by a second event vocabulary on the wire. Optional
   * because the field is additive: a run that announces none simply cannot answer a per-handle
   * question. The shell always emits it.
   */
  handles?: readonly number[]
}

/**
 * `runFinished`: the last VERDICT-SCOPED event, exactly once.
 *
 * "Always last" until Phase 388, relaxed there to "last verdict-scoped event" — the wording,
 * not the guarantee (388 D-13/D-16; dated reconciliation C13 in `.planning/REQUIREMENTS.md`). It remains the last thing the run bus ever publishes and the last line of the
 * run's log at the moment the exit code is frozen — `finalSeq` is still its own seq, and every
 * bus subscriber has already been flushed. What may now follow it IN THE FILE is a
 * postProcessing chip envelope, appended directly to `events.jsonl` by the in-process post-run
 * tail and continuing this seq. That producer is not on the bus at all, so no subscriber can
 * observe an event after the one it was promised was last.
 *
 * Only the in-process leg appends. When the daemon drains the chain instead, nothing is
 * emitted onto the run bus and durable job state is the only truth — which is the 386 D-16
 * two-receipt rule: a second process never writes a finished run's log.
 *
 * `disposition` — SUPERSEDED 2026-08-26. It read "stays the literal
 * `'detached'`, deliberately" while nothing decided it; it now carries the ratified three-value
 * {@link PostProcessingDisposition}, and the reason the old paragraph gave is exactly why the
 * three values mean what they do: this field is the POSTURE decided at the verdict, never a
 * report of the chain.
 *
 *   - `handedOff` — a current-epoch writer-lease holder exists, so somebody else will drain.
 *   - `drained`   — no holder; THIS process took the lease and will pump under it.
 *   - `detached`  — `--detach`, a gate-run skip, or an undecidable consult (a refused lease, no
 *                   queue composed on this host, a step that threw or overran its budget). Every
 *                   undecidable case is `detached` PLUS a named `runWarning`; the union is
 *                   never widened with a fourth arm.
 *
 * What actually BECAME of the chain is chip truth — `runs.postprocessing` over durable job state
 * and never this field. A `drained` run whose pump then failed still reads `drained`
 * here, because the promise this field makes is about who owns the work, not about the outcome.
 * Pre-404 logs carry the literal `'detached'`, which remains true of them.
 */
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

/**
 * `testStarted`: the {@link PerTestOutcome} identity fields (never the embedded steps).
 * Phase 363 D-01 additive-optional appends (§2.2 append-only, RESEARCH A2): suite grouping
 * rides testStarted rather than a new suite lifecycle event — the shell is suite-agnostic,
 * so reporters derive suite boundaries by watching the grouping change. `filePath`/`totalSteps`
 * restore console/JUnit/wire parity (RESEARCH Q1 table).
 */
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
  /**
   * 2026-09-26, owner decision (2), G-428-2. The same 363 D-01 additive-optional footing as the
   * fields above: the member's authored step texts, in step order, so a live row can show a step's
   * real text before the step starts. Masked at the producer by the run's redactor, exactly
   * as `stepStarted.stepText` is, so entry i equals step i's announced text. Absent from older
   * producers and recorded runs; a consumer that ignores it loses nothing but the pending text.
   */
  stepTexts?: readonly string[]
}

/**
 * `testFinished`: the {@link PerTestOutcome} identity fields plus `outcome`; the embedded
 * `steps` array is structurally excluded — projections never carry it.
 */
export interface TestFinishedPayload {
  testId: string
  testIndex: number
  outcome: MemberTestOutcome
  /**
   * Phase 363 D-01 additive-optional appends (§2.2, RESEARCH Q1). Sourced from the runner
   * `TestResult` at projection time — NOT new fields on the §A8 `PerTestOutcome` DTO
   * (Pitfall 2). `failureSummary` is masked at the sink.
   */
  durationMs?: number
  failureSummary?: string
  retryCount?: number
  recording?: RecordingEntry
  // set only on a skipped member, which has no testStarted to name it.
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

/**
 * `stepFinalized`: the {@link StepEvidence} projection — the full `ServedBrief` body is
 * structurally excluded (only its `briefDigest` travels). D-10/D-11.
 */
export interface StepFinalizedPayload {
  testIndex: number
  stepIndex: number
  cacheStatus: 'hit' | 'miss' | 'bypass' | 'disabled'
  verifierVerdict: VerifierVerdict
  selfHealOccurred: boolean
  briefDigest: string
  /**
   * Phase 363 D-01 additive-optional appends (§2.2, RESEARCH Q1). Sourced from the runner
   * `StepResult` at projection time — NOT new fields on the §A8 `StepEvidence` DTO
   * (Pitfall 2). `error` is masked at the sink.
   */
  status?: 'passed' | 'failed' | 'healed' | 'skipped' | 'cancelled'
  durationMs?: number
  error?: string
  /**
   * the step's measured model-call usage, on the same
   * 363 D-01 additive-optional footing as the three fields above — the frozen envelope and the
   * event NAME are untouched. Summed by the runner loop over the calls IT made for this step
   * (planner + verifier; heal turns ride the planner path), never re-derived downstream.
   *
   * ABSENT when no call was measured — a cache hit, a bypass, or a provider that reports no
   * usage. Never zero-filled: a `{0,0,0}` here would be a measurement nobody made, and every
   * consumer downstream (the NULL step columns, the omitted `runs.detail` sum, the omitted
   * analytics fields) reads absence as "unmeasured" rather than "free".
   */
  tokenUsage?: ModelTokenUsage
  /** selected profiles and authoritative provider observations, never backfilled. */
  modelUsage?: ModelUsage
  /** capture facts only; record bodies stay in evidence blobs. */
  evidence?: StepEvidenceEntries
  variableSnapshot?: VariableSnapshot
  /**
   * the host's retrieval rung at the moment this step's
   * brief was served, on the same 363 D-01 additive-optional footing as the fields above — the
   * frozen envelope and the event NAME are untouched.
   *
   * Unlike the 363 extras this fact is NOT sourced from the runner `StepResult`: it IS a
   * `StepEvidence` field, so the projection reads it off the evidence. ABSENT when the
   * evidence carries none — a pre-407 run, or a run that bound no knowledge reader. Both
   * members are closed enum words, so `maskPayloadStrings` walks them unchanged in meaning.
   */
  retrievalRung?: RecordedRetrievalRung
  readonly servedBrief?: never
}

// --- Sub-action evidence tick payload ----------------------------------------

/**
 * `subActionRecorded`: the {@link SubActionEvidence} projection with states collapsed to
 * `screenStateHash` identity. Raw `stateBefore`/`screenshot` are structural
 * compile errors — the 356 `NonCacheableStepInput` `?: never` idiom enforces payload
 * discipline at the type level, not a runtime strip.
 */
export interface SubActionRecordedPayload {
  testIndex: number
  stepIndex: number
  subActionIndex: number
  plan: string
  plannedAction: Action
  grounding?: GroundingEvidence
  result: RecordedActionResult
  /**
   * The `stateBefore` identity — the full {@link ScreenState} collapsed to a
   * `screenStateHash` string. This is the sub-action's primary state hash;
   * `screenStateHashAfter` is present only when the action recorded a distinct
   * post-action state.
   */
  screenStateHash: string
  screenStateHashAfter?: string
  artifactRefs?: readonly ArtifactRef[]
  /** before-tree capture state; its present ref also rides artifactRefs. */
  ariaEvidence?: AriaEvidenceEntry
  recordingOffsetMs?: number
  readonly stateBefore?: never
  readonly screenshot?: never
}

// --- Hook lifecycle payloads (Phase 363 D-01 parity appends) ----------------

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

/**
 * `hookFinished`: the identity fields plus the hook result (mirrors core `HookResultEvent`,
 * reporter/types.ts lines 47-52). `stdout`/`stderr`/`error` and each `variables` VALUE are
 * masked at projection; `variables` keys pass through. `kind` distinguishes a
 * plain hook from an appium-script / runjs inline body.
 */
export interface HookFinishedPayload extends HookStartedPayload {
  status: 'passed' | 'failed' | 'skipped'
  durationMs: number
  stdout: string
  stderr: string
  variables: Record<string, string>
  error?: string
  kind?: 'hook' | 'appium-script' | 'runjs'
}

/**
 * `testRetryScheduled` (resolves RESEARCH Open Q-3): emitted when the member-runner retry
 * loop schedules another attempt. Only the FINAL attempt emits the authoritative
 * `testFinished`; this event marks a per-test accumulation reset for subscribers so
 * repeated `stepStarted` sequences mid-member don't corrupt counts/durations.
 */
export interface TestRetryScheduledPayload {
  testId: string
  testIndex: number
  attempt: number
  maxAttempts: number
  reason?: string
}

// --- Post-processing / status chip payloads (defined-never-emitted in M1) -----

/**
 * The shared post-processing chip payload shape (spec §2.2: `{ runId, error, willRetry }`).
 * DEFINED in bus schema v1; the producer lands in Phase 388 — appended to
 * `events.jsonl` by the in-process post-run tail, continuing `runFinished.finalSeq`.
 *
 * The shape is UNCHANGED by 388 and that is a decision rather than an omission: `live-view.md`
 * §4.3 ratifies richer per-chip summaries, and the bus enum is append-only (§2.2), so those
 * fields are additive later at no cost. What 388 emits is the minimal honest envelope, because
 * anything richer would be a second place chip semantics are stated — and the one place they
 * are stated is `projectPostProcessingChips`, over durable rows a surface can re-read.
 */
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

/**
 * The frozen bus envelope (spec §2.2): `{ seq, ts, runId, type, payload }`. This is a
 * TYPE ONLY — the runner bus stamps `seq`/`ts` at publish (schema bans host time/hash APIs, D-05).
 * `seq` is a per-run gap-free monotonic integer (the total order; `lastEventId ≡ seq`);
 * `ts` is wall-clock, audit only. `runId` is a plain string here (the envelope crosses to
 * the browser/JSONL, so it carries the un-branded id).
 */
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

/**
 * The discriminated bus-event union: each event `type` mapped to its payload. M5 replay
 * tooling and M1b eval consume this to narrow on `type`. The six chip events are members
 * of the union (defined-never-emitted in M1; the reserved `issues*` triple was removed
 * see the {@link RUN_EVENT_TYPES} header).
 */
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
