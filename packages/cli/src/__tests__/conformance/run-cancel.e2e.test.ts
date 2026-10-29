// C444-REAL-CANCEL (444-17, D-12, D-11, D-31): a cancel is proven against a run that is really
// running. Each leg parks a run inside step 1 on a real page in real headless Chromium (the stub
// model holds the planning turn and never answers it), cancels it through one door and reads what
// the run left: no later step, the held request aborted, the run's Chromium gone, a `cancelled`
// verdict and handoff, and a runs.db row that reads `running` at every poll until the verdict
// envelope exists. The held turn is answered only by a release this file issues at cleanup, and the
// model client's own request timeout is far beyond the settle wait, so a cancel that does nothing
// fails the leg.

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { ServerResponse } from 'node:http'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { resolveDashboardDbPath } from '@vostride/agent-qa-dashboard'
import { generateRunId } from '@vostride/agent-qa-ids'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

import {
  openDashboardScene,
  printedRunIds,
  refuseWithoutRecordingTools,
  runStoreEvents,
  type DashboardScene,
} from './run-doors-fixture.js'
import { chromiumDescendants, livePidsAfter } from './process-tree.js'
import { refuseWithoutPosixRunLifecycle } from './cli-run-fixture.js'
import {
  POPULATED_BUTTON_LABEL,
  populatedRunFixtureProject,
  populatedRunSpawnEnv,
  startStubModelServer,
  startTargetPageServer,
  type FixtureServer,
  type PopulatedRunProject,
  type StubModelServer,
} from './populated-run-fixture.js'
import { CLI_ENTRY, cleanupTempRoots, hermeticEnv } from './spawned-chat.js'

const CELL_BUDGET_MS = 300_000
const HOLD_BUDGET_MS = 120_000
const SETTLE_BUDGET_MS = 60_000
const BROWSER_GONE_MS = 10_000
const POLL_MS = 50
const KILL_AFTER_MS = 90_000
const FORCED_EXIT_SUMMARY = 'The run was stopped before it reached a verdict.'
const HELD_STEP_RECORD = 'The run was cancelled before this step finished.'
const HOLD_MARKER = 'once the operator lifts the hold'
const HOLD_STEP_TEXT = `Click the ${POPULATED_BUTTON_LABEL} button ${HOLD_MARKER}.`
const STOP_REQUESTED = { outcome: 'stop-requested', message: 'Stop requested. The run will end with its own verdict.' }
const ALREADY_CANCELLED = {
  outcome: 'finished',
  status: 'cancelled',
  message: 'This run already finished: cancelled.',
}

interface Rig {
  readonly project: PopulatedRunProject
  readonly model: StubModelServer
  readonly target: FixtureServer
  child?: ChildProcess
}

interface Envelope {
  readonly seq: number
  readonly ts: number
  readonly type: string
  readonly payload?: unknown
}

interface RowView {
  readonly status: string
  readonly endedAt: string | null
  readonly duration: number
  readonly failureSummary: string | null
}

interface RowSample {
  readonly at: number
  readonly status: string
  readonly endedAt: string | null
  readonly verdict: boolean
}

// What every leg records, whichever door cancelled it.
interface LegFacts {
  readonly leg: string
  runId?: string
  reached?: 'held' | 'ended' | 'timeout'
  eventsAtCancel?: string[]
  cancelSeq?: number
  chromiumAtCancel?: number[]
  cancelledAt?: number
  settled?: boolean
  cancelToVerdictMs?: number
  cancelToSettleMs?: number
  samples?: RowSample[]
  runningPollsBeforeVerdict?: number
  abortedWhenVerdictSeen?: number
  events?: string[]
  stepsStartedAfterCancel?: number
  stepFinalized?: unknown[]
  testsFinished?: unknown[]
  subActionsRecorded?: number
  verdict?: unknown
  verdictTs?: number
  handoffVerdict?: unknown
  heldCount?: number
  heldAborted?: number
  chromiumAliveAfter?: number[]
  row?: RowView
  error?: string
}

interface DashboardFacts extends LegFacts {
  enqueue?: string
  answer?: { status: number; body: unknown }
  rowAtAnswer?: string
  verdictAtAnswer?: boolean
  rowWhenReceived?: string
  verdictWhenReceived?: boolean
  beforeSecond?: RowView
  second?: { status: number; body: unknown }
  afterSecond?: RowView
}

interface CliFacts extends LegFacts {
  readonly signal: NodeJS.Signals
  exit?: { code: number | null; signal: NodeJS.Signals | null }
  printed?: boolean
  output?: string
}

const rigs: Rig[] = []
const scenes: DashboardScene[] = []

async function openRig(label: string): Promise<Rig> {
  const target = await startTargetPageServer()
  const model = await startStubModelServer({ holdOnlyStepText: HOLD_MARKER })
  const project = populatedRunFixtureProject(label, {
    modelBaseUrl: model.baseUrl,
    targetUrl: target.url,
  }, { stepText: HOLD_STEP_TEXT })
  const rig: Rig = { project, model, target }
  rigs.push(rig)
  return rig
}

function loggedEvents(project: PopulatedRunProject, runId: string): Envelope[] {
  try {
    return runStoreEvents(project, runId) as unknown as Envelope[]
  } catch {
    return []
  }
}

function handoffVerdictOf(project: PopulatedRunProject, runId: string): unknown {
  const runs = join(project.agentQaRoot, 'runs')
  for (const entry of readdirSync(runs, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const log = join(runs, entry.name, 'events.jsonl')
    if (!existsSync(log)) continue
    const first = readFileSync(log, 'utf8').split('\n').find((line) => line.trim() !== '')
    if (first === undefined || (JSON.parse(first) as { runId?: string }).runId !== runId) continue
    const handoff = join(runs, entry.name, 'handoff.json')
    if (!existsSync(handoff)) return undefined
    return (JSON.parse(readFileSync(handoff, 'utf8')) as { aggregateVerdict?: unknown }).aggregateVerdict
  }
  return undefined
}

function readRowFresh(project: PopulatedRunProject, runId: string): RowView | undefined {
  const dbPath = resolveDashboardDbPath({ configDir: project.root })
  if (!existsSync(dbPath)) return undefined
  // The run writes runs.db from another process; a read waits out its write lock, never throws on it.
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5_000 })
  try {
    const row = db.prepare('SELECT status, ended_at, duration, failure_summary FROM runs WHERE id = ?')
      .get(runId) as
      | { status: string; ended_at: string | null; duration: number; failure_summary: string | null }
      | undefined
    return row === undefined
      ? undefined
      : { status: row.status, endedAt: row.ended_at, duration: row.duration, failureSummary: row.failure_summary }
  } finally {
    db.close()
  }
}

// Reads the row first and the event log second, so a sample that saw no verdict saw the row as it
// stood before the verdict could have been written.
function watchRow(rig: Rig, runId: string): {
  stop(): RowSample[]
  verdictSeenAt(): number | undefined
  abortedWhenVerdictSeen(): number | undefined
} {
  const samples: RowSample[] = []
  let seenAt: number | undefined
  let abortedThen: number | undefined
  // A tick runs on a timer, so a read that still fails is recorded as a sample the assertions
  // reject, never thrown where nothing catches it.
  const tick = (): void => {
    let row: RowView | undefined
    let unreadable: string | undefined
    try {
      row = readRowFresh(rig.project, runId)
    } catch (error) {
      unreadable = `unreadable: ${error instanceof Error ? error.message : String(error)}`
    }
    const verdict = loggedEvents(rig.project, runId).some((event) => event.type === 'verdict')
    const at = Date.now()
    samples.push({ at, status: unreadable ?? row?.status ?? 'absent', endedAt: row?.endedAt ?? null, verdict })
    if (verdict && seenAt === undefined) {
      seenAt = at
      abortedThen = rig.model.held.aborted()
    }
  }
  tick()
  const timer = setInterval(tick, POLL_MS)
  return {
    stop: () => {
      clearInterval(timer)
      tick()
      return samples
    },
    verdictSeenAt: () => seenAt,
    abortedWhenVerdictSeen: () => abortedThen,
  }
}

async function untilHeld(model: StubModelServer, ended: () => boolean): Promise<'held' | 'ended' | 'timeout'> {
  const deadline = Date.now() + HOLD_BUDGET_MS
  for (;;) {
    if (model.held.count() > 0) return 'held'
    if (ended()) return 'ended'
    if (Date.now() >= deadline) return 'timeout'
    await new Promise((tick) => setTimeout(tick, POLL_MS))
  }
}

async function until(done: () => boolean, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (!done()) {
    if (Date.now() >= deadline) return false
    await new Promise((tick) => setTimeout(tick, POLL_MS))
  }
  return true
}

function noteCancel(facts: LegFacts, rig: Rig, runId: string): void {
  const events = loggedEvents(rig.project, runId)
  facts.eventsAtCancel = events.map((event) => event.type)
  facts.cancelSeq = events.reduce((max, event) => Math.max(max, event.seq), 0)
}

async function noteSettled(
  facts: LegFacts,
  rig: Rig,
  runId: string,
  watcher: ReturnType<typeof watchRow>,
): Promise<void> {
  const settledAt = Date.now()
  facts.cancelToSettleMs = settledAt - facts.cancelledAt!
  facts.samples = watcher.stop()
  const seenAt = watcher.verdictSeenAt()
  if (seenAt !== undefined) facts.cancelToVerdictMs = seenAt - facts.cancelledAt!
  facts.abortedWhenVerdictSeen = watcher.abortedWhenVerdictSeen()
  facts.runningPollsBeforeVerdict = facts.samples.filter((sample) => !sample.verdict).length
  const events = loggedEvents(rig.project, runId)
  facts.events = events.map((event) => event.type)
  facts.stepsStartedAfterCancel = events
    .filter((event) => event.seq > facts.cancelSeq! && event.type === 'stepStarted').length
  facts.stepFinalized = events.filter((event) => event.type === 'stepFinalized').map((event) => event.payload)
  facts.testsFinished = events.filter((event) => event.type === 'testFinished').map((event) => {
    const { testIndex, outcome, durationMs } = event.payload as Record<string, unknown>
    return { testIndex, outcome, durationMs }
  })
  facts.subActionsRecorded = events.filter((event) => event.type === 'subActionRecorded').length
  const verdict = events.find((event) => event.type === 'verdict')
  facts.verdict = verdict?.payload
  facts.verdictTs = verdict?.ts
  facts.handoffVerdict = handoffVerdictOf(rig.project, runId)
  facts.heldCount = rig.model.held.count()
  facts.heldAborted = rig.model.held.aborted()
  facts.chromiumAliveAfter = await livePidsAfter(facts.chromiumAtCancel ?? [], BROWSER_GONE_MS)
  facts.row = readRowFresh(rig.project, runId)
}

function runLengths(samples: readonly RowSample[]): string[] {
  const runs: Array<{ key: string; count: number }> = []
  for (const sample of samples) {
    const key = `${sample.status}${sample.verdict ? '+verdict' : ''}`
    const last = runs.at(-1)
    if (last?.key === key) last.count += 1
    else runs.push({ key, count: 1 })
  }
  return runs.map((run) => `${run.key} x${String(run.count)}`)
}

function stepRecords(facts: LegFacts): Array<Record<string, unknown>> {
  return (facts.stepFinalized ?? []).map((payload) => {
    const { status, stepIndex, testIndex, error } = payload as Record<string, unknown>
    return { testIndex, stepIndex, status, error }
  })
}

function seen(facts: LegFacts): string {
  return JSON.stringify({
    ...facts,
    samples: runLengths(facts.samples ?? []),
    stepFinalized: stepRecords(facts),
  }, null, 2)
}

// The per-leg set (D-12): the run was parked in its step with a live browser, nothing ran after the
// cancel, the held request was aborted, the browser closed, the verdict and the handoff read
// `cancelled`, and the row read `running` at every poll until the verdict envelope existed.
function expectCancelledInPlace(facts: LegFacts): void {
  const at = seen(facts)
  expect(facts.error, at).toBeUndefined()
  expect(facts.reached, at).toBe('held')
  expect(facts.eventsAtCancel, `the run was inside its step at the cancel\n${at}`).toContain('stepStarted')
  expect(facts.eventsAtCancel, `the run had no verdict at the cancel\n${at}`).not.toContain('verdict')
  expect(facts.chromiumAtCancel?.length ?? 0, `a parked run with no live browser\n${at}`).toBeGreaterThan(0)
  expect(facts.settled, `the run settled within ${String(SETTLE_BUDGET_MS)} ms of the cancel\n${at}`).toBe(true)
  expect(facts.stepsStartedAfterCancel, `no step started after the cancel\n${at}`).toBe(0)
  expect(facts.events?.filter((type) => type === 'stepStarted'), at).toEqual(['stepStarted'])
  // D-51: the ratified one-terminal-record contract publishes exactly one record for the held
  // step, and it names no cause.
  expect(stepRecords(facts), `the held step has exactly one cancelled record\n${at}`).toEqual([
    { testIndex: 0, stepIndex: 0, status: 'cancelled', error: HELD_STEP_RECORD },
  ])
  expect(facts.subActionsRecorded, `the held step recorded no action\n${at}`).toBe(0)
  const finished = (facts.testsFinished ?? []) as Array<Record<string, unknown>>
  expect(finished.map((test) => [test.testIndex, test.outcome]), at).toEqual([[0, 'cancelled']])
  expect(Number(finished[0]?.durationMs ?? 0), `the held member keeps the time it ran (D-52)\n${at}`)
    .toBeGreaterThan(0)
  expect(facts.heldCount, at).toBe(1)
  expect(facts.heldAborted, `the held planning request was aborted\n${at}`).toBe(1)
  expect(facts.chromiumAliveAfter, `no Chromium outlived the run\n${at}`).toEqual([])
  expect(facts.verdict, at).toEqual({ verdict: 'cancelled' })
  expect(facts.handoffVerdict, at).toBe('cancelled')
  expect(facts.events, `the run reached runFinished\n${at}`).toContain('runFinished')

  const samples = facts.samples ?? []
  expect(facts.runningPollsBeforeVerdict ?? 0, `the row was polled before the verdict\n${at}`).toBeGreaterThan(0)
  expect(samples.filter((sample) => !sample.verdict).map((sample) => sample.status), at)
    .toEqual(samples.filter((sample) => !sample.verdict).map(() => 'running'))
  const firstCancelled = samples.findIndex((sample) => sample.status === 'cancelled')
  expect(firstCancelled, `the row reached cancelled\n${at}`).toBeGreaterThan(0)
  expect(samples.slice(0, firstCancelled).every((sample) => sample.status === 'running'), at).toBe(true)
  expect(samples.slice(firstCancelled).every((sample) => sample.status === 'cancelled'), at).toBe(true)
  expect(samples[firstCancelled]!.verdict, `cancelled only once the verdict existed\n${at}`).toBe(true)
  expect(facts.row?.status, at).toBe('cancelled')
  expect(facts.row?.endedAt, at).toEqual(expect.any(String))
  expect(facts.row?.duration ?? 0, `the cancelled row keeps the run's duration (D-52)\n${at}`).toBeGreaterThan(0)
  expect(Date.parse(facts.row!.endedAt!), `ended_at is not before the verdict\n${at}`)
    .toBeGreaterThanOrEqual(facts.verdictTs ?? Infinity)
}

async function postJson(url: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' } })
  const text = await response.text()
  try {
    return { status: response.status, body: JSON.parse(text) as unknown }
  } catch {
    return { status: response.status, body: text }
  }
}

let dashboardLeg: Promise<DashboardFacts> | undefined

// The dashboard runs in this process, and the cancel route answers synchronously after asking the
// run to stop, so the row is read inside the route's own `end`: the instant the answer is written.
function witnessAnswer(path: string, read: () => void): () => void {
  const end = ServerResponse.prototype.end
  ServerResponse.prototype.end = function witnessedEnd(this: ServerResponse, ...args: unknown[]) {
    if (this.req?.method === 'POST' && this.req.url === path) read()
    return (end as (...rest: unknown[]) => ServerResponse).apply(this, args)
  } as typeof end
  return () => { ServerResponse.prototype.end = end }
}

async function driveDashboardLeg(): Promise<DashboardFacts> {
  const facts: DashboardFacts = { leg: 'dashboard Cancel' }
  refuseWithoutRecordingTools()
  refuseWithoutPosixRunLifecycle()
  const savedCi = process.env.CI
  const savedBrowsers = process.env.PLAYWRIGHT_BROWSERS_PATH
  try {
    const rig = await openRig('444-real-cancel-dashboard')
    process.env.CI = 'true'
    const browsers = populatedRunSpawnEnv().PLAYWRIGHT_BROWSERS_PATH
    if (browsers !== undefined) process.env.PLAYWRIGHT_BROWSERS_PATH = browsers
    // The browser runs in this process, so only the Chromium that appeared for this run counts.
    const before = new Set(chromiumDescendants(process.pid))
    const scene = await openDashboardScene(rig.project)
    scenes.push(scene)
    const enqueued = await fetch(`${scene.origin}/api/runs/trigger`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: rig.project.testPath }),
    })
    const text = await enqueued.text()
    facts.enqueue = `${String(enqueued.status)} ${text}`
    const runId = (JSON.parse(text) as { runId?: unknown }).runId
    if (typeof runId !== 'string') throw new Error(`the queue route answered no run id: ${facts.enqueue}`)
    facts.runId = runId
    const ended = (): boolean => loggedEvents(rig.project, runId).some((event) => event.type === 'runFinished')
    facts.reached = await untilHeld(rig.model, ended)
    if (facts.reached !== 'held') return facts

    noteCancel(facts, rig, runId)
    facts.chromiumAtCancel = chromiumDescendants(process.pid).filter((pid) => !before.has(pid))
    const watcher = watchRow(rig, runId)
    facts.cancelledAt = Date.now()
    const cancelPath = `/api/runs/${encodeURIComponent(runId)}/cancel`
    const cancelUrl = `${scene.origin}${cancelPath}`
    const unwitness = witnessAnswer(cancelPath, () => {
      facts.rowAtAnswer ??= readRowFresh(rig.project, runId)?.status
      facts.verdictAtAnswer ??= loggedEvents(rig.project, runId).some((event) => event.type === 'verdict')
    })
    let response: Response
    try {
      response = await fetch(cancelUrl, { method: 'POST', headers: { 'content-type': 'application/json' } })
    } finally {
      unwitness()
    }
    facts.rowWhenReceived = readRowFresh(rig.project, runId)?.status
    facts.verdictWhenReceived = loggedEvents(rig.project, runId).some((event) => event.type === 'verdict')
    facts.answer = { status: response.status, body: JSON.parse(await response.text()) as unknown }
    facts.settled = await until(
      () => ended() && scene.settled.some((entry) => entry.runId === runId),
      SETTLE_BUDGET_MS,
    )
    await noteSettled(facts, rig, runId, watcher)

    facts.beforeSecond = readRowFresh(rig.project, runId)
    facts.second = await postJson(cancelUrl)
    facts.afterSecond = readRowFresh(rig.project, runId)
    return facts
  } catch (error) {
    facts.error = error instanceof Error ? error.message : String(error)
    return facts
  } finally {
    if (savedCi === undefined) delete process.env.CI
    else process.env.CI = savedCi
    if (savedBrowsers === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH
    else process.env.PLAYWRIGHT_BROWSERS_PATH = savedBrowsers
  }
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

async function driveCliLeg(
  leg: string,
  label: string,
  args: readonly string[],
  signal: NodeJS.Signals,
): Promise<CliFacts> {
  const facts: CliFacts = { leg, signal }
  let output = ''
  try {
    refuseWithoutRecordingTools()
    refuseWithoutPosixRunLifecycle()
    const rig = await openRig(label)
    const runId = generateRunId()
    facts.runId = runId
    const child = spawn(process.execPath, [CLI_ENTRY, '--config', rig.project.configPath, ...args], {
      cwd: rig.project.root,
      env: {
        ...hermeticEnv(rig.project.root),
        ...populatedRunSpawnEnv(),
        CI: 'true',
        NO_COLOR: '1',
        // Research Pitfall 4: the grace backstop's exit 130 can never stand in for the run's own.
        AGENT_QA_CANCEL_GRACE_MS: '120000',
        AGENT_QA_RUN_ID: runId,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    rig.child = child
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((settle, fail) => {
      child.once('error', fail)
      child.once('close', (code, closeSignal) => { settle({ code, signal: closeSignal }) })
    })
    facts.reached = await untilHeld(rig.model, () => exited(child))
    if (facts.reached !== 'held') return facts

    noteCancel(facts, rig, runId)
    facts.chromiumAtCancel = chromiumDescendants(child.pid!)
    const watcher = watchRow(rig, runId)
    facts.cancelledAt = Date.now()
    child.kill(signal)
    const kill = setTimeout(() => { child.kill('SIGKILL') }, KILL_AFTER_MS)
    try {
      facts.settled = await Promise.race([
        closed.then(() => true),
        new Promise<boolean>((settle) => { setTimeout(() => settle(false), SETTLE_BUDGET_MS) }),
      ])
      facts.exit = await closed
    } finally {
      clearTimeout(kill)
    }
    await noteSettled(facts, rig, runId, watcher)
    facts.printed = printedRunIds(output).includes(runId)
    return facts
  } catch (error) {
    facts.error = error instanceof Error ? error.message : String(error)
    return facts
  } finally {
    facts.output = output.slice(-1_500)
  }
}

// The CLI legs add the exit beside the verdict, never alone, and D-30: one signal stopped the run
// and the row's `cancelled` is the verdict's, not the forced-exit close's.
function expectCliCancelled(facts: CliFacts): void {
  expectCancelledInPlace(facts)
  const at = seen(facts)
  expect(facts.exit, at).toEqual({ code: 130, signal: null })
  expect(facts.row?.failureSummary, `the row was not closed by a forced exit\n${at}`).not.toBe(FORCED_EXIT_SUMMARY)
  expect(facts.printed, `the run id was printed\n${at}`).toBe(true)
}

afterEach(async () => {
  for (const rig of rigs) {
    rig.model.held.release()
    if (rig.child !== undefined && !exited(rig.child)) rig.child.kill('SIGKILL')
  }
  for (const scene of scenes.splice(0)) await scene.close().catch(() => undefined)
  for (const rig of rigs.splice(0)) {
    await rig.model.close().catch(() => undefined)
    await rig.target.close().catch(() => undefined)
  }
}, 120_000)

afterAll(() => {
  cleanupTempRoots()
})

describe('C444-REAL-CANCEL', () => {
  it('a dashboard Cancel stops a run parked in its first step', async () => {
    dashboardLeg ??= driveDashboardLeg()
    const facts = await dashboardLeg
    const at = seen(facts)
    expect(facts.answer, at).toEqual({ status: 202, body: STOP_REQUESTED })
    expect(facts.verdictAtAnswer, `no verdict existed when the route answered\n${at}`).toBe(false)
    expect(facts.rowAtAnswer, `the row read running at the answer\n${at}`).toBe('running')
    expectCancelledInPlace(facts)
  }, CELL_BUDGET_MS)

  it('a Cancel after the verdict answers that the run already finished', async () => {
    dashboardLeg ??= driveDashboardLeg()
    const facts = await dashboardLeg
    const at = seen(facts)
    expect(facts.error, at).toBeUndefined()
    expect(facts.beforeSecond?.status, at).toBe('cancelled')
    expect(facts.second, at).toEqual({ status: 200, body: ALREADY_CANCELLED })
    expect(facts.afterSecond, `the second Cancel wrote nothing\n${at}`).toEqual(facts.beforeSecond)
  }, CELL_BUDGET_MS)

  it('SIGINT stops a parked direct run', async () => {
    expectCliCancelled(await driveCliLeg(
      'SIGINT direct',
      '444-real-cancel-direct-sigint',
      ['run', 'tests/populated.test.yaml'],
      'SIGINT',
    ))
  }, CELL_BUDGET_MS)

  it('SIGTERM stops a parked direct run', async () => {
    expectCliCancelled(await driveCliLeg(
      'SIGTERM direct',
      '444-real-cancel-direct-sigterm',
      ['run', 'tests/populated.test.yaml'],
      'SIGTERM',
    ))
  }, CELL_BUDGET_MS)

  it('SIGINT stops a parked suite run', async () => {
    expectCliCancelled(await driveCliLeg(
      'SIGINT suite',
      '444-real-cancel-suite-sigint',
      ['run', '--suite', 'suites/populated.suite.yaml'],
      'SIGINT',
    ))
  }, CELL_BUDGET_MS)

  it('SIGTERM stops a parked suite run', async () => {
    expectCliCancelled(await driveCliLeg(
      'SIGTERM suite',
      '444-real-cancel-suite-sigterm',
      ['run', '--suite', 'suites/populated.suite.yaml'],
      'SIGTERM',
    ))
  }, CELL_BUDGET_MS)
})
