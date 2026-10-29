// Goldens are bytes derived by reading the source, so the code cannot just agree with itself.
import { DatabaseSync } from 'node:sqlite'

import {
  CURRENT_HANDOFF_SCHEMA_VERSION,
  CURRENT_ANALYSIS_SCHEMA_VERSION,
  type Anchor,
  type CompletedRunHandoff,
  type PerTestOutcome,
  type RunAnalysisArtifact,
  type ScopeKey,
  type StepEvidence,
  type Verdict,
} from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { ensureRunOutcomeTables } from '../../index-open.js'
import {
  fingerprintRecurrence,
  QUARANTINE_WINDOW_ORDINALS,
  readFingerprintWindow,
} from '../fingerprint-window-read.js'
import {
  applyRunOutcomes,
  projectRunOutcomes,
  RUN_OUTCOMES_PROJECTION_VERSION,
} from '../run-outcomes.js'

const SHOP_SCOPE: ScopeKey = { tier: 'product', key: 'shop-web' }
const PRODUCT = 'shop-web'
const FILE_PATH = 'suite/checkout.test.ts'
const TEST_NAME = 'checkout completes with a saved card'
const ERROR_TEXT = 'the payment sheet never opened'

/**
 * The element-anchored golden. Derived from source, not captured: `exercisedAnchors` resolves the
 * planned ref against `stateBefore.elements` and mints `{t:'el', role, name: nameNormalized,
 * ordinal: 0}`; `normalizeAnchor` casefolds the role and runs the name through
 * `normalizeAccessibleName` (both already lowercase single-spaced here); `canonicalJson` sorts
 * keys; `failureFingerprint` joins the class with `::`.
 */
const ELEMENT_GOLDEN = '{"name":"pay now","ordinal":0,"role":"button","t":"el"}'

/**
 * The anchorless golden: with no sub-actions there is no element or page contact, so the recipe
 * falls to its error arm over `errorTextOf`'s answer — the verifier reasoning — and
 * `normalizeAnchor`'s error arm casefolds, collapses whitespace and digit-runs to '#'.
 */
const ANCHORLESS_GOLDEN = '{"message":"the payment sheet never opened","t":"error"}'

const extractAnchors = (step: StepEvidence): Anchor[] =>
  (step as unknown as { anchors?: Anchor[] }).anchors ?? []

function openDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  ensureRunOutcomeTables(db)
  return db
}

function groundedStep(): StepEvidence {
  return {
    stepIndex: 0,
    stepText: 'pay with the saved card',
    cacheStatus: 'miss',
    servedBrief: {
      scope: SHOP_SCOPE,
      asOfBuild: 1,
      budget: 1,
      truncation: 'none',
      channel1: [],
      channel2: [],
      channel3: [],
      briefDigest: 'window-fixture-digest',
    },
    subActions: [{
      plannedAction: { kind: 'click', ref: 'e-pay' },
      stateBefore: {
        platform: 'web',
        url: 'https://shop.example/checkout',
        elements: [{
          ref: 'e-pay',
          role: 'button',
          nameNormalized: 'pay now',
          attributes: {},
          labels: {},
        }],
      },
      result: { error: ERROR_TEXT },
    }],
    verifierVerdict: { pass: false, reasoning: ERROR_TEXT },
    anchors: [],
  } as unknown as StepEvidence
}

function anchorlessStep(): StepEvidence {
  return {
    ...(groundedStep() as unknown as Record<string, unknown>),
    subActions: [],
  } as unknown as StepEvidence
}

function handoffFixture(input: {
  runId: string
  buildOrdinal: number
  outcome: PerTestOutcome['outcome']
  step?: StepEvidence
  testName?: string
}): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: input.runId,
    buildOrdinal: input.buildOrdinal,
    scope: SHOP_SCOPE,
    executionContext: 'ci',
    aggregateVerdict: input.outcome === 'passed' ? 'passed' : 'failed',
    configDigests: {
      suiteConfigDigest: 'window-suite-digest',
      testConfigDigest: 'window-test-digest',
    },
    startedAt: input.buildOrdinal * 1_000,
    endedAt: input.buildOrdinal * 1_000 + 1,
    tests: [{
      testId: `${input.runId}-checkout`,
      testName: input.testName ?? TEST_NAME,
      filePath: FILE_PATH,
      testIndex: 0,
      outcome: input.outcome,
      steps: [input.step ?? groundedStep()],
    } as unknown as PerTestOutcome],
  } as unknown as CompletedRunHandoff
}

function flakeArtifact(runId: string): RunAnalysisArtifact {
  const verdict: Verdict = {
    class: 'flake',
    producer: 'analyze-run',
    confidence: 0.8,
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
      groundingQuote: { stepIndex: 0, quote: ERROR_TEXT },
      discriminator: 'intermittent, no persistent cause',
      nextAction: 're-run to confirm stability',
      links: [],
    }],
  }
}

function fold(
  db: DatabaseSync,
  handoff: CompletedRunHandoff,
  artifact?: RunAnalysisArtifact,
): void {
  applyRunOutcomes(db, projectRunOutcomes(handoff, {
    extractAnchors,
    ...(artifact === undefined ? {} : { artifact }),
  }))
}

function windowRows(db: DatabaseSync): Record<string, unknown>[] {
  return db.prepare(`
    SELECT * FROM run_fingerprint_windows
    ORDER BY build_ordinal, run_id, file_path, test_name, fingerprint
  `).all() as unknown as Record<string, unknown>[]
}

describe('the fingerprint-keyed recurrence window', () => {
  it('stamps the projection at version 2 so receipted runs refold on the next tail', () => {
    expect(RUN_OUTCOMES_PROJECTION_VERSION).toBe(2)
  })

  it('writes one window row per applied failed member, keyed by THE fingerprint', () => {
    const db = openDb()

    fold(db, handoffFixture({ runId: 'run-window-aaa', buildOrdinal: 7, outcome: 'failed' }))

    expect(windowRows(db)).toEqual([{
      product: PRODUCT,
      file_path: FILE_PATH,
      test_name: TEST_NAME,
      fingerprint: `${ELEMENT_GOLDEN}::unknown`,
      verdict_class: 'unknown',
      build_ordinal: 7,
      run_id: 'run-window-aaa',
    }])
  })

  it('keys an anchorless failure through the recipe\'s error arm', () => {
    const db = openDb()

    fold(db, handoffFixture({
      runId: 'run-window-anchorless',
      buildOrdinal: 7,
      outcome: 'failed',
      step: anchorlessStep(),
    }))

    expect(windowRows(db).map((row) => row.fingerprint)).toEqual([
      `${ANCHORLESS_GOLDEN}::unknown`,
    ])
  })

  it('folds the RESOLVED class into the key — an unknown→flake upgrade re-keys the row', () => {
    const db = openDb()
    const runId = 'run-window-upgraded'

    fold(db, handoffFixture({ runId, buildOrdinal: 7, outcome: 'failed' }), flakeArtifact(runId))

    expect(windowRows(db)).toEqual([{
      product: PRODUCT,
      file_path: FILE_PATH,
      test_name: TEST_NAME,
      fingerprint: `${ELEMENT_GOLDEN}::flake`,
      verdict_class: 'flake',
      build_ordinal: 7,
      run_id: runId,
    }])
  })

  // The plan specified uniqueness over (product, fingerprint, build_ordinal, run_id); the shipped
  // constraint is WIDER, carrying file_path and test_name. This case is the whole difference: under
  // the narrower form the second test's row collides with the first and INSERT OR IGNORE drops it
  // SILENTLY, so a crossing on that fingerprint could only ever name one of the two tests it
  // actually describes. The identity has to survive because the ledger is keyed by
  // (product, filePath, testName) — a window row that cannot say which test it belongs to cannot
  // author an `entered` event. Refold idempotency is unaffected either way: a re-apply produces
  // byte-identical tuples (deduped under BOTH forms) and is short-circuited by the applied-runs
  // marker before any insert, while recurrence counts DISTINCT ordinals and so cannot inflate.
  it('keeps BOTH tests when two members of one run share a fingerprint', () => {
    const db = openDb()
    const runId = 'run-shared-fingerprint'
    const first = handoffFixture({ runId, buildOrdinal: 7, outcome: 'failed' })
    const sibling = {
      ...(first.tests[0] as unknown as Record<string, unknown>),
      testId: `${runId}-checkout-sibling`,
      testName: 'a second test failing the very same way',
      testIndex: 1,
    } as unknown as PerTestOutcome
    const handoff = {
      ...(first as unknown as Record<string, unknown>),
      tests: [first.tests[0], sibling],
    } as unknown as CompletedRunHandoff

    fold(db, handoff)

    const rows = windowRows(db)
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.test_name)).toEqual([
      'a second test failing the very same way',
      TEST_NAME,
    ])
    expect(new Set(rows.map((row) => row.fingerprint))).toEqual(
      new Set([`${ELEMENT_GOLDEN}::unknown`]),
    )
    // Two rows in one ordinal are still ONE occurrence — the distinct-ordinal count is the
    // guarantee the wider constraint does not touch.
    expect(fingerprintRecurrence(
      db,
      { product: PRODUCT, fingerprint: `${ELEMENT_GOLDEN}::unknown` },
      7,
    )).toEqual({ occurrenceOrdinals: 1, windowOrdinals: 1 })
  })

  it('writes no window row for a passing member', () => {
    const db = openDb()

    fold(db, handoffFixture({ runId: 'run-window-green', buildOrdinal: 7, outcome: 'passed' }))

    expect(windowRows(db)).toEqual([])
  })

  it('writes no second row when an already-applied run refolds (marker-gated)', () => {
    const db = openDb()
    const handoff = handoffFixture({
      runId: 'run-window-refold',
      buildOrdinal: 7,
      outcome: 'failed',
    })

    fold(db, handoff)
    const before = windowRows(db)
    expect(applyRunOutcomes(db, projectRunOutcomes(handoff, { extractAnchors })))
      .toEqual({ kind: 'already-applied', tests: 0 })

    expect(windowRows(db)).toEqual(before)
    expect(before).toHaveLength(1)
  })
})

describe('fingerprintRecurrence — distinct ordinals, sliding window', () => {
  const FINGERPRINT = `${ELEMENT_GOLDEN}::unknown`

  it('counts DISTINCT build ordinals — two failing runs in one ordinal count once', () => {
    const db = openDb()
    fold(db, handoffFixture({ runId: 'run-same-ordinal-1', buildOrdinal: 4, outcome: 'failed' }))
    fold(db, handoffFixture({ runId: 'run-same-ordinal-2', buildOrdinal: 4, outcome: 'failed' }))

    expect(windowRows(db)).toHaveLength(2)
    expect(fingerprintRecurrence(db, { product: PRODUCT, fingerprint: FINGERPRINT }, 4)).toEqual({
      occurrenceOrdinals: 1,
      windowOrdinals: 1,
    })
  })

  it('crosses on non-consecutive ordinals inside the sliding window', () => {
    const db = openDb()
    for (const buildOrdinal of [5, 7, 9]) {
      fold(db, handoffFixture({
        runId: `run-slide-${String(buildOrdinal)}`,
        buildOrdinal,
        outcome: 'failed',
      }))
    }

    expect(fingerprintRecurrence(db, { product: PRODUCT, fingerprint: FINGERPRINT }, 9)).toEqual({
      occurrenceOrdinals: 3,
      windowOrdinals: 3,
    })
  })

  it('forgives an occurrence that has slid out of the last QUARANTINE_WINDOW_ORDINALS', () => {
    const db = openDb()
    expect(QUARANTINE_WINDOW_ORDINALS).toBe(5)
    // 1 is five ordinals below 6, so it sits one step outside the window [2..6].
    for (const buildOrdinal of [1, 6]) {
      fold(db, handoffFixture({
        runId: `run-forgive-${String(buildOrdinal)}`,
        buildOrdinal,
        outcome: 'failed',
      }))
    }

    expect(fingerprintRecurrence(db, { product: PRODUCT, fingerprint: FINGERPRINT }, 6)).toEqual({
      occurrenceOrdinals: 1,
      windowOrdinals: 1,
    })
    // Boundary, one step the other way: at ordinal 5 the window is [1..5] and 1 is inside it.
    expect(fingerprintRecurrence(db, { product: PRODUCT, fingerprint: FINGERPRINT }, 5)).toEqual({
      occurrenceOrdinals: 1,
      windowOrdinals: 1,
    })
  })

  it('counts a DIFFERENT fingerprint\'s ordinals in the denominator, never the numerator', () => {
    const db = openDb()
    fold(db, handoffFixture({ runId: 'run-mine', buildOrdinal: 3, outcome: 'failed' }))
    fold(db, handoffFixture({
      runId: 'run-theirs',
      buildOrdinal: 4,
      outcome: 'failed',
      step: anchorlessStep(),
      testName: 'a different failing test',
    }))

    expect(fingerprintRecurrence(db, { product: PRODUCT, fingerprint: FINGERPRINT }, 4)).toEqual({
      occurrenceOrdinals: 1,
      windowOrdinals: 2,
    })
  })

  it('answers typed zeros for an empty window, never an undefined crash', () => {
    const db = openDb()

    expect(fingerprintRecurrence(db, { product: PRODUCT, fingerprint: FINGERPRINT }, 12)).toEqual({
      occurrenceOrdinals: 0,
      windowOrdinals: 0,
    })
    expect(readFingerprintWindow(db, { product: PRODUCT, fingerprint: FINGERPRINT }, 12))
      .toEqual([])
  })

  it('reads one fingerprint\'s rows ordinal-ascending, scoped to its own product', () => {
    const db = openDb()
    for (const buildOrdinal of [9, 5, 7]) {
      fold(db, handoffFixture({
        runId: `run-read-${String(buildOrdinal)}`,
        buildOrdinal,
        outcome: 'failed',
      }))
    }
    fold(db, handoffFixture({
      runId: 'run-read-other',
      buildOrdinal: 8,
      outcome: 'failed',
      step: anchorlessStep(),
      testName: 'a different failing test',
    }))

    const rows = readFingerprintWindow(db, { product: PRODUCT, fingerprint: FINGERPRINT }, 9)

    expect(rows.map(({ buildOrdinal, runId }) => ({ buildOrdinal, runId }))).toEqual([
      { buildOrdinal: 5, runId: 'run-read-5' },
      { buildOrdinal: 7, runId: 'run-read-7' },
      { buildOrdinal: 9, runId: 'run-read-9' },
    ])
    expect(rows.every((row) => row.fingerprint === FINGERPRINT)).toBe(true)
    expect(rows[0]).toEqual({
      product: PRODUCT,
      filePath: FILE_PATH,
      testName: TEST_NAME,
      fingerprint: FINGERPRINT,
      verdictClass: 'unknown',
      buildOrdinal: 5,
      runId: 'run-read-5',
    })
  })
})
