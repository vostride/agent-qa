import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DashboardDatabase } from '../db/database.js'

type SuiteAnalyticsDatabase = DashboardDatabase & {
  getRunsBySuiteId: (
    suiteId: string,
    opts?: { limit?: number; offset?: number },
  ) => Array<{
    id: string
    suiteId: string | null
    parentRunId: string | null
    status: string
    duration: number
  }>
  getRunsBySuiteIdCount: (suiteId: string) => number
  getSuiteTrends: (suiteId: string, opts?: { from?: string }) => {
    daily: Array<{
      date: string
      passed: number
      failed: number
      total: number
      avgDuration: number
    }>
    passRate: number
    totalRuns: number
    avgDuration: number
  }
}

let db: DashboardDatabase

function insertSampleRun(overrides: Record<string, unknown> = {}) {
  return db.insertRun({
    name: 'Alpha Suite',
    filePath: 'suites/alpha.suite.yaml',
    status: 'passed',
    duration: 1000,
    startedAt: '2026-03-02T08:00:00Z',
    endedAt: '2026-03-02T08:00:01Z',
    platform: 'web',
    suiteId: 's_alpha',
    ...overrides,
  })
}

function seedSuiteAnalyticsFixture() {
  const oldestSuiteRunId = insertSampleRun({
    id: 'suite-alpha-1',
    status: 'passed',
    duration: 1000,
    startedAt: '2026-03-02T08:00:00Z',
    endedAt: '2026-03-02T08:00:01Z',
  })
  const middleSuiteRunId = insertSampleRun({
    id: 'suite-alpha-2',
    status: 'failed',
    duration: 3000,
    startedAt: '2026-03-02T09:00:00Z',
    endedAt: '2026-03-02T09:00:03Z',
  })
  const newestSuiteRunId = insertSampleRun({
    id: 'suite-alpha-3',
    status: 'passed',
    duration: 2000,
    startedAt: '2026-03-03T10:00:00Z',
    endedAt: '2026-03-03T10:00:02Z',
  })

  db.insertRun({
    id: 'suite-alpha-child',
    name: 'Alpha Child Test',
    filePath: 'tests/alpha-child.yaml',
    status: 'failed',
    duration: 750,
    startedAt: '2026-03-02T09:30:00Z',
    endedAt: '2026-03-02T09:30:01Z',
    platform: 'web',
    suiteId: 's_alpha',
    parentRunId: middleSuiteRunId,
    testId: 't_alpha-child',
  })

  db.insertRun({
    id: 'suite-alpha-dashboard-top-level',
    name: 'Alpha Standalone Test',
    filePath: 'tests/alpha-standalone.yaml',
    status: 'passed',
    duration: 500,
    startedAt: '2026-03-03T11:00:00Z',
    endedAt: '2026-03-03T11:00:01Z',
    platform: 'web',
    testId: 't_alpha-standalone',
  })

  db.insertRun({
    id: 'suite-beta-1',
    name: 'Beta Suite',
    filePath: 'suites/beta.suite.yaml',
    status: 'passed',
    duration: 1800,
    startedAt: '2026-03-03T08:00:00Z',
    endedAt: '2026-03-03T08:00:02Z',
    platform: 'web',
    suiteId: 's_beta',
  })

  db.insertRun({
    id: 'plain-test-run',
    name: 'Standalone Test',
    filePath: 'tests/login.yaml',
    status: 'passed',
    duration: 900,
    startedAt: '2026-03-01T07:00:00Z',
    endedAt: '2026-03-01T07:00:01Z',
    platform: 'web',
    testId: 't_login',
  })

  return {
    newestSuiteRunId,
    middleSuiteRunId,
    oldestSuiteRunId,
  }
}

beforeEach(() => {
  db = new DashboardDatabase({ dbPath: ':memory:' })
})

afterEach(() => {
  db.close()
})

describe('DashboardDatabase suite analytics helpers', () => {
  it('returns only top-level suite runs for a suite id in descending order', () => {
    const ids = seedSuiteAnalyticsFixture()
    const suiteDb = db as SuiteAnalyticsDatabase

    const runs = suiteDb.getRunsBySuiteId('s_alpha')

    expect(runs.map((run) => run.id)).toEqual([
      ids.newestSuiteRunId,
      ids.middleSuiteRunId,
      ids.oldestSuiteRunId,
    ])
    expect(runs).toHaveLength(3)
    expect(runs.every((run) => run.suiteId === 's_alpha')).toBe(true)
    expect(runs.every((run) => run.parentRunId === null)).toBe(true)
  })

  it('counts only the filtered top-level suite runs', () => {
    seedSuiteAnalyticsFixture()
    const suiteDb = db as SuiteAnalyticsDatabase

    expect(suiteDb.getRunsBySuiteIdCount('s_alpha')).toBe(3)
  })

  it('returns trends from the same filtered suite-only run set', () => {
    seedSuiteAnalyticsFixture()
    const suiteDb = db as SuiteAnalyticsDatabase

    expect(suiteDb.getSuiteTrends('s_alpha')).toEqual({
      daily: [
        {
          date: '2026-03-02',
          passed: 1,
          failed: 1,
          total: 2,
          avgDuration: 2000,
        },
        {
          date: '2026-03-03',
          passed: 1,
          failed: 0,
          total: 1,
          avgDuration: 2000,
        },
      ],
      passRate: 2 / 3,
      totalRuns: 3,
      avgDuration: 2000,
    })
  })
})
