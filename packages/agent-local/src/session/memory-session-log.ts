// The in-memory session log twin (Phase 392, D-14 — storage stays a port).
//
// It exists so a hermetic test can drive a whole turn without a temp directory, and it implements
// the SAME `SessionLogPort` the disk adapter does — which is the only reason a twin is honest. A
// second, looser shape would let a test pass against a contract production never signs.
//
// It is NOT a stand-in for the durability properties. `turnBoundary` here is a no-op because there
// is nothing to sync, and any test whose subject is the fsync ORDER must drive the disk adapter
// through its recorder facade instead (`createJsonlSessionLogOn`). Using this twin for that would
// be measuring a promise nobody made.

import { repairSession } from '@vostride/agent-qa-agent'
import { CURRENT_CHAT_SESSION_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type {
  ChatSessionEvent,
  ChatSessionHandle,
  ChatSessionHeader,
  OpenedChatSession,
  SessionLogPort,
} from '@vostride/agent-qa-schema'

import {
  ChatSessionBusyError,
  UnknownChatSessionError,
  mintChatSessionId,
} from './jsonl-session-log.js'

export interface CreateMemorySessionLogOptions {
  readonly now: () => string
  readonly model: () => string
  readonly toolsetHash: () => string
  readonly random?: () => number
}

export interface MemorySessionLog extends SessionLogPort {
  /** Everything written, for assertions. A copy, so a caller cannot edit the log through it. */
  snapshot(sessionId: string): OpenedChatSession | undefined
}

export function createMemorySessionLog(
  options: CreateMemorySessionLogOptions,
): MemorySessionLog {
  const sessions = new Map<string, { header: ChatSessionHeader; events: ChatSessionEvent[] }>()
  const random = options.random ?? Math.random
  // THE TWIN CARRIES THE CONCURRENCY CONTRACT TOO. What was `let current` here —
  // the same single-session shape the disk adapter's single `fd` had — is gone, and for the reason
  // 390 paid for once: a read-side fix without its write-side twin is a regression generator. A
  // twin that kept a "current session" would let every hermetic test pass against a contract
  // production no longer signs, which is the failure this file's own header already warns about.
  const liveSessions = new Set<string>()

  function handleFor(id: string, opened: OpenedChatSession): ChatSessionHandle {
    let live = true
    const requireLive = (verb: string): void => {
      if (!live) {
        throw new TypeError(
          `a chat session ${verb} cannot go through a closed handle for ${id}. Open the session `
          + 'again to write to it.',
        )
      }
    }
    liveSessions.add(id)
    return {
      header: opened.header,
      events: opened.events,
      refusedLines: opened.refusedLines,
      append(event: ChatSessionEvent): Promise<void> {
        requireLive('event')
        sessions.get(id)!.events.push(event)
        return Promise.resolve()
      },
      turnBoundary(): Promise<void> {
        // A no-op because there is nothing to sync — and a REFUSAL after close, so the twin
        // answers the same question the disk adapter does rather than a laxer one.
        requireLive('turn boundary')
        return Promise.resolve()
      },
      close(): Promise<void> {
        if (live) {
          live = false
          liveSessions.delete(id)
        }
        return Promise.resolve()
      },
    }
  }

  return {
    open(sessionId?: string): Promise<ChatSessionHandle> {
      if (sessionId !== undefined) {
        const existing = sessions.get(sessionId)
        // The same refusal the disk adapter raises, and deliberately the same class: a test that
        // proves the refusal against this twin proves it about the vocabulary production uses.
        if (existing === undefined) throw new UnknownChatSessionError(sessionId)
        if (liveSessions.has(sessionId)) throw new ChatSessionBusyError(sessionId)
        // THE SAME REPAIR PATH, not a twin of it. A hermetic test that resumed a dangling session
        // here and saw no synthesized abort would be passing against a contract production does
        // not sign. The events are re-serialized so they enter `repairSession` exactly as disk
        // lines do — the twin cannot produce a torn line or a damaged one, which is precisely why
        // it must not get its own shortcut for deciding what a resumed session means.
        const repair = repairSession(
          existing.events.map((event, index) => ({
            lineNumber: index + 2,
            text: JSON.stringify(event),
          })),
          { declaredVersion: existing.header.schemaVersion, now: options.now },
        )
        existing.events.push(...repair.synthesized)
        return Promise.resolve(
          handleFor(sessionId, {
            header: existing.header,
            events: [...existing.events],
            // Always empty here, and that is the honest answer rather than a placeholder: this
            // twin stores typed records, so no line of it can be damaged in the way a file's can.
            refusedLines: repair.refusedLines,
          }),
        )
      }
      const createdAt = options.now()
      const id = mintChatSessionId(createdAt, random)
      const header: ChatSessionHeader = {
        schemaVersion: CURRENT_CHAT_SESSION_SCHEMA_VERSION,
        sessionId: id,
        createdAt,
        model: options.model(),
        toolsetHash: options.toolsetHash(),
      }
      sessions.set(id, { header, events: [] })
      return Promise.resolve(handleFor(id, { header, events: [], refusedLines: [] }))
    },

    snapshot(sessionId: string): OpenedChatSession | undefined {
      const found = sessions.get(sessionId)
      return found === undefined
        ? undefined
        : { header: found.header, events: [...found.events], refusedLines: [] }
    },
  }
}
