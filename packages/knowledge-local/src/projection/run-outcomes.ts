// A rebuild from stored handoffs reproduces these tables; no test file content is stored.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import {
  ANALYSIS_FILE,
  admitAnalysisArtifactForRun,
  canonicalJson,
  errorTextOf,
  exercisedAnchors,
  failingStepOf,
  failureFingerprint,
  guardCompletedRunHandoff,
  guardRunAnalysisArtifact,
  normalizeAnchor,
  resolveRunVerdicts,
  slugBranch,
} from '@vostride/agent-qa-schema'
import type {
  Anchor,
  CompletedRunHandoff,
  PerTestOutcome,
  RunAnalysisArtifact,
  ScopeKey,
  StepEvidence,
  Verdict,
  VerdictClass,
} from '@vostride/agent-qa-schema'

import { QuarantineLedgerVersionError } from '@vostride/agent-qa-schema'
import type { QuarantineLedgerEvent } from '@vostride/agent-qa-schema'

import { ensureRunOutcomeTables, openIndexWriter } from '../index-open.js'
import { withCurrentWriterAuthority } from '../lease/writer-lease.js'
import { evaluateQuarantineDetection, hasSameBuildPassAndFail } from '../quarantine/detection.js'
import type {
  QuarantineDetectionFailure,
  QuarantineDetectionSighting,
  QuarantineDetectionTestWindow,
} from '../quarantine/detection.js'
import {
  appendQuarantineEvents,
  foldQuarantineLedgerState,
  readQuarantineLedger,
} from '../quarantine/ledger.js'
import type {
  QuarantineAppendOutcome,
  RefusedQuarantineLine,
} from '../quarantine/ledger.js'
import { fingerprintRecurrence, windowFloor } from './fingerprint-window-read.js'
import { isAbsenceErrno, pathPresent } from './path-present.js'
import { LAST_OUTCOMES_LIMIT } from './run-outcome-constants.js'
import { readTestOutcomeHistory } from './run-outcome-read.js'
import { applySuiteFingerprints, suiteFingerprintDeltas } from './suite-fingerprints.js'
import type { SuiteFingerprintTestDelta } from './suite-fingerprints.js'

// Bump on fold or table change; a mismatch with the index's stamp rebuilds the whole family.
export const RUN_OUTCOMES_PROJECTION_VERSION = 2

export { LAST_OUTCOMES_LIMIT } from './run-outcome-constants.js'

/**
 * Mirrors runner-local's HANDOFF_FILE. knowledge-local sits below runner-local in the
 * package layering, so the constant cannot be imported without inverting the dependency
 * direction; the rebuild receives the runs root and joins this fixed leaf name.
 */
const RUN_HANDOFF_FILE = 'handoff.json'

/** Anchor extraction seam: the CLI tail passes its exercisedAnchors(step) walk. */
export type ExtractStepAnchors = (step: StepEvidence) => Anchor[]

// No exclusion override: the durable handoff marker decides for every fold path.
export interface ProjectRunOutcomesOptions {
  extractAnchors: ExtractStepAnchors
  // Data loaded by both fold paths, so one projection signature keeps rebuild parity.
  artifact?: RunAnalysisArtifact
}

// Built from the shared fingerprint vocabulary, so the window and cluster view agree.
export interface RunOutcomeFailureKey {
  fingerprint: string
  verdictClass: VerdictClass
  // Kept off the stored window: only the floor-eligibility gate needs it, on the in-memory delta.
  producer: Verdict['producer']
}

export interface RunOutcomeTestDelta {
  filePath: string
  testName: string
  passed: boolean
  heals: number
  flake: boolean
  // `canonicalJson(normalizeAnchor(...))` keys, byte-deterministic.
  anchorKeys: string[]
  /** Present for exactly the failed members — a pass contributes no window row. */
  failure?: RunOutcomeFailureKey
}

export interface RunOutcomesProjection {
  product: string
  scope: ScopeKey
  runId: string
  buildOrdinal: number
  excluded: boolean
  tests: RunOutcomeTestDelta[]
  // Carried here so one traversal, one transaction and one marker cover both tables.
  fingerprints: SuiteFingerprintTestDelta[]
}

export type ApplyRunOutcomesResult =
  | { kind: 'applied'; tests: number }
  | { kind: 'already-applied'; tests: 0 }

export interface RebuildRunOutcomesOptions {
  extractAnchors: ExtractStepAnchors
}

// Two skip causes kept apart; a projection or write failure propagates and yields no report.
export interface RebuildRunOutcomesReport {
  folded: number
  /** Runs whose `handoff.json` would not load or has an old or structurally unsafe shape. */
  skippedHandoffs: number
  // Runs whose `handoff.json` loaded but whose `analysis.json` threw.
  skippedArtifacts: number
}

// Optional, so a caller with no clock gets `not-evaluated` instead of an empty evaluation.
export interface QuarantineDetectionOptions {
  // Read once by the caller; the fold and the rule stay clock-free.
  now: string
}

export interface FoldRunOutcomesOptions {
  /** Absolute agent-qa-knowledge root hosting the derived index SQLite. */
  knowledgeRoot: string
  handoff: CompletedRunHandoff
  extractAnchors: ExtractStepAnchors
  // When supplied, the fold reads resolved verdicts from `analysis.json`; absent folds the floor.
  runDir?: string
  // Present to run detection; absent skips it explicitly.
  quarantine?: QuarantineDetectionOptions
}

// Detection's outcome as data: an unreadable ledger is a value, not an exception lost in a catch.
export type QuarantineFoldOutcome =
  | { kind: 'not-evaluated'; reason: 'already-applied' | 'not-requested' }
  /** The committed ledger could not be read at all — detection refuses rather than guessing. */
  | { kind: 'ledger-unreadable'; reason: string }
  | {
      kind: 'evaluated'
      append: QuarantineAppendOutcome
      events: readonly QuarantineLedgerEvent[]
      flagged: readonly QuarantineDetectionSighting[]
      escalatedNotQuarantined: readonly QuarantineDetectionSighting[]
      refusedLines: readonly RefusedQuarantineLine[]
    }

export type FoldRunOutcomesReport = ApplyRunOutcomesResult & {
  quarantine: QuarantineFoldOutcome
}

interface OutcomeEntry {
  buildOrdinal: number
  passed: boolean
}

/**
 * Derive the projection partition from the same scope-key law as committed records.
 * Product bytes are path-safe to match serving's productSlug bind; the raw scope pair
 * stays alongside them for the shared scope-ladder predicate.
 */
export function projectionPartition(scope: ScopeKey): {
  product: string
  scopeTier: ScopeKey['tier']
  scopeKey: string
} {
  return {
    product: slugBranch(scope.key),
    scopeTier: scope.tier,
    scopeKey: scope.key,
  }
}

function countedOutcome(outcome: PerTestOutcome['outcome']): boolean | undefined {
  switch (outcome) {
    case 'passed':
    case 'healed':
      return true
    case 'failed':
    case 'timeout':
      return false
    default:
      // 'skipped' and 'cancelled' members never ran to a verdict — no counter entry.
      return undefined
  }
}

// A late artifact reaches counters only through later runs or a version rebuild.
function resolveProjectionClasses(
  handoff: CompletedRunHandoff,
  artifact: RunAnalysisArtifact | undefined,
): ReadonlyMap<number, Verdict> {
  const members = handoff.tests ?? []
  const verdicts = new Map<number, Verdict>()
  for (const member of members) {
    if (member.rootCause !== undefined) verdicts.set(member.testIndex, member.rootCause)
  }
  // A rebuilt handoff may lack `tests`, so it is normalized to the same empty array.
  for (const verdict of resolveRunVerdicts(artifact, { ...handoff, tests: members })) {
    verdicts.set(verdict.perTest, verdict)
  }
  return verdicts
}

function testDelta(
  test: PerTestOutcome,
  extractAnchors: ExtractStepAnchors,
  resolvedVerdicts: ReadonlyMap<number, Verdict>,
): RunOutcomeTestDelta | undefined {
  const passed = countedOutcome(test.outcome)
  if (passed === undefined) return undefined

  const steps = test.steps ?? []
  const anchorKeys = new Set<string>()
  for (const step of steps) {
    for (const anchor of extractAnchors(step)) {
      anchorKeys.add(canonicalJson(normalizeAnchor(anchor)))
    }
  }

  const resolved = resolvedVerdicts.get(test.testIndex)
  return {
    filePath: test.filePath,
    testName: test.testName,
    passed,
    heals: steps.filter((step) => step.selfHeal !== undefined).length,
    flake: resolved?.class === 'flake',
    anchorKeys: [...anchorKeys].sort(),
    ...(passed ? {} : { failure: failureKey({ ...test, steps }, resolved) }),
  }
}

// Keyed through schema's anchor walk, not the injected seam, so window and cluster view agree.
function failureKey(
  test: PerTestOutcome,
  resolved: Verdict | undefined,
): RunOutcomeFailureKey {
  const step = failingStepOf(test)
  const anchors = step === undefined ? [] : exercisedAnchors(step)
  const verdictClass = resolved?.class ?? 'unknown'
  return {
    fingerprint: failureFingerprint(
      { anchors, errorText: errorTextOf(step, test) },
      verdictClass,
    ),
    verdictClass,
    producer: resolved?.producer ?? 'deterministic-classifier',
  }
}

/** Pure fold: identical (handoff, artifact) bytes yield identical row deltas. */
export function projectRunOutcomes(
  handoff: CompletedRunHandoff,
  opts: ProjectRunOutcomesOptions,
): RunOutcomesProjection {
  const partition = projectionPartition(handoff.scope)
  const excluded = handoff.excludedFromOutcomes === true
  const resolvedClasses = resolveProjectionClasses(handoff, opts.artifact)
  // The one exclusion gate; every table below derives from its output, so none can disagree.
  const members = excluded ? [] : (handoff.tests ?? [])
  const tests = members.flatMap((test) => {
    const delta = testDelta(test, opts.extractAnchors, resolvedClasses)
    return delta === undefined ? [] : [delta]
  })
  return {
    product: partition.product,
    scope: { tier: partition.scopeTier, key: partition.scopeKey },
    runId: String(handoff.runId),
    buildOrdinal: handoff.buildOrdinal,
    excluded,
    tests,
    fingerprints: suiteFingerprintDeltas(members),
  }
}

function mergeOutcomeEntries(
  existingJson: string | undefined,
  entry: OutcomeEntry,
): string {
  let entries: OutcomeEntry[] = []
  if (existingJson !== undefined) {
    try {
      const parsed: unknown = JSON.parse(existingJson)
      if (Array.isArray(parsed)) entries = parsed as OutcomeEntry[]
    } catch {
      // A malformed history heals through the rebuild; start the window fresh.
    }
  }
  entries.push(entry)
  // Ordinal-sorted (tiebreak on passed) so incremental fold order and rebuild scan order
  // produce byte-identical windows — the L12 parity requirement.
  entries.sort((a, b) =>
    a.buildOrdinal - b.buildOrdinal || Number(a.passed) - Number(b.passed),
  )
  return canonicalJson(entries.slice(-LAST_OUTCOMES_LIMIT))
}

function runAlreadyApplied(db: DatabaseSync, product: string, runId: string): boolean {
  return db
    .prepare(`
      SELECT 1 AS present
      FROM run_outcome_applied_runs
      WHERE product = ? AND run_id = ?
    `)
    .get(product, runId) !== undefined
}

/**
 * Writer against the one index connection. Idempotent per product/runId: the applied-runs
 * marker commits in the same transaction as the counter rows, so a crash-rerun tail that
 * refolds an already-applied partition (receipt withheld mid-tail) changes nothing.
 */
export function applyRunOutcomes(
  db: DatabaseSync,
  projection: RunOutcomesProjection,
): ApplyRunOutcomesResult {
  ensureRunOutcomeTables(db)
  if (runAlreadyApplied(db, projection.product, projection.runId)) {
    return { kind: 'already-applied', tests: 0 }
  }

  const selectRow = db.prepare(`
    SELECT passes, failures, heals, flake_count, last_outcomes_json, last_build_ordinal
    FROM run_test_outcomes
    WHERE product = ? AND file_path = ? AND test_name = ?
  `)
  const upsertRow = db.prepare(`
    INSERT INTO run_test_outcomes (
      product, scope_tier, scope_key, file_path, test_name, passes, failures, heals,
      flake_count, last_outcomes_json, last_build_ordinal
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (product, file_path, test_name) DO UPDATE SET
      scope_tier = excluded.scope_tier,
      scope_key = excluded.scope_key,
      passes = excluded.passes,
      failures = excluded.failures,
      heals = excluded.heals,
      flake_count = excluded.flake_count,
      last_outcomes_json = excluded.last_outcomes_json,
      last_build_ordinal = excluded.last_build_ordinal
  `)
  const insertAnchor = db.prepare(`
    INSERT OR IGNORE INTO run_test_anchors (
      product, scope_tier, scope_key, file_path, test_name, anchor_normalized_json
    ) VALUES (?, ?, ?, ?, ?, ?)
  `)
  // Same transaction and marker as the counters, so a refold cannot double-count a recurrence.
  const insertWindow = db.prepare(`
    INSERT OR IGNORE INTO run_fingerprint_windows (
      product, file_path, test_name, fingerprint, verdict_class, build_ordinal, run_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `)

  db.exec('BEGIN IMMEDIATE')
  try {
    for (const test of projection.tests) {
      const existing = selectRow.get(projection.product, test.filePath, test.testName) as
        | {
            passes: number
            failures: number
            heals: number
            flake_count: number
            last_outcomes_json: string
            last_build_ordinal: number | null
          }
        | undefined
      const passes = (existing?.passes ?? 0) + (test.passed ? 1 : 0)
      const failures = (existing?.failures ?? 0) + (test.passed ? 0 : 1)
      const heals = (existing?.heals ?? 0) + test.heals
      const flakeCount = (existing?.flake_count ?? 0) + (test.flake ? 1 : 0)
      const lastBuildOrdinal = Math.max(
        existing?.last_build_ordinal ?? projection.buildOrdinal,
        projection.buildOrdinal,
      )
      upsertRow.run(
        projection.product,
        projection.scope.tier,
        projection.scope.key,
        test.filePath,
        test.testName,
        passes,
        failures,
        heals,
        flakeCount,
        mergeOutcomeEntries(existing?.last_outcomes_json, {
          buildOrdinal: projection.buildOrdinal,
          passed: test.passed,
        }),
        lastBuildOrdinal,
      )
      for (const anchorKey of test.anchorKeys) {
        insertAnchor.run(
          projection.product,
          projection.scope.tier,
          projection.scope.key,
          test.filePath,
          test.testName,
          anchorKey,
        )
      }
      if (test.failure !== undefined) {
        insertWindow.run(
          projection.product,
          test.filePath,
          test.testName,
          test.failure.fingerprint,
          test.failure.verdictClass,
          projection.buildOrdinal,
          projection.runId,
        )
      }
    }
    // Same transaction and marker as the counters, so both tables describe one history.
    applySuiteFingerprints(db, {
      product: projection.product,
      runId: projection.runId,
      buildOrdinal: projection.buildOrdinal,
      tests: projection.fingerprints,
    })
    db.prepare('INSERT INTO run_outcome_applied_runs (product, run_id) VALUES (?, ?)')
      .run(projection.product, projection.runId)
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // Preserve the apply error that caused the rollback.
    }
    throw error
  }
  return { kind: 'applied', tests: projection.tests.length }
}

/**
 * An errno-coded fs failure — the FILESYSTEM refusing, not the file's contents being wrong. Every
 * `fs` throw carries a string `code`; `JSON.parse` throws a `SyntaxError` and the schema guard
 * throws a `VersionGuardError`, and neither carries one. Absence errnos never reach this predicate: both
 * loaders convert them to `undefined` (legitimate absence) before anything else can rethrow.
 */
function isErrnoHostFault(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && typeof (error as NodeJS.ErrnoException).code === 'string'
}

// Always rethrows; the rebuild counts bad bytes as a skip, while the incremental fold fails loudly.
function loadRunArtifact(runDir: string, runId: string): RunAnalysisArtifact | undefined {
  let bytes: string
  try {
    bytes = readFileSync(join(runDir, ANALYSIS_FILE), 'utf8')
  } catch (error) {
    if (isAbsenceErrno(error)) return undefined
    throw error
  }
  const admission = admitAnalysisArtifactForRun(
    guardRunAnalysisArtifact(JSON.parse(bytes)),
    runId,
  )
  return admission.kind === 'admitted' ? admission.artifact : undefined
}

function loadRebuildHandoff(file: string): CompletedRunHandoff | undefined {
  let bytes: string
  try {
    bytes = readFileSync(file, 'utf8')
  } catch (error) {
    if (isAbsenceErrno(error)) return undefined
    throw error
  }

  try {
    const guarded = guardCompletedRunHandoff(JSON.parse(bytes))

    // Every structural access on this untrusted document stays inside the try, so bad bytes skip.
    const tests = (guarded as { tests?: unknown }).tests
    if (tests !== undefined && !Array.isArray(tests)) return undefined

    // The guard-level shape hook and this consumer wall are independent: reject unsafe
    // members and steps here before projection traversal can observe them.
    const structurallyCurrent = (tests ?? []).every((test) => {
      if (test === null || typeof test !== 'object' || Array.isArray(test)) return false

      const member = test as {
        filePath?: unknown
        testName?: unknown
        steps?: unknown
      }
      return (
        typeof member.filePath === 'string'
        && member.filePath.length > 0
        && typeof member.testName === 'string'
        && member.testName.length > 0
        && (member.steps === undefined
          || (Array.isArray(member.steps)
            && member.steps.every(
              (step) => step !== null && typeof step === 'object' && !Array.isArray(step),
            )))
      )
    })
    return structurallyCurrent ? guarded : undefined
  } catch {
    return undefined
  }
}

/** The stored fold-semantics stamp, or `undefined` on an index that has never carried one. */
function readStoredProjectionVersion(db: DatabaseSync): number | undefined {
  const row = db
    .prepare('SELECT version FROM run_outcome_projection_version WHERE id = 1')
    .get() as { version: number } | undefined
  return row?.version
}

// Reads everything before deleting, then deletes first and stamps last, so a crash leaves no stamp.
export function rebuildRunOutcomes(
  db: DatabaseSync,
  runsRoot: string,
  opts: RebuildRunOutcomesOptions,
): RebuildRunOutcomesReport {
  const loaded: { handoff: CompletedRunHandoff; artifact?: RunAnalysisArtifact }[] = []
  const report: RebuildRunOutcomesReport = { folded: 0, skippedHandoffs: 0, skippedArtifacts: 0 }
  // A missing runs root is an empty family and still earns the stamp, or every sweep would rebuild.
  if (pathPresent(runsRoot, 'directory') === 'present') {
    const runDirs = readdirSync(runsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(runsRoot, entry.name))
      .filter((dir) => pathPresent(join(dir, RUN_HANDOFF_FILE), 'file') === 'present')
      .sort()

    for (const runDir of runDirs) {
      const handoff = loadRebuildHandoff(join(runDir, RUN_HANDOFF_FILE))
      if (handoff === undefined) {
        report.skippedHandoffs += 1
        continue
      }
      // Only the loader sits in this catch; host faults and later write failures still propagate.
      let artifact: RunAnalysisArtifact | undefined
      try {
        artifact = loadRunArtifact(runDir, String(handoff.runId))
      } catch (error) {
        if (isErrnoHostFault(error)) throw error
        report.skippedArtifacts += 1
        continue
      }
      loaded.push({ handoff, ...(artifact === undefined ? {} : { artifact }) })
    }
  }

  ensureRunOutcomeTables(db)
  db.exec(`
    DELETE FROM run_test_outcomes;
    DELETE FROM run_test_anchors;
    DELETE FROM run_outcome_applied_runs;
    DELETE FROM run_fingerprint_windows;
    DELETE FROM suite_fingerprints;
    DELETE FROM run_outcome_projection_version;
  `)

  for (const { handoff, artifact } of loaded) {
    // Each apply owns its transaction; a write failure leaves no stamp and retries next sweep.
    applyRunOutcomes(db, projectRunOutcomes(handoff, {
      extractAnchors: opts.extractAnchors,
      ...(artifact === undefined ? {} : { artifact }),
    }))
    report.folded += 1
  }

  db.prepare('INSERT OR REPLACE INTO run_outcome_projection_version (id, version) VALUES (1, ?)')
    .run(RUN_OUTCOMES_PROJECTION_VERSION)
  return report
}

/** What one reconcile did — a fact the caller can print, never a silent side effect. */
export type ReconcileRunOutcomesProjectionResult =
  | { kind: 'current' }
  | { kind: 'rebuilt'; report: RebuildRunOutcomesReport }
  | { kind: 'skipped'; reason: 'no-writer-authority' }

export interface ReconcileRunOutcomesProjectionOptions {
  /** The exact live writer lease owned by the caller; never inferred from an epoch alone. */
  authority?: { leaseId: string; epoch: number }
  /** Absolute agent-qa-knowledge root hosting the derived index SQLite. */
  knowledgeRoot: string
  /** `<agentQaRoot>/runs` — the scan root the rebuild refolds from. */
  runsRoot: string
  extractAnchors: ExtractStepAnchors
}

// An absent stamp is a mismatch; it rebuilds, because refolding in place would double the counters.
export function reconcileRunOutcomesProjection(
  opts: ReconcileRunOutcomesProjectionOptions,
): ReconcileRunOutcomesProjectionResult {
  if (opts.authority === undefined) return { kind: 'skipped', reason: 'no-writer-authority' }
  return withCurrentWriterAuthority(opts.knowledgeRoot, opts.authority, () => {
    const handle = openIndexWriter(opts.knowledgeRoot)
    try {
      ensureRunOutcomeTables(handle.db)
      if (readStoredProjectionVersion(handle.db) === RUN_OUTCOMES_PROJECTION_VERSION) {
        return { kind: 'current' }
      }
      return {
        kind: 'rebuilt',
        report: rebuildRunOutcomes(handle.db, opts.runsRoot, {
          extractAnchors: opts.extractAnchors,
        }),
      }
    } finally {
      handle.close()
    }
  })
}

// Appends after the projection commits; a crash between them self-heals on the next fold.
function evaluateQuarantineForFold(
  db: DatabaseSync,
  projection: RunOutcomesProjection,
  knowledgeRoot: string,
  opts: QuarantineDetectionOptions,
): QuarantineFoldOutcome {
  let read
  try {
    read = readQuarantineLedger(knowledgeRoot)
  } catch (error) {
    // Refuse, never heal. A ledger this build cannot parse is committed truth it must not guess
    // at — evaluating against "no entries" would re-quarantine released tests and re-enter open
    // ones. The counters already applied; only detection stands down, and it says so.
    if (error instanceof QuarantineLedgerVersionError) {
      return { kind: 'ledger-unreadable', reason: error.message }
    }
    throw error
  }
  const entries = foldQuarantineLedgerState(read.events, opts.now)

  const failures: QuarantineDetectionFailure[] = projection.tests.flatMap((test) =>
    test.failure === undefined ? [] : [{
      product: projection.product,
      filePath: test.filePath,
      testName: test.testName,
      fingerprint: test.failure.fingerprint,
      verdictClass: test.failure.verdictClass,
      producer: test.failure.producer,
      // Scoped to this crossing's recurrence window, so old flake evidence licenses nothing.
      sameBuildPassAndFail: hasSameBuildPassAndFail(
        (readTestOutcomeHistory(db, {
          product: projection.product,
          filePath: test.filePath,
          testName: test.testName,
        })?.lastOutcomes ?? []).filter(
          (outcome) => outcome.buildOrdinal >= windowFloor(projection.buildOrdinal)
            && outcome.buildOrdinal <= projection.buildOrdinal,
        ),
      ),
      ...fingerprintRecurrence(
        db,
        { product: projection.product, fingerprint: test.failure.fingerprint },
        projection.buildOrdinal,
      ),
    }])

  // Every listed entry, lapsed included, gets a window; the detection release loop must match this.
  const testWindows: QuarantineDetectionTestWindow[] = entries.flatMap((entry) => {
    if (entry.state === 'released' || entry.product !== projection.product) return []
    const history = readTestOutcomeHistory(db, {
      product: entry.product,
      filePath: entry.filePath,
      testName: entry.testName,
    })
    if (history === undefined) return []
    return [{
      product: entry.product,
      filePath: entry.filePath,
      testName: entry.testName,
      ordinals: history.lastOutcomes,
    }]
  })

  const detection = evaluateQuarantineDetection({
    failures,
    testWindows,
    entries,
    now: opts.now,
  })

  const append = appendQuarantineEvents(knowledgeRoot, detection.events)

  return {
    kind: 'evaluated',
    append,
    events: detection.events,
    flagged: detection.flagged,
    escalatedNotQuarantined: detection.escalatedNotQuarantined,
    refusedLines: read.refusedLines,
  }
}

// Detection hangs off the `applied` arm only, so a refold never double-quarantines.
export function foldRunOutcomes(opts: FoldRunOutcomesOptions): FoldRunOutcomesReport {
  const artifact = opts.runDir === undefined
    ? undefined
    : loadRunArtifact(opts.runDir, String(opts.handoff.runId))
  const projection = projectRunOutcomes(opts.handoff, {
    extractAnchors: opts.extractAnchors,
    ...(artifact === undefined ? {} : { artifact }),
  })
  const handle = openIndexWriter(opts.knowledgeRoot)
  try {
    const applied = applyRunOutcomes(handle.db, projection)
    if (applied.kind !== 'applied') {
      return { ...applied, quarantine: { kind: 'not-evaluated', reason: 'already-applied' } }
    }
    if (opts.quarantine === undefined) {
      return { ...applied, quarantine: { kind: 'not-evaluated', reason: 'not-requested' } }
    }
    return {
      ...applied,
      quarantine: evaluateQuarantineForFold(
        handle.db,
        projection,
        opts.knowledgeRoot,
        opts.quarantine,
      ),
    }
  } finally {
    handle.close()
  }
}
