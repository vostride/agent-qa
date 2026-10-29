import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  CURRENT_HANDOFF_SCHEMA_VERSION,
  actionAnchorElement,
  type Action,
  type CompletedRunHandoff,
  type ElementInfo,
  type PerTestOutcome,
  type ScopeKey,
  type StepEvidence,
  type SubActionEvidence,
} from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it } from 'vitest'

import { ensureRunOutcomeTables } from '../../index-open.js'
import {
  applyRunOutcomes,
  projectionPartition,
  projectRunOutcomes,
  rebuildRunOutcomes,
} from '../run-outcomes.js'
import {
  createSuiteFingerprintIndex,
  foldSuiteFingerprints,
  SUITE_FINGERPRINTS_TABLE,
} from '../suite-fingerprints.js'

const SHOP_SCOPE: ScopeKey = { tier: 'product', key: 'shop-web' }
const SHOP_PRODUCT = projectionPartition(SHOP_SCOPE).product

// The anchor walk the fold reuses resolves an element from `stateBefore.elements` by the ref the
// planned action carried, so a fixture sub-action is (action type, ref, the element that ref
// names, and the URL context around it). Everything below is built through these helpers rather
// than as row literals: the expected ELEMENT bytes are computed by schema's own
// `actionAnchorElement` in each assertion, so a fixture cannot pin a string this recipe would
// never mint (the produced-not-literal law).
interface SubActionFixture {
  type: string
  ref?: string
  role?: string
  name?: string
  url?: string
  urlAfter?: string
  success?: boolean
}

interface TestFixture {
  filePath: string
  testName: string
  outcome?: PerTestOutcome['outcome']
  steps?: SubActionFixture[][]
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

function screenState(url: string | undefined, elements: ElementInfo[], timestamp: number): unknown {
  return {
    platform: 'web',
    tree: '',
    elements,
    refMap: {},
    timestamp,
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
    stateBefore: screenState(fixture.url, elements, 0),
    ...(fixture.urlAfter === undefined
      ? {}
      : { stateAfter: screenState(fixture.urlAfter, [], 1) }),
    result: { success: fixture.success ?? true },
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
    outcome: fixture.outcome ?? 'passed',
    steps: (fixture.steps ?? []).map((subActions, index) => stepEvidence(index, subActions)),
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

function openDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  ensureRunOutcomeTables(db)
  return db
}

interface FingerprintRow {
  product: string
  file_path: string
  test_name: string
  seq: number
  element: string
  run_id: string
  build_ordinal: number
}

function fingerprintRows(db: DatabaseSync): FingerprintRow[] {
  return db.prepare(`
    SELECT * FROM ${SUITE_FINGERPRINTS_TABLE}
    ORDER BY product, file_path, test_name, seq
  `).all() as unknown as FingerprintRow[]
}

function elementsFor(db: DatabaseSync, filePath: string, testName: string): string[] {
  return fingerprintRows(db)
    .filter((row) => row.file_path === filePath && row.test_name === testName)
    .map((row) => row.element)
}

/** THE production path: one fold pass, both projections, one applied-runs marker. */
function foldThroughRunOutcomes(db: DatabaseSync, handoff: CompletedRunHandoff): void {
  applyRunOutcomes(db, projectRunOutcomes(handoff, { extractAnchors }))
}

/** The standalone door the gate evaluator's own harness uses. */
function foldDirectly(
  db: DatabaseSync,
  handoff: CompletedRunHandoff,
  excluded = false,
): void {
  foldSuiteFingerprints(db, handoff, { product: SHOP_PRODUCT, excluded })
}

const CHECKOUT_TEST: TestFixture = {
  filePath: 'suite/checkout.test.ts',
  testName: 'checkout happy path',
  steps: [
    [
      { type: 'click', ref: 'e1', role: 'button', name: 'checkout', url: '/cart' },
      { type: 'assertValue', url: '/cart' },
    ],
  ],
}

const LOGIN_TEST: TestFixture = {
  filePath: 'suite/login.test.ts',
  testName: 'login with a valid password',
  steps: [[{ type: 'fill', ref: 'e9', role: 'textbox', name: 'password', url: '/login' }]],
}

const CHECKOUT_CLICK_ELEMENT = actionAnchorElement({
  kind: 'action',
  type: 'click',
  anchor: { t: 'el', role: 'button', name: 'checkout', ordinal: 0 },
  route: '/cart',
})

const CHECKOUT_ASSERT_ELEMENT = actionAnchorElement({
  kind: 'assert',
  type: 'assertValue',
  anchor: { t: 'page', route: '/cart' },
})

const LOGIN_FILL_ELEMENT = actionAnchorElement({
  kind: 'action',
  type: 'fill',
  anchor: { t: 'el', role: 'textbox', name: 'password', ordinal: 0 },
  route: '/login',
})

describe('the suite-fingerprint table (the gate comparison substrate)', () => {
  it('writes one ordered row set per (filePath, testName) from sub-action evidence', () => {
    const db = openDb()
    foldThroughRunOutcomes(db, handoffFixture({
      runId: 'run-fp-a',
      buildOrdinal: 4,
      tests: [CHECKOUT_TEST, LOGIN_TEST],
    }))

    const rows = fingerprintRows(db)
    expect(rows).toHaveLength(3)
    expect(rows.every((row) => row.product === SHOP_PRODUCT)).toBe(true)
    expect(rows.every((row) => row.run_id === 'run-fp-a' && row.build_ordinal === 4)).toBe(true)

    // ORDER is part of the recipe (D-13): the sequence is what a later §4.1 enrichment builds on.
    expect(elementsFor(db, 'suite/checkout.test.ts', 'checkout happy path')).toEqual([
      CHECKOUT_CLICK_ELEMENT,
      CHECKOUT_ASSERT_ELEMENT,
    ])
    expect(
      rows
        .filter((row) => row.file_path === 'suite/checkout.test.ts')
        .map((row) => row.seq),
    ).toEqual([0, 1])

    // Keyed by STABLE identity, never testId: the second test is a separate row set.
    expect(elementsFor(db, 'suite/login.test.ts', 'login with a valid password')).toEqual([
      LOGIN_FILL_ELEMENT,
    ])
  })

  it(
    'writes ZERO fingerprint rows for a handoff flagged excludedFromOutcomes — '
    + 'a gate-run never seeds the union it is later compared against',
    () => {
      const db = openDb()
      foldThroughRunOutcomes(db, handoffFixture({
        runId: 'run-fp-gate',
        buildOrdinal: 4,
        tests: [CHECKOUT_TEST, LOGIN_TEST],
        excludedFromOutcomes: true,
      }))

      expect(fingerprintRows(db)).toEqual([])
      // The same run is excluded from the outcome counters, which is the point: ONE exclusion
      // read gates BOTH projections, so the two tables can never disagree about a gate-run.
      expect(db.prepare('SELECT * FROM run_test_outcomes').all()).toEqual([])
    },
  )

  it('excludes a flagged handoff through the standalone fold door as well', () => {
    const db = openDb()
    foldDirectly(db, handoffFixture({
      runId: 'run-fp-gate-direct',
      buildOrdinal: 4,
      tests: [CHECKOUT_TEST],
    }), true)

    expect(fingerprintRows(db)).toEqual([])
  })

  it('replaces one identity\'s rows from newer evidence and leaves other identities untouched', () => {
    const db = openDb()
    foldThroughRunOutcomes(db, handoffFixture({
      runId: 'run-fp-old',
      buildOrdinal: 4,
      tests: [CHECKOUT_TEST, LOGIN_TEST],
    }))

    foldThroughRunOutcomes(db, handoffFixture({
      runId: 'run-fp-new',
      buildOrdinal: 9,
      tests: [{
        ...CHECKOUT_TEST,
        steps: [[{ type: 'click', ref: 'e2', role: 'link', name: 'pay now', url: '/pay' }]],
      }],
    }))

    expect(elementsFor(db, 'suite/checkout.test.ts', 'checkout happy path')).toEqual([
      actionAnchorElement({
        kind: 'action',
        type: 'click',
        anchor: { t: 'el', role: 'link', name: 'pay now', ordinal: 0 },
        route: '/pay',
      }),
    ])
    expect(elementsFor(db, 'suite/login.test.ts', 'login with a valid password')).toEqual([
      LOGIN_FILL_ELEMENT,
    ])
  })

  it('keeps the newest evidence when an OLDER run folds afterwards (fold order cannot decide)', () => {
    const db = openDb()
    foldThroughRunOutcomes(db, handoffFixture({
      runId: 'run-fp-new',
      buildOrdinal: 9,
      tests: [CHECKOUT_TEST],
    }))
    foldThroughRunOutcomes(db, handoffFixture({
      runId: 'run-fp-old',
      buildOrdinal: 4,
      tests: [{
        ...CHECKOUT_TEST,
        steps: [[{ type: 'click', ref: 'e2', role: 'link', name: 'pay now', url: '/pay' }]],
      }],
    }))

    const rows = fingerprintRows(db)
    expect(rows.every((row) => row.run_id === 'run-fp-new')).toBe(true)
    expect(elementsFor(db, 'suite/checkout.test.ts', 'checkout happy path')).toEqual([
      CHECKOUT_CLICK_ELEMENT,
      CHECKOUT_ASSERT_ELEMENT,
    ])
  })

  it('contributes no rows for a test with no usable sub-action evidence (the text lane)', () => {
    const db = openDb()
    foldThroughRunOutcomes(db, handoffFixture({
      runId: 'run-fp-bare',
      buildOrdinal: 4,
      tests: [
        { filePath: 'suite/bare.test.ts', testName: 'no steps at all' },
        { filePath: 'suite/bare.test.ts', testName: 'a step with no sub-actions', steps: [[]] },
        {
          filePath: 'suite/bare.test.ts',
          testName: 'a sub-action with neither element nor route',
          steps: [[{ type: 'delay' }]],
        },
      ],
    }))

    expect(fingerprintRows(db)).toEqual([])
  })

  it('contributes no element for a sub-action whose result did not succeed', () => {
    const db = openDb()
    foldThroughRunOutcomes(db, handoffFixture({
      runId: 'run-fp-failed',
      buildOrdinal: 4,
      tests: [{
        filePath: 'suite/checkout.test.ts',
        testName: 'checkout happy path',
        steps: [[
          { type: 'click', ref: 'e1', role: 'button', name: 'checkout', url: '/cart' },
          { type: 'click', ref: 'e2', role: 'button', name: 'confirm', url: '/cart', success: false },
        ]],
      }],
    }))

    expect(elementsFor(db, 'suite/checkout.test.ts', 'checkout happy path')).toEqual([
      CHECKOUT_CLICK_ELEMENT,
    ])
  })

  it('re-applying the same run leaves the rows byte-identical (convergent, not marker-gated)', () => {
    const db = openDb()
    const handoff = handoffFixture({
      runId: 'run-fp-a',
      buildOrdinal: 4,
      tests: [CHECKOUT_TEST, LOGIN_TEST],
    })
    foldDirectly(db, handoff)
    const first = fingerprintRows(db)
    foldDirectly(db, handoff)

    expect(fingerprintRows(db)).toEqual(first)
  })
})

describe('the suite-fingerprint read port', () => {
  it('answers a union whose size is the distinct element count in the table', () => {
    const db = openDb()
    foldThroughRunOutcomes(db, handoffFixture({
      runId: 'run-fp-a',
      buildOrdinal: 4,
      tests: [
        CHECKOUT_TEST,
        LOGIN_TEST,
        // A second test exercising the SAME click as CHECKOUT_TEST: three rows arrive, but the
        // union is a set, so the repeated element counts once. The set semantics live HERE, at
        // the consumer, exactly as the recipe's own header says (D-14).
        {
          filePath: 'suite/checkout.test.ts',
          testName: 'checkout with a saved card',
          steps: [[{ type: 'click', ref: 'e1', role: 'button', name: 'checkout', url: '/cart' }]],
        },
      ],
    }))
    const index = createSuiteFingerprintIndex(db, { product: SHOP_PRODUCT })

    const distinct = new Set(fingerprintRows(db).map((row) => row.element))
    expect(fingerprintRows(db)).toHaveLength(4)
    expect(index.elementUnion().size).toBe(distinct.size)
    expect(index.elementUnion()).toEqual(
      new Set([CHECKOUT_CLICK_ELEMENT, CHECKOUT_ASSERT_ELEMENT, LOGIN_FILL_ELEMENT]),
    )
  })

  it('reports the covered identities so the consumer can derive the evidence-less set', () => {
    const db = openDb()
    foldThroughRunOutcomes(db, handoffFixture({
      runId: 'run-fp-a',
      buildOrdinal: 4,
      tests: [
        CHECKOUT_TEST,
        LOGIN_TEST,
        { filePath: 'suite/bare.test.ts', testName: 'no evidence at all' },
      ],
    }))
    const index = createSuiteFingerprintIndex(db, { product: SHOP_PRODUCT })

    expect(index.coveredTests()).toEqual([
      { filePath: 'suite/checkout.test.ts', testName: 'checkout happy path' },
      { filePath: 'suite/login.test.ts', testName: 'login with a valid password' },
    ])
    // The authored-test universe minus the covered set IS the text lane's input. The evidence-less
    // member is absent here, which is what puts it on that lane rather than silently uncovered.
    expect(index.elementsForTest('suite/bare.test.ts', 'no evidence at all')).toEqual([])
    expect(index.elementsForTest('suite/checkout.test.ts', 'checkout happy path')).toEqual([
      CHECKOUT_CLICK_ELEMENT,
      CHECKOUT_ASSERT_ELEMENT,
    ])
  })

  it('answers an empty union and no covered tests over an empty table (the empty-suite edge)', () => {
    const index = createSuiteFingerprintIndex(openDb(), { product: SHOP_PRODUCT })

    expect(index.elementUnion()).toEqual(new Set())
    expect(index.coveredTests()).toEqual([])
    expect(index.elementsForTest('suite/anything.test.ts', 'anything')).toEqual([])
  })

  it('scopes every read to its own partition — a draft never compares against another product', () => {
    const db = openDb()
    foldThroughRunOutcomes(db, handoffFixture({
      runId: 'run-fp-a',
      buildOrdinal: 4,
      tests: [CHECKOUT_TEST],
    }))

    const other = createSuiteFingerprintIndex(db, { product: 'some-other-product' })
    expect(other.elementUnion()).toEqual(new Set())
    expect(other.coveredTests()).toEqual([])
  })
})

const tempDirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('rebuild identity and ordering for the suite-fingerprint table', () => {
  /**
   * Three runs over two identities, one of them a flagged gate-run:
   *  - `run-a` (ordinal 4) covers checkout and login.
   *  - `run-b` (ordinal 9) re-covers checkout with DIFFERENT evidence — the newest-wins case.
   *  - `run-gate` (ordinal 12) is the NEWEST run and is flagged, so if the exclusion were not
   *    applied on a path it would win everywhere and be impossible to miss.
   */
  function corpus(): CompletedRunHandoff[] {
    return [
      handoffFixture({ runId: 'run-a', buildOrdinal: 4, tests: [CHECKOUT_TEST, LOGIN_TEST] }),
      handoffFixture({
        runId: 'run-b',
        buildOrdinal: 9,
        tests: [{
          ...CHECKOUT_TEST,
          steps: [[{ type: 'click', ref: 'e2', role: 'link', name: 'pay now', url: '/pay' }]],
        }],
      }),
      handoffFixture({
        runId: 'run-gate',
        buildOrdinal: 12,
        tests: [{
          ...CHECKOUT_TEST,
          steps: [[{ type: 'click', ref: 'e3', role: 'button', name: 'gate run only', url: '/gate' }]],
        }],
        excludedFromOutcomes: true,
      }),
    ]
  }

  function foldAll(handoffs: CompletedRunHandoff[]): DatabaseSync {
    const db = openDb()
    for (const handoff of handoffs) foldThroughRunOutcomes(db, handoff)
    return db
  }

  function dump(db: DatabaseSync): unknown[] {
    return db.prepare(`
      SELECT product, file_path, test_name, seq, element, run_id, build_ordinal
      FROM ${SUITE_FINGERPRINTS_TABLE}
      ORDER BY product, file_path, test_name, seq
    `).all()
  }

  it(
    'produces one row set from either fold order AND from a rebuild, with the flagged run '
    + 'absent from all three',
    () => {
      const handoffs = corpus()
      const forward = foldAll(handoffs)
      const reversed = foldAll([...handoffs].reverse())

      const runsRoot = tempDir('suite-fingerprints-rebuild-')
      for (const handoff of handoffs) {
        const dir = join(runsRoot, String(handoff.runId))
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'handoff.json'), JSON.stringify(handoff))
      }
      const rebuilt = openDb()
      // Pre-seed a row the rebuild must clear, so a rebuild that never touched this table would
      // fail here rather than pass by coincidence.
      foldThroughRunOutcomes(rebuilt, handoffFixture({
        runId: 'run-stale',
        buildOrdinal: 99,
        tests: [{
          filePath: 'suite/stale.test.ts',
          testName: 'a row from a run that no longer exists',
          steps: [[{ type: 'click', ref: 'e7', role: 'button', name: 'stale', url: '/stale' }]],
        }],
      }))
      expect(rebuildRunOutcomes(rebuilt, runsRoot, { extractAnchors })).toEqual({
        folded: 3,
        skippedHandoffs: 0,
        skippedArtifacts: 0,
      })

      const expected = dump(forward)
      expect(expected).toHaveLength(2)
      expect(dump(reversed)).toEqual(expected)
      expect(dump(rebuilt)).toEqual(expected)

      // The newest run in the corpus is the flagged one; nothing it touched is anywhere.
      const everyElement = dump(rebuilt).map((row) => (row as { element: string }).element)
      expect(everyElement.join(' ')).not.toContain('gate run only')
      expect(dump(rebuilt).map((row) => (row as { run_id: string }).run_id)).toEqual([
        'run-b',
        'run-a',
      ])
    },
  )
})
