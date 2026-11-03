import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LiveSessionConfig } from '../types.js'

interface HeldCleanup {
  calls: number
  release(): void
  fail(error: Error): void
  readonly done: Promise<void>
}

const { holds } = vi.hoisted(() => ({ holds: [] as HeldCleanup[] }))

vi.mock('../live-session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../live-session.js')>()
  class HeldCleanupSession extends actual.LiveSession {
    private readonly hold: HeldCleanup = (() => {
      let release!: () => void
      let fail!: (error: Error) => void
      const done = new Promise<void>((settle, reject) => {
        release = settle
        fail = reject
      })
      const entry = { calls: 0, release, fail, done }
      holds.push(entry)
      return entry
    })()

    async initialize(): Promise<void> {}

    cleanup(): Promise<void> {
      this.clearIdleTimer()
      this.hold.calls += 1
      return this.hold.done
    }
  }
  return { ...actual, LiveSession: HeldCleanupSession }
})

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

async function settleMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve()
}

describe('cleaning up every live-editor session', () => {
  afterEach(() => {
    for (const hold of holds.splice(0)) hold.release()
  })

  it('cleans each session once when calls overlap, and every call waits for that one pass', async () => {
    const subjects = createLiveEditorSubjects()
    const manager = new SessionManager({ liveEditorSubjects: subjects })
    const first = await manager.createSession(config)
    const second = await manager.createSession(config)
    const [firstHold, secondHold] = holds as [HeldCleanup, HeldCleanup]

    let resolved = 0
    const calls = [manager.cleanupAll(), manager.cleanupAll(), manager.cleanupAll()]
    for (const call of calls) {
      void call.then(() => {
        resolved += 1
      })
    }
    await settleMicrotasks()

    expect(holds.map((hold) => hold.calls)).toEqual([1, 1])
    expect(manager.size).toBe(0)
    expect(subjects.attach(first.sessionId)).toBeUndefined()
    expect(subjects.attach(second.sessionId)).toBeUndefined()
    expect(resolved).toBe(0)

    firstHold.release()
    await settleMicrotasks()
    expect(resolved).toBe(0)

    secondHold.release()
    await Promise.all(calls)
    expect(resolved).toBe(3)

    await manager.cleanupAll()
    expect(holds.map((hold) => hold.calls)).toEqual([1, 1])
  })

  it('waits for every other session when one cleanup fails, and never rejects', async () => {
    const manager = new SessionManager()
    await manager.createSession(config)
    await manager.createSession(config)
    const [failing, slow] = holds as [HeldCleanup, HeldCleanup]

    let resolved = false
    const pass = manager.cleanupAll().then(() => {
      resolved = true
    })
    failing.fail(new Error('the adapter could not close'))
    await settleMicrotasks()
    expect(resolved).toBe(false)

    slow.release()
    await pass
    expect(resolved).toBe(true)
  })

  it('starts a fresh pass for sessions created after an earlier pass settled', async () => {
    const manager = new SessionManager()
    await manager.createSession(config)
    holds[0]?.release()
    await manager.cleanupAll()

    await manager.createSession(config)
    const later = holds[1] as HeldCleanup
    const pass = manager.cleanupAll()
    await settleMicrotasks()
    expect(later.calls).toBe(1)
    expect(manager.size).toBe(0)

    later.release()
    await pass
    expect(holds.map((hold) => hold.calls)).toEqual([1, 1])
  })
})
