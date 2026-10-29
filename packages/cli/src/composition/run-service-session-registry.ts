// Eviction starts when a run settles, so a live run is never evicted from under a subscriber.

import type { RunSession } from '@vostride/agent-qa-schema'

/** How long a finished run stays attachable, matching the in-process backend's replay window. */
export const RUN_SERVICE_SESSION_RETENTION_MS = 5 * 60 * 1000

export interface RunServiceSessionRegistry {
  /** The session for this run id, or nothing if this process never started it (or has forgotten). */
  attach(runId: string): RunSession | undefined
  /** Unregister the observer and drop every retained handle and pending timer. */
  dispose(): void
}

export function createRunServiceSessionRegistry(input: {
  /** The one run bridge's fan-out. Returns the unregister handle. */
  readonly observeSessions: (observer: (session: RunSession) => void) => () => void
  readonly retentionMs?: number
}): RunServiceSessionRegistry {
  const retentionMs = input.retentionMs ?? RUN_SERVICE_SESSION_RETENTION_MS
  const sessions = new Map<string, { readonly session: RunSession; timer?: NodeJS.Timeout }>()

  const unobserve = input.observeSessions((session) => {
    const runId = session.id as unknown as string
    const entry: { readonly session: RunSession; timer?: NodeJS.Timeout } = { session }
    sessions.set(runId, entry)
    const scheduleEviction = (): void => {
      // `unref` so a retained handle cannot hold a process open past its own work — a server
      // shuts down on its own schedule, not on the last run's retention window.
      entry.timer = setTimeout(() => { sessions.delete(runId) }, retentionMs)
      entry.timer.unref?.()
    }
    // BOTH ARMS, deliberately: a run that REJECTS its completion is still a run this process is
    // done with, and a rejection with no eviction is the leak the settle-triggered window exists
    // to close.
    session.done.then(scheduleEviction, scheduleEviction)
  })

  return {
    attach: (runId) => sessions.get(runId)?.session,
    dispose: () => {
      unobserve()
      for (const entry of sessions.values()) {
        if (entry.timer !== undefined) clearTimeout(entry.timer)
      }
      sessions.clear()
    },
  }
}
