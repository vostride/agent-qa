// Events carry refs and one-line summaries only, so no renderer needs its own masking boundary.

/**
 * Stamped into the header line and checked before any shape question on reopen.
 *
 * A literal type rather than `number` (the `RunNotification` idiom): a header built with last
 * version's shape fails to typecheck at its construction site, which is where the mistake is,
 * rather than at a reader that could only report it as corrupt bytes.
 */
export const CURRENT_CHAT_SESSION_SCHEMA_VERSION = 2

// Written once at create: drift arrives as events, so the file stays append-only.
export interface ChatSessionHeader {
  schemaVersion: typeof CURRENT_CHAT_SESSION_SCHEMA_VERSION
  sessionId: string
  createdAt: string
  model: string
  toolsetHash: string
  // On the header: event guards compare exact key sets, so an event field would break older files.
  surface?: string
}

// Ordered by the turn they belong to, so the list reads as the shape of a turn.
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

// `skipped` is an outcome, so a skipped planner never reads as an unbound one.
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

// The utterance is logged verbatim because it is the content, not a reference.
export interface ChatUserMessageEvent extends ChatSessionEventBase<'user_message'> {
  text: string
}

/** Which stage answered, and how. One event per stage the turn actually reached. */
export interface ChatStageOutcomeEvent extends ChatSessionEventBase<'stage_outcome'> {
  stage: ChatTurnStage
  outcome: ChatStageOutcome
}

// `outcome` is a one-line summary; the result itself stays where the op put it.
export interface ChatClauseReceiptEvent extends ChatSessionEventBase<'clause_receipt'> {
  clause: string
  functionId: string
  origin: string
  status: string
  outcome: string
}

// `payload` must be JSON: an `undefined` result is written as `null`, or the key guard refuses it.
export interface ChatClauseResultEvent extends ChatSessionEventBase<'clause_result'> {
  functionId: string
  payload: unknown
}

/** The fsync boundary marker. Its presence is what makes the preceding turn non-dangling. */
export interface ChatTurnCompleteEvent extends ChatSessionEventBase<'turn_complete'> {
  status: ChatTurnStatus
}

// Nothing writes this kind; it stays because the guard refuses unknown kinds in stored sessions.
export interface ChatApprovalDecisionEvent extends ChatSessionEventBase<'approval_decision'> {
  /** The `fn:`-prefixed risk name the gate classified, not the bare op id. */
  actionClass: string
  decision: 'accept' | 'accept-always' | 'deny'
  // `gate` is an answered inline confirm; `verb` is a `/pin` that pre-denies the class.
  source: 'gate' | 'verb'
}

// Logged on every occurrence, so the field rate is a projection over logs.
export interface ChatMarkUnhandledEvent extends ChatSessionEventBase<'mark_unhandled'> {
  clause: string
  reason: string
}

// `source` tells a person's `/model` apart from configuration drift the session re-read.
export interface ChatModelChangeEvent extends ChatSessionEventBase<'model_change'> {
  from: string
  to: string
  source: 'verb' | 'config_reread'
}

// Deltas plus the new fingerprint; a reader folds them over the header's opening hash.
export interface ChatActiveToolsChangeEvent extends ChatSessionEventBase<'active_tools_change'> {
  addedIds: readonly string[]
  removedIds: readonly string[]
  toolsetHash: string
}

// `outcome` carries `DegradeOutcome` verbatim, so a cannot-fit case is never reported as success.
export interface ChatCompactionEvent extends ChatSessionEventBase<'compaction'> {
  beforeTokens: number
  afterTokens: number
  outcome: 'degraded' | 'pinned-content-exceeds-budget'
}

// `explicit` is a graceful Ctrl+C; `synthesized` is the next-turn repair after a hard kill.
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

// Exact key sets, because a presence check would admit an extra field carrying a payload body.
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
