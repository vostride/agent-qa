// The server hands the live-editor session manager the host's mask binder, so every session it
// opens hands its mask to the host.

import { afterEach, describe, expect, it, vi } from 'vitest'

import { DashboardDatabase } from '../db/database.js'
import type { SessionManagerDeps } from '../live-editor/session-manager.js'
import { startServer } from '../server/server.js'

const { managerDeps } = vi.hoisted(() => ({ managerDeps: [] as SessionManagerDeps[] }))

vi.mock('../live-editor/session-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../live-editor/session-manager.js')>()
  class RecordingSessionManager extends actual.SessionManager {
    constructor(deps: SessionManagerDeps = {}) {
      super(deps)
      managerDeps.push(deps)
    }
  }
  return { ...actual, SessionManager: RecordingSessionManager }
})

const closers: Array<() => void> = []

afterEach(() => {
  for (const close of closers.splice(0)) close()
  managerDeps.length = 0
})

async function startWith(bindSessionMask?: SessionManagerDeps['bindSessionMask']): Promise<void> {
  const started = await startServer({
    db: new DashboardDatabase({ dbPath: ':memory:' }),
    port: 0,
    declaredSecretMask: (text) => text,
    ...(bindSessionMask === undefined ? {} : { bindSessionMask }),
  })
  closers.push(started.close)
}

describe("the dashboard server's live-editor sessions", () => {
  it('get the mask binder the server was started with, and none when it was given none', async () => {
    const bindSessionMask = () => () => {}

    await startWith(bindSessionMask)
    await startWith()

    expect(managerDeps).toHaveLength(2)
    expect(managerDeps[0]?.bindSessionMask).toBe(bindSessionMask)
    expect(Object.hasOwn(managerDeps[1]!, 'bindSessionMask')).toBe(false)
  })
})
