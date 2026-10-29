/**
 * Run-outcome projection: per-test outcome counters and exercised-anchor sets.
 *
 * Third application of the handoff-to-projection fold idiom (after curation emit and canary
 * emit): a pure projection over one CompletedRunHandoff, a SQLite writer against the one
 * derived-index connection, and a full rebuild that reproduces identical tables from
 * `.agent-qa/runs/<runId>/handoff.json` scans alone (L12 — derived state is disposable).
 *
 * The projection knows ABOUT tests (identity, counters, anchors, flags) and never CONTAINS
 * them: no test file content enters the store, and tests are never memidex-indexed.
 */
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

/**
 * Stamped into the curation-tail receipt's projection component. Bump when the fold
 * semantics or table shapes change so already-receipted runs refold on the next tail.
 *
 * HOW THAT REFOLD ACTUALLY HAPPENS, because the receipt alone cannot do it. The tail
 * stores this number in each run's receipt, so a bump invalidates every receipt and the sweep
 * re-runs each historical run — but the per-run fold then answers 'already-applied' off the
 * durable marker and writes nothing. The stamp is therefore ALSO stored in the index itself, in
 * `run_outcome_projection_version`, and `reconcileRunOutcomesProjection` compares the two ONCE per
 * curation-tail sweep, before the per-run loop: a differing or absent stamp rebuilds the whole
 * projection family from the runs root through `rebuildRunOutcomes`, which clears the family
 * (marker included) and re-reads every `handoff.json` + `analysis.json` from disk. THAT is how an
 * already-receipted run contributes its elements. The per-run receipts then rewrite at the new
 * version through the same sweep. The family is derived, so the rebuild is the whole upgrade, and
 * it is a mechanism that runs, not an argument that it is unnecessary.
 *
 * NOT the case argued at `cli/src/commands/run.ts:1949`, where a bump was
 * deliberately declined: there the rebuild would have replayed stored handoffs carrying the OLD
 * identities, landing in the same mixed state the bump was meant to clear. Here the new table has
 * no historical rows at all, and every row it will hold is derivable from evidence the stored
 * handoffs already carry — so the refold produces the complete answer rather than a mixed one.
 */
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

/**
 * Projection inputs contain no exclusion override. The durable handoff marker is the sole
 * authority for current-run folds, sibling backfill, and full rebuild alike (D-14 §6).
 */
export interface ProjectRunOutcomesOptions {
  extractAnchors: ExtractStepAnchors
  /**
   * The run's persisted analysis artifact when one exists (390 D-09, the `ProjectCanaryOutcomes
   * Input.artifact` precedent). DATA, not a port: `foldRunOutcomes` and `rebuildRunOutcomes` each
   * load it from the run's own dir through the one shared loader and hand it here, so ONE
   * projection function with ONE signature serves both paths — a second signature only one path
   * calls is exactly how L12 rebuild parity breaks in silence.
   */
  artifact?: RunAnalysisArtifact
}

/**
 * What a FAILED member contributes to the fingerprint-keyed recurrence window.
 *
 * The fingerprint is composed through the ONE exported vocabulary — `failingStepOf`/`errorTextOf`
 * over `exercisedAnchors`, keyed by `failureFingerprint` — so this window and the render-time
 * cluster presentation cannot disagree about what "the same failure" is. The verdict class is part
 * of the key by recipe, which is why it travels beside it rather than being re-derived downstream.
 */
export interface RunOutcomeFailureKey {
  fingerprint: string
  verdictClass: VerdictClass
  /**
   * WHICH pipeline authored the class. Not part of the fingerprint and not stored on
   * `run_fingerprint_windows` — it travels on the in-memory delta only, because the quarantine
   * ladder's floor-eligibility gate needs to know whether the class is a statement about THIS
   * TEST (an authored `analyze-run` verdict) or about the RUN (the deterministic floor, whose
   * `environment` arms are one health-probe result applied to every failing member).
   */
  producer: Verdict['producer']
}

export interface RunOutcomeTestDelta {
  filePath: string
  testName: string
  passed: boolean
  heals: number
  flake: boolean
  /** canonicalJson(normalizeAnchor(...)) keys — byte-deterministic (ABRF-02 encoding edge). */
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
  /**
   * The suite-fingerprint deltas for the SAME members. They travel on this projection
   * rather than being folded by a second pass so that one traversal of the handoff produces both
   * tables, one transaction commits them, and one applied-runs marker covers them — which is what
   * makes rebuild parity structural instead of asserted.
   */
  fingerprints: SuiteFingerprintTestDelta[]
}

export type ApplyRunOutcomesResult =
  | { kind: 'applied'; tests: number }
  | { kind: 'already-applied'; tests: 0 }

export interface RebuildRunOutcomesOptions {
  extractAnchors: ExtractStepAnchors
}

/**
 * What one rebuild did, with its two skip causes kept APART (393 round 7, CR-01-WIDENED).
 *
 * A single conflating counter answered "how many runs did not fold" and nothing an operator could
 * act on: a malformed `handoff.json` and an unloadable `analysis.json` are different files, written
 * by different producers, and fixed differently. There is deliberately no third counter for a
 * projection or write failure — that class is no longer a skip at all. It propagates out of
 * `rebuildRunOutcomes` and the rebuild produces no report.
 */
export interface RebuildRunOutcomesReport {
  folded: number
  /** Runs whose `handoff.json` would not load or carries a pre-381 / structurally unsafe shape. */
  skippedHandoffs: number
  /** Runs whose `handoff.json` loaded but whose `analysis.json` threw (the D-09 second document). */
  skippedArtifacts: number
}

/**
 * What the fold needs before it may evaluate the quarantine detection ladder.
 *
 * Grouped and OPTIONAL on purpose: a caller that cannot supply a clock does
 * not get a silently empty evaluation, it gets `{kind: 'not-evaluated', reason: 'not-requested'}`
 * on the report. "Detection ran and found nothing" and "detection never ran" are different facts.
 */
export interface QuarantineDetectionOptions {
  /**
   * The ISO-8601 instant the evaluation is anchored to — the drain's own wall clock, read ONCE by
   * the caller. The fold and the rule below it stay clock-free (390-01's purity-by-argument), which
   * is what lets both expiry and the ladder be pinned one step either side.
   */
  now: string
}

export interface FoldRunOutcomesOptions {
  /** Absolute agent-qa-knowledge root hosting the derived index SQLite. */
  knowledgeRoot: string
  handoff: CompletedRunHandoff
  extractAnchors: ExtractStepAnchors
  /**
   * The run's own directory (`.agent-qa/runs/<slug(runId)>/`). When supplied, the fold loads
   * `analysis.json` from it so the counters read RESOLVED verdicts. Absent — a caller that
   * has no run dir — folds the deterministic floor, byte-identically to pre-390.
   */
  runDir?: string
  /** Present when the caller wants the D-08 detection step; absent skips it explicitly. */
  quarantine?: QuarantineDetectionOptions
}

/**
 * What the fold's detection step did, as DATA (390 Pitfall 4).
 *
 * Every arm is a fact the caller can print. A ledger that could not be read is a value, not an
 * exception: a failure that vanished inside a catch is exactly how an `entered` event goes missing
 * in silence, and a missing `entered` event is a test that keeps failing builds with nobody told
 * why it was supposed to stop.
 */
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

/**
 * The RESOLVED VERDICT per member test, computed ONCE per fold (390 D-09, mirroring the canary
 * fold's `resolveAttributionClasses` member-for-member — same class of fold, same input treatment).
 *
 * It answers the whole `Verdict`, not just `.class`. Both layers below already HOLD one —
 * layer 1 reads `member.rootCause`, which IS a Verdict, and layer 2 reads `resolveRunVerdicts`,
 * which returns them — so keeping only the class was discarding `producer` one step short of the
 * quarantine decision that needs it.
 *
 * Two layers, in overwrite order:
 *
 *  1. Members OUTSIDE the accessor's domain first — a clean pass keeps its persisted class, which
 *     is how the runner's one pass-mintable `flake` (classifyRootCause's retry rule) still counts.
 *  2. THE one supersedable-verdict read, `resolveRunVerdicts`: artifact verdicts when the
 *     artifact is present, the deterministic floor when it is absent. It OVERWRITES layer 1
 *     wherever it governs, which is exactly how an unknown→flake upgrade moves the flake counter
 *     instead of the projection contradicting the resolved verdict.
 *
 * ACCEPTED SHAPE (the 389-06 precedent): a run whose artifact is written AFTER its fold does not
 * refold at the projection version it was folded at. The `run_outcome_applied_runs` marker is
 * final WITHIN a version, so an upgraded class reaches the counters and the fingerprint windows
 * only through LATER runs. ACROSS a version it is not final at all:
 * `reconcileRunOutcomesProjection` clears the marker through `rebuildRunOutcomes`, which re-reads
 * every artifact from disk — which is where a late upgrade eventually lands, and which is why the
 * version-4 note at the head of this file and this paragraph describe one mechanism rather than
 * contradicting each other.
 */
function resolveProjectionClasses(
  handoff: CompletedRunHandoff,
  artifact: RunAnalysisArtifact | undefined,
): ReadonlyMap<number, Verdict> {
  const members = handoff.tests ?? []
  const verdicts = new Map<number, Verdict>()
  for (const member of members) {
    if (member.rootCause !== undefined) verdicts.set(member.testIndex, member.rootCause)
  }
  // The accessor traverses `tests` on the floor path; the rebuild's WR-03 wall admits a handoff
  // whose `tests` key is absent, so it is normalized to the same empty array used above.
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

/**
 * The window key for one failed member.
 *
 * Every input rule is IMPORTED, never respelled here: which step the failure is about
 * (`failingStepOf`), which recorded bytes describe it (`errorTextOf`), which anchors it touched
 * (`exercisedAnchors`), and how those compose into the frozen key (`failureFingerprint`). The
 * anchor walk is schema's own — deliberately NOT the injected `extractAnchors` seam, which exists
 * so callers can vary the projection's anchor ROWS; keying the window through a variable seam would
 * let the window and the cluster presentation drift apart on a test host.
 *
 * A failed member always has a resolved verdict (`resolveRunVerdicts` mints `unknown` for a failure
 * carrying no verdict), so the fallbacks below are total-function guards, not expected paths. The
 * `producer` fallback matches `mintedUnknown`'s own value for the same reason the class fallback
 * matches its class: an absent verdict is exactly the floor's answer, never an authored one.
 */
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
  // THE ONE EXCLUSION GATE, and every projection below is computed from its output (393 D-15 /
  // WTST-06). A flagged gate-run reaches no counter, no anchor row, no fingerprint element,
  // because after this line there are no members to reach them with. A second gate — one per
  // table — would be the shape in which the two could eventually disagree about the same run,
  // which is exactly Pitfall 8: a gate-run seeding the union it is later compared against.
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
  // window rows commit in the SAME transaction as the counters and behind the SAME
  // applied-runs marker, so a refold can neither double-count a recurrence nor leave counters and
  // windows describing different histories. OR IGNORE makes the uniqueness constraint the second
  // line of defence rather than an error path.
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
    // the suite-fingerprint rows commit in the SAME transaction and behind the SAME
    // applied-runs marker as the counters, on the 390 D-07 precedent one paragraph up. The write
    // is convergent on its own (newest `(buildOrdinal, runId)` wins), so the marker is what makes
    // the two tables describe one history rather than what makes this idempotent.
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

/**
 * One run's persisted analysis artifact, loaded from that run's OWN dir. THE shared
 * loader: the incremental fold and the full rebuild both call it, which is what keeps L12 parity
 * true rather than asserted.
 *
 * The fs glue is local; every rule that matters belongs to schema. An absent file is `undefined` —
 * the deterministic floor. A newer schemaVersion is the guard's typed hard failure, never swallowed
 * into a silent floor. A PRESENT file recording ANOTHER run's id is refused by identity
 * (`admitAnalysisArtifactForRun`, G-389-3A) and folds to the floor: counters and windows never key
 * off another run's verdicts, the 388 cross-instance class.
 *
 * THE LOADER ALWAYS RETHROWS, and what that costs is the CALLER's call (393 round 6, CR-01). On the
 * incremental `foldRunOutcomes` path the throw stands: one run's fold fails loudly rather than
 * silently recording a resolved run at its unresolved floor. In `rebuildRunOutcomes` the per-run
 * body catches the BAD-BYTES class and counts a skip, because there those throws would abandon a
 * family from one malformed run — while an errno-coded HOST fault rethrows from that same
 * call site (393 round 8, CR-01-READ). Two postures, one loader — do not "fix" this by softening
 * the loader.
 */
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

    // WR-03 / L12 fail-closed boundary: EVERY structural access on this untrusted
    // persisted document stays inside this try. A malformed file is a counted skip,
    // never an exception that aborts the disposable derived-state rebuild.
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

/**
 * Full rebuild: scan and read every run dir under `runsRoot`, then clear the projection tables
 * and refold each loadable handoff. Reproduces tables byte-identical to the incremental fold
 * (L12); a rebuild over zero handoff dirs yields empty tables without error (ABRF-02
 * empty edge). BAD-BYTES load failures and pre-381 shapes are counted skips — including a run whose
 * `analysis.json` will not decode, which costs that run's contribution and nothing else (393 round
 * 6, CR-01). One undecodable artifact must never truncate a family this function has already
 * read; an errno-coded HOST fault on either document, on the runs root, or on any run dir
 * propagates BEFORE the family is deleted, so no sweep can stamp — or empty — a family the
 * filesystem prevented it from reading (418-12, CR-01-EXISTS).
 *
 * Phase A: no document is destroyed before every document was read — a host fault during reads
 * leaves the previous family and its stamp untouched (418-12, CR-02-DESTRUCTIVE, load-before-delete).
 * The list holds parsed handoffs for one sweep; the runs root is bounded by host run retention.
 *
 * Phase B is DELETE-FIRST, STAMP-LAST, and that order is the crash story rather than a style choice (393
 * CR-02). The version row is cleared with the family it describes and re-written only after the
 * refold loop has run to completion, so a crash anywhere in between leaves NO stamp — which
 * `reconcileRunOutcomesProjection` reads as a mismatch and rebuilds again. The projection
 * therefore self-heals from a partial rebuild instead of stamping a half-built family as current.
 */
export function rebuildRunOutcomes(
  db: DatabaseSync,
  runsRoot: string,
  opts: RebuildRunOutcomesOptions,
): RebuildRunOutcomesReport {
  const loaded: { handoff: CompletedRunHandoff; artifact?: RunAnalysisArtifact }[] = []
  const report: RebuildRunOutcomesReport = { folded: 0, skippedHandoffs: 0, skippedArtifacts: 0 }
  // A missing runs root is the ABRF-02 empty edge, not a failure: the family is legitimately
  // empty at the CURRENT semantics, so it still earns the stamp below — otherwise a project with
  // no runs yet would rebuild on every single sweep forever.
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
      // D-09 / L12: share the incremental artifact loader but keep the established per-run
      // BAD-BYTES skip. Only the loader sits in this catch: host faults propagate, and
      // projection/write failures in phase B must never be mistaken for malformed bytes.
      // An unreadable artifact skips the whole run rather than inventing floor counters.
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

/**
 * THE version trigger: reconcile the stored fold semantics with the shipped ones.
 *
 * `RUN_OUTCOMES_PROJECTION_VERSION`'s doc block has always promised that a bump makes
 * already-receipted runs refold. Nothing performed that refold: `applyRunOutcomes` short-circuits
 * on the `run_outcome_applied_runs` marker before it can reach the fingerprint write, and nothing
 * cleared the marker on a version change — so on any project that folded runs before a bump, the
 * new table stayed empty forever and gate 3's fingerprint lane never had data to decide on. This
 * function is what makes that promise true, and it composes machinery that already existed rather
 * than adding a parallel path: `rebuildRunOutcomes` already clears the family, already re-reads
 * every `handoff.json` + `analysis.json` through the one shared loader, and already reaches
 * `applySuiteFingerprints` for every fold.
 *
 * ABSENT MEANS MISMATCH, deliberately. Every pre-stamp index reads as absent, which is exactly the
 * population that needs to converge; so does an index whose file was deleted, which is exactly the
 * population that needs to re-heal. Treating absence as "probably fine" would have made the
 * upgrade path the one path this function does not serve.
 *
 * WHY A REBUILD RATHER THAN A PER-RUN VERSION COLUMN. Refolding runs in place through the
 * incremental path would add each run's counters a SECOND time — the fold accumulates, it does not
 * replace. The rebuild is the mechanism precisely because it clears before it refolds, which is
 * also why the derived family is safe to move this way at all (L12: every row here is reproducible
 * from run artifacts on disk).
 *
 * a destructive rebuild of a shared derived family is a leased act. A caller
 * without authority gets a typed skip before opening a writer; it stays stale until a leased
 * sweep. The version check and entire rebuild share the current-authority generation lock.
 */
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

/**
 * The D-08 detection step: evaluate the quarantine ladder over the JUST-COMMITTED window and
 * append whatever lifecycle events it authors.
 *
 * ORDERING, stated rather than pretended (Open Q1). The projection lives in SQLite and the ledger
 * is a committed JSONL file; there is no transaction that spans both, so this cannot be atomic and
 * the code does not claim to be. The append orders AFTER the projection commit, which means a
 * crash between the two leaves the counters applied and no event written.
 * That state SELF-HEALS: the window is still crossed, so the next applied fold re-evaluates and
 * appends then. The opposite order (append first) would have the strictly worse failure: a
 * quarantine entry for a run whose counters never landed.
 *
 * The reads below run on the same connection immediately after `applyRunOutcomes` returned
 * `'applied'`, so the recurrence they see includes this run.
 *
 * TWO PER-TEST OUTCOME READS THAT LOOK REDUNDANT AND ARE NOT. `testWindows` is built for
 * ENTRIES — tests the ledger already carries — and answers the EXIT question. The flake signature
 * is needed for CROSSINGS, and a crossing is by definition NOT in the ledger yet, so it has no
 * window here: the exit path reads windows for entries, the entry path needs a window for a test
 * that has none. That asymmetry is the whole reason the signature is computed in this function and
 * nowhere else — the failure loop is the only place holding both the crossing's identity and the db
 * handle at once.
 *
 * THE READ COST, stated honestly: one indexed point lookup per CROSSING failure, on a connection
 * already open, after the projection has committed. Crossings are rare by construction — this loop
 * is reached only for members that failed — so this is not a per-test cost on the common path.
 */
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
      // THE PER-CROSSING FLAKE SIGNATURE, read from this test's OWN outcome window.
      // `hasSameBuildPassAndFail` is called rather than re-derived: the exit path's
      // `distinctOrdinalOutcomes` and this entry-side read share one `groupByBuildOrdinal`, so
      // "what a build ordinal is" has exactly one spelling and the two directions cannot drift.
      // A test with no history row answers false through the `?? []` — typed absence, never a
      // throw and never a fabricated window. (Defensive in-tree: the reads below run after
      // `applyRunOutcomes` returned `applied`, so a crossing test always has a row by now.)
      //
      // AND IT IS SCOPED TO THIS CROSSING'S OWN RECURRENCE WINDOW. The per-test
      // outcome window keeps LAST_OUTCOMES_LIMIT entries, which is DEEPER than the detection
      // window, so an unscoped read let a since-fixed flake episode license a new hard regression
      // several ordinals later — the gate silencing exactly what the disposition table exists to
      // keep failing the build. The floor here is `fingerprintRecurrence`'s floor, from the same
      // export: the evidence and the count are bounded by ONE window, so evidence expires with the
      // window that licensed nothing (D-07 windows-forgive; D-05 anti-silencing).
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

  // Exit candidates are every entry in this product that is still LISTED — `quarantined` or
  // `expired` — and not only the tests that ran here: a test whose window filled with passes
  // several runs ago must still be released. A LAPSED entry is included because a test fixed while
  // its window was lapsed is still listed and can otherwise only be closed by hand.
  //
  // TWO SITES, ONE RULE. `evaluateQuarantineDetection`'s release loop (quarantine/detection.ts)
  // applies the same state test to the entries themselves. This filter decides whether a window is
  // BUILT at all, so narrowing it alone silently disables the release for a whole state class while
  // the pure rule's own tests stay green over windows the fold never hands it.
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

/**
 * Incremental fold wrapper for the post-verdict tail: opens the one index writer, applies
 * the projection, and closes. The tail invokes it inside the SAME crash boundary and the
 * SAME (extended) receipt as candidate/canary emit — never a second marker file.
 *
 * Detection hangs off the `'applied'` arm ONLY. `applyRunOutcomes` answers
 * `'already-applied'` from an early return that fires before its transaction even opens, so
 * "a refold never double-quarantines" is true by POSITION — there is no second idempotency
 * condition here to keep in sync with the marker.
 */
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
