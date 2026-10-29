// A checkpointed kind with an empty schedule is refused, or a crash matrix covers it vacuously.

import type { ChainedJobRequest, Job, JobHandlerOutcome, JobKind } from '@vostride/agent-qa-schema'

import type { BoundRecordLlmAuthorship } from './record-llm-authorship.js'

/** What a handler is handed. Checkpoint publication is a capability, never an import. */
export interface JobHandlerContext {
  readonly job: Job
  /**
   * The work the enqueuer described.
   *
   * Carried beside the job rather than on it: the `Job` DTO is the queue's public row and the
   * payload is opaque input that only this kind's handler knows how to read. A handler that
   * could not see it could not do any real work at all — every kind would be a function of
   * its own id.
   */
  readonly payload: unknown
  publishCheckpoint(checkpointId: string, value: unknown): Promise<void>
  // The only path from a job to a model; its member set is pinned so no accessor can join it.
  readonly recordLlmAuthorship: BoundRecordLlmAuthorship
}

// The kind declares what may chain; the handler returns only the instances.
export type JobHandler = (context: JobHandlerContext) => Promise<JobHandlerOutcome>

// Data, not a function, so the delay for attempt N is a pure function of the policy.
export type JobBackoffPolicy =
  | { readonly kind: 'none' }
  | { readonly kind: 'fixed'; readonly delayMs: number }
  | {
      readonly kind: 'exponential'
      readonly initialDelayMs: number
      readonly factor: number
      readonly maxDelayMs: number
    }

// No model capability here, so a fallback producer cannot invoke a model.
export interface FallbackContinuationInput {
  readonly job: Job
  readonly payload: unknown
  readonly reason: string
}

/**
 * The deterministic continuation a kind produces when it has permanently failed.
 *
 * SYNCHRONOUS on purpose, and that is the load-bearing half of the guarantee above: a
 * producer that returned a promise could await anything at all, including a model call. One
 * that must return its instances immediately can only compute them from what it was handed.
 */
export type FallbackContinuationProducer = (
  input: FallbackContinuationInput,
) => readonly ChainedJobRequest[]

// `'halt-chain'` enqueues nothing; a producer names the successors the chain proceeds with.
export type JobPermanentFailureDisposition = 'halt-chain' | FallbackContinuationProducer

export interface JobKindDeclaration {
  readonly kind: JobKind
  /** `false` means the kind resumes NOTHING after a crash — chat's posture. */
  readonly checkpointed: boolean
  /** The complete set of checkpoint ids this kind may publish, in schedule order. */
  readonly checkpointSchedule: readonly string[]
  readonly allowedSuccessors: readonly JobKind[]
  /** Attempts are spent at CLAIM, so this bound holds even for a job that never returns. */
  readonly maxAttempts: number
  readonly backoff: JobBackoffPolicy
  readonly onPermanentFailure: JobPermanentFailureDisposition
  readonly handler: JobHandler
}

/** Thrown at construction when two declarations claim the same kind — never last-wins. */
export class DuplicateJobKindError extends Error {
  override readonly name = 'DuplicateJobKindError'

  constructor(readonly jobKind: JobKind) {
    super(`Duplicate agent job kind: ${jobKind}`)
  }
}

/** Thrown when the engine is asked to act on a kind no declaration covers. */
export class UnknownJobKindError extends Error {
  override readonly name = 'UnknownJobKindError'

  constructor(readonly jobKind: string) {
    super(
      `Unknown agent job kind: ${jobKind}. A kind must be declared before it can be ` +
        'enqueued or run, so an undeclared kind cannot reach a handler at all.',
    )
  }
}

/** Thrown at construction when a declaration omits a field the engine reads. */
export class IncompleteJobKindDeclarationError extends Error {
  override readonly name = 'IncompleteJobKindDeclarationError'

  constructor(
    readonly jobKind: string,
    readonly field: string,
  ) {
    super(
      `Agent job kind ${jobKind} declares no ${field}. Every field of a kind declaration is ` +
        'read by the engine, and a default supplied here would decide a kind\'s recovery ' +
        'behaviour on behalf of whoever wrote the kind.',
    )
  }
}

/** Thrown at construction when a complete declaration still cannot be true of any kind. */
export class InconsistentJobKindDeclarationError extends Error {
  override readonly name = 'InconsistentJobKindDeclarationError'

  constructor(
    readonly jobKind: string,
    readonly detail: string,
  ) {
    super(`Agent job kind ${jobKind} has an inconsistent declaration: ${detail}`)
  }
}

export interface JobKindRegistry {
  /** Declarations in kind order, so any registry-driven harness is order-stable. */
  list(): readonly JobKindDeclaration[]
  get(kind: JobKind): JobKindDeclaration | undefined
  /** `get`, but refusing rather than returning `undefined` for an undeclared kind. */
  require(kind: JobKind): JobKindDeclaration
}

/**
 * Checked in this order, so the field a caller is told about is deterministic.
 *
 * `kind` is first because every other refusal message names it.
 */
const REQUIRED_FIELDS = [
  'kind',
  'checkpointed',
  'checkpointSchedule',
  'allowedSuccessors',
  'maxAttempts',
  'backoff',
  'onPermanentFailure',
  'handler',
] as const

function requireFields(declaration: JobKindDeclaration): void {
  const record = declaration as unknown as Record<string, unknown>
  const named = typeof record.kind === 'string' ? record.kind : '<undeclared>'
  for (const field of REQUIRED_FIELDS) {
    const value = record[field]
    if (value === undefined || value === null) {
      throw new IncompleteJobKindDeclarationError(named, field)
    }
  }
}

function requireCheckpointSchedule(declaration: JobKindDeclaration): void {
  const { kind, checkpointed, checkpointSchedule } = declaration
  if (!Array.isArray(checkpointSchedule)) {
    throw new InconsistentJobKindDeclarationError(kind, 'the checkpoint schedule is not a list')
  }
  // The vacuous-coverage hole, closed in both directions.
  if (checkpointed && checkpointSchedule.length === 0) {
    throw new InconsistentJobKindDeclarationError(
      kind,
      'it checkpoints but names no checkpoint. A crash matrix derives its crash points from ' +
        'the declared schedule, so an empty one would report full coverage of a kind it never ' +
        'interrupted even once.',
    )
  }
  if (!checkpointed && checkpointSchedule.length > 0) {
    throw new InconsistentJobKindDeclarationError(
      kind,
      'it does not checkpoint yet names checkpoints. Publishing any of them would be refused ' +
        'at the call, so the schedule describes state nothing could ever resume from.',
    )
  }
  const seen = new Set<string>()
  for (const checkpointId of checkpointSchedule) {
    if (typeof checkpointId !== 'string' || checkpointId.trim() === '') {
      throw new InconsistentJobKindDeclarationError(kind, 'a checkpoint id is not a usable id')
    }
    if (seen.has(checkpointId)) {
      throw new InconsistentJobKindDeclarationError(
        kind,
        `checkpoint ${checkpointId} is declared twice, so two crash points would carry one name`,
      )
    }
    seen.add(checkpointId)
  }
}

function requireSuccessors(declaration: JobKindDeclaration): void {
  const { kind, allowedSuccessors } = declaration
  if (!Array.isArray(allowedSuccessors)) {
    throw new InconsistentJobKindDeclarationError(kind, 'the successor topology is not a list')
  }
  const seen = new Set<string>()
  for (const successor of allowedSuccessors) {
    if (seen.has(successor)) {
      throw new InconsistentJobKindDeclarationError(kind, `successor ${successor} is declared twice`)
    }
    seen.add(successor)
  }
}

function requireAttemptBound(declaration: JobKindDeclaration): void {
  const { kind, maxAttempts } = declaration
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new InconsistentJobKindDeclarationError(
      kind,
      `maxAttempts ${String(maxAttempts)} is not a whole number of attempts of at least one`,
    )
  }
}

function requireBackoff(declaration: JobKindDeclaration): void {
  const { kind, backoff } = declaration
  const nonNegative = (value: number): boolean => Number.isFinite(value) && value >= 0
  if (backoff.kind === 'none') return
  if (backoff.kind === 'fixed') {
    if (!nonNegative(backoff.delayMs)) {
      throw new InconsistentJobKindDeclarationError(kind, 'the fixed backoff delay is not a delay')
    }
    return
  }
  if (backoff.kind === 'exponential') {
    if (!nonNegative(backoff.initialDelayMs) || !nonNegative(backoff.maxDelayMs)) {
      throw new InconsistentJobKindDeclarationError(
        kind,
        'an exponential backoff bound is not a delay',
      )
    }
    if (!Number.isFinite(backoff.factor) || backoff.factor < 1) {
      // A factor below one is a backoff that gets FASTER as a job keeps failing.
      throw new InconsistentJobKindDeclarationError(
        kind,
        `the exponential backoff factor ${String(backoff.factor)} does not grow the delay`,
      )
    }
    if (backoff.maxDelayMs < backoff.initialDelayMs) {
      throw new InconsistentJobKindDeclarationError(
        kind,
        'the exponential backoff ceiling is below its own first delay',
      )
    }
    return
  }
  throw new InconsistentJobKindDeclarationError(
    kind,
    `${String((backoff as { kind: unknown }).kind)} is not a backoff policy this build applies`,
  )
}

function requireDisposition(declaration: JobKindDeclaration): void {
  const { kind, onPermanentFailure } = declaration
  if (onPermanentFailure === 'halt-chain') return
  if (typeof onPermanentFailure === 'function') return
  throw new InconsistentJobKindDeclarationError(
    kind,
    'the permanent-failure disposition is neither a halt nor a continuation producer',
  )
}

function requireHandler(declaration: JobKindDeclaration): void {
  if (typeof declaration.handler !== 'function') {
    throw new InconsistentJobKindDeclarationError(declaration.kind, 'the handler is not callable')
  }
}

/**
 * Validate one declaration completely before it can be registered.
 *
 * A type binds only the callers the compiler sees; these checks bind an in-workspace cast and
 * a plain-JS consumer of the published package as well, which is the same reason the function
 * layer refuses a hollow audit sink at runtime rather than trusting its own signature.
 */
function validate(declaration: JobKindDeclaration): void {
  requireFields(declaration)
  requireCheckpointSchedule(declaration)
  requireSuccessors(declaration)
  requireAttemptBound(declaration)
  requireBackoff(declaration)
  requireDisposition(declaration)
  requireHandler(declaration)
}

export function createJobKindRegistry(
  declarations: readonly JobKindDeclaration[],
): JobKindRegistry {
  const byKind = new Map<JobKind, JobKindDeclaration>()
  for (const declaration of declarations) {
    validate(declaration)
    if (byKind.has(declaration.kind)) {
      throw new DuplicateJobKindError(declaration.kind)
    }
    byKind.set(
      declaration.kind,
      Object.freeze({
        ...declaration,
        checkpointSchedule: Object.freeze([...declaration.checkpointSchedule]),
        allowedSuccessors: Object.freeze([...declaration.allowedSuccessors]),
      }),
    )
  }

  const sorted = [...byKind.values()].sort((left, right) =>
    left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0,
  )

  return {
    list: () => sorted,
    get: (kind) => byKind.get(kind),
    require: (kind) => {
      const declaration = byKind.get(kind)
      if (declaration === undefined) {
        throw new UnknownJobKindError(kind)
      }
      return declaration
    },
  }
}
