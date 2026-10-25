// The post-run chain's derived facts (Phase 388, RESEARCH Pattern 2).
//
// Everything the chain needs to know about itself is COMPUTED from `runId`, and that is the
// mechanism the whole phase rests on rather than a convenience. Job ids are derived from
// `(kind, idempotencyKey)` through an injected source, and successor keys are derived from
// the predecessor's id — so given a run id alone, any process can name every job the chain
// would have enqueued without reading a row, without a chains table, and without parent
// pointers. The chip projection addresses exactly these ids; the chain-terminal check asks
// which of them exist and whether each is terminal.
//
// The alternative — recording chain membership as state — would need a second durable fact
// to be kept in step with the first, and the first thing a stale chain table does is report
// a chain complete because it never heard about the job that is still running.
//
// The derivation is stated ONCE, here, and imported by everything that needs it. Two copies
// of a hash input differing by a space are two different chains that look identical in
// review.

import type { JobId, JobKind, RunNotification, Verdict } from '@vostride/agent-qa-schema'
import {
  CURRENT_RUN_NOTIFICATION_SCHEMA_VERSION, CurationSnapshotSchema, RunNotificationSchemaError,
} from '@vostride/agent-qa-schema'

import type { JobIdSource } from './engine.js'

/**
 * The kinds whose finish can BE the chain's terminal in this build.
 *
 * Every kind the chain derives an id for is a member, so this list IS the kind set
 * `chainJobIdsForRun` below asks the id source for — there is no declared-but-empty slot left
 * to ask about. `__tests__/chain-identity.test.ts` pins the two against each other by name, so
 * a chain that grows an id without extending this list, or extends this list without deriving
 * the id, reds there rather than reporting a terminal one job early.
 *
 * A kind is listed here when its finish CAN be the last one. `curate-memory` declares no
 * successor, so its finish is the ordinary terminal; `analyze-run` is a member because the chain
 * derives an id for it and `chainTerminalFor` declines it on the successor it produced.
 */
export const POST_RUN_CHAIN_TERMINAL_KINDS: readonly JobKind[] = Object.freeze([
  'analyze-run',
  'curate-memory',
])

/** The job ids one run's chain addresses, whether or not any of them exists. */
export interface ChainJobIds {
  readonly analyzeRun: JobId
  readonly curateMemory: JobId
}

/**
 * Every id the chain for `runId` would carry, from `runId` and the id source alone.
 *
 * The successor keys mirror `successorsOf` in kinds.ts verbatim — `${predecessorId}->${kind}`
 * — because they ARE the same keys: this function predicts what that function will ask for.
 * If the two ever disagree, the projection addresses rows that exist under other ids, which
 * is the failure the shared derivation exists to make impossible.
 */
export function chainJobIdsForRun(runId: string, idSource: JobIdSource): ChainJobIds {
  const analyzeRun = idSource.jobIdFor('analyze-run', runId)
  return {
    analyzeRun,
    curateMemory: idSource.jobIdFor('curate-memory', `${String(analyzeRun)}->curate-memory`),
  }
}

/**
 * The marker a permanently failed analysis leaves on the successors it hands on (D-20).
 *
 * Read by the notification builder to report the analysis stage honestly: the chain proceeded
 * with no verdicts, and the record has to say so even though the job that reports the
 * terminal is the one that succeeded afterwards.
 */
export const UNKNOWN_VERDICTS_MARKER = 'unknown'

export interface ChainTerminalNotificationInput {
  readonly runId: string
  /** The kind whose finish is landing the chain terminal. */
  readonly finishingKind: JobKind
  /** How that job itself ended. */
  readonly finished: 'done' | 'failed'
  /** The payload it was claimed with — the carrier of the upstream stages' provenance. */
  readonly payload: unknown
  /** The values this attempt published, by checkpoint id. Empty on a job that published none. */
  readonly publishedValues: ReadonlyMap<string, unknown>
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/**
 * The verdict summary the analysis stage put on its successor's payload.
 *
 * Absent is not a failure and not a zero-filled guess — it is a chain whose analysis never
 * produced verdicts, which the fallback marker reports separately. An unreadable summary
 * degrades to the empty one rather than refusing: this record is written inside the
 * transaction that lands a job terminal, and a guard that threw here would trade a slightly
 * poorer notification for a rolled-back completion.
 */
function readVerdictSummary(payload: Record<string, unknown>): RunNotification['verdictSummary'] {
  const summary = asRecord(payload.verdictSummary)
  const byClassSource = asRecord(summary.byClass)
  if (!isCount(summary.total)) return { total: 0, byClass: {} }
  const byClass: Partial<Record<Verdict['class'], number>> = {}
  for (const [className, count] of Object.entries(byClassSource)) {
    if (isCount(count)) byClass[className as Verdict['class']] = count
  }
  return { total: summary.total, byClass }
}

/**
 * Assemble the record from what the engine holds at the terminal — nothing is read back.
 *
 * Every stage's outcome is derivable from three facts already in hand: which kind is
 * finishing, how it ended, and what its payload says about the stages upstream of it. That
 * matters because this runs immediately before the terminal transaction; a builder that
 * needed a query would be reading rows the same transaction is about to change.
 */
export function buildChainTerminalNotification(
  input: ChainTerminalNotificationInput,
): RunNotification {
  const payload = asRecord(input.payload)

  // The fallback marker travels FORWARD on the successor payload, so a curate-memory job that
  // succeeded after a dead analysis still knows the analysis died. Without it the record
  // would report the only stage it watched and call the chain done.
  const analysisFailed =
    payload.verdicts === UNKNOWN_VERDICTS_MARKER ||
    (input.finishingKind === 'analyze-run' && input.finished === 'failed')

  const committed = asRecord(input.publishedValues.get('bundle-committed'))
  const curationSucceeded = input.finishingKind === 'curate-memory' && input.finished === 'done'
  const snapshot = curationSucceeded && committed.curationSnapshot !== undefined
    ? CurationSnapshotSchema.safeParse(committed.curationSnapshot)
    : undefined
  if (snapshot !== undefined && !snapshot.success) {
    throw new RunNotificationSchemaError('its curation snapshot is invalid')
  }
  const curation: RunNotification['stages']['curation'] = curationSucceeded
    ? {
        status: 'done',
        // Counts only when a bundle was actually committed. Zeros on a stage that never got
        // there would claim it curated nothing, which is a different sentence.
        ...(isCount(committed.curated) ? { curated: committed.curated } : {}),
        ...(isCount(committed.deprecated) ? { deprecated: committed.deprecated } : {}),
        ...(snapshot?.success ? { curationSnapshot: snapshot.data } : {}),
      }
    : { status: 'failed' }

  return {
    schemaVersion: CURRENT_RUN_NOTIFICATION_SCHEMA_VERSION,
    runId: input.runId,
    outcome: analysisFailed || !curationSucceeded ? 'failed' : 'done',
    verdictSummary: readVerdictSummary(payload),
    stages: {
      analysis: { status: analysisFailed ? 'failed' : 'done' },
      curation,
    },
  }
}
