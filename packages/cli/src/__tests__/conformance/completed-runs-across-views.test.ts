// C444-COMPLETED-VIEWS (444-18, D-04, D-02): three real `agent-qa run`s in one project, one that
// passes, one that fails and one stopped with one SIGINT while its step is held, are then read on
// the doors a user touches: the shipped dashboard's Completed tab in headless Chromium,
// `agent-qa runs list --json` and MCP `agent_qa_list_runs` over stdio. Each id must be on all three
// with the same verdict word.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { generateRunId, generateTestId } from '@vostride/agent-qa-ids'
import { chromium } from 'playwright-core'
import type { Browser, Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { printedRunIds, refuseWithoutRecordingTools, spawnCliRun } from './run-doors-fixture.js'
import {
  POPULATED_BUTTON_LABEL,
  POPULATED_FAILURE_STEP_MARKER,
  POPULATED_FAILURE_STEP_TEXT,
  POPULATED_PASSING_STEP_TEXT,
  POPULATED_TARGET_NAME,
  populatedRunFixtureProject,
  populatedRunSpawnEnv,
  startStubModelServer,
  startTargetPageServer,
  type FixtureServer,
  type PopulatedRunProject,
  type StubModelServer,
} from './populated-run-fixture.js'
import {
  CLI_ENTRY,
  cleanupTempRoots,
  hermeticEnv,
  reserveEphemeralPort,
  spawnDashboard,
  type SpawnedDashboard,
} from './spawned-chat.js'

const FILE_BUDGET_MS = 900_000
const RUN_BUDGET_MS = 240_000
const HOLD_BUDGET_MS = 120_000
const READ_BUDGET_MS = 60_000
const PAGE_BUDGET_MS = 20_000
const HOLD_MARKER = 'once the operator lifts the hold'
const HOLD_STEP_TEXT = `Click the ${POPULATED_BUTTON_LABEL} button ${HOLD_MARKER}.`

// The run-status badge labels `dashboard-ui/src/lib/status.ts` paints; the Verify run badge is not one.
const STATUS_LABELS = new Set(['Passed', 'Failed', 'Timed Out', 'Cancelled', 'Healed', 'Running', 'Pending', 'Queued', 'Skipped'])

type Word = 'passed' | 'failed' | 'cancelled'

interface Spec {
  readonly word: Word
  readonly file: string
  readonly name: string
  readonly step: string
  readonly exit: number
}

const SPECS: readonly Spec[] = [
  { word: 'passed', file: 'tests/views/passing.test.yaml', name: 'Completed views passing probe', step: POPULATED_PASSING_STEP_TEXT, exit: 0 },
  { word: 'failed', file: 'tests/views/failing.test.yaml', name: 'Completed views failing probe', step: POPULATED_FAILURE_STEP_TEXT, exit: 1 },
  { word: 'cancelled', file: 'tests/views/cancelled.test.yaml', name: 'Completed views cancelled probe', step: HOLD_STEP_TEXT, exit: 130 },
]

interface Seeded {
  readonly spec: Spec
  readonly runId: string
  reached?: 'held' | 'exited' | 'timeout'
  exit?: { code: number | null; signal: NodeJS.Signals | null }
  printed?: boolean
  verdict?: unknown
  output?: string
}

interface TabRow {
  readonly runId: string
  readonly status?: string
  readonly text?: string
}

interface Listed {
  readonly runId: string
  readonly verdict?: string
}

interface Scene {
  seeded: Seeded[]
  completed?: { selected: boolean; rows: TabRow[]; waitFailure?: string }
  cli?: { listed?: Listed[]; error?: string }
  mcp?: { listed?: Listed[]; error?: string }
  error?: string
}

const scene: Scene = { seeded: [] }
let model: StubModelServer | undefined
let target: FixtureServer | undefined
let dashboard: SpawnedDashboard | undefined
let browser: Browser | undefined

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function writeTests(project: PopulatedRunProject): void {
  for (const spec of SPECS) {
    const file = join(project.root, spec.file)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(
      file,
      `name: ${spec.name}\ntest-id: ${generateTestId()}\ntarget: ${POPULATED_TARGET_NAME}\nsteps:\n  - ${spec.step}\n`,
      'utf8',
    )
  }
}

function verdictOf(project: PopulatedRunProject, runId: string): unknown {
  const runs = join(project.agentQaRoot, 'runs')
  for (const entry of readdirSync(runs, { withFileTypes: true })) {
    const log = join(runs, entry.name, 'events.jsonl')
    if (!entry.isDirectory() || !existsSync(log)) continue
    const events = readFileSync(log, 'utf8').split('\n').filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { runId?: string; type?: string; payload?: unknown })
    if (events[0]?.runId !== runId) continue
    return events.find((event) => event.type === 'verdict')?.payload
  }
  return undefined
}

async function seed(project: PopulatedRunProject, stub: StubModelServer, spec: Spec): Promise<Seeded> {
  const seeded: Seeded = { spec, runId: generateRunId() }
  const child = spawn(process.execPath, [CLI_ENTRY, '--config', project.configPath, 'run', spec.file], {
    cwd: project.root,
    env: {
      ...hermeticEnv(project.root),
      ...populatedRunSpawnEnv(),
      CI: 'true',
      NO_COLOR: '1',
      AGENT_QA_CANCEL_GRACE_MS: '120000',
      AGENT_QA_RUN_ID: seeded.runId,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
  const budget = setTimeout(() => { child.kill('SIGKILL') }, RUN_BUDGET_MS)
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((settle, fail) => {
    child.once('error', fail)
    child.once('close', (code, signal) => { settle({ code, signal }) })
  }).finally(() => { clearTimeout(budget) })
  try {
    if (spec.word === 'cancelled') {
      const deadline = Date.now() + HOLD_BUDGET_MS
      for (;;) {
        if (stub.held.count() > 0) { seeded.reached = 'held'; break }
        if (child.exitCode !== null || child.signalCode !== null) { seeded.reached = 'exited'; break }
        if (Date.now() >= deadline) { seeded.reached = 'timeout'; break }
        await new Promise((tick) => setTimeout(tick, 50))
      }
      if (seeded.reached === 'held') child.kill('SIGINT')
    }
    seeded.exit = await closed
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    seeded.output = output.slice(-1_500)
  }
  seeded.printed = printedRunIds(output).includes(seeded.runId)
  seeded.verdict = verdictOf(project, seeded.runId)
  return seeded
}

function listedOf(rows: unknown): Listed[] {
  const array = Array.isArray(rows) ? rows : (rows as { result?: unknown } | null)?.result
  if (!Array.isArray(array)) throw new Error(`not a run list: ${JSON.stringify(rows).slice(0, 1_000)}`)
  return array.map((row) => {
    const { runId, aggregateVerdict } = row as { runId: string; aggregateVerdict?: string }
    return { runId, ...(aggregateVerdict === undefined ? {} : { verdict: aggregateVerdict }) }
  })
}

async function readCliList(project: PopulatedRunProject): Promise<Scene['cli']> {
  const outcome = await spawnCliRun(project, ['runs', 'list', '--json'], { budgetMs: READ_BUDGET_MS })
  try {
    return { listed: listedOf(JSON.parse(outcome.stdout)) }
  } catch (error) {
    return { error: `exit ${String(outcome.status)}: ${message(error)} ${outcome.stderr.slice(0, 1_000)}` }
  }
}

async function readMcpList(project: PopulatedRunProject): Promise<Scene['mcp']> {
  const env = Object.fromEntries(Object.entries({
    ...hermeticEnv(project.root),
    ...populatedRunSpawnEnv(),
    CI: 'true',
    NO_COLOR: '1',
  }).filter((entry): entry is [string, string] => entry[1] !== undefined))
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI_ENTRY, '--config', project.configPath, 'mcp'],
    cwd: project.root,
    stderr: 'pipe',
    env,
  })
  const client = new Client({ name: 'agent-qa-444-18-completed-views', version: '0.0.0' })
  try {
    await client.connect(transport)
    const result = await client.callTool(
      { name: 'agent_qa_list_runs', arguments: {} },
      { timeout: READ_BUDGET_MS },
    ) as { isError?: boolean; structuredContent?: unknown; content?: Array<{ text?: string }> }
    if (result.isError === true) return { error: (result.content ?? []).map((part) => part.text).join('\n') }
    return { listed: listedOf(result.structuredContent) }
  } catch (error) {
    return { error: message(error) }
  } finally {
    await client.close().catch(() => undefined)
    await transport.close().catch(() => undefined)
  }
}

async function rowsOnPage(page: Page, runIds: readonly string[]): Promise<TabRow[]> {
  const rows: TabRow[] = []
  for (const runId of runIds) {
    const row = page.locator(`[data-runs-row-surface="${runId}"]`)
    if (await row.count() === 0) continue
    const badges = await row.first().locator('[data-slot="badge"]').allInnerTexts().catch(() => [])
    const label = badges.map((badge) => badge.trim()).find((badge) => STATUS_LABELS.has(badge))
    const text = await row.first().innerText().catch(() => undefined)
    rows.push({
      runId,
      ...(label === undefined ? {} : { status: label.trim().toLowerCase() }),
      ...(text === undefined ? {} : { text }),
    })
  }
  return rows
}

async function readCompletedTab(project: PopulatedRunProject, runIds: readonly string[]): Promise<Scene['completed']> {
  const port = await reserveEphemeralPort()
  const spawned = await spawnDashboard(project.root, project.configPath, port, 60_000, populatedRunSpawnEnv())
  dashboard = spawned
  if (!spawned.ready) throw new Error(`the spawned dashboard never said it was listening: ${spawned.stderr()}`)
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  let firstList: string | undefined
  page.on('response', (response) => {
    if (firstList === undefined && new URL(response.url()).pathname === '/api/runs') firstList = response.url()
  })
  await page.goto(`${dashboard.origin}/runs`)
  const tab = page.getByRole('tab', { name: 'Completed' })
  await tab.waitFor({ state: 'visible', timeout: PAGE_BUDGET_MS })
  let waitFailure: string | undefined
  const listed = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/runs'
      && response.request().method() === 'GET'
      && response.url() !== firstList,
    { timeout: PAGE_BUDGET_MS },
  )
  try {
    await tab.click({ timeout: PAGE_BUDGET_MS })
    await listed
  } catch (error) {
    waitFailure = message(error)
    listed.catch(() => undefined)
  }
  const deadline = Date.now() + PAGE_BUDGET_MS
  let rows = await rowsOnPage(page, runIds)
  let steady = 0
  while (Date.now() < deadline && steady < 6) {
    await new Promise((tick) => setTimeout(tick, 500))
    const next = await rowsOnPage(page, runIds)
    steady = JSON.stringify(next) === JSON.stringify(rows) && next.length === runIds.length ? steady + 1 : 0
    rows = next
  }
  const selected = (await tab.getAttribute('aria-selected').catch(() => null)) === 'true'
  return { selected, rows, ...(waitFailure === undefined ? {} : { waitFailure }) }
}

async function drive(): Promise<void> {
  target = await startTargetPageServer()
  model = await startStubModelServer({
    plannerOutcome: 'stepFailed',
    failOnlyStepText: POPULATED_FAILURE_STEP_MARKER,
    holdOnlyStepText: HOLD_MARKER,
  })
  const project = populatedRunFixtureProject('444-completed-views', {
    modelBaseUrl: model.baseUrl,
    targetUrl: target.url,
  })
  writeTests(project)
  for (const spec of SPECS) scene.seeded.push(await seed(project, model, spec))
  model.held.release()
  const runIds = scene.seeded.map((run) => run.runId)
  scene.cli = await readCliList(project)
  scene.mcp = await readMcpList(project)
  scene.completed = await readCompletedTab(project, runIds)
}

function seen(): string {
  return JSON.stringify(scene, null, 2)
}

function expectSeeded(): void {
  expect(scene.error, seen()).toBeUndefined()
  expect(scene.seeded.map((run) => run.spec.word), seen()).toEqual(['passed', 'failed', 'cancelled'])
  expect(scene.seeded.find((run) => run.spec.word === 'cancelled')?.reached, seen()).toBe('held')
  for (const run of scene.seeded) {
    expect(run.verdict, `${run.spec.word}'s verdict\n${seen()}`).toEqual({ verdict: run.spec.word })
    expect(run.exit, `${run.spec.word}'s exit beside its verdict\n${seen()}`).toEqual({ code: run.spec.exit, signal: null })
    expect(run.printed, `${run.spec.word}'s run id was printed\n${seen()}`).toBe(true)
  }
}

function expectedWords(): Listed[] {
  return scene.seeded.map((run) => ({ runId: run.runId, verdict: run.spec.word }))
}

function wordsFor(listed: readonly Listed[] | undefined): Listed[] {
  const ids = new Set(scene.seeded.map((run) => run.runId))
  return (listed ?? []).filter((row) => ids.has(row.runId))
    .sort((a, b) => scene.seeded.findIndex((run) => run.runId === a.runId)
      - scene.seeded.findIndex((run) => run.runId === b.runId))
}

describe('C444-COMPLETED-VIEWS', () => {
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
    model?.held.release()
    await browser?.close().catch(() => undefined)
    await dashboard?.stop().catch(() => undefined)
    await model?.close().catch(() => undefined)
    await target?.close().catch(() => undefined)
    cleanupTempRoots()
  }, 120_000)

  it('the Completed tab shows the passed, failed and cancelled run', () => {
    expectSeeded()
    expect(scene.completed?.waitFailure, seen()).toBeUndefined()
    expect(scene.completed?.selected, seen()).toBe(true)
    expect(scene.completed?.rows.map((row) => ({ runId: row.runId, verdict: row.status })), seen())
      .toEqual(expectedWords())
    for (const run of scene.seeded) {
      expect(scene.completed?.rows.find((row) => row.runId === run.runId)?.text, seen())
        .toContain(run.spec.name)
    }
  })

  it('agent-qa runs list shows the three runs with their verdict words', () => {
    expectSeeded()
    expect(scene.cli?.error, seen()).toBeUndefined()
    expect(wordsFor(scene.cli?.listed), seen()).toEqual(expectedWords())
  })

  it('agent_qa_list_runs shows the three runs with their verdict words', () => {
    expectSeeded()
    expect(scene.mcp?.error, seen()).toBeUndefined()
    expect(wordsFor(scene.mcp?.listed), seen()).toEqual(expectedWords())
  })

  it('every surface names each run with the same word', () => {
    expectSeeded()
    const cli = wordsFor(scene.cli?.listed)
    const mcp = wordsFor(scene.mcp?.listed)
    const tab = scene.completed?.rows ?? []
    expect(cli.length, seen()).toBe(scene.seeded.length)
    for (const run of scene.seeded) {
      const words = {
        dashboard: tab.find((row) => row.runId === run.runId)?.status,
        cli: cli.find((row) => row.runId === run.runId)?.verdict,
        mcp: mcp.find((row) => row.runId === run.runId)?.verdict,
      }
      expect(words, `${run.runId}\n${seen()}`).toEqual({ dashboard: run.spec.word, cli: run.spec.word, mcp: run.spec.word })
    }
  })
})
