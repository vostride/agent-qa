// real `agent-qa run`s whose post-processing ends
// failed, skipped (gate run) or pending keep their verdict and exit code on the CLI, MCP and the
// dashboard, and every surface prints D-13's stage words. The failed leg is a failed run whose
// analyze-run author is refused: its own tail leaves the job retrying (`pending`), and two shipped
// `agent-qa agent-jobs pump --only analyze-run` drains, each started once the row's backoff has
// passed, spend attempts 2 and 3. A passed run's analysis asks no model, so it has no failed leg.

import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { REAL_JOB_KIND_DECLARATIONS } from '@vostride/agent-qa-agent'
import { generateRunId } from '@vostride/agent-qa-ids'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { openDashboardScene, printedRunIds, refuseWithoutRecordingTools } from './run-doors-fixture.js'
import type { DashboardScene } from './run-doors-fixture.js'
import {
  POPULATED_FAILURE_STEP_MARKER,
  POPULATED_FAILURE_STEP_TEXT,
  POPULATED_PASSING_STEP_TEXT,
  POPULATED_SECOND_TEST_PATH,
  populatedRunFixtureProject,
  populatedRunSpawnEnv,
  startStubModelServer,
  startTargetPageServer,
  type FixtureServer,
  type PopulatedRunProject,
  type StubModelServer,
} from './populated-run-fixture.js'
import { CLI_ENTRY, cleanupTempRoots, hermeticEnv } from './spawned-chat.js'

const FILE_BUDGET_MS = 900_000
const SPAWN_BUDGET_MS = 240_000
const READ_BUDGET_MS = 60_000
const BACKOFF_BOUND_MS = 30_000

// The child's execution context is resolved from the environment this file builds for it (stdio
// is piped, so never a TTY): `CI` is forwarded from this process and nothing else is.
const FORWARDED_CI = process.env.CI
const CHILD_CONTEXT = isTruthy(FORWARDED_CI) ? 'ci' : 'local-headless'

// D-22, `post-run-tail.ts`'s `CI_PENDING_SUFFIX`, per stage drainer. Outside `ci` the suffix
// comes from the drain's posture, and `detached` and `retry-scheduled` both map to `none` there.
const CI_PENDING_SUFFIX = {
  analysis: " (resumes only if this workspace's .agent-qa/ is kept and a later run or the daemon picks it up)",
  curation: " (resumes only if this workspace's .agent-qa/ is kept and a later local run picks it up)",
} as const

type Stage = keyof typeof CI_PENDING_SUFFIX
type Verdict = 'passed' | 'failed'

interface JobRow {
  readonly id: string
  readonly status: string
  readonly attempts: number
  readonly lastFailureKind: string | null
  readonly updatedAt: string
}

interface Drain {
  readonly attempt: number
  readonly before?: JobRow
  readonly readyAt?: string
  readonly startedAt?: string
  readonly code?: number | null
  readonly pumped?: unknown
  readonly after?: JobRow
  readonly error?: string
}

interface Reads {
  overviewVerdict?: string
  overviewCuration?: string
  overviewSkipped?: unknown
  digestChainLines?: string[]
  mcpOverviewVerdict?: string
  mcpOverviewCuration?: string
  mcpOverviewSkipped?: unknown
  mcpDigestChain?: unknown
  mcpDigestChainLines?: string[]
  dashboardStatus?: string
  postProcessing?: { status: number; body: unknown }
  errors: string[]
}

// `runs.overview` carries the verdict and, in its Learned half, the curation chip and, for a chain
// that was never enqueued, the skipped fact beside it.
interface OverviewDocument {
  readonly aggregateVerdict?: string
  readonly learned?: {
    readonly curation?: { readonly status?: string; readonly skipped?: { readonly reason?: string } }
  }
}

interface Leg {
  readonly key: string
  readonly verdict: Verdict
  readonly testPath: string
  readonly flags: readonly string[]
  readonly runId: string
  exit?: { code: number | null; signal: NodeJS.Signals | null }
  exitLines?: string[]
  exitLineStreams?: string[]
  printed?: boolean
  recordedVerdict?: unknown
  jobAfterRun?: JobRow | string
  drains?: Drain[]
  reads?: Reads
  tail?: string
}

interface Scene {
  context: string
  legs: Leg[]
  error?: string
}

const scene: Scene = { context: CHILD_CONTEXT, legs: [] }
let model: StubModelServer | undefined
let target: FixtureServer | undefined
const dashboards: DashboardScene[] = []

function isTruthy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase()
  return normalized !== undefined && normalized !== '' && normalized !== '0' && normalized !== 'false'
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function childEnv(project: PopulatedRunProject, runId?: string): NodeJS.ProcessEnv {
  return {
    ...hermeticEnv(project.root),
    ...populatedRunSpawnEnv(),
    ...(FORWARDED_CI === undefined ? {} : { CI: FORWARDED_CI }),
    NO_COLOR: '1',
    ...(runId === undefined ? {} : { AGENT_QA_RUN_ID: runId }),
  }
}

interface Spawned {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
}

async function cli(project: PopulatedRunProject, args: readonly string[], runId?: string): Promise<Spawned> {
  const env = childEnv(project, runId)
  if (runId === undefined) delete env.AGENT_QA_RUN_ID
  const child = spawn(process.execPath, [CLI_ENTRY, '--config', project.configPath, ...args], {
    cwd: project.root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
  const budget = setTimeout(() => { child.kill('SIGKILL') }, SPAWN_BUDGET_MS)
  try {
    const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (settle, fail) => {
        child.once('error', fail)
        child.once('close', (exitCode, exitSignal) => { settle({ code: exitCode, signal: exitSignal }) })
      },
    )
    return { code, signal, stdout, stderr }
  } finally {
    clearTimeout(budget)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
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

// Read-only, waiting out a drainer's write lock. A read that still fails is thrown, and
// the caller records it as an unreadable sample the cells reject.
function analyzeRunRow(project: PopulatedRunProject, runId: string): JobRow {
  const db = new DatabaseSync(join(project.agentQaRoot, 'agent-jobs.db'), { readOnly: true, timeout: 5_000 })
  try {
    const row = db.prepare(
      `SELECT id, status, attempts, last_failure_kind, updated_at FROM jobs
       WHERE kind = 'analyze-run' AND json_extract(payload, '$.runId') = ?`,
    ).get(runId) as
      | { id: string; status: string; attempts: number; last_failure_kind: string | null; updated_at: string }
      | undefined
    if (row === undefined) throw new Error(`no analyze-run row for ${runId}`)
    return {
      id: String(row.id),
      status: row.status,
      attempts: Number(row.attempts),
      lastFailureKind: row.last_failure_kind,
      updatedAt: row.updated_at,
    }
  } finally {
    db.close()
  }
}

// The row records when its retry was decided and which attempt it spent; analyze-run's shipped
// declaration says how long a host waits after that attempt.
function nextAttemptAt(row: JobRow): number {
  const declaration = REAL_JOB_KIND_DECLARATIONS.find((entry) => entry.kind === 'analyze-run')
  if (declaration === undefined) throw new Error('analyze-run has no shipped declaration')
  const { backoff } = declaration
  const delay = backoff.kind === 'none'
    ? 0
    : backoff.kind === 'fixed'
      ? backoff.delayMs
      : Math.min(backoff.initialDelayMs * backoff.factor ** Math.max(0, row.attempts - 1), backoff.maxDelayMs)
  const recorded = Date.parse(row.updatedAt)
  if (Number.isNaN(recorded)) throw new Error(`the row's updated_at is not a time: ${row.updatedAt}`)
  return recorded + delay
}

async function untilBackoffPassed(row: JobRow): Promise<number> {
  const readyAt = nextAttemptAt(row)
  const deadline = Date.now() + BACKOFF_BOUND_MS
  while (Date.now() < readyAt) {
    if (Date.now() >= deadline) throw new Error(`the row's backoff did not pass within ${String(BACKOFF_BOUND_MS)} ms`)
    await new Promise((tick) => setTimeout(tick, 25))
  }
  return readyAt
}

async function drainOnce(project: PopulatedRunProject, runId: string, attempt: number): Promise<Drain> {
  let before: JobRow
  try {
    before = analyzeRunRow(project, runId)
  } catch (error) {
    return { attempt, error: `unreadable before the drain: ${message(error)}` }
  }
  let readyAt: number
  try {
    readyAt = await untilBackoffPassed(before)
  } catch (error) {
    return { attempt, before, error: message(error) }
  }
  const startedAt = new Date().toISOString()
  const pumped = await cli(project, ['agent-jobs', 'pump', '--only', 'analyze-run', '--json'])
  let parsed: unknown
  try {
    parsed = JSON.parse(pumped.stdout)
  } catch {
    parsed = { unparsed: pumped.stdout.slice(0, 1_000), stderr: pumped.stderr.slice(0, 1_000) }
  }
  let after: JobRow | undefined
  let error: string | undefined
  try {
    after = analyzeRunRow(project, runId)
  } catch (failure) {
    error = `unreadable after the drain: ${message(failure)}`
  }
  return {
    attempt,
    before,
    readyAt: new Date(readyAt).toISOString(),
    startedAt,
    code: pumped.code,
    pumped: parsed,
    ...(after === undefined ? {} : { after }),
    ...(error === undefined ? {} : { error }),
  }
}

async function runLeg(project: PopulatedRunProject, leg: Leg): Promise<void> {
  const ran = await cli(project, ['run', leg.testPath, ...leg.flags], leg.runId)
  const output = `${ran.stdout}\n${ran.stderr}`
  leg.exit = { code: ran.code, signal: ran.signal }
  const exitLine = (line: string): boolean => line.startsWith('post-processing — ')
  leg.exitLines = [...ran.stdout.split('\n'), ...ran.stderr.split('\n')].filter(exitLine)
  leg.exitLineStreams = [
    ...ran.stdout.split('\n').filter(exitLine).map(() => 'stdout'),
    ...ran.stderr.split('\n').filter(exitLine).map(() => 'stderr'),
  ]
  leg.printed = printedRunIds(output).includes(leg.runId)
  leg.recordedVerdict = verdictOf(project, leg.runId)
  leg.tail = output.slice(-2_000)
}

function chainLines(text: string): string[] {
  return text.split('\n').filter((line) => line.startsWith('chain — '))
}

async function readLeg(project: PopulatedRunProject, leg: Leg, mcp: Client, dashboard: DashboardScene): Promise<Reads> {
  const reads: Reads = { errors: [] }
  const overview = await cli(project, ['runs', 'overview', leg.runId, '--json'])
  try {
    const document = JSON.parse(overview.stdout) as OverviewDocument
    reads.overviewVerdict = document.aggregateVerdict
    reads.overviewCuration = document.learned?.curation?.status
    reads.overviewSkipped = document.learned?.curation?.skipped
  } catch (error) {
    reads.errors.push(`runs overview: exit ${String(overview.code)} ${message(error)} ${overview.stderr.slice(0, 500)}`)
  }
  const digest = await cli(project, ['digest', leg.runId])
  reads.digestChainLines = chainLines(digest.stdout)
  if (digest.code !== 0) reads.errors.push(`digest: exit ${String(digest.code)} ${digest.stderr.slice(0, 500)}`)
  try {
    const result = await mcp.callTool(
      { name: 'agent_qa_get_run_overview', arguments: { runId: leg.runId } },
      { timeout: READ_BUDGET_MS },
    ) as { isError?: boolean; structuredContent?: unknown; content?: Array<{ text?: string }> }
    if (result.isError === true) throw new Error((result.content ?? []).map((part) => part.text).join('\n'))
    const document = result.structuredContent as OverviewDocument
    reads.mcpOverviewVerdict = document.aggregateVerdict
    reads.mcpOverviewCuration = document.learned?.curation?.status
    reads.mcpOverviewSkipped = document.learned?.curation?.skipped
  } catch (error) {
    reads.errors.push(`agent_qa_get_run_overview: ${message(error)}`)
  }
  try {
    const result = await mcp.callTool(
      { name: 'agent_qa_get_run_digest', arguments: { runId: leg.runId } },
      { timeout: READ_BUDGET_MS },
    ) as { isError?: boolean; structuredContent?: unknown; content?: Array<{ text?: string }> }
    if (result.isError === true) throw new Error((result.content ?? []).map((part) => part.text).join('\n'))
    const document = result.structuredContent as { chain?: unknown; lines?: unknown }
    reads.mcpDigestChain = document.chain
    reads.mcpDigestChainLines = Array.isArray(document.lines)
      ? (document.lines as unknown[]).filter((line): line is string => typeof line === 'string' && line.startsWith('chain — '))
      : []
  } catch (error) {
    reads.errors.push(`agent_qa_get_run_digest: ${message(error)}`)
  }
  try {
    const response = await fetch(`${dashboard.origin}/api/runs/${encodeURIComponent(leg.runId)}`)
    reads.dashboardStatus = (await response.json() as { run?: { status?: string } }).run?.status
  } catch (error) {
    reads.errors.push(`/api/runs/:id: ${message(error)}`)
  }
  try {
    const response = await fetch(`${dashboard.origin}/api/runs/${encodeURIComponent(leg.runId)}/post-processing`)
    reads.postProcessing = { status: response.status, body: await response.json() }
  } catch (error) {
    reads.errors.push(`/api/runs/:id/post-processing: ${message(error)}`)
  }
  return reads
}

async function withMcp<T>(project: PopulatedRunProject, use: (client: Client) => Promise<T>): Promise<T> {
  const env = Object.fromEntries(Object.entries(childEnv(project))
    .filter((entry): entry is [string, string] => entry[1] !== undefined))
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI_ENTRY, '--config', project.configPath, 'mcp'],
    cwd: project.root,
    stderr: 'pipe',
    env,
  })
  const client = new Client({ name: 'agent-qa-444-18-verdict-independence', version: '0.0.0' })
  try {
    await client.connect(transport)
    return await use(client)
  } finally {
    await client.close().catch(() => undefined)
    await transport.close().catch(() => undefined)
  }
}

async function readAll(project: PopulatedRunProject, legs: readonly Leg[]): Promise<void> {
  const dashboard = await openDashboardScene(project)
  dashboards.push(dashboard)
  try {
    await withMcp(project, async (client) => {
      for (const leg of legs) leg.reads = await readLeg(project, leg, client, dashboard)
    })
  } finally {
    await dashboard.close()
  }
}

function leg(key: string, verdict: Verdict, testPath: string, flags: readonly string[]): Leg {
  return { key, verdict, testPath, flags, runId: generateRunId() }
}

async function drive(): Promise<void> {
  target = await startTargetPageServer()
  model = await startStubModelServer({
    plannerOutcome: 'stepFailed',
    failOnlyStepText: POPULATED_FAILURE_STEP_MARKER,
    analysisOutcome: 'error',
  })
  const servers = { modelBaseUrl: model.baseUrl, targetUrl: target.url }

  // The analysis leg has its own project: its drains claim queued work, and the pending legs
  // must keep theirs.
  const analysisProject = populatedRunFixtureProject('444-vi-analysis', servers, {
    stepText: POPULATED_FAILURE_STEP_TEXT,
  })
  const analysis = leg('failed-analysis', 'failed', analysisProject.testPath, [])
  scene.legs.push(analysis)
  await runLeg(analysisProject, analysis)
  try {
    analysis.jobAfterRun = analyzeRunRow(analysisProject, analysis.runId)
  } catch (error) {
    analysis.jobAfterRun = `unreadable: ${message(error)}`
  }
  analysis.drains = []
  for (const attempt of [2, 3]) analysis.drains.push(await drainOnce(analysisProject, analysis.runId, attempt))
  await readAll(analysisProject, [analysis])

  const markersProject = populatedRunFixtureProject('444-vi-markers', servers, {
    stepText: POPULATED_PASSING_STEP_TEXT,
    secondStepText: POPULATED_FAILURE_STEP_TEXT,
  })
  const markerLegs = [
    leg('passed-gate', 'passed', markersProject.testPath, ['--gate-run']),
    leg('failed-gate', 'failed', POPULATED_SECOND_TEST_PATH, ['--gate-run']),
    leg('passed-detached', 'passed', markersProject.testPath, ['--detach']),
    leg('failed-detached', 'failed', POPULATED_SECOND_TEST_PATH, ['--detach']),
  ]
  for (const each of markerLegs) {
    scene.legs.push(each)
    await runLeg(markersProject, each)
  }
  await readAll(markersProject, markerLegs)
}

function seen(): string {
  return JSON.stringify(scene, null, 2)
}

function legOf(key: string): Leg {
  const found = scene.legs.find((each) => each.key === key)
  expect(found, `${key} ran\n${seen()}`).toBeDefined()
  return found as Leg
}

function pendingWord(stage: Stage): string {
  return `pending${CHILD_CONTEXT === 'ci' ? CI_PENDING_SUFFIX[stage] : ''}`
}

type StageWords = { readonly analysis: string; readonly curation: string }

// The stage words first, on every surface that prints them, then no `done` or `excluded`
// anywhere but the run id, whose random words can be either, then the verdict and the exit
// code beside it.
function expectLeg(
  key: string,
  expected: {
    readonly exitLine: StageWords
    readonly chain: StageWords & { readonly skipped?: { reason: string } }
    readonly chainLine: string
    readonly overviewSkipped: { reason: string } | undefined
  },
): void {
  expect(scene.error, seen()).toBeUndefined()
  const run = legOf(key)
  const reads = run.reads
  expect(reads?.errors, `${key}'s reads\n${seen()}`).toEqual([])

  expect(run.exitLines?.length, `${key}'s one exit line\n${seen()}`).toBe(1)
  expect(run.exitLines?.[0]?.startsWith(
    `post-processing — analysis: ${expected.exitLine.analysis} · curation: ${expected.exitLine.curation} · `,
  ), `${key}'s exit line\n${seen()}`).toBe(true)
  expect(reads?.digestChainLines, `${key}'s digest chain line\n${seen()}`).toEqual([expected.chainLine])
  expect(reads?.mcpDigestChainLines, `${key}'s MCP digest chain line\n${seen()}`).toEqual([expected.chainLine])
  const chain = {
    analysis: expected.chain.analysis,
    curation: expected.chain.curation,
    ...(expected.chain.skipped === undefined ? {} : { skipped: expected.chain.skipped }),
  }
  expect(reads?.mcpDigestChain, `${key}'s MCP digest chain\n${seen()}`).toEqual(chain)
  expect(reads?.overviewCuration, `${key}'s runs overview curation chip\n${seen()}`).toBe(expected.chain.curation)
  expect(reads?.mcpOverviewCuration, `${key}'s agent_qa_get_run_overview curation chip\n${seen()}`)
    .toBe(expected.chain.curation)
  expect(reads?.overviewSkipped, `${key}'s runs overview skipped fact\n${seen()}`).toEqual(expected.overviewSkipped)
  expect(reads?.mcpOverviewSkipped, `${key}'s agent_qa_get_run_overview skipped fact\n${seen()}`)
    .toEqual(expected.overviewSkipped)
  expect(reads?.postProcessing?.status, `${key}'s post-processing read\n${seen()}`).toBe(200)
  const body = (reads?.postProcessing?.body as { status?: { chips?: unknown; skipped?: unknown } } | undefined)?.status
  expect(body?.chips, `${key}'s dashboard chips\n${seen()}`)
    .toEqual({ analysis: expected.chain.analysis, curation: expected.chain.curation })
  if (expected.chain.skipped === undefined) {
    expect(body !== undefined && 'skipped' in body, `${key}'s dashboard has no skipped fact\n${seen()}`).toBe(false)
  } else {
    expect(body?.skipped, `${key}'s dashboard skipped fact\n${seen()}`).toEqual(expected.chain.skipped)
  }
  const printed = [
    ...(run.exitLines ?? []),
    ...(reads?.digestChainLines ?? []),
    ...(reads?.mcpDigestChainLines ?? []),
    JSON.stringify(reads?.mcpDigestChain),
    JSON.stringify(reads?.postProcessing?.body),
  ]
  for (const text of printed) {
    expect(text.replaceAll(run.runId, 'run-id'), `${key} prints no done or excluded\n${seen()}`)
      .not.toMatch(/\b(done|excluded)\b/u)
  }

  expect(run.recordedVerdict, `${key}'s verdict\n${seen()}`).toEqual({ verdict: run.verdict })
  expect(reads?.overviewVerdict, `${key}'s runs overview\n${seen()}`).toBe(run.verdict)
  expect(reads?.mcpOverviewVerdict, `${key}'s agent_qa_get_run_overview\n${seen()}`).toBe(run.verdict)
  expect(reads?.dashboardStatus, `${key}'s /api/runs/:id\n${seen()}`).toBe(run.verdict)
  expect(run.exit, `${key}'s exit beside its verdict\n${seen()}`)
    .toEqual({ code: run.verdict === 'passed' ? 0 : 1, signal: null })
  expect(run.printed, `${key}'s run id was printed\n${seen()}`).toBe(true)
}

function expectGateLeg(key: string): void {
  const skipped = 'skipped (gate run)'
  expectLeg(key, {
    exitLine: { analysis: skipped, curation: skipped },
    chain: { analysis: 'pending', curation: 'pending', skipped: { reason: 'gate-run' } },
    chainLine: `chain — analysis: ${skipped} · curation: ${skipped}`,
    overviewSkipped: { reason: 'gate-run' },
  })
}

function expectDetachedLeg(key: string): void {
  expectLeg(key, {
    exitLine: { analysis: pendingWord('analysis'), curation: pendingWord('curation') },
    chain: { analysis: 'pending', curation: 'pending' },
    chainLine: 'chain — analysis: pending · curation: pending',
    overviewSkipped: undefined,
  })
}

describe('post-processing never changes the verdict', () => {
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
    for (const dashboard of dashboards) await dashboard.close().catch(() => undefined)
    await model?.close().catch(() => undefined)
    await target?.close().catch(() => undefined)
    cleanupTempRoots()
  }, 120_000)

  it('a failed run whose analysis failed keeps failed and exit 1 on every surface', () => {
    expect(scene.error, seen()).toBeUndefined()
    const run = legOf('failed-analysis')
    // Its own tail spent attempt 1 on the refused author and left the job retrying, so the run
    // printed `pending`, never `failed`.
    expect(run.jobAfterRun, seen()).toMatchObject({ status: 'queued', attempts: 1, lastFailureKind: 'retry' })
    expect(model?.requests.filter((request) => request.kind === 'analysis').map((request) => request.status), seen())
      .toEqual([400, 400, 400])
    const drains = run.drains ?? []
    expect(drains.map((drain) => drain.error), seen()).toEqual([undefined, undefined])
    for (const drain of drains) {
      expect(Date.parse(drain.startedAt ?? '') >= Date.parse(drain.readyAt ?? ''), `attempt ${String(drain.attempt)} waited out the row's backoff\n${seen()}`)
        .toBe(true)
      expect(drain.code, seen()).toBe(0)
    }
    expect(drains.map((drain) => drain.before?.attempts), seen()).toEqual([1, 2])
    expect(drains.map((drain) => (drain.pumped as { outcomes?: Array<{ disposition?: string; attempt?: number; runId?: string }> })
      .outcomes?.map(({ disposition, attempt, runId }) => ({ disposition, attempt, runId }))), seen())
      .toEqual([
        [{ disposition: 'retry-scheduled', attempt: 2, runId: run.runId }],
        [{ disposition: 'failed', attempt: 3, runId: run.runId }],
      ])
    expect(drains[0]?.after, seen()).toMatchObject({ status: 'queued', attempts: 2, lastFailureKind: 'retry' })
    expect(drains[1]?.after, seen()).toMatchObject({ status: 'failed', attempts: 3, lastFailureKind: 'permanent' })

    // analyze-run's permanent failure proceeds into curate-memory, which only a local run's tail
    // drains (D-20's masked-leg rule), so curation truthfully reads `pending`.
    expectLeg('failed-analysis', {
      exitLine: { analysis: pendingWord('analysis'), curation: pendingWord('curation') },
      chain: { analysis: 'failed', curation: 'pending' },
      chainLine: 'chain — analysis: failed · curation: pending',
      overviewSkipped: undefined,
    })
  })

  it('a passed gate run reads skipped (gate run) and keeps passed and exit 0', () => {
    expectGateLeg('passed-gate')
  })

  it('a failed gate run reads skipped (gate run) and keeps failed and exit 1', () => {
    expectGateLeg('failed-gate')
  })

  it('a passed detached run reads pending and keeps passed and exit 0', () => {
    expectDetachedLeg('passed-detached')
  })

  it('a failed detached run reads pending and keeps failed and exit 1', () => {
    expectDetachedLeg('failed-detached')
  })
})
