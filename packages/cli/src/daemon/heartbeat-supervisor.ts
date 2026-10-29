import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'

import type { HeartbeatLeaseOutcome } from '@vostride/agent-qa-agent-local'

/** Bound worker startup so a broken bundle cannot hold writer authority indefinitely. */
export const HEARTBEAT_SUPERVISOR_START_TIMEOUT_MS = 5_000

/** Bound graceful worker teardown before the host force-terminates the thread. */
export const HEARTBEAT_SUPERVISOR_STOP_TIMEOUT_MS = 3_000

export interface HeartbeatSupervisorHolder {
  readonly leaseId: string
  readonly pid: number
  readonly epoch: number
  readonly heartbeatAtMs: number
}

type HeartbeatSupervisorRefusalReason = Extract<
  HeartbeatLeaseOutcome,
  { kind: 'refused' }
>['reason']

/**
 * Exactly three payload kinds cross the thread boundary: a beat landed, a beat was refused by
 * name, or the beat threw. There is no contention kind, because the beat no longer takes the
 * mutation lock and so cannot be contended by hosted work.
 */
export type HeartbeatSupervisorMessage =
  | { readonly kind: 'heartbeated'; readonly holder: HeartbeatSupervisorHolder }
  | {
      readonly kind: 'refused'
      readonly reason: HeartbeatSupervisorRefusalReason
      readonly holder?: HeartbeatSupervisorHolder
      readonly observedEpoch?: number
    }
  | { readonly kind: 'error'; readonly name: string; readonly message: string }

export interface StartHeartbeatSupervisorOptions {
  readonly knowledgeRoot: string
  readonly leaseId: string
  readonly intervalMs: number
  readonly onMessage: (message: HeartbeatSupervisorMessage) => void
  readonly onUnexpectedExit: (error: Error) => void
  /**
   * Test/chaos seam for the pinned graceful-stop window, mirroring `mutationLockTakeoverMs`.
   *
   * A real wedge is bounded by MUTATION_LOCK_BUSY_TIMEOUT_MS (2s), which is shorter than the
   * pinned 3s window, so shortening the window is the only way to reach the escalation branch
   * from a test. Production never sets it.
   */
  readonly stopTimeoutMs?: number
}

export interface HeartbeatSupervisorHandle {
  /** Settles once the supervisor thread has actually exited; never rejects. */
  readonly exited: Promise<void>
  stop(): Promise<void>
}

type WorkerMessage =
  | { readonly kind: 'ready' }
  | { readonly kind: 'stopped' }
  | HeartbeatSupervisorMessage

const HEARTBEAT_WORKER_SOURCE = String.raw`
'use strict'

const { isAbsolute } = require('node:path')
const { parentPort, workerData } = require('node:worker_threads')

if (parentPort === null) throw new Error('heartbeat supervisor requires a parent port')

const { agentLocalEntryPath, knowledgeRoot, leaseId, intervalMs } = workerData
if (typeof agentLocalEntryPath !== 'string' || !isAbsolute(agentLocalEntryPath)) {
  throw new TypeError('heartbeat supervisor agentLocalEntryPath must be absolute')
}
if (typeof knowledgeRoot !== 'string' || knowledgeRoot.length === 0) {
  throw new TypeError('heartbeat supervisor knowledgeRoot must be a non-empty string')
}
if (typeof leaseId !== 'string' || leaseId.length === 0) {
  throw new TypeError('heartbeat supervisor leaseId must be a non-empty string')
}
if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
  throw new TypeError('heartbeat supervisor intervalMs must be a positive safe integer')
}

const { LOCAL_DAEMON_CAPABILITIES } = require(agentLocalEntryPath)
const authority = { knowledgeRoot, leaseId }
let timer
let loopHalted = false
let closing = false

function schedule(delayMs) {
  if (loopHalted || closing) return
  timer = setTimeout(heartbeat, delayMs)
}

function stop() {
  if (closing) return
  closing = true
  loopHalted = true
  if (timer !== undefined) clearTimeout(timer)
  parentPort.postMessage({ kind: 'stopped' })
  parentPort.close()
}

function heartbeat() {
  if (loopHalted || closing) return
  try {
    const outcome = LOCAL_DAEMON_CAPABILITIES.heartbeatLease(authority)
    if (outcome.kind === 'heartbeated') {
      parentPort.postMessage({ kind: 'heartbeated', holder: outcome.holder })
      schedule(intervalMs)
      return
    }
    // CR-03: the beat never enters the mutation lock, so a governed mutation of any length cannot
    // starve it. Only a typed refusal is authority loss.
    loopHalted = true
    parentPort.postMessage({
      kind: 'refused',
      reason: outcome.reason,
      holder: outcome.holder,
      observedEpoch: outcome.observedEpoch,
    })
  } catch (error) {
    // I-02: there is still no retry branch here. Since 261002-lse the beat does take the short
    // lease-file guard it shares with release, and its wait outlasts the guard's residue bound
    // (261003-lgd, WR-11), so a guard left by a terminated thread is reclaimed inside the beat.
    // What can still arrive here is a guard held by live sections for that whole wait, or a guard
    // chain refused for leaving the knowledge root (CR-01). Both are genuine failures: the loop
    // halts and the main thread is told, as for any other throw.
    loopHalted = true
    parentPort.postMessage({
      kind: 'error',
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

parentPort.on('message', (message) => {
  if (message !== null && typeof message === 'object' && message.kind === 'stop') stop()
})

parentPort.postMessage({ kind: 'ready' })
schedule(intervalMs)
`

function isWorkerMessage(value: unknown): value is WorkerMessage {
  if (value === null || typeof value !== 'object' || !('kind' in value)) return false
  const kind = (value as { kind?: unknown }).kind
  return kind === 'ready'
    || kind === 'stopped'
    || kind === 'heartbeated'
    || kind === 'refused'
    || kind === 'error'
}

/**
 * Start a dedicated writer-lease heartbeat thread and wait until its recurrence is armed.
 *
 * The worker source is inline so the CLI's existing single-file ESM/CJS bundles do not need a
 * second publish entry. The worker resolves the already-shipped agent-local composition edge,
 * preserving the CLI architecture boundary while keeping all recurrence off the host event loop.
 */
export function startHeartbeatSupervisor(
  options: StartHeartbeatSupervisorOptions,
): Promise<HeartbeatSupervisorHandle> {
  const requireBase = typeof __filename === 'string'
    ? __filename
    : import.meta.url
  const agentLocalEntryPath = createRequire(requireBase).resolve(
    '@vostride/agent-qa-agent-local',
  )
  const worker = new Worker(HEARTBEAT_WORKER_SOURCE, {
    eval: true,
    // Do not inherit `--input-type=module` or test loaders that would reinterpret eval as ESM.
    execArgv: [],
    name: 'agent-qa-writer-lease-heartbeat',
    workerData: {
      agentLocalEntryPath,
      knowledgeRoot: options.knowledgeRoot,
      leaseId: options.leaseId,
      intervalMs: options.intervalMs,
    },
  })

  let ready = false
  let exited = false
  let stopping = false
  let unexpectedReported = false
  let stopPromise: Promise<void> | undefined
  let resolveStop: (() => void) | undefined
  let stopTimer: ReturnType<typeof setTimeout> | undefined
  const stopTimeoutMs = options.stopTimeoutMs ?? HEARTBEAT_SUPERVISOR_STOP_TIMEOUT_MS

  let resolveExited: (() => void) | undefined
  const exitedPromise = new Promise<void>((resolve) => {
    resolveExited = resolve
  })

  let rejectStop: ((error: unknown) => void) | undefined

  const settleStop = (): void => {
    if (stopTimer !== undefined) {
      clearTimeout(stopTimer)
      stopTimer = undefined
    }
    resolveStop = undefined
    rejectStop = undefined
  }

  const finishStop = (): void => {
    const resolve = resolveStop
    settleStop()
    resolve?.()
  }

  const failStop = (error: unknown): void => {
    const reject = rejectStop
    settleStop()
    reject?.(error)
  }

  // Released only once no beat can land: from the terminate settlement or exit, failures named.
  const escalateStop = (): void => {
    worker.terminate().then(
      () => finishStop(),
      (error: unknown) => failStop(error),
    )
  }

  const reportUnexpected = (error: Error): void => {
    if (stopping || unexpectedReported) return
    unexpectedReported = true
    options.onUnexpectedExit(error)
  }

  const handle: HeartbeatSupervisorHandle = {
    exited: exitedPromise,
    stop: () => {
      if (stopPromise !== undefined) return stopPromise
      stopping = true
      if (exited) return Promise.resolve()

      stopPromise = new Promise<void>((resolve, reject) => {
        resolveStop = resolve
        rejectStop = reject
        stopTimer = setTimeout(escalateStop, stopTimeoutMs)
        stopTimer.unref?.()
        try {
          worker.postMessage({ kind: 'stop' })
        } catch {
          if (stopTimer !== undefined) {
            clearTimeout(stopTimer)
            stopTimer = undefined
          }
          escalateStop()
        }
      })
      return stopPromise
    },
  }

  return new Promise<HeartbeatSupervisorHandle>((resolve, reject) => {
    let startupSettled = false
    const startupTimer = setTimeout(() => {
      if (startupSettled) return
      startupSettled = true
      stopping = true
      void worker.terminate().catch(() => undefined)
      reject(new Error(
        `heartbeat supervisor did not start within ${HEARTBEAT_SUPERVISOR_START_TIMEOUT_MS}ms`,
      ))
    }, HEARTBEAT_SUPERVISOR_START_TIMEOUT_MS)
    startupTimer.unref?.()

    const failStartup = (error: Error): void => {
      if (startupSettled) return
      startupSettled = true
      clearTimeout(startupTimer)
      stopping = true
      void worker.terminate().catch(() => undefined)
      reject(error)
    }

    worker.on('message', (message: unknown) => {
      if (!isWorkerMessage(message)) {
        const error = new Error('heartbeat supervisor emitted an invalid protocol message')
        if (!ready) failStartup(error)
        else reportUnexpected(error)
        return
      }
      if (message.kind === 'ready') {
        if (startupSettled) return
        startupSettled = true
        ready = true
        clearTimeout(startupTimer)
        resolve(handle)
        return
      }
      if (message.kind === 'stopped') return
      if (!ready || stopping) return
      options.onMessage(message)
    })

    worker.on('error', (error) => {
      if (!ready) failStartup(error)
      else reportUnexpected(error)
    })

    worker.on('exit', (code) => {
      exited = true
      resolveExited?.()
      resolveExited = undefined
      finishStop()
      if (!ready) {
        failStartup(new Error(`heartbeat supervisor exited before ready with code ${code}`))
      } else if (!stopping) {
        reportUnexpected(new Error(`heartbeat supervisor exited unexpectedly with code ${code}`))
      }
    })
  })
}
