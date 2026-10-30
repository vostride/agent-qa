// On a cancelled run, a member before the cancel is `failed`, at it `cancelled`, after `skipped`.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { generateRunId, generateTestId } from '@vostride/agent-qa-ids'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  openDashboardScene,
  refuseWithoutRecordingTools,
  runStoreEvents,
  spawnCliRun,
  type DashboardScene,
} from './run-doors-fixture.js'
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
import { CLI_ENTRY, cleanupTempRoots, hermeticEnv } from './spawned-chat.js'

const FILE_BUDGET_MS = 600_000
const RUN_BUDGET_MS = 240_000
const HOLD_BUDGET_MS = 180_000
const READ_BUDGET_MS = 60_000
const HOLD_MARKER = 'once the operator lifts the hold'
const HOLD_STEP_TEXT = `Click the ${POPULATED_BUTTON_LABEL} button ${HOLD_MARKER}.`

interface MemberSpec {
  readonly file: string
  readonly name: string
  readonly step: string
}

interface Member extends MemberSpec {
  readonly testId: string
}

interface MemberWord {
  readonly testId?: string
  readonly outcome?: string
}

interface Read {
  readonly verdict?: string
  readonly members?: MemberWord[]
  readonly error?: string
}

interface RankingRun {
  members: Member[]
  runId?: string
  reached?: 'held' | 'exited' | 'timeout'
  finishedAtHold?: Array<{ testIndex?: number; outcome?: string }>
  exit?: { code: number | null; signal: NodeJS.Signals | null }
  verdict?: unknown
  handoffVerdict?: unknown
  events?: string[]
  cli?: Read
  mcp?: Read
  dashboard?: Read
  output?: string
  error?: string
}

const MEMBERS: readonly MemberSpec[] = [
  { file: 'tests/ranking/1-fails.test.yaml', name: 'Ranking member one fails', step: POPULATED_FAILURE_STEP_TEXT },
  { file: 'tests/ranking/2-held.test.yaml', name: 'Ranking member two is held', step: HOLD_STEP_TEXT },
  { file: 'tests/ranking/3-passes.test.yaml', name: 'Ranking member three passes', step: POPULATED_PASSING_STEP_TEXT },
]

const run: RankingRun = { members: [] }
let model: StubModelServer | undefined
let target: FixtureServer | undefined
let scene: DashboardScene | undefined

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function writeMembers(project: PopulatedRunProject): Member[] {
  return MEMBERS.map((spec) => {
    const testId = generateTestId()
    const file = join(project.root, spec.file)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(
      file,
      `name: ${spec.name}\ntest-id: ${testId}\ntarget: ${POPULATED_TARGET_NAME}\nsteps:\n  - ${spec.step}\n`,
      'utf8',
    )
    return { ...spec, testId }
  })
}

function loggedEvents(project: PopulatedRunProject, runId: string): Array<{ type: string; payload?: unknown }> {
  try {
    return runStoreEvents(project, runId) as unknown as Array<{ type: string; payload?: unknown }>
  } catch {
    return []
  }
}

function handoffVerdictOf(project: PopulatedRunProject, runId: string): unknown {
  const runs = join(project.agentQaRoot, 'runs')
  for (const entry of readdirSync(runs, { withFileTypes: true })) {
    const log = join(runs, entry.name, 'events.jsonl')
    if (!entry.isDirectory() || !existsSync(log)) continue
    const first = readFileSync(log, 'utf8').split('\n').find((line) => line.trim() !== '')
    if (first === undefined || (JSON.parse(first) as { runId?: string }).runId !== runId) continue
    const handoff = join(runs, entry.name, 'handoff.json')
    return existsSync(handoff)
      ? (JSON.parse(readFileSync(handoff, 'utf8')) as { aggregateVerdict?: unknown }).aggregateVerdict
      : undefined
  }
  return undefined
}

function wordsOf(members: ReadonlyArray<{ testId?: string; outcome?: string }> | undefined): MemberWord[] | undefined {
  return members?.map((member) => ({ testId: member.testId, outcome: member.outcome }))
}

interface OverviewDocument {
  readonly aggregateVerdict?: string
  readonly tests?: ReadonlyArray<{ testId?: string; outcome?: string }>
}

async function readCli(project: PopulatedRunProject, runId: string): Promise<Read> {
  const outcome = await spawnCliRun(project, ['runs', 'overview', runId, '--json'], { budgetMs: READ_BUDGET_MS })
  try {
    const document = JSON.parse(outcome.stdout) as OverviewDocument
    return { verdict: document.aggregateVerdict, members: wordsOf(document.tests) }
  } catch {
    return { error: `exit ${String(outcome.status)}: ${outcome.stdout.slice(0, 1_000)} ${outcome.stderr.slice(0, 1_000)}` }
  }
}

async function readMcp(project: PopulatedRunProject, runId: string): Promise<Read> {
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
  const client = new Client({ name: 'agent-qa-ranking', version: '0.0.0' })
  try {
    await client.connect(transport)
    const result = await client.callTool(
      { name: 'agent_qa_get_run_overview', arguments: { runId } },
      { timeout: READ_BUDGET_MS },
    ) as { isError?: boolean; structuredContent?: unknown; content?: Array<{ text?: string }> }
    if (result.isError === true) return { error: (result.content ?? []).map((part) => part.text).join('\n') }
    const document = result.structuredContent as OverviewDocument
    return { verdict: document.aggregateVerdict, members: wordsOf(document.tests) }
  } catch (error) {
    return { error: message(error) }
  } finally {
    await client.close().catch(() => undefined)
    await transport.close().catch(() => undefined)
  }
}

async function readDashboard(project: PopulatedRunProject, runId: string): Promise<Read> {
  const savedCi = process.env.CI
  process.env.CI = 'true'
  try {
    scene = await openDashboardScene(project)
    const response = await fetch(`${scene.origin}/api/runs/${encodeURIComponent(runId)}/detail`)
    const text = await response.text()
    if (response.status !== 200) return { error: `${String(response.status)} ${text.slice(0, 1_000)}` }
    const document = JSON.parse(text) as { members?: Array<{ testId?: string; outcome?: string }> }
    const row = await fetch(`${scene.origin}/api/runs/${encodeURIComponent(runId)}`)
    const status = (JSON.parse(await row.text()) as { run?: { status?: string } }).run?.status
    return { verdict: status, members: wordsOf(document.members) }
  } catch (error) {
    return { error: message(error) }
  } finally {
    if (savedCi === undefined) delete process.env.CI
    else process.env.CI = savedCi
  }
}

async function driveRanking(): Promise<void> {
  target = await startTargetPageServer()
  model = await startStubModelServer({
    plannerOutcome: 'stepFailed',
    failOnlyStepText: POPULATED_FAILURE_STEP_MARKER,
    holdOnlyStepText: HOLD_MARKER,
  })
  const project = populatedRunFixtureProject('cancel-ranking', {
    modelBaseUrl: model.baseUrl,
    targetUrl: target.url,
  })
  run.members = writeMembers(project)
  const runId = generateRunId()
  run.runId = runId
  const child = spawn(
    process.execPath,
    [CLI_ENTRY, '--config', project.configPath, 'run', ...run.members.map((member) => member.file)],
    {
      cwd: project.root,
      env: {
        ...hermeticEnv(project.root),
        ...populatedRunSpawnEnv(),
        CI: 'true',
        NO_COLOR: '1',
        AGENT_QA_CANCEL_GRACE_MS: '120000',
        AGENT_QA_RUN_ID: runId,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
  const budget = setTimeout(() => { child.kill('SIGKILL') }, RUN_BUDGET_MS)
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((settle, fail) => {
    child.once('error', fail)
    child.once('close', (code, signal) => { settle({ code, signal }) })
  }).finally(() => { clearTimeout(budget) })
  try {
    const deadline = Date.now() + HOLD_BUDGET_MS
    for (;;) {
      if (model.held.count() > 0) { run.reached = 'held'; break }
      if (child.exitCode !== null || child.signalCode !== null) { run.reached = 'exited'; break }
      if (Date.now() >= deadline) { run.reached = 'timeout'; break }
      await new Promise((tick) => setTimeout(tick, 50))
    }
    if (run.reached === 'held') {
      run.finishedAtHold = loggedEvents(project, runId)
        .filter((event) => event.type === 'testFinished')
        .map((event) => {
          const payload = event.payload as { testIndex?: number; outcome?: string }
          return { testIndex: payload.testIndex, outcome: payload.outcome }
        })
      child.kill('SIGINT')
    }
    run.exit = await closed
  } finally {
    model.held.release()
    run.output = output.slice(-2_000)
  }
  const events = loggedEvents(project, runId)
  run.events = events.map((event) => event.type)
  run.verdict = events.find((event) => event.type === 'verdict')?.payload
  run.handoffVerdict = handoffVerdictOf(project, runId)
  run.cli = await readCli(project, runId)
  run.mcp = await readMcp(project, runId)
  run.dashboard = await readDashboard(project, runId)
}

function seen(): string {
  return JSON.stringify(run, null, 2)
}

function expectedWords(): MemberWord[] {
  const [first, second, third] = run.members
  return [
    { testId: first?.testId, outcome: 'failed' },
    { testId: second?.testId, outcome: 'cancelled' },
    { testId: third?.testId, outcome: 'skipped' },
  ]
}

describe('member outcomes of a suite run cancelled mid-member', () => {
  beforeAll(async () => {
    refuseWithoutRecordingTools()
    if (process.platform === 'win32') throw new Error('POSIX run lifecycle required; never skip')
    try {
      await driveRanking()
    } catch (error) {
      run.error = message(error)
    }
  }, FILE_BUDGET_MS)

  afterAll(async () => {
    model?.held.release()
    await scene?.close().catch(() => undefined)
    await model?.close().catch(() => undefined)
    await target?.close().catch(() => undefined)
    cleanupTempRoots()
  }, 120_000)

  it('Ctrl+C during member 2 after member 1 failed gives cancelled and exit 130', () => {
    expect(run.error, seen()).toBeUndefined()
    expect(run.reached, seen()).toBe('held')
    expect(run.finishedAtHold, `member 1 had failed when member 2 was held\n${seen()}`)
      .toEqual([{ testIndex: 0, outcome: 'failed' }])
    expect(run.verdict, seen()).toEqual({ verdict: 'cancelled' })
    expect(run.handoffVerdict, seen()).toBe('cancelled')
    expect(run.exit, seen()).toEqual({ code: 130, signal: null })
    expect(run.events, seen()).toContain('runFinished')
  })

  it('the CLI overview lists member 1 failed, member 2 cancelled and member 3 skipped', () => {
    expect(run.cli, seen()).toEqual({ verdict: 'cancelled', members: expectedWords() })
  })

  it('the MCP overview lists the same member words', () => {
    expect(run.mcp, seen()).toEqual({ verdict: 'cancelled', members: expectedWords() })
  })

  it("the dashboard's run detail lists the same member words", () => {
    expect(run.dashboard, seen()).toEqual({ verdict: 'cancelled', members: expectedWords() })
  })
})
