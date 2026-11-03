import { randomUUID } from 'node:crypto'
import { LiveSession } from './live-session.js'
import type { SessionState, LiveSessionConfig, EntityRef } from './types.js'
import type { AppiumManager } from '../execution/appium-manager.js'
import type { ConfigManager } from '../config/index.js'
import type { LiveEditorSubjects } from '../live-view/editor-subjects.js'
import type { RemoteSessionRegistry } from '@vostride/agent-qa-runner'

export interface SessionManagerDeps {
  appiumManager?: AppiumManager
  configManager?: ConfigManager
  configPath?: string
  liveEditorSubjects?: LiveEditorSubjects
  // The host's registry, so a shutdown releases a live session's remote beside its cleanup.
  remoteSessions?: RemoteSessionRegistry
}

export class SessionManager {
  private sessions = new Map<string, LiveSession>()
  // Monotonic per entity and reset on restart, so a reopened entity gets the next number.
  private counters = new Map<string, number>()
  private cleanupInFlight: Promise<void> | undefined

  constructor(private deps: SessionManagerDeps = {}) {}

  async createSession(
    config: LiveSessionConfig,
    entity?: EntityRef,
  ): Promise<{ sessionId: string; sessionNumber: number | null }> {
    if (!config.llmConfig) {
      throw new Error('LLM not configured')
    }

    const sessionId = randomUUID()
    const session = new LiveSession(sessionId, this.deps)
    await session.initialize(config)
    this.sessions.set(sessionId, session)
    // The session is an editor subject for exactly its lifetime.
    this.deps.liveEditorSubjects?.register(sessionId, session.liveAttachment())
    // The idle window runs until the first control socket attaches, so an unopened session ends.
    session.startIdleTimer(() => {
      void this.terminateSession(sessionId).catch((error: unknown) => {
        console.error(`[live-editor] idle expiry could not end session ${sessionId}`, error)
      })
    })

    // `sessionNumber` is for display only; authorization uses the session id.
    let sessionNumber: number | null = null
    if (entity && entity.id) {
      const key = `${entity.type}:${entity.id}`
      sessionNumber = (this.counters.get(key) ?? 0) + 1
      this.counters.set(key, sessionNumber)
    }

    return { sessionId, sessionNumber }
  }

  getSession(sessionId: string): LiveSession | undefined {
    return this.sessions.get(sessionId)
  }

  listSessions(): SessionState[] {
    return Array.from(this.sessions.values()).map(s => s.getState())
  }

  async terminateSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    // Forgotten before the await, so a concurrent second terminate answers false.
    this.sessions.delete(sessionId)
    this.deps.liveEditorSubjects?.unregister(sessionId)
    await session.cleanup()
    // `counters` stays untouched, so the number keeps counting up until restart.
    return true
  }

  // Every shutdown path calls this on one signal, so overlapping calls share one pass.
  cleanupAll(): Promise<void> {
    this.cleanupInFlight ??= this.cleanupEverySession()
    return this.cleanupInFlight
  }

  private async cleanupEverySession(): Promise<void> {
    const sessions = [...this.sessions]
    this.sessions.clear()
    for (const [sessionId] of sessions) this.deps.liveEditorSubjects?.unregister(sessionId)
    try {
      await Promise.allSettled(sessions.map(async ([, session]) => session.cleanup()))
    } finally {
      this.cleanupInFlight = undefined
    }
  }

  getCounter(entity: EntityRef): number {
    return this.counters.get(`${entity.type}:${entity.id}`) ?? 0
  }

  get size(): number {
    return this.sessions.size
  }
}
