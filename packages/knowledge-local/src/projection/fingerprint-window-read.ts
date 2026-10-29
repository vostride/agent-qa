/**
 * Read side of the fingerprint-keyed recurrence window.
 *
 * `run_fingerprint_windows` is written by `applyRunOutcomes`; this module is the one place that
 * queries it. Strictly read-only: prepared SELECTs, no statement that mutates a row, ever — the
 * writer half stays whole in `run-outcomes.ts`, exactly as `run-outcome-read.ts` does for the
 * per-test counters it is the sibling of.
 *
 * KEY LAW — a window row is addressed by `(product, fingerprint)`. Stable test identity
 * `(product, filePath, testName)` travels ON the row because a crossing has to name the test it
 * quarantines, but it is never part of the recurrence key: one fingerprint may be exercised by
 * several tests, and D-07's rule is about the FAILURE recurring, not the test.
 *
 * THE WINDOW SLIDES OVER ORDINALS, NOT RUNS. Recurrence is counted over the ordinal range
 * `[current - QUARANTINE_WINDOW_ORDINALS + 1, current]`:
 *
 *  - two failing runs inside ONE build ordinal count once (the numerator counts DISTINCT ordinals),
 *  - a failure at ordinals 5/7/9 still crosses at 9 even though no two runs were consecutive,
 *  - and an occurrence that has slid out of the range is FORGIVEN. That is the whole point of a
 *    window: the lifetime `flake_count` never forgives, which is exactly why D-07 demoted it to a
 *    ranking input and made this the trigger substrate instead.
 *
 * `windowOrdinals` is the honest denominator: how many distinct ordinals in the range this product
 * recorded a failure in at all. A caller renders "3rd occurrence in 5 builds" from the pair, and an
 * empty window answers typed zeros rather than an absence a renderer has to guess about.
 *
 * PRECONDITION — the caller supplies a connection where `ensureRunOutcomeTables` has run (every
 * `openIndexWriter` does). A read-only connection against a store predating these tables raises
 * sqlite's `no such table`, which the composition layer folds to typed absence the same way it
 * already does for `readTestOutcomeHistory`.
 */
import type { DatabaseSync } from 'node:sqlite'

import type { VerdictClass } from '@vostride/agent-qa-schema'

import { LAST_OUTCOMES_LIMIT } from './run-outcome-constants.js'

/**
 * §7.3's locked detection window, verbatim: the same fingerprint recurring within the last five
 * build ordinals. A pinned constant with no config key — retune it from operational
 * evidence, in the source, where the change is reviewable. Plan 05's rule reads the threshold
 * against this window; D-10's auto-exit is symmetric with it by design.
 */
export const QUARANTINE_WINDOW_ORDINALS = 5

/** The recurrence key: the failure, inside one product partition. */
export interface FingerprintWindowIdentity {
  product: string
  fingerprint: string
}

/** One window row, as the writer stored it. */
export interface FingerprintWindowRow {
  product: string
  filePath: string
  testName: string
  fingerprint: string
  verdictClass: VerdictClass
  buildOrdinal: number
  runId: string
}

export interface FingerprintRecurrence {
  /** DISTINCT build ordinals inside the window carrying this fingerprint. */
  occurrenceOrdinals: number
  /** DISTINCT build ordinals inside the window carrying ANY failure for this product. */
  windowOrdinals: number
}

/**
 * Inclusive lower bound of the ordinal window ending at `currentBuildOrdinal`.
 *
 * ONE SPELLING, TWO CONSUMERS. `fingerprintRecurrence` below bounds its SQL range with
 * it, and `run-outcomes.ts` bounds the per-crossing flake-signature read with it — the scope of
 * the evidence and the scope of the count are the same window BY CONSTRUCTION, not by two sites
 * agreeing. Exported for that second consumer; re-deriving
 * `buildOrdinal - QUARANTINE_WINDOW_ORDINALS + 1` anywhere else re-opens the drift.
 */
export function windowFloor(currentBuildOrdinal: number): number {
  return currentBuildOrdinal - QUARANTINE_WINDOW_ORDINALS + 1
}

/**
 * Every stored row for one fingerprint inside the bounded read scope, ordinal-ascending.
 *
 * The read scope is the last {@link LAST_OUTCOMES_LIMIT} ordinals rather than the detection window,
 * so a caller that wants to SHOW the recent history (D-10's M-consecutive-passes exit, the list
 * verb) sees the same depth the per-test outcome window carries. An identity the projection never
 * recorded answers `[]` — typed absence, never a stand-in row.
 */
export function readFingerprintWindow(
  db: DatabaseSync,
  identity: FingerprintWindowIdentity,
  currentBuildOrdinal: number,
): FingerprintWindowRow[] {
  const rows = db.prepare(`
    SELECT product, file_path, test_name, fingerprint, verdict_class, build_ordinal, run_id
    FROM run_fingerprint_windows
    WHERE product = ?
      AND fingerprint = ?
      AND build_ordinal <= ?
      AND build_ordinal > ?
    ORDER BY build_ordinal, run_id, file_path, test_name
  `).all(
    identity.product,
    identity.fingerprint,
    currentBuildOrdinal,
    currentBuildOrdinal - LAST_OUTCOMES_LIMIT,
  ) as unknown as {
    product: string
    file_path: string
    test_name: string
    fingerprint: string
    verdict_class: string
    build_ordinal: number
    run_id: string
  }[]

  return rows.map((row) => ({
    product: String(row.product),
    filePath: String(row.file_path),
    testName: String(row.test_name),
    fingerprint: String(row.fingerprint),
    verdictClass: String(row.verdict_class) as VerdictClass,
    buildOrdinal: Number(row.build_ordinal),
    runId: String(row.run_id),
  }))
}

/**
 * One fingerprint's recurrence over the sliding ordinal window — computed LIVE on every
 * call, never stored. Both legs count DISTINCT ordinals, which is what makes two failing runs in
 * one build one occurrence.
 */
export function fingerprintRecurrence(
  db: DatabaseSync,
  identity: FingerprintWindowIdentity,
  currentBuildOrdinal: number,
): FingerprintRecurrence {
  const floor = windowFloor(currentBuildOrdinal)
  const occurrences = db.prepare(`
    SELECT COUNT(DISTINCT build_ordinal) AS ordinals
    FROM run_fingerprint_windows
    WHERE product = ?
      AND fingerprint = ?
      AND build_ordinal >= ?
      AND build_ordinal <= ?
  `).get(identity.product, identity.fingerprint, floor, currentBuildOrdinal) as
    | { ordinals: number }
    | undefined
  const observed = db.prepare(`
    SELECT COUNT(DISTINCT build_ordinal) AS ordinals
    FROM run_fingerprint_windows
    WHERE product = ?
      AND build_ordinal >= ?
      AND build_ordinal <= ?
  `).get(identity.product, floor, currentBuildOrdinal) as { ordinals: number } | undefined

  return {
    occurrenceOrdinals: Number(occurrences?.ordinals ?? 0),
    windowOrdinals: Number(observed?.ordinals ?? 0),
  }
}
