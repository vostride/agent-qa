/**
 * Read side of the run-outcome projection (389 ANLZ-03, RESEARCH Pitfall 2).
 *
 * `run_test_outcomes` is written by `foldRunOutcomes`/`applyRunOutcomes`; this module is
 * the one place that queries it. Strictly read-only: one prepared SELECT, no statement
 * that mutates a row, ever — the writer half stays whole in `run-outcomes.ts`.
 *
 * KEY LAW — stable test identity is `(product, filePath, testName)`, exactly the
 * projection's primary key and per-test-outcome.ts's identity rule. Callers joining from
 * a handoff use `PerTestOutcome.filePath` + `testName`, NEVER `testId` (a per-run
 * explicit id, not a durable identity).
 */
import type { DatabaseSync } from 'node:sqlite'

import { LAST_OUTCOMES_LIMIT } from './run-outcome-constants.js'

/** One window entry: ordinals only, wall-clock never (mirrors the writer's OutcomeEntry). */
export interface TestOutcomeEntry {
  buildOrdinal: number
  passed: boolean
}

export interface TestOutcomeHistory {
  passes: number
  failures: number
  heals: number
  flakeCount: number
  /** Ordinal-ascending, at most LAST_OUTCOMES_LIMIT entries; [] when the stored JSON is malformed. */
  lastOutcomes: TestOutcomeEntry[]
  lastBuildOrdinal: number | undefined
}

/** The projection's key, spelled the way the table is keyed. */
export interface TestOutcomeIdentity {
  product: string
  filePath: string
  testName: string
}

function isOutcomeEntry(value: unknown): value is TestOutcomeEntry {
  return (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as { buildOrdinal?: unknown }).buildOrdinal === 'number'
    && typeof (value as { passed?: unknown }).passed === 'boolean'
  )
}

/**
 * Heal-to-empty parse of `last_outcomes_json` — the same tolerance posture as the
 * writer's `mergeOutcomeEntries`: a malformed history is an empty window, never a throw.
 * The ascending sort and window cap are re-derived defensively so the read-side
 * invariants hold even over bytes an older writer left behind.
 */
function parseLastOutcomes(json: string): TestOutcomeEntry[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed
    .filter(isOutcomeEntry)
    .map((entry) => ({ buildOrdinal: entry.buildOrdinal, passed: entry.passed }))
    .sort((a, b) => a.buildOrdinal - b.buildOrdinal || Number(a.passed) - Number(b.passed))
    .slice(-LAST_OUTCOMES_LIMIT)
}

/**
 * Answer one test's failure history from `run_test_outcomes`, or `undefined` when the
 * projection has never counted the test — typed absence, never an empty stand-in row.
 */
export function readTestOutcomeHistory(
  db: DatabaseSync,
  identity: TestOutcomeIdentity,
): TestOutcomeHistory | undefined {
  const row = db
    .prepare(`
      SELECT passes, failures, heals, flake_count, last_outcomes_json, last_build_ordinal
      FROM run_test_outcomes
      WHERE product = ? AND file_path = ? AND test_name = ?
    `)
    .get(identity.product, identity.filePath, identity.testName) as
    | {
        passes: number
        failures: number
        heals: number
        flake_count: number
        last_outcomes_json: string
        last_build_ordinal: number | null
      }
    | undefined
  if (row === undefined) return undefined
  return {
    passes: row.passes,
    failures: row.failures,
    heals: row.heals,
    flakeCount: row.flake_count,
    lastOutcomes: parseLastOutcomes(row.last_outcomes_json),
    lastBuildOrdinal: row.last_build_ordinal ?? undefined,
  }
}

/**
 * Every identity the projection has counted inside ONE file, in one product.
 *
 * The neighbours side of D-14's stability read: "which tests does this suite file already have run
 * evidence for". Keyed on the projection's own primary key, so `product` is REQUIRED for the same
 * reason `readTestOutcomeHistory` requires it — a query that dropped it would serve every
 * product's rows under one file path and report another application's tests as this target's.
 *
 * `test_name` ORDER, so a caller's message names its neighbours in a stable order across runs. An
 * empty array is the honest answer for a file the projection has never counted; the caller turns
 * that into a `no-history` posture rather than into a clean bill of health.
 */
export function listTestsInFile(
  db: DatabaseSync,
  scope: { product: string; filePath: string },
): string[] {
  return db
    .prepare(`
      SELECT test_name
      FROM run_test_outcomes
      WHERE product = ? AND file_path = ?
      ORDER BY test_name
    `)
    .all(scope.product, scope.filePath)
    .map((row) => String((row as { test_name: unknown }).test_name))
}

/**
 * D-02's forced discriminator channel: did the same step pass on the previous build?
 * Answers the entry with the greatest buildOrdinal STRICTLY below `currentBuildOrdinal`,
 * or `undefined` when no prior build is in the window (empty history, a single
 * current-build entry, or every entry at/above current) — prior-build honestly absent,
 * never faked from the current entry.
 */
export function priorBuildOutcome(
  history: TestOutcomeHistory,
  currentBuildOrdinal: number,
): TestOutcomeEntry | undefined {
  let prior: TestOutcomeEntry | undefined
  for (const entry of history.lastOutcomes) {
    if (entry.buildOrdinal >= currentBuildOrdinal) continue
    if (prior === undefined || entry.buildOrdinal >= prior.buildOrdinal) prior = entry
  }
  return prior
}

export interface FailureRecurrence {
  /** Failed entries with buildOrdinal AT OR BELOW current — includes the current failure when recorded. */
  kth: number
  /** Distinct buildOrdinals observed in lastOutcomes — honest about the ≤LAST_OUTCOMES_LIMIT window. */
  windowBuilds: number
}

/**
 * Feeds "Kth failure in the last N builds", computed LIVE at render time — counts
 * derived from the window on every call, never stored prose. 390 rebinds the same seam to
 * its fingerprint-window computation; this derivation is 389's binding, not the seam's
 * final owner. An empty history answers {kth: 0, windowBuilds: 0}: the renderer (plan 05)
 * turns zero-history into an explicit no-history clause, so absence stays typed.
 */
export function failureRecurrence(
  history: TestOutcomeHistory,
  currentBuildOrdinal: number,
): FailureRecurrence {
  const kth = history.lastOutcomes.filter(
    (entry) => !entry.passed && entry.buildOrdinal <= currentBuildOrdinal,
  ).length
  const windowBuilds = new Set(
    history.lastOutcomes.map((entry) => entry.buildOrdinal),
  ).size
  return { kth, windowBuilds }
}
