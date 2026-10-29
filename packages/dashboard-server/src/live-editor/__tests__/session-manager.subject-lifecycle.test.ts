// 428 D-07 / D-09 at the manager: every editor session is a registered editor subject for exactly
// its lifetime, and the idle window (RESEARCH P1) really runs from the moment a session exists.
//
// The session is the real LiveSession with only `initialize` stubbed out, so the idle timer, the
// attachment and cleanup under test are the shipped ones. A headless session has no adapter, so its
// subject declares `{ kind: 'none' }`; the per-session hub itself is pinned in live-session.test.ts.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LiveSessionConfig } from '../types.js'

vi.mock('../live-session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../live-session.js')>()
  class HeadlessLiveSession extends actual.LiveSession {
    async initialize(): Promise<void> {}
  }
  return { ...actual, LiveSession: HeadlessLiveSession }
})

import { IDLE_TIMEOUT_MS, LiveSession } from '../live-session.js'
import { SessionManager } from '../session-manager.js'
import { createLiveEditorSubjects } from '../../live-view/editor-subjects.js'

const config: LiveSessionConfig = {
  platform: 'web',
  llmConfig: {
    provider: 'anthropic-compatible',
    model: 'claude-sonnet-4-20250514',
    baseURL: 'https://anthropic-proxy.example/messages',
  },
}

describe('428 editor session lifecycle at the manager', () => {
  const managers: SessionManager[] = []
  const managerWith = (subjects = createLiveEditorSubjects()) => {
    const manager = new SessionManager({ liveEditorSubjects: subjects })
    managers.push(manager)
    return { manager, subjects }
  }

  afterEach(async () => {
    for (const manager of managers.splice(0)) await manager.cleanupAll()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('TERMINATE-UNREGISTERS-SUBJECT: a created session is an editor subject until it is terminated', async () => {
    const { manager, subjects } = managerWith()
    const { sessionId } = await manager.createSession(config)

    const attached = subjects.attach(sessionId)
    expect(attached, 'registered under its own session id').toBeDefined()
    expect(subjects.capabilityOf(sessionId)).toEqual({ kind: 'none' })
    let ended = false
    void attached?.ended.then(() => {
      ended = true
    })

    expect(await manager.terminateSession(sessionId)).toBe(true)
    await Promise.resolve()

    expect(subjects.attach(sessionId)).toBeUndefined()
    expect(subjects.capabilityOf(sessionId)).toBeUndefined()
    expect(ended, 'the attachment ends with the session').toBe(true)
    expect(await manager.terminateSession(sessionId), 'a second terminate is a no-op').toBe(false)
  })

  it('TERMINATE-UNREGISTERS-SUBJECT: cleanupAll unregisters every subject', async () => {
    const { manager, subjects } = managerWith()
    const first = await manager.createSession(config)
    const second = await manager.createSession(config)
    expect(subjects.attach(first.sessionId)).toBeDefined()
    expect(subjects.attach(second.sessionId)).toBeDefined()

    await manager.cleanupAll()

    expect(subjects.attach(first.sessionId)).toBeUndefined()
    expect(subjects.attach(second.sessionId)).toBeUndefined()
  })

  it('CREATE-ARMS-IDLE-UNTIL-ATTACH: a session no socket attaches to is terminated after IDLE_TIMEOUT_MS, not before', async () => {
    vi.useFakeTimers()
    const cleanup = vi.spyOn(LiveSession.prototype, 'cleanup')
    const { manager, subjects } = managerWith()
    const { sessionId } = await manager.createSession(config)

    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 1)
    expect(manager.getSession(sessionId), 'still held one millisecond before the window ends').toBeDefined()
    expect(cleanup).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(manager.getSession(sessionId)).toBeUndefined()
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(subjects.attach(sessionId)).toBeUndefined()
  })

  it('CREATE-ARMS-IDLE-UNTIL-ATTACH: an attach inside the window clears it', async () => {
    vi.useFakeTimers()
    const cleanup = vi.spyOn(LiveSession.prototype, 'cleanup')
    const { manager } = managerWith()
    const { sessionId } = await manager.createSession(config)

    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 1)
    manager.getSession(sessionId)?.clearIdleTimer()
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS)

    expect(manager.getSession(sessionId)).toBeDefined()
    expect(cleanup).not.toHaveBeenCalled()
  })
})
