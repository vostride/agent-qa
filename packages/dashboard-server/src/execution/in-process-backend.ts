// THE IN-PROCESS EXECUTION BACKEND (Phase 401 plan 07 — D-01/D-04/D-09/D-12, INVK-01).
//
// WHAT THIS REPLACES. `TestRunner` started a dashboard run by SPAWNING `agent-qa run` and learned
// what happened by scraping `AGENT_QA_EVENT:<json>` lines off the child's stdout. Everything a
// caller could not express became an argv operand, every policy denial died in the child's stderr,
// and liveness had to be inferred from silence — hence a staleness timer and a `treeKill`. This
// backend starts the run IN THIS PROCESS through the gated `runs.start` op and subscribes the
// started run's `RunSession` bus. There is no child, so there is nothing to scrape, nothing to
// SIGKILL and no process group to walk.
//
// 2026-08-27 (405-07, D-19) — THE LEGACY CONSUMER SURFACE IS GONE. This backend used to keep a
// per-run replay buffer with a monotonic `id`, synthesise `run-start` / `run-complete` bookends
// around the real envelopes, and re-emit every frame on a second event for one SSE route. That
// shape existed to be byte-for-byte what the retired stdout scrape produced, so the retirement
// could be measured rather than argued — and it did its job: the parity golden proved the swap.
// 405-03 then removed the browser that read the feed and this plan removes the route, so all of it
// is deleted. What survives is `'run-settled'`, which the HOST reconciles the db row from, and the
// bus subscription itself, which now records exactly one derived fact on the handle: `testName`.
//
// ENVELOPES ARE CARRIED, NEVER RE-MINTED (T-401-20). The bus already publishes the frozen §2.2
// shape `{seq, ts, runId, type, payload}`. This module adds the buffer's `id` and copies; it parses
// nothing, reshapes nothing and invents no field.
//
// SUBSCRIBE FROM THE START — replay-then-live. The session arrives through the run door's
// `onSession` hook, which fires while the run is starting; a subscriber attached at the first seq
// receives everything already published before it, in seq order, and then the live tail. So the
// buffer is whole regardless of how late the bridge attaches, which is what makes the attach a
// wiring detail rather than a race.
//
// AND THE FIRST SEQ IS 1, NOT 0 (401-07, Rule 1 — measured on the live bus). `RunEventBus.subscribe`
// resolves `fromSeq ?? 1` and then REFUSES to serve a gap: a request from below the earliest
// retained seq is answered by reading the event log for the missing prefix, and a prefix it cannot
// supply raises `ReplayIncompleteError` rather than silently starting late (D-07). Seq numbering
// starts at 1, so seq 0 is a prefix that can never exist, and `subscribe(0, …)` therefore throws on
// EVERY run — empty window or not:
//
//   ReplayIncomplete: events before seq 1 are no longer available (replay requested from seq 0)
//
// The bridge attaches inside the core's `onSession`, so that throw would surface as a failure of
// every dashboard-triggered run. `REPLAY_FROM_START` below is the same constant, and the same
// value, `run-session-composition.ts` has always used for this.
//
// IT DEPENDS ON NO AGENT PACKAGE. The run-starter is INJECTED — the whole implementation that names
// `runs.start`, `invokeFunction` and the composed host lives in the CLI's `dashboard` command and is
// handed to `startServer`, exactly as `agentHost` already is. `packages/dashboard-server` may not
// import `agent`, `agent-local` or `safety`, and the arch package tests are the mechanical proof.

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
 *
 * CARRIED VERBATIM FROM `test-runner.ts`. It is a bus-vocabulary reading and always was; the scrape
 * was only how the envelope reached it.
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

// 2026-10-17 (444-02, D-43): the run-level outcome only (`verdict`, `runFinished`); a member's
// finish leaves the handle running, so the active list and `kill` hold for the whole run.
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

/**
 * Start one run and resolve when it is over.
 *
 * REJECTION IS NOT "the run failed" — a failing run resolves. A rejection is a denial, a refused
 * request field, an input error or a crash, and its message is what the dashboard shows as the
 * failure summary. That is the whole user-visible win of the retirement: on the retiring wire a
 * policy denial and a run that never started were the same nothing.
 */
export type InProcessRunStarter = (input: InProcessRunStartInput) => Promise<void>

export interface InProcessExecutionBackendOptions {
  /**
   * How this backend actually starts a run.
   *
   * NAMED `invokeRun` AND NOT `startRun`, which is not a stylistic choice. `startRun` is the RUN
   * SHELL's entry point in `@vostride/agent-qa-runner`, and `run-door-invocation-census.test.ts`
   * makes a complete-set claim over the whole CLI package that no file acquires it — the one legal
   * call site is inside the invocation core, one line below the one `evaluate()`. A second thing
   * called `startRun`, in the CLI file that composes this option, REDS that census; and the census
   * is right to red, because a second spelling of somebody else's symbol is exactly what it exists
   * to refuse. `invokeRun` also says what this one does: it invokes the `runs.start` OP (D-10).
   */
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
  /**
   * The name of the member this run most recently started (405-07, D-19 · RESEARCH D7).
   *
   * RECORDED OFF THE SESSION'S OWN `testStarted`, on the subscription this backend already holds.
   * `/api/execution/active` used to derive it by scanning a per-run event buffer for the same
   * envelope; the buffer is gone, and the scan was the only thing keeping it alive. One string on
   * the handle answers the same question without retaining every frame of every run.
   *
   * UNSET UNTIL THE FIRST MEMBER STARTS. A run between its start and its first `testStarted` has
   * no member name, and that absence is served as an absent field.
   */
  testName?: string
  completionReason?: string
  /** Set the moment a cancel or a timeout is requested, so a session named later is still cancelled. */
  cancelRequested: boolean
  timeoutTimer?: ReturnType<typeof setTimeout>
}

/**
 * The dashboard's in-process `ExecutionBackend`.
 *
 * A CLASS, matching the shape the interface already declared (`extends EventEmitter`), with a
 * factory beside it so a composing host names a function rather than a constructor — nothing here
 * is meant to be subclassed, and nothing needs the `resolveCliBin`-style static the retiring class
 * carried for its binary.
 */
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

    // D-12: a per-run timeout aborts the SESSION. There is no process to signal and no grace period
    // to wait out — `cancel()` is the run's own orderly stop, and the run's terminal verdict then
    // arrives on the bus like any other.
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
            // 2026-10-17 (444-06, D-11, D-43): a cancel leaves the status to the run's own verdict.
            if (mapped !== undefined && handle.status !== 'timeout') handle.status = mapped
            // 405-07 (D-19 · RESEARCH D7): the ONE fact this subscription still derives. The
            // envelope type is `testStarted` and its `payload.name` is the member's name — read
            // here, on the session's own frames, rather than by scanning a buffer of them later.
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
      // 405-07 (D-19): read straight off the handle the subscription writes. This used to scan a
      // per-run buffer for the `testStarted` frame — and before 401-07 it scanned for `test-start`,
      // a v1 reporter name the frozen §2.2 vocabulary never emits, so the field was `undefined` on
      // every run for as long as the derivation lived away from the producer.
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
    // 401-18 (G-401-16): the two facts the host used to have to guess at. 2026-09-30, 432-09 (D-15):
    // a refusal settles as these plain facts; no remedy list is projected or carried.
    let refusedBeforeStart = false
    if (error !== undefined) {
      const message = error instanceof Error ? error.message : String(error)
      for (const line of message.split('\n')) handle.output.push(line)
      // A rejection reaching here without a started session is a refusal or an input error —
      // the run never began. With one, it is a post-start framework error on a run that did.
      //
      // 401-18: THAT DISTINCTION NOW LEAVES THIS FUNCTION. It was computed here and spent on a
      // prefix, so the host had to re-derive it from prose and got it wrong. Same test, carried.
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

    // 405-07 (D-19): a synthetic `run-complete` frame was pushed here, carrying the same status,
    // duration and reason the settle details below carry. It existed because the retired
    // feed and the host's reconciliation were two different readers of the same fact. There is one
    // reader now, so the fact is stated once.
    //
    // `'run-settled'` rather than a constructor callback, so the HOST that owns the db, the queue
    // and the Appium leases can subscribe to a backend somebody else composed — which is the whole
    // shape of the injection (`startServer`'s `agentHost` precedent).
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
