// The projection-version reconcile differential (393 CR-02).
//
// THE PRE-v4 STATE IS PRODUCED, NOT WRITTEN. Every historical run below is folded through the
// REAL `foldRunOutcomes` path against a REAL index on disk, exactly as the shipping tail folds
// it. Only two DELETEs are synthetic — the `suite_fingerprints` rows and the version row — and
// those stand in for the producer that no longer exists in this tree: a v3-era fold, which had
// no fingerprint write and no stamp, left precisely markers + counters + an empty fingerprint
// table + no version row. Hand-building the index instead would have risked pinning an
// unproducible shape, and a differential over impossible inputs cannot tell a vacuous corpus
// from a real closure (the produced-not-literal law).
//
// The two directions are pinned together on purpose (the two-sided contract pin law): a backfill
// that converges is only half the contract, and the other half — an already-current index that
// never re-folds — is where a re-fold-every-open regression and double-counted counters would
// live.
//
// 393 round 6 / CR-01 + WR-06: the run dirs now carry the SECOND document production writes beside
// the handoff. Until this round every fixture below wrote `handoff.json` alone, so the rebuild's
// `analysis.json` leg was unexercised in BOTH directions — which is precisely the hole through
// which a family-truncating unguarded read shipped green. The artifact bytes are planted RAW so a
// TRUNCATED file (the crash / full-disk shape) is expressible, not just an exotic schemaVersion.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import {
  CURRENT_HANDOFF_SCHEMA_VERSION,
  actionAnchorElement,
  ANALYSIS_FILE,
  canonicalJson,
  CURRENT_ANALYSIS_SCHEMA_VERSION,
  type Action,
  type CompletedRunHandoff,
  type ElementInfo,
  type PerTestOutcome,
  type RunAnalysisArtifact,
  type ScopeKey,
  type StepEvidence,
  type SubActionEvidence,
  type Verdict,
} from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it } from 'vitest'

import { openIndexWriter } from '../../index-open.js'
import {
  foldRunOutcomes,
  projectionPartition,
  reconcileRunOutcomesProjection as reconcileUnderAuthority,
  RUN_OUTCOMES_PROJECTION_VERSION,
} from '../run-outcomes.js'
import { createSuiteFingerprintIndex } from '../suite-fingerprints.js'

import { acquireWriterLease, releaseLease } from '../../lease/writer-lease.js'

// Every historical version cell now models the real host holding a live lease.
function reconcileRunOutcomesProjection(
  opts: Parameters<typeof reconcileUnderAuthority>[0],
): ReturnType<typeof reconcileUnderAuthority> {
  const acquired = acquireWriterLease(opts.knowledgeRoot)
  if (acquired.kind !== 'acquired') throw new Error('fixture did not acquire authority')
  try {
    return reconcileUnderAuthority({ ...opts, authority: acquired })
  } finally {
    releaseLease({ knowledgeRoot: opts.knowledgeRoot, leaseId: acquired.leaseId })
  }
}

const SHOP_SCOPE: ScopeKey = { tier: 'product', key: 'shop-web' }
const SHOP_PRODUCT = projectionPartition(SHOP_SCOPE).product

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

// Fixture builders mirror `suite-fingerprints.test.ts`: the fingerprint recipe reads SUCCEEDED
// sub-actions and the element the planned action's ref names, so a handoff that carries only
// step anchors would fold to an empty fingerprint table and the convergence assertion would pass
// vacuously against zero.
interface SubActionFixture {
  type: string
  ref?: string
  role?: string
  name?: string
  url?: string
}

interface TestFixture {
  filePath: string
  testName: string
  steps: SubActionFixture[][]
}

function elementInfo(ref: string, role: string, name: string): ElementInfo {
  return {
    ref,
    role,
    name,
    nameNormalized: name,
    state: { enabled: true, focused: false, visible: true },
    labels: {},
    attributes: {},
  } as unknown as ElementInfo
}

function screenState(url: string | undefined, elements: ElementInfo[]): unknown {
  return {
    platform: 'web',
    tree: '',
    elements,
    refMap: {},
    timestamp: 0,
    metadata: {},
    ...(url === undefined ? {} : { url }),
  }
}

function subActionEvidence(fixture: SubActionFixture): SubActionEvidence {
  const elements = fixture.ref === undefined
    ? []
    : [elementInfo(fixture.ref, fixture.role ?? 'button', fixture.name ?? 'checkout')]
  return {
    plan: `plan ${fixture.type}`,
    plannedAction: {
      type: fixture.type,
      ...(fixture.ref === undefined ? {} : { ref: fixture.ref }),
    } as unknown as Action,
    stateBefore: screenState(fixture.url, elements),
    result: { success: true },
  } as unknown as SubActionEvidence
}

function stepEvidence(stepIndex: number, subActions: SubActionFixture[]): StepEvidence {
  return {
    stepIndex,
    stepText: `step ${stepIndex}`,
    cacheStatus: 'miss',
    servedBrief: {
      scope: SHOP_SCOPE,
      asOfBuild: 1,
      budget: 1,
      truncation: 'none',
      channel1: [],
      channel2: [],
      channel3: [],
      briefDigest: 'fixture-brief-digest',
    },
    subActions: subActions.map(subActionEvidence),
    verifierVerdict: { pass: true, reasoning: 'fixture verdict' },
  } as unknown as StepEvidence
}

function perTest(fixture: TestFixture, testIndex: number): PerTestOutcome {
  return {
    testId: `${fixture.filePath}::${fixture.testName}`,
    testName: fixture.testName,
    filePath: fixture.filePath,
    testIndex,
    outcome: 'passed',
    steps: fixture.steps.map((subActions, index) => stepEvidence(index, subActions)),
  } as unknown as PerTestOutcome
}

function handoffFixture(input: {
  runId: string
  buildOrdinal: number
  tests: TestFixture[]
  excludedFromOutcomes?: true
}): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: input.runId,
    buildOrdinal: input.buildOrdinal,
    scope: SHOP_SCOPE,
    executionContext: 'ci',
    aggregateVerdict: 'passed',
    configDigests: {
      suiteConfigDigest: 'fixture-suite-config-digest',
      testConfigDigest: 'fixture-test-config-digest',
    },
    startedAt: input.buildOrdinal * 1_000,
    endedAt: input.buildOrdinal * 1_000 + 1,
    tests: input.tests.map((fixture, testIndex) => perTest(fixture, testIndex)),
    ...(input.excludedFromOutcomes === true ? { excludedFromOutcomes: true } : {}),
  } as unknown as CompletedRunHandoff
}

const extractAnchors = (): [] => []

const CHECKOUT_TEST: TestFixture = {
  filePath: 'suite/checkout.test.ts',
  testName: 'checkout happy path',
  steps: [[{ type: 'click', ref: 'e1', role: 'button', name: 'checkout', url: '/cart' }]],
}

const LOGIN_TEST: TestFixture = {
  filePath: 'suite/login.test.ts',
  testName: 'login with a valid password',
  steps: [[{ type: 'fill', ref: 'e9', role: 'textbox', name: 'password', url: '/login' }]],
}

/** The gate-run's own draft test — WTST-06's exclusion subject on the rebuild path. */
const GATE_TEST: TestFixture = {
  filePath: 'suite/internal-gate.test.ts',
  testName: 'gate run draft',
  steps: [[{ type: 'click', ref: 'e4', role: 'button', name: 'gate only', url: '/gate' }]],
}

const CHECKOUT_ELEMENT = actionAnchorElement({
  kind: 'action',
  type: 'click',
  anchor: { t: 'el', role: 'button', name: 'checkout', ordinal: 0 },
  route: '/cart',
})

const GATE_ELEMENT = actionAnchorElement({
  kind: 'action',
  type: 'click',
  anchor: { t: 'el', role: 'button', name: 'gate only', ordinal: 0 },
  route: '/gate',
})

const HISTORICAL_RUNS: CompletedRunHandoff[] = [
  handoffFixture({ runId: '001-checkout', buildOrdinal: 1, tests: [CHECKOUT_TEST] }),
  handoffFixture({ runId: '002-login', buildOrdinal: 2, tests: [LOGIN_TEST] }),
  handoffFixture({
    runId: '003-gate',
    buildOrdinal: 3,
    tests: [GATE_TEST],
    excludedFromOutcomes: true,
  }),
]

// ---------------------------------------------------------------------------
// The artifact leg (393 round 6 / WR-06). Mirrors run-outcomes-resolved.test.ts's fixtures: one
// FAILING member carrying no `rootCause`, whose deterministic floor is the minted `unknown` — not
// a flake. That is what makes the artifact's upgrade observable, and what stops the valid-artifact
// cell from passing vacuously on a projection the floor alone would have produced.
// ---------------------------------------------------------------------------

const FLAKE_RUN_ID = '004-payment'
const FLAKY_FILE = 'suite/payment.test.ts'
const FLAKY_TEST = 'checkout retries the payment sheet'

function unknownFailureHandoff(runId: string, buildOrdinal: number): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId,
    buildOrdinal,
    scope: SHOP_SCOPE,
    executionContext: 'ci',
    aggregateVerdict: 'failed',
    configDigests: {
      suiteConfigDigest: 'fixture-suite-config-digest',
      testConfigDigest: 'fixture-test-config-digest',
    },
    startedAt: buildOrdinal * 1_000,
    endedAt: buildOrdinal * 1_000 + 1,
    tests: [{
      testId: `${runId}-payment`,
      testName: FLAKY_TEST,
      filePath: FLAKY_FILE,
      testIndex: 0,
      outcome: 'failed',
      steps: [{
        ...stepEvidence(0, [{ type: 'click', ref: 'e7', role: 'button', name: 'pay now', url: '/pay' }]),
        verifierVerdict: { pass: false, reasoning: 'the payment sheet never opened' },
      } as unknown as StepEvidence],
    } as unknown as PerTestOutcome],
  } as unknown as CompletedRunHandoff
}

/** The 389 supersession: the author upgraded the floor's `unknown` to `flake`. */
function flakeArtifact(runId: string): RunAnalysisArtifact {
  const verdict: Verdict = {
    class: 'flake',
    producer: 'analyze-run',
    confidence: 0.82,
    evidence: {
      citedSteps: [0],
      citedAnchors: [],
      citedArtifacts: [],
      rationale: 'the same step passed on the immediate re-run',
    },
    memoryMisdirectionRuledOut: true,
    perTest: 0,
  }
  return {
    schemaVersion: CURRENT_ANALYSIS_SCHEMA_VERSION,
    runId,
    verdicts: [verdict],
    parts: [{
      perTest: 0,
      groundingQuote: { stepIndex: 0, quote: 'the payment sheet never opened' },
      discriminator: 'intermittent, no persistent cause',
      nextAction: 're-run to confirm stability',
      links: [],
    }],
  }
}

const FLAKE_RUN = unknownFailureHandoff(FLAKE_RUN_ID, 4)

/**
 * A truncated `analysis.json`: real bytes of a real artifact, cut mid-string. This is the shape a
 * crash or a full disk produces — `JSON.parse` throws straight out of the loader, whose `try`
 * wraps only `readFileSync`. Deliberately NOT a `schemaVersion: 9999` literal, because the point
 * is that the unguarded read is reachable from an ordinary durability failure.
 */
const TRUNCATED_ARTIFACT_BYTES = canonicalJson(flakeArtifact('002-login')).slice(0, 40)

function flakeCountOf(db: DatabaseSync): number {
  const row = db.prepare(
    'SELECT flake_count FROM run_test_outcomes WHERE file_path = ? AND test_name = ?',
  ).get(FLAKY_FILE, FLAKY_TEST) as { flake_count: number } | undefined
  return Number(row?.flake_count ?? -1)
}

interface ProjectionDump {
  outcomes: unknown[]
  anchors: unknown[]
  appliedRuns: unknown[]
  windows: unknown[]
  fingerprints: unknown[]
  version: unknown[]
}

function dumpProjection(db: DatabaseSync): ProjectionDump {
  return {
    outcomes: db.prepare(
      'SELECT * FROM run_test_outcomes ORDER BY product, file_path, test_name',
    ).all(),
    anchors: db.prepare(
      'SELECT * FROM run_test_anchors ORDER BY product, file_path, test_name, anchor_normalized_json',
    ).all(),
    appliedRuns: db.prepare(
      'SELECT * FROM run_outcome_applied_runs ORDER BY product, run_id',
    ).all(),
    windows: db.prepare(
      'SELECT * FROM run_fingerprint_windows ORDER BY product, file_path, test_name, build_ordinal',
    ).all(),
    fingerprints: db.prepare(
      'SELECT * FROM suite_fingerprints ORDER BY product, file_path, test_name, seq',
    ).all(),
    version: db.prepare('SELECT * FROM run_outcome_projection_version ORDER BY id').all(),
  }
}

function withIndex<T>(knowledgeRoot: string, read: (db: DatabaseSync) => T): T {
  const handle = openIndexWriter(knowledgeRoot)
  try {
    return read(handle.db)
  } finally {
    handle.close()
  }
}

interface PreV4Project {
  knowledgeRoot: string
  runsRoot: string
}

/**
 * PRODUCE the pre-v4 state, then subtract exactly what a v3-era fold never wrote.
 *
 * Everything up to the two DELETEs is the real production path: the same `foldRunOutcomes` the
 * curation tail calls, against the same `openIndexWriter` index, over handoff documents written
 * to a real runs root the way the runner writes them.
 *
 * `artifacts` plants RAW `analysis.json` bytes beside a run's handoff, keyed by runId. Raw rather
 * than typed, because the poisoned cell's whole subject is a file that is NOT a valid artifact and
 * could not be expressed as one (WR-06). The pre-state folds pass no `runDir`, so a planted
 * artifact contributes nothing until the REBUILD reads it — which is exactly the leg under test.
 */
function producePreV4Project(options: {
  runs?: readonly CompletedRunHandoff[]
  artifacts?: Readonly<Record<string, string>>
} = {}): PreV4Project {
  const knowledgeRoot = tempDir('reconcile-knowledge-')
  const runsRoot = tempDir('reconcile-runs-')

  for (const handoff of options.runs ?? HISTORICAL_RUNS) {
    const runDir = join(runsRoot, String(handoff.runId))
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, 'handoff.json'), JSON.stringify(handoff))
    const artifactBytes = options.artifacts?.[String(handoff.runId)]
    if (artifactBytes !== undefined) {
      writeFileSync(join(runDir, ANALYSIS_FILE), artifactBytes, 'utf8')
    }
    const report = foldRunOutcomes({ knowledgeRoot, handoff, extractAnchors })
    expect(report.kind).toBe('applied')
  }

  withIndex(knowledgeRoot, (db) => {
    // The only synthetic step: strip what a v3-era fold never produced.
    db.exec('DELETE FROM suite_fingerprints')
    db.exec('DELETE FROM run_outcome_projection_version')
  })

  return { knowledgeRoot, runsRoot }
}

describe('reconcileRunOutcomesProjection — the projection-version backfill', () => {
  it('converges a pre-v4 index: suite_fingerprints goes empty -> populated with no counter drift', () => {
    const { knowledgeRoot, runsRoot } = producePreV4Project()

    const before = withIndex(knowledgeRoot, (db) => {
      expect(db.prepare('SELECT COUNT(*) AS n FROM suite_fingerprints').get())
        .toMatchObject({ n: 0 })
      expect(db.prepare('SELECT COUNT(*) AS n FROM run_outcome_applied_runs').get())
        .toMatchObject({ n: HISTORICAL_RUNS.length })
      expect(createSuiteFingerprintIndex(db, { product: SHOP_PRODUCT }).elementUnion().size)
        .toBe(0)
      return dumpProjection(db)
    })

    const result = reconcileRunOutcomesProjection({ knowledgeRoot, runsRoot, extractAnchors })
    expect(result.kind).toBe('rebuilt')
    expect(result.kind === 'rebuilt' ? result.report : undefined)
      .toEqual({ folded: HISTORICAL_RUNS.length, skippedHandoffs: 0, skippedArtifacts: 0 })

    withIndex(knowledgeRoot, (db) => {
      const fingerprintCount = db.prepare('SELECT COUNT(*) AS n FROM suite_fingerprints').get() as
        { n: number }
      expect(fingerprintCount.n).toBeGreaterThan(0)

      const union = createSuiteFingerprintIndex(db, { product: SHOP_PRODUCT }).elementUnion()
      expect(union.size).toBeGreaterThan(0)
      expect(union.has(CHECKOUT_ELEMENT)).toBe(true)

      // Counter parity: the rebuild recomputes from the same handoffs, so nothing double-counts.
      expect(dumpProjection(db).outcomes).toEqual(before.outcomes)
      expect(db.prepare('SELECT * FROM run_outcome_projection_version').all())
        .toEqual([{ id: 1, version: RUN_OUTCOMES_PROJECTION_VERSION }])
    })
  })

  it('answers current on an already-stamped index, writes nothing, and keeps the marker final', () => {
    const { knowledgeRoot, runsRoot } = producePreV4Project()
    expect(reconcileRunOutcomesProjection({ knowledgeRoot, runsRoot, extractAnchors }).kind)
      .toBe('rebuilt')

    const before = withIndex(knowledgeRoot, dumpProjection)

    const second = reconcileRunOutcomesProjection({ knowledgeRoot, runsRoot, extractAnchors })
    expect(second).toEqual({ kind: 'current' })

    expect(withIndex(knowledgeRoot, dumpProjection)).toEqual(before)

    // The marker short-circuit is intact AT the current version: an already-folded run still
    // answers 'already-applied' rather than refolding on every open.
    const refold = foldRunOutcomes({
      knowledgeRoot,
      handoff: HISTORICAL_RUNS[0]!,
      extractAnchors,
    })
    expect(refold.kind).toBe('already-applied')
    expect(withIndex(knowledgeRoot, dumpProjection)).toEqual(before)
  })

  it.each([1, 3, 4])('an index whose stored projection version is %i rebuilds at the current version', (stored) => {
    const { knowledgeRoot, runsRoot } = producePreV4Project()
    expect(reconcileRunOutcomesProjection({ knowledgeRoot, runsRoot, extractAnchors }).kind)
      .toBe('rebuilt')
    withIndex(knowledgeRoot, (db) => {
      db.prepare('UPDATE run_outcome_projection_version SET version = ?').run(stored)
    })

    const result = reconcileRunOutcomesProjection({ knowledgeRoot, runsRoot, extractAnchors })
    expect(result.kind).toBe('rebuilt')
    expect(result.kind === 'rebuilt' ? result.report : undefined)
      .toEqual({ folded: HISTORICAL_RUNS.length, skippedHandoffs: 0, skippedArtifacts: 0 })
    withIndex(knowledgeRoot, (db) => {
      expect(db.prepare('SELECT * FROM run_outcome_projection_version').all())
        .toEqual([{ id: 1, version: RUN_OUTCOMES_PROJECTION_VERSION }])
    })
  })

  it('an excludedFromOutcomes gate-run contributes zero rows through the rebuild', () => {
    const { knowledgeRoot, runsRoot } = producePreV4Project()
    expect(reconcileRunOutcomesProjection({ knowledgeRoot, runsRoot, extractAnchors }).kind)
      .toBe('rebuilt')

    withIndex(knowledgeRoot, (db) => {
      const union = createSuiteFingerprintIndex(db, { product: SHOP_PRODUCT }).elementUnion()
      expect(union.has(GATE_ELEMENT)).toBe(false)
      expect(
        db.prepare('SELECT COUNT(*) AS n FROM suite_fingerprints WHERE file_path = ?')
          .get(GATE_TEST.filePath),
      ).toMatchObject({ n: 0 })
      expect(
        db.prepare('SELECT COUNT(*) AS n FROM run_test_outcomes WHERE file_path = ?')
          .get(GATE_TEST.filePath),
      ).toMatchObject({ n: 0 })
      // The run itself is still marked applied — exclusion removes its members, never its receipt.
      expect(
        db.prepare('SELECT COUNT(*) AS n FROM run_outcome_applied_runs WHERE product = ? AND run_id = ?')
          .get(SHOP_PRODUCT, '003-gate'),
      ).toMatchObject({ n: 1 })
    })
  })

  it('leaves memidex source-of-truth rows byte-identical across a rebuild', () => {
    const { knowledgeRoot, runsRoot } = producePreV4Project()

    withIndex(knowledgeRoot, (db) => {
      db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
        .run('fixture-source-of-truth', 'survives-the-rebuild')
    })
    const metaBefore = withIndex(knowledgeRoot, (db) =>
      db.prepare('SELECT * FROM meta ORDER BY k').all())

    expect(reconcileRunOutcomesProjection({ knowledgeRoot, runsRoot, extractAnchors }).kind)
      .toBe('rebuilt')

    expect(withIndex(knowledgeRoot, (db) => db.prepare('SELECT * FROM meta ORDER BY k').all()))
      .toEqual(metaBefore)
  })

  it('costs ONE run, never the family, when a run dir carries a truncated analysis.json', () => {
    const { knowledgeRoot, runsRoot } = producePreV4Project({
      artifacts: { '002-login': TRUNCATED_ARTIFACT_BYTES },
    })

    const result = reconcileRunOutcomesProjection({ knowledgeRoot, runsRoot, extractAnchors })

    // The poisoned run is SKIPPED ENTIRELY, not folded to the deterministic floor: the
    // incremental path hard-fails on the same bytes, so parity means ABSENCE, and floor counters
    // for a run no fold ever produced would misrepresent AI-resolved verdicts at their
    // unresolved floor.
    expect(result).toEqual({
      kind: 'rebuilt',
      report: { folded: 2, skippedHandoffs: 0, skippedArtifacts: 1 },
    })

    withIndex(knowledgeRoot, (db) => {
      // The stamp lands, so the next sweep answers `current` instead of re-destroying the family
      // on every sweep for as long as the bad artifact exists.
      expect(db.prepare('SELECT * FROM run_outcome_projection_version').all())
        .toEqual([{ id: 1, version: RUN_OUTCOMES_PROJECTION_VERSION }])

      const appliedRunIds = (db.prepare(
        'SELECT run_id FROM run_outcome_applied_runs WHERE product = ? ORDER BY run_id',
      ).all(SHOP_PRODUCT) as { run_id: string }[]).map((row) => row.run_id)
      expect(appliedRunIds).toEqual(['001-checkout', '003-gate'])

      // The runs AFTER the poisoned one in sort order still fold — the pre-fix module truncated
      // the family at the bad file and left everything past it missing.
      const union = createSuiteFingerprintIndex(db, { product: SHOP_PRODUCT }).elementUnion()
      expect(union.has(CHECKOUT_ELEMENT)).toBe(true)
      expect(
        db.prepare('SELECT COUNT(*) AS n FROM run_test_outcomes WHERE file_path = ?')
          .get(CHECKOUT_TEST.filePath),
      ).toMatchObject({ n: 1 })
      expect(
        db.prepare('SELECT COUNT(*) AS n FROM run_test_outcomes WHERE file_path = ?')
          .get(LOGIN_TEST.filePath),
      ).toMatchObject({ n: 0 })
    })
  })

  it('refuses to stamp when a PROJECTION-layer throw aborts the rebuild, and self-heals next sweep (projection half)', () => {
    const { knowledgeRoot, runsRoot } = producePreV4Project()

    // The injected seam is consumed by `testDelta` inside `projectRunOutcomes` — a PURE computation
    // that completes BEFORE `applyRunOutcomes` is ever called — so what this cell pins is the
    // PROJECTION half of the boundary: a throw raised while computing, after the DELETEs. It does
    // not stand in for a write-layer failure; the trigger cell below holds that half (393 round 7,
    // measured by mutation). By the time it fires the family has already been DELETEd, which is the
    // whole question: what does the module do with a family it has destroyed and cannot rebuild?
    const throwingAnchors = (): never[] => {
      throw new Error('projection layer refused')
    }

    // (i) It PROPAGATES. A per-run catch this wide counts the throw as a skip and walks on to the
    // stamp — which is the round-6 regression, and the assertion this cell RED-receipts.
    expect(() => reconcileRunOutcomesProjection({
      knowledgeRoot,
      runsRoot,
      extractAnchors: throwingAnchors,
    })).toThrow('projection layer refused')

    // (ii) NO stamp — the prohibition. `suite_fingerprints` is the substrate gate 3's
    // `elementUnion()` decides on, so an EMPTY family stamped CURRENT is not a degraded answer,
    // it is a permanently wrong one: every later reconcile answers 'current' and never looks again.
    withIndex(knowledgeRoot, (db) => {
      expect(db.prepare('SELECT * FROM run_outcome_projection_version').all()).toEqual([])
      expect(createSuiteFingerprintIndex(db, { product: SHOP_PRODUCT }).elementUnion().size).toBe(0)
    })

    // (iii) The absent stamp reads as a mismatch, so the next HEALTHY sweep rebuilds and the family
    // comes back. This is the other half of the pin (the two-sided contract law): fail-closed alone
    // would be a projection that is merely broken more loudly. Asserted on `.kind` so this cell
    // pins the POSTURE, not the report's field names.
    expect(reconcileRunOutcomesProjection({ knowledgeRoot, runsRoot, extractAnchors }).kind)
      .toBe('rebuilt')

    withIndex(knowledgeRoot, (db) => {
      expect(createSuiteFingerprintIndex(db, { product: SHOP_PRODUCT }).elementUnion()
        .has(CHECKOUT_ELEMENT)).toBe(true)
      const outcomes = db.prepare('SELECT COUNT(*) AS n FROM run_test_outcomes').get() as
        { n: number }
      expect(outcomes.n).toBeGreaterThan(0)
      expect(db.prepare('SELECT * FROM run_outcome_projection_version').all())
        .toEqual([{ id: 1, version: RUN_OUTCOMES_PROJECTION_VERSION }])
    })
  })

  it('refuses to stamp when the WRITE itself fails: a trigger on run_outcome_applied_runs aborts applyRunOutcomes (frozen item 6c)', () => {
    const { knowledgeRoot, runsRoot } = producePreV4Project()

    // Driven from OUTSIDE the module's own seams. A trigger is a persisted schema object, so the
    // reconcile's OWN connection hits it when `applyRunOutcomes` reaches its marker INSERT, inside
    // that function's own `BEGIN IMMEDIATE`. A pure-path throw therefore cannot satisfy this cell —
    // which is the property the projection cell above was measured NOT to have (393 frozen item 6c).
    withIndex(knowledgeRoot, (db) => {
      db.exec(
        `CREATE TRIGGER refuse_applied_runs_insert BEFORE INSERT ON run_outcome_applied_runs
         BEGIN SELECT RAISE(ABORT, 'write path refused'); END;`,
      )
    })

    // (i) It PROPAGATES. The matched string is the trigger's own injected text and appears nowhere
    // in the module, so the assertion cannot pass off static wording.
    expect(() => reconcileRunOutcomesProjection({ knowledgeRoot, runsRoot, extractAnchors }))
      .toThrow('write path refused')

    // (ii) NO stamp, and gate 3's substrate is left empty rather than empty-AND-current.
    withIndex(knowledgeRoot, (db) => {
      expect(db.prepare('SELECT * FROM run_outcome_projection_version').all()).toEqual([])
      expect(createSuiteFingerprintIndex(db, { product: SHOP_PRODUCT }).elementUnion().size).toBe(0)
    })

    // (iii) The write path recovers, and the next sweep heals the family it destroyed.
    withIndex(knowledgeRoot, (db) => db.exec('DROP TRIGGER refuse_applied_runs_insert'))

    expect(reconcileRunOutcomesProjection({ knowledgeRoot, runsRoot, extractAnchors }).kind)
      .toBe('rebuilt')

    withIndex(knowledgeRoot, (db) => {
      expect(createSuiteFingerprintIndex(db, { product: SHOP_PRODUCT }).elementUnion()
        .has(CHECKOUT_ELEMENT)).toBe(true)
      expect(db.prepare('SELECT * FROM run_outcome_projection_version').all())
        .toEqual([{ id: 1, version: RUN_OUTCOMES_PROJECTION_VERSION }])
    })
  })

  it('propagates a host fault reading handoff.json: previous complete family survived, then the healed sweep rebuilds', () => {
    const { knowledgeRoot, runsRoot } = producePreV4Project()
    expect(reconcileRunOutcomesProjection({ knowledgeRoot, runsRoot, extractAnchors }).kind)
      .toBe('rebuilt')
    const previous = withIndex(knowledgeRoot, (db) => {
      db.prepare('UPDATE run_outcome_projection_version SET version = ?')
        .run(RUN_OUTCOMES_PROJECTION_VERSION - 1)
      expect(createSuiteFingerprintIndex(db, { product: SHOP_PRODUCT }).elementUnion().size).toBe(2)
      return dumpProjection(db)
    })

    // A DIRECTORY where the document belongs: `readFileSync` throws EISDIR, an errno-coded
    // non-absence host fault. Root-proof where chmod is inert, on SECOND run 002-login
    // (WR-04): the first run must not become a partial union while the fault persists.
    const handoffPath = join(runsRoot, '002-login', 'handoff.json')
    rmSync(handoffPath)
    mkdirSync(handoffPath)

    expect(() => reconcileRunOutcomesProjection({ knowledgeRoot, runsRoot, extractAnchors }))
      .toThrow(/EISDIR/)

    withIndex(knowledgeRoot, (db) => {
      expect(dumpProjection(db)).toEqual(previous)
      expect(createSuiteFingerprintIndex(db, { product: SHOP_PRODUCT }).elementUnion().size).toBe(2)
    })

    rmSync(handoffPath, { recursive: true })
    writeFileSync(handoffPath, JSON.stringify(HISTORICAL_RUNS[1]))

    expect(reconcileRunOutcomesProjection({ knowledgeRoot, runsRoot, extractAnchors }).kind)
      .toBe('rebuilt')

    withIndex(knowledgeRoot, (db) => {
      expect(createSuiteFingerprintIndex(db, { product: SHOP_PRODUCT }).elementUnion()
        .has(CHECKOUT_ELEMENT)).toBe(true)
      expect(db.prepare('SELECT * FROM run_outcome_projection_version').all())
        .toEqual([{ id: 1, version: RUN_OUTCOMES_PROJECTION_VERSION }])
    })
  })

  it('propagates a host fault reading analysis.json: previous complete family survived, then the healed sweep rebuilds', () => {
    const { knowledgeRoot, runsRoot } = producePreV4Project()
    expect(reconcileRunOutcomesProjection({ knowledgeRoot, runsRoot, extractAnchors }).kind)
      .toBe('rebuilt')
    const previous = withIndex(knowledgeRoot, (db) => {
      db.prepare('UPDATE run_outcome_projection_version SET version = ?')
        .run(RUN_OUTCOMES_PROJECTION_VERSION - 1)
      expect(createSuiteFingerprintIndex(db, { product: SHOP_PRODUCT }).elementUnion().size).toBe(2)
      return dumpProjection(db)
    })

    // The sibling-input law: ONE fault primitive, BOTH documents. The run carries a directory where
    // its artifact belongs, so `loadRunArtifact`'s `readFileSync` throws EISDIR and the loader
    // rethrows it (non-ENOENT) into the per-run artifact catch that owns the skip decision.
    const artifactPath = join(runsRoot, '002-login', ANALYSIS_FILE)
    mkdirSync(artifactPath)

    expect(() => reconcileRunOutcomesProjection({ knowledgeRoot, runsRoot, extractAnchors }))
      .toThrow(/EISDIR/)

    withIndex(knowledgeRoot, (db) => {
      expect(dumpProjection(db)).toEqual(previous)
      expect(createSuiteFingerprintIndex(db, { product: SHOP_PRODUCT }).elementUnion().size).toBe(2)
    })

    // Healed by removal: an ABSENT artifact is legitimate, so the run folds handoff-only.
    rmSync(artifactPath, { recursive: true })

    expect(reconcileRunOutcomesProjection({ knowledgeRoot, runsRoot, extractAnchors }).kind)
      .toBe('rebuilt')

    withIndex(knowledgeRoot, (db) => {
      expect(createSuiteFingerprintIndex(db, { product: SHOP_PRODUCT }).elementUnion()
        .has(CHECKOUT_ELEMENT)).toBe(true)
      expect(db.prepare('SELECT * FROM run_outcome_projection_version').all())
        .toEqual([{ id: 1, version: RUN_OUTCOMES_PROJECTION_VERSION }])
    })
  })

  it('reads a VALID analysis.json through the reconcile-driven rebuild (the other half)', () => {
    const { knowledgeRoot, runsRoot } = producePreV4Project({
      runs: [...HISTORICAL_RUNS, FLAKE_RUN],
      artifacts: { [FLAKE_RUN_ID]: canonicalJson(flakeArtifact(FLAKE_RUN_ID)) },
    })

    // The pre-state folds passed no runDir, so the floor governs: an `unknown` failure is not a
    // flake. A rebuild that read handoffs alone would leave this at 0 and every fingerprint
    // assertion above would still pass — which is how an unexercised artifact leg stays invisible.
    withIndex(knowledgeRoot, (db) => expect(flakeCountOf(db)).toBe(0))

    expect(reconcileRunOutcomesProjection({ knowledgeRoot, runsRoot, extractAnchors }))
      .toEqual({
        kind: 'rebuilt',
        report: { folded: 4, skippedHandoffs: 0, skippedArtifacts: 0 },
      })

    withIndex(knowledgeRoot, (db) => expect(flakeCountOf(db)).toBe(1))
  })

  it('keeps the INCREMENTAL fold hard-failing on the same truncated artifact', () => {
    const { knowledgeRoot, runsRoot } = producePreV4Project({
      artifacts: { '002-login': TRUNCATED_ARTIFACT_BYTES },
    })

    // The per-run catch belongs to the REBUILD loop and nowhere else. "Never swallowed into a
    // silent floor" was argued for this path, and this is the case the rebuild's new guard still
    // has to reject — drawn from outside the fix's own assumption.
    expect(() => foldRunOutcomes({
      knowledgeRoot,
      handoff: HISTORICAL_RUNS[1]!,
      runDir: join(runsRoot, '002-login'),
      extractAnchors,
    })).toThrow(SyntaxError)
  })

  it('stamps the current version over an empty project without folding anything', () => {
    const knowledgeRoot = tempDir('reconcile-empty-knowledge-')
    const runsRoot = tempDir('reconcile-empty-runs-')

    const result = reconcileRunOutcomesProjection({ knowledgeRoot, runsRoot, extractAnchors })
    expect(result).toEqual({
      kind: 'rebuilt',
      report: { folded: 0, skippedHandoffs: 0, skippedArtifacts: 0 },
    })

    withIndex(knowledgeRoot, (db) => {
      expect(db.prepare('SELECT COUNT(*) AS n FROM run_test_outcomes').get()).toMatchObject({ n: 0 })
      expect(db.prepare('SELECT COUNT(*) AS n FROM suite_fingerprints').get()).toMatchObject({ n: 0 })
      expect(db.prepare('SELECT * FROM run_outcome_projection_version').all())
        .toEqual([{ id: 1, version: RUN_OUTCOMES_PROJECTION_VERSION }])
    })

    expect(reconcileRunOutcomesProjection({ knowledgeRoot, runsRoot, extractAnchors }))
      .toEqual({ kind: 'current' })
  })
})
