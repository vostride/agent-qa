import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveWorkspacePaths } from '@vostride/agent-qa-core'

import { DashboardDatabase } from '../db/database.js'
import type { ExecutionBackend } from '../execution/execution-backend.js'
import { extractTestFileMetadata } from '../tests/test-file-manager.js'
import { startServer } from '../server/server.js'

// The batch read the list pages use must agree with each row's viewer at 200 runs and past 200.

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
  dir = mkdtempSync(join(tmpdir(), 'agent-qa-444-rate-window-'))
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

type Answer = { status: number; body: any }

async function read(url: string): Promise<Answer> {
  const response = await fetch(url)
  const type = response.headers.get('content-type') ?? ''
  return { status: response.status, body: type.includes('application/json') ? await response.json() : await response.text() }
}

function batchRow(answer: Answer, key: 'tests' | 'suites', path: string): any {
  const rows = answer.body !== null && typeof answer.body === 'object' && Array.isArray(answer.body[key])
    ? (answer.body[key] as Array<{ path: string }>)
    : null
  const row = rows?.find((candidate) => candidate.path === path)
  expect(row, `the ${key} batch read (status ${String(answer.status)}) names ${path}`).toBeDefined()
  return row
}

const TESTS = {
  A: { file: 'tests/window-a.yaml', name: 'Window A', testId: 't_window_a' },
  B: { file: 'tests/window-b.yaml', name: 'Window B', testId: 't_window_b' },
  C: { file: 'tests/window-c.yaml', name: 'Window C', testId: 't_window_c' },
  D: { file: 'tests/window-d.yaml', name: 'Window D', testId: 't_window_d' },
  E: { file: 'tests/window-e.yaml', name: 'Window E', testId: 't_window_e' },
} as const
type TestKey = keyof typeof TESTS

const SUITES = {
  s_window: { file: 'suites/window.suite.yaml', name: 'Window suite', test: 'A' },
  s_unrated: { file: 'suites/unrated.suite.yaml', name: 'Unrated suite', test: 'C' },
  s_old: { file: 'suites/old.suite.yaml', name: 'Old suite', test: 'E' },
  s_idle: { file: 'suites/idle.suite.yaml', name: 'Idle suite', test: 'D' },
} as const
type SuiteId = keyof typeof SUITES

const E_RUN_CONTENT = ['name: Window E', 'test-id: t_window_e', 'target: staging', 'steps: []', ''].join('\n')

type Seeded = { testId: string; filePath: string; name: string }

interface RateWindow {
  origin: string
  tests: Record<TestKey, Seeded>
  secondOne: string[]
  secondTwo: string[]
  secondThree: string[]
  eRun: string
  aPasses: string[]
  addSecondThree: () => Promise<void>
}

const clockSecond = (): string => new Date().toISOString().slice(0, 19).replace('T', ' ')

async function waitPastSecond(ids: string[]): Promise<void> {
  const newest = ids.map((id) => db.getRun(id)!.createdAt).sort().at(-1)!
  const deadline = Date.now() + 3000
  while (clockSecond() <= newest) {
    if (Date.now() > deadline) {
      throw new Error(`the clock did not pass the seeded second ${newest} within 3 s (now ${clockSecond()})`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function seedRateWindow(): Promise<RateWindow> {
  mkdirSync(join(dir, 'tests'), { recursive: true })
  mkdirSync(join(dir, 'suites'), { recursive: true })
  for (const test of Object.values(TESTS)) {
    writeFileSync(join(dir, test.file), [`name: ${test.name}`, `test-id: ${test.testId}`, 'steps: []', ''].join('\n'))
  }
  for (const [suiteId, suite] of Object.entries(SUITES)) {
    const test = TESTS[suite.test]
    writeFileSync(
      join(dir, suite.file),
      [`suite-id: ${suiteId}`, `name: ${suite.name}`, 'tests:', `  - test: ${test.file}`, `    id: ${test.testId}`, ''].join('\n'),
    )
  }
  const workspacePaths = resolveWorkspacePaths({
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
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  const handle = await startServer({
    declaredSecretMask: (text) => text,
    db: new DashboardDatabase({ dbPath }),
    port: 0,
    configPath,
    workspacePaths,
    executionBackend: new IdleBackend() as unknown as ExecutionBackend,
  })
  started.push(handle)
  const origin = `http://127.0.0.1:${String((handle.server.address() as AddressInfo).port)}`

  const listed = await read(`${origin}/api/tests`)
  expect(listed.status, 'GET /api/tests').toBe(200)
  const files = listed.body.files as Array<{ path: string; name: string; testId: string | null }>
  const tests = {} as Record<TestKey, Seeded>
  for (const [key, test] of Object.entries(TESTS) as Array<[TestKey, (typeof TESTS)[TestKey]]>) {
    const file = files.find((candidate) => candidate.path === test.file)
    expect(file, `GET /api/tests lists ${test.file}`).toBeDefined()
    expect(file!.testId, `${test.file}'s test id`).toBe(test.testId)
    tests[key] = { testId: file!.testId!, filePath: file!.path, name: file!.name }
  }

  let minute = 0
  const nextStart = (): string => new Date(Date.UTC(2026, 9, 1, 0, minute++)).toISOString()
  const seed = (
    status: string,
    members: ReadonlyArray<{ test: TestKey; outcome: string; suiteId?: SuiteId }>,
    extra: { platform?: string; testFileContent?: string } = {},
  ): string => {
    const startedAt = nextStart()
    const id = db.insertRun({
      name: members.map((member) => tests[member.test].name).join(' · '),
      status,
      duration: 1000,
      startedAt,
      endedAt: startedAt,
      ...extra,
    })
    for (const [testIndex, member] of members.entries()) {
      db.upsertRunMember({
        runId: id,
        testIndex,
        testId: tests[member.test].testId,
        name: tests[member.test].name,
        filePath: tests[member.test].filePath,
        outcome: member.outcome,
        ...(member.suiteId ? { suiteId: member.suiteId, suiteName: SUITES[member.suiteId].name } : {}),
      })
    }
    return id
  }

  expect(extractTestFileMetadata(E_RUN_CONTENT).targetName, "E's run content names its target").toBe('staging')

  // Second 1: ten failures of A in s_window; the newest also carries E's only run, in s_old.
  const secondOne: string[] = []
  for (let index = 0; index < 9; index++) {
    secondOne.push(seed('failed', [{ test: 'A', outcome: 'failed', suiteId: 's_window' }]))
  }
  const eRun = seed(
    'failed',
    [{ test: 'A', outcome: 'failed', suiteId: 's_window' }, { test: 'E', outcome: 'passed', suiteId: 's_old' }],
    { platform: 'android', testFileContent: E_RUN_CONTENT },
  )
  secondOne.push(eRun)
  await waitPastSecond(secondOne)

  // Second 2: A's five passes, C's two runs and 183 passes of B, which make exactly 200 runs.
  const secondTwo: string[] = []
  const aPasses: string[] = []
  for (let index = 0; index < 190; index++) {
    if (index % 40 === 5) {
      const id = seed('passed', [{ test: 'A', outcome: 'passed', suiteId: 's_window' }])
      aPasses.push(id)
      secondTwo.push(id)
    } else if (index === 100) {
      secondTwo.push(seed('cancelled', [{ test: 'C', outcome: 'cancelled', suiteId: 's_unrated' }]))
    } else if (index === 150) {
      secondTwo.push(seed('cancelled', [{ test: 'B', outcome: 'cancelled' }, { test: 'C', outcome: 'skipped' }]))
    } else {
      secondTwo.push(seed('passed', [{ test: 'B', outcome: 'passed' }]))
    }
  }
  expect(aPasses, "A's passes in second 2").toHaveLength(5)
  await waitPastSecond(secondTwo)

  const secondThree: string[] = []
  return {
    origin,
    tests,
    secondOne,
    secondTwo,
    secondThree,
    eRun,
    aPasses,
    addSecondThree: async () => {
      for (let index = 0; index < 10; index++) secondThree.push(seed('passed', [{ test: 'B', outcome: 'passed' }]))
    },
  }
}

type PageRun = {
  id: string
  status: string
  platform: string
  targetName: string | null
  members?: Array<{ testId: string | null; filePath: string | null; suiteId: string | null; outcome: string | null }>
}

// The precondition every cell asserts first: what the 200-run page holds at each checkpoint.
async function windowAt(window: RateWindow, total: 200 | 210): Promise<PageRun[]> {
  const page = await read(`${window.origin}/api/runs?limit=200`)
  expect(page.status, 'GET /api/runs?limit=200').toBe(200)
  expect(page.body.total, 'the workspace run count').toBe(total)
  const runs = page.body.runs as PageRun[]
  expect(runs, 'the 200-run page').toHaveLength(200)

  const created = (ids: string[]) => ids.map((id) => db.getRun(id)!.createdAt).sort()
  const [one, two, three] = [created(window.secondOne), created(window.secondTwo), created(window.secondThree)]
  expect(one.at(-1)! < two[0]!, `second 1 (${one.at(-1)!}) is before second 2 (${two[0]!})`).toBe(true)
  if (three.length > 0) {
    expect(two.at(-1)! < three[0]!, `second 2 (${two.at(-1)!}) is before second 3 (${three[0]!})`).toBe(true)
  }

  const onPage = new Set(runs.map((run) => run.id))
  expect(window.aPasses.every((id) => onPage.has(id)), "all of A's passes are on the 200-run page").toBe(true)
  if (total === 210) {
    expect(window.secondOne.filter((id) => onPage.has(id)), 'second 1 runs on the 200-run page').toEqual([])
    const named = runs.filter((run) =>
      (run.members ?? []).some((member) => member.testId === window.tests.E.testId || member.suiteId === 's_old'))
    expect(named.map((run) => run.id), 'runs on the 200-run page with a member of E or s_old').toEqual([])
  }
  return runs
}

const PASS = new Set(['passed', 'healed'])
const FAIL = new Set(['failed', 'timeout'])

// For comparison only: the fold the list pages used to make over the 200-run page.
function pageFoldOfTest(runs: PageRun[], test: Seeded): { passed: number; decided: number } {
  let passed = 0
  let decided = 0
  for (const run of runs) {
    const member = (run.members ?? []).find((candidate) => candidate.testId === test.testId || candidate.filePath === test.filePath)
    if (!member?.outcome) continue
    if (PASS.has(member.outcome)) { passed++; decided++ }
    if (FAIL.has(member.outcome)) decided++
  }
  return { passed, decided }
}

function pageFoldOfSuite(runs: PageRun[], suiteId: string): { passed: number; decided: number } {
  let passed = 0
  let decided = 0
  for (const run of runs) {
    if (!(run.members ?? []).some((member) => member.suiteId === suiteId)) continue
    if (PASS.has(run.status)) { passed++; decided++ }
    if (FAIL.has(run.status)) decided++
  }
  return { passed, decided }
}

async function suiteViewer(window: RateWindow, suiteId: string): Promise<any> {
  const viewer = await read(`${window.origin}/api/analytics/suites/${encodeURIComponent(suiteId)}?limit=50`)
  expect(viewer.status, `the ${suiteId} viewer route`).toBe(200)
  return viewer.body
}

async function testViewer(window: RateWindow, test: Seeded): Promise<any> {
  const file = await read(`${window.origin}/api/tests/${encodeURIComponent(test.testId)}`)
  expect(file.status, `GET /api/tests/${test.testId}`).toBe(200)
  const query = `testId=${encodeURIComponent(file.body.testId)}&filePath=${encodeURIComponent(file.body.path)}`
  const viewer = await read(`${window.origin}/api/analytics/tests/${encodeURIComponent(test.name)}?${query}`)
  expect(viewer.status, `the ${test.name} viewer route`).toBe(200)
  return viewer.body
}

function lastRunFields(run: any, withOutcome: boolean): Record<string, unknown> {
  return {
    id: run.id,
    status: run.status,
    startedAt: run.startedAt,
    createdAt: run.createdAt,
    duration: run.duration,
    ...(withOutcome ? { memberOutcome: run.memberOutcome ?? null } : {}),
  }
}

// The batch reads count each class of member and run as their viewers do.
const COUNTING_RUNS = [
  { name: 'healed', status: 'healed', outcome: 'healed' },
  { name: 'timeout', status: 'timeout', outcome: 'timeout' },
  { name: 'bare', status: 'cancelled', outcome: undefined },
  { name: 'cancelled', status: 'cancelled', outcome: 'cancelled' },
  { name: 'running', status: 'running', outcome: undefined },
] as const
const COUNTING_CLASSES = [...COUNTING_RUNS.map((run) => run.name), 'mixed'] as const
type CountingClass = (typeof COUNTING_CLASSES)[number]
// An outcome-less member under a run that counts, with no suite and no mixed member.
const UNRECORDED_RUNS = [
  { name: 'unrecorded-pass', status: 'passed' },
  { name: 'unrecorded-fail', status: 'failed' },
] as const
const UNRECORDED_CLASSES = UNRECORDED_RUNS.map((run) => run.name)
type TestCountingClass = CountingClass | (typeof UNRECORDED_RUNS)[number]['name']

async function seedCountingClasses(): Promise<{ origin: string; tests: Record<TestCountingClass, Seeded> }> {
  mkdirSync(join(dir, 'tests'), { recursive: true })
  mkdirSync(join(dir, 'suites'), { recursive: true })
  for (const name of UNRECORDED_CLASSES) {
    writeFileSync(
      join(dir, 'tests', `count-${name}.yaml`),
      [`name: Count ${name}`, `test-id: t_count_${name}`, 'steps: []', ''].join('\n'),
    )
  }
  for (const name of COUNTING_CLASSES) {
    writeFileSync(
      join(dir, 'tests', `count-${name}.yaml`),
      [`name: Count ${name}`, `test-id: t_count_${name}`, 'steps: []', ''].join('\n'),
    )
    writeFileSync(
      join(dir, 'suites', `count-${name}.suite.yaml`),
      [
        `suite-id: s_count_${name}`,
        `name: Count ${name} suite`,
        'tests:',
        `  - test: tests/count-${name}.yaml`,
        `    id: t_count_${name}`,
        '',
      ].join('\n'),
    )
  }
  const workspacePaths = resolveWorkspacePaths({
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
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  const handle = await startServer({
    declaredSecretMask: (text) => text,
    db: new DashboardDatabase({ dbPath }),
    port: 0,
    configPath,
    workspacePaths,
    executionBackend: new IdleBackend() as unknown as ExecutionBackend,
  })
  started.push(handle)
  const origin = `http://127.0.0.1:${String((handle.server.address() as AddressInfo).port)}`

  const listed = await read(`${origin}/api/tests`)
  expect(listed.status, 'GET /api/tests').toBe(200)
  const files = listed.body.files as Array<{ path: string; name: string; testId: string | null }>
  const tests = {} as Record<TestCountingClass, Seeded>
  for (const name of [...COUNTING_CLASSES, ...UNRECORDED_CLASSES]) {
    const file = files.find((candidate) => candidate.path === `tests/count-${name}.yaml`)
    expect(file, `GET /api/tests lists tests/count-${name}.yaml`).toBeDefined()
    expect(file!.testId, `tests/count-${name}.yaml's test id`).toBe(`t_count_${name}`)
    tests[name] = { testId: file!.testId!, filePath: file!.path, name: file!.name }
  }

  for (const [minute, run] of COUNTING_RUNS.entries()) {
    const startedAt = new Date(Date.UTC(2026, 9, 3, 0, minute)).toISOString()
    const id = db.insertRun({
      name: `${tests[run.name].name} · ${tests.mixed.name}`,
      status: run.status,
      duration: 1000,
      startedAt,
      endedAt: startedAt,
    })
    for (const [testIndex, member] of [run.name, 'mixed' as const].entries()) {
      db.upsertRunMember({
        runId: id,
        testIndex,
        testId: tests[member].testId,
        name: tests[member].name,
        filePath: tests[member].filePath,
        suiteId: `s_count_${member}`,
        suiteName: `Count ${member} suite`,
        ...(run.outcome === undefined ? {} : { outcome: run.outcome }),
      })
    }
  }
  for (const [index, run] of UNRECORDED_RUNS.entries()) {
    const startedAt = new Date(Date.UTC(2026, 9, 3, 0, COUNTING_RUNS.length + index)).toISOString()
    const id = db.insertRun({ name: tests[run.name].name, status: run.status, duration: 1000, startedAt, endedAt: startedAt })
    db.upsertRunMember({
      runId: id,
      testIndex: 0,
      testId: tests[run.name].testId,
      name: tests[run.name].name,
      filePath: tests[run.name].filePath,
    })
  }
  return { origin, tests }
}

describe('the list reads agree with the viewers on pass rate and last run', () => {
  it('a test reads one rate from the batch read and from its viewer at 200 runs and past 200', async () => {
    const window = await seedRateWindow()
    const { A, C, D, E } = window.tests

    for (const total of [200, 210] as const) {
      if (total === 210) await window.addSecondThree()
      const page = await windowAt(window, total)

      const viewerA = await testViewer(window, A)
      expect(viewerA.trends.passRate, `A's viewer rate at ${String(total)}`).toBeCloseTo(1 / 3)
      expect(pageFoldOfTest(page, A), `the 200-run page's fold of A at ${String(total)}`)
        .toEqual(total === 200 ? { passed: 5, decided: 15 } : { passed: 5, decided: 5 })
      const viewerC = await testViewer(window, C)
      const viewerD = await testViewer(window, D)
      const viewerE = await testViewer(window, E)
      expect(viewerC.trends.passRate, `C's viewer rate at ${String(total)}`).toBeNull()
      expect(viewerD.trends.passRate, `D's viewer rate at ${String(total)}`).toBeNull()
      expect(viewerE.trends.passRate, `E's viewer rate at ${String(total)}`).toBe(1)

      const batch = await read(`${window.origin}/api/analytics/test-summaries`)
      const rowA = batchRow(batch, 'tests', A.filePath)
      expect(rowA, `A's batch row at ${String(total)}`).toMatchObject({ testId: A.testId, passed: 5, decided: 15 })
      expect(rowA.passRate, `A's batch rate at ${String(total)}`).toBeCloseTo(1 / 3)
      expect(rowA.passRate, `A's batch rate equals its viewer's at ${String(total)}`).toBe(viewerA.trends.passRate)
      expect(batchRow(batch, 'tests', C.filePath), `C at ${String(total)}`).toMatchObject({ passRate: null, passed: 0, decided: 0 })
      expect(batchRow(batch, 'tests', D.filePath), `D at ${String(total)}`).toMatchObject({ passRate: null, passed: 0, decided: 0 })
      expect(batchRow(batch, 'tests', E.filePath), `E at ${String(total)}`).toMatchObject({ passRate: 1, passed: 1, decided: 1 })
      expect(batchRow(batch, 'tests', E.filePath).passRate).toBe(viewerE.trends.passRate)
    }
  })

  it("a test's last run is the first run its viewer lists, even when all its runs are past the 200-run page", async () => {
    const window = await seedRateWindow()
    const { A, B, C, D, E } = window.tests

    for (const total of [200, 210] as const) {
      if (total === 210) await window.addSecondThree()
      await windowAt(window, total)

      const viewers = new Map<Seeded, any>()
      for (const test of [A, B, C, D, E]) viewers.set(test, await testViewer(window, test))
      expect(viewers.get(D).runs, `D's viewer lists no run at ${String(total)}`).toEqual([])
      expect(viewers.get(E).runs[0]?.id, `E's viewer lists its second-1 run first at ${String(total)}`).toBe(window.eRun)
      expect(viewers.get(A).runs[0]?.id, `A's viewer lists its newest pass first at ${String(total)}`).toBe(window.aPasses.at(-1))

      const batch = await read(`${window.origin}/api/analytics/test-summaries`)
      for (const test of [A, B, C, E]) {
        const row = batchRow(batch, 'tests', test.filePath)
        expect(row.lastRun, `${test.name}'s last run at ${String(total)}`).not.toBeNull()
        expect(lastRunFields(row.lastRun, true), `${test.name}'s last run equals its viewer's runs[0] at ${String(total)}`)
          .toEqual(lastRunFields(viewers.get(test).runs[0], true))
      }
      expect(batchRow(batch, 'tests', D.filePath).lastRun, `D's last run at ${String(total)}`).toBeNull()
      expect(batchRow(batch, 'tests', E.filePath).lastRun, `E's last run at ${String(total)}`)
        .toMatchObject({ id: window.eRun, status: 'failed', memberOutcome: 'passed' })
      expect(batchRow(batch, 'tests', A.filePath).lastRun, `A's last run at ${String(total)}`)
        .toMatchObject({ id: window.aPasses.at(-1), status: 'passed', memberOutcome: 'passed' })
    }
  })

  it('a suite reads one rate from the batch read and from its viewer at 200 runs and past 200', async () => {
    const window = await seedRateWindow()

    for (const total of [200, 210] as const) {
      if (total === 210) await window.addSecondThree()
      const page = await windowAt(window, total)

      const viewers = new Map<SuiteId, any>()
      for (const suiteId of Object.keys(SUITES) as SuiteId[]) viewers.set(suiteId, await suiteViewer(window, suiteId))
      expect(viewers.get('s_window').trends.passRate, `s_window's viewer rate at ${String(total)}`).toBeCloseTo(1 / 3)
      expect(pageFoldOfSuite(page, 's_window'), `the 200-run page's fold of s_window at ${String(total)}`)
        .toEqual(total === 200 ? { passed: 5, decided: 15 } : { passed: 5, decided: 5 })
      expect(viewers.get('s_unrated').trends.passRate, `s_unrated's viewer rate at ${String(total)}`).toBeNull()
      expect(viewers.get('s_idle').trends.passRate, `s_idle's viewer rate at ${String(total)}`).toBeNull()
      expect(viewers.get('s_old').trends.passRate, `s_old's viewer rate at ${String(total)}`).toBe(0)

      const batch = await read(`${window.origin}/api/analytics/suite-summaries`)
      const rowWindow = batchRow(batch, 'suites', SUITES.s_window.file)
      expect(rowWindow, `s_window's batch row at ${String(total)}`).toMatchObject({ suiteId: 's_window', passed: 5, decided: 15 })
      expect(rowWindow.passRate, `s_window's batch rate at ${String(total)}`).toBeCloseTo(1 / 3)
      expect(rowWindow.passRate, `s_window's batch rate equals its viewer's at ${String(total)}`)
        .toBe(viewers.get('s_window').trends.passRate)
      for (const suiteId of ['s_unrated', 's_idle'] as const) {
        expect(batchRow(batch, 'suites', SUITES[suiteId].file), `${suiteId} at ${String(total)}`)
          .toMatchObject({ suiteId, passRate: null, passed: 0, decided: 0 })
      }
      const rowOld = batchRow(batch, 'suites', SUITES.s_old.file)
      expect(rowOld, `s_old at ${String(total)}`).toMatchObject({ suiteId: 's_old', passRate: 0, passed: 0, decided: 1 })
      expect(rowOld.passRate, `s_old's batch rate equals its viewer's at ${String(total)}`).toBe(viewers.get('s_old').trends.passRate)
    }
  })

  it("a suite's last run, target and platform come from its own history, even when all its runs are past the 200-run page", async () => {
    const window = await seedRateWindow()
    let pagePlatformOfE: string | undefined

    for (const total of [200, 210] as const) {
      if (total === 210) await window.addSecondThree()
      const page = await windowAt(window, total)
      if (total === 200) {
        const eOnPage = page.find((run) => run.id === window.eRun)
        expect(eOnPage, "E's run on the 200-run page at 200").toBeDefined()
        expect(eOnPage!.targetName, "the target GET /api/runs gives E's run").toBe('staging')
        pagePlatformOfE = eOnPage!.platform
        expect(pagePlatformOfE, "the platform GET /api/runs gives E's run").toBe('android')
      }

      const viewers = new Map<SuiteId, any>()
      for (const suiteId of Object.keys(SUITES) as SuiteId[]) viewers.set(suiteId, await suiteViewer(window, suiteId))
      expect(viewers.get('s_idle').runs, `s_idle's viewer lists no run at ${String(total)}`).toEqual([])
      expect(viewers.get('s_old').runs[0]?.id, `s_old's viewer lists E's run first at ${String(total)}`).toBe(window.eRun)

      const batch = await read(`${window.origin}/api/analytics/suite-summaries`)
      for (const suiteId of ['s_window', 's_unrated', 's_old'] as const) {
        const row = batchRow(batch, 'suites', SUITES[suiteId].file)
        expect(row.lastRun, `${suiteId}'s last run at ${String(total)}`).not.toBeNull()
        expect(lastRunFields(row.lastRun, false), `${suiteId}'s last run equals its viewer's runs[0] at ${String(total)}`)
          .toEqual(lastRunFields(viewers.get(suiteId).runs[0], false))
      }
      expect(batchRow(batch, 'suites', SUITES.s_idle.file), `s_idle at ${String(total)}`)
        .toMatchObject({ lastRun: null, targetName: null, platform: null })
      expect(batchRow(batch, 'suites', SUITES.s_old.file), `s_old's target and platform at ${String(total)}`)
        .toMatchObject({ lastRun: { id: window.eRun, status: 'failed' }, targetName: 'staging', platform: pagePlatformOfE })
    }
  })

  it('with a pass-rate scope configured, each batch read rates a row over the scoped runs its viewer opens on and keeps its last run unscoped', async () => {
    const scopeConfig = (branch: string) => [
      'workspace:',
      '  testMatch:',
      '    - tests/*.yaml',
      '  suiteMatch:',
      '    - suites/*.suite.yaml',
      '  hooksFile: hooks.yaml',
      '  envFile: .env',
      '  secretsFile: .env.secrets.local',
      'use:',
      '  mobile:',
      '    appState: preserve',
      'analytics:',
      '  passRateScope:',
      '    attributes:',
      `      git.branch: ${JSON.stringify(branch)}`,
      '',
    ].join('\n')
    writeFileSync(configPath, scopeConfig('main'))
    mkdirSync(join(dir, 'tests'), { recursive: true })
    mkdirSync(join(dir, 'suites'), { recursive: true })
    writeFileSync(join(dir, 'tests', 'scope-s.yaml'), ['name: Scope S', 'test-id: t_scope_s', 'steps: []', ''].join('\n'))
    writeFileSync(
      join(dir, 'suites', 'scope.suite.yaml'),
      ['suite-id: s_scope', 'name: Scope suite', 'tests:', '  - test: tests/scope-s.yaml', '    id: t_scope_s', ''].join('\n'),
    )
    const workspacePaths = resolveWorkspacePaths({
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
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const handle = await startServer({
      declaredSecretMask: (text) => text,
      db: new DashboardDatabase({ dbPath }),
      port: 0,
      configPath,
      workspacePaths,
      executionBackend: new IdleBackend() as unknown as ExecutionBackend,
    })
    started.push(handle)
    const origin = `http://127.0.0.1:${String((handle.server.address() as AddressInfo).port)}`

    const listed = await read(`${origin}/api/tests`)
    const file = (listed.body.files as Array<{ path: string; name: string; testId: string }>).find((candidate) => candidate.path === 'tests/scope-s.yaml')
    expect(file, 'GET /api/tests lists tests/scope-s.yaml').toBeDefined()
    const scoped: Seeded = { testId: file!.testId, filePath: file!.path, name: file!.name }
    for (const [minute, status, branch] of [[0, 'passed', 'main'], [1, 'failed', 'dev'], [2, 'passed', 'main'], [3, 'failed', 'dev']] as const) {
      const startedAt = new Date(Date.UTC(2026, 9, 2, 0, minute)).toISOString()
      const id = db.insertRun({ name: scoped.name, status, duration: 1000, startedAt, endedAt: startedAt, attributes: { 'git.branch': branch } })
      db.upsertRunMember({
        runId: id,
        testIndex: 0,
        testId: scoped.testId,
        name: scoped.name,
        filePath: scoped.filePath,
        suiteId: 's_scope',
        suiteName: 'Scope suite',
        outcome: status,
      })
    }

    const window = { origin } as RateWindow
    const viewer = await testViewer(window, scoped)
    expect(viewer.scope?.configured, "the test viewer's scope is configured").toBe(true)
    expect(viewer.trends.passRate, "the test viewer's all-runs rate").toBe(0.5)
    expect(viewer.scopedTrends?.passRate, "the test viewer's scoped rate").toBe(1)
    expect(viewer.runs[0]?.id, "the viewer's newest run differs from its newest scoped run").not.toBe(viewer.scopedRuns?.[0]?.id)
    const suite = await read(`${origin}/api/analytics/suites/s_scope?limit=50`)
    expect(suite.status, 'the s_scope viewer route').toBe(200)
    expect(suite.body.scopedTrends?.passRate, "the suite viewer's scoped rate").toBe(1)
    expect(suite.body.trends.passRate, "the suite viewer's all-runs rate").toBe(0.5)

    const tests = await read(`${origin}/api/analytics/test-summaries`)
    const testRow = batchRow(tests, 'tests', scoped.filePath)
    expect(testRow, "S's batch row reads its viewer's scoped figure").toMatchObject({ passRate: 1, passed: 2, decided: 2 })
    expect(testRow.passRate).toBe(viewer.scopedTrends.passRate)
    expect(lastRunFields(testRow.lastRun, true), "S's last run is its viewer's unscoped runs[0]")
      .toEqual(lastRunFields(viewer.runs[0], true))
    const suites = await read(`${origin}/api/analytics/suite-summaries`)
    const suiteRow = batchRow(suites, 'suites', 'suites/scope.suite.yaml')
    expect(suiteRow, "s_scope's batch row reads its viewer's scoped figure").toMatchObject({ passRate: 1, passed: 2, decided: 2 })
    expect(suiteRow.passRate).toBe(suite.body.scopedTrends.passRate)
    expect(lastRunFields(suiteRow.lastRun, false), "s_scope's last run is its viewer's unscoped runs[0]")
      .toEqual(lastRunFields(suite.body.runs[0], false))

    writeFileSync(configPath, scopeConfig(''))
    const query = `testId=${encodeURIComponent(scoped.testId)}&filePath=${encodeURIComponent(scoped.filePath)}`
    const refused = await read(`${origin}/api/analytics/tests/${encodeURIComponent(scoped.name)}?${query}`)
    expect(refused.status, 'the test viewer refuses the empty scope value').toBe(400)
    expect(refused.body.error, "the test viewer's refusal").toMatch(/passRateScope/)
    const refusedSuite = await read(`${origin}/api/analytics/suites/s_scope?limit=50`)
    expect(refusedSuite, 'the suite viewer refuses it the same way').toEqual(refused)
    expect(await read(`${origin}/api/analytics/test-summaries`), 'the test batch read refuses it the same way').toEqual(refused)
    expect(await read(`${origin}/api/analytics/suite-summaries`), 'the suite batch read refuses it the same way').toEqual(refused)
  })

  it('the test batch read counts a healed member as a pass and a timed-out one as a fail, and a cancelled, a still-running and an outcome-less member in neither, as its viewer does', async () => {
    const { origin, tests } = await seedCountingClasses()
    const expected: Record<TestCountingClass, { figures: object; lastRun: object }> = {
      'unrecorded-pass': { figures: { passRate: null, passed: 0, decided: 0 }, lastRun: { status: 'passed', memberOutcome: null } },
      'unrecorded-fail': { figures: { passRate: null, passed: 0, decided: 0 }, lastRun: { status: 'failed', memberOutcome: null } },
      healed: { figures: { passRate: 1, passed: 1, decided: 1 }, lastRun: { status: 'healed', memberOutcome: 'healed' } },
      timeout: { figures: { passRate: 0, passed: 0, decided: 1 }, lastRun: { status: 'timeout', memberOutcome: 'timeout' } },
      bare: { figures: { passRate: null, passed: 0, decided: 0 }, lastRun: { status: 'cancelled', memberOutcome: null } },
      cancelled: { figures: { passRate: null, passed: 0, decided: 0 }, lastRun: { status: 'cancelled', memberOutcome: 'cancelled' } },
      running: { figures: { passRate: null, passed: 0, decided: 0 }, lastRun: { status: 'running', memberOutcome: null } },
      mixed: { figures: { passRate: 0.5, passed: 1, decided: 2 }, lastRun: { status: 'running', memberOutcome: null } },
    }

    const batch = await read(`${origin}/api/analytics/test-summaries`)
    const window = { origin } as RateWindow
    for (const name of [...UNRECORDED_CLASSES, ...COUNTING_CLASSES]) {
      const test = tests[name]
      const row = batchRow(batch, 'tests', test.filePath)
      expect(row, `${test.name}'s batch figures`).toMatchObject({ testId: test.testId, ...expected[name].figures })
      expect(row.lastRun, `${test.name}'s batch last run`).toMatchObject(expected[name].lastRun)
      const viewer = await testViewer(window, test)
      expect(row.passRate, `${test.name}'s batch rate equals its viewer's`).toBe(viewer.trends.passRate)
      expect(lastRunFields(row.lastRun, true), `${test.name}'s last run equals its viewer's runs[0]`)
        .toEqual(lastRunFields(viewer.runs[0], true))
    }
  })

  it('the suite batch read counts a healed run as a pass and a timed-out one as a fail, and a cancelled run, a still-running run and a run whose member has no outcome in neither, as its viewer does', async () => {
    const { origin } = await seedCountingClasses()
    const expected: Record<CountingClass, { figures: object; status: string }> = {
      healed: { figures: { passRate: 1, passed: 1, decided: 1 }, status: 'healed' },
      timeout: { figures: { passRate: 0, passed: 0, decided: 1 }, status: 'timeout' },
      bare: { figures: { passRate: null, passed: 0, decided: 0 }, status: 'cancelled' },
      cancelled: { figures: { passRate: null, passed: 0, decided: 0 }, status: 'cancelled' },
      running: { figures: { passRate: null, passed: 0, decided: 0 }, status: 'running' },
      mixed: { figures: { passRate: 0.5, passed: 1, decided: 2 }, status: 'running' },
    }

    const batch = await read(`${origin}/api/analytics/suite-summaries`)
    const window = { origin } as RateWindow
    for (const name of COUNTING_CLASSES) {
      const suiteId = `s_count_${name}`
      const row = batchRow(batch, 'suites', `suites/count-${name}.suite.yaml`)
      expect(row, `${suiteId}'s batch figures`).toMatchObject({ suiteId, ...expected[name].figures })
      expect(row.lastRun?.status, `${suiteId}'s batch last run`).toBe(expected[name].status)
      const viewer = await suiteViewer(window, suiteId)
      expect(row.passRate, `${suiteId}'s batch rate equals its viewer's`).toBe(viewer.trends.passRate)
      expect(lastRunFields(row.lastRun, false), `${suiteId}'s last run equals its viewer's runs[0]`)
        .toEqual(lastRunFields(viewer.runs[0], false))
    }
  })
})
