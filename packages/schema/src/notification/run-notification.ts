// The chain-terminal notification DTO (Phase 388, D-09 / D-11 / D-12).
//
// One record per run, written inside the transaction that lands the LAST job the post-run
// chain enqueued. It is the thing 392's chat and M5's dashboard read, which is why it is
// minted here rather than beside either of them: a payload shape that lived with one
// consumer would be re-derived by the second, and the two spellings would drift on the first
// field either of them wanted.
//
// What it deliberately does NOT carry (D-11; 385 D-01): no record content, no rationale
// prose, no artifact bytes, no `agentqa://` refs. Counts, verdict classes and identifiers
// only. The curation stage carries fixed curation event identities, which may contain
// unconstrained strings. Public reads mask that snapshot through the same strict projection
// as the early checkpoint snapshot; durable bytes remain the exact committed facts.
//
// `outcome` is a fact about the CHAIN, not about the run: a failed run whose analysis and
// curation both succeeded notifies `done`. The run's own verdict is the exit code, frozen
// long before anything here exists (JOBQ-06), and conflating the two would make this record
// a second, later, quieter answer to a question already answered.

import type { Verdict } from '../verdict/verdict'
import { CurationSnapshotSchema } from './curation-snapshot'
import type { CurationSnapshot } from './curation-snapshot'

/**
 * Stamped into every record and checked on every read.
 *
 * A literal type rather than `number` (the `CurationTailReceipt` idiom): a record built with
 * last version's shape then fails to typecheck at its construction site, which is where the
 * mistake is, instead of at the reader that could only report it as corrupt bytes.
 */
export const CURRENT_RUN_NOTIFICATION_SCHEMA_VERSION = 2

/** Whether the chain as a whole finished clean. Every stage done ⇒ `done` (D-12). */
export type RunNotificationOutcome = 'done' | 'failed'

/** Declaration-order projection of `RunNotificationOutcome`. */
export const RUN_NOTIFICATION_OUTCOMES = [
  'done',
  'failed',
] as const satisfies readonly RunNotificationOutcome[]

/** What became of one stage the chain actually ran. */
export type RunNotificationStageStatus = 'done' | 'failed'

/**
 * Declaration-order projection of `RunNotificationStageStatus`. A status is a claim about a stage
 * that ran, so there is no word for a stage that did not.
 */
export const RUN_NOTIFICATION_STAGE_STATUSES = [
  'done',
  'failed',
] as const satisfies readonly RunNotificationStageStatus[]

/**
 * Per-class counts over the verdicts the analysis stage authored.
 *
 * `byClass` is PARTIAL on purpose: a run with no environment failures omits the key rather
 * than carrying a zero. A dense record would make "this class did not occur" and "this build
 * does not know that class yet" the same bytes, and the second is the one a later verdict
 * class introduces.
 */
export interface RunNotificationVerdictSummary {
  total: number
  byClass: Partial<Record<Verdict['class'], number>>
}

/**
 * The two stages the chain runs, analysis then curation.
 *
 * A stage record carries its STATUS and, for curation, the counts it committed. It carries NO
 * failure text: this row is stamped by whichever process drains the chain, INCLUDING the daemon's
 * pump, which can fold with no declared mask bound (the `no-masker` posture). A reason stored here
 * therefore could not be guaranteed masked at the moment it was written, and this row is read by
 * surfaces that render it directly — so a secret that reached the column would reach a screen. The
 * masked, bounded reason (`CHIP_ERROR_MAX_LENGTH`) lives instead on the in-process `*Failed` chip
 * envelope, which is itself durable (it is appended to the run's `events.jsonl`) and reaches the
 * page through the read route's `runs.events` fold. A `failed` chip with no such envelope renders
 * `failed` plus a posture-qualified "reason not recorded" line — never blank. The job store's own
 * per-job failure-reason column is a pump-internal field and is not surfaced by this contract for
 * the same masking reason.
 */
export interface RunNotificationStages {
  analysis: { status: RunNotificationStageStatus }
  /**
   * Counts are present only when the curation stage actually committed a bundle. A failed
   * curation reports its status and no counts at all — zeros would say it curated nothing,
   * which is a different claim from never having got that far.
   */
  curation: {
    status: RunNotificationStageStatus
    curated?: number
    deprecated?: number
    /** Exact bundle-committed facts. Missing on historical or uncommitted curation. */
    curationSnapshot?: CurationSnapshot
  }
}

export interface RunNotification {
  schemaVersion: typeof CURRENT_RUN_NOTIFICATION_SCHEMA_VERSION
  runId: string
  outcome: RunNotificationOutcome
  verdictSummary: RunNotificationVerdictSummary
  stages: RunNotificationStages
}

// 2026-10-17 (444-10, D-36): agent-jobs.db keeps the stored words; every read serves this view.
export type RunNotificationViewStatus = 'complete' | 'failed'

export const RUN_NOTIFICATION_VIEW_STATUSES = [
  'complete',
  'failed',
] as const satisfies readonly RunNotificationViewStatus[]

export interface RunNotificationViewStages {
  analysis: { status: RunNotificationViewStatus }
  curation: {
    status: RunNotificationViewStatus
    curated?: number
    deprecated?: number
    curationSnapshot?: CurationSnapshot
  }
}

export interface RunNotificationView {
  schemaVersion: typeof CURRENT_RUN_NOTIFICATION_SCHEMA_VERSION
  runId: string
  outcome: RunNotificationViewStatus
  verdictSummary: RunNotificationVerdictSummary
  stages: RunNotificationViewStages
}

const VIEW_WORD: Record<RunNotificationStageStatus, RunNotificationViewStatus> = {
  done: 'complete',
  failed: 'failed',
}

export function toRunNotificationView(notification: RunNotification): RunNotificationView {
  const { analysis, curation } = notification.stages
  return {
    ...notification,
    outcome: VIEW_WORD[notification.outcome],
    stages: {
      analysis: { ...analysis, status: VIEW_WORD[analysis.status] },
      curation: { ...curation, status: VIEW_WORD[curation.status] },
    },
  }
}

/** The admissible stage key set, sorted and joined; the guard refuses any other. */
export const RUN_NOTIFICATION_STAGE_KEY_SETS = ['analysis,curation'] as const

/** The exact top-level field set, sorted and joined. The record carries these five and no more. */
export const RUN_NOTIFICATION_FIELD_KEYS = 'outcome,runId,schemaVersion,stages,verdictSummary'

/** Refusal for bytes that do not describe a notification this build can read. */
export class RunNotificationSchemaError extends Error {
  override readonly name = 'RunNotificationSchemaError'

  constructor(readonly detail: string) {
    super(
      `a stored run notification cannot be read: ${detail}. The row is written inside the ` +
        'chain-terminal transaction from a typed record, so bytes that fail this guard were ' +
        'written by another build rather than by a caller that got a field wrong.',
    )
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/**
 * Membership against a declared closed list (2026-09-12, 422-22).
 *
 * The guard asks the CONSTANT rather than re-spelling its members in an `||` chain, so a word this
 * build reads and a word it admits cannot drift apart. An inline pair was fine while the words
 * were spelled once; they are now spelled beside their type, and two spellings is one too many.
 */
function isMember<T extends string>(members: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (members as readonly string[]).includes(value)
}

/**
 * The migration seam, keyed by source version with one version step per entry, so a later bump
 * has a home instead of an `if` in the guard. It is empty, so every stamp but the current one is
 * refused.
 */
export const RUN_NOTIFICATION_MIGRATIONS: Record<number, (doc: unknown) => unknown> = {}

/**
 * The full-shape guard, checked by EXACT key set rather than by presence, behind a forward walk
 * over the migration seam above.
 *
 * Presence checks admit a record carrying an extra field, and an extra field on a row several
 * surfaces render is exactly how a payload grows a member nobody declared. The sorted-key
 * comparison is the `CurationTailReceipt` idiom for the same reason.
 *
 * The walk runs FIRST and only forwards, and the record is then checked against the CURRENT shape
 * in full, so a step that produced something malformed is refused here rather than travelling. A
 * record whose stamp is not the current one after the walk is refused by name — this build cannot
 * know what another contract means, and guessing is how a reader renders a field it does not
 * understand.
 */
export function guardRunNotification(value: unknown): RunNotification {
  if (!isRecord(value)) {
    throw new RunNotificationSchemaError('it is not an object')
  }

  const declared = value.schemaVersion
  let migrated: Record<string, unknown> = value
  if (
    typeof declared === 'number' &&
    Number.isInteger(declared) &&
    declared < CURRENT_RUN_NOTIFICATION_SCHEMA_VERSION
  ) {
    for (let from = declared; from < CURRENT_RUN_NOTIFICATION_SCHEMA_VERSION; from += 1) {
      const step = RUN_NOTIFICATION_MIGRATIONS[from]
      if (step === undefined) break
      const next = step(migrated)
      if (!isRecord(next)) {
        throw new RunNotificationSchemaError(
          `migrating it from schemaVersion ${String(from)} produced no record`,
        )
      }
      migrated = next
    }
  }

  if (Object.keys(migrated).sort().join(',') !== RUN_NOTIFICATION_FIELD_KEYS) {
    throw new RunNotificationSchemaError(
      `its field set is ${JSON.stringify(Object.keys(migrated).sort())}`,
    )
  }
  if (migrated.schemaVersion !== CURRENT_RUN_NOTIFICATION_SCHEMA_VERSION) {
    throw new RunNotificationSchemaError(
      `it declares schemaVersion ${String(migrated.schemaVersion)}, and this build reads ` +
        String(CURRENT_RUN_NOTIFICATION_SCHEMA_VERSION),
    )
  }
  if (typeof migrated.runId !== 'string' || migrated.runId === '') {
    throw new RunNotificationSchemaError('it names no run')
  }
  if (!isMember(RUN_NOTIFICATION_OUTCOMES, migrated.outcome)) {
    throw new RunNotificationSchemaError(`${String(migrated.outcome)} is not a chain outcome`)
  }

  const summary = migrated.verdictSummary
  if (!isRecord(summary) || !isCount(summary.total) || !isRecord(summary.byClass)) {
    throw new RunNotificationSchemaError('its verdict summary is not a summary')
  }
  for (const [className, count] of Object.entries(summary.byClass)) {
    if (!isCount(count)) {
      throw new RunNotificationSchemaError(`its ${className} count is not a count`)
    }
  }

  const stages = migrated.stages
  if (!isRecord(stages)) {
    throw new RunNotificationSchemaError('it reports no stages')
  }
  const stageKeys = Object.keys(stages).sort().join(',')
  if (!(RUN_NOTIFICATION_STAGE_KEY_SETS as readonly string[]).includes(stageKeys)) {
    throw new RunNotificationSchemaError(
      `its stage set is ${JSON.stringify(Object.keys(stages).sort())}`,
    )
  }
  const analysis = stages.analysis
  if (!isRecord(analysis) || !isMember(RUN_NOTIFICATION_STAGE_STATUSES, analysis.status)) {
    throw new RunNotificationSchemaError('its analysis stage reports no outcome')
  }
  const curation = stages.curation
  if (!isRecord(curation) || !isMember(RUN_NOTIFICATION_STAGE_STATUSES, curation.status)) {
    throw new RunNotificationSchemaError('its curation stage reports no outcome')
  }
  if ('curated' in curation && !isCount(curation.curated)) {
    throw new RunNotificationSchemaError('its curated count is not a count')
  }
  if ('deprecated' in curation && !isCount(curation.deprecated)) {
    throw new RunNotificationSchemaError('its deprecated count is not a count')
  }
  if ('curationSnapshot' in curation &&
    !CurationSnapshotSchema.safeParse(curation.curationSnapshot).success) {
    // Never include untrusted snapshot keys or identity values in diagnostics.
    throw new RunNotificationSchemaError('its curation snapshot is invalid')
  }

  return migrated as unknown as RunNotification
}
