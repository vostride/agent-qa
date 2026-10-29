// The chat session log's event grammar.
//
// MINTED IN SCHEMA, on the `run-notification.ts` precedent and for its stated reason rather than
// by analogy: several packages read these bytes and none may import another. `agent` emits them
// from the turn engine, `agent-local` writes and re-reads them as JSONL, `cli` renders them, and
// M5's dashboard will parse the same file. A grammar that lived beside any one consumer would be
// re-derived by the next, and the two spellings would drift on the first field either wanted.
//
// THE EVENT KIND UNION IS CLOSED AND COMPLETE FROM DAY ONE, including the kinds nothing emits
// yet. CHAT-05 names `model_change`, `active_tools_change`, `compaction` and `aborted` as members
// of the log grammar; declaring them late would make "this build does not know that kind" and
// "that kind did not occur" the same bytes for every reader written in between — which is exactly
// the ambiguity a versioned, append-only log exists to avoid.
//
// MAP, NOT TERRITORY. An event carries REFS and one-line summaries, never payload bodies.
// The one exception is chat's own content: a user message IS the thing chat is a record of, so its
// text is logged. A knowledge record, a config file's contents, a tool result — those live in
// their own stores and appear here as an id and a sentence. The rule is not about size. It is that
// this file is read by surfaces that render it directly, so a field that could carry a secret
// would need a masking boundary at every one of them.

/**
 * Stamped into the header line and checked before any shape question on reopen.
 *
 * A literal type rather than `number` (the `RunNotification` idiom): a header built with last
 * version's shape fails to typecheck at its construction site, which is where the mistake is,
 * rather than at a reader that could only report it as corrupt bytes.
 */
export const CURRENT_CHAT_SESSION_SCHEMA_VERSION = 2

/**
 * The first line of every session file, written and fsynced when the file is created.
 *
 * `model` and `toolsetHash` are the session's opening CONTEXT, not its running state: the log's
 * `model_change` and `active_tools_change` events carry drift from here onwards, so a reader
 * reconstructs "what was in force at turn N" by folding events over this header. Rewriting the
 * header on drift would make the file no longer append-only, which is the one property CHAT-05
 * asks for by name.
 */
export interface ChatSessionHeader {
  schemaVersion: typeof CURRENT_CHAT_SESSION_SCHEMA_VERSION
  sessionId: string
  createdAt: string
  model: string
  toolsetHash: string
  /**
   * WHICH DOOR OPENED THIS CONVERSATION — optional, and on the HEADER.
   *
   * D-04 puts dashboard chat on this exact substrate "tagged with their surface". The obvious
   * spelling is a field on each event, and it is the one thing this grammar cannot have: the guard
   * below compares an EXACT key set per kind, so an extra field on any event kind makes every
   * session file written before it unreadable by the build that comes after. The header's own
   * guard is presence-based and tolerates keys it does not know, so the tag rides here, is written
   * ONCE at create with the rest of the opening context, and never rewritten.
   *
   * ABSENT IS A REAL VALUE AND IT IS THE DEFAULT: a session opened by a host that did not name its
   * surface. That is every file written before Phase 400 and every `agent-qa chat` session written
   * after it — one population, not two, which is what keeps the absence unambiguous. Only a host
   * that has a reason to distinguish itself supplies one, and `agent-qa dashboard` is the first.
   *
   * A PLAIN STRING RATHER THAN A CLOSED UNION, deliberately. The value is the surface's own name —
   * the same word `FunctionCaller.surface` carries for the same door — and the surface roster grows
   * by design (four doors today). A union here would make a session file written by a later build
   * fail to typecheck against an older one for a field no decision is taken on: nothing branches on
   * this value, it is a fact for a reader and a listing filter.
   */
  surface?: string
}

/**
 * Every kind of thing that can happen to a session, spelled ONCE (388 C13).
 *
 * Ordered by the turn they belong to rather than alphabetically, because the order is the shape
 * of a turn and a reader of this list should be able to see one.
 */
export const CHAT_SESSION_EVENT_KINDS = [
  'user_message',
  'stage_outcome',
  'clause_receipt',
  'clause_result',
  'approval_decision',
  'mark_unhandled',
  'model_change',
  'active_tools_change',
  'compaction',
  'aborted',
  'turn_complete',
] as const

export type ChatSessionEventKind = (typeof CHAT_SESSION_EVENT_KINDS)[number]

/**
 * The four-stage routing contract's stages, named rather than numbered in the log.
 *
 * A number would be a position in a pipeline whose length is a design decision; a name survives
 * a stage being inserted, and a reader six months from now can tell which stage answered without
 * the contract in front of them.
 */
export const CHAT_TURN_STAGES = ['resolver', 'planner', 'reconcile', 'execute'] as const

export type ChatTurnStage = (typeof CHAT_TURN_STAGES)[number]

/**
 * What a stage did with the turn.
 *
 * `skipped` is a first-class outcome and not an absence: a turn every clause of which the
 * deterministic table resolved does not consult the planner at all, and that is the tracer's whole
 * point (D-01/D-06 — the LLM is never touched). Logging nothing would make a skipped planner and
 * an unbound one identical in the record.
 */
export const CHAT_STAGE_OUTCOMES = ['resolved', 'skipped', 'unresolved'] as const

export type ChatStageOutcome = (typeof CHAT_STAGE_OUTCOMES)[number]

/** How a turn ended (the value `turn_complete` carries, and the `agent.ask` result's status). */
export const CHAT_TURN_STATUSES = ['completed', 'failed', 'fail_closed'] as const

export type ChatTurnStatus = (typeof CHAT_TURN_STATUSES)[number]

/**
 * The fields EVERY event carries, whatever its kind.
 *
 * `turnId` is on the base rather than per-kind because the log's primary read is "show me that
 * turn", and a kind that could omit it would be a hole in exactly that read. Session-scoped facts
 * that arrive between turns (a config re-read on open) carry the id of the turn they precede.
 */
export interface ChatSessionEventBase<K extends ChatSessionEventKind> {
  kind: K
  turnId: string
  at: string
}

/**
 * What the person typed, verbatim.
 *
 * The ONE payload body in this vocabulary, and the exception is principled: the utterance is not
 * a reference to content held elsewhere, it IS the content, and a session log that recorded
 * "the user said something" would not be the triage report D-18 asks for.
 */
export interface ChatUserMessageEvent extends ChatSessionEventBase<'user_message'> {
  text: string
}

/** Which stage answered, and how. One event per stage the turn actually reached. */
export interface ChatStageOutcomeEvent extends ChatSessionEventBase<'stage_outcome'> {
  stage: ChatTurnStage
  outcome: ChatStageOutcome
}

/**
 * One clause's trip through the function layer, as a REF and a sentence.
 *
 * `functionId` addresses the op; `outcome` is a ONE-LINE human summary; the result itself stays
 * wherever the op put it. `origin` records which caller the composition MINTED for this clause
 * (391 D-06, RESEARCH Pitfall 1) — a deterministic table hit is a person typing, a planner-planned
 * call is not, and the difference is a permission fact worth having in the record.
 */
export interface ChatClauseReceiptEvent extends ChatSessionEventBase<'clause_receipt'> {
  clause: string
  functionId: string
  origin: string
  status: string
  outcome: string
}

/**
 * WHAT ONE CLAUSE'S OP RETURNED — the turn's `results[]` entry, MASKED (399.1, D-05).
 *
 * THE SECOND PAYLOAD BODY IN THIS VOCABULARY, and like the first it is stated as an exception
 * rather than smuggled in. D-18's rule above is that an event carries REFS and one-line summaries,
 * because "this file is read by surfaces that render it directly, so a field that could carry a
 * secret would need a masking boundary at every one of them". That sentence is the REASON, and it
 * is satisfied here by the boundary being crossed BEFORE the bytes arrive rather than at each
 * reader: what rides this field is the function layer's masked payload, and nothing between the op
 * and this line restores a value. Each surface prints what the declared mask produced.
 *
 * VERBATIM-MASKED, NOT A DIGEST — the discretion D-05 left open, resolved. A digest would satisfy
 * the disclosure guard trivially and would also make the record unable to answer the question the
 * channel was minted for: 399's UAT rejected a chat surface that executed ops and could not say
 * what they returned, and a session log holding a hash of the answer reproduces that hole one
 * layer down. The result is the TURN'S OWN TERRITORY (392's receipt charter: the receipt is the
 * map, the territory travels beside it), so it is kept — as filed, masked.
 *
 * THE BINDING CONSTRAINT IS ON THE RECORD.
 * `.planning/phases/399.1-chat-render-contract/399.1-ADJUDICATION-transcript-cleartext.md`
 * § "The load-bearing corollary for D-05": op results can carry credentials, so persisting an
 * UNMASKED entry here would mint a second unadjudicated cleartext sink in this exact file — the
 * class that adjudication names — converting an inherited 392 posture gap into a 399.1 defect.
 * A repair of the two fields that DO carry cleartext today (`user_message.text`,
 * `clause_receipt.clause`) is filed separately as `T-399.1-04`; this kind must never become a
 * third.
 *
 * ONE EVENT PER CLAUSE THAT RAN, never per clause planned: a `not-run` clause has no result, and a
 * line claiming one would be the log asserting an op answered a call nobody made.
 *
 * `payload` IS `unknown` AND MUST BE JSON-REPRESENTABLE. The writer is a JSONL adapter, so an
 * `undefined` payload is written as `null` at the append site rather than omitted — an omitted key
 * would fail the exact-key guard below on reopen, turning an op that returns nothing into a corrupt
 * line.
 */
export interface ChatClauseResultEvent extends ChatSessionEventBase<'clause_result'> {
  functionId: string
  payload: unknown
}

/** The fsync boundary marker. Its presence is what makes the preceding turn non-dangling. */
export interface ChatTurnCompleteEvent extends ChatSessionEventBase<'turn_complete'> {
  status: ChatTurnStatus
}

/**
 * A person's answer at an ask-tier gate. HISTORICAL ONLY.
 *
 * nothing writes this event any more. The chat confirm, the
 * `/pin` verb and the execution gate are deleted, so no build mints an `approval_decision`. The kind
 * and its exact key set stay so a session file a pre-432 build wrote keeps parsing: the session
 * guard throws on an unknown kind, and persisted history stays readable.
 */
export interface ChatApprovalDecisionEvent extends ChatSessionEventBase<'approval_decision'> {
  /** The `fn:`-prefixed risk name the gate classified, not the bare op id. */
  actionClass: string
  decision: 'accept' | 'accept-always' | 'deny'
  /**
   * WHICH DECISION THIS WAS, on `model_change.source`'s precedent and for its reason (plan 08).
   *
   * `gate` — a person answered the inline confirm when an ask-tier capability reached the gate.
   * `verb` — a person typed `/pin <class>`, pre-denying the class for the rest of the session.
   *
   * Both are a human decision about one action class, and collapsing them would leave a reviewer
   * unable to tell a refusal of a specific request from a standing rule the person set in advance.
   * The field is REQUIRED rather than defaulted: nothing had ever emitted an `approval_decision`
   * before this plan, so no session file on disk carries one, and an optional field would have
   * bought back-compatibility with a population of exactly zero lines at the cost of a defaulting
   * rule that then has to be right forever.
   */
  source: 'gate' | 'verb'
}

/**
 * A clause nothing in this build handles.
 *
 * Logged on EVERY occurrence, in live sessions as well as scenario runs, which is what makes
 * CHAT-03's field rate a projection over logs rather than a new metric store. The gated ceiling
 * is computed over the frozen corpus; this event is what makes the ungated field number
 * observable at all.
 */
export interface ChatMarkUnhandledEvent extends ChatSessionEventBase<'mark_unhandled'> {
  clause: string
  reason: string
}

/**
 * The session model changed (D-04, CHAT-05's named config event).
 *
 * `source` distinguishes the two ways it happens, and they are genuinely different facts: a person
 * typed `/model`, or the configuration on disk drifted and the session re-read it (391's
 * human-edits-always-win echo). Collapsing them would leave a reader unable to tell a deliberate
 * switch from one that happened to them.
 */
export interface ChatModelChangeEvent extends ChatSessionEventBase<'model_change'> {
  from: string
  to: string
  source: 'verb' | 'config_reread'
}

/**
 * The reachable toolset changed (D-04, CHAT-05's second named config event).
 *
 * Deltas plus the new fingerprint, not the whole set: the header already carries the opening hash,
 * so a reader folds these to reconstruct what was reachable at turn N. Logging the full set each
 * time would put a copy of the catalogue in the log on every drift.
 *
 * There is no `/tools` toggle producing these — the always-send-all law forbids one. What
 * produces them is a build or configuration that genuinely changed what exists.
 */
export interface ChatActiveToolsChangeEvent extends ChatSessionEventBase<'active_tools_change'> {
  addedIds: readonly string[]
  removedIds: readonly string[]
  toolsetHash: string
}

/**
 * ONE event for the whole degrade pass.
 *
 * The stages of a degrade — hygiene, screenshot stripping, dedup, truncation — are FIELDS of one
 * pass and not sibling kinds, and that is a decision rather than a shorthand: they always run
 * together under one budget for one turn, so a reader asking "what did compaction cost here"
 * wants one row. Sibling kinds would make that question a join.
 *
 * `outcome` carries the substrate's own two answers verbatim (`degrade()`'s `DegradeOutcome`), so
 * the cannot-fit case is reported rather than folded into a success with smaller numbers.
 */
export interface ChatCompactionEvent extends ChatSessionEventBase<'compaction'> {
  beforeTokens: number
  afterTokens: number
  outcome: 'degraded' | 'pinned-content-exceeds-budget'
}

/**
 * A turn that ended without completing (D-19's two arms).
 *
 * `explicit` is a graceful Ctrl+C: the process was alive and wrote this itself. `synthesized` is
 * what the next-turn repair writes after a hard kill, where the dangling turn is inferred from a
 * tail that is not a boundary marker. Both are real and they are different — one says a person
 * stopped, the other says a machine died — and a single spelling would lose that.
 */
export interface ChatAbortedEvent extends ChatSessionEventBase<'aborted'> {
  source: 'explicit' | 'synthesized'
}

/** The complete event union: one member per declared kind. */
export type ChatSessionEvent =
  | ChatUserMessageEvent
  | ChatStageOutcomeEvent
  | ChatClauseReceiptEvent
  | ChatClauseResultEvent
  | ChatApprovalDecisionEvent
  | ChatMarkUnhandledEvent
  | ChatModelChangeEvent
  | ChatActiveToolsChangeEvent
  | ChatCompactionEvent
  | ChatAbortedEvent
  | ChatTurnCompleteEvent

/** Bytes on a session line that do not describe an event this build can read. */
export class ChatSessionEventSchemaError extends Error {
  override readonly name = 'ChatSessionEventSchemaError'

  constructor(readonly detail: string) {
    super(
      `a stored chat session event cannot be read: ${detail}. Lines are written from typed `
      + 'records inside one process, so bytes that fail this guard were written by another '
      + 'build or damaged in place.',
    )
  }
}

/**
 * The EXACT key set each kind carries, spelled once and read by the guard below.
 *
 * A total `Record` over the kind union, which is the compile-time half of the double lock: an
 * twelfth kind cannot be declared without saying what its line looks like. The guard is the
 * runtime half, and the two catch different drifts (`jobs/kinds.ts:619-627`).
 *
 * Exact key sets rather than presence checks, for `run-notification.ts`'s stated reason: a
 * presence check admits a record carrying an EXTRA field, and an extra field on a line several
 * surfaces render is exactly how a payload body arrives in a log that promised refs.
 */
const EVENT_KEYS: Record<ChatSessionEventKind, readonly string[]> = {
  user_message: ['at', 'kind', 'text', 'turnId'],
  stage_outcome: ['at', 'kind', 'outcome', 'stage', 'turnId'],
  clause_receipt: ['at', 'clause', 'functionId', 'kind', 'origin', 'outcome', 'status', 'turnId'],
  clause_result: ['at', 'functionId', 'kind', 'payload', 'turnId'],
  approval_decision: ['actionClass', 'at', 'decision', 'kind', 'source', 'turnId'],
  mark_unhandled: ['at', 'clause', 'kind', 'reason', 'turnId'],
  model_change: ['at', 'from', 'kind', 'source', 'to', 'turnId'],
  active_tools_change: ['addedIds', 'at', 'kind', 'removedIds', 'toolsetHash', 'turnId'],
  compaction: ['afterTokens', 'at', 'beforeTokens', 'kind', 'outcome', 'turnId'],
  aborted: ['at', 'kind', 'source', 'turnId'],
  turn_complete: ['at', 'kind', 'status', 'turnId'],
}

function isChatSessionEventKind(value: unknown): value is ChatSessionEventKind {
  return CHAT_SESSION_EVENT_KINDS.some((kind) => kind === value)
}

/**
 * Guard one line off a session file.
 *
 * THE VERSION IS AN ARGUMENT, NOT A FIELD ON THE LINE, and that is a decision worth stating
 * because the obvious alternative looks safer. The file's version is declared ONCE, on the header
 * line, and the adapter refuses to open a session whose header this build does not read — so a
 * mixed-version file cannot come into existence by appending. Stamping every line as well would
 * be a second answer to the same question, free to disagree with the first, and would put a
 * constant in every line of an append-only file for a hazard the open path already closes.
 *
 * The version is nonetheless checked FIRST, before any shape question, for
 * `job-checkpoint-store.ts:231-237`'s reason: a version mismatch has a remedy an operator can act
 * on, and reporting it as a missing field sends them to repair a line whose real problem is that
 * another build wrote it.
 */
export function guardChatSessionEvent(
  value: unknown,
  declaredVersion: number,
): ChatSessionEvent {
  if (declaredVersion !== CURRENT_CHAT_SESSION_SCHEMA_VERSION) {
    throw new ChatSessionEventSchemaError(
      `its session declares schemaVersion ${String(declaredVersion)}, and this build reads `
      + String(CURRENT_CHAT_SESSION_SCHEMA_VERSION),
    )
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ChatSessionEventSchemaError('it is not an object')
  }
  const record = value as Record<string, unknown>
  if (!isChatSessionEventKind(record.kind)) {
    throw new ChatSessionEventSchemaError(`${String(record.kind)} is not a session event kind`)
  }
  const expected = EVENT_KEYS[record.kind].join(',')
  const actual = Object.keys(record).sort().join(',')
  if (actual !== expected) {
    throw new ChatSessionEventSchemaError(
      `a ${record.kind} line carries ${JSON.stringify(Object.keys(record).sort())} and this `
      + `build writes ${JSON.stringify(EVENT_KEYS[record.kind])}`,
    )
  }
  if (typeof record.turnId !== 'string' || record.turnId === '') {
    throw new ChatSessionEventSchemaError('it names no turn')
  }
  if (typeof record.at !== 'string' || record.at === '') {
    throw new ChatSessionEventSchemaError('it carries no instant')
  }
  return record as unknown as ChatSessionEvent
}
