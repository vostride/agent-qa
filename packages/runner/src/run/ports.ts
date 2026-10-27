// Runner-owned port interfaces for the run layer (D-01/D-02/D-04/D-05).
// CRITICAL: provider-neutral + storage-neutral. Type-only imports, exported
// interfaces, no implementation, no class, and NO `node:*` — the run shell and
// the in-memory bus are pure logic; every I/O leg (JSONL event log, handoff.json,
// timers) crosses to `runner-local` behind these seams (validate:arch storageNeutral,
// the FsActionCache / storage-state port precedent). Declared interface-first so
// Plans 06–10 build against them without exploration.
//
// 2026-08-26 (Phase 404 D-10): `POST_VERDICT_STEP_BUDGET_MS` is the first VALUE this module
// exports, and it stays inside the rule the header states. The rule is about IMPLEMENTATION —
// nothing here may open a file, name a provider or hold state. A bound is neither: it is part of
// the port's contract (the shell races the step against it; the host may not choose its own), and
// putting it beside the interface it bounds is what keeps the two from drifting.

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

/**
 * The two 356 A5 config digests the run actually keyed on, computed once at the CLI
 * composition root and passed in the resolved {@link RunConfig} (D-20). Carried verbatim
 * into `runStarted`/the handoff so run identity and handoff identity cannot fork.
 */
export interface ConfigDigests {
  suiteConfigDigest: string
  testConfigDigest: string
}

/**
 * The run-start baseline health-probe outcome (D-04, RCC-02): ONE GET against the web
 * target's base URL, executed at the CLI composition root (the runner bans node:* — only
 * the RESULT crosses this seam). ALL probe failures arrive as values on `error`; a probe
 * never aborts the run. Consumed by the deterministic root-cause classifier's environment
 * branch (run/root-cause.ts).
 */
export interface BaselineProbeResult {
  status?: number
  elapsedMs: number
  error?: string
}

/**
 * The JSONL event-log seam (D-05/D-06). BOTH legs are SYNC and fire-and-forget — the bus
 * NEVER awaits telemetry (a synchronous one-line append; D-06/D-07). `append` persists one
 * envelope per emitted event; a throw degrades the bus to memory-only with a single
 * `runWarning` (D-07). `read(fromSeq)` supplies older-than-window envelopes for deep replay.
 * The runner-local `FsEventLog` (Plan 07) implements this against `events.jsonl`.
 */
export interface EventLogPort {
  append(envelope: RunEventEnvelope): void
  read(fromSeq: number): RunEventEnvelope[]
}

/**
 * The per-hook execution options the orchestration threads into the {@link HookExecutorPort}
 * (D-06). `env` is the accumulated-variables + user-env map the orchestrator merges per hook;
 * `secretEnv` is the ALREADY-RESOLVED secret name→value map for container injection — the CLI
 * composition root resolves the SecretStore and the runner never touches the store itself. The
 * secret VALUES double as the output-variable filter (a hook-emitted variable equal to a secret
 * value is dropped). `secretRedactor` redacts stdout/stderr/error; `authState` mounts + injects
 * the active auth state (container-local paths only). Pitfall 3: all sandbox-side
 * redaction/filtering stays inside the impl — the sink mask is additive.
 */
export interface HookExecuteOptions {
  env: Record<string, string>
  secretEnv: Record<string, string>
  secretRedactor?: SecretRedactorPort
  authState?: RuntimeAuthStateConfig
}

/**
 * The D-06 hook-execution seam: a runner-owned port whose only implementation is the
 * runner-local `DockerHookExecutor` (the 356/361 port-in-runner/impl-in-runner-local
 * precedent). `execute` runs ONE hook in the sandboxed container and resolves a
 * {@link HookResult} — a per-hook timeout resolves a FAILED result with an exit-124-style
 * error, NEVER a throw (the orchestration relies on a resolved result to synthesize
 * fail-fast skips). node:child_process / node:fs live behind this port in runner-local;
 * the runner stays storageNeutral (validate:arch is the arbiter).
 */
export interface HookExecutorPort {
  execute(hook: HookDefinition, opts: HookExecuteOptions): Promise<HookResult>
}

/**
 * The durable handoff seam (D-05/D-17). SYNC single-document persist of the one
 * `CompletedRunHandoff` at run end; the runner-local `FsHandoffStore` (Plan 07) writes
 * `handoff.json` beside `events.jsonl`. Failure degrades with a `runWarning`, never gates
 * the verdict (D-07).
 */
export interface HandoffStorePort {
  save(handoff: CompletedRunHandoff): void
}

/**
 * What the post-verdict step is told about the run whose posture it is deciding (404 D-10).
 *
 * The two markers are read off the ASSEMBLED `RunConfig` — the same values `startRun` was handed
 * — never off ambient state, so a gate-run skip (D-08) is decided from the run's own record.
 * Absent means absent: `?: true` carriers are conditionally spread, never written as `undefined`.
 */
export interface PostVerdictStepInput {
  readonly runId: RunId
  readonly verdict: RunStatus
  readonly gateRun?: true
  readonly excludedFromOutcomes?: true
}

/**
 * The step's answer: the posture, and — when the consult could not decide — the reason, by name.
 *
 * A warning rather than a fourth union arm (D-11). `detached` is the honest "nothing will be
 * drained from here", and the cause travels on the `runWarning` channel a surface already reads.
 */
export interface PostVerdictOutcome {
  readonly disposition: PostProcessingDisposition
  readonly warning?: { readonly code: string; readonly message: string }
}

/**
 * The post-verdict step (404 D-10) — the `HandoffStorePort` idiom applied to the ONE decision the
 * shell delays `runFinished` for.
 *
 * WHAT IT MAY DO: the durable enqueue and ONE writer-lease consult. Milliseconds. The runner
 * names no queue, no sqlite and no lease vocabulary (validate:arch storageNeutral) — the HOST
 * supplies the implementation, and the shell only awaits it.
 *
 * WHAT IT MAY NOT DO: gate `done`. A throw, a resolution past
 * {@link POST_VERDICT_STEP_BUDGET_MS}, or an absent port all yield `detached` plus a named
 * `runWarning`, and `runFinished` still publishes last with `bus.close()` behind it (403-03 D-3).
 * The step returns a VALUE and never touches the bus: the shell keeps sole ownership of the
 * terminal sequence.
 *
 * THE SHELL HOLDS NO LEASE. Whatever the step acquired stays with the host, which hands it to its
 * own pump — acquire → pump → release is ONE lease, never re-acquired (RESEARCH Pitfall 3).
 */
export interface PostVerdictPort {
  run(input: PostVerdictStepInput): Promise<PostVerdictOutcome>
}

/**
 * The hard bound the shell races the step against (404 D-10, RESEARCH Pitfall 1).
 *
 * `acquireWriterLease` has contention/deadline semantics of its own, and a busy sqlite enqueue can
 * stall; without a bound here `runFinished`, `done`, the SSE close and the dashboard finalize all
 * slide behind it. Five seconds is generous for "enqueue + one consult" and still far below any
 * drain budget — reaching it means the consult is not going to answer, which is `detached`.
 */
export const POST_VERDICT_STEP_BUDGET_MS = 5_000

/**
 * The D-08 run-artifact persistence seam: a runner-owned port whose only implementation is the
 * runner-local `FsRunArtifactStore` (the 356/361 port-in-runner/impl-in-runner-local precedent).
 * BOTH legs are SYNC and fire-and-forget — the shell NEVER awaits artifact persistence, and a
 * throw degrades with a `runWarning`, never gates the verdict (the event-log/handoff
 * discipline; D-07). The store writes ONE `artifact.json` into the SAME
 * `<root>/runs/<slug(runId)>/` family as `events.jsonl`/`handoff.json` (one self-contained run
 * directory). `stage(document)` persists the config + source snapshot once after `runStarted`;
 * `finalize(patch)` merges terminal errors + the end timestamp before `runFinished` — matching
 * the dashboard DB staged/finalize idiom so a crashed run still leaves a staged artifact. Per the
 * RESEARCH Q5 keep/drop table the FILE artifact keeps config/source/errors only; the top-level
 * `runtime` section is dropped (derived from events/handoff). An absent port is a silent no-op.
 */
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

/**
 * One ordered member of the run (D-04). `failFastGroup` scopes today's suite fail-fast: a
 * failed/timed-out member skips the remaining SAME-group members; ungrouped members never
 * fail-fast, preserving the single-test path's run-all behavior.
 *
 * `testIndex` is optional: the shell owns iteration and derives the authoritative index
 * from array position (a caller-supplied value is a hint at most). `name` is REQUIRED so
 * the compiler enforces every descriptor construction site supplies the parsed test name;
 * handoff assembly copies it verbatim onto `PerTestOutcome.testName`.
 */
export interface RunMemberDescriptor {
  testId: string
  testIndex?: number
  name: string
  failFastGroup?: string
  /**
   * The member test file's WORKSPACE-RELATIVE path — rooted at the config directory,
   * forward-slashed, no leading `./`. REQUIRED since 381-01 (ABRF-02): stable test identity =
   * filePath + testName, copied verbatim onto `PerTestOutcome.filePath` by the handoff assembly —
   * the required field makes the compiler enforce that every descriptor construction site supplies
   * it.
   *
   * 390-08 (CR-02 / D-01): this is IDENTITY, not a file handle. It is deliberately checkout-
   * independent — the same bytes on every machine — because the committed `quarantine.jsonl` keys
   * entries on it and matches with `===`, so an absolute path here would produce a ledger that
   * could only ever apply on the machine that wrote it. Nothing in the run reads bytes off disk
   * through this field; the CLI mints it via core's `workspaceRelativeIdentityPath` and keeps the
   * absolute path on the side for every read.
   */
  filePath: string
  /**
   * 363 D-01 parity fields (RESEARCH Q1). All OPTIONAL and additive — the shell rides them onto
   * the widened `testStarted` payload so reporters can render the full v1 console/JUnit/wire
   * surface from the bus alone. Suite grouping (`suiteId`/`suiteName`/`suiteIndex`/`suiteTotal`)
   * rides testStarted rather than a suite lifecycle event — the shell stays suite-agnostic and
   * reporters derive suite boundaries by watching the grouping change. `totalSteps` is the
   * per-member parsed step count. The CLI populates these at both startRun sites; absent
   * ⇒ omitted from the payload (no undefined-hole survives JSON round-trip).
   */
  suiteId?: string
  suiteName?: string
  suiteIndex?: number
  suiteTotal?: number
  totalSteps?: number
  /**
   * G-428-2 (2026-09-26): the raw authored text of each step, in order. It is the same string
   * member-runner announces at `stepStarted` (`memberStepText`). The shell masks it onto
   * `testStarted.stepTexts`; callers never pre-mask. Absent ⇒ omitted from the payload.
   */
  stepTexts?: readonly string[]
  /**
   * THIS MEMBER'S OWN TARGET's run-start health baseline (D-04, 401-19 WR-04).
   *
   * PER MEMBER, NOT PER RUN, because a run's members may name different targets and a reading taken
   * against one of them says nothing about another. It lived on `RunConfig` and was handed to the
   * classifier for EVERY member, so a 503 observed against member B's target was recorded as member
   * A's environment failure. The CLI composition root fills this in behind the verdict, probing each
   * DISTINCT member URL once; absent means no probe applies to this member — the mobile posture,
   * where the device-session-create failure is the equivalent environment signal, and equally the
   * posture of a member whose target could not be resolved.
   */
  baselineProbe?: BaselineProbeResult
  /**
   * 402-02 (D-09): members declaring the SAME lane share a mutable execution resource and MUST NOT
   * run concurrently — the bounded member pool runs them strictly one at a time, in index order.
   * Absent means "this member owns everything it touches" and the pool may schedule it freely.
   *
   * This is a PRECONDITION the producer states, never something the shell infers. D-09 requires
   * each concurrent member its own browser/CDP handle; today's suite path does not satisfy that
   * (every member of a suite drives the ONE adapter its suite set up, and `createSuiteLifecycle`
   * admits one active suite at a time), while the direct path does (each direct test constructs
   * its own adapter). A producer that starts handing each member its own session drops the lane
   * and gets concurrency; nothing in the shell has to be re-argued for that to be safe.
   */
  exclusiveLane?: string
}

/**
 * The run-scoped event sink handed to the executor per member test (D-02). The shell binds
 * `runId`/`testIndex`/masking; core curries `stepIndex` via `loopEmitFor`. `stepStarted`
 * fires as a step opens; `loopEmitFor(stepIndex)` yields the {@link LoopEventEmitPort} the
 * loop emits `stepFinalized`/`subActionRecorded` through.
 */
export interface MemberEventSink {
  stepStarted(input: { stepIndex: number; stepText: string }): void
  loopEmitFor(stepIndex: number): LoopEventEmitPort
  /**
   * 363 D-01 parity legs, each routed through its Plan 01 projection + the sink mask (never a raw
   * `bus.publish` from the caller — T-363-06). `hookStarted`/`hookFinished` are emitted by the
   * runner hook orchestration (Plan 04 populates them; `hookFinished` stdout/stderr/error and every
   * `variables` value are masked at the sink, T-363-05). `testRetryScheduled` is emitted by the
   * member-runner retry loop (Plan 10) and marks a per-test accumulation reset for subscribers.
   */
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
  /**
   * CASS-02 run-scoped decision-screenshot byte store (the same instance the shell holds on
   * {@link RunPorts}). The member threads it onto `LoopPorts.evidenceArtifacts`; absent ⇒ a
   * memory-only run with no screenshot persistence.
   */
  evidenceArtifacts?: EvidenceArtifactStorePort
  /**
   * 403 D-05: declare (or withdraw) this member's live-stream producer. Optional on the SAME
   * `setEvidenceContext` precedent above — the executor pushes a capability the shell knows
   * nothing about, and the shell owns the per-run hub that refcounts it. Passing `undefined`
   * withdraws the declaration (the handle then reads `{ kind: 'none' }`). Absent on the context
   * ⇒ a composition that predates live view; the executor's optional call is a no-op.
   * `fallback` is the labelled snapshot producer the hub switches to when the primary fails to
   * start (428 D-12).
   */
  registerLiveStream?(
    capability: LiveStreamCapability | undefined,
    fallback?: LiveStreamCapability,
  ): void
}

/**
 * The injected per-test execution port (D-01). The CLI composition root wraps core's
 * `runTest` behind this seam (core depends on runner, so runner can never import core);
 * Phase 363 dissolves the core side of the port when it migrates hooks/variables/reporters.
 * A staged migration, not a workaround — this is the exact seam 363 needs.
 */
export type MemberTestExecutor = (
  member: RunMemberDescriptor,
  ctx: MemberTestRunContext,
) => Promise<TestResult>

/**
 * The durable/telemetry/clock seams the run wires behind ports (D-04/D-05). All optional —
 * an absent leg degrades gracefully (no persistence, memory-only telemetry, default clock).
 * Grouped under `ports` so the resolved config keeps the run identity fields flat and the
 * injectable I/O seams together (the Wave-0 `run-shell.test.ts` pins this nesting).
 */
export interface RunPorts {
  handoffStore?: HandoffStorePort
  eventLog?: EventLogPort
  /**
   * The D-08 run-artifact store. Staged after `runStarted`, finalized before `runFinished`;
   * absent ⇒ no artifact.json is written (memory-only run, byte-identical pre-363-06 behavior).
   */
  runArtifactStore?: RunArtifactStorePort
  /**
   * The clock the post-verdict step's bound and the frame hub's bounds run on. It is NOT routed
   * into the bus heartbeat: the clocks stay apart so a fake timer drives those bounds
   * deterministically.
   */
  timer?: RunTimerPort
  /**
   * The CASS-02 run-scoped decision-screenshot artifact store (Plan 11). The runner-local
   * `FsEvidenceArtifactStore` is constructed run-scoped at the CLI composition root and injected
   * here; the shell hands the same instance to every member. Absent ⇒ no screenshot bytes are
   * persisted (memory-only run, byte-identical pre-Plan-11 behavior).
   */
  evidenceArtifacts?: EvidenceArtifactStorePort
  /**
   * Where a VIEWER's fault is reported (403 WR-06): a live-frame subscriber that throws during
   * delivery is detached by the hub and the fact lands here. NEVER the bus — the run's permanent
   * transcript must not depend on who happened to be watching (LIVE-03). Same signature as the
   * hub's own option, so the shell forwards rather than adapts; absent ⇒ reported nowhere.
   */
  onSubscriberFault?: (code: string, message: string) => void
  /**
   * The 404 D-10 post-verdict step, awaited between `runArtifactStore.finalize` and
   * `runFinished`. Absent ⇒ `disposition: 'detached'` with NO warning — a host that composed no
   * step is not an error, it is a host from which nothing will be drained, and the wire says so.
   */
  postVerdict?: PostVerdictPort
}

/**
 * The fully-resolved run configuration `startRun` receives (D-04). The CLI keeps pattern
 * discovery, parsing, config merge, and target/device/model resolution; `startRun` never
 * touches fs or providers (validate:arch stays clean) — hence NO fs/provider/discovery-shaped
 * members here. A future cloud RPC surface reuses this same resolved-config contract.
 *
 * `members`/`ports` shapes are pinned by the Wave-0 `run-shell.test.ts` scaffold.
 */
export interface RunConfig {
  runId: RunId
  scope: ScopeKey
  executionContext: ExecutionContext
  configDigests: ConfigDigests
  buildOrdinal: number
  /**
   * D-14 §6 gate-run exclusion copied into the durable completed-run handoff. Only literal
   * true excludes; absence denotes an ordinary counted run and remains absent in JSON.
   */
  excludedFromOutcomes?: true
  /**
   * D-10 verify-before-present gate-run marker (Phase 384, 2026-07-28) copied into the
   * durable completed-run handoff. A DISTINCT axis from `excludedFromOutcomes` above:
   * C8-ratified, gate runs still feed curation. Only literal true marks a gate run;
   * absence denotes an ordinary run and remains absent in JSON. 384 threads the carrier
   * only — the exclusion semantics land in 388/393.
   *
   * ═══ 2026-08-26 — Phase 404 D-08 amends "gate runs still feed curation" ═══
   *
   * They still feed the FOLD — a gate run's handoff, folded, still emits curation candidates, and
   * the outcome-side exclusion still keys on `excludedFromOutcomes` alone. What changed is the
   * QUEUE: the post-verdict step enqueues NOTHING for a run carrying either marker, so no
   * `analyze-run` row exists for a `write_test` keep-filter probe. The reasons are all about the
   * gate loop rather than about correctness — no strong-model analysis cost per keep-gate
   * iteration, no draft evidence reaching curation through the chain, and no post-processing chips
   * about a run nobody will ever open. The marker still rides the handoff and the payload schema
   * still carries it, because the exclusion is a decision the enqueue takes and not a fact the
   * record forgets.
   */
  gateRun?: true
  members: readonly RunMemberDescriptor[]
  executor: MemberTestExecutor
  /**
   * The run's redactor over the secrets its producer read at the run's start (441-12, D-06/D-11).
   * Every bus event, and so `events.jsonl` and the dashboard rows, is masked with it and nothing
   * else. Absent ⇒ the run's events are published as written.
   */
  secretRedactor?: SecretRedactorPort
  ports?: RunPorts
  /**
   * The D-08 config + source artifact snapshot the CLI composition root assembles (the
   * `buildRunArtifactContext` document). Staged verbatim into `artifact.json` after `runStarted`
   * via `ports.runArtifactStore`. Optional — absent ⇒ an empty stage (schema-version-only doc),
   * so the store leg stays a no-op-shaped write and the memory-only path is unchanged.
   */
  runArtifact?: RunArtifactStageInput
  /**
   * Phase 390 D-16: the quarantined-test set, resolved ONCE at run start by the composition layer
   * (the CLI folds the committed ledger before the first member executes) and threaded in as PLAIN
   * DATA. This is deliberately NOT a port: the runner gains zero new I/O seams and stays
   * storageNeutral, and the disposition is deterministic for the whole run, so a mid-run ledger
   * edit can never retroactively change a running build. Mirrors how `executionContext` is
   * resolved once at run start.
   *
   * Members are matched on `(filePath, name)` — the stable test identity — never `testId`. A match
   * makes the member's failure skippable in the aggregate rule (`deriveAggregateVerdict`) and
   * stamps the disposition beside its truthful outcome in the handoff. Absent or empty ⇒
   * byte-identical pre-390 behavior.
   */
  quarantined?: readonly QuarantineAppliedEntry[]
  /**
   * 436 D-06: the planner limits the producer resolved for this run and the members whose own
   * limits differ, as plain data. Copied verbatim onto the handoff; absent stays absent.
   */
  plannerLimits?: PlannerLimitsRecord
  /**
   * 402-02 (D-09/D-12): how many members may execute CONCURRENTLY in this run's process. Defaults
   * to 1 — one worker is a plain sequential loop, byte-identical to the pre-402 shell, so nothing
   * changes until a config resolves a higher value. Effective concurrency is
   * `min(members.length, workers)`; values below 1 and non-finite values resolve to 1.
   *
   * CONFIG-RESOLVED, NEVER REQUEST-SUPPLIED. It arrives on the already-resolved RunConfig the
   * composition root builds. `RunsStartInput` carries no concurrency field, so a remote
   * token-holder cannot raise the concurrency of a target whose owner tuned it down (the
   * refused-request-fields posture), and unbounded concurrency has no reachable input.
   */
  workers?: number
}
