// A plain container, not `AbstractChat`, whose tool calls would run before reconciliation finishes.

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
  // The override lives here, or the config re-read would emit a `model_change` undoing `/model`.
  readonly activeModel: string
  // The only name for an interrupted turn, so a SIGINT handler can write its `aborted` event.
  readonly activeTurnId?: string
  /** The conversation as compaction left it, oldest first (see the module head for the direction). */
  readonly conversation: readonly ModelMessage[]
  readonly lastTurn?: ChatLastTurn
  /** `/quit` asked the loop to end. The REPL reads it; nothing in the engine acts on it. */
  readonly closing: boolean
}

// The engine writes and the surface reads after each turn; no subscription reacts mid-turn.
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
