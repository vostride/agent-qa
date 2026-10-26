import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Readable } from 'node:stream'
import { isDeepStrictEqual } from 'node:util'
import { renderPromotionLine } from '../curation/promotion-line.js'

import type {
  ConfigReaderPort,
  JobModelCapability,
} from '@vostride/agent-qa-agent'
import {
  composeJobRecovery,
  composeLocalAgent,
  DIGEST_JOB_ID_SOURCE,
  EMBEDDER_WORKER_REGISTRATION_FILE,
  EMBEDDER_WORKER_START_TIMEOUT_MS,
  EMBEDDER_WORKER_TERM_GRACE_MS,
  EmbedderWorkerTimeoutError,
  ENTITY_INDEX_SWEEP_INTERVAL_MS,
  LOCAL_DAEMON_CAPABILITIES,
  RunDeniedError,
  SYSTEM_CLOCK,
  sweepEntityIndexProjection,
} from '@vostride/agent-qa-agent-local'
import type {
  ComposeJobRecoveryInput,
  ComposeLocalAgentInput,
  CuratorAuthor,
  DraftAuthoringPort,
  JobRecoveryHost,
  LocalAgentHost,
  RunExecutionPort,
  AcquireWriterLeaseOutcome,
  HeartbeatLeaseOutcome,
  LeaseOperationOptions,
  ReadWriterLeaseOutcome,
  ReleaseLeaseOutcome,
} from '@vostride/agent-qa-agent-local'
import {
  asRunId,
  DEFAULT_EMBEDDING_PROFILE,
} from '@vostride/agent-qa-schema'

import { analyticsRunId } from '@vostride/agent-qa-analytics'

import { analyticsEvent } from '../composition/analytics-host.js'
import type { CliAnalyticsHost } from '../composition/analytics-host.js'
import { createShutdownController } from '../commands/shutdown-controller.js'
import {
  completedRunDir,
  completedRunHandoffPath,
  completedRunsRoot,
  curateCompletedRun,
  defaultCurationTailOperations,
  type CurationTailOperations,
  type CurationWriterAuthority,
} from '../curation/curation-tail.js'
import { recoverPendingPostVerdictContinuations } from '../curation/post-verdict-continuation.js'
import { DRAIN_BUDGET_MS } from '@vostride/agent-qa-agent-local'
import { exercisedAnchors } from '../curation/handoff-anchors.js'
import {
  appendDrainSessionReceipt,
  type DrainSessionReceipt,
} from './drain-receipts.js'
import { appendDaemonEvent } from './events.js'
import type { DaemonEvent } from './events.js'
import {
  currentInvokeAgentProduct,
  DAEMON_FUNCTION_CALLER,
  DAEMON_IDENTITY_SCHEMA_VERSION,
  daemonSocketOwnershipFor,
  daemonSocketPath,
  startInvokeServer,
  unlinkDaemonSocket,
  type DaemonSocketOwnership,
  type InvokeServerHandle,
  type StartInvokeServerOptions,
} from './server.js'
import {
  classifyDaemonRegistration,
  DAEMON_REGISTRATION_SCHEMA_VERSION,
  readDaemonRegistration,
  removeRegistrationIfOwned,
  writeDaemonRegistration,
} from './registration.js'
import type {
  ClassifyDaemonRegistrationInput,
  ClassifyDaemonRegistrationOutcome,
  RemoveRegistrationOutcome,
} from './registration.js'
import type { DaemonRegistration } from './registration.js'
import {
  createJobDispatcher,
  type JobDispatcher,
} from './job-dispatcher.js'
import {
  HEARTBEAT_SUPERVISOR_STOP_TIMEOUT_MS,
  startHeartbeatSupervisor,
  type HeartbeatSupervisorHandle,
  type HeartbeatSupervisorMessage,
  type StartHeartbeatSupervisorOptions,
} from './heartbeat-supervisor.js'

/** Provisional daemon heartbeat interval; retune from operational evidence without adding config. */
export const LEASE_HEARTBEAT_INTERVAL_MS = 10_000

/** Provisional lost-nudge backstop; retune from operational evidence without adding config. */
export const CURATION_QUEUE_POLL_MS = 30_000

/** Provisional writer-maintenance cadence; retune from operational evidence without adding config. */
export const MAINTENANCE_CADENCE_MS = 300_000

/** Provisional synchronous drain wait; retune from operational evidence without adding config. */
export const DRAIN_WAIT_TIMEOUT_MS = 120_000

/** Provisional graceful-stop backstop; includes all worker termination bounds plus scheduling. */
export const DAEMON_SHUTDOWN_GRACE_MS =
  (EMBEDDER_WORKER_TERM_GRACE_MS * 2) + HEARTBEAT_SUPERVISOR_STOP_TIMEOUT_MS + 1_000

/** Provisional worker residency window; retune from daemon telemetry without adding config. */
export const EMBEDDER_WORKER_IDLE_MS = 300_000

/** Bound each captured worker stream before it is attributed to the daemon event log. */
export const EMBEDDER_WORKER_OUTPUT_CAP_BYTES = 65_536

export { EMBEDDER_WORKER_START_TIMEOUT_MS, EMBEDDER_WORKER_TERM_GRACE_MS }

export type EmbedderWorkerRegistration = Extract<
  ReturnType<typeof LOCAL_DAEMON_CAPABILITIES.readEmbedderWorkerRegistration>,
  { kind: 'parsed' }
>['registration']
type ReadEmbedderWorkerRegistrationOutcome = ReturnType<
  typeof LOCAL_DAEMON_CAPABILITIES.readEmbedderWorkerRegistration
>

// 2026-08-23 — D-04: THE TYPED BUS EVENT LOG IS THE RUN'S RECORD, and the two run-scoped capture
// constants that used to live on this line are gone with the child that produced them.
//
// The daemon answered `runs.start` by spawning a piped `agent-qa run`, tee-ing the child's stdout
// and stderr into `run-child.stdout.log` / `run-child.stderr.log` beside the run, and recording a
// `run-child-exit` daemon event carrying the child's exit code. All three retire together: the run
// now happens IN THIS PROCESS, so there is no second process whose console output could be a
// record of anything, and the run's own `events.jsonl` — written by the v49 bus, typed, ordered and
// already the thing every reader reads — is the successor (runner.md §3's own words).
//
// ANYTHING LATER FOUND MISSING GETS A TYPED EVENT, NEVER A STDOUT TEE. No console-capture shim, no
// untyped side channel re-minted under another name. The daemon event kept from the old pair is
// renamed to `run-completed` (`runId` + `outcome`) because that is the fact it now records; the
// rename is asserted, not merely described, by `__tests__/daemon-run-execution.test.ts`.

export type DaemonHostTraceStep =
  | 'posture-pinned'
  | 'lease-acquired'
  | 'recovery-composed'
  | 'epoch-adopted'
  | 'claims-recovered'
  | 'local-agent-composed'
  | 'jobs-opened'
  | 'registration-written'
  | 'heartbeat-started'
  | 'shutdown-started'
  | 'lease-released'
  | 'registration-removed'

export interface DaemonHostLogger {
  info(message: string): void
  error(message: string): void
}

export interface EmbedderWorkerSpawnOptions {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly stdio: readonly ['ignore', 'pipe', 'pipe']
}

export type DaemonShutdownStage =
  | 'heartbeatSupervisor.stop'
  | 'invokeServer.close'
  | 'drainWorker'
  | 'maintenanceWorker'
  | 'stopEmbedderWorker'
  | 'jobDispatcher.stop'
  | 'localAgent.close'
  | 'releaseLease'

export interface DaemonHostOperations {
  recoverPendingPostVerdictContinuations: typeof recoverPendingPostVerdictContinuations
  /** Test-only scheduler seam; production uses libuv's monotonic timer scheduling. */
  setInterval(callback: () => void, intervalMs: number): ReturnType<typeof setInterval>
  clearInterval(timer: ReturnType<typeof setInterval>): void
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>
  clearTimeout(timer: ReturnType<typeof setTimeout>): void
  /** Wall-clock epoch milliseconds for registration and human elapsed-time rendering only. */
  now(): number
  onSignal(signal: NodeJS.Signals, listener: () => void): void
  offSignal(signal: NodeJS.Signals, listener: () => void): void
  hardExit(code: number): void
  /** Focused failure-injection seam around each awaited shutdown stage. */
  runShutdownStage(
    stage: DaemonShutdownStage,
    action: () => void | Promise<void>,
  ): Promise<void>
  startHeartbeatSupervisor(
    options: StartHeartbeatSupervisorOptions,
  ): Promise<HeartbeatSupervisorHandle>
  acquireWriterLease(knowledgeRoot: string): AcquireWriterLeaseOutcome
  heartbeatLease(options: LeaseOperationOptions): HeartbeatLeaseOutcome
  releaseLease(options: LeaseOperationOptions): ReleaseLeaseOutcome
  composeJobRecovery(input: ComposeJobRecoveryInput): JobRecoveryHost
  composeLocalAgent(input: ComposeLocalAgentInput): LocalAgentHost
  appendDaemonEvent(agentQaRoot: string, event: DaemonEvent): void
  writeDaemonRegistration(agentQaRoot: string, registration: DaemonRegistration): void
  removeRegistrationIfOwned(agentQaRoot: string, instanceId: string): RemoveRegistrationOutcome
  unlinkDaemonSocket(socketPath: string, ownership: DaemonSocketOwnership): boolean
  classifyDaemonRegistration(
    input: ClassifyDaemonRegistrationInput,
  ): Promise<ClassifyDaemonRegistrationOutcome>
  startInvokeServer(options: StartInvokeServerOptions): Promise<InvokeServerHandle>
  countRemainingCurationWork: typeof LOCAL_DAEMON_CAPABILITIES.countRemainingCurationWork
  inspectDrainableCurationWork: typeof LOCAL_DAEMON_CAPABILITIES.inspectDrainableCurationWork
  listQueuedCandidates(knowledgeRoot: string): string[]
  acquireEmbedder: typeof LOCAL_DAEMON_CAPABILITIES.acquireEmbedder
  drainQueue: typeof LOCAL_DAEMON_CAPABILITIES.drainQueue
  runMaintenanceTail: typeof LOCAL_DAEMON_CAPABILITIES.runMaintenanceTail
  /**
   * The 393 CR-02 projection-version backfill, on THIS host too (round 6, CR-02-daemon). Typed
   * from the curation-tail operations member it mirrors and default-wired from the same
   * `defaultCurationTailOperations()` the daemon already imports, so the two hosts invoke ONE
   * body: the daemon reaches the projection module through the tail's composition, never by a
   * new import edge of its own.
   */
  reconcileRunOutcomesProjection: CurationTailOperations['reconcileRunOutcomesProjection']
  /**
   * The D-06 entity-index sweep. Lease-free by contract: it writes only the projection's own
   * database file, so it is registered on its own cadence and never inside the lease-gated
   * maintenance tail (see ENTITY_INDEX_SWEEP_INTERVAL_MS).
   */
  sweepEntityIndexProjection: typeof sweepEntityIndexProjection
  appendDrainSessionReceipt(agentQaRoot: string, receipt: DrainSessionReceipt): void
  resolveEmbedderWorkerEntryPath(): string
  spawnEmbedderWorker(options: EmbedderWorkerSpawnOptions): ChildProcess
  waitForEmbedderWorkerReady(
    agentQaRoot: string,
    pid: number | undefined,
    instanceId: string,
    signal: AbortSignal,
  ): Promise<EmbedderWorkerRegistration>
  readEmbedderWorkerRegistration(agentQaRoot: string): ReadEmbedderWorkerRegistrationOutcome
  embedderWorkerProcessIsAlive(pid: number): boolean
  embedderWorkerSocketPath(
    agentQaRoot: string,
    projectRoot: string,
    instanceId: string,
  ): string
  probeEmbedderWorkerSocket(socketPath: string): Promise<boolean>
  verifyEmbedderWorkerIncarnation:
    typeof LOCAL_DAEMON_CAPABILITIES.verifyEmbedderWorkerIncarnation
  signalEmbedderWorkerProcess(pid: number, signal: NodeJS.Signals): boolean
  waitForEmbedderWorkerProcessExit(pid: number, timeoutMs: number): Promise<boolean>
  unlinkEmbedderWorkerSocket(socketPath: string): void
  removeEmbedderWorkerRegistration(
    agentQaRoot: string,
    expected: EmbedderWorkerRegistration,
  ): boolean
  resetEmbedderCapability(): void
  randomUUID(): string
  trace?(step: DaemonHostTraceStep): void
}

export interface DaemonHostOptions {
  /** The project's runtime root (`<config-dir>/.agent-qa`), always absolute. */
  agentQaRoot: string
  /** The project's writer-gated knowledge root, always absolute. */
  knowledgeRoot: string
  /** Masked project configuration supplied to the one local composition root. */
  config: ConfigReaderPort
  /** Already-host-owned model factory; agent-local never constructs a provider. */
  model: () => JobModelCapability | Promise<JobModelCapability>
  /**
   * The analyze-run author's compaction budget factory (389-06), derived by the caller
   * from the SAME profile resolution as `model` (386 D-15). Resolved once at queue open
   * by the shared composition; absent or `undefined`-answering means no ladder.
   */
  analysisTokenBudget?: ComposeLocalAgentInput['analysisTokenBudget']
  /** Lazy so an idle daemon does not resolve curation credentials until work appears. */
  author?: () => CuratorAuthor | Promise<CuratorAuthor>
  /** Explicit test/embedding override; it wins over the production Plan 08 binding. */
  runExecution?: RunExecutionPort
  /** Exact resolved project config path. Presence binds the production run executor. */
  configPath?: string
  /** Plan 05 binds the recorded path to the live invoke server. */
  socketPath?: string
  /**
   * The invocation's composed analytics (398-10, D-17/D-18).
   *
   * A PARAMETER, like every other capability this host is handed. `commands/daemon.ts` composes it
   * once at its root; this module emits through the port it is given and composes nothing, which is
   * what keeps the opt-out decision in one place for the process. Absent means a host with no
   * analytics — every legacy and test caller — and the emission sites below are then no-ops.
   */
  analytics?: CliAnalyticsHost
  logger?: DaemonHostLogger
  /** Test-only operations table. Production callers omit it. */
  operations?: Partial<DaemonHostOperations>
}

const DEFAULT_LOGGER: DaemonHostLogger = {
  info: (message) => console.log(message),
  error: (message) => console.error(message),
}

async function waitForEmbedderWorkerReady(
  agentQaRoot: string,
  pid: number | undefined,
  instanceId: string,
  signal: AbortSignal,
): Promise<EmbedderWorkerRegistration> {
  while (!signal.aborted) {
    const outcome = LOCAL_DAEMON_CAPABILITIES.readEmbedderWorkerRegistration(agentQaRoot)
    if (
      outcome.kind === 'parsed'
      && (pid === undefined || outcome.registration.pid === pid)
      && outcome.registration.instanceId === instanceId
    ) {
      return outcome.registration
    }
    if (outcome.kind === 'malformed') {
      throw new Error('Embedder worker registration is malformed')
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        clearTimeout(timer)
        reject(signal.reason)
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, 25)
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
  }
  throw signal.reason
}

function signalEmbedderWorkerProcess(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

async function waitForEmbedderWorkerProcessExit(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (LOCAL_DAEMON_CAPABILITIES.embedderWorkerProcessIsAlive(pid)) {
    if (Date.now() >= deadline) return false
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
  return true
}

function defaultOperations(): DaemonHostOperations {
  return {
    recoverPendingPostVerdictContinuations,
    setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
    clearInterval: (timer) => clearInterval(timer),
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (timer) => clearTimeout(timer),
    now: () => Date.now(),
    onSignal: (signal, listener) => process.on(signal, listener),
    offSignal: (signal, listener) => process.off(signal, listener),
    hardExit: (code) => process.exit(code),
    runShutdownStage: async (_stage, action) => {
      await action()
    },
    startHeartbeatSupervisor,
    acquireWriterLease: LOCAL_DAEMON_CAPABILITIES.acquireWriterLease,
    heartbeatLease: LOCAL_DAEMON_CAPABILITIES.heartbeatLease,
    releaseLease: LOCAL_DAEMON_CAPABILITIES.releaseLease,
    composeJobRecovery,
    composeLocalAgent,
    appendDaemonEvent,
    writeDaemonRegistration,
    removeRegistrationIfOwned,
    unlinkDaemonSocket,
    classifyDaemonRegistration,
    startInvokeServer,
    countRemainingCurationWork: LOCAL_DAEMON_CAPABILITIES.countRemainingCurationWork,
    inspectDrainableCurationWork: LOCAL_DAEMON_CAPABILITIES.inspectDrainableCurationWork,
    listQueuedCandidates: LOCAL_DAEMON_CAPABILITIES.listQueuedCandidates,
    acquireEmbedder: LOCAL_DAEMON_CAPABILITIES.acquireEmbedder,
    drainQueue: LOCAL_DAEMON_CAPABILITIES.drainQueue,
    runMaintenanceTail: LOCAL_DAEMON_CAPABILITIES.runMaintenanceTail,
    reconcileRunOutcomesProjection:
      defaultCurationTailOperations().reconcileRunOutcomesProjection,
    sweepEntityIndexProjection,
    appendDrainSessionReceipt,
    resolveEmbedderWorkerEntryPath: LOCAL_DAEMON_CAPABILITIES.resolveEmbedderWorkerEntryPath,
    spawnEmbedderWorker: (options) => spawn(
      options.command,
      [...options.args],
      {
        cwd: options.cwd,
        stdio: [...options.stdio],
      },
    ),
    waitForEmbedderWorkerReady,
    readEmbedderWorkerRegistration: LOCAL_DAEMON_CAPABILITIES.readEmbedderWorkerRegistration,
    embedderWorkerProcessIsAlive: LOCAL_DAEMON_CAPABILITIES.embedderWorkerProcessIsAlive,
    embedderWorkerSocketPath: LOCAL_DAEMON_CAPABILITIES.embedderWorkerSocketPath,
    probeEmbedderWorkerSocket: LOCAL_DAEMON_CAPABILITIES.probeEmbedderWorkerSocket,
    verifyEmbedderWorkerIncarnation:
      LOCAL_DAEMON_CAPABILITIES.verifyEmbedderWorkerIncarnation,
    signalEmbedderWorkerProcess,
    waitForEmbedderWorkerProcessExit,
    unlinkEmbedderWorkerSocket: (socketPath) => rmSync(socketPath, { force: true }),
    removeEmbedderWorkerRegistration:
      LOCAL_DAEMON_CAPABILITIES.removeEmbedderWorkerRegistration,
    resetEmbedderCapability: LOCAL_DAEMON_CAPABILITIES.resetEmbedderCapability,
    randomUUID,
  }
}

function heldMessage(
  holder: Extract<AcquireWriterLeaseOutcome, { kind: 'held' }>['holder'],
): string {
  return (
    `agent-qa daemon is already running (pid ${holder.pid}; ` +
    `lease heartbeat since ${new Date(holder.heartbeatAtMs).toISOString()})`
  )
}

/**
 * The same refusal, for the case where the holder could not be read at all.
 *
 * CR-01 (round 5): `unreachable-lease-fresh` now covers an unreadable `.lease`, and there is no
 * holder payload to name because the file that carries it is the file that would not open. Naming
 * the errno instead is what makes the refusal actionable — the operator sees EACCES on a specific
 * file rather than a daemon refusing to start for no stated reason.
 */
function unreadableLeaseMessage(lease: ReadWriterLeaseOutcome): string {
  const cause = lease.kind === 'unreadable' ? lease.code : lease.kind
  return (
    `agent-qa daemon writer lease is unreadable (${cause}); refusing to overwrite a registration `
    + `whose authority state cannot be read`
  )
}

function liveRegistrationMessage(
  registration: Pick<DaemonRegistration, 'pid' | 'startedAtMs'>,
): string {
  return (
    `agent-qa daemon is already running (pid ${registration.pid}; ` +
    `daemon registration since ${new Date(registration.startedAtMs).toISOString()})`
  )
}

interface CapturedWorkerOutput {
  readonly read: () => string
  readonly wasTruncated: () => boolean
}

function captureWorkerOutput(stream: Readable): CapturedWorkerOutput {
  const chunks: Buffer[] = []
  let capturedBytes = 0
  let truncated = false
  stream.on('data', (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    const remaining = EMBEDDER_WORKER_OUTPUT_CAP_BYTES - capturedBytes
    if (remaining > 0) {
      const captured = buffer.subarray(0, remaining)
      chunks.push(captured)
      capturedBytes += captured.byteLength
    }
    if (buffer.byteLength > remaining) truncated = true
  })
  return {
    read: () => Buffer.concat(chunks).toString('utf8'),
    wasTruncated: () => truncated,
  }
}

/**
 * The quarantine identity mint this daemon composes with (390-12 / D-01).
 *
 * Two arms, on the same `configPath` branch this file already uses for the run executor (:268 —
 * production always resolves it in `commands/daemon.ts`; legacy and test hosts omit it):
 *
 *  - PRESENT: pre-bind core's one recipe to the workspace's own config directory, through
 *    `createQuarantineIdentityMint` in the CLI composition module. Deferred exactly as the run
 *    executor is, for the same two reasons stated there and in that module's head: it keeps a
 *    configPath-less host independent of the CLI composition graph, and the mint's dependency on
 *    `@vostride/agent-qa-core` belongs in the one surface file the FUNC-02 firewall ledger already
 *    clears for it — that ledger only ever shrinks, so new surface code may not join it.
 *  - ABSENT: FAIL CLOSED. A host with no checkout root cannot mint an identity, and the wrong
 *    answer here is the pass-through: it would store whatever a caller typed into a COMMITTED file
 *    that every later checkout inherits. Throwing means such a host simply has no working
 *    `quarantine.add`/`release`, which the verbs surface as `QuarantineIdentityRefusedError`.
 */
async function resolveQuarantineIdentityMint(
  configPath: string | undefined,
): Promise<(filePath: string) => string> {
  if (configPath === undefined) {
    return (filePath: string) => {
      throw new Error(
        'this daemon was composed without a workspace config path, so it cannot mint the '
          + 'workspace-relative quarantine identity the committed ledger is keyed on: '
          + filePath,
      )
    }
  }
  const { createQuarantineIdentityMint } = await import('../composition/local-agent-host.js')
  return createQuarantineIdentityMint(configPath)
}

/**
 * The keep-gate evaluator's host half for this daemon (393 D-01), or nothing.
 *
 * REACHED THROUGH A DEFERRED IMPORT, and the mechanism is not a lint dodge — it is the rule this
 * file's own head already follows twice. The implementation needs `parseTestFile` and
 * `workspaceRelativeIdentityPath` from `@vostride/agent-qa-core`; the FUNC-02 surface firewall
 * waives an exact (file, specifier) PAIR and `daemon/host.ts` holds no entry for core; and the
 * ledger only ever SHRINKS, so a new leak in a file written after 2026-07-28 is fixed rather than
 * waived. `composition/local-agent-host.ts` already carries the pair, so the factory is minted
 * there and reached from here exactly as `createQuarantineIdentityMint` (390-12) is. The import also keeps the CLI composition graph out of a
 * `configPath`-less legacy or test host, which is the second reason all three are deferred.
 *
 * ABSENT WHERE THERE IS NO CONFIG PATH, and the absence is the report. A host with no workspace
 * cannot resolve a checkout root, so it cannot mint the identity gates 1-2 join on nor enumerate
 * the suite gate 3 compares against — which makes it a host that cannot verify a draft. Omitting
 * the field lists `authoring.draft.verify` as `unbound` BY NAME (D-09), where the quarantine mint
 * one function up instead binds a THROWING closure: the difference is that the mint is REQUIRED by
 * the composition and this is optional, so this one can express the same fact structurally rather
 * than at the first call.
 */
async function resolveDraftAuthoring(
  configPath: string | undefined,
): Promise<DraftAuthoringPort | undefined> {
  if (configPath === undefined) return undefined
  const { createDraftAuthoringPort } = await import('../composition/local-agent-host.js')
  return createDraftAuthoringPort(configPath)
}

/**
 * 2026-10-02 (quick 261002-mrk, 432-13 #1): this daemon's mark host, which a CLI, dashboard or MCP
 * mark is handed to whole while this daemon holds the writer lease. It commits with the lease this
 * process owns and binds no delegate. Deferred import for the same reasons as the resolvers above;
 * absent without a config path, where `runs.mark` stays `unbound` by name.
 */
async function resolveHolderFeedback(input: {
  readonly configPath: string | undefined
  readonly agentQaRoot: string
  readonly knowledgeRoot: string
  readonly authority: () => { readonly leaseId: string; readonly epoch: number }
  readonly registry: () => LocalAgentHost['registry']
}): Promise<ComposeLocalAgentInput['feedback']> {
  if (input.configPath === undefined) return undefined
  const { createLeaseHolderFeedbackPort } = await import('../composition/local-agent-host.js')
  return createLeaseHolderFeedbackPort({
    configPath: input.configPath,
    agentQaRoot: input.agentQaRoot,
    writerAuthority: { knowledgeRoot: input.knowledgeRoot, authority: input.authority },
    registry: input.registry,
    caller: DAEMON_FUNCTION_CALLER,
  })
}

/**
 * Compose this daemon's run execution over the ONE in-process drive (401-06, D-01/D-04/D-07).
 *
 * REACHED THROUGH A DEFERRED IMPORT, for the same two reasons the three resolvers above are, plus
 * one this seam adds. `composition/in-process-run-execution.ts` imports `commands/run.ts`'s member
 * producers STATICALLY — that is the surface firewall's only legal route for the platform, model
 * and runner vocabulary those producers need — so a static import back from this file would close
 * an ESM cycle at MODULE-EVALUATION time rather than at call time, which is the only kind ESM does
 * not survive. The deferral also keeps the CLI composition graph out of a `configPath`-less legacy
 * or test host, which is what it was written for in the first place.
 *
 * ═══ 2026-08-23 — D-03: THE ACCEPTED CRASH RISK, RECORDED SO AUDITS DO NOT RE-FILE IT ═══
 *
 * A dispatched run now executes IN THIS PROCESS. A hard-crashing run — a native crash, an OOM, an
 * escaped rejection — may therefore take the daemon down with it, and that is the owner's ratified
 * posture rather than an oversight. The reasoning, recorded verbatim in spirit: crash-through is a
 * PLUS, because it surfaces bugs instead of silently handling them. The runner's own budget/abort
 * machinery is the orderly containment for a run that misbehaves within its means, and process
 * death is answered by the daemon's existing restart/resume machinery — the lease, the registration
 * recovery and the fence are all built for a daemon that stopped without saying goodbye.
 *
 * SO THERE IS NO DEFENSIVE CATCH HERE, and a later reader must not add one. The single `catch`
 * below re-throws everything; what it does with what it sees is RECORD, never suppress. The one
 * class it converts into a return is a run that already STARTED and then surfaced a member's
 * framework error, which is the in-process spelling of the child's non-zero exit — the old wire
 * treated that as a real run too, deliberately, and turning it into a rejected `runs.start` would
 * break the ack law for exactly the runs that left evidence behind. An ordinary control-flow
 * failure (an unreadable config, a pattern that matches nothing) is a typed refusal from the drive
 * and never a dead daemon; that is what 401-11's `CliRunInputError` conversion bought.
 */
async function composeDaemonRunExecution(input: {
  readonly configPath: string
  readonly agentQaRoot: string
  readonly analytics: CliAnalyticsHost | undefined
  readonly recordDaemonEvent: (event: DaemonEvent) => void
  readonly logger: DaemonHostLogger
  /**
   * THIS daemon's own writer lease, read per run rather than captured (404 D-05/D-09, Open Q2).
   *
   * A resolver because of an ORDER this composition cannot change: `runExecution` is composed at
   * startup, several steps BEFORE `acquireWriterLease` runs, so a value captured here would always
   * be `undefined`. Read at `execute()` time — which is minutes later, after the lease exists — it
   * is the authority the daemon is actually holding. The same reason `resolveWriterAuthority` on
   * the local-agent composition is a function.
   */
  readonly resolveWriterAuthority: () => CurationWriterAuthority | undefined
}): Promise<RunExecutionPort> {
  const { createRunRecord, doorRunAttributes, resolveRunInvocationInputs } =
    await import('../commands/run.js')
  const { refuseUnhonourableRequestFields, runInProcessCliRun } =
    await import('../composition/in-process-run-execution.js')
  const analytics = input.analytics
  const runSession =
    analytics === undefined ? undefined : await import('../run-session-composition.js')

  /**
   * The one place a dispatched run is known to have finished, and both per-run effects live here.
   *
   * 398-10 (D-18) moved with the wire unchanged. `job_kind: 'run'` and no other arm: the union's
   * kinds are run/suite/recovery/unknown, and the curation drain — this daemon's other queue — is
   * none of them, so reporting it would put a number on a chart saying a job of an unnamed kind
   * happened, which is worse than silence. `duration_ms` stays absent because nothing here measured
   * an interval; a duration off this callback's clock would be the time since this process noticed.
   */
  const recordRunOutcome = (
    host: CliAnalyticsHost | undefined,
    runId: string,
    outcome: 'completed' | 'failed',
  ): void => {
    input.recordDaemonEvent({ kind: 'run-completed', runId, outcome })
    host?.port.capture(
      analyticsEvent(host, 'agent-qa.daemon.job.completed', {
        job_kind: 'run',
        outcome,
        // Through the union's OWN filter: `run_id` is a known-id codec, nothing parses an event on
        // the way to the transport, and a foreign string here would be sent rather than refused.
        // A non-canonical id becomes an absence.
        ...(analyticsRunId(runId) === undefined ? {} : { run_id: runId }),
      }),
    )
  }

  return {
    async execute(request) {
      // 2026-10-21 (447-09, D-14): the job is its submitter's, so it reports the submitter's product.
      const jobAnalytics: CliAnalyticsHost | undefined =
        analytics === undefined
          ? undefined
          : {
              ...analytics,
              properties: {
                ...analytics.properties,
                agent_product: currentInvokeAgentProduct() ?? 'unknown',
              },
            }
      // (0) THE REFUSAL, BEFORE ANYTHING IS READ — and it is made HERE rather than left to the
      // drive's own step (0) because this door reads its own preflight, which happens first. Before
      // 442-08 that preflight loaded auth plugins, so a `runs.start` naming `scope` reported
      // `PluginNotInstalledError` instead of the refusal (`daemon-run-execution.test.ts`).
      refuseUnhonourableRequestFields(request)
      // The request may name another config; the drive resolves against exactly this expression, so
      // a preflight read here that used a different one would resolve a different project.
      const configPath = request.configPath ?? input.configPath
      // THE DOOR READS ITS OWN PREFLIGHT, because the preflight's non-fatal warnings default to
      // `console.warn`, and a daemon's diagnostics belong in the daemon's own log rather than on a
      // console nothing is reading. `inputs` is then handed to the drive, so the config and the
      // secrets file are read once and not twice. (432-13: the preflight's `safety.trustMode` is no
      // longer read — nothing asks, so there is no approval for trust to satisfy.)
      const inputs = await resolveRunInvocationInputs({
        configPath,
        ...(request.patterns === undefined ? {} : { patterns: request.patterns }),
        warn: (message: string) => input.logger.info(message),
      })

      // Read ONCE per run, here, so the conditional spread and the value it spreads are the same
      // reading — two calls could straddle a lease this daemon lost between them.
      const daemonAuthority = input.resolveWriterAuthority()
      // 2026-10-17 (443-06, D-02): the record's incomplete line goes to the daemon's log, never stdout.
      const runRecord = createRunRecord({
        attributes: doorRunAttributes('cli'),
        warn: (line: string) => input.logger.error(line),
      })

      let startedRunId: string | undefined
      try {
        const finished = await runInProcessCliRun(
          {
            configPath,
            agentQaRoot: input.agentQaRoot,
            // D-07: THE POSTURE TRAVELS EXPLICITLY. The startup `pinLocalHeadlessExecutionContext()`
            // STAYS — it is this process's detected context — and every dispatched run records
            // THIS value, so a varied ambient cannot move it. Asserted in
            // `__tests__/daemon-run-execution.test.ts`.
            executionContext: 'local-headless',
            // 432-13 (D-01/D-14): NO APPROVAL POSTURE. The worker injects no confirm and no trust:
            // nothing asks, so a non-production run it is handed starts, and the core refuses a
            // production one before any effect unless the config opts in.
            inputs,
            runRecord,
            // ═══ 2026-08-26 — Phase 404 D-05/D-09: THIS DOOR HANDS OVER ITS OWN LEASE ═══
            //
            // The daemon holds this project's writer lease for its whole lifetime and heartbeats
            // it. Its dispatched runs execute IN THIS PROCESS, so the shell's post-verdict step
            // would consult a lease this very process is holding and be answered `held` — by
            // itself — and report `handedOff` to nobody (RESEARCH Pitfall 3). D-09 says a
            // daemon-launched run drained by the daemon's own pump reads `drained`, so the door
            // that MINTED the lease says so instead of asking.
            //
            // NO SECOND ACQUISITION HAPPENS ON THIS PATH AT ALL, and nothing releases the handed
            // authority either: the step's no-leak backstop deliberately refuses to release a
            // supplied lease (`takeUnclaimedLease`), because that lease is alive and this run is
            // not what ends it.
            //
            // THE ENQUEUE IS THE CORE'S NOW. Before this change the daemon door's runs queued
            // nothing whatsoever — the enqueue lived in `commands/run.ts`'s tail and this door
            // supplies no `afterVerdict`. The step performs it on every door, so the daemon's own
            // pump has something to drain. What this door still supplies is no TAIL: 388 D-13 —
            // the daemon emits no chips, and its pump drains under the lease it already holds.
            ...(daemonAuthority === undefined
              ? {}
              : { postProcessing: { writerAuthority: daemonAuthority } }),
            onSession: (session) => { startedRunId = session.id as unknown as string },
            // 2026-10-21 (447-08, D-16): subscribed directly, because `attachRunSubscribers`'
            // wire reporter can print to stdout.
            ...(jobAnalytics === undefined || runSession === undefined ? {} : {
              subscribers: ({ session }) => {
                const subscriber = runSession.buildAnalyticsRunSubscriber({
                  analytics: jobAnalytics,
                  triggerSource: 'daemon',
                  runner: 'local',
                })
                session.subscribe(runSession.REPLAY_FROM_START, subscriber.handler)
                return { flush: async () => { await subscriber.flush?.() } }
              },
            }),
            warn: (message: string) => input.logger.info(message),
          },
          request,
        )
        // The run's OWN completion. `exitCode` here is `mapVerdictToExitCode(verdict)` and nothing
        // else — this door supplies no `afterVerdict` (see the 404 note above for what that does
        // and no longer does NOT mean), so no fold of its own can have touched it — which is why
        // the outcome is read off it rather than off a second verdict table minted here.
        // Byte-identical semantics to the child's exit code it replaces.
        recordRunOutcome(
          jobAnalytics,
          finished.runId,
          finished.exitCode === 0 ? 'completed' : 'failed',
        )
        return { runId: asRunId(finished.runId) }
      } catch (error) {
        if (error instanceof RunDeniedError) {
          // A refused run is a failed JOB and never a crashed daemon; the refusal itself travels on
          // to the caller with the core's own reason.
          recordRunOutcome(jobAnalytics, error.runId, 'failed')
          throw error
        }
        if (startedRunId === undefined) throw error
        // The run BEGAN and then surfaced a framework error. See the D-03 note above: this is the
        // in-process spelling of a non-zero child exit, the evidence exists, and the composition's
        // own evidence check is what decides whether the ack is real.
        input.logger.error(
          `Dispatched run ${startedRunId} failed: ${error instanceof Error ? error.message : String(error)}`,
        )
        recordRunOutcome(jobAnalytics, startedRunId, 'failed')
        return { runId: asRunId(startedRunId) }
      } finally {
        runRecord.close()
      }
    },
  }
}

/**
 * Run the foreground daemon until a signal or lease-heartbeat refusal closes it.
 *
 * Startup order is part of the safety contract: pin posture, acquire authority, heartbeat once,
 * install the independent heartbeat, then recover and compose under the protected epoch.
 */
export async function runDaemonHost(input: DaemonHostOptions): Promise<number> {
  // D-09: this is deliberately the first effect and is never injectable or TTY-dependent.
  LOCAL_DAEMON_CAPABILITIES.pinLocalHeadlessExecutionContext()

  const operations = { ...defaultOperations(), ...input.operations }
  const logger = input.logger ?? DEFAULT_LOGGER
  const instanceId = randomUUID()
  const recordDaemonEvent = (event: DaemonEvent): void => {
    try {
      operations.appendDaemonEvent(input.agentQaRoot, event)
    } catch (error) {
      logger.error(
        `Daemon event append failed (${event.kind}): ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  /**
   * This daemon's writer lease, filled the moment it is acquired (404 D-05/D-09, Open Q2).
   *
   * Declared HERE because the run-execution composition below happens at startup, well before
   * `acquireWriterLease` runs — see `composeDaemonRunExecution`'s `resolveWriterAuthority` doc. It
   * is written exactly once, and only from the acquisition's own outcome.
   */
  let daemonWriterAuthority: CurationWriterAuthority | undefined

  let runExecution = input.runExecution
  if (runExecution === undefined && input.configPath !== undefined) {
    runExecution = await composeDaemonRunExecution({
      configPath: input.configPath,
      agentQaRoot: input.agentQaRoot,
      analytics: input.analytics,
      recordDaemonEvent,
      logger,
      resolveWriterAuthority: () => daemonWriterAuthority,
    })
  }
  // `operations` is test-only. Legacy injected drain fixtures opt out unless they also provide
  // the worker command seam; production (no operations table) always manages the child.
  const embedderLifecycleEnabled = input.operations?.drainQueue === undefined
    || input.operations.spawnEmbedderWorker !== undefined
  operations.trace?.('posture-pinned')

  type RecoverableRegistration = Extract<
    ClassifyDaemonRegistrationOutcome,
    { kind: 'unreachable-lease-stale' }
  >

  const classifyRegistration = (): Promise<ClassifyDaemonRegistrationOutcome> =>
    operations.classifyDaemonRegistration({
      agentQaRoot: input.agentQaRoot,
      knowledgeRoot: input.knowledgeRoot,
    })

  /**
   * Remove exactly the generation that was classified, and nothing else.
   *
   * The removal compares before it deletes, so two racing successors cannot erase each other's
   * registrations: a file that changed underneath is restored, not obeyed.
   */
  const removeClassifiedRegistration = (classified: RecoverableRegistration): boolean => {
    const outcome = operations.removeRegistrationIfOwned(
      input.agentQaRoot,
      classified.registration.instanceId,
    )
    // A registration that changed mid-removal leaves its predecessor's bytes in quarantine on
    // purpose. Saying so is the whole point of the widened outcome: a stranded file nobody names
    // is indistinguishable from a file that was never there.
    if (outcome.kind === 'changed-under-removal') {
      logger.error(
        `agent-qa daemon registration changed while it was being removed; a newer publication `
        + `holds ${outcome.registrationPath} and the classified generation's bytes are preserved `
        + `at ${outcome.quarantinePath}`,
      )
    }
    return outcome.kind === 'removed'
  }

  const recordRegistrationRecovered = (classified: RecoverableRegistration): void => {
    // V-01: the removal above proved this registration's BYTES — not that the address those bytes
    // record is one this host may delete. `socketPath` is `z.string().min(1)`, so a forged or
    // corrupted daemon.json can name any path on the machine, and obeying it would be a local
    // arbitrary-socket-deletion primitive driven by a file in the runtime root. So the address
    // must also pass `unlinkDaemonSocket`'s ownership proof: the exact generation address the
    // record names.
    //
    // A refusal is recorded as `socketRemoved: false`, never thrown: the registration file is
    // already gone, so failing here would strand a recovery that has otherwise succeeded. The
    // sibling embedder check (`registration names a non-owned socket path`, below) throws instead
    // because it runs BEFORE its own cleanup and has a fresh worker to fall back on.
    const socketPath = classified.registration.socketPath
    const ownership = daemonSocketOwnershipFor(input.agentQaRoot, classified.registration)
    let socketRemoved = false
    try {
      socketRemoved = operations.unlinkDaemonSocket(socketPath, ownership)
    } catch (error) {
      logger.error(
        `agent-qa daemon stale socket cleanup failed (${socketPath}): `
        + (error instanceof Error ? error.message : String(error)),
      )
    }
    recordDaemonEvent({
      kind: 'registration-recovered',
      classification: classified.kind,
      pid: classified.registration.pid,
      instanceId: classified.registration.instanceId,
      socketPath,
      socketRemoved,
    })
  }

  /** Refusals for a classification this host must not overwrite. Absent means nothing to refuse. */
  const refuseRegistration = (
    outcome: ClassifyDaemonRegistrationOutcome,
  ): boolean => {
    if (outcome.kind === 'live-confirmed') {
      logger.error(liveRegistrationMessage(outcome.registration))
      return true
    }
    if (outcome.kind === 'malformed') {
      logger.error('agent-qa daemon registration is malformed; refusing to overwrite it')
      return true
    }
    if (outcome.kind === 'unreachable-lease-fresh') {
      logger.error(
        outcome.holder === undefined
          ? unreadableLeaseMessage(outcome.lease)
          : heldMessage(outcome.holder),
      )
      return true
    }
    return false
  }

  const registrationSnapshot = readDaemonRegistration(input.agentQaRoot)
  const registration = registrationSnapshot.kind === 'parsed'
    ? await classifyRegistration()
    : registrationSnapshot
  if (refuseRegistration(registration)) return 1
  if (registration.kind === 'unreachable-lease-stale') {
    if (removeClassifiedRegistration(registration)) {
      recordRegistrationRecovered(registration)
    } else {
      // The registration changed between classification and cleanup. Never guess at a file this
      // host has not seen: look once more, and fail closed rather than re-race a third writer.
      const reclassified = await classifyRegistration()
      if (refuseRegistration(reclassified)) return 1
      if (reclassified.kind === 'unreachable-lease-stale') {
        if (removeClassifiedRegistration(reclassified)) {
          recordRegistrationRecovered(reclassified)
        } else {
          logger.error(liveRegistrationMessage(reclassified.registration))
          return 1
        }
      }
    }
  }

  const acquired = operations.acquireWriterLease(input.knowledgeRoot)
  if (acquired.kind === 'held') {
    logger.error(heldMessage(acquired.holder))
    return 1
  }
  if (acquired.kind === 'refused') {
    logger.error(
      `agent-qa daemon writer lease acquisition refused [${acquired.reason}]: `
      + acquired.error.message,
    )
    return 1
  }
  operations.trace?.('lease-acquired')
  // 404 D-09: the door's runs now report `drained` off THIS pair rather than re-consulting a lease
  // this process is holding (Pitfall 3).
  daemonWriterAuthority = { leaseId: acquired.leaseId, epoch: acquired.epoch }

  const authority: LeaseOperationOptions = {
    knowledgeRoot: input.knowledgeRoot,
    leaseId: acquired.leaseId,
  }

  let recovery: JobRecoveryHost | undefined
  let localAgent: LocalAgentHost | undefined
  let jobDispatcher: JobDispatcher | undefined
  let registrationWritten = false
  let heartbeatSupervisor: HeartbeatSupervisorHandle | undefined
  let heartbeatSupervisorStarting = false
  let pendingHeartbeatFailure: (() => void) | undefined
  let curationPollTimer: ReturnType<typeof setInterval> | undefined
  let maintenanceTimer: ReturnType<typeof setInterval> | undefined
  let entityIndexSweepTimer: ReturnType<typeof setInterval> | undefined
  let entityIndexSweepWorker: Promise<void> | undefined
  let invokeServer: InvokeServerHandle | undefined
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  let resolveCompletion: ((code: number) => void) | undefined
  let shutdownPromise: Promise<void> | undefined
  let shutdownCompleted = false
  let drainRequested = false
  let drainReceiptRequired = false
  let requestedDrainSessionId: string | undefined
  let activeDrainSessionId: string | undefined
  let drainWorker: Promise<void> | undefined
  let maintenanceWorker: Promise<void> | undefined
  let authorPromise: Promise<CuratorAuthor> | undefined
  let embedderWorkerIdleTimer: ReturnType<typeof setTimeout> | undefined

  type EmbedderWorkerExitReason = 'idle' | 'crash' | 'daemon-stop' | 'start-error' | 'replace'
  interface EmbedderWorkerRuntime {
    readonly mode: 'spawned' | 'adopted'
    readonly child?: ChildProcess
    readonly sessionId: string
    readonly stdout?: CapturedWorkerOutput
    readonly stderr?: CapturedWorkerOutput
    readonly exit: Promise<void>
    readonly resolveExit: () => void
    ready: Promise<void>
    registration?: EmbedderWorkerRegistration
    stopReason?: Exclude<EmbedderWorkerExitReason, 'crash'>
    finished: boolean
  }

  let embedderWorker: EmbedderWorkerRuntime | undefined
  let embedderWorkerEnsure: Promise<EmbedderWorkerRuntime> | undefined

  const completion = new Promise<number>((resolve) => {
    resolveCompletion = resolve
  })

  let controller: ReturnType<typeof createShutdownController> | undefined

  const clearEmbedderWorkerIdleTimer = (): void => {
    if (embedderWorkerIdleTimer === undefined) return
    operations.clearTimeout(embedderWorkerIdleTimer)
    embedderWorkerIdleTimer = undefined
  }

  /**
   * How the adopted arm resolved its identity question, carried onto the exit record.
   *
   * The shutdown leak is only acceptable while it is observable, so the verdict that produced it
   * travels with the fact rather than being reconstructed from timing.
   */
  interface EmbedderWorkerShutdownAttribution {
    readonly signalWithheld: boolean
    readonly incarnationVerdict: ReturnType<
      DaemonHostOperations['verifyEmbedderWorkerIncarnation']
    >
  }

  const finishEmbedderWorkerExit = (
    runtime: EmbedderWorkerRuntime,
    code: number | null,
    signal: NodeJS.Signals | null,
    attribution?: EmbedderWorkerShutdownAttribution,
  ): void => {
    if (runtime.finished) return
    runtime.finished = true
    if (embedderWorker === runtime) {
      clearEmbedderWorkerIdleTimer()
      embedderWorker = undefined
    }

    if (runtime.registration !== undefined) {
      try {
        operations.removeEmbedderWorkerRegistration(
          input.agentQaRoot,
          runtime.registration,
        )
      } catch (error) {
        logger.error(
          `Embedder worker registration cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      try {
        operations.unlinkEmbedderWorkerSocket(runtime.registration.socketPath)
      } catch (error) {
        logger.error(
          `Embedder worker socket cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    try {
      operations.resetEmbedderCapability()
    } catch (error) {
      logger.error(
        `Embedder capability reset failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    try {
      recordDaemonEvent({
        kind: 'embedder-worker-exit',
        sessionId: runtime.sessionId,
        pid: runtime.registration?.pid ?? runtime.child?.pid,
        mode: runtime.mode,
        code,
        signal,
        reason: runtime.stopReason ?? 'crash',
        stdout: runtime.stdout?.read() ?? '',
        stderr: runtime.stderr?.read() ?? '',
        outputTruncated:
          (runtime.stdout?.wasTruncated() ?? false)
          || (runtime.stderr?.wasTruncated() ?? false),
        ...(attribution ?? {}),
      })
    } catch (error) {
      logger.error(
        `Embedder worker exit event failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      runtime.resolveExit()
    }
  }

  const waitForEmbedderWorkerExit = (
    runtime: EmbedderWorkerRuntime,
    timeoutMs: number,
  ): Promise<boolean> => new Promise((resolve) => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    const finish = (exited: boolean): void => {
      if (settled) return
      settled = true
      if (timeout !== undefined) operations.clearTimeout(timeout)
      resolve(exited)
    }
    timeout = operations.setTimeout(() => finish(false), timeoutMs)
    timeout.unref?.()
    void runtime.exit.then(() => finish(true))
  })

  const stopEmbedderWorker = async (
    reason: Exclude<EmbedderWorkerExitReason, 'crash'>,
  ): Promise<void> => {
    const runtime = embedderWorker
    if (runtime === undefined) return
    clearEmbedderWorkerIdleTimer()
    runtime.stopReason ??= reason

    if (runtime.mode === 'adopted') {
      const registration = runtime.registration
      if (registration === undefined) {
        throw new Error('Adopted embedder worker is missing its retained registration')
      }
      // V-03: an adopted worker can die between adoption and shutdown, and its pid can be recycled
      // in that window — the same CR-05 hazard, one layer later. So the same law applies on this
      // kill path as on replacement: only a verified 'match' may be signalled. `mismatch` means the
      // worker is provably gone; `unverifiable` means we cannot say, and a pid we cannot attribute
      // is exactly the pid we must not signal. That is `worker-incarnation.ts`'s own contract
      // ("Neither may be signalled") and 386-32 prohibition #1, now true on both paths.
      //
      // The ratified trade, deliberately NOT the other way round: on a host with no incarnation
      // source every adopted worker is unverifiable, so daemon shutdown leaves it running. That
      // leak is recoverable (one local process, reclaimable by reboot or an operator) and it is
      // observable — the exit record below names `signalWithheld` and the verdict. Signalling an
      // unattributable pid is unrecoverable: the victim is some other program. Do not "fix" the
      // asymmetry by restoring the signal; the leak is the cheaper half of the trade.
      const incarnationVerdict = operations.verifyEmbedderWorkerIncarnation(registration)
      if (incarnationVerdict !== 'match') {
        finishEmbedderWorkerExit(runtime, null, null, {
          signalWithheld: true,
          incarnationVerdict,
        })
        return
      }
      const attribution = { signalWithheld: false, incarnationVerdict } as const
      const termWasSent = operations.signalEmbedderWorkerProcess(registration.pid, 'SIGTERM')
      if (
        await operations.waitForEmbedderWorkerProcessExit(
          registration.pid,
          EMBEDDER_WORKER_TERM_GRACE_MS,
        )
      ) {
        finishEmbedderWorkerExit(runtime, null, termWasSent ? 'SIGTERM' : null, attribution)
        return
      }

      recordDaemonEvent({
        kind: 'embedder-worker-terminate-escalated',
        sessionId: runtime.sessionId,
        pid: registration.pid,
        instanceId: registration.instanceId,
        mode: runtime.mode,
        signal: 'SIGKILL',
        reason,
        ...attribution,
      })
      const killWasSent = operations.signalEmbedderWorkerProcess(registration.pid, 'SIGKILL')
      if (
        await operations.waitForEmbedderWorkerProcessExit(
          registration.pid,
          EMBEDDER_WORKER_TERM_GRACE_MS,
        )
      ) {
        finishEmbedderWorkerExit(runtime, null, killWasSent ? 'SIGKILL' : null, attribution)
        return
      }
      throw new EmbedderWorkerTimeoutError('terminate', EMBEDDER_WORKER_TERM_GRACE_MS)
    }

    const child = runtime.child
    if (child === undefined) throw new Error('Spawned embedder worker is missing its child handle')

    if (child.exitCode !== null || child.signalCode !== null) {
      if (await waitForEmbedderWorkerExit(runtime, EMBEDDER_WORKER_TERM_GRACE_MS)) return
      throw new EmbedderWorkerTimeoutError('terminate', EMBEDDER_WORKER_TERM_GRACE_MS)
    }

    child.kill('SIGTERM')
    if (await waitForEmbedderWorkerExit(runtime, EMBEDDER_WORKER_TERM_GRACE_MS)) return

    recordDaemonEvent({
      kind: 'embedder-worker-terminate-escalated',
      sessionId: runtime.sessionId,
      pid: child.pid,
      mode: runtime.mode,
      signal: 'SIGKILL',
      reason,
    })
    child.kill('SIGKILL')
    if (await waitForEmbedderWorkerExit(runtime, EMBEDDER_WORKER_TERM_GRACE_MS)) return
    throw new EmbedderWorkerTimeoutError('terminate', EMBEDDER_WORKER_TERM_GRACE_MS)
  }

  const cleanOwnedEmbedderWorkerResources = (
    registration: EmbedderWorkerRegistration,
  ): void => {
    operations.removeEmbedderWorkerRegistration(input.agentQaRoot, registration)
    operations.unlinkEmbedderWorkerSocket(registration.socketPath)
    operations.resetEmbedderCapability()
  }

  /**
   * CR-05: the ONLY signal path for a registered worker pid, and it is unreachable without a
   * verified 'match' incarnation verdict at its single call site below.
   */
  const terminateRegisteredEmbedderWorker = async (
    registration: EmbedderWorkerRegistration,
    sessionId: string,
  ): Promise<void> => {
    operations.signalEmbedderWorkerProcess(registration.pid, 'SIGTERM')
    if (
      await operations.waitForEmbedderWorkerProcessExit(
        registration.pid,
        EMBEDDER_WORKER_TERM_GRACE_MS,
      )
    ) return

    recordDaemonEvent({
      kind: 'embedder-worker-terminate-escalated',
      sessionId,
      pid: registration.pid,
      instanceId: registration.instanceId,
      mode: 'orphan-replacement',
      signal: 'SIGKILL',
      reason: 'replace',
    })
    operations.signalEmbedderWorkerProcess(registration.pid, 'SIGKILL')
    if (
      await operations.waitForEmbedderWorkerProcessExit(
        registration.pid,
        EMBEDDER_WORKER_TERM_GRACE_MS,
      )
    ) return
    throw new EmbedderWorkerTimeoutError('terminate', EMBEDDER_WORKER_TERM_GRACE_MS)
  }

  type EmbedderWorkerPreflight =
    | { readonly kind: 'adopt'; readonly registration: EmbedderWorkerRegistration }
    | {
        readonly kind: 'spawn'
        readonly outcome: 'fresh' | 'replaced'
        readonly replacedRegistration?: EmbedderWorkerRegistration
        /** True when a live registered pid was left alone because it could not be attributed. */
        readonly signalWithheld?: boolean
        readonly incarnationVerdict?: 'mismatch' | 'unverifiable'
      }

  const classifyEmbedderWorkerBeforeSpawn = async (
    sessionId: string,
  ): Promise<EmbedderWorkerPreflight> => {
    const projectRoot = dirname(input.agentQaRoot)
    const outcome = operations.readEmbedderWorkerRegistration(input.agentQaRoot)
    if (outcome.kind === 'absent') return { kind: 'spawn', outcome: 'fresh' }
    if (outcome.kind === 'malformed') {
      const registrationPath = join(input.agentQaRoot, EMBEDDER_WORKER_REGISTRATION_FILE)
      throw new Error(
        `Embedder worker registration ${registrationPath} is malformed or was written by an older `
          + 'agent-qa build; refusing to overwrite it. Remove the file once, with no embedder '
          + 'worker running, and the next drain starts a fresh worker.',
      )
    }

    const registration = outcome.registration
    const expectedSocketPath = operations.embedderWorkerSocketPath(
      input.agentQaRoot,
      projectRoot,
      registration.instanceId,
    )
    if (registration.socketPath !== expectedSocketPath) {
      throw new Error('Embedder worker registration names a non-owned socket path')
    }

    // An answering generation socket is stronger evidence than pid identity could ever be: the
    // worker responded on the exact address only its own generation binds. Adoption therefore
    // never consults the incarnation, and never signals.
    const socketAnswers = await operations.probeEmbedderWorkerSocket(registration.socketPath)
    const processIsAlive = operations.embedderWorkerProcessIsAlive(registration.pid)
    const profileMatches = isDeepStrictEqual(registration.profile, DEFAULT_EMBEDDING_PROFILE)
    if (socketAnswers && processIsAlive && profileMatches) {
      return { kind: 'adopt', registration }
    }

    // CR-05: liveness plus a dead socket says the WORKER is gone, not who holds its pid now. The
    // OS-anchored incarnation is the only thing that can tell those apart, and without a 'match'
    // the daemon replaces the worker without touching that process at all — which it can afford to
    // do because the fresh generation binds its own socket and cannot collide with the occupant.
    let signalWithheld = false
    let incarnationVerdict: 'match' | 'mismatch' | 'unverifiable' | undefined
    if (processIsAlive) {
      incarnationVerdict = operations.verifyEmbedderWorkerIncarnation(registration)
      if (incarnationVerdict === 'match') {
        await terminateRegisteredEmbedderWorker(registration, sessionId)
      } else {
        signalWithheld = true
      }
    }
    cleanOwnedEmbedderWorkerResources(registration)
    return {
      kind: 'spawn',
      outcome: 'replaced',
      replacedRegistration: registration,
      signalWithheld,
      ...(incarnationVerdict === 'mismatch' || incarnationVerdict === 'unverifiable'
        ? { incarnationVerdict }
        : {}),
    }
  }

  const adoptEmbedderWorker = (
    sessionId: string,
    registration: EmbedderWorkerRegistration,
  ): EmbedderWorkerRuntime => {
    let resolveExit = (): void => undefined
    const exit = new Promise<void>((resolve) => {
      resolveExit = resolve
    })
    const runtime: EmbedderWorkerRuntime = {
      mode: 'adopted',
      sessionId,
      exit,
      resolveExit,
      ready: Promise.resolve(),
      registration,
      finished: false,
    }
    embedderWorker = runtime
    recordDaemonEvent({
      kind: 'embedder-worker-start',
      sessionId,
      pid: registration.pid,
      instanceId: registration.instanceId,
      modelId: registration.profile.model_id,
      mode: runtime.mode,
      outcome: 'adopted',
    })
    return runtime
  }

  const spawnFreshEmbedderWorker = async (
    sessionId: string,
    preflight: Extract<EmbedderWorkerPreflight, { kind: 'spawn' }>,
  ): Promise<EmbedderWorkerRuntime> => {
    const projectRoot = dirname(input.agentQaRoot)
    const entryPath = operations.resolveEmbedderWorkerEntryPath()
    const workerInstanceId = operations.randomUUID()
    const spawnOptions: EmbedderWorkerSpawnOptions = {
      command: process.execPath,
      args: [
        entryPath,
        projectRoot,
        JSON.stringify(DEFAULT_EMBEDDING_PROFILE),
        workerInstanceId,
      ],
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
    const child = operations.spawnEmbedderWorker(spawnOptions)
    if (child.stdout === null || child.stderr === null) {
      child.kill('SIGTERM')
      throw new Error('Embedder worker stdout/stderr pipes were not created')
    }

    let resolveExit = (): void => undefined
    const exit = new Promise<void>((resolve) => {
      resolveExit = resolve
    })
    const runtime: EmbedderWorkerRuntime = {
      mode: 'spawned',
      child,
      sessionId,
      stdout: captureWorkerOutput(child.stdout),
      stderr: captureWorkerOutput(child.stderr),
      exit,
      resolveExit,
      ready: Promise.resolve(),
      finished: false,
    }
    embedderWorker = runtime
    child.once('error', (error) => {
      logger.error(`Embedder worker spawn error: ${error.message}`)
    })
    child.once('close', (code, signal) => finishEmbedderWorkerExit(runtime, code, signal))

    runtime.ready = (async () => {
      recordDaemonEvent({
        kind: 'embedder-worker-start',
        sessionId,
        pid: child.pid,
        instanceId: workerInstanceId,
        modelId: DEFAULT_EMBEDDING_PROFILE.model_id,
        mode: runtime.mode,
        outcome: preflight.outcome,
        ...(preflight.replacedRegistration === undefined
          ? {}
          : {
            replacedInstanceId: preflight.replacedRegistration.instanceId,
            // The refusal is a durable fact, not a silent one: an operator reading the event log
            // can see that a live registered pid was deliberately left unsignalled and why.
            signalWithheld: preflight.signalWithheld === true,
            ...(preflight.incarnationVerdict === undefined
              ? {}
              : { incarnationVerdict: preflight.incarnationVerdict }),
          }),
      })
      const startAbort = new AbortController()
      const startTimeout = operations.setTimeout(() => {
        startAbort.abort(
          new EmbedderWorkerTimeoutError('start', EMBEDDER_WORKER_START_TIMEOUT_MS),
        )
      }, EMBEDDER_WORKER_START_TIMEOUT_MS)
      startTimeout.unref?.()
      try {
        const registration = await Promise.race([
          operations.waitForEmbedderWorkerReady(
            input.agentQaRoot,
            child.pid,
            workerInstanceId,
            startAbort.signal,
          ),
          runtime.exit.then(() => {
            throw new Error('Embedder worker exited before publishing its registration')
          }),
        ])
        const expectedSocketPath = operations.embedderWorkerSocketPath(
          input.agentQaRoot,
          projectRoot,
          workerInstanceId,
        )
        if (
          registration.socketPath !== expectedSocketPath
          || !isDeepStrictEqual(registration.profile, DEFAULT_EMBEDDING_PROFILE)
        ) {
          throw new Error('Embedder worker published a registration outside its owned generation')
        }
        runtime.registration = registration
      } finally {
        operations.clearTimeout(startTimeout)
        if (!startAbort.signal.aborted) startAbort.abort()
      }
    })()
    try {
      await runtime.ready
    } catch (error) {
      runtime.stopReason ??= 'start-error'
      await stopEmbedderWorker('start-error')
      throw error
    }
    return runtime
  }

  const initializeEmbedderWorker = async (
    sessionId: string,
  ): Promise<EmbedderWorkerRuntime> => {
    const preflight = await classifyEmbedderWorkerBeforeSpawn(sessionId)
    return preflight.kind === 'adopt'
      ? adoptEmbedderWorker(sessionId, preflight.registration)
      : spawnFreshEmbedderWorker(sessionId, preflight)
  }

  const ensureEmbedderWorker = async (sessionId: string): Promise<EmbedderWorkerRuntime> => {
    while (true) {
      const current = embedderWorker
      if (current !== undefined) {
        if (current.stopReason !== undefined) {
          await current.exit
          continue
        }
        clearEmbedderWorkerIdleTimer()
        await current.ready
        if (current.mode === 'adopted') {
          const registration = current.registration
          if (registration === undefined) {
            throw new Error('Adopted embedder worker is missing its retained registration')
          }
          const socketAnswers = await operations.probeEmbedderWorkerSocket(
            registration.socketPath,
          )
          const processIsAlive = operations.embedderWorkerProcessIsAlive(registration.pid)
          if (socketAnswers && processIsAlive) return current
          if (processIsAlive) {
            await stopEmbedderWorker('replace')
          } else {
            current.stopReason = 'replace'
            finishEmbedderWorkerExit(current, null, null)
          }
          continue
        }
        return current
      }

      if (embedderWorkerEnsure !== undefined) return embedderWorkerEnsure
      const pending = initializeEmbedderWorker(sessionId)
      embedderWorkerEnsure = pending
      try {
        return await pending
      } finally {
        if (embedderWorkerEnsure === pending) embedderWorkerEnsure = undefined
      }
    }
  }

  const acquireRequiredEmbedder = () => operations.acquireEmbedder({
    allowDownload: false,
    workerPolicy: 'required',
    agentQaRoot: input.agentQaRoot,
  })

  const armEmbedderWorkerIdleTimer = (runtime: EmbedderWorkerRuntime): void => {
    clearEmbedderWorkerIdleTimer()
    if (shutdownPromise !== undefined || embedderWorker !== runtime) return
    const timer = operations.setTimeout(() => {
      if (embedderWorkerIdleTimer !== timer || embedderWorker !== runtime) return
      embedderWorkerIdleTimer = undefined
      void stopEmbedderWorker('idle').catch((error) => {
        logger.error(
          `Embedder worker idle stop failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
    }, EMBEDDER_WORKER_IDLE_MS)
    timer.unref?.()
    embedderWorkerIdleTimer = timer
  }

  const remainingTotal = (
    work: ReturnType<DaemonHostOperations['countRemainingCurationWork']>,
  ): number => work.queued + work.claimedNonterminal + work.quarantined

  const drainSession = async (
    sessionId: string,
    receiptRequired: boolean,
    deadlineMs: number | undefined,
  ): Promise<void> => {
    const initialWork = operations.inspectDrainableCurationWork({
      knowledgeRoot: input.knowledgeRoot,
      currentLeaseId: acquired.leaseId,
    })
    const initialCandidates = [
      ...initialWork.queuedCandidateIds,
      ...initialWork.recoverableClaimedCandidateIds,
    ]
    if (initialCandidates.length === 0 && !receiptRequired) return
    // Fail fast, before publishing a session start this host cannot serve. The late-arrival path
    // repeats the same named check at its own resolution point below.
    if (initialCandidates.length > 0 && input.author === undefined) {
      throw new Error('Daemon curation requires an author factory')
    }

    const seenCandidateIds = new Set(initialCandidates)
    let jobsProcessed = 0
    let failures = 0
    let quarantined = 0
    let remainingAfter = remainingTotal(operations.countRemainingCurationWork(
      input.knowledgeRoot,
      { currentLeaseId: acquired.leaseId },
    ))
    recordDaemonEvent({
      kind: 'drain-session-start',
      sessionId,
      holderPid: process.pid,
      epoch: acquired.epoch,
    })

    /**
     * WR-01: a receipt-required session may legitimately start with no candidates, and work can
     * arrive between the initial inspection and the loop's first observation. Resolving the author
     * eagerly fixed it to `undefined` for that whole session, so the arrival was drained
     * unauthored. The author is therefore resolved — and the configuration validated — at the
     * first observed candidate, whenever it appears; `authorPromise` still memoizes the factory to
     * at most one invocation per process.
     */
    let curation: { author: CuratorAuthor } | undefined
    const resolveCuration = async (): Promise<{ author: CuratorAuthor }> => {
      const factory = input.author
      if (factory === undefined) {
        throw new Error('Daemon curation requires an author factory')
      }
      return { author: await (authorPromise ??= Promise.resolve(factory())) }
    }
    if (initialCandidates.length > 0) curation = await resolveCuration()
    while (remainingAfter > 0 && (deadlineMs === undefined || operations.now() < deadlineMs)) {
      const observed = operations.inspectDrainableCurationWork({
        knowledgeRoot: input.knowledgeRoot,
        currentLeaseId: acquired.leaseId,
      })
      for (const candidateId of [
        ...observed.queuedCandidateIds,
        ...observed.recoverableClaimedCandidateIds,
      ]) {
        seenCandidateIds.add(candidateId)
      }
      if (
        observed.queuedCandidateIds.length === 0
        && observed.recoverableClaimedCandidateIds.length === 0
      ) {
        break
      }
      const sessionCuration = (curation ??= await resolveCuration())
      let worker: EmbedderWorkerRuntime | undefined
      if (embedderLifecycleEnabled) {
        try {
          worker = await ensureEmbedderWorker(sessionId)
        } catch (error) {
          logger.error(
            `Embedder worker start failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
      const embeddingCapability = embedderLifecycleEnabled
        ? await acquireRequiredEmbedder()
        : { kind: 'deferred' as const, reason: 'worker-unavailable' as const }
      let report: Awaited<ReturnType<DaemonHostOperations['drainQueue']>>
      try {
        report = await operations.drainQueue({
          knowledgeRoot: input.knowledgeRoot,
          budgetMs: deadlineMs === undefined ? 'unbounded' : Math.max(0, deadlineMs - operations.now()),
          lease: { leaseId: acquired.leaseId, epoch: acquired.epoch },
          author: sessionCuration.author,
          executionContext: 'local-headless',
          embeddingCapability,
          maintenance: 'skip',
          onJobLifecycle: (event) => {
            seenCandidateIds.add(event.candidateId)
            recordDaemonEvent({
              kind: event.kind,
              sessionId,
              candidateId: event.candidateId,
              holderPid: process.pid,
              leaseId: acquired.leaseId,
              epoch: acquired.epoch,
            })
          },
        })
      } catch (error) {
        failures += 1
        logger.error(
          `Daemon curation drain failed: ${error instanceof Error ? error.message : String(error)}`,
        )
        remainingAfter = remainingTotal(operations.countRemainingCurationWork(
          input.knowledgeRoot,
          { currentLeaseId: acquired.leaseId },
        ))
        break
      } finally {
        if (worker !== undefined) armEmbedderWorkerIdleTimer(worker)
      }
      for (const entry of report.promotions ?? []) logger.info(renderPromotionLine(entry))
      jobsProcessed += report.jobsProcessed
      failures += report.failures
      quarantined += report.quarantined
      remainingAfter = remainingTotal(operations.countRemainingCurationWork(
        input.knowledgeRoot,
        { currentLeaseId: acquired.leaseId },
      ))
      if (
        remainingAfter > 0
        && (
          report.jobsProcessed === 0
          || report.failures > 0
          || report.quarantined > 0
          || report.requeued > 0
        )
      ) break
    }

    const candidateIds = [...seenCandidateIds].sort()
    const outcome = failures === 0 && quarantined === 0 && remainingAfter === 0
      ? 'completed' as const
      : 'failed' as const
    if (receiptRequired || jobsProcessed > 0 || outcome === 'failed') {
      operations.appendDrainSessionReceipt(input.agentQaRoot, {
        ts: new Date(operations.now()).toISOString(),
        sessionId,
        holderPid: process.pid,
        epoch: acquired.epoch,
        candidateIds,
        remainingAfter,
        outcome,
        failures,
        quarantined,
      })
    }
    recordDaemonEvent({
      kind: 'drain-session-end',
      sessionId,
      holderPid: process.pid,
      epoch: acquired.epoch,
      candidateIds,
      jobsProcessed,
      remainingAfter,
    })
  }

  const serviceDrainRequests = async (): Promise<void> => {
    while (drainRequested && shutdownPromise === undefined) {
      drainRequested = false
      const sessionId = requestedDrainSessionId ?? operations.randomUUID()
      const receiptRequired = drainReceiptRequired
      requestedDrainSessionId = undefined
      drainReceiptRequired = false
      activeDrainSessionId = sessionId
      try {
        const deadlineMs = operations.now() + DRAIN_BUDGET_MS
        if (input.configPath !== undefined) {
          await operations.recoverPendingPostVerdictContinuations({
            agentQaRoot: input.agentQaRoot, configPath: input.configPath,
            knowledgeRoot: input.knowledgeRoot, deadlineMs,
            log: { warn: (message) => logger.error(message) },
            onEnqueued: () => jobDispatcher?.wake(),
          })
        }
        // Config-less legacy hosts cannot recover run preparation and retain their existing
        // unbounded standing curation session. Configured hosts share one recovery/drain budget.
        await drainSession(sessionId, receiptRequired, input.configPath === undefined ? undefined : deadlineMs)
      } finally {
        activeDrainSessionId = undefined
      }
    }
  }

  const requestDrain = (receiptRequired = false): string | undefined => {
    if (shutdownPromise !== undefined) return undefined
    drainRequested = true
    drainReceiptRequired ||= receiptRequired
    // A nudge arriving during an unreceipted cadence pass must identify the
    // follow-up session whose terminal receipt is guaranteed to be written.
    if (activeDrainSessionId !== undefined) {
      requestedDrainSessionId ??= operations.randomUUID()
      return requestedDrainSessionId
    }
    requestedDrainSessionId ??= operations.randomUUID()
    const sessionId = requestedDrainSessionId
    if (drainWorker !== undefined) return sessionId
    drainWorker = serviceDrainRequests()
      .catch((error) => {
        logger.error(
          `Daemon curation drain failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
      .finally(() => {
        drainWorker = undefined
        if (drainRequested && shutdownPromise === undefined) requestDrain()
      })
    return sessionId
  }

  const detachSignals = (): void => {
    if (controller === undefined) return
    const activeController = controller
    controller = undefined
    let firstFailure: unknown
    try {
      operations.offSignal('SIGINT', activeController.handleSignal)
    } catch (error) {
      firstFailure = error
    }
    try {
      operations.offSignal('SIGTERM', activeController.handleSignal)
    } catch (error) {
      firstFailure ??= error
    }
    try {
      activeController.dispose()
    } catch (error) {
      firstFailure ??= error
    }
    if (firstFailure !== undefined) throw firstFailure
  }

  const armShutdownGrace = (): void => {
    if (shutdownCompleted || graceTimer !== undefined) return
    graceTimer = operations.setTimeout(
      () => operations.hardExit(130),
      DAEMON_SHUTDOWN_GRACE_MS,
    )
    graceTimer.unref?.()
  }

  const beginShutdown = (
    requestedCode: number,
    releaseAuthority: boolean,
    reason: 'signal' | 'lease-lost' | 'startup-error',
  ): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise
    const executeShutdown = async (): Promise<void> => {
      const failures: Array<{ stage: string; message: string }> = []
      let exitCode = requestedCode
      const recordShutdownFailure = (stage: string, error: unknown): void => {
        const message = error instanceof Error ? error.message : String(error)
        failures.push({ stage, message })
        try {
          logger.error(`Daemon shutdown stage ${stage} failed: ${message}`)
        } catch {
          // A logger failure must not interrupt cleanup convergence.
        }
        try {
          recordDaemonEvent({
            kind: 'shutdown-stage-failed',
            stage,
            message,
          })
        } catch {
          // Event recording is best-effort and already reports its own sink failures.
        }
      }
      const runStage = async (
        stage: DaemonShutdownStage,
        action: () => void | Promise<void>,
      ): Promise<void> => {
        try {
          await operations.runShutdownStage(stage, action)
        } catch (error) {
          recordShutdownFailure(stage, error)
        }
      }
      const runSyncCleanup = (stage: string, action: () => void): void => {
        try {
          action()
        } catch (error) {
          recordShutdownFailure(stage, error)
        }
      }

      try {
        if (reason === 'lease-lost') {
          runSyncCleanup('shutdownGrace.arm', armShutdownGrace)
        }
        runSyncCleanup('shutdown.trace', () => operations.trace?.('shutdown-started'))
        const supervisor = heartbeatSupervisor
        heartbeatSupervisor = undefined
        await runStage('heartbeatSupervisor.stop', async () => {
          await supervisor?.stop()
        })
        if (curationPollTimer !== undefined) {
          const timer = curationPollTimer
          curationPollTimer = undefined
          runSyncCleanup('curationPollTimer.clear', () => operations.clearInterval(timer))
        }
        if (maintenanceTimer !== undefined) {
          const timer = maintenanceTimer
          maintenanceTimer = undefined
          runSyncCleanup('maintenanceTimer.clear', () => operations.clearInterval(timer))
        }
        if (entityIndexSweepTimer !== undefined) {
          const timer = entityIndexSweepTimer
          entityIndexSweepTimer = undefined
          runSyncCleanup('entityIndexSweepTimer.clear', () => operations.clearInterval(timer))
        }

        const server = invokeServer
        invokeServer = undefined
        await runStage('invokeServer.close', async () => {
          await server?.close()
        })

        await runStage('drainWorker', async () => {
          await drainWorker
        })
        drainWorker = undefined
        await runStage('maintenanceWorker', async () => {
          await maintenanceWorker
        })
        maintenanceWorker = undefined

        runSyncCleanup('embedderWorkerIdleTimer.clear', clearEmbedderWorkerIdleTimer)
        await runStage('stopEmbedderWorker', async () => {
          await stopEmbedderWorker('daemon-stop')
        })

        const dispatcher = jobDispatcher
        jobDispatcher = undefined
        await runStage('jobDispatcher.stop', async () => {
          await dispatcher?.stop()
        })
        const agent = localAgent
        localAgent = undefined
        await runStage('localAgent.close', async () => {
          await agent?.close()
        })
        const activeRecovery = recovery
        recovery = undefined
        runSyncCleanup('recovery.close', () => activeRecovery?.close())

        if (releaseAuthority) {
          await runStage('releaseLease', () => {
            const released = operations.releaseLease(authority)
            if (released.kind === 'released') {
              operations.trace?.('lease-released')
            } else {
              exitCode = 1
              recordDaemonEvent({
                kind: 'lease-lost',
                reason: released.reason,
                observedEpoch: released.holder?.epoch,
              })
            }
          })
        }
      } catch (error) {
        // The staged helpers should contain failures; this protects convergence from helper bugs.
        recordShutdownFailure('shutdown.unexpected', error)
      } finally {
        if (registrationWritten) {
          registrationWritten = false
          runSyncCleanup('removeRegistrationIfOwned', () => {
            const removed = operations.removeRegistrationIfOwned(
              input.agentQaRoot,
              instanceId,
            )
            if (removed.kind === 'removed') operations.trace?.('registration-removed')
          })
        }
        runSyncCleanup('signals.detach', detachSignals)
        if (graceTimer !== undefined) {
          const timer = graceTimer
          graceTimer = undefined
          runSyncCleanup('shutdownGrace.clear', () => operations.clearTimeout(timer))
        }

        if (failures.length > 0) exitCode = 1
        try {
          recordDaemonEvent({
            kind: 'daemon-stopped',
            exitCode,
            reason,
            failureCount: failures.length,
            failedStages: failures.map((failure) => failure.stage),
            failures,
          })
        } catch {
          // Completion still settles if both the event sink and its logger fail.
        }
        shutdownCompleted = true
        resolveCompletion?.(exitCode)
      }
    }
    // Publish the memo before cleanup begins so even a synchronous re-entrant trigger observes it.
    shutdownPromise = Promise.resolve().then(executeShutdown)
    return shutdownPromise
  }

  const handleHeartbeatMessage = (heartbeat: HeartbeatSupervisorMessage): void => {
    if (shutdownPromise !== undefined) return
    if (heartbeat.kind === 'heartbeated') {
      recordDaemonEvent({
        kind: 'lease-heartbeated',
        pid: heartbeat.holder.pid,
        epoch: heartbeat.holder.epoch,
        heartbeatAtMs: heartbeat.holder.heartbeatAtMs,
      })
      return
    }
    const failAuthority = (): void => {
      if (shutdownPromise !== undefined) return
      if (heartbeat.kind === 'refused') {
        recordDaemonEvent({
          kind: 'lease-lost',
          reason: heartbeat.reason,
          observedEpoch: heartbeat.observedEpoch ?? heartbeat.holder?.epoch,
        })
      } else {
        recordDaemonEvent({
          kind: 'lease-lost',
          reason: 'heartbeat-error',
          detail: `${heartbeat.name}: ${heartbeat.message}`,
        })
      }
      void beginShutdown(1, false, 'lease-lost')
    }
    if (heartbeatSupervisorStarting && heartbeatSupervisor === undefined) {
      pendingHeartbeatFailure ??= failAuthority
      return
    }
    failAuthority()
  }

  const handleUnexpectedHeartbeatExit = (error: Error): void => {
    if (shutdownPromise !== undefined) return
    const failAuthority = (): void => {
      if (shutdownPromise !== undefined) return
      recordDaemonEvent({
        kind: 'lease-lost',
        reason: 'heartbeat-error',
        detail: error.message,
      })
      void beginShutdown(1, false, 'lease-lost')
    }
    if (heartbeatSupervisorStarting && heartbeatSupervisor === undefined) {
      pendingHeartbeatFailure ??= failAuthority
      return
    }
    failAuthority()
  }

  try {
    const initialHeartbeat = operations.heartbeatLease(authority)
    if (initialHeartbeat.kind === 'refused') {
      recordDaemonEvent({
        kind: 'lease-lost',
        reason: initialHeartbeat.reason,
        observedEpoch: initialHeartbeat.observedEpoch ?? initialHeartbeat.holder?.epoch,
      })
      await beginShutdown(1, false, 'lease-lost')
      return await completion
    }

    heartbeatSupervisorStarting = true
    try {
      heartbeatSupervisor = await operations.startHeartbeatSupervisor({
        knowledgeRoot: authority.knowledgeRoot,
        leaseId: authority.leaseId,
        intervalMs: LEASE_HEARTBEAT_INTERVAL_MS,
        onMessage: handleHeartbeatMessage,
        onUnexpectedExit: handleUnexpectedHeartbeatExit,
      })
    } finally {
      heartbeatSupervisorStarting = false
    }
    const startupFailure = pendingHeartbeatFailure
    pendingHeartbeatFailure = undefined
    startupFailure?.()
    if (shutdownPromise !== undefined) {
      await shutdownPromise
      return await completion
    }
    operations.trace?.('heartbeat-started')
    recordDaemonEvent({
      kind: 'lease-acquired',
      pid: process.pid,
      leaseId: acquired.leaseId,
      epoch: acquired.epoch,
    })
    if (acquired.reclaimed !== undefined) {
      recordDaemonEvent({
        kind: 'lease-reclaimed',
        priorHolderPid: acquired.reclaimed.pid,
        priorLeaseId: acquired.reclaimed.leaseId,
        priorEpoch: acquired.reclaimed.epoch,
        newEpoch: acquired.epoch,
      })
    }
    recordDaemonEvent({
      kind: 'epoch-bump',
      epoch: acquired.epoch,
    })
    // The initial beat is heartbeated or refused only; the refusal already shut the host down
    // above, so reaching here means the lease we just acquired was refreshed on disk.
    recordDaemonEvent({
      kind: 'lease-heartbeated',
      pid: initialHeartbeat.holder.pid,
      epoch: initialHeartbeat.holder.epoch,
      heartbeatAtMs: initialHeartbeat.holder.heartbeatAtMs,
    })

    const model = await input.model()
    recovery = operations.composeJobRecovery({
      agentQaRoot: input.agentQaRoot,
      clock: SYSTEM_CLOCK,
      idSource: DIGEST_JOB_ID_SOURCE,
      model,
    })
    operations.trace?.('recovery-composed')
    const fence = await recovery.store.adoptEpoch(acquired.epoch)
    operations.trace?.('epoch-adopted')
    await recovery.recoverAbandonedClaims(fence)
    operations.trace?.('claims-recovered')
    recovery.close()
    recovery = undefined

    // 393 round 6 / CR-02-daemon: ONCE per acquired lease, here.
    //
    // The CLI tail reconciles once per sweep — but `runCurationTail` is unreachable whenever the
    // drain hands off, which is every run's posture while this daemon stands. So a daemon-hosted
    // project's `suite_fingerprints` stayed empty forever and gate 3 silently read a degraded
    // substrate. Once per acquired lease IS the daemon's once-per-sweep analog: it is the one
    // moment per host lifetime at which this process has just become the writer, which is the
    // authority a destructive rebuild needs. THIS PROCESS HOLDS THE LEASE HERE (the `acquired`
    // above), so the rebuild runs under the same authority posture as the tail's without
    // re-acquiring — the 387-08 D-18 shape, where a holder that re-acquires is told `held` by
    // itself. Not inside the `curate-memory` handler below: per job it would put a destructive
    // rebuild candidate on every fold. Keeping it here is also what keeps that handler's
    // two-hosts-one-body invariant true one layer up, where 393-14 first broke it.
    //
    // ISOLATED, on the tail's reasoning: a daemon that cannot reconcile must still serve, so a
    // throw is one logged line and startup continues. The 'rebuilt' arm logs its counts because a
    // silent rebuild of the derived index is exactly the work an operator should see happen.
    try {
      // `completedRunsRoot` rather than a local join: the FUNC-02 surface firewall forbids this
      // file from naming `@vostride/agent-qa-runner-local`, and `RUNS_SUBDIR` must stay the ONE
      // spelling of 'runs' rather than a literal copied into a second host.
      const reconcile = operations.reconcileRunOutcomesProjection({
        knowledgeRoot: input.knowledgeRoot,
        authority: { leaseId: acquired.leaseId, epoch: acquired.epoch },
        runsRoot: completedRunsRoot(input.agentQaRoot),
        extractAnchors: exercisedAnchors,
      })
      if (reconcile.kind === 'skipped') {
        logger.error('daemon: run-outcome projection not reconciled (no writer authority)')
      } else if (reconcile.kind === 'rebuilt') {
        logger.info(
          'daemon: run-outcome projection rebuilt '
          + `(folded ${reconcile.report.folded}, `
          + `skipped ${reconcile.report.skippedHandoffs} handoff, `
          + `${reconcile.report.skippedArtifacts} artifact)`,
        )
      }
    } catch (error) {
      // The tail's body verbatim (393 round 7, WARN-TEXT-CLASS): the same two throw classes reach
      // both catches — one before any DELETE, leaving the family intact under its previous stamp,
      // and one after, leaving it unstamped and possibly partial — so both hosts state the two
      // outcomes as alternatives rather than promising a partway failure that may not have happened.
      logger.error(
        'Daemon startup: the run-outcome projection reconcile did not complete. '
        + 'If the rebuild write phase had already begun, the projection family is left unstamped and possibly'
        + ' partial, and the next reconcile rebuilds it; if it stopped before that, the family and'
        + ' its previous stamp are untouched. Continuing to serve. '
        + `(${error instanceof Error ? error.message : String(error)})`,
      )
    }

    const draftAuthoring = await resolveDraftAuthoring(input.configPath)
    const feedback = await resolveHolderFeedback({
      configPath: input.configPath,
      agentQaRoot: input.agentQaRoot,
      knowledgeRoot: input.knowledgeRoot,
      authority: () => ({ leaseId: acquired.leaseId, epoch: acquired.epoch }),
      registry: () => {
        if (localAgent === undefined) {
          throw new Error('a daemon mark ran before its registry finished composing')
        }
        return localAgent.registry
      },
    })
    localAgent = operations.composeLocalAgent({
      // 2026-10-14 (441-55, D-06): a host with no config path (test hosts only) declares nothing.
      mask: input.configPath === undefined
        ? (text: string) => text
        : (await import('../composition/declared-secrets.js'))
          .createDeclaredSecretMask(input.configPath).mask,
      ...(feedback === undefined ? {} : { feedback }),
      agentQaRoot: input.agentQaRoot,
      config: input.config,
      knowledgeRoot: () => input.knowledgeRoot,
      model: () => model,
      // 390-12 / D-01. Resolved on the `configPath` branch above: bound to the real checkout root
      // in production, fail-closed in a legacy or test host that has none.
      mintQuarantineIdentityPath: await resolveQuarantineIdentityMint(input.configPath),
      // 389-06: the author's compaction budget, host-derived from the same profile
      // resolution as the model above and resolved once at queue open (386 D-15).
      ...(input.analysisTokenBudget === undefined
        ? {}
        : { analysisTokenBudget: input.analysisTokenBudget }),
      // 388 D-01: a `curate-memory` job this daemon claims must perform the SAME v51 per-run
      // fold the CLI tail performs, or the canonical pipeline would have two bodies and the
      // curation chip would depend on which process happened to hold the lease. The authority
      // handed in is the lease this process already owns — the 387-08 D-18 idiom — because a
      // holder that re-acquires is told `held` by itself and has nobody to delegate to.
      postRun: {
        // 2026-10-14 (441-55, 441-01 decision 10): the daemon's posture is unchanged.
        candidateProse: 'no-masker',
        curateRun: async ({ runId: curatedRunId, deadlineMs }) => {
          const factory = input.author
          if (factory === undefined) {
            throw new Error('Daemon curation requires an author factory')
          }
          const curationOperations = defaultCurationTailOperations()
          const handoff = curationOperations.loadCompletedRunHandoff(
            completedRunHandoffPath(input.agentQaRoot, curatedRunId),
          )
          const folded = await curateCompletedRun({
            operations: curationOperations,
            runDir: completedRunDir(input.agentQaRoot, curatedRunId),
            handoff,
            knowledgeRoot: input.knowledgeRoot,
            agentQaRoot: input.agentQaRoot,
            author: await (authorPromise ??= Promise.resolve(factory())),
            authority: { leaseId: acquired.leaseId, epoch: acquired.epoch },
            ...(deadlineMs === undefined ? {} : { deadlineMs }),
            log: {
              warn: (message: string) => logger.error(message),
              info: (message: string) => logger.info(message),
            },
          })
          // WR-03 / D-01: the same fields the CLI binding returns — but the two bindings are
          // NOT equivalent, and the reason is declared one field above: only a leg folding with
          // the declared mask bound may claim the kind that runs the same fold.
          return {
            curated: folded.curated,
            deprecated: folded.deprecated,
            complete: folded.complete,
            ...(folded.snapshot === undefined ? {} : { snapshot: folded.snapshot }),
          }
        },
      },
      ...(runExecution === undefined ? {} : { runExecution }),
      // 393 D-01 / 385 D-15: the SAME keep-gate binding the CLI composes, because both hosts
      // compose the same root. Conditionally spread, so a daemon with no workspace lists the
      // capability `unbound` BY NAME rather than binding one that cannot resolve a draft path.
      ...(draftAuthoring === undefined ? {} : { draftAuthoring }),
      // 432-16 (D-07): no one-commit test-draft apply is bound here or on the CLI host — agent-qa
      // makes no git commits — so both hosts list the pre-432 accept's test-draft route unbound.
      // 387-08 D-18 / D-5: this process IS the writer-lease holder, so an apply it performs hands
      // in the authority it already owns rather than asking for a lease it cannot be granted
      // twice — a holder that calls `acquireWriterLease` is told `held` by itself and then has
      // nobody to delegate to. Same two fields the drain and maintenance paths already pass.
      // Deliberately no `applyDelegate`: authority and delegate are mutually exclusive, and a
      // host supplying both would be claiming to be two places at once.
      resolveWriterAuthority: () => ({ leaseId: acquired.leaseId, epoch: acquired.epoch }),
      clock: SYSTEM_CLOCK,
      idSource: DIGEST_JOB_ID_SOURCE,
    })
    operations.trace?.('local-agent-composed')
    const jobs = await localAgent.jobs()
    operations.trace?.('jobs-opened')
    jobDispatcher = createJobDispatcher({
      queue: jobs.queue,
      fence,
      scheduler: {
        now: operations.now,
        setTimeout: operations.setTimeout,
        clearTimeout: operations.clearTimeout,
      },
      recordEvent: recordDaemonEvent,
      reportError: (error) => logger.error(
        `Daemon agent-job dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    })

    controller = createShutdownController({
      cancel: () => {
        armShutdownGrace()
        void beginShutdown(0, true, 'signal')
      },
      exit: (code) => operations.hardExit(code),
      // A daemon's first signal is a successful operator stop, not a cancelled test verdict.
      setExitCode: () => undefined,
      armGrace: armShutdownGrace,
    })
    operations.onSignal('SIGINT', controller.handleSignal)
    operations.onSignal('SIGTERM', controller.handleSignal)

    // Registration is the readiness commit: handlers are live and the socket must listen first.
    const socketPath = input.socketPath ?? daemonSocketPath(
      input.agentQaRoot,
      dirname(input.agentQaRoot),
      instanceId,
    )
    const startedServer = await operations.startInvokeServer({
      socketPath,
      registry: localAgent.registry,
      identity: {
        schemaVersion: DAEMON_IDENTITY_SCHEMA_VERSION,
        instanceId,
        pid: process.pid,
      },
      onNudge: (nudge) => {
        const sessionId = requestDrain(nudge.requireReceipt)
        jobDispatcher?.wake()
        if (sessionId === undefined) {
          throw new Error('Daemon is shutting down and cannot accept a drain nudge')
        }
        return { sessionId }
      },
    })
    if (shutdownPromise !== undefined) {
      await startedServer.close()
      await shutdownPromise
      return await completion
    }
    invokeServer = startedServer

    operations.writeDaemonRegistration(input.agentQaRoot, {
      schemaVersion: DAEMON_REGISTRATION_SCHEMA_VERSION,
      instanceId,
      pid: process.pid,
      socketPath,
      startedAtMs: operations.now(),
    })
    registrationWritten = true
    operations.trace?.('registration-written')

    curationPollTimer = operations.setInterval(requestDrain, CURATION_QUEUE_POLL_MS)
    if (input.configPath !== undefined) requestDrain()
    maintenanceTimer = operations.setInterval(() => {
      if (shutdownPromise !== undefined || maintenanceWorker !== undefined) return
      maintenanceWorker = (async () => {
        const sessionId = operations.randomUUID()
        let worker: EmbedderWorkerRuntime | undefined
        if (embedderLifecycleEnabled) {
          try {
            worker = await ensureEmbedderWorker(sessionId)
          } catch (error) {
            logger.error(
              `Embedder worker start failed: ${error instanceof Error ? error.message : String(error)}`,
            )
          }
        }
        const embeddingCapability = embedderLifecycleEnabled
          ? await acquireRequiredEmbedder()
          : { kind: 'deferred' as const, reason: 'worker-unavailable' as const }
        try {
          await operations.runMaintenanceTail({
            knowledgeRoot: input.knowledgeRoot,
            lease: { leaseId: acquired.leaseId, epoch: acquired.epoch },
            embeddingCapability,
          })
        } finally {
          if (worker !== undefined) armEmbedderWorkerIdleTimer(worker)
        }
      })()
        .then(() => undefined)
        .catch((error) => {
          recordDaemonEvent({
            kind: 'lease-lost',
            reason:
              typeof error === 'object'
                && error !== null
                && 'reason' in error
                && typeof error.reason === 'string'
                ? error.reason
                : 'maintenance-error',
            observedEpoch:
              typeof error === 'object'
                && error !== null
                && 'observedEpoch' in error
                && typeof error.observedEpoch === 'number'
                ? error.observedEpoch
                : undefined,
            detail: error instanceof Error ? error.message : String(error),
          })
          void beginShutdown(1, false, 'lease-lost')
        })
        .finally(() => {
          maintenanceWorker = undefined
        })
    }, MAINTENANCE_CADENCE_MS)

    // The D-06 projection sweep, on its OWN cadence and deliberately not inside the worker
    // above. That worker holds the writer lease and shuts the daemon down when it loses it;
    // this sweep needs no lease at all, writes only the entity index's own file, and never
    // touches the addressing ledger's rows. Folding it into lease-gated maintenance would have
    // made a lease-free projection stop being maintained the moment a lease was lost, and made
    // a sweep failure look like a lease failure.
    //
    // Re-entrancy guarded the same way, so a slow sweep cannot stack: a tick that arrives while
    // the previous one is still running is dropped rather than queued.
    entityIndexSweepTimer = operations.setInterval(() => {
      if (shutdownPromise !== undefined || entityIndexSweepWorker !== undefined) return
      entityIndexSweepWorker = operations.sweepEntityIndexProjection({
        agentQaRoot: input.agentQaRoot,
        resolveKnowledgeRoot: () => input.knowledgeRoot,
      })
        .then(() => undefined)
        .catch((error: unknown) => {
          // A projection is disposable and a rebuild heals it, so a failed sweep is logged and
          // the daemon carries on. Shutting down over it would let a disposable file take down
          // a host holding the writer lease.
          logger.error(
            `Entity index sweep failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        })
        .finally(() => {
          entityIndexSweepWorker = undefined
        })
    }, ENTITY_INDEX_SWEEP_INTERVAL_MS)

    logger.info(`agent-qa daemon started (pid ${process.pid}, epoch ${acquired.epoch})`)

    return await completion
  } catch (error) {
    await beginShutdown(1, true, 'startup-error')
    throw error
  } finally {
    if (!shutdownCompleted) await beginShutdown(1, true, 'startup-error')
  }
}
