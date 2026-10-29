import { randomUUID } from 'node:crypto'
import { LiveSession } from './live-session.js'
import type { SessionState, LiveSessionConfig, EntityRef } from './types.js'
import type { AppiumManager } from '../execution/appium-manager.js'
import type { ConfigManager } from '../config/index.js'
import type { LiveEditorSubjects } from '../live-view/editor-subjects.js'

export interface SessionManagerDeps {
  appiumManager?: AppiumManager
  configManager?: ConfigManager
  configPath?: string
  liveEditorSubjects?: LiveEditorSubjects
}

export class SessionManager {
  private sessions = new Map<string, LiveSession>()
  // Per-entity counter keyed by `${entityType}:${entityId}`.
  // Monotonic and ephemeral: resets on server restart per CONTEXT D-30.
  // Never decremented on terminate — a re-open of a terminated entity yields
  // the next number so "Session #3" after "#2" ends does not confuse users.
  private counters = new Map<string, number>()

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
    // the session is an editor subject for exactly its lifetime.
    this.deps.liveEditorSubjects?.register(sessionId, session.liveAttachment())
    // RESEARCH P1: the idle window runs until the first control socket attaches (the upgrade
    // clears it), so a session nobody ever opens cannot hold a browser or a lease forever.
    session.startIdleTimer(() => {
      void this.terminateSession(sessionId).catch((error: unknown) => {
        console.error(`[live-editor] idle expiry could not end session ${sessionId}`, error)
      })
    })

    // sessionNumber is used for display only; never for authorization lookups
    // (always use sessionId UUID for that — see threat T-181.1-07).
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
    // Note: `counters` intentionally left untouched — per D-30 the counter is
    // monotonic per-restart.
    return true
  }

  async cleanupAll(): Promise<void> {
    for (const [sessionId, session] of this.sessions) {
      this.deps.liveEditorSubjects?.unregister(sessionId)
      try { await session.cleanup() } catch {}
    }
    this.sessions.clear()
  }

  getCounter(entity: EntityRef): number {
    return this.counters.get(`${entity.type}:${entity.id}`) ?? 0
  }

  get size(): number {
    return this.sessions.size
  }
}
