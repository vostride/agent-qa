// Appends observed outcomes of this run's own chain straight to `events.jsonl`, in process only.

import { appendFileSync, readFileSync } from 'node:fs'

import type {
  ChipEventPayload,
  JobKind,
  MaskFn,
  RunEventEnvelope,
  RunEventType,
} from '@vostride/agent-qa-schema'

import { completedRunEventsPath } from './curation-tail.js'

/**
 * The three chip kinds one chain stage can publish.
 *
 * A `Record` over the chain kinds rather than a lookup with a default, so a chain that grows a
 * member is a compile error here instead of a stage that silently emits nothing.
 */
interface StageChipKinds {
  readonly started: RunEventType
  readonly completed: RunEventType
  readonly failed: RunEventType
}

// A full `Record`, so every job kind states its chip and a new kind fails to compile until it does.
const NO_CHIP = 'no-chip' as const

const STAGE_CHIPS: Record<JobKind, StageChipKinds | typeof NO_CHIP> = {
  chat: NO_CHIP,
  'analyze-run': {
    started: 'analysisStarted',
    completed: 'analysisCompleted',
    failed: 'analysisFailed',
  },
  'curate-memory': {
    started: 'curationStarted',
    completed: 'curationCompleted',
    failed: 'curationFailed',
  },
  consolidate: NO_CHIP,
}

/**
 * What this build has DECIDED about a job kind's chips.
 *
 * Three arms, because there are three facts and the previous `undefined` lookup collapsed two of
 * them. `declared-chip-less` is a kind this build knows and deliberately gives no chip;
 * `unknown-kind` is a kind this build cannot classify at all — a row written by a later build,
 * or a quarantined kind. Both emit nothing (a chip is a claim, and neither has a vocabulary to
 * make one in), and that is exactly why they have to be distinguishable somewhere: silence
 * that means two things cannot be reviewed.
 */
export type PostRunChipDecision =
  | { readonly kind: 'chips'; readonly chips: StageChipKinds }
  | { readonly kind: 'declared-chip-less' }
  | { readonly kind: 'unknown-kind' }

/**
 * The one lookup, total over `JobKind` by construction.
 *
 * `STAGE_CHIPS` is a full `Record` rather than a `Partial`, so a sixth kind added to the shipped
 * vocabulary fails to compile HERE until somebody chooses its chips or writes `NO_CHIP` beside a
 * reason — instead of silently inheriting the chip-less arm from a missing key.
 *
 * The parameter is `string` and not `JobKind` deliberately: the runtime value arrives off a queue
 * row, and a build that narrowed it at the type level would still have to answer for bytes an
 * older or newer build wrote. That is what `unknown-kind` is.
 */
export function postRunChipDecision(kind: string): PostRunChipDecision {
  const declared = Object.hasOwn(STAGE_CHIPS, kind)
    ? STAGE_CHIPS[kind as JobKind]
    : undefined
  if (declared === undefined) return { kind: 'unknown-kind' }
  return declared === NO_CHIP ? { kind: 'declared-chip-less' } : { kind: 'chips', chips: declared }
}

/**
 * The shape of a pump outcome this emitter reads.
 *
 * Structural rather than the engine's `RunNextJobOutcome` itself, and the narrowing is the
 * point: what a chip may say is derived from four fields, so a future disposition that carries
 * new information cannot leak into a chip without somebody widening this type on purpose.
 */
export interface ObservedJobOutcome {
  readonly ran: boolean
  /**
   * The job AS CLAIMED — its id as well as its kind.
   *
   * The id is the only discriminator that answers "whose chain did the pump just watch". It was
   * absent for exactly one round, and the emitter dispatched on kind alone: enough to pick a
   * chip, never enough to pick a run.
   */
  readonly job?: { readonly id: string; readonly kind: JobKind }
  readonly disposition?: 'completed' | 'retry-scheduled' | 'cancelled' | 'failed' | 'interrupted'
  readonly handlerInvoked?: boolean
  readonly reason?: string
}

export interface PostRunChipEmitter {
  /** Turn one observed pump outcome into its chip transitions and append them. */
  observe(outcome: ObservedJobOutcome): void
  /** How many envelopes this emitter has appended. */
  emitted(): number
}

export interface CreatePostRunChipEmitterOptions {
  readonly agentQaRoot: string
  readonly runId: string
  // One `chainJobIdsForRun` derivation, shared with the read op, so two chains cannot split rows.
  readonly chainJobIds: readonly string[]
  /**
   * The tail's declared mask, the same one the fold is threaded with.
   *
   * OPTIONAL because a tail may legitimately carry none, and the bound below still applies —
   * absence must degrade the redaction, never the discipline.
   */
  readonly mask?: MaskFn
  /** The tail's one wall clock, so envelope stamps and budget arithmetic share a source. */
  readonly now?: () => number
  // After the append, same object; a listener fault is swallowed so a viewer cannot abort a drain.
  readonly relay?: (envelope: RunEventEnvelope) => void
}

// A diagnostic pointer, short enough that a runaway exception cannot flood a streamed log.
const CHIP_ERROR_MAX_LENGTH = 500

/**
 * The seq the run's log stopped at.
 *
 * Read from the file rather than carried in memory because the process that WROTE those lines
 * has already closed its bus — `finalSeq` lives on the last line and nowhere else this side of
 * the verdict. A torn or absent log yields 0, which makes the first chip seq 1: the same number
 * the bus itself starts at, so a chip trail over a lost log is still internally ordered rather
 * than anchored to a seq nobody can see.
 */
function lastRecordedSeq(eventsPath: string): number {
  let raw: string
  try {
    raw = readFileSync(eventsPath, 'utf8')
  } catch {
    return 0
  }
  const lines = raw.split('\n').filter((line) => line.length > 0)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]!) as { seq?: unknown }
      if (typeof parsed.seq === 'number' && Number.isFinite(parsed.seq)) return parsed.seq
    } catch {
      // The reader never throws on garbage: a torn final line is skipped.
      continue
    }
  }
  return 0
}

export function createPostRunChipEmitter(
  options: CreatePostRunChipEmitterOptions,
): PostRunChipEmitter {
  const eventsPath = completedRunEventsPath(options.agentQaRoot, options.runId)
  const now = options.now ?? Date.now
  // Masked before it is bounded, because a slice could cut a secret and the masker would miss it.
  const chipError = (reason: string): string =>
    (options.mask?.(reason) ?? reason).slice(0, CHIP_ERROR_MAX_LENGTH)
  // Read ONCE, at construction: the emitter is the only writer of this file from here on, so
  // re-reading per append would be asking a file what this object already knows — and would
  // make the trail's ordering depend on nobody else appending, which is the assumption the
  // in-process-only rule already guarantees.
  let nextSeq = lastRecordedSeq(eventsPath) + 1
  let emitted = 0

  const append = (type: RunEventType, payload: ChipEventPayload): void => {
    const envelope: RunEventEnvelope = {
      seq: nextSeq,
      ts: now(),
      runId: options.runId,
      type,
      payload,
    }
    nextSeq += 1
    emitted += 1
    appendFileSync(eventsPath, `${JSON.stringify(envelope)}\n`)
    // After the append and inside the drop-guard: a foreign chip reaches neither file nor wire.
    try {
      options.relay?.(envelope)
    } catch {
      /* the trail is written; a viewer's fault is not the emitter's, and never the drain's */
    }
  }

  return {
    observe(outcome: ObservedJobOutcome): void {
      if (!outcome.ran) return
      const job = outcome.job
      // An outcome that cannot be ATTRIBUTED must not be emitted. Silence here is a stage whose
      // durable row still answers for it; a chip is a claim, and a claim with no claimant is the
      // one thing this file may never append.
      if (job === undefined) return
      // Rule 3. The pump is a global FIFO, so this is the common case rather than the odd one.
      if (!options.chainJobIds.includes(String(job.id))) return
      const kind = job.kind
      if (kind === undefined) return
      const decision = postRunChipDecision(kind)
      // Two silences, and this build knows which one it is making. `chat` and `consolidate` are
      // not post-processing stages. A kind this build cannot classify is the other case and also
      // emits nothing — a claim needs a vocabulary, and there is none for a row a later build
      // wrote.
      if (decision.kind !== 'chips') return
      const chips = decision.chips

      // `handlerInvoked: false` means the handler never ran, so a `started` chip would be false.
      if (outcome.handlerInvoked !== false) {
        append(chips.started, { runId: options.runId })
      }

      if (outcome.disposition === 'completed') {
        append(chips.completed, { runId: options.runId })
        return
      }
      // Queued again: the push trail keeps `started`, no failure chip; durable state reads pending.
      if (outcome.disposition === 'interrupted') return
      // `cancelled` joins the failure chip deliberately, matching `projectPostProcessingChips`:
      // both are terminal states in which the stage's work did not happen, and a push event
      // that told them apart would disagree with the durable projection of the same row.
      const willRetry = outcome.disposition === 'retry-scheduled'
      append(chips.failed, {
        runId: options.runId,
        ...(outcome.reason === undefined ? {} : { error: chipError(outcome.reason) }),
        ...(willRetry ? { willRetry: true } : {}),
      })
    },

    emitted(): number {
      return emitted
    },
  }
}
