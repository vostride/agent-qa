/** How often a held remote session is touched while agent-qa waits between actions. */
export const REMOTE_HEARTBEAT_INTERVAL_MS = 30_000
/** How long one beat may take before it counts as failed; a silent remote never answers it. */
export const REMOTE_HEARTBEAT_TIMEOUT_MS = 10_000

export interface RemoteHeartbeatCounts {
  sent: number
  failed: number
  // The latest beat failed or timed out; the next action decides what that means.
  suspect: boolean
}

export interface RemoteHeartbeat {
  start(): void
  stop(): void
  // Holds off beats until the matching leave(), after any running beat settles or times out.
  enter(): Promise<void>
  leave(): void
  counts(): RemoteHeartbeatCounts
}

export interface RemoteHeartbeatOptions {
  readonly intervalMs?: number
  readonly beatTimeoutMs?: number
  readonly beat: () => Promise<unknown>
}

export function createRemoteHeartbeat(options: RemoteHeartbeatOptions): RemoteHeartbeat {
  const intervalMs = options.intervalMs ?? REMOTE_HEARTBEAT_INTERVAL_MS
  const beatTimeoutMs = options.beatTimeoutMs ?? REMOTE_HEARTBEAT_TIMEOUT_MS
  let timer: ReturnType<typeof setInterval> | undefined
  let inFlight = 0
  let sent = 0
  let failed = 0
  let suspect = false
  // Settles when the beat answers or times out, whichever is first.
  let running: Promise<void> | undefined
  // A timed-out beat may still be waiting on the remote; no second beat stacks on it.
  let outstanding = false

  const runBeat = (): Promise<void> => {
    let beat: Promise<unknown>
    try {
      beat = Promise.resolve(options.beat())
    } catch (error) {
      beat = Promise.reject(error)
    }
    sent += 1
    outstanding = true
    const answered = beat.then(
      () => true,
      () => false,
    )
    void answered.then(() => {
      outstanding = false
    })
    let bound: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<boolean>((resolve) => {
      bound = setTimeout(() => resolve(false), beatTimeoutMs)
      bound.unref?.()
    })
    return Promise.race([answered, timedOut]).then((ok) => {
      clearTimeout(bound)
      if (ok) {
        suspect = false
      } else {
        failed += 1
        suspect = true
      }
    })
  }

  const tick = (): void => {
    if (inFlight > 0 || outstanding) return
    const current = runBeat()
    running = current
    void current.then(() => {
      if (running === current) running = undefined
    })
  }

  return {
    start() {
      if (timer !== undefined) return
      timer = setInterval(tick, intervalMs)
      timer.unref?.()
    },
    stop() {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
    },
    async enter() {
      inFlight += 1
      await running
    },
    leave() {
      if (inFlight > 0) inFlight -= 1
    },
    counts() {
      return { sent, failed, suspect }
    },
  }
}
