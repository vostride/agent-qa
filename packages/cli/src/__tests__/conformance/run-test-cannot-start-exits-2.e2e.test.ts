// The one exception to exit equals verdict: a member that cannot start makes the CLI exit 2.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { resolveDashboardDbPath } from '@vostride/agent-qa-dashboard'
import { generateRunId, generateTestId } from '@vostride/agent-qa-ids'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { printedRunIds, refuseWithoutRecordingTools } from './run-doors-fixture.js'
import {
  POPULATED_PASSING_STEP_TEXT,
  POPULATED_TARGET_NAME,
  populatedRunFixtureProject,
  startStubModelServer,
  startTargetPageServer,
  type FixtureServer,
  type PopulatedRunProject,
  type StubModelServer,
} from './populated-run-fixture.js'
import { CLI_ENTRY, cleanupTempRoots, hermeticEnv } from './spawned-chat.js'

const FILE_BUDGET_MS = 300_000
const RUN_BUDGET_MS = 180_000
const FIRST_NAME = 'Exit two first member'
const SECOND_NAME = 'Exit two second member'
const LAUNCH_CAUSE = /^Browser support missing: run /u
const COULD_NOT_START = `Not run: "${FIRST_NAME}" could not start. Browser support missing: run `
const BROWSER_CLOSED = 'The browser closed before this test finished.'

interface Member {
  readonly testIndex?: number
  readonly outcome?: string
  readonly failureSummary?: string
}

interface Scene {
  runId?: string
  exit?: { code: number | null; signal: NodeJS.Signals | null }
  output?: string
  events?: string[]
  verdict?: unknown
  handoff?: { aggregateVerdict?: string; tests?: Member[] }
  finished?: Member[]
  row?: { status: string; failureSummary: string | null }
  running?: Array<{ id: string; status: string }>
  modelRequests?: number
  error?: string
}

const scene: Scene = {}
let model: StubModelServer | undefined
let target: FixtureServer | undefined

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function writeTest(project: PopulatedRunProject, file: string, name: string): void {
  const path = join(project.root, file)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(
    path,
    `name: ${name}\ntest-id: ${generateTestId()}\ntarget: ${POPULATED_TARGET_NAME}\nsteps:\n  - ${POPULATED_PASSING_STEP_TEXT}\n`,
    'utf8',
  )
}

function runDirectory(project: PopulatedRunProject, runId: string): string | undefined {
  const runs = join(project.agentQaRoot, 'runs')
  if (!existsSync(runs)) return undefined
  for (const entry of readdirSync(runs, { withFileTypes: true })) {
    const log = join(runs, entry.name, 'events.jsonl')
    if (!entry.isDirectory() || !existsSync(log)) continue
    const first = readFileSync(log, 'utf8').split('\n').find((line) => line.trim() !== '')
    if (first !== undefined && (JSON.parse(first) as { runId?: string }).runId === runId) return join(runs, entry.name)
  }
  return undefined
}

function readRows(project: PopulatedRunProject, runId: string): Pick<Scene, 'row' | 'running'> {
  const dbPath = resolveDashboardDbPath({ configDir: project.root })
  if (!existsSync(dbPath)) return {}
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5_000 })
  try {
    const row = db.prepare('SELECT status, failure_summary FROM runs WHERE id = ?').get(runId) as
      | { status: string; failure_summary: string | null }
      | undefined
    const running = db.prepare("SELECT id, status FROM runs WHERE status = 'running'").all() as Array<{ id: string; status: string }>
    return {
      ...(row === undefined ? {} : { row: { status: row.status, failureSummary: row.failure_summary } }),
      running,
    }
  } finally {
    db.close()
  }
}

async function drive(): Promise<void> {
  target = await startTargetPageServer()
  model = await startStubModelServer()
  const project = populatedRunFixtureProject('444-exit-two', { modelBaseUrl: model.baseUrl, targetUrl: target.url })
  writeTest(project, 'tests/exit-two/a-first.test.yaml', FIRST_NAME)
  writeTest(project, 'tests/exit-two/b-second.test.yaml', SECOND_NAME)
  const noBrowsers = join(project.root, 'no-browsers')
  mkdirSync(noBrowsers, { recursive: true })
  const runId = generateRunId()
  scene.runId = runId
  const child = spawn(
    process.execPath,
    [CLI_ENTRY, '--config', project.configPath, 'run', 'tests/exit-two/a-first.test.yaml', 'tests/exit-two/b-second.test.yaml'],
    {
      cwd: project.root,
      env: {
        ...hermeticEnv(project.root),
        CI: 'true',
        NO_COLOR: '1',
        PLAYWRIGHT_BROWSERS_PATH: noBrowsers,
        AGENT_QA_RUN_ID: runId,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
  const budget = setTimeout(() => { child.kill('SIGKILL') }, RUN_BUDGET_MS)
  try {
    scene.exit = await new Promise((settle, fail) => {
      child.once('error', fail)
      child.once('close', (code, signal) => { settle({ code, signal }) })
    })
  } finally {
    clearTimeout(budget)
    scene.output = output
  }
  const dir = runDirectory(project, runId)
  if (dir !== undefined) {
    const events = readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n').filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { type: string; payload?: unknown })
    scene.events = events.map((event) => event.type)
    scene.verdict = events.find((event) => event.type === 'verdict')?.payload
    scene.finished = events.filter((event) => event.type === 'testFinished').map((event) => {
      const { testIndex, outcome, failureSummary } = event.payload as Member
      return { testIndex, outcome, failureSummary }
    })
    const handoff = join(dir, 'handoff.json')
    if (existsSync(handoff)) {
      const document = JSON.parse(readFileSync(handoff, 'utf8')) as { aggregateVerdict?: string; tests?: Member[] }
      scene.handoff = {
        ...(document.aggregateVerdict === undefined ? {} : { aggregateVerdict: document.aggregateVerdict }),
        tests: (document.tests ?? []).map(({ testIndex, outcome }) => ({ testIndex, outcome })),
      }
    }
  }
  Object.assign(scene, readRows(project, runId))
  scene.modelRequests = model.requests.length
}

function seen(): string {
  return JSON.stringify(scene, null, 2)
}

describe('a test that cannot start', () => {
  beforeAll(async () => {
    refuseWithoutRecordingTools()
    if (process.platform === 'win32') throw new Error('POSIX run lifecycle required; never skip')
    try {
      await drive()
    } catch (error) {
      scene.error = message(error)
    }
  }, FILE_BUDGET_MS)

  afterAll(async () => {
    await model?.close().catch(() => undefined)
    await target?.close().catch(() => undefined)
    cleanupTempRoots()
  }, 60_000)

  it('a test that cannot start exits 2', () => {
    expect(scene.error, seen()).toBeUndefined()
    expect(scene.exit, seen()).toEqual({ code: 2, signal: null })
    // The bootstrap's exit 2 starts no run; this exit 2 comes from a run that recorded its verdict.
    expect(scene.events, `the run started and reached its verdict\n${seen()}`)
      .toEqual(expect.arrayContaining(['runStarted', 'verdict', 'runFinished']))
    expect(scene.verdict, seen()).toEqual({ verdict: 'failed' })
    expect(scene.output, `the CLI names the launch failure\n${seen()}`).toMatch(/browser support is not installed/u)
    expect(printedRunIds(scene.output ?? ''), `the CLI names the run it recorded\n${seen()}`).toEqual([scene.runId])
    expect(scene.modelRequests, `no member reached a model\n${seen()}`).toBe(0)
  })

  it('its verdict is failed with the could-not-start summary', () => {
    expect(scene.error, seen()).toBeUndefined()
    expect(scene.handoff?.aggregateVerdict, seen()).toBe('failed')
    expect(scene.handoff?.tests?.map((test) => [test.testIndex, test.outcome]), seen())
      .toEqual([[0, 'failed'], [1, 'skipped']])
    // The handoff records outcomes only; each member's summary is on its `testFinished`.
    const [first, second] = scene.finished ?? []
    expect(scene.finished?.map((test) => [test.testIndex, test.outcome]), seen())
      .toEqual([[0, 'failed'], [1, 'skipped']])
    expect(first?.failureSummary ?? '', `the member that could not start names its cause\n${seen()}`).toMatch(LAUNCH_CAUSE)
    expect(second?.failureSummary ?? '', `the member after it says it was not run\n${seen()}`)
      .toContain(COULD_NOT_START)
    for (const test of scene.finished ?? []) {
      expect(test.failureSummary ?? '', `the disconnect sentence is not a launch failure\n${seen()}`)
        .not.toContain(BROWSER_CLOSED)
    }
  })

  it('its row reads failed and no running row is left', () => {
    expect(scene.error, seen()).toBeUndefined()
    expect(scene.row?.status, seen()).toBe('failed')
    expect(scene.row?.failureSummary ?? '', `the row says the test could not start\n${seen()}`).toContain(COULD_NOT_START)
    expect(scene.running, `no runs.db row is left running\n${seen()}`).toEqual([])
  })
})
