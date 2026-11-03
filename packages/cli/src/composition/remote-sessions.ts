import { createRemoteSessionRegistry, REMOTE_RELEASE_BOUND_MS } from '@vostride/agent-qa-runner'
import type { RemoteSessionRegistry } from '@vostride/agent-qa-runner'

// Every remote session this process holds: each run door's and the dashboard's live editor's.
export const processRemoteSessions: RemoteSessionRegistry = createRemoteSessionRegistry()
let startedRemoteRelease: Promise<void> | undefined

export { REMOTE_RELEASE_BOUND_MS }

/** Disconnects every open remote session at once, each within `boundMs`; never throws. */
export function releaseRemoteSessions(boundMs: number): Promise<void> {
  const releasing = processRemoteSessions.releaseAll(boundMs)
  const earlier = startedRemoteRelease
  startedRemoteRelease =
    earlier === undefined ? releasing : Promise.all([earlier, releasing]).then(() => undefined)
  return releasing
}

// An exit waits for the release its signal started, so exiting never cuts one short.
export function startedRemoteReleases(): Promise<void> {
  return startedRemoteRelease ?? Promise.resolve()
}
