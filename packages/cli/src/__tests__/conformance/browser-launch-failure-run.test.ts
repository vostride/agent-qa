// A run whose browser never launches is `failed` with the launch cause on both doors.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DashboardDatabase } from '@vostride/agent-qa-dashboard'
import { generateTestId } from '@vostride/agent-qa-ids'
import type { RunEventEnvelope } from '@vostride/agent-qa-schema'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// Each in-process member execution is awaited before the project is removed, because a member's
// finally writes its working-memory flush. The scene waits for each run's post-run work itself.
const inFlight = vi.hoisted(() => ({
  members: [] as Array<Promise<unknown>>,
}))

vi.mock('../../commands/run.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../commands/run.js')>()
  return {
    ...original,
    produceMembersFromPatterns: async (
      ...args: Parameters<typeof original.produceMembersFromPatterns>
    ) => {
      const produced = await original.produceMembersFromPatterns(...args)
      return {
        ...produced,
        executor: (...run: Parameters<typeof produced.executor>) => {
          const execution = produced.executor(...run)
          inFlight.members.push(execution)
          return execution
        },
      }
    },
  }
})

import { CountingTarget } from '../../commands/__tests__/suite-run-fixture.js'
import {
  dashboardDbPath,
  openDashboardScene,
  printedRunIds,
  runStoreEvents,
  runStoreIds,
  spawnCliRun,
  type CliRunOutcome,
} from './run-doors-fixture.js'
import type { PopulatedRunProject } from './populated-run-fixture.js'
import { reserveEphemeralPort, spawnDashboard } from './spawned-chat.js'

const TARGET_NAME = 'launch-target'
const FIRST_TEST_NAME = 'The launch-failure first member'
const SECOND_TEST_NAME = 'The launch-failure second member'
const CELL_BUDGET_MS = 300_000
const LAUNCH_CAUSE = /Browser support missing/u

interface LaunchProject extends PopulatedRunProject {
  readonly noBrowsers: string
  readonly secondTestPath: string
}

const roots: string[] = []
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {})
  while (inFlight.members.length > 0) {
    await Promise.allSettled(inFlight.members.splice(0))
  }
})

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function launchProject(label: string, origin: string, modelBaseUrl: string): LaunchProject {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `agent-qa-${label}-`)))
  roots.push(root)
  mkdirSync(join(root, 'tests'), { recursive: true })
  mkdirSync(join(root, 'suites'), { recursive: true })
  mkdirSync(join(root, 'no-browsers'), { recursive: true })
  mkdirSync(join(root, '.agent-qa'), { recursive: true })
  writeFileSync(join(root, 'agent-qa.config.yaml'), [
    'workspace:',
    '  testMatch:',
    "    - 'tests/**/*.yaml'",
    '  suiteMatch:',
    "    - 'suites/**/*.suite.yaml'",
    '  hooksFile: hooks.yaml',
    '  envFile: .env',
    '  secretsFile: .env.secrets.local',
    'registry:',
    '  targets:',
    `    ${TARGET_NAME}:`,
    '      platform: web',
    `      url: ${origin}/${TARGET_NAME}`,
    '      environment: local',
    '  llms:',
    '    - name: launch-model',
    '      provider: openai-compatible',
    '      model: gpt-4o-mini',
    `      baseURL: ${modelBaseUrl}`,
    'use:',
    '  llm: launch-model',
    '  mobile:',
    '    appState: preserve',
    'services:',
    '  dashboard: {}',
    '',
  ].join('\n'))
  writeFileSync(join(root, 'hooks.yaml'), 'hooks: []\n')
  writeFileSync(join(root, '.env'), '')
  writeFileSync(join(root, '.env.secrets.local'), '')
  const test = (file: string, name: string): { path: string; id: string } => {
    const id = generateTestId()
    writeFileSync(join(root, 'tests', file), [
      `test-id: ${id}`,
      `name: ${name}`,
      `target: ${TARGET_NAME}`,
      'steps:',
      '  - Verify the page says "Example"',
      '',
    ].join('\n'))
    return { path: `tests/${file}`, id }
  }
  const first = test('a-first.test.yaml', FIRST_TEST_NAME)
  const second = test('b-second.test.yaml', SECOND_TEST_NAME)
  return {
    root,
    configPath: join(root, 'agent-qa.config.yaml'),
    agentQaRoot: join(root, '.agent-qa'),
    suitePath: 'suites/none.suite.yaml',
    testPath: first.path,
    testId: first.id,
    noBrowsers: join(root, 'no-browsers'),
    secondTestPath: second.path,
  }
}

async function withTarget(): Promise<CountingTarget> {
  const target = new CountingTarget()
  await target.listen()
  cleanups.push(() => target.close())
  return target
}

/** A model endpoint that takes every request and never answers, so a member that reaches planning stays running. */
async function hangingModel(): Promise<{ baseUrl: string; requests: string[] }> {
  const requests: string[] = []
  const server: Server = createServer((req: IncomingMessage, _res: ServerResponse) => {
    requests.push(req.url ?? '')
  })
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
  cleanups.push(async () => {
    server.closeAllConnections?.()
    await new Promise<void>((closed) => server.close(() => closed()))
  })
  return { baseUrl: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/v1`, requests }
}

function transcript(outcome: CliRunOutcome): string {
  return `exit ${String(outcome.status)}\n--- stdout ---\n${outcome.stdout}\n--- stderr ---\n${outcome.stderr}`
}

function payloadOf<T>(events: RunEventEnvelope[], type: string, testIndex?: number): T | undefined {
  const found = events.find((event) => event.type === type
    && (testIndex === undefined || (event.payload as { testIndex?: number }).testIndex === testIndex))
  return found?.payload as T | undefined
}

interface TestFinished {
  outcome: string
  failureSummary?: string
  recording?: { state?: string; reason?: string }
}

function runRow(dbPath: string, runId: string): { status: string; failureSummary?: string | null } | undefined {
  const db = new DashboardDatabase({ dbPath })
  try {
    const row = db.getRun(runId) as { status: string; failureSummary?: string | null } | undefined
    return row === undefined || row === null ? undefined : { status: row.status, failureSummary: row.failureSummary }
  } finally {
    db.close()
  }
}

function unsettledRuns(project: LaunchProject): string[] {
  const runs = join(project.agentQaRoot, 'runs')
  if (!existsSync(runs)) return []
  return readdirSync(runs).filter((runId) => {
    const events = join(runs, runId, 'events.jsonl')
    return !existsSync(events) || !readFileSync(events, 'utf8').includes('"type":"runFinished"')
  })
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((settle) => setTimeout(settle, 100))
  }
  return check()
}

async function withProcessEnv<T>(values: Record<string, string | undefined>, body: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await body()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

async function trigger(origin: string, file: string): Promise<string> {
  const response = await fetch(`${origin}/api/runs/trigger`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ file }),
  })
  const body = await response.json() as { runId?: string; error?: string }
  expect(body.error, JSON.stringify(body)).toBeUndefined()
  expect(typeof body.runId, JSON.stringify(body)).toBe('string')
  return body.runId!
}

describe('the CLI door', () => {
  let project: LaunchProject
  let outcome: CliRunOutcome
  let runId: string
  let events: RunEventEnvelope[]
  let target: CountingTarget

  beforeAll(async () => {
    target = new CountingTarget()
    await target.listen()
    project = launchProject('cli', target.origin, 'http://127.0.0.1:1/v1')
    outcome = await spawnCliRun(project, ['run', 'tests/**/*.yaml'], { env: { PLAYWRIGHT_BROWSERS_PATH: project.noBrowsers } })
    const storeIds = runStoreIds(project)
    expect(storeIds, `the run store holds exactly one run\n${transcript(outcome)}`).toHaveLength(1)
    runId = storeIds[0]!
    events = runStoreEvents(project, runId)
  }, CELL_BUDGET_MS)

  afterAll(async () => {
    await target?.close()
  })

  it('the CLI door records a launch failure as failed with its cause', () => {
    const text = transcript(outcome)

    const finished = payloadOf<{ aggregateVerdict?: string }>(events, 'runFinished')
    expect(finished?.aggregateVerdict, `nobody cancelled this run\n${text}`).toBe('failed')

    const first = payloadOf<TestFinished>(events, 'testFinished', 0)
    expect(first?.outcome, `the member whose browser never launched\n${JSON.stringify(first)}`).toBe('failed')
    expect(first?.failureSummary ?? '', 'the member names the launch failure').toMatch(LAUNCH_CAUSE)

    const second = payloadOf<TestFinished>(events, 'testFinished', 1)
    expect(second?.outcome, `the member after it is not launched\n${JSON.stringify(second)}`).toBe('skipped')
    expect(second?.failureSummary ?? '', 'the skip names the earlier failure').toContain(FIRST_TEST_NAME)
    expect(second?.failureSummary ?? '', 'the skip names the earlier failure').toMatch(LAUNCH_CAUSE)
    const secondWork = events.filter((event) => (event.payload as { testIndex?: number }).testIndex === 1
      && event.type !== 'testStarted' && event.type !== 'testFinished')
    expect(secondWork.map((event) => event.type), 'the skipped member did no work').toEqual([])

    expect(outcome.status, text).toBe(2)
    expect(`${outcome.stdout}\n${outcome.stderr}`, 'the CLI prints the cause').toMatch(/browser support is not installed/u)
    expect(printedRunIds(`${outcome.stdout}\n${outcome.stderr}`), `the CLI names the run id it recorded\n${text}`).toEqual([runId])
  })

  it('the dashboard row agrees', () => {
    const row = runRow(dashboardDbPath(project), runId)
    expect(row?.status, `the dashboard row\n${JSON.stringify(row)}`).toBe('failed')
    expect(row?.failureSummary ?? '', 'the dashboard row names the cause').toMatch(LAUNCH_CAUSE)
  })

  it('recording stays absent/unavailable', () => {
    for (const testIndex of [0, 1]) {
      const recording = payloadOf<TestFinished>(events, 'testFinished', testIndex)?.recording
      expect(recording?.state, `member ${String(testIndex)} recording ${JSON.stringify(recording)}`).not.toBe('failed')
      if (testIndex === 0 && recording !== undefined) {
        expect(recording).toEqual({ state: 'absent', reason: 'unavailable' })
      }
    }
  })
})

describe('the dashboard door', () => {
  // The shipped `agent-qa dashboard`, spawned with the empty pin in its own environment: Playwright
  // reads `PLAYWRIGHT_BROWSERS_PATH` once, when it is first imported, so a pin set in this process
  // after the door fixture imported it would not reach an in-process launch.
  it('the dashboard door agrees', async () => {
    const target = await withTarget()
    const project = launchProject('dashboard', target.origin, 'http://127.0.0.1:1/v1')
    const dashboard = await spawnDashboard(project.root, project.configPath, await reserveEphemeralPort(), 60_000,
      { CI: 'true', NO_COLOR: '1', PLAYWRIGHT_BROWSERS_PATH: project.noBrowsers })
    cleanups.push(() => dashboard.stop())
    expect(dashboard.ready, `the dashboard started\n${dashboard.stderr()}`).toBe(true)

    const runId = await trigger(dashboard.origin, project.testPath)
    const readRun = async (): Promise<{ status?: string; failureSummary?: string | null; text: string }> => {
      const response = await fetch(`${dashboard.origin}/api/runs/${encodeURIComponent(runId)}`)
      const text = await response.text()
      const body = (() => { try { return JSON.parse(text) as Record<string, unknown> } catch { return {} } })()
      const run = (body['run'] ?? body) as { status?: string; failureSummary?: string | null }
      return { status: run.status, failureSummary: run.failureSummary, text }
    }
    let read = await readRun()
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline && (unsettledRuns(project).length > 0 || runStoreIds(project).length === 0
      || read.status === 'running' || read.status === 'pending')) {
      await new Promise((settle) => setTimeout(settle, 250))
      read = await readRun()
    }
    // The settle reconciliation runs after the run's own terminal events; give it a moment.
    await new Promise((settle) => setTimeout(settle, 1_000))
    read = await readRun()

    const finished = payloadOf<{ aggregateVerdict?: string }>(runStoreEvents(project, runId), 'runFinished')
    const facts = { row: read.status, aggregate: finished?.aggregateVerdict }
    expect(facts, `the settled run\n${read.text}\n${dashboard.stderr()}`).toEqual({ row: 'failed', aggregate: 'failed' })
    expect(read.failureSummary ?? '', 'the row names the cause').toMatch(LAUNCH_CAUSE)
    expect(read.text, 'GET /api/runs/:id carries the cause').toMatch(LAUNCH_CAUSE)
  }, CELL_BUDGET_MS)

  it('an explicit cancel is still cancelled', async () => {
    const target = await withTarget()
    const model = await hangingModel()
    const project = launchProject('cancel', target.origin, model.baseUrl)
    await withProcessEnv({ CI: 'true' }, async () => {
      const scene = await openDashboardScene(project, { dbPath: ':memory:' })
      cleanups.push(() => scene.close())
      const runId = await trigger(scene.origin, project.testPath)
      expect(await waitFor(() => model.requests.length > 0, 150_000), 'the member launched its browser and reached planning').toBe(true)

      const cancel = await fetch(`${scene.origin}/api/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' })
      // A running run's cancel is a stop request, answered 202.
      expect(cancel.status, await cancel.text()).toBe(202)
      expect(await waitFor(() => scene.settled.some((entry) => entry.runId === runId), 120_000), 'the run settles').toBe(true)
      await waitFor(() => unsettledRuns(project).length === 0, 60_000)

      const row = scene.db.getRun(runId) as { status: string } | undefined
      const finished = payloadOf<{ aggregateVerdict?: string }>(runStoreEvents(project, runId), 'runFinished')
      expect({ row: row?.status, aggregate: finished?.aggregateVerdict }).toEqual({ row: 'cancelled', aggregate: 'cancelled' })
    })
  }, CELL_BUDGET_MS)
})
