// The session log PORT.
//
// Port in schema, factory in the adapter, binding at the composition root — the 390/391 triple, and
// for the same structural reason: `agent`'s turn engine appends through this type and
// `agent-local`'s JSONL adapter implements it, and neither package may import the other.
//
// IT IS ITS OWN PORT, NOT A WIDENING OF `PersistencePort`. The conversation methods were
// deliberately DELETED from that port in 385 (`packages/agent/src/ports/persistence.ts:5-11`), and
// re-adding them here under a new name would restore the thing that deletion removed: a general
// persistence surface whose consumers cannot tell which of its verbs a given host can actually
// answer. A session log has a lifecycle — open, append, boundary, close — that no other stored
// artifact in this system has, and a port shaped like that lifecycle is what makes the fsync
// discipline expressible at all.

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

/**
 * ONE OPEN SESSION, AND EVERY WRITE THAT BELONGS TO IT.
 *
 * The write verbs live HERE rather than on the port, and that placement is the whole of the
 * concurrency contract. When `append` and `turnBoundary` sat on the adapter, the session they wrote
 * to was ADAPTER STATE — a mutable descriptor the most recent `open()` repointed — so two turns
 * whose awaits interleaved wrote into one file: the second session's. What that cost was measured
 * rather than argued (392-VERIFICATION, CR-01): both turns' events fully interleaved in session B's
 * file, session A's turn missing from its own conversation, and — because a session whose last
 * event is not `turn_complete` is a DANGLING turn — that turn synthesized as `aborted` and pruned
 * out of the replay, the user's own message included, on the very next open.
 *
 * Session identity is therefore a PARAMETER of the write path. A caller cannot name the wrong
 * session because it never names one at all: it holds the handle its own `open()` returned.
 *
 * A HANDLE IS OWNED, AND OWNERSHIP ENDS AT `close()`. Appending or syncing through a closed handle
 * is a typed refusal rather than a write somewhere else — the failure mode a "reopen it quietly"
 * fallback would restore is exactly the aliasing above.
 */
export interface ChatSessionHandle extends OpenedChatSession {
  /** Append one event to THIS session. Durability is NOT claimed until {@link turnBoundary} returns. */
  append(event: ChatSessionEvent): Promise<void>
  /**
   * The fsync point for THIS session.
   *
   * Per TURN rather than per event, which is what makes the loss bound exactly the in-flight turn —
   * the thing the next-turn repair already knows how to handle. Syncing per event would pay for a
   * durability guarantee finer than any reader can use.
   */
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
  /**
   * Open a session, creating one when no id is given.
   *
   * A SUPPLIED id is a claim that the session exists. An unknown one is a typed refusal and never
   * a create: a surface that mistyped an id and got a fresh empty session would be told its history
   * was lost when in fact it was never looked at (D-17, RESEARCH Open Q4).
   *
   * A BUSY id is a refusal too, and a different one — the session exists and somebody else is
   * writing it. Adapters raise their own named error for that case; the caller's remedy is to wait
   * for the holder rather than to look for the history elsewhere.
   */
  open(sessionId?: string): Promise<ChatSessionHandle>
}
