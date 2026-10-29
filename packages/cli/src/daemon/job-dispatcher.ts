/**
 * The daemon's resident agent-job pump and the two lifecycle events it records.
 *
 * `job-claimed` and `job-completed` carry an ADDITIVE optional `runId`, read off the claimed
 * job's payload, so an operator reading the ledger can attribute a job — a failed one above all
 * — to its run without correlating sub-second timestamps (406 D-16, closing
 * `399-friction-daemon-events-no-runid`). Nothing else from the payload crosses onto an event:
 * the daemon holds no masker, and the failure reason stays in the job store where it is read
 * through a seam that does.
 */
import type {
  AgentJobQueue,
  JobStoreFence,
  RunNextJobOutcome,
} from '@vostride/agent-qa-agent'
import { JOB_RECOVERY_MAX_RESUMED_JOBS } from '@vostride/agent-qa-agent-local'

import type { DaemonEvent } from './events.js'

export const AGENT_JOB_DISPATCH_POLL_MS = 5_000

export interface JobDispatcherScheduler {
  now(): number
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>
  clearTimeout(timer: ReturnType<typeof setTimeout>): void
}

export interface CreateJobDispatcherInput {
  readonly queue: Pick<AgentJobQueue, 'runNextJob'>
  readonly fence: JobStoreFence
  readonly scheduler: JobDispatcherScheduler
  readonly recordEvent: (event: DaemonEvent) => void
  readonly reportError: (error: unknown) => void
}

export interface JobDispatcher {
  /** Coalesce a producer nudge into the resident pump's next opportunity to inspect the queue. */
  wake(): void
  /** Stop accepting work and wait for the one in-flight handler, if any, to settle. */
  stop(): Promise<void>
}

/**
 * The run a claimed job's payload names, if it names one as a string.
 *
 * Read structurally rather than through a schema: the payload is `unknown` by construction and
 * every kind spells its own, so an id-shaped string under `runId` is the whole contract. A
 * payload that carries none, or carries something else, yields `undefined` and the event is
 * emitted without the key rather than with an empty one.
 */
function runIdOf(outcome: Extract<RunNextJobOutcome, { ran: true }>): string | undefined {
  const payload: unknown = outcome.payload
  if (typeof payload !== 'object' || payload === null) return undefined
  const candidate = (payload as { runId?: unknown }).runId
  return typeof candidate === 'string' ? candidate : undefined
}

function completedEvent(
  outcome: Extract<RunNextJobOutcome, { ran: true }>,
  dispatchSafetyBoundExceeded: boolean,
): DaemonEvent {
  const runId = runIdOf(outcome)
  return {
    kind: 'job-completed',
    jobId: String(outcome.job.id),
    jobKind: outcome.job.kind,
    attempt: outcome.job.attempts,
    disposition: outcome.disposition,
    handlerInvoked: outcome.handlerInvoked,
    checkpointsPublished: outcome.checkpointsPublished.length,
    ...(runId === undefined ? {} : { runId }),
    ...(outcome.disposition === 'retry-scheduled'
      ? { retryDelayMs: outcome.retryDelayMs }
      : {}),
    ...(dispatchSafetyBoundExceeded ? { dispatchSafetyBoundExceeded: true } : {}),
  }
}

/**
 * Own the daemon's one serialized, wakeable pump over the agent job queue.
 *
 * The queue deliberately executes one job at a time. This host loop supplies residency without
 * turning a producer nudge into parallel execution, and treats the poll as a lost-nudge backstop.
 */
export function createJobDispatcher(input: CreateJobDispatcherInput): JobDispatcher {
  let stopping = false
  let wakePending = true
  let waiter: {
    readonly timer: ReturnType<typeof setTimeout>
    readonly resolve: () => void
  } | undefined

  const settleWaiter = (): void => {
    const waiting = waiter
    if (waiting === undefined) return
    waiter = undefined
    input.scheduler.clearTimeout(waiting.timer)
    waiting.resolve()
  }

  const wake = (): void => {
    if (stopping) return
    if (waiter !== undefined) {
      settleWaiter()
      return
    }
    wakePending = true
  }

  const wait = (delayMs: number): Promise<void> => {
    if (stopping) return Promise.resolve()
    if (wakePending) {
      wakePending = false
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      const timer = input.scheduler.setTimeout(() => {
        if (waiter?.timer !== timer) return
        waiter = undefined
        resolve()
      }, delayMs)
      timer.unref?.()
      waiter = { timer, resolve }
    })
  }

  const safelyRecord = (event: DaemonEvent): void => {
    try {
      input.recordEvent(event)
    } catch (error) {
      try {
        input.reportError(error)
      } catch {
        // Observability must not become a second way to stop the resident queue.
      }
    }
  }

  const safelyReport = (error: unknown): void => {
    try {
      input.reportError(error)
    } catch {
      // A logger failure is not queue authority and cannot terminate dispatch.
    }
  }

  const running = (async (): Promise<void> => {
    let consecutiveRuns = 0
    let doNotRunBeforeMs = 0

    while (!stopping) {
      const remainingDelayMs = doNotRunBeforeMs - input.scheduler.now()
      if (remainingDelayMs > 0) {
        // A wake may shorten the sleep, but it cannot make a retry or safety pause eligible early.
        await wait(remainingDelayMs)
        continue
      }
      doNotRunBeforeMs = 0

      const isSafetyProbe = consecutiveRuns >= JOB_RECOVERY_MAX_RESUMED_JOBS
      let outcome: RunNextJobOutcome
      try {
        outcome = await input.queue.runNextJob({ fence: input.fence })
      } catch (error) {
        // A handler can throw after its row is claimed. The store preserves that evidence; the
        // resident loop must still inspect the next eligible row instead of dying with it.
        safelyReport(error)
        consecutiveRuns += 1
        if (isSafetyProbe) {
          // A persistent driver fault is not a license to hot-spin either. Preserve immediate
          // failure isolation inside a batch, then yield at the same bounded host seam.
          consecutiveRuns = 0
          doNotRunBeforeMs = input.scheduler.now() + AGENT_JOB_DISPATCH_POLL_MS
        }
        continue
      }

      if (!outcome.ran) {
        consecutiveRuns = 0
        await wait(AGENT_JOB_DISPATCH_POLL_MS)
        continue
      }

      const runId = runIdOf(outcome)
      safelyRecord({
        kind: 'job-claimed',
        jobId: String(outcome.job.id),
        jobKind: outcome.job.kind,
        attempt: outcome.job.attempts,
        ...(runId === undefined ? {} : { runId }),
      })
      safelyRecord(completedEvent(outcome, isSafetyProbe))
      consecutiveRuns += 1

      if (outcome.disposition === 'retry-scheduled') {
        doNotRunBeforeMs = input.scheduler.now() + outcome.retryDelayMs
      } else if (isSafetyProbe) {
        // The old recovery loop stopped at the bound. A single non-empty probe proves work remains,
        // records that fact, and yields before another batch so successor chains cannot hot-spin.
        consecutiveRuns = 0
        doNotRunBeforeMs = input.scheduler.now() + AGENT_JOB_DISPATCH_POLL_MS
      }
    }
  })()

  return {
    wake,
    async stop(): Promise<void> {
      if (!stopping) {
        stopping = true
        settleWaiter()
      }
      await running
    },
  }
}
