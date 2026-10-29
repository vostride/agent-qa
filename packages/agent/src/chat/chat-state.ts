// The live turn state a chat surface renders from (Phase 392 plan 08, RESEARCH Open Q2).
//
// THE DECISION THIS FILE IS, stated in code because it is a decision and not drift: chat's live
// turn state is a PLAIN IN-MEMORY CONTAINER the engine mutates and the surface reads. CONTEXT
// pre-ratified "AI SDK v6 `AbstractChat`/`ChatState` owns live turn state" (spec §4.2), and full
// adoption of `AbstractChat` with its `DirectChatTransport` is DEFERRED to M5 rather than taken
// here. The reason is a conflict, not a preference: the SDK's chat machinery AUTO-EXECUTES tool
// calls as they stream, and D-10's pre-flight atomicity says reconciliation completes before the
// first side effect. A transport that ran a tool the moment the model named it would execute the
// first clause of a turn the reconciler was about to refuse whole. M5's streaming and HTTP
// machinery is where that transport earns the work of reconciling the two; until then the state
// this file holds is the same shape a surface would read off `ChatState`, minus the auto-run.
//
// WHAT IS IN IT IS WHAT A SURFACE CANNOT ANSWER FOR ITSELF. The active turn id (minted inside the
// engine, and the only thing a Ctrl+C handler can name), the conversation as compaction left it,
// the model in force after any `/model`, and whether `/quit` asked the loop to end. (The
// classes `/pin` denied left with the pin overlay, 432-18.) Everything else a REPL renders —
// receipts, the answer — rides the turn result.
//
// THE CONVERSATION IS `ModelMessage[]`, AND THE DIRECTION IS SPELLED ONCE (392-06's flagged
// mismatch, resolved here because this is the file that holds it). The one projection is
// `replayToModelMessages`: log events become `ChatReplayMessage[]` through `replaySession`, that
// becomes `ModelMessage[]` through the projection, compaction prunes IN THAT FORM, and the prompt
// renders from it. There is no inverse, because there could not be an honest one — pruning drops
// and truncates messages, so re-keying the result back onto turn-stamped replay messages would
// have to invent the turn ids it lost, and a fabricated ref in state several surfaces render is
// the same wrong the `active_tools_change` deltas refuse to commit.

import type { ModelMessage } from 'ai'

import type { ChatTurnStatus, ClauseReceipt } from '@vostride/agent-qa-schema'

/** What the last turn did, as a surface renders it. Absent before the first turn of a session. */
export interface ChatLastTurn {
  readonly turnId: string
  readonly status: ChatTurnStatus
  readonly receipts: readonly ClauseReceipt[]
  readonly answer?: string
}

/** A frozen view of the session's live state. Handed out per read, never the live object. */
export interface ChatStateSnapshot {
  /**
   * The model in force RIGHT NOW, after any `/model` this session ran.
   *
   * This is the value the config re-read compares against, and that is why the override lives here
   * rather than in a variable beside it: a thunk that kept answering the composed model would emit
   * a `model_change` straight back on the next turn, undoing the verb it just recorded.
   */
  readonly activeModel: string
  /**
   * The turn currently in flight, or absent between turns.
   *
   * The ONLY thing that can name an interrupted turn. A SIGINT handler has no other way to write
   * the explicit `aborted` event D-19's graceful arm asks for — the id is minted inside the engine
   * and a surface never sees it until the turn result comes back, which for an interrupted turn is
   * never.
   */
  readonly activeTurnId?: string
  /** The conversation as compaction left it, oldest first (see the module head for the direction). */
  readonly conversation: readonly ModelMessage[]
  readonly lastTurn?: ChatLastTurn
  /** `/quit` asked the loop to end. The REPL reads it; nothing in the engine acts on it. */
  readonly closing: boolean
}

/**
 * The mutable container. The engine writes; the surface reads.
 *
 * Deliberately NOT an event emitter. A REPL renders after each turn returns, and a subscription
 * would be the seam through which a surface started reacting to a turn mid-flight — which is the
 * streaming design M5 owns, not a thing to half-build here.
 */
export interface ChatStateContainer {
  read(): ChatStateSnapshot
  beginTurn(turnId: string): void
  endTurn(turn: ChatLastTurn): void
  setConversation(messages: readonly ModelMessage[]): void
  setActiveModel(model: string): void
  requestClose(): void
}

export interface CreateChatStateInput {
  /** The model the session opened under — `unbound` on a host that composed none. */
  readonly activeModel: string
}

export function createChatState(input: CreateChatStateInput): ChatStateContainer {
  let activeModel = input.activeModel
  let activeTurnId: string | undefined
  let conversation: readonly ModelMessage[] = []
  let lastTurn: ChatLastTurn | undefined
  let closing = false

  return {
    read() {
      // A fresh object per read, with frozen arrays: a surface handed the live members could
      // change what the engine believes is in force, and the one member that would matter is the
      // model — which is exactly the value the drift check compares against.
      return {
        activeModel,
        ...(activeTurnId === undefined ? {} : { activeTurnId }),
        conversation: Object.freeze([...conversation]),
        ...(lastTurn === undefined ? {} : { lastTurn }),
        closing,
      }
    },
    beginTurn(turnId) {
      activeTurnId = turnId
    },
    endTurn(turn) {
      // Cleared on the SAME call that records the result, so "a turn is in flight" and "the last
      // turn finished" can never both be true — an abort handler firing between them would write
      // an `aborted` event for a turn that already carries its `turn_complete`.
      activeTurnId = undefined
      lastTurn = turn
    },
    setConversation(messages) {
      conversation = [...messages]
    },
    setActiveModel(model) {
      activeModel = model
    },
    requestClose() {
      closing = true
    },
  }
}
