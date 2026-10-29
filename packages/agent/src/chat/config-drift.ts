// Drift is an event, not a header rewrite, so what was in force at each turn stays answerable.

import type {
  ChatActiveToolsChangeEvent,
  ChatModelChangeEvent,
  ChatSessionEvent,
  ChatSessionHeader,
} from '@vostride/agent-qa-schema'

/**
 * What the toolset was, as the record can express it.
 *
 * The hash is the identity and it is REQUIRED; the ids are the explanation and they are optional.
 * The asymmetry mirrors the log's own: a hash survives on the header line, and an id list does not.
 */
export interface ChatToolsetFingerprint {
  readonly hash: string
  /** Present only when the caller genuinely observed the set — never reconstructed by guessing. */
  readonly ids?: readonly string[]
}

/** The configuration facts a chat session is sensitive to. */
export interface ChatConfigState {
  readonly model: string
  readonly toolset: ChatToolsetFingerprint
}

// `source` tells a typed `/model` apart from a re-read config, through this one function.
export interface ChatConfigDriftStamp {
  readonly turnId: string
  readonly at: string
  readonly source: ChatModelChangeEvent['source']
}

export type ChatConfigDriftEvent = ChatModelChangeEvent | ChatActiveToolsChangeEvent

/** Sorted set difference — the ids in `after` that `before` did not have. */
function added(before: readonly string[], after: readonly string[]): string[] {
  const known = new Set(before)
  return after.filter((id) => !known.has(id)).sort()
}

// Model first when both drift, so every build writes the append-only log in one order.
export function diffChatConfig(
  previous: ChatConfigState,
  current: ChatConfigState,
  stamp: ChatConfigDriftStamp,
): readonly ChatConfigDriftEvent[] {
  const events: ChatConfigDriftEvent[] = []

  if (previous.model !== current.model) {
    events.push({
      kind: 'model_change',
      turnId: stamp.turnId,
      at: stamp.at,
      from: previous.model,
      to: current.model,
      source: stamp.source,
    })
  }

  if (previous.toolset.hash !== current.toolset.hash) {
    // The hash is the trigger, and the ids only ever explain it. A comparison keyed on the id
    // ARRAYS would fire on a reordered registry walk — a difference in nothing but iteration order.
    const before = previous.toolset.ids
    const after = current.toolset.ids
    const knowable = before !== undefined && after !== undefined
    events.push({
      kind: 'active_tools_change',
      turnId: stamp.turnId,
      at: stamp.at,
      addedIds: knowable ? added(before, after) : [],
      removedIds: knowable ? added(after, before) : [],
      toolsetHash: current.toolset.hash,
    })
  }

  return events
}

/**
 * Rebuild what the session last recorded, by folding drift events over the header.
 *
 * THE HEADER IS THE BASE AND THE EVENTS ARE THE DELTAS, walked in file order so the LAST one wins.
 * That is the only reading consistent with an append-only log: an earlier `model_change` is not
 * wrong, it is history, and a fold that took the first would answer with the model a session opened
 * three days ago rather than the one its last turn ran under.
 *
 * `toolset.ids` is deliberately never populated here. Nothing in the record carries the set, and the
 * one thing this function must not do is invent one — see the file header.
 */
export function foldChatConfigState(
  header: ChatSessionHeader,
  events: readonly ChatSessionEvent[],
): ChatConfigState {
  let model = header.model
  let hash = header.toolsetHash

  for (const event of events) {
    if (event.kind === 'model_change') model = event.to
    else if (event.kind === 'active_tools_change') hash = event.toolsetHash
  }

  return { model, toolset: { hash } }
}
