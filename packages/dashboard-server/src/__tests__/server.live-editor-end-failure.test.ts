// A control socket whose session cannot be ended prints one line under the live tag.

import { once } from 'node:events'

import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'

import { DashboardDatabase } from '../db/database.js'
import type { SessionManagerDeps } from '../live-editor/session-manager.js'
import { startServer } from '../server/server.js'

const SESSION_ID = 'held-session'

const { terminations } = vi.hoisted(() => ({ terminations: [] as Array<() => void> }))

vi.mock('../live-editor/session-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../live-editor/session-manager.js')>()
  class FailingEndSessionManager extends actual.SessionManager {
    constructor(deps: SessionManagerDeps = {}) {
      super(deps)
    }

    override getSession(sessionId: string) {
      if (sessionId !== SESSION_ID) return super.getSession(sessionId)
      return { clearIdleTimer: () => {} } as unknown as ReturnType<
        InstanceType<typeof actual.SessionManager>['getSession']
      >
    }

    override async terminateSession(): Promise<boolean> {
      throw new Error('cleanup failed')
    }
  }
  return { ...actual, SessionManager: FailingEndSessionManager }
})

vi.mock('../live-editor/ws-handler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../live-editor/ws-handler.js')>()
  return {
    ...actual,
    createSessionHandler: (_session: unknown, onTerminate: () => void) => {
      terminations.push(onTerminate)
      return () => {}
    },
  }
})

const PAIR = /^::stop-commands::([0-9a-f]{32})\n[\s\S]*\n::\1::\n$/u
const closers: Array<() => void> = []
const sockets: WebSocket[] = []

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.terminate()
  for (const close of closers.splice(0)) close()
  terminations.length = 0
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

async function endHeldSession(): Promise<void> {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const started = await startServer({
    db: new DashboardDatabase({ dbPath: ':memory:' }),
    port: 0,
    declaredSecretMask: (text) => text,
  })
  closers.push(started.close)
  const socket = new WebSocket(
    `ws://localhost:${String(started.port)}/api/live-editor/ws?sessionId=${SESSION_ID}`,
  )
  sockets.push(socket)
  // Terminating a socket that is still connecting raises an error after the test has ended.
  await once(socket, 'open')
  await vi.waitFor(() => expect(terminations).toHaveLength(1))
  terminations[0]?.()
}

describe('a control socket whose session cannot be ended', () => {
  it('prints one console.error line under the live tag with the error', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await endHeldSession()

    await vi.waitFor(() => expect(errSpy).toHaveBeenCalledOnce())
    expect(errSpy.mock.calls[0]).toHaveLength(1)
    const line = String(errSpy.mock.calls[0]?.[0])
    expect(line).toMatch(/^\d\d:\d\d:\d\d  live       /u)
    expect(line).toContain(`Could not end session ${SESSION_ID} Error: cleanup failed`)
    expect(line).not.toContain('[live-editor]')
  })

  it('prints the line inside one pair on stdout under GitHub Actions', async () => {
    vi.stubEnv('GITHUB_ACTIONS', 'true')
    const writes: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk))
      return true
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await endHeldSession()

    await vi.waitFor(() => {
      expect(writes.filter((chunk) => chunk.includes('Could not end session'))).toHaveLength(1)
    })
    const block = writes.find((chunk) => chunk.includes('Could not end session'))
    expect(block).toMatch(PAIR)
    expect(block).toContain(`live       Could not end session ${SESSION_ID}`)
    expect(errSpy).not.toHaveBeenCalled()
  })
})
