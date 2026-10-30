// Starts the run in this process through `runs.start` and subscribes from seq 1, as 0 throws.

import { EventEmitter } from 'node:events'

import type { RunEventEnvelope, RunSession } from '@vostride/agent-qa-schema'

import type {
  ExecuteOptions,
  ExecutionBackend,
  RunSettledDetails,
} from './execution-backend.js'

/** How long a settled run's handle stays readable before it is dropped. */
const DEFAULT_HANDLE_RETENTION_MS = 5 * 60 * 1000

/**
 * The seq a bridge attaches at to receive the whole run. See the header: the bus numbers from 1 and
 * refuses to serve a prefix it cannot produce, so 0 is not "earlier", it is unserveable.
 */
const REPLAY_FROM_START = 1

export type InProcessRunStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout'

type TerminalProcessStatus = 'completed' | 'failed' | 'cancelled'

/**
 * Map a bus `verdict` / `runFinished.aggregateVerdict` value (the frozen §2.2 envelope vocabulary)
 * onto the run-status ground truth the dashboard's db reconciliation reads. `passed`/`healed` →
 * completed, `cancelled` → cancelled, `failed`/`timeout` → failed. Anything else returns
 * undefined, so the caller leaves the status alone.
 */
function mapOutcomeToRunStatus(outcome: unknown): TerminalProcessStatus | undefined {
  switch (outcome) {
    case 'passed':
    case 'healed':
      return 'completed'
    case 'cancelled':
      return 'cancelled'
    case 'failed':
    case 'timeout':
      return 'failed'
    default:
      return undefined
  }
}

// The run-level outcome only; a member's finish leaves the handle running for the whole run.
export function runStatusFromEnvelope(envelope: RunEventEnvelope): TerminalProcessStatus | undefined {
  const payload = envelope.payload as Record<string, unknown> | undefined
  switch (envelope.type) {
    case 'verdict':
      return mapOutcomeToRunStatus(payload?.verdict)
    case 'runFinished':
      return mapOutcomeToRunStatus(payload?.aggregateVerdict)
    default:
      return undefined
  }
}

/** What the injected starter is handed: the request as data, and where to hand the session back. */
export interface InProcessRunStartInput {
  readonly opts: ExecuteOptions
  /**
   * Called with the started session, as early as the run door can name it.
   *
   * A run that is DENIED never calls this, and that asymmetry is load-bearing: it is the only way
   * the backend can tell a policy refusal apart from a run that started and then failed.
   *
   * (Phrased without a quoted clause after the word `from`: the arch lint's dependency scanner
   * reads that shape as an import specifier and reported this comment as an undeclared external
   * dependency of `packages/dashboard-server`.)
   */
  readonly onSession: (session: RunSession) => void
}

// A failing run resolves; a rejection is a refusal or a crash, and its message is the failure text.
export type InProcessRunStarter = (input: InProcessRunStartInput) => Promise<void>

export interface InProcessExecutionBackendOptions {
  // Not `startRun`, the runner shell's entry point, which a CLI census keeps to one call site.
  readonly invokeRun: InProcessRunStarter
  /** Applied when an `ExecuteOptions` carries no `timeout` of its own. */
  readonly defaultTimeout?: number
  /** How long a settled run's handle survives before it is dropped. */
  readonly retentionMs?: number
}

interface RunHandle {
  runId: string
  status: InProcessRunStatus
  startedAt: Date
  output: string[]
  session?: RunSession
  // Recorded off the session's own `testStarted`; unset until the first member starts.
  testName?: string
  completionReason?: string
  /** Set the moment a cancel or a timeout is requested, so a session named later is still cancelled. */
  cancelRequested: boolean
  timeoutTimer?: ReturnType<typeof setTimeout>
}

export class InProcessExecutionBackend extends EventEmitter implements ExecutionBackend {
  private readonly options: InProcessExecutionBackendOptions
  private readonly handles = new Map<string, RunHandle>()
  private readonly retentionMs: number

  constructor(options: InProcessExecutionBackendOptions) {
    super()
    this.options = options
    this.retentionMs = options.retentionMs ?? DEFAULT_HANDLE_RETENTION_MS
  }

  execute(opts: ExecuteOptions): void {
    const handle: RunHandle = {
      runId: opts.runId,
      status: 'running',
      startedAt: new Date(),
      output: [],
      cancelRequested: false,
    }
    this.handles.set(opts.runId, handle)

    // A per-run timeout cancels the session; the terminal verdict then arrives on the bus.
    const timeoutMs = opts.timeout ?? this.options.defaultTimeout
    if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      const timer = setTimeout(() => {
        if (handle.status !== 'running') return
        handle.cancelRequested = true
        handle.status = 'timeout'
        handle.completionReason = `run timeout after ${String(timeoutMs)}ms`
        handle.session?.cancel()
      }, timeoutMs)
      timer.unref()
      handle.timeoutTimer = timer
    }

    void this.options
      .invokeRun({
        opts,
        onSession: (session) => {
          handle.session = session
          // REPLAY-THEN-LIVE FROM THE FIRST SEQ. Everything published before this attach arrives
          // first, in seq order, and the live tail follows — so the buffer is whole regardless of
          // when the door names the session.
          session.subscribe(REPLAY_FROM_START, (envelope) => {
            const mapped = runStatusFromEnvelope(envelope)
            // A cancel leaves the status to the run's own verdict.
            if (mapped !== undefined && handle.status !== 'timeout') handle.status = mapped
            // The one fact derived here: a `testStarted` payload's `name` is the member's name.
            if (envelope.type === 'testStarted') {
              const startedName = (envelope.payload as { name?: unknown } | undefined)?.name
              if (typeof startedName === 'string') handle.testName = startedName
            }
          })
          // A cancel or a timeout that landed BEFORE the session existed still has to be honoured;
          // otherwise a run cancelled during startup runs to completion.
          if (handle.cancelRequested) session.cancel()
        },
      })
      .then(
        () => { this.settle(handle) },
        (error: unknown) => { this.settle(handle, error) },
      )
  }

  kill(runId: string): boolean {
    const handle = this.handles.get(runId)
    if (!handle || handle.status !== 'running') return false
    handle.cancelRequested = true
    handle.session?.cancel()
    return true
  }

  killAll(): void {
    for (const handle of this.handles.values()) {
      if (handle.status !== 'running') continue
      handle.cancelRequested = true
      handle.session?.cancel()
    }
  }

  getActiveExecutions(): {
    runId: string
    status: string
    startedAt: string
    duration: number
    testName?: string
  }[] {
    const active: {
      runId: string
      status: string
      startedAt: string
      duration: number
      testName?: string
    }[] = []
    for (const handle of this.handles.values()) {
      if (handle.status !== 'running') continue
      // Read straight off the handle the subscription writes.
      active.push({
        runId: handle.runId,
        status: handle.status,
        startedAt: handle.startedAt.toISOString(),
        duration: Date.now() - handle.startedAt.getTime(),
        ...(handle.testName === undefined ? {} : { testName: handle.testName }),
      })
    }
    return active
  }

  private settle(handle: RunHandle, error?: unknown): void {
    if (handle.timeoutTimer) clearTimeout(handle.timeoutTimer)
    let refusedBeforeStart = false
    if (error !== undefined) {
      const message = error instanceof Error ? error.message : String(error)
      for (const line of message.split('\n')) handle.output.push(line)
      // With no started session the rejection is a refusal or input error; with one, a later error.
      refusedBeforeStart = handle.session === undefined
      handle.completionReason = refusedBeforeStart
        ? message
        : `Run failed after start: ${message}`
      if (!handle.cancelRequested) handle.status = 'failed'
    }
    if (handle.status === 'running') {
      handle.status = 'failed'
      handle.completionReason = handle.completionReason ?? 'Run ended before a verdict was reached'
    }

    // `run-settled`, so the host owning db, queue and leases can subscribe to an injected backend.
    const details: RunSettledDetails = {
      ...(handle.completionReason === undefined ? {} : { reason: handle.completionReason }),
      ...(refusedBeforeStart ? { refusedBeforeStart: true as const } : {}),
      output: [...handle.output],
    }
    this.emit('run-settled', handle.runId, handle.status, details)

    const cleanup = setTimeout(() => {
      this.handles.delete(handle.runId)
    }, this.retentionMs)
    cleanup.unref()
  }
}

export function createInProcessExecutionBackend(
  options: InProcessExecutionBackendOptions,
): InProcessExecutionBackend {
  return new InProcessExecutionBackend(options)
}
