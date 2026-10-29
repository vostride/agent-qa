import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

import { CURRENT_HANDOFF_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type { CompletedRunHandoff, ScopeKey } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { ensureRunOutcomeTables } from '../../index-open.js'
import {
  failureRecurrence as barrelFailureRecurrence,
  listTestsInFile as barrelListTestsInFile,
  priorBuildOutcome as barrelPriorBuildOutcome,
  readTestOutcomeHistory as barrelReadTestOutcomeHistory,
} from '../../index.js'
import {
  failureRecurrence,
  listTestsInFile,
  priorBuildOutcome,
  readTestOutcomeHistory,
  type TestOutcomeEntry,
  type TestOutcomeHistory,
} from '../run-outcome-read.js'
import {
  applyRunOutcomes,
  LAST_OUTCOMES_LIMIT,
  projectRunOutcomes,
} from '../run-outcomes.js'

const SHOP_SCOPE: ScopeKey = { tier: 'product', key: 'shop-web' }
const PRODUCT = 'shop-web'
const FILE_PATH = 'suite/checkout.test.ts'
const TEST_NAME = 'checkout happy path'

/**
 * Minimal handoff carrying one counted per-test outcome. Self-contained rather than
 * imported from run-outcomes.test.ts — importing a sibling .test.ts re-runs its suite.
 */
function oneTestHandoff(input: {
  runId: string
  buildOrdinal: number
  outcome: 'passed' | 'failed'
  heals?: number
  flake?: boolean
}): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: input.runId,
    buildOrdinal: input.buildOrdinal,
    scope: SHOP_SCOPE,
    executionContext: 'ci',
    aggregateVerdict: input.outcome,
    configDigests: {
      suiteConfigDigest: 'fixture-suite-config-digest',
      testConfigDigest: 'fixture-test-config-digest',
    },
    startedAt: input.buildOrdinal * 1_000,
    endedAt: input.buildOrdinal * 1_000 + 1,
    tests: [
      {
        testId: 'checkout-happy-1',
        testName: TEST_NAME,
        filePath: FILE_PATH,
        testIndex: 0,
        outcome: input.outcome,
        steps: [],
        ...(input.flake === true
          ? {
              rootCause: {
                class: 'flake',
                producer: 'deterministic-classifier',
                confidence: 1,
                evidence: {
                  citedSteps: [],
                  citedAnchors: [],
                  citedArtifacts: [],
                  rationale: 'fixture flake root cause',
                },
                memoryMisdirectionRuledOut: true,
                perTest: 1,
              },
            }
          : {}),
      },
    ],
  } as unknown as CompletedRunHandoff
}

function openDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  ensureRunOutcomeTables(db)
  return db
}

/** Write through the projection's real writer path — the rows the reader must round-trip. */
function fold(
  db: DatabaseSync,
  input: Parameters<typeof oneTestHandoff>[0],
): void {
  applyRunOutcomes(db, projectRunOutcomes(oneTestHandoff(input), {
    extractAnchors: () => [],
  }))
}

function insertRawRow(db: DatabaseSync, lastOutcomesJson: string): void {
  db.prepare(`
    INSERT INTO run_test_outcomes (
      product, scope_tier, scope_key, file_path, test_name, passes, failures, heals,
      flake_count, last_outcomes_json, last_build_ordinal
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    PRODUCT,
    'product',
    PRODUCT,
    FILE_PATH,
    TEST_NAME,
    4,
    2,
    1,
    1,
    lastOutcomesJson,
    9,
  )
}

describe('readTestOutcomeHistory', () => {
  it('round-trips a row written by the real fold path, lastOutcomes ordinal-ascending', () => {
    const db = openDb()
    fold(db, { runId: 'run-b3', buildOrdinal: 3, outcome: 'failed' })
    fold(db, { runId: 'run-b5', buildOrdinal: 5, outcome: 'passed' })

    const history = readTestOutcomeHistory(db, {
      product: PRODUCT,
      filePath: FILE_PATH,
      testName: TEST_NAME,
    })
    expect(history).toEqual({
      passes: 1,
      failures: 1,
      heals: 0,
      flakeCount: 0,
      lastOutcomes: [
        { buildOrdinal: 3, passed: false },
        { buildOrdinal: 5, passed: true },
      ],
      lastBuildOrdinal: 5,
    } satisfies TestOutcomeHistory)
  })

  it('answers undefined for a missing row — never a throw, never an empty object', () => {
    const db = openDb()
    fold(db, { runId: 'run-b1', buildOrdinal: 1, outcome: 'passed' })

    expect(readTestOutcomeHistory(db, {
      product: PRODUCT,
      filePath: FILE_PATH,
      testName: 'a test never folded',
    })).toBeUndefined()
    expect(readTestOutcomeHistory(db, {
      product: 'other-product',
      filePath: FILE_PATH,
      testName: TEST_NAME,
    })).toBeUndefined()
  })

  it('caps lastOutcomes at LAST_OUTCOMES_LIMIT entries, ascending, most-recent kept', () => {
    const db = openDb()
    for (let ordinal = 1; ordinal <= LAST_OUTCOMES_LIMIT + 2; ordinal += 1) {
      fold(db, {
        runId: `run-b${ordinal}`,
        buildOrdinal: ordinal,
        outcome: ordinal % 2 === 0 ? 'passed' : 'failed',
      })
    }

    const history = readTestOutcomeHistory(db, {
      product: PRODUCT,
      filePath: FILE_PATH,
      testName: TEST_NAME,
    })
    expect(history?.lastOutcomes).toHaveLength(LAST_OUTCOMES_LIMIT)
    expect(history?.lastOutcomes[0]).toEqual({ buildOrdinal: 3, passed: false })
    expect(history?.lastOutcomes.at(-1)).toEqual({
      buildOrdinal: LAST_OUTCOMES_LIMIT + 2,
      passed: true,
    })
    const ordinals = (history?.lastOutcomes ?? []).map((entry) => entry.buildOrdinal)
    expect(ordinals).toEqual([...ordinals].sort((a, b) => a - b))
  })

  it.each([
    ['unparseable bytes', '{not json'],
    ['parseable non-array', '{"buildOrdinal":9,"passed":true}'],
  ])('heals %s in last_outcomes_json to an empty window, scalars intact', (_label, json) => {
    const db = openDb()
    insertRawRow(db, json)

    const history = readTestOutcomeHistory(db, {
      product: PRODUCT,
      filePath: FILE_PATH,
      testName: TEST_NAME,
    })
    expect(history).toEqual({
      passes: 4,
      failures: 2,
      heals: 1,
      flakeCount: 1,
      lastOutcomes: [],
      lastBuildOrdinal: 9,
    } satisfies TestOutcomeHistory)
  })

  it('is a read-only module: no INSERT/UPDATE/DELETE statement text in its source', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../run-outcome-read.ts', import.meta.url)),
      'utf8',
    )
    const withoutComments = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n')
    expect(withoutComments).not.toMatch(/\b(?:insert|update|delete)\b/i)
  })
})

/** Pure-derivation fixture: scalars derived from the entries so the shape stays honest. */
function historyOf(entries: TestOutcomeEntry[]): TestOutcomeHistory {
  return {
    passes: entries.filter((entry) => entry.passed).length,
    failures: entries.filter((entry) => !entry.passed).length,
    heals: 0,
    flakeCount: 0,
    lastOutcomes: entries,
    lastBuildOrdinal: entries.at(-1)?.buildOrdinal,
  }
}

describe('priorBuildOutcome (forced discriminator channel)', () => {
  const twoBuilds = historyOf([
    { buildOrdinal: 3, passed: true },
    { buildOrdinal: 5, passed: false },
  ])

  it('answers the greatest ordinal strictly below current — one step either side of each boundary', () => {
    expect(priorBuildOutcome(twoBuilds, 5)).toEqual({ buildOrdinal: 3, passed: true })
    expect(priorBuildOutcome(twoBuilds, 6)).toEqual({ buildOrdinal: 5, passed: false })
    expect(priorBuildOutcome(twoBuilds, 4)).toEqual({ buildOrdinal: 3, passed: true })
    expect(priorBuildOutcome(twoBuilds, 3)).toBeUndefined()
    expect(priorBuildOutcome(twoBuilds, 2)).toBeUndefined()
  })

  it('answers typed absence for an empty history and a single current-build entry', () => {
    expect(priorBuildOutcome(historyOf([]), 7)).toBeUndefined()
    expect(
      priorBuildOutcome(historyOf([{ buildOrdinal: 7, passed: false }]), 7),
    ).toBeUndefined()
  })
})

describe('failureRecurrence (live recurrence join)', () => {
  const mixed = historyOf([
    { buildOrdinal: 3, passed: false },
    { buildOrdinal: 5, passed: false },
    { buildOrdinal: 7, passed: true },
  ])

  it('counts kth as failed entries at or below current — one step either side of each boundary', () => {
    expect(failureRecurrence(mixed, 5)).toEqual({ kth: 2, windowBuilds: 3 })
    expect(failureRecurrence(mixed, 6)).toEqual({ kth: 2, windowBuilds: 3 })
    expect(failureRecurrence(mixed, 4)).toEqual({ kth: 1, windowBuilds: 3 })
    expect(failureRecurrence(mixed, 3)).toEqual({ kth: 1, windowBuilds: 3 })
    expect(failureRecurrence(mixed, 2)).toEqual({ kth: 0, windowBuilds: 3 })
  })

  it('includes the current failure when recorded, and windowBuilds counts distinct ordinals only', () => {
    const current = historyOf([{ buildOrdinal: 7, passed: false }])
    expect(failureRecurrence(current, 7)).toEqual({ kth: 1, windowBuilds: 1 })

    const flap = historyOf([
      { buildOrdinal: 4, passed: false },
      { buildOrdinal: 4, passed: true },
      { buildOrdinal: 6, passed: false },
    ])
    expect(failureRecurrence(flap, 6)).toEqual({ kth: 2, windowBuilds: 2 })
  })

  it('answers {kth: 0, windowBuilds: 0} for an empty history — typed absence, never faked', () => {
    expect(failureRecurrence(historyOf([]), 9)).toEqual({ kth: 0, windowBuilds: 0 })
  })
})

describe('knowledge-local barrel export', () => {
  it('publishes the read function and both derivations as the same symbols', () => {
    expect(barrelReadTestOutcomeHistory).toBe(readTestOutcomeHistory)
    expect(barrelPriorBuildOutcome).toBe(priorBuildOutcome)
    expect(barrelFailureRecurrence).toBe(failureRecurrence)
  })
})

// A query that dropped `product` would name another app's flaky test under the same file path.

function insertRow(
  db: DatabaseSync,
  row: { product: string; filePath: string; testName: string },
): void {
  db.prepare(`
    INSERT INTO run_test_outcomes (
      product, scope_tier, scope_key, file_path, test_name, passes, failures, heals,
      flake_count, last_outcomes_json, last_build_ordinal
    ) VALUES (?, ?, ?, ?, ?, 1, 0, 0, 0, '[]', 1)
  `).run(row.product, 'product', row.product, row.filePath, row.testName)
}

describe('listTestsInFile', () => {
  it('answers the file\'s counted identities in test_name order', () => {
    const db = openDb()
    insertRow(db, { product: PRODUCT, filePath: FILE_PATH, testName: 'zeta checkout' })
    insertRow(db, { product: PRODUCT, filePath: FILE_PATH, testName: 'alpha checkout' })

    expect(listTestsInFile(db, { product: PRODUCT, filePath: FILE_PATH }))
      .toEqual(['alpha checkout', 'zeta checkout'])
  })

  it('never serves ANOTHER product\'s rows under the same file path', () => {
    const db = openDb()
    insertRow(db, { product: PRODUCT, filePath: FILE_PATH, testName: 'ours' })
    insertRow(db, { product: 'other-app', filePath: FILE_PATH, testName: 'theirs' })

    expect(listTestsInFile(db, { product: PRODUCT, filePath: FILE_PATH })).toEqual(['ours'])
    // And the fixture really did put a row there under the other key, so the cell above is an
    // exclusion rather than an empty table.
    expect(listTestsInFile(db, { product: 'other-app', filePath: FILE_PATH })).toEqual(['theirs'])
  })

  it('answers [] for a file the projection has never counted', () => {
    const db = openDb()
    fold(db, { runId: 'run-b1', buildOrdinal: 1, outcome: 'passed' })

    expect(listTestsInFile(db, { product: PRODUCT, filePath: 'suite/never-run.test.ts' }))
      .toEqual([])
  })

  it('is published on the barrel as the same symbol', () => {
    expect(barrelListTestsInFile).toBe(listTestsInFile)
  })
})
