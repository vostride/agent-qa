// `agent` appends through this port and `agent-local` implements it; neither may import the other.

import type { ChatSessionEvent, ChatSessionHeader } from './session-events'

/**
 * One line an open could not read, surfaced as data rather than thrown over.
 *
 * MINTED HERE rather than beside the repair logic, for this vocabulary's usual reason: the shape
 * crosses the port, so `agent`'s repair produces it and `agent-local`'s adapters hand it back, and
 * neither package may import the other. `lineNumber` is 1-based and counts the header line, so it
 * names what an editor shows the person who has to go and look.
 */
export interface RefusedChatSessionLine {
  lineNumber: number
  reason: string
}

/**
 * What `open` answers: the header in force, every event already on file, and what it could not read.
 *
 * `refusedLines` IS PART OF THE ANSWER, not an aside. A session file can carry damage that the
 * append-only law forbids ever removing — a line another build wrote, or one edited in place — and
 * the open path is the single moment in the system where that is known. Dropping it here would
 * leave every later surface to re-derive it with a second parser, which is how two readers end up
 * disagreeing about whether a conversation is intact. A clean session answers with an empty list.
 */
export interface OpenedChatSession {
  header: ChatSessionHeader
  events: readonly ChatSessionEvent[]
  refusedLines: readonly RefusedChatSessionLine[]
}

// Writes go through the handle `open()` returned, so two interleaved turns cannot share one file.
export interface ChatSessionHandle extends OpenedChatSession {
  /** Append one event to THIS session. Durability is NOT claimed until {@link turnBoundary} returns. */
  append(event: ChatSessionEvent): Promise<void>
  // Synced per turn, so a crash loses at most the in-flight turn, which the next open repairs.
  turnBoundary(): Promise<void>
  /** Release the session's descriptor. Idempotent, so a `finally` may call it unconditionally. */
  close(): Promise<void>
}

/**
 * The session log, as everything that is not one session.
 *
 * ONE ADAPTER SERVES ANY NUMBER OF SESSIONS CONCURRENTLY, each through its own handle, and the
 * adapter holds no notion of a "current" one. AT MOST ONE LIVE HANDLE PER SESSION ID: a second open
 * of a session somebody is already holding is a typed refusal, because two handles on one file
 * would interleave two turns inside a single conversation — the same damage as the cross-session
 * case, one level down, and the one a double-submit on the daemon delivers.
 *
 * THIS SENTENCE IS THE CONTRACT, STATED ONCE. Both shipped adapters implement it — the JSONL disk
 * adapter and its in-memory twin — and a twin that kept a looser shape would let hermetic tests
 * pass against a contract production does not sign (390's one-sided-hardening lesson, which this
 * port exists on the far side of).
 */
export interface SessionLogPort {
  // A supplied id must exist: an unknown id is refused, never silently created.
  open(sessionId?: string): Promise<ChatSessionHandle>
}
