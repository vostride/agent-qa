import { describe, it, expect, beforeEach, vi } from 'vitest'
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
})

vi.mock('../live-editor/live-session.js', () => ({
  LiveSession: vi.fn().mockImplementation(function (sessionId: string) {
    return {
      sessionId,
      initialize: mockInitialize,
      cleanup: mockCleanup,
      getState: () => ({ ...mockGetState(), sessionId }),
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
