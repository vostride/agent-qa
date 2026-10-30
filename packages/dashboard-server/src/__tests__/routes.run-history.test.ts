import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveWorkspacePaths, type ResolvedWorkspacePaths } from '@vostride/agent-qa-core'

import { DashboardDatabase } from '../db/database.js'
import type { ExecutionBackend } from '../execution/execution-backend.js'
import { startServer } from '../server/server.js'

const SEVEN = ['pending', 'running', 'passed', 'healed', 'failed', 'timeout', 'cancelled'] as const
const FINISHED = ['passed', 'healed', 'failed', 'timeout', 'cancelled'] as const

class IdleBackend extends EventEmitter {
  execute = (): void => undefined
  kill = (): boolean => false
  killAll = (): void => undefined
  getActiveExecutions = (): [] => []
}

let dir: string
let dbPath: string
let configPath: string
let db: DashboardDatabase
const started: Array<{ close: () => void }> = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-qa-run-reads-'))
  dbPath = join(dir, 'runs.db')
  configPath = join(dir, 'agent-qa.config.yaml')
  writeFileSync(configPath, 'testDir: tests\n')
  db = new DashboardDatabase({ dbPath })
})

afterEach(() => {
  while (started.length > 0) started.pop()?.close()
  db.close()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

function seedRun(
  status: string,
  overrides: { id?: string; name?: string; startedAt?: string; suiteId?: string; filePath?: string; testId?: string } = {},
): string {
  const startedAt = overrides.startedAt ?? '2026-10-01T10:00:00.000Z'
  return db.insertRun({
    id: overrides.id,
    name: overrides.name ?? `Run ${status}`,
    status,
    duration: 1000,
    startedAt,
    endedAt: startedAt,
    ...(overrides.suiteId ? { suiteId: overrides.suiteId } : {}),
    ...(overrides.filePath ? { filePath: overrides.filePath } : {}),
    ...(overrides.testId ? { testId: overrides.testId } : {}),
  })
}

function seedSevenWords(): Record<(typeof SEVEN)[number], string> {
  const ids = {} as Record<(typeof SEVEN)[number], string>
  for (const [index, status] of SEVEN.entries()) {
    const id = seedRun(status, {
      id: `run_${status}`,
      name: 'Seven words',
      startedAt: `2026-10-01T10:0${String(index)}:00.000Z`,
      suiteId: 's_seven',
      filePath: 'tests/seven.yaml',
      testId: 't_seven',
    })
    db.upsertRunMember({
      runId: id,
      testIndex: 0,
      testId: 't_seven',
      name: 'Seven words',
      filePath: 'tests/seven.yaml',
      suiteId: 's_seven',
      ...(status === 'pending' || status === 'running' ? {} : { outcome: status }),
    })
    ids[status] = id
  }
  return ids
}

async function startDashboard(workspacePaths?: ResolvedWorkspacePaths): Promise<string> {
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  const handle = await startServer({
    declaredSecretMask: (text) => text,
    db: new DashboardDatabase({ dbPath }),
    port: 0,
    configPath,
    ...(workspacePaths ? { workspacePaths } : {}),
    executionBackend: new IdleBackend() as unknown as ExecutionBackend,
  })
  started.push(handle)
  const { port } = handle.server.address() as AddressInfo
  return `http://127.0.0.1:${String(port)}`
}

function writeSuiteWorkspace(suites: ReadonlyArray<{ suiteId: string; name: string }>): ResolvedWorkspacePaths {
  mkdirSync(join(dir, 'tests'), { recursive: true })
  mkdirSync(join(dir, 'suites'), { recursive: true })
  writeFileSync(
    join(dir, 'tests', 'a.yaml'),
    ['name: A', 'test-id: t_a', 'target: web', 'steps: []', ''].join('\n'),
  )
  for (const suite of suites) {
    writeFileSync(
      join(dir, 'suites', `${suite.suiteId}.suite.yaml`),
      [
        `suite-id: ${suite.suiteId}`,
        `name: ${suite.name}`,
        'target: web',
        'tests:',
        '  - test: tests/a.yaml',
        '    id: t_a',
        '',
      ].join('\n'),
    )
  }
  return resolveWorkspacePaths({
    config: {
      workspace: {
        testMatch: ['tests/*.yaml'],
        suiteMatch: ['suites/*.suite.yaml'],
        hooksFile: 'hooks.yaml',
        envFile: '.env',
        secretsFile: '.env.secrets.local',
      },
      knowledge: { dir: 'agent-qa-knowledge' },
    },
    configPath,
  })
}

type Member = {
  testIndex: number
  testId: string | null
  filePath: string | null
  suiteId: string | null
  name: string | null
  outcome: string | null
}

function rowOf(body: any, id: string): { id: string; members?: Member[] } {
  const row = (body.runs as Array<{ id: string; members?: Member[] }>).find((run) => run.id === id)
  expect(row, `the /api/runs page lists ${id}`).toBeDefined()
  return row!
}

async function getJson(url: string): Promise<{ status: number; body: any }> {
  const response = await fetch(url)
  return { status: response.status, body: await response.json() }
}

describe('status word classes', () => {
  it('the classifier sorts the seven words into pass, fail, cancelled and live', async () => {
    const { runStatusClass, RUN_STATUS_WORDS } = await import('../db/run-status-class.js')

    expect([...RUN_STATUS_WORDS]).toEqual([...SEVEN])
    expect(Object.fromEntries(SEVEN.map((word) => [word, runStatusClass(word)]))).toEqual({
      pending: 'live',
      running: 'live',
      passed: 'pass',
      healed: 'pass',
      failed: 'fail',
      timeout: 'fail',
      cancelled: 'cancelled',
    })
    expect(() => runStatusClass('flaky')).toThrow(/flaky/)
  })

  it('healed counts as a pass and timeout as a fail in trends and the insights summary', () => {
    seedSevenWords()

    const stats = db.getStats()
    expect(stats.totalRuns).toBe(7)
    expect(stats.passed).toBe(2)
    expect(stats.failed).toBe(2)
    expect(stats.runs).toEqual([
      expect.objectContaining({ date: '2026-10-01', passed: 2, failed: 2 }),
    ])

    const trends = db.getSuiteTrends('s_seven')
    expect(trends.totalRuns).toBe(7)
    expect(trends.passRate).toBeCloseTo(2 / 4)
    expect(trends.daily).toEqual([
      expect.objectContaining({ date: '2026-10-01', passed: 2, failed: 2, total: 7 }),
    ])

    const [platform] = db.getInsightsBreakdown('platform')
    expect(platform).toMatchObject({ key: 'web', runs: 7, passed: 2, failed: 2 })
    expect(platform!.passRate).toBeCloseTo(2 / 4)
  })

  it('the insights flaky count reads the stored healed word', () => {
    seedRun('passed', { name: 'Checkout flow' })
    seedRun('healed', { name: 'Checkout flow' })
    seedRun('failed', { name: 'Checkout flow' })

    const stats = db.getStats()
    expect(stats.flaky).toBe(1)
    expect(stats.flakeRate).toBeCloseTo(1 / 3)
    expect(stats.runs).toEqual([expect.objectContaining({ healed: 1 })])

    const [checkout] = db.getInsightsBreakdown('test')
    expect(checkout).toMatchObject({ key: 'Checkout flow', runs: 3 })
    expect(checkout!.flakeRate).toBeCloseTo(1 / 3)
    expect(checkout!.passRate).toBeCloseTo(2 / 3)
  })
})

describe('the runs status filter', () => {
  it('repeated status parameters list every run in any of those words', async () => {
    const ids = seedSevenWords()
    const finishedIds = FINISHED.map((word) => ids[word]).sort()

    expect(db.getRuns({ statuses: FINISHED }).map((run) => run.id).sort()).toEqual(finishedIds)

    const origin = await startDashboard()
    const query = FINISHED.map((word) => `status=${word}`).join('&')
    const { status, body } = await getJson(`${origin}/api/runs?${query}`)
    expect(status).toBe(200)
    expect(body.total).toBe(5)
    expect((body.runs as Array<{ id: string }>).map((run) => run.id).sort()).toEqual(finishedIds)
  })

  it('one status parameter lists that word only', async () => {
    const ids = seedSevenWords()

    const origin = await startDashboard()
    const { status, body } = await getJson(`${origin}/api/runs?status=healed`)
    expect(status).toBe(200)
    expect(body.total).toBe(1)
    expect((body.runs as Array<{ id: string; status: string }>).map((run) => [run.id, run.status])).toEqual([
      [ids.healed, 'healed'],
    ])
  })

  it('an unknown status word is refused with 400', async () => {
    seedSevenWords()

    const origin = await startDashboard()
    const { status, body } = await getJson(`${origin}/api/runs?status=passed&status=flaky`)
    expect(status).toBe(400)
    expect(body).toEqual({ error: 'Unknown run status: flaky.' })
  })
})

describe('members on run history rows', () => {
  it('each run row lists its members with their test ids, paths, suites and outcomes', async () => {
    const id = seedRun('failed', { id: 'run_three', name: 'A · B +1 more' })
    db.upsertRunMember({ runId: id, testIndex: 2, testId: 't_c', name: 'C', filePath: 'tests/c.yaml', outcome: 'healed' })
    db.upsertRunMember({ runId: id, testIndex: 0, testId: 't_a', name: 'A', filePath: 'tests/a.yaml', suiteId: 's_one', outcome: 'passed' })
    db.upsertRunMember({ runId: id, testIndex: 1, testId: 't_b', name: 'B', filePath: 'tests/b.yaml', suiteId: 's_one', outcome: 'failed' })

    const origin = await startDashboard()
    const { status, body } = await getJson(`${origin}/api/runs`)
    expect(status).toBe(200)
    expect(rowOf(body, id).members).toEqual([
      { testIndex: 0, testId: 't_a', filePath: 'tests/a.yaml', suiteId: 's_one', name: 'A', outcome: 'passed' },
      { testIndex: 1, testId: 't_b', filePath: 'tests/b.yaml', suiteId: 's_one', name: 'B', outcome: 'failed' },
      { testIndex: 2, testId: 't_c', filePath: 'tests/c.yaml', suiteId: null, name: 'C', outcome: 'healed' },
    ])
  })

  it('a running member with no outcome reads null', async () => {
    const id = seedRun('running', { id: 'run_live', name: 'A · B' })
    db.upsertRunMember({ runId: id, testIndex: 0, testId: 't_a', name: 'A', filePath: 'tests/a.yaml', outcome: 'passed' })
    db.upsertRunMember({ runId: id, testIndex: 1, testId: 't_b', name: 'B', filePath: 'tests/b.yaml' })

    const origin = await startDashboard()
    const { body } = await getJson(`${origin}/api/runs?status=running`)
    expect(rowOf(body, id).members).toEqual([
      { testIndex: 0, testId: 't_a', filePath: 'tests/a.yaml', suiteId: null, name: 'A', outcome: 'passed' },
      { testIndex: 1, testId: 't_b', filePath: 'tests/b.yaml', suiteId: null, name: 'B', outcome: null },
    ])
  })

  it("a page of runs is listed with every run's members", async () => {
    const count = 450
    for (let index = 0; index < count; index++) {
      const id = seedRun('passed', {
        id: `run_page-${String(index).padStart(3, '0')}`,
        startedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index)).toISOString(),
      })
      db.upsertRunMember({ runId: id, testIndex: 0, testId: `t_${String(index)}`, name: `T${String(index)}`, outcome: 'passed' })
    }

    const all = db.getRuns()
    expect(all).toHaveLength(count)
    for (const run of all) {
      expect(run.members?.map((member) => member.testId)).toEqual([`t_${String(Number(run.id.slice(-3)))}`])
    }

    const origin = await startDashboard()
    const { body } = await getJson(`${origin}/api/runs?limit=200&offset=0`)
    expect(body.total).toBe(count)
    const page = body.runs as Array<{ id: string; members?: Member[] }>
    expect(page).toHaveLength(200)
    for (const run of page) {
      expect(run.members?.map((member) => member.testId)).toEqual([`t_${String(Number(run.id.slice(-3)))}`])
    }
  })
})

describe('suite history', () => {
  it("a run spanning two suites is listed under each suite's history", async () => {
    const spanning = seedRun('failed', { id: 'run_two-suites', name: 'One · Two', startedAt: '2026-10-01T11:00:00.000Z' })
    db.upsertRunMember({ runId: spanning, testIndex: 0, testId: 't_a', name: 'A', suiteId: 's_one', suiteName: 'One', outcome: 'passed' })
    db.upsertRunMember({ runId: spanning, testIndex: 1, testId: 't_a', name: 'A', suiteId: 's_two', suiteName: 'Two', outcome: 'failed' })
    const single = seedRun('passed', { id: 'run_one-suite', name: 'One', suiteId: 's_one', startedAt: '2026-10-01T10:00:00.000Z' })
    db.upsertRunMember({ runId: single, testIndex: 0, testId: 't_a', name: 'A', suiteId: 's_one', suiteName: 'One', outcome: 'passed' })
    seedRun('passed', { id: 'run_no-suite', name: 'A', testId: 't_a' })

    expect(db.getRunsBySuiteId('s_one').map((run) => run.id)).toEqual([spanning, single])
    expect(db.getRunsBySuiteIdCount('s_one')).toBe(2)
    expect(db.getRunsBySuiteId('s_two').map((run) => run.id)).toEqual([spanning])
    expect(db.getRunsBySuiteIdCount('s_two')).toBe(1)

    const origin = await startDashboard(writeSuiteWorkspace([
      { suiteId: 's_one', name: 'One' },
      { suiteId: 's_two', name: 'Two' },
    ]))
    const one = await getJson(`${origin}/api/analytics/suites/s_one`)
    expect(one.status).toBe(200)
    expect(one.body.total).toBe(2)
    expect((one.body.runs as Array<{ id: string }>).map((run) => run.id)).toEqual([spanning, single])
    expect(one.body.trends).toMatchObject({ totalRuns: 2 })
    const two = await getJson(`${origin}/api/analytics/suites/s_two`)
    expect(two.status).toBe(200)
    expect(two.body.total).toBe(1)
    expect((two.body.runs as Array<{ id: string }>).map((run) => run.id)).toEqual([spanning])
    expect(two.body.trends).toMatchObject({ totalRuns: 1, passRate: 0 })
  })
})

function seedMemberRun(
  id: string,
  status: string,
  startedAt: string,
  members: ReadonlyArray<{ testId: string | null; name: string; filePath: string; outcome?: string }>,
): string {
  const runId = seedRun(status, {
    id,
    name: members.length === 1 ? members[0]!.name : members.map((member) => member.name).join(' · '),
    startedAt,
    ...(members.length === 1 && members[0]!.testId ? { testId: members[0]!.testId, filePath: members[0]!.filePath } : {}),
  })
  for (const [testIndex, member] of members.entries()) {
    db.upsertRunMember({
      runId,
      testIndex,
      ...(member.testId ? { testId: member.testId } : {}),
      name: member.name,
      filePath: member.filePath,
      ...(member.outcome ? { outcome: member.outcome } : {}),
    })
  }
  return runId
}

const A = { testId: 't_a', name: 'A', filePath: 'tests/a.yaml' }
const B = { testId: 't_b', name: 'B', filePath: 'tests/b.yaml' }
const C = { testId: 't_c', name: 'C', filePath: 'tests/c.yaml' }

describe('the test viewer', () => {
  it('the test viewer lists every run that ran the test, with that member\'s outcome', async () => {
    const multi = seedMemberRun('run_abc', 'failed', '2026-10-01T10:00:00.000Z', [
      { ...A, outcome: 'passed' },
      { ...B, outcome: 'failed' },
      { ...C, outcome: 'passed' },
    ])
    const single = seedMemberRun('run_b', 'passed', '2026-10-01T11:00:00.000Z', [{ ...B, outcome: 'passed' }])
    seedMemberRun('run_a', 'passed', '2026-10-01T12:00:00.000Z', [{ ...A, outcome: 'passed' }])

    const origin = await startDashboard()
    const { status, body } = await getJson(`${origin}/api/analytics/tests/B?testId=t_b`)
    expect(status).toBe(200)
    expect(body.name).toBe('B')
    expect(body.total).toBe(2)
    expect((body.runs as Array<{ id: string; memberOutcome: string | null }>).map((run) => [run.id, run.memberOutcome]))
      .toEqual([[single, 'passed'], [multi, 'failed']])
  })

  it('pass rate and trends count member outcomes', async () => {
    seedMemberRun('run_ab', 'cancelled', '2026-10-01T10:00:00.000Z', [
      { ...A, outcome: 'passed' },
      { ...B, outcome: 'timeout' },
    ])
    seedMemberRun('run_b', 'passed', '2026-10-01T11:00:00.000Z', [{ ...B, outcome: 'passed' }])

    const trends = db.getTestTrends({ testId: 't_b' })
    expect(trends).toMatchObject({ totalRuns: 2, passRate: 0.5 })
    expect(trends.daily).toEqual([expect.objectContaining({ date: '2026-10-01', passed: 1, failed: 1, total: 2 })])

    const origin = await startDashboard()
    const { status, body } = await getJson(`${origin}/api/analytics/tests/B?testId=t_b`)
    expect(status).toBe(200)
    expect(body.trends).toMatchObject({ totalRuns: 2, passRate: 0.5 })
    expect(body.trends.daily).toEqual([expect.objectContaining({ passed: 1, failed: 1, total: 2 })])
    expect(body.flakyScore).toBe(1)
  })

  it('a test is found by its path when no id is given', async () => {
    const multi = seedMemberRun('run_ab', 'failed', '2026-10-01T10:00:00.000Z', [
      { ...A, outcome: 'passed' },
      { testId: null, name: 'B', filePath: 'tests/b.yaml', outcome: 'failed' },
    ])
    const single = seedMemberRun('run_b', 'passed', '2026-10-01T11:00:00.000Z', [{ ...B, outcome: 'passed' }])
    seedMemberRun('run_other', 'passed', '2026-10-01T12:00:00.000Z', [
      { testId: 't_b2', name: 'B', filePath: 'tests/other/b.yaml', outcome: 'passed' },
    ])

    expect(db.getRunsByTestCount({ filePath: 'tests/b.yaml' })).toBe(2)

    const origin = await startDashboard()
    const { status, body } = await getJson(`${origin}/api/analytics/tests/B?filePath=${encodeURIComponent('tests/b.yaml')}`)
    expect(status).toBe(200)
    expect(body.total).toBe(2)
    expect((body.runs as Array<{ id: string; memberOutcome: string | null }>).map((run) => [run.id, run.memberOutcome]))
      .toEqual([[single, 'passed'], [multi, 'failed']])
  })

  it('a request naming neither a test id nor a path is refused with 400', async () => {
    seedMemberRun('run_b', 'passed', '2026-10-01T11:00:00.000Z', [{ ...B, outcome: 'passed' }])

    const origin = await startDashboard()
    const { status, body } = await getJson(`${origin}/api/analytics/tests/B`)
    expect(status).toBe(400)
    expect(body).toEqual({ error: 'testId or filePath is required' })
  })

  it('flaky tests are grouped by member file path and count healed as a pass', async () => {
    const outcomes = ['passed', 'failed', 'healed', 'failed'] as const
    for (const [index, outcome] of outcomes.entries()) {
      seedMemberRun(`run_flaky-${String(index)}`, outcome, `2026-10-0${String(index + 1)}T10:00:00.000Z`, [
        { ...A, outcome: 'passed' },
        { ...B, name: index === outcomes.length - 1 ? 'B' : 'B (old name)', outcome },
      ])
    }
    seedMemberRun('run_flaky-cancelled', 'cancelled', '2026-10-09T10:00:00.000Z', [{ ...B, outcome: 'cancelled' }])
    seedMemberRun('run_flaky-skipped', 'passed', '2026-10-09T11:00:00.000Z', [{ ...B, outcome: 'skipped' }])

    const origin = await startDashboard()
    const { status, body } = await getJson(`${origin}/api/analytics/tests?minRuns=3`)
    expect(status).toBe(200)
    const tests = body.tests as Array<{ name: string; filePath: string; totalRuns: number; passRate: number; flakyScore: number; isFlaky: boolean }>
    expect(tests.map((test) => test.filePath).sort()).toEqual(['tests/a.yaml', 'tests/b.yaml'])
    expect(tests.find((test) => test.filePath === 'tests/b.yaml')).toEqual({
      name: 'B',
      filePath: 'tests/b.yaml',
      totalRuns: 4,
      passRate: 0.5,
      flakyScore: 1,
      isFlaky: true,
    })
    expect(tests.find((test) => test.filePath === 'tests/a.yaml')).toMatchObject({
      name: 'A',
      totalRuns: 4,
      passRate: 1,
      flakyScore: 0,
      isFlaky: false,
    })
  })
})

const RATED = { testId: 't_rate', name: 'Rate', filePath: 'tests/rate.yaml' }

describe('pass rate', () => {
  it("a test's rate counts only pass and fail member outcomes", async () => {
    const outcomes: ReadonlyArray<[string, string | undefined]> = [
      ['passed', 'passed'],
      ['healed', 'healed'],
      ['timeout', 'timeout'],
      ['cancelled', 'cancelled'],
      ['cancelled', 'skipped'],
      ['running', undefined],
    ]
    for (const [index, [status, outcome]] of outcomes.entries()) {
      seedMemberRun(`run_rate-${String(index)}`, status, `2026-10-01T1${String(index)}:00:00.000Z`, [
        { ...RATED, ...(outcome === undefined ? {} : { outcome }) },
      ])
    }

    const trends = db.getTestTrends({ testId: RATED.testId })
    expect(trends.totalRuns).toBe(6)
    expect(trends.passRate).toBeCloseTo(2 / 3)
    expect(trends.daily).toEqual([expect.objectContaining({ date: '2026-10-01', passed: 2, failed: 1, total: 6 })])

    const origin = await startDashboard()
    const { status, body } = await getJson(`${origin}/api/analytics/tests/Rate?testId=${RATED.testId}`)
    expect(status).toBe(200)
    expect(body.trends).toEqual(JSON.parse(JSON.stringify(trends)))
    expect(body.trends.passRate).toBeCloseTo(2 / 3)
  })

  it('a test with no pass or fail outcome has no rate', async () => {
    const outcomes: ReadonlyArray<[string, string | undefined]> = [
      ['cancelled', 'cancelled'],
      ['cancelled', 'skipped'],
      ['running', undefined],
    ]
    for (const [index, [status, outcome]] of outcomes.entries()) {
      seedMemberRun(`run_unrated-${String(index)}`, status, `2026-10-01T1${String(index)}:00:00.000Z`, [
        { ...RATED, ...(outcome === undefined ? {} : { outcome }) },
      ])
    }

    const trends = db.getTestTrends({ testId: RATED.testId })
    expect(trends.totalRuns).toBe(3)
    expect(trends.passRate).toBeNull()

    const origin = await startDashboard()
    const { status, body } = await getJson(`${origin}/api/analytics/tests/Rate?testId=${RATED.testId}`)
    expect(status).toBe(200)
    expect(body.trends.totalRuns).toBe(3)
    expect(body.trends.passRate === null, `trends.passRate is ${JSON.stringify(body.trends.passRate)}`).toBe(true)
  })

  it("a suite's rate leaves cancelled and live runs out", () => {
    for (const [index, status] of ['passed', 'failed', 'cancelled', 'running'].entries()) {
      const id = seedRun(status, {
        id: `run_suite-rate-${status}`,
        name: 'Rated suite',
        startedAt: `2026-10-01T1${String(index)}:00:00.000Z`,
        suiteId: 's_rate',
      })
      db.upsertRunMember({
        runId: id,
        testIndex: 0,
        testId: RATED.testId,
        name: RATED.name,
        filePath: RATED.filePath,
        suiteId: 's_rate',
        ...(status === 'running' ? {} : { outcome: status }),
      })
    }

    const trends = db.getSuiteTrends('s_rate')
    expect(trends.totalRuns).toBe(4)
    expect(trends.passRate).toBeCloseTo(1 / 2)
  })

  it('the insights breakdown rates a group over its passed and failed runs only', async () => {
    for (const [index, status] of ['passed', 'failed', 'cancelled', 'running'].entries()) {
      seedRun(status, { id: `run_rated-${status}`, name: 'Rated', startedAt: `2026-10-01T1${String(index)}:00:00.000Z` })
    }
    for (const [index, status] of ['cancelled', 'pending'].entries()) {
      seedRun(status, { id: `run_unrated-${status}`, name: 'Unrated', startedAt: `2026-10-02T1${String(index)}:00:00.000Z` })
    }

    const rows = db.getInsightsBreakdown('test')
    expect(rows.map((row) => row.key)).toEqual(['Rated', 'Unrated'])
    expect(rows[0]).toMatchObject({ key: 'Rated', runs: 4, passed: 1, failed: 1 })
    expect(rows[0]!.passRate).toBeCloseTo(1 / 2)
    expect(rows[1]).toMatchObject({ key: 'Unrated', runs: 2, passed: 0, failed: 0 })
    expect(rows[1]!.passRate).toBeNull()

    const origin = await startDashboard()
    const { status, body } = await getJson(`${origin}/api/analytics/breakdowns?dimension=test`)
    expect(status).toBe(200)
    expect(body.rows).toEqual(JSON.parse(JSON.stringify(rows)))
    expect(body.rows[1].passRate === null, `the Unrated row's passRate is ${JSON.stringify(body.rows[1]?.passRate)}`).toBe(true)
  })
})
