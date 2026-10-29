import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  CURRENT_HANDOFF_SCHEMA_VERSION,
  canonicalJson,
  normalizeAnchor,
  type Anchor,
  type CompletedRunHandoff,
  type PerTestOutcome,
  type ScopeKey,
  type StepEvidence,
} from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it } from 'vitest'

import { ensureRunOutcomeTables, indexDbPath, openIndexWriter } from '../../index-open.js'
import { acquireWriterLease, releaseLease, WriterAuthorityLostError } from '../../lease/writer-lease.js'
import {
  applyRunOutcomes,
  projectRunOutcomes,
  rebuildRunOutcomes,
  reconcileRunOutcomesProjection,
  RUN_OUTCOMES_PROJECTION_VERSION,
} from '../run-outcomes.js'
import { createSuiteFingerprintIndex } from '../suite-fingerprints.js'

const SHOP_SCOPE: ScopeKey = { tier: 'product', key: 'shop-web' }
const BLOG_SCOPE: ScopeKey = { tier: 'product', key: 'blog-web' }

interface StepFixture {
  stepIndex: number
  anchors?: Anchor[]
  selfHealed?: boolean
  fingerprintName?: string
}

interface TestFixture {
  filePath: string
  testId: string
  testName?: string
  outcome: PerTestOutcome['outcome']
  rootCauseClass?: string
  steps?: StepFixture[]
}

function stepEvidence(fixture: StepFixture): StepEvidence {
  return {
    stepIndex: fixture.stepIndex,
    stepText: `step ${fixture.stepIndex}`,
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
    subActions: fixture.fingerprintName === undefined ? [] : [{
      plan: 'click the exercised control',
      plannedAction: { type: 'click', ref: 'control' },
      stateBefore: {
        platform: 'web',
        tree: '', refMap: {}, timestamp: 0, metadata: {},
        elements: [{ ref: 'control', role: 'button', name: fixture.fingerprintName,
          nameNormalized: fixture.fingerprintName,
          state: { enabled: true, focused: false, visible: true }, labels: {}, attributes: {} }],
      },
      result: { success: true },
    }],
    verifierVerdict: { pass: true, reasoning: 'fixture verdict' },
    anchors: fixture.anchors ?? [],
    ...(fixture.selfHealed === true
      ? { selfHeal: { failedDecision: {}, recoveringDecision: {} } }
      : {}),
  } as unknown as StepEvidence
}

// Indexes come from the member's position, because the resolved-class map is keyed by them.
function perTest(fixture: TestFixture, testIndex: number): PerTestOutcome {
  return {
    testId: fixture.testId,
    testName: fixture.testName ?? fixture.testId,
    filePath: fixture.filePath,
    testIndex,
    outcome: fixture.outcome,
    steps: (fixture.steps ?? []).map(stepEvidence),
    ...(fixture.rootCauseClass === undefined
      ? {}
      : {
          rootCause: {
            class: fixture.rootCauseClass,
            producer: 'deterministic-classifier',
            confidence: 1,
            evidence: {
              citedSteps: [],
              citedAnchors: [],
              citedArtifacts: [],
              rationale: `fixture ${fixture.rootCauseClass} root cause`,
            },
            memoryMisdirectionRuledOut: true,
            perTest: testIndex,
          },
        }),
  } as unknown as PerTestOutcome
}

function handoffFixture(input: {
  runId: string
  buildOrdinal: number
  scope: ScopeKey
  tests: TestFixture[]
  excludedFromOutcomes?: true
}): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: input.runId,
    buildOrdinal: input.buildOrdinal,
    scope: input.scope,
    executionContext: 'ci',
    aggregateVerdict: input.tests.some(
      (test) =>
        test.outcome === 'failed' ||
        test.outcome === 'timeout' ||
        test.outcome === 'cancelled',
    )
      ? 'failed'
      : 'passed',
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

const extractAnchors = (step: StepEvidence): Anchor[] =>
  (step as unknown as { anchors?: Anchor[] }).anchors ?? []

function openDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  ensureRunOutcomeTables(db)
  return db
}

interface TableDump {
  outcomes: unknown[]
  anchors: unknown[]
  appliedRuns: unknown[]
}

function dumpTables(db: DatabaseSync): TableDump {
  return {
    outcomes: db.prepare(
      'SELECT * FROM run_test_outcomes ORDER BY product, file_path, test_name',
    ).all(),
    anchors: db.prepare(
      'SELECT * FROM run_test_anchors ORDER BY product, file_path, test_name, anchor_normalized_json',
    ).all(),
    appliedRuns: db.prepare(
      'SELECT product, run_id FROM run_outcome_applied_runs ORDER BY product, run_id',
    ).all(),
  }
}

const checkoutAnchor: Anchor = { t: 'el', role: 'button', name: 'checkout', ordinal: 0 }
const cartPageAnchor: Anchor = { t: 'page', route: '/cart' }
const payAnchor: Anchor = { t: 'el', role: 'button', name: 'pay now', ordinal: 1 }

function threeOutcomeHandoff(): CompletedRunHandoff {
  return handoffFixture({
    runId: 'run-a',
    buildOrdinal: 7,
    scope: SHOP_SCOPE,
    tests: [
      {
        filePath: 'suite/checkout.test.ts',
        testId: 'checkout-happy-1',
        testName: 'checkout happy path',
        outcome: 'passed',
        steps: [
          { stepIndex: 0, anchors: [checkoutAnchor, cartPageAnchor], selfHealed: true },
        ],
      },
      {
        filePath: 'suite/checkout.test.ts',
        testId: 'checkout-declined-1',
        testName: 'checkout declined card',
        outcome: 'failed',
        rootCauseClass: 'app_bug',
        steps: [{ stepIndex: 0, anchors: [payAnchor] }],
      },
      {
        filePath: 'suite/login.test.ts',
        testId: 'login-retry-1',
        testName: 'login after retry',
        outcome: 'passed',
        rootCauseClass: 'flake',
        steps: [{ stepIndex: 0 }],
      },
    ],
  })
}

const tempDirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('run-outcome projection fold', () => {
  it('skips without writer authority before opening or touching the index', () => {
    const knowledgeRoot = tempDir('projection-no-authority-')
    const options = { knowledgeRoot, runsRoot: join(knowledgeRoot, 'runs'), extractAnchors }
    expect(reconcileRunOutcomesProjection(options))
      .toEqual({ kind: 'skipped', reason: 'no-writer-authority' })
    expect(readdirSync(knowledgeRoot)).toEqual([])
    expect(existsSync(indexDbPath(knowledgeRoot))).toBe(false)
    const handle = openIndexWriter(knowledgeRoot)
    applyRunOutcomes(handle.db, projectRunOutcomes(threeOutcomeHandoff(), { extractAnchors }))
    const previous = dumpTables(handle.db)
    const before = statSync(indexDbPath(knowledgeRoot))
    expect(reconcileRunOutcomesProjection(options))
      .toEqual({ kind: 'skipped', reason: 'no-writer-authority' })
    const after = statSync(indexDbPath(knowledgeRoot))
    expect([after.mtimeMs, after.size]).toEqual([before.mtimeMs, before.size])
    expect(dumpTables(handle.db)).toEqual(previous)
    handle.close()
  })

  it('rebuilds under current authority and refuses a stale epoch before any deletion', () => {
    const knowledgeRoot = tempDir('projection-current-authority-')
    const options = { knowledgeRoot, runsRoot: join(knowledgeRoot, 'runs'), extractAnchors }
    const authority = acquireWriterLease(knowledgeRoot)
    if (authority.kind !== 'acquired') throw new Error('fixture failed to acquire writer')
    try {
      expect(reconcileRunOutcomesProjection({ ...options, authority }).kind).toBe('rebuilt')
      const handle = openIndexWriter(knowledgeRoot)
      applyRunOutcomes(handle.db, projectRunOutcomes(threeOutcomeHandoff(), { extractAnchors }))
      handle.db.prepare('UPDATE run_outcome_projection_version SET version = ?')
        .run(RUN_OUTCOMES_PROJECTION_VERSION - 1)
      const previous = dumpTables(handle.db)
      const stamp = handle.db.prepare('SELECT * FROM run_outcome_projection_version').all()
      expect(() => reconcileRunOutcomesProjection({
        ...options, authority: { leaseId: authority.leaseId, epoch: authority.epoch - 1 },
      })).toThrow(WriterAuthorityLostError)
      expect(dumpTables(handle.db)).toEqual(previous)
      expect(handle.db.prepare('SELECT * FROM run_outcome_projection_version').all()).toEqual(stamp)
      handle.close()
      expect(reconcileRunOutcomesProjection({ ...options, authority }).kind).toBe('rebuilt')
    } finally {
      releaseLease({ knowledgeRoot, leaseId: authority.leaseId })
    }
  })

  it('stamps the suite-fingerprint projection shape at version 2', () => {
    expect(RUN_OUTCOMES_PROJECTION_VERSION).toBe(2)
  })

  it('folds pass/failure/heal/flake counters, last-N ordinals, and normalized anchor rows', () => {
    const db = openDb()
    const projection = projectRunOutcomes(threeOutcomeHandoff(), {
      extractAnchors,
    })

    const result = applyRunOutcomes(db, projection)
    expect(result).toEqual({ kind: 'applied', tests: 3 })

    const rows = db.prepare(
      'SELECT * FROM run_test_outcomes ORDER BY file_path, test_name',
    ).all() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(3)

    const happy = rows.find((row) => row.test_name === 'checkout happy path')
    expect(happy).toMatchObject({
      file_path: 'suite/checkout.test.ts',
      passes: 1,
      failures: 0,
      heals: 1,
      flake_count: 0,
      last_build_ordinal: 7,
    })
    expect(happy?.last_outcomes_json).toBe(
      canonicalJson([{ buildOrdinal: 7, passed: true }]),
    )

    const declined = rows.find((row) => row.test_name === 'checkout declined card')
    expect(declined).toMatchObject({
      file_path: 'suite/checkout.test.ts',
      passes: 0,
      failures: 1,
      heals: 0,
      flake_count: 0,
    })
    expect(declined?.last_outcomes_json).toBe(
      canonicalJson([{ buildOrdinal: 7, passed: false }]),
    )

    const retried = rows.find((row) => row.test_name === 'login after retry')
    expect(retried).toMatchObject({
      file_path: 'suite/login.test.ts',
      passes: 1,
      failures: 0,
      flake_count: 1,
    })

    const anchorRows = db.prepare(
      'SELECT * FROM run_test_anchors ORDER BY file_path, test_name, anchor_normalized_json',
    ).all() as Array<Record<string, unknown>>
    expect(
      anchorRows
        .filter((row) => row.test_name === 'checkout happy path')
        .map((row) => row.anchor_normalized_json)
        .sort(),
    ).toEqual(
      [
        canonicalJson(normalizeAnchor(checkoutAnchor)),
        canonicalJson(normalizeAnchor(cartPageAnchor)),
      ].sort(),
    )
    expect(
      anchorRows
        .filter((row) => row.test_name === 'checkout declined card')
        .map((row) => row.anchor_normalized_json),
    ).toEqual([canonicalJson(normalizeAnchor(payAnchor))])
  })

  it('stores only identity, counters, and anchors — never test file content', () => {
    const db = openDb()
    const outcomeColumns = db.prepare('PRAGMA table_info(run_test_outcomes)').all()
      .map((row) => String((row as Record<string, unknown>).name))
      .sort()
    expect(outcomeColumns).toEqual([
      'failures',
      'file_path',
      'flake_count',
      'heals',
      'last_build_ordinal',
      'last_outcomes_json',
      'passes',
      'product',
      'scope_key',
      'scope_tier',
      'test_name',
    ])
    // A re-added derived `quarantined` column would disagree with the committed ledger.
    expect(outcomeColumns).not.toContain('quarantined')
    const anchorColumns = db.prepare('PRAGMA table_info(run_test_anchors)').all()
      .map((row) => String((row as Record<string, unknown>).name))
      .sort()
    expect(anchorColumns).toEqual([
      'anchor_normalized_json',
      'file_path',
      'product',
      'scope_key',
      'scope_tier',
      'test_name',
    ])
  })

  it('partitions equal test identities, anchors, and applied-run markers by product', () => {
    const db = openDb()
    const sharedTest = {
      filePath: 'suite/shared.test.ts',
      testId: 'shared-test',
      testName: 'shared test',
    }
    const shop = projectRunOutcomes(handoffFixture({
      runId: 'shared-run',
      buildOrdinal: 11,
      scope: SHOP_SCOPE,
      tests: [{
        ...sharedTest,
        outcome: 'passed',
        steps: [{ stepIndex: 0, anchors: [checkoutAnchor] }],
      }],
    }), { extractAnchors })
    const blog = projectRunOutcomes(handoffFixture({
      runId: 'shared-run',
      buildOrdinal: 12,
      scope: BLOG_SCOPE,
      tests: [{
        ...sharedTest,
        outcome: 'failed',
        steps: [{ stepIndex: 0, anchors: [payAnchor] }],
      }],
    }), { extractAnchors })

    expect(shop).toMatchObject({
      product: 'shop-web',
      scope: SHOP_SCOPE,
    })
    expect(blog).toMatchObject({
      product: 'blog-web',
      scope: BLOG_SCOPE,
    })
    expect(applyRunOutcomes(db, shop)).toEqual({ kind: 'applied', tests: 1 })
    expect(applyRunOutcomes(db, blog)).toEqual({ kind: 'applied', tests: 1 })
    expect(applyRunOutcomes(db, shop)).toEqual({ kind: 'already-applied', tests: 0 })

    expect(db.prepare(`
      SELECT product, scope_tier, scope_key, passes, failures
      FROM run_test_outcomes
      ORDER BY product
    `).all()).toEqual([
      {
        product: 'blog-web',
        scope_tier: 'product',
        scope_key: 'blog-web',
        passes: 0,
        failures: 1,
      },
      {
        product: 'shop-web',
        scope_tier: 'product',
        scope_key: 'shop-web',
        passes: 1,
        failures: 0,
      },
    ])
    expect(db.prepare(`
      SELECT product, anchor_normalized_json
      FROM run_test_anchors
      ORDER BY product
    `).all()).toEqual([
      {
        product: 'blog-web',
        anchor_normalized_json: canonicalJson(normalizeAnchor(payAnchor)),
      },
      {
        product: 'shop-web',
        anchor_normalized_json: canonicalJson(normalizeAnchor(checkoutAnchor)),
      },
    ])
    expect(db.prepare(`
      SELECT product, run_id
      FROM run_outcome_applied_runs
      ORDER BY product
    `).all()).toEqual([
      { product: 'blog-web', run_id: 'shared-run' },
      { product: 'shop-web', run_id: 'shared-run' },
    ])
  })

  it('drops and recreates a pre-partition projection instead of reading old-shape rows', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`
      CREATE TABLE run_test_outcomes (
        file_path TEXT NOT NULL,
        test_name TEXT NOT NULL,
        passes INTEGER NOT NULL DEFAULT 0,
        failures INTEGER NOT NULL DEFAULT 0,
        heals INTEGER NOT NULL DEFAULT 0,
        flake_count INTEGER NOT NULL DEFAULT 0,
        quarantined INTEGER NOT NULL DEFAULT 0,
        last_outcomes_json TEXT NOT NULL DEFAULT '[]',
        last_build_ordinal INTEGER,
        PRIMARY KEY (file_path, test_name)
      );
      CREATE TABLE run_test_anchors (
        file_path TEXT NOT NULL,
        test_name TEXT NOT NULL,
        anchor_normalized_json TEXT NOT NULL,
        UNIQUE (file_path, test_name, anchor_normalized_json)
      );
      CREATE TABLE run_outcome_applied_runs (run_id TEXT PRIMARY KEY);
      INSERT INTO run_test_outcomes (file_path, test_name, passes)
      VALUES ('legacy.test.ts', 'legacy test', 9);
      INSERT INTO run_test_anchors (file_path, test_name, anchor_normalized_json)
      VALUES ('legacy.test.ts', 'legacy test', '{}');
      INSERT INTO run_outcome_applied_runs (run_id) VALUES ('legacy-run');
    `)

    ensureRunOutcomeTables(db)

    expect(db.prepare('PRAGMA table_info(run_test_outcomes)').all()).toContainEqual(
      expect.objectContaining({ name: 'product' }),
    )
    expect(db.prepare('PRAGMA table_info(run_test_anchors)').all()).toContainEqual(
      expect.objectContaining({ name: 'product' }),
    )
    expect(db.prepare('PRAGMA table_info(run_outcome_applied_runs)').all()).toContainEqual(
      expect.objectContaining({ name: 'product' }),
    )
    expect(db.prepare('SELECT COUNT(*) AS n FROM run_test_outcomes').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM run_test_anchors').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM run_outcome_applied_runs').get()).toEqual({ n: 0 })
  })

  it('is idempotent per runId: refolding an already-applied run changes nothing', () => {
    const db = openDb()
    const projection = projectRunOutcomes(threeOutcomeHandoff(), {
      extractAnchors,
    })

    expect(applyRunOutcomes(db, projection)).toEqual({ kind: 'applied', tests: 3 })
    const before = dumpTables(db)

    expect(applyRunOutcomes(db, projection)).toEqual({ kind: 'already-applied', tests: 0 })
    expect(dumpTables(db)).toEqual(before)
  })

  it('contributes zero rows or anchors when the durable handoff marker is set', () => {
    const db = openDb()
    const excluded = handoffFixture({
      runId: 'run-gate',
      buildOrdinal: 9,
      scope: SHOP_SCOPE,
      excludedFromOutcomes: true,
      tests: [{
        filePath: 'suite/gate.test.ts',
        testId: 'internal gate replay',
        outcome: 'passed',
        steps: [{ stepIndex: 0, anchors: [payAnchor] }],
      }],
    })
    const projection = projectRunOutcomes(excluded, { extractAnchors })
    expect(projection.excluded).toBe(true)
    expect(projection.tests).toEqual([])

    expect(applyRunOutcomes(db, projection)).toEqual({ kind: 'applied', tests: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM run_test_outcomes').get()).toMatchObject({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM run_test_anchors').get()).toMatchObject({ n: 0 })
    expect(db.prepare('SELECT run_id FROM run_outcome_applied_runs').all()).toEqual([
      { run_id: 'run-gate' },
    ])
  })

  it('rebuild reproduces an incremental fold with one of three handoffs excluded', () => {
    const handoffs = [
      handoffFixture({
        runId: '001-first',
        buildOrdinal: 1,
        scope: SHOP_SCOPE,
        tests: [
          {
            filePath: 'suite/checkout.test.ts',
            testId: 'checkout happy path',
            outcome: 'passed',
            steps: [{ stepIndex: 0, anchors: [checkoutAnchor] }],
          },
        ],
      }),
      handoffFixture({
        runId: '002-second',
        buildOrdinal: 2,
        scope: SHOP_SCOPE,
        excludedFromOutcomes: true,
        tests: [
          {
            filePath: 'suite/internal-gate.test.ts',
            testId: 'internal gate replay',
            outcome: 'passed',
            steps: [{ stepIndex: 0, anchors: [payAnchor] }],
          },
        ],
      }),
      handoffFixture({
        runId: '003-third',
        buildOrdinal: 3,
        scope: BLOG_SCOPE,
        tests: [
          {
            filePath: 'suite/checkout.test.ts',
            testId: 'checkout happy path',
            outcome: 'passed',
            rootCauseClass: 'flake',
            steps: [{ stepIndex: 0, anchors: [checkoutAnchor] }],
          },
          {
            filePath: 'suite/login.test.ts',
            testId: 'login after retry',
            outcome: 'passed',
            steps: [{ stepIndex: 0, anchors: [payAnchor], selfHealed: true }],
          },
        ],
      }),
    ]

    const incremental = openDb()
    for (const handoff of handoffs) {
      applyRunOutcomes(
        incremental,
        projectRunOutcomes(handoff, { extractAnchors }),
      )
    }

    const runsRoot = tempDir('run-outcomes-rebuild-')
    for (const handoff of handoffs) {
      const dir = join(runsRoot, String(handoff.runId))
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'handoff.json'), JSON.stringify(handoff))
    }

    const rebuilt = openDb()
    // Pre-seed stale rows to prove the rebuild clears before scanning.
    applyRunOutcomes(rebuilt, projectRunOutcomes(handoffFixture({
      runId: 'stale-run',
      buildOrdinal: 99,
      scope: SHOP_SCOPE,
      tests: [{ filePath: 'stale/file.test.ts', testId: 'stale', outcome: 'passed' }],
    }), { extractAnchors }))

    const report = rebuildRunOutcomes(rebuilt, runsRoot, { extractAnchors })
    expect(report).toEqual({ folded: 3, skippedHandoffs: 0, skippedArtifacts: 0 })
    const incrementalDump = dumpTables(incremental)
    expect(dumpTables(rebuilt)).toEqual(incrementalDump)
    expect(incrementalDump.outcomes).not.toContainEqual(
      expect.objectContaining({ file_path: 'suite/internal-gate.test.ts' }),
    )
    expect(incrementalDump.anchors).not.toContainEqual(
      expect.objectContaining({ file_path: 'suite/internal-gate.test.ts' }),
    )
    expect(incrementalDump.appliedRuns).toEqual([
      { product: 'blog-web', run_id: '003-third' },
      { product: 'shop-web', run_id: '001-first' },
      { product: 'shop-web', run_id: '002-second' },
    ])
  })

  it.skipIf(process.getuid?.() === 0).each(['002-login', 'runs-holder'])(
    'refuses EACCES at %s without returning a folded report',
    (faultSite) => {
      const holder = tempDir('run-outcomes-refusal-')
      const runsRoot = join(holder, 'runs')
      for (const [index, name] of ['001-checkout', '002-login'].entries()) {
        const dir = join(runsRoot, name)
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'handoff.json'), JSON.stringify(handoffFixture({
          runId: name,
          buildOrdinal: index + 1,
          scope: SHOP_SCOPE,
          tests: [{
            filePath: `suite/${name}.test.ts`,
            testId: name,
            outcome: 'passed',
            steps: [{ stepIndex: 0, anchors: [index === 0 ? checkoutAnchor : payAnchor],
              fingerprintName: name }],
          }],
        })))
      }
      const db = openDb()
      expect(rebuildRunOutcomes(db, runsRoot, { extractAnchors }).folded).toBe(2)
      const family = () => ({
        ...dumpTables(db),
        fingerprints: db.prepare('SELECT * FROM suite_fingerprints ORDER BY file_path').all(),
        windows: db.prepare('SELECT * FROM run_fingerprint_windows ORDER BY file_path').all(),
        stamp: db.prepare('SELECT * FROM run_outcome_projection_version').all(),
      })
      // Retain an OLD stamp as well as the complete family: a failed upgrade must retry.
      db.prepare('UPDATE run_outcome_projection_version SET version = ?')
        .run(RUN_OUTCOMES_PROJECTION_VERSION - 1)
      const previous = family()
      const index = createSuiteFingerprintIndex(db, { product: 'shop-web' })
      expect(index.elementUnion().size).toBe(2)
      const inaccessible = faultSite === 'runs-holder' ? holder : join(runsRoot, faultSite)
      let report: unknown
      chmodSync(inaccessible, 0o000)
      try {
        for (let sweep = 0; sweep < 3; sweep += 1) {
          expect(() => { report = rebuildRunOutcomes(db, runsRoot, { extractAnchors }) })
            .toThrow(expect.objectContaining({ code: 'EACCES' }))
          expect(report).toBeUndefined()
          // The previous complete family survived, never the 002-login partial union of 1.
          expect(family()).toEqual(previous)
          expect(index.elementUnion().size).toBe(2)
        }
      } finally {
        chmodSync(inaccessible, 0o755)
      }
      expect(rebuildRunOutcomes(db, runsRoot, { extractAnchors }).folded).toBe(2)
      expect(family().stamp).toEqual([{ id: 1, version: RUN_OUTCOMES_PROJECTION_VERSION }])
    },
  )

  it('rebuild over an empty or missing runs dir yields empty tables without error (the empty edge)', () => {
    const emptyRoot = tempDir('run-outcomes-empty-')
    const db = openDb()
    expect(rebuildRunOutcomes(db, emptyRoot, { extractAnchors })).toEqual({
      folded: 0,
      skippedHandoffs: 0,
      skippedArtifacts: 0,
    })
    expect(rebuildRunOutcomes(db, join(emptyRoot, 'missing'), { extractAnchors })).toEqual({
      folded: 0,
      skippedHandoffs: 0,
      skippedArtifacts: 0,
    })
    expect(db.prepare('SELECT COUNT(*) AS n FROM run_test_outcomes').get()).toMatchObject({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM run_test_anchors').get()).toMatchObject({ n: 0 })
  })

  it('skips pre-fix handoffs lacking per-test testName with a counted skip, never a throw', () => {
    const runsRoot = tempDir('run-outcomes-skip-')
    const good = handoffFixture({
      runId: '001-good',
      buildOrdinal: 4,
      scope: SHOP_SCOPE,
      tests: [{
        filePath: 'suite/checkout.test.ts',
        testId: 'checkout happy path',
        outcome: 'passed',
      }],
    })
    mkdirSync(join(runsRoot, '001-good'), { recursive: true })
    writeFileSync(join(runsRoot, '001-good', 'handoff.json'), JSON.stringify(good))

    const oldShape = {
      schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
      runId: '002-old',
      buildOrdinal: 2,
      executionContext: 'ci',
      // filePath exists but testName is absent — skip structurally.
      tests: [{
        testId: 'legacy-test-1',
        filePath: 'suite/legacy.test.ts',
        testIndex: 0,
        outcome: 'passed',
        steps: [],
      }],
    }
    mkdirSync(join(runsRoot, '002-old'), { recursive: true })
    writeFileSync(join(runsRoot, '002-old', 'handoff.json'), JSON.stringify(oldShape))

    const db = openDb()
    const report = rebuildRunOutcomes(db, runsRoot, { extractAnchors })
    expect(report).toEqual({ folded: 1, skippedHandoffs: 1, skippedArtifacts: 0 })

    const rows = db.prepare('SELECT test_name FROM run_test_outcomes').all()
    expect(rows).toEqual([{ test_name: 'checkout happy path' }])
  })

  it.each([
    ['non-array tests', { tests: {} }],
    ['null test member', { tests: [null] }],
    [
      'non-string member identity',
      {
        tests: [{
          testId: 'malformed-test',
          testName: 'malformed test',
          filePath: 42,
          testIndex: 0,
          outcome: 'passed',
          steps: [],
        }],
      },
    ],
    [
      'non-array member steps',
      {
        tests: [{
          testId: 'malformed-test',
          testName: 'malformed test',
          filePath: 'suite/malformed.test.ts',
          testIndex: 0,
          outcome: 'passed',
          steps: {},
        }],
      },
    ],
  ])('counts %s as a skip and continues folding a valid sibling', (_label, shape) => {
    const good = handoffFixture({
      runId: '001-good',
      buildOrdinal: 4,
      scope: SHOP_SCOPE,
      tests: [{
        filePath: 'suite/checkout.test.ts',
        testId: 'checkout-happy-1',
        testName: 'checkout happy path',
        outcome: 'passed',
        steps: [{ stepIndex: 0, anchors: [checkoutAnchor] }],
      }],
    })
    const malformed = {
      schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
      runId: '002-malformed',
      buildOrdinal: 2,
      executionContext: 'ci',
      ...shape,
    }
    const runsRoot = tempDir('run-outcomes-malformed-')
    for (const handoff of [good, malformed]) {
      const dir = join(runsRoot, String(handoff.runId))
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'handoff.json'), JSON.stringify(handoff))
    }

    const incremental = openDb()
    applyRunOutcomes(incremental, projectRunOutcomes(good, { extractAnchors }))

    const rebuilt = openDb()
    expect(rebuildRunOutcomes(rebuilt, runsRoot, { extractAnchors })).toEqual({
      folded: 1,
      skippedHandoffs: 1,
      skippedArtifacts: 0,
    })
    expect(dumpTables(rebuilt)).toEqual(dumpTables(incremental))
  })

  // The lifetime flake count only ranks; it never forgives, so it cannot drive a quarantine.
  it('accumulates a lifetime flake count that triggers no quarantine of its own', () => {
    const db = openDb()
    for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
      applyRunOutcomes(db, projectRunOutcomes(handoffFixture({
        runId: `run-flake-${ordinal}`,
        buildOrdinal: ordinal,
        scope: SHOP_SCOPE,
        tests: [{
          filePath: 'suite/flaky.test.ts',
          testId: 'flaky test',
          outcome: 'passed',
          rootCauseClass: 'flake',
        }],
      }), { extractAnchors }))
    }

    const row = db.prepare('SELECT * FROM run_test_outcomes').get() as Record<string, unknown>
    expect(row).toMatchObject({ flake_count: 3 })
    expect(Object.keys(row)).not.toContain('quarantined')
    // Passing members write no window rows either, so a lifetime flake count cannot reach the
    // detection substrate by this path at all.
    expect(db.prepare('SELECT count(*) AS rows FROM run_fingerprint_windows').get())
      .toEqual({ rows: 0 })
  })
})
