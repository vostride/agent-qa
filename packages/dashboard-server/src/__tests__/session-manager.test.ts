import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import type { SessionState, LiveSessionConfig } from '../live-editor/types.js'

const mockInitialize = vi.fn().mockResolvedValue(undefined)
const mockCleanup = vi.fn().mockResolvedValue(undefined)
const mockGetState = vi.fn<() => SessionState>().mockReturnValue({
  sessionId: 'test-id',
  platform: 'web',
  status: 'idle',
  currentStep: null,
  currentUrl: null,
  stepsExecuted: 0,
  createdAt: Date.now(),
  interactive: true,
  terminalError: null,
  authState: null,
})

vi.mock('../live-editor/live-session.js', () => ({
  LiveSession: vi.fn().mockImplementation(function (sessionId: string) {
    return {
      sessionId,
      initialize: mockInitialize,
      cleanup: mockCleanup,
      getState: () => ({ ...mockGetState(), sessionId }),
      // The manager arms the idle window and registers the subject on create.
      startIdleTimer: vi.fn(),
      clearIdleTimer: vi.fn(),
      liveAttachment: vi.fn(),
    }
  }),
}))

import { SessionManager } from '../live-editor/session-manager.js'

const validConfig: LiveSessionConfig = {
  platform: 'web',
  llmConfig: {
    provider: 'anthropic-compatible',
    model: 'claude-sonnet-4-20250514',
    baseURL: 'https://anthropic-proxy.example/messages',
  },
}

describe('SessionManager', () => {
  let manager: SessionManager

  beforeEach(() => {
    manager = new SessionManager()
    vi.clearAllMocks()
  })

  it('createSession returns a UUID', async () => {
    const { sessionId } = await manager.createSession(validConfig)
    expect(sessionId).toMatch(/^[0-9a-f]{8}-/)
  })

  it('getSession returns the created session', async () => {
    const { sessionId } = await manager.createSession(validConfig)
    const session = manager.getSession(sessionId)
    expect(session).toBeTruthy()
    expect(session!.sessionId).toBe(sessionId)
  })

  it('getSession returns undefined for unknown id', () => {
    expect(manager.getSession('nonexistent')).toBeUndefined()
  })

  it('listSessions returns all active sessions', async () => {
    await manager.createSession(validConfig)
    await manager.createSession(validConfig)
    const list = manager.listSessions()
    expect(list).toHaveLength(2)
  })

  it('terminateSession cleans up and removes', async () => {
    const { sessionId } = await manager.createSession(validConfig)
    const result = await manager.terminateSession(sessionId)
    expect(result).toBe(true)
    expect(mockCleanup).toHaveBeenCalled()
    expect(manager.getSession(sessionId)).toBeUndefined()
  })

  it('terminateSession returns false for unknown id', async () => {
    const result = await manager.terminateSession('nonexistent')
    expect(result).toBe(false)
  })

  it('cleanupAll cleans up all sessions', async () => {
    await manager.createSession(validConfig)
    await manager.createSession(validConfig)
    await manager.cleanupAll()
    expect(manager.size).toBe(0)
  })

  it('createSession throws when LLM config missing', async () => {
    const badConfig = { platform: 'web' as const } as LiveSessionConfig
    await expect(manager.createSession(badConfig)).rejects.toThrow('LLM not configured')
  })
})

describe('an expiry that cannot end its session', () => {
  const PAIR = /^::stop-commands::([0-9a-f]{32})\n[\s\S]*\n::\1::\n$/u

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  async function expireFailing(): Promise<string> {
    const manager = new SessionManager()
    const { sessionId } = await manager.createSession(validConfig)
    const session = manager.getSession(sessionId) as unknown as { startIdleTimer: Mock }
    const expire = session.startIdleTimer.mock.calls[0]?.[0] as () => void
    mockCleanup.mockRejectedValueOnce(new Error('cleanup failed'))
    expire()
    return sessionId
  }

  it('prints one console.error line under the live tag with the error', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const sessionId = await expireFailing()

    await vi.waitFor(() => expect(errSpy).toHaveBeenCalledOnce())
    expect(errSpy.mock.calls[0]).toHaveLength(1)
    const line = String(errSpy.mock.calls[0]?.[0])
    expect(line).toMatch(/^\d\d:\d\d:\d\d  live       /u)
    expect(line).toContain(`idle expiry could not end session ${sessionId} Error: cleanup failed`)
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

    const sessionId = await expireFailing()

    await vi.waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]).toMatch(PAIR)
    expect(writes[0]).toContain(`live       idle expiry could not end session ${sessionId}`)
    expect(errSpy).not.toHaveBeenCalled()
  })
})
