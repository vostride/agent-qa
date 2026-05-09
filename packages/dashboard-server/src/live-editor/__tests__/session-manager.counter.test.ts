import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SessionState, LiveSessionConfig } from '../types.js'

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

vi.mock('../live-session.js', () => ({
  LiveSession: vi.fn().mockImplementation(function (sessionId: string) {
    return {
      sessionId,
      initialize: mockInitialize,
      cleanup: mockCleanup,
      getState: () => ({ ...mockGetState(), sessionId }),
    }
  }),
}))

import { SessionManager } from '../session-manager.js'

// Forward-contract type — plan 02 will export EntityRef from ../types.js
// (so this local alias gets replaced by the real import once the type lands).
interface EntityRef {
  type: 'suite' | 'test'
  id: string
}

const validConfig: LiveSessionConfig = {
  platform: 'web',
  llmConfig: {
    provider: 'anthropic-compatible',
    model: 'claude-sonnet-4-20250514',
    baseURL: 'https://anthropic-proxy.example/messages',
  },
}

// Forward-contract wrapper — plan 01 used this to assert the future return shape
// without breaking tsc on today's string-returning createSession.
async function callCreateSession(
  manager: SessionManager,
  entity?: EntityRef,
): Promise<string | { sessionId: string; sessionNumber: number | null }> {
  const invoke = manager.createSession as unknown as (
    config: LiveSessionConfig,
    entity?: EntityRef,
  ) => Promise<unknown>
  return (await invoke.call(manager, validConfig, entity)) as unknown as
    | string
    | { sessionId: string; sessionNumber: number | null }
}

describe('SessionManager per-entity counter (D-27, D-30)', () => {
  let manager: SessionManager

  beforeEach(() => {
    manager = new SessionManager()
    vi.clearAllMocks()
  })

  it('createSession without entity returns { sessionId, sessionNumber: null }', async () => {
    const raw = await callCreateSession(manager)
    expect(typeof raw).toBe('object')
    expect(raw).toEqual({ sessionId: expect.any(String), sessionNumber: null })
    if (typeof raw === 'object') {
      expect(raw.sessionId).toMatch(/^[0-9a-f]{8}-/)
    }
  })

  it('first createSession for an entity returns sessionNumber: 1', async () => {
    const raw = await callCreateSession(manager, { type: 'suite', id: 's_alpha' })
    expect(typeof raw).toBe('object')
    if (typeof raw === 'object') {
      expect(raw.sessionNumber).toBe(1)
    }
  })

  it('repeated createSession for the same entity increments monotonically', async () => {
    const r1 = await callCreateSession(manager, { type: 'suite', id: 's_beta' })
    const r2 = await callCreateSession(manager, { type: 'suite', id: 's_beta' })
    const r3 = await callCreateSession(manager, { type: 'suite', id: 's_beta' })
    expect(typeof r1).toBe('object')
    expect(typeof r2).toBe('object')
    expect(typeof r3).toBe('object')
    if (typeof r1 === 'object' && typeof r2 === 'object' && typeof r3 === 'object') {
      expect(r1.sessionNumber).toBe(1)
      expect(r2.sessionNumber).toBe(2)
      expect(r3.sessionNumber).toBe(3)
    }
  })

  it('keeps separate counters for same id under different types', async () => {
    const rSuite = await callCreateSession(manager, { type: 'suite', id: 'shared_id' })
    const rTest = await callCreateSession(manager, { type: 'test', id: 'shared_id' })
    expect(typeof rSuite).toBe('object')
    expect(typeof rTest).toBe('object')
    if (typeof rSuite !== 'object' || typeof rTest !== 'object') return
    expect(rSuite.sessionNumber).toBe(1)
    expect(rTest.sessionNumber).toBe(1)
  })

  it('keeps separate counters for different ids within the same type', async () => {
    const r1 = await callCreateSession(manager, { type: 'suite', id: 's_x' })
    const r2 = await callCreateSession(manager, { type: 'suite', id: 's_y' })
    expect(typeof r1).toBe('object')
    expect(typeof r2).toBe('object')
    if (typeof r1 !== 'object' || typeof r2 !== 'object') return
    expect(r1.sessionNumber).toBe(1)
    expect(r2.sessionNumber).toBe(1)
  })

  it('counter does NOT decrement on terminateSession — next create returns the next number', async () => {
    const first = await callCreateSession(manager, { type: 'suite', id: 's_mono' })
    const second = await callCreateSession(manager, { type: 'suite', id: 's_mono' })
    expect(typeof first).toBe('object')
    expect(typeof second).toBe('object')
    if (typeof first !== 'object' || typeof second !== 'object') return
    expect(first.sessionNumber).toBe(1)
    expect(second.sessionNumber).toBe(2)
    const terminated = await manager.terminateSession(first.sessionId)
    expect(terminated).toBe(true)
    const third = await callCreateSession(manager, { type: 'suite', id: 's_mono' })
    expect(typeof third).toBe('object')
    if (typeof third !== 'object') return
    expect(third.sessionNumber).toBe(3)
  })

  it('getCounter returns the last-assigned number; 0 for unknown entities', async () => {
    const typed = manager as unknown as { getCounter(entity: EntityRef): number }
    expect(typeof typed.getCounter).toBe('function')
    expect(typed.getCounter({ type: 'suite', id: 'unknown' })).toBe(0)
    await callCreateSession(manager, { type: 'suite', id: 's_counted' })
    await callCreateSession(manager, { type: 'suite', id: 's_counted' })
    expect(typed.getCounter({ type: 'suite', id: 's_counted' })).toBe(2)
  })

  it.skip('counter resets on server restart (documented — ephemeral per CONTEXT D-30)', () => {
    // Ephemeral-restart behavior is not exercised in unit tests — requires process-level
    // lifecycle. Skipped intentionally to document the contract.
  })
})
