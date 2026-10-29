// The run service's attachable-session registry.
//
// WHAT THIS HOLDS AND WHY IT IS BOUNDED. `GET /run/:runId/events` serves a run's envelopes off the
// `RunSession` that run produced, so the door needs a run id → session lookup. Sessions arrive
// through the ONE bridge this process's host publishes them on, and they arrive for every run —
// the queue's and the service's alike, because there is one bridge and one host.
//
// THE EVICTION IS THE REASON THIS IS A MODULE AND NOT A `Map`. Without it the lookup grows for the
// life of a long-running dashboard, one entry per run, each entry pinning a whole event bus in
// memory. The window OPENS WHEN THE RUN SETTLES rather than when it starts, so a live run is never
// evicted out from under a subscriber, and it matches the in-process backend's own replay
// retention — a client told "attach later" by one part of this process is not refused by another.
//
// IT LIVES BESIDE THE COMPOSITION RATHER THAN INSIDE `commands/dashboard.ts`, and that placement
// is a measured constraint rather than taste. `run-trigger-confirm.test.ts` runs a complete-set
// census over `packages/cli/src` and `packages/dashboard-server/src` for the mechanical shape of a
// CONFIRM REAPER — a module holding both a `setTimeout` and the denial answer — and asserts
// exactly one module has it, so that "silence is consent" has one reading in this codebase. That
// predicate shares no vocabulary with the registry factory census beside it, deliberately, which
// is what lets it find a parking lot somebody wrote by hand. `commands/dashboard.ts` already holds
// that answer (the confirm ledger writes it), so a retention timer written there would have made
// that file match the reaper shape and reddened a census protecting something else entirely.
// NOTE FOR ANYONE EDITING THIS HEADER: the census reads SOURCE TEXT, so even a prose mention of
// the denial literal in a module that also holds a timer trips it. That is a known sharp edge of
// a text-scanning complete-set predicate and not a thing to work around by narrowing the scan.
// Narrowing the census to let this timer through would have traded a real guard for a convenience;
// moving the timer costs nothing and leaves the guard exactly as strong as it was.

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
