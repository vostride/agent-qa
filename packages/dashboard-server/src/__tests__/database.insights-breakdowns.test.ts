import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DashboardDatabase } from '../db/database.js'

type BreakdownDimension = 'test' | 'suite' | 'platform'

type BreakdownRow = {
  key: string
  label: string
  runs: number
  passRate: number
  flakeRate: number
  avgDuration: number
  passed?: number
  failed?: number
  filePath?: string
  suiteId?: string
}

let db: DashboardDatabase

beforeEach(() => {
  db = new DashboardDatabase({ dbPath: ':memory:' })
})

afterEach(() => {
  db.close()
})

function insertRun(overrides: Record<string, unknown> = {}) {
  return db.insertRun({
    name: 'Checkout flow',
    filePath: 'tests/checkout.yaml',
    status: 'passed',
    duration: 1000,
    startedAt: '2026-04-01T10:00:00Z',
    endedAt: '2026-04-01T10:00:01Z',
    platform: 'web',
    ...overrides,
  })
}

function insertHealedStep(runId: string) {
  db.insertStep({
    runId,
    name: 'Retry tap',
    status: 'healed',
    duration: 50,
    stepOrder: 0,
  })
}

async function getBreakdown(
  dimension: BreakdownDimension,
  opts: { from?: string; to?: string; limit?: number } = {},
): Promise<BreakdownRow[]> {
  const getInsightsBreakdown = (
    db as DashboardDatabase & {
      getInsightsBreakdown?: (dimension: BreakdownDimension, opts?: { from?: string; to?: string; limit?: number }) => BreakdownRow[] | Promise<BreakdownRow[]>
    }
  ).getInsightsBreakdown

  expect(getInsightsBreakdown).toBeTypeOf('function')

  return await Promise.resolve(getInsightsBreakdown!.call(db, dimension, opts))
}

describe('DashboardDatabase insights breakdown aggregates', () => {
  it('keeps overview stats aligned with the same success, flake, and duration semantics', () => {
    insertRun({ name: 'Checkout flow', status: 'passed', duration: 1000, startedAt: '2026-04-01T10:00:00Z' })
    insertRun({ name: 'Checkout flow', status: 'flaky', duration: 3000, startedAt: '2026-04-01T11:00:00Z' })
    const healedRunId = insertRun({ name: 'Checkout flow', status: 'passed', duration: 2000, startedAt: '2026-04-01T12:00:00Z' })
    insertHealedStep(healedRunId)

    const stats = db.getStats()

    expect(stats.passed).toBe(3)
    expect(stats.failed).toBe(0)
    expect(stats.flakeRate).toBeCloseTo(2 / 3)
    expect(stats.avgDuration).toBeCloseTo(2000)
    expect(stats.runs[0]).toMatchObject({
      date: '2026-04-01',
      passed: 3,
      failed: 0,
      duration: 2000,
    })
  })

  it('ranks test rows and normalizes pass rate, flake rate, and avg duration semantics', async () => {
    insertRun({ name: 'Checkout flow', status: 'passed', duration: 1000 })
    insertRun({ name: 'Checkout flow', status: 'flaky', duration: 3000 })
    const healedRunId = insertRun({ name: 'Checkout flow', status: 'passed', duration: 2000 })
    insertHealedStep(healedRunId)
    insertRun({ name: 'Login flow', status: 'failed', duration: 4000 })

    const rows = await getBreakdown('test')
    const checkout = rows[0]

    expect(checkout).toMatchObject({
      key: 'Checkout flow',
      label: 'Checkout flow',
      runs: 3,
      filePath: 'tests/checkout.yaml',
    })
    expect(checkout.passRate).toBeCloseTo(1)
    expect(checkout.flakeRate).toBeCloseTo(2 / 3)
    expect(checkout.avgDuration).toBeCloseTo(2000)
  })

  it('returns suite rows with suiteId preserved for route-level label mapping', async () => {
    insertRun({ name: 'Checkout flow', filePath: 'suites/checkout.suite.yaml', source: 'suite', suiteId: 'suite-checkout', status: 'passed', duration: 1200 })
    insertRun({ name: 'Checkout flow', filePath: 'suites/checkout.suite.yaml', source: 'suite', suiteId: 'suite-checkout', status: 'failed', duration: 1800 })
    insertRun({ name: 'Login flow', filePath: 'suites/login.suite.yaml', source: 'suite', suiteId: 'suite-login', status: 'passed', duration: 900 })

    const rows = await getBreakdown('suite')
    const checkoutSuite = rows[0]

    expect(checkoutSuite).toMatchObject({
      key: 'suite-checkout',
      label: 'suite-checkout',
      suiteId: 'suite-checkout',
      runs: 2,
    })
    expect(checkoutSuite.passRate).toBeCloseTo(0.5)
    expect(checkoutSuite.avgDuration).toBeCloseTo(1500)
  })

  it('returns platform rows with summary counts instead of raw runs', async () => {
    insertRun({ name: 'Checkout flow', platform: 'web', status: 'passed', duration: 1000 })
    insertRun({ name: 'Checkout flow', platform: 'web', status: 'failed', duration: 2000 })
    insertRun({ name: 'Mobile smoke', platform: 'android', status: 'passed', duration: 3000 })

    const rows = await getBreakdown('platform')
    const web = rows.find((row) => row.key === 'web')

    expect(web).toMatchObject({
      key: 'web',
      label: 'web',
      runs: 2,
      passed: 1,
      failed: 1,
    })
    expect(web?.passRate).toBeCloseTo(0.5)
  })
})
