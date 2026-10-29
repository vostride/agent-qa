// Read-only; rows key on `(product, fingerprint)`, and the window slides over ordinals, not runs.
import type { DatabaseSync } from 'node:sqlite'

import type { VerdictClass } from '@vostride/agent-qa-schema'

import { LAST_OUTCOMES_LIMIT } from './run-outcome-constants.js'

// The same fingerprint recurring within this many build ordinals; auto-exit is symmetric with it.
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

// Both the recurrence count and the flake-signature read use this, so their scopes cannot drift.
export function windowFloor(currentBuildOrdinal: number): number {
  return currentBuildOrdinal - QUARANTINE_WINDOW_ORDINALS + 1
}

// Reads as deep as the per-test outcome window, not the detection window; unknown answers `[]`.
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

// Computed live, never stored; both legs count distinct ordinals.
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
