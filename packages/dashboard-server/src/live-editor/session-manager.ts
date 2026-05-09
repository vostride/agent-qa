import { randomUUID } from 'node:crypto'
import { LiveSession } from './live-session.js'
import type { SessionState, LiveSessionConfig, EntityRef } from './types.js'
import type { AppiumManager } from '../execution/appium-manager.js'
import type { ConfigManager } from '../config/index.js'

export interface SessionManagerDeps {
  appiumManager?: AppiumManager
  configManager?: ConfigManager
  configPath?: string
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
    await session.cleanup()
    this.sessions.delete(sessionId)
    // Note: `counters` intentionally left untouched — per D-30 the counter is
    // monotonic per-restart.
    return true
  }

  async cleanupAll(): Promise<void> {
    for (const session of this.sessions.values()) {
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
