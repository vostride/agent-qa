// configuration changes are EVENTS, not silent state.
//
// TWO PURE FUNCTIONS AND NO I/O. One folds what a session last RECORDED about its configuration out
// of the log it already has; the other diffs that against what the host re-read, and answers in
// events. Neither reads a file, resolves a profile or walks a registry — the current state arrives
// as data from the composition root, which is the only place that knows how this host resolves a
// model and enumerates a toolset. A drift module that re-read the configuration itself would be a
// second resolution path, free to disagree with the one the turn actually runs under.
//
// WHY DRIFT IS AN EVENT AND NOT A HEADER REWRITE. The log is append-only by contract, so
// the opening context stays on the header forever and everything after it is a delta a reader folds
// forward. That is what makes "what was in force at turn N" answerable at all; rewriting the header
// would give the file one truth — the latest — and destroy every earlier one.
//
// THE UNKNOWN-PREVIOUS-IDS ARM IS AN HONEST GAP, STATED. A header carries the toolset HASH and not
// the ids behind it, so a session reopened after a build change can prove the reachable set moved
// and cannot name what moved. Both facts are kept: the event fires, because the hash is the drift,
// and its deltas are EMPTY, because nothing in the record knows them. Filling them with the current
// set would put a fabricated delta into an append-only file, which is worse than an unnamed one —
// a reader can act on "changed, contents unknown" and cannot act on a delta that is wrong.

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

/**
 * Which turn a drift belongs to, when it happened, and WHY the model moved.
 *
 * `source` distinguishes the two ways a model changes and they are genuinely different facts: a
 * person typed `/model`, or the configuration on disk drifted and the session re-read it (391's
 * human-edits-always-win echo). Collapsing them would leave a reader unable to tell a deliberate
 * switch from one that happened to them. The `verb` arm is what plan 08's directive handler stamps;
 * both arms produce the SAME event through this one function rather than through two emitters.
 */
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

/**
 * Diff two configuration states into the events the session log carries.
 *
 * MODEL FIRST when both drifted, because a reader folding the log rebuilds "what was in force" in
 * that order and because the model is the fact a person is far more likely to be looking for. The
 * order is fixed rather than incidental: it is bytes in an append-only file that several surfaces
 * render, and two builds emitting them in different orders would make the file's shape depend on
 * which one wrote it.
 */
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
