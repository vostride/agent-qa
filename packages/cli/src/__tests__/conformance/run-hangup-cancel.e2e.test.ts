// on `agent-qa run` a signal is answered by the run's own
// shutdown path, not by Playwright's. Each cell holds a real run inside its step (the stub model
// parks the planning turn), sends one signal to the built bin and reads what the run left: the
// exit, `runFinished`, the printed run id, the verdict, the runs.db row and the Chromium it had.
// The grace timer is set to 120 s and the run must end within 30 s, so only the run's own path
// can pass (research Pitfall 4). Every other door keeps Playwright's handling: a dashboard run in
// this process gains Playwright's listeners while its browser is open, and only `agent-qa run`'s
// two producer calls name the option.
// a hang-up is a cancel on this door too, so one SIGHUP to a held direct
// run must end through the same path; the dashboard door still keeps Playwright's default.
// a terminal close under zsh delivers SIGHUP twice about 1 ms apart, so
// two SIGHUPs that far apart must end a held direct run once, through the same path.

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DashboardDatabase, resolveDashboardDbPath } from '@vostride/agent-qa-dashboard'
import { generateRunId } from '@vostride/agent-qa-ids'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

import {
  openDashboardScene,
  printedRunIds,
  refuseWithoutRecordingTools,
  runStoreEvents,
  type DashboardScene,
} from './run-doors-fixture.js'
import { refuseWithoutPosixRunLifecycle } from './cli-run-fixture.js'
import { chromiumDescendants, livePids, livePidsAfter } from './process-tree.js'
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
const KILL_AFTER_MS = 90_000
const OWN_PATH_BOUND_MS = 30_000
const BROWSER_GONE_MS = 10_000
const HOLD_MARKER = 'once the operator lifts the hold'
const HOLD_STEP_TEXT = `Click the ${POPULATED_BUTTON_LABEL} button ${HOLD_MARKER}.`
const FORCED_EXIT_SUMMARY = 'The run was stopped before it reached a verdict.'
const RUN_FINISHED_MS = 60_000
const PACKAGES_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const RUN_TS = join(PACKAGES_ROOT, 'cli', 'src', 'commands', 'run.ts')
const OWNED_SIGNALS = ['SIGINT', 'SIGTERM'] as const
const SIGHUP_ON = "process.on('SIGHUP', shutdownController.handleSignal)"
const SIGHUP_OFF = "process.removeListener('SIGHUP', shutdownController.handleSignal)"
type OwnedSignal = (typeof OWNED_SIGNALS)[number]
type Listener = (...args: unknown[]) => void

interface Rig {
  readonly project: PopulatedRunProject
  readonly model: StubModelServer
  readonly target: FixtureServer
  child?: ChildProcess
}

interface SignalReport {
  readonly cell: string
  readonly signal: NodeJS.Signals
  readonly runId: string
  reached?: 'held' | 'exited' | 'timeout'
  chromiumAtSignal?: number[]
  elapsedMs?: number
  exit?: { code: number | null; signal: NodeJS.Signals | null }
  walAfterExit?: boolean
  aliveAtExit?: number[]
  aliveAfterExit?: number[]
  events?: string[]
  verdict?: unknown
  row?: { status: string; failureSummary: string | null }
  printed?: boolean
  secondSignal?: { sentAfterMs: number; aliveAtSend: boolean; delivered: boolean }
  output?: string
}

const rigs: Rig[] = []

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

function spawnRun(rig: Rig, args: readonly string[], runId: string): {
  readonly child: ChildProcess
  readonly output: () => string
  readonly closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
} {
  const child = spawn(process.execPath, [CLI_ENTRY, '--config', rig.project.configPath, ...args], {
    cwd: rig.project.root,
    env: {
      ...hermeticEnv(rig.project.root),
      ...populatedRunSpawnEnv(),
      CI: 'true',
      NO_COLOR: '1',
      AGENT_QA_CANCEL_GRACE_MS: '120000',
      AGENT_QA_RUN_ID: runId,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  rig.child = child
  let text = ''
  child.stdout?.on('data', (chunk: Buffer) => { text += chunk.toString('utf8') })
  child.stderr?.on('data', (chunk: Buffer) => { text += chunk.toString('utf8') })
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((settle, fail) => {
    child.once('error', fail)
    child.once('close', (code, signal) => { settle({ code, signal }) })
  })
  return { child, output: () => text, closed }
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

async function untilHeld(model: StubModelServer, child: ChildProcess): Promise<'held' | 'exited' | 'timeout'> {
  const deadline = Date.now() + HOLD_BUDGET_MS
  for (;;) {
    if (model.held.count() > 0) return 'held'
    if (exited(child)) return 'exited'
    if (Date.now() >= deadline) return 'timeout'
    await new Promise((tick) => setTimeout(tick, 50))
  }
}

function readRow(project: PopulatedRunProject, runId: string): SignalReport['row'] {
  const dbPath = resolveDashboardDbPath({ configDir: project.root })
  if (!existsSync(dbPath)) return undefined
  const db = new DashboardDatabase({ dbPath })
  try {
    const row = db.getRun(runId)
    return row === undefined ? undefined : { status: row.status, failureSummary: row.failureSummary ?? null }
  } finally {
    db.close()
  }
}

function loggedEvents(project: PopulatedRunProject, runId: string): Array<{ type: string; payload?: unknown }> {
  try {
    return runStoreEvents(project, runId) as Array<{ type: string; payload?: unknown }>
  } catch {
    return []
  }
}

async function signalHeldRun(
  cell: string,
  label: string,
  args: readonly string[],
  signal: NodeJS.Signals,
  repeat?: { readonly afterMs: number },
): Promise<SignalReport> {
  refuseWithoutRecordingTools()
  refuseWithoutPosixRunLifecycle()
  const rig = await openRig(label)
  const runId = generateRunId()
  const facts: SignalReport = { cell, signal, runId }
  const run = spawnRun(rig, args, runId)
  facts.reached = await untilHeld(rig.model, run.child)
  if (facts.reached !== 'held') {
    facts.output = run.output()
    return facts
  }
  facts.chromiumAtSignal = chromiumDescendants(run.child.pid!)
  const signalledAt = Date.now()
  run.child.kill(signal)
  if (repeat !== undefined) {
    await new Promise((tick) => setTimeout(tick, repeat.afterMs))
    const aliveAtSend = !exited(run.child)
    const sentAfterMs = Date.now() - signalledAt
    facts.secondSignal = { sentAfterMs, aliveAtSend, delivered: run.child.kill(signal) }
  }
  const kill = setTimeout(() => { run.child.kill('SIGKILL') }, KILL_AFTER_MS)
  try {
    facts.exit = await run.closed
  } finally {
    clearTimeout(kill)
  }
  facts.elapsedMs = Date.now() - signalledAt
  facts.aliveAtExit = livePids(facts.chromiumAtSignal)
  facts.walAfterExit = existsSync(`${resolveDashboardDbPath({ configDir: rig.project.root })}-wal`)
  facts.aliveAfterExit = await livePidsAfter(facts.chromiumAtSignal, BROWSER_GONE_MS)
  const events = loggedEvents(rig.project, runId)
  facts.events = events.map((event) => event.type)
  facts.verdict = events.find((event) => event.type === 'verdict')?.payload
  facts.row = readRow(rig.project, runId)
  facts.printed = printedRunIds(run.output()).includes(runId)
  facts.output = run.output()
  return facts
}

function expectOwnPath(facts: SignalReport): void {
  const seen = JSON.stringify({ ...facts, output: facts.output?.slice(-1_500) }, null, 2)
  expect(facts.reached, seen).toBe('held')
  expect(facts.chromiumAtSignal?.length ?? 0, `a held run with no live browser\n${seen}`).toBeGreaterThan(0)
  expect(facts.exit, seen).toEqual({ code: 130, signal: null })
  expect(facts.elapsedMs ?? Infinity, seen).toBeLessThan(OWN_PATH_BOUND_MS)
  expect(facts.events, `the run reached runFinished\n${seen}`).toContain('runFinished')
  expect(facts.verdict, seen).toMatchObject({ verdict: 'cancelled' })
  expect(facts.printed, `the run id was printed\n${seen}`).toBe(true)
  expect(facts.row?.status, seen).toBe('cancelled')
  expect(facts.row?.failureSummary, seen).not.toBe(FORCED_EXIT_SUMMARY)
  expect(facts.aliveAfterExit, `no Chromium outlived the run\n${seen}`).toEqual([])
}

function listenersOf(signal: OwnedSignal): Listener[] {
  return process.listeners(signal) as Listener[]
}

function listenerBaseline(): Record<OwnedSignal, Set<Listener>> {
  return { SIGINT: new Set(listenersOf('SIGINT')), SIGTERM: new Set(listenersOf('SIGTERM')) }
}

function addedSince(before: Record<OwnedSignal, Set<Listener>>): Record<OwnedSignal, Listener[]> {
  return {
    SIGINT: listenersOf('SIGINT').filter((listener) => !before.SIGINT.has(listener)),
    SIGTERM: listenersOf('SIGTERM').filter((listener) => !before.SIGTERM.has(listener)),
  }
}

function attachedOf(added: Record<OwnedSignal, Listener[]>): number {
  return OWNED_SIGNALS.reduce(
    (sum, signal) => sum + added[signal].filter((listener) => listenersOf(signal).includes(listener)).length,
    0,
  )
}

interface DashboardReport {
  runId?: string
  enqueue?: string
  reached?: 'held' | 'finished' | 'timeout'
  addedAtHold?: Record<OwnedSignal, number>
  finished?: boolean
  attachedAfterFinish?: number
  error?: string
  closeError?: string
}

async function driveDashboardHold(): Promise<DashboardReport> {
  refuseWithoutRecordingTools()
  refuseWithoutPosixRunLifecycle()
  const facts: DashboardReport = {}
  const rig = await openRig('444-ctrl-c-dashboard')
  const savedCi = process.env.CI
  const savedBrowsers = process.env.PLAYWRIGHT_BROWSERS_PATH
  process.env.CI = 'true'
  const browsers = populatedRunSpawnEnv().PLAYWRIGHT_BROWSERS_PATH
  if (browsers !== undefined) process.env.PLAYWRIGHT_BROWSERS_PATH = browsers
  const beforeScene = listenerBaseline()
  let scene: DashboardScene | undefined
  try {
    scene = await openDashboardScene(rig.project)
    const beforeLaunch = listenerBaseline()
    const enqueued = await fetch(`${scene.origin}/api/runs/trigger`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: rig.project.testPath }),
    })
    const text = await enqueued.text()
    facts.enqueue = `${String(enqueued.status)} ${text}`
    const runId = (JSON.parse(text) as { runId?: unknown }).runId
    if (typeof runId !== 'string') return facts
    facts.runId = runId
    const finished = (): boolean => loggedEvents(rig.project, runId).some((event) => event.type === 'runFinished')
    const holdDeadline = Date.now() + HOLD_BUDGET_MS
    for (;;) {
      if (rig.model.held.count() > 0) { facts.reached = 'held'; break }
      if (finished()) { facts.reached = 'finished'; break }
      if (Date.now() >= holdDeadline) { facts.reached = 'timeout'; break }
      await new Promise((tick) => setTimeout(tick, 50))
    }
    if (facts.reached !== 'held') return facts
    const added = addedSince(beforeLaunch)
    facts.addedAtHold = { SIGINT: added.SIGINT.length, SIGTERM: added.SIGTERM.length }
    rig.model.held.release()
    const finishDeadline = Date.now() + RUN_FINISHED_MS
    while (!finished() && Date.now() < finishDeadline) {
      await new Promise((tick) => setTimeout(tick, 100))
    }
    facts.finished = finished()
    const detachDeadline = Date.now() + BROWSER_GONE_MS
    while (attachedOf(added) > 0 && Date.now() < detachDeadline) {
      await new Promise((tick) => setTimeout(tick, 100))
    }
    facts.attachedAfterFinish = attachedOf(added)
    return facts
  } catch (error) {
    facts.error = error instanceof Error ? error.message : String(error)
    return facts
  } finally {
    rig.model.held.release()
    try {
      await scene?.close()
    } catch (error) {
      facts.closeError = error instanceof Error ? error.message : String(error)
    }
    const sceneAdded = addedSince(beforeScene)
    for (const signal of OWNED_SIGNALS) {
      for (const listener of sceneAdded[signal]) process.removeListener(signal, listener)
    }
    if (savedCi === undefined) delete process.env.CI
    else process.env.CI = savedCi
    if (savedBrowsers === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH
    else process.env.PLAYWRIGHT_BROWSERS_PATH = savedBrowsers
  }
}

interface Declaration {
  readonly name: string
  readonly body: string
}

function codeLines(text: string): string[] {
  return text.split('\n').map((line) => {
    const trimmed = line.trim()
    return trimmed.startsWith('//') || trimmed.startsWith('*') ? '' : line
  })
}

function runTsDeclarations(): Declaration[] {
  const lines = codeLines(readFileSync(RUN_TS, 'utf8'))
  const header = /^(?:export\s+)?(?:async\s+)?(?:function|const|let|var|class|interface|type)\s+([A-Za-z_$][\w$]*)/
  const starts: Array<{ name: string; start: number }> = []
  lines.forEach((line, index) => {
    const match = header.exec(line)
    if (match !== null) starts.push({ name: match[1]!, start: index })
  })
  return starts.map((decl, index) => ({
    name: decl.name,
    body: lines.slice(decl.start, starts[index + 1]?.start ?? lines.length).join('\n'),
  }))
}

function productSources(): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!['__tests__', 'dist', 'node_modules'].includes(entry.name)) walk(join(dir, entry.name))
      } else if (entry.name.endsWith('.ts')) {
        found.push(join(dir, entry.name))
      }
    }
  }
  for (const pkg of readdirSync(PACKAGES_ROOT, { withFileTypes: true })) {
    const src = join(PACKAGES_ROOT, pkg.name, 'src')
    if (pkg.isDirectory() && existsSync(src)) walk(src)
  }
  return found
}

function sourcesNaming(pattern: RegExp): string[] {
  return productSources()
    .filter((file) => pattern.test(codeLines(readFileSync(file, 'utf8')).join('\n')))
    .map((file) => relative(PACKAGES_ROOT, file).split('\\').join('/'))
    .sort()
}

function occurrences(body: string, text: string): number {
  return body.split(text).length - 1
}

afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    rig.model.held.release()
    if (rig.child !== undefined && !exited(rig.child)) rig.child.kill('SIGKILL')
    await rig.model.close().catch(() => undefined)
    await rig.target.close().catch(() => undefined)
  }
}, 120_000)

afterAll(() => {
  cleanupTempRoots()
})

describe('Ctrl-C and hangup end agent-qa run through its own path', () => {
  it("one SIGINT ends a held direct run through agent-qa run's own path", async () => {
    expectOwnPath(await signalHeldRun(
      'direct SIGINT',
      '444-ctrl-c-direct-sigint',
      ['run', 'tests/populated.test.yaml'],
      'SIGINT',
    ))
  }, CELL_BUDGET_MS)

  it("one SIGINT ends a held suite run through agent-qa run's own path", async () => {
    expectOwnPath(await signalHeldRun(
      'suite SIGINT',
      '444-ctrl-c-suite-sigint',
      ['run', '--suite', 'suites/populated.suite.yaml'],
      'SIGINT',
    ))
  }, CELL_BUDGET_MS)

  it("one SIGTERM ends a held direct run through agent-qa run's own path", async () => {
    expectOwnPath(await signalHeldRun(
      'direct SIGTERM',
      '444-ctrl-c-direct-sigterm',
      ['run', 'tests/populated.test.yaml'],
      'SIGTERM',
    ))
  }, CELL_BUDGET_MS)

  it("one SIGHUP ends a held direct run through agent-qa run's own path", async () => {
    expectOwnPath(await signalHeldRun(
      'direct SIGHUP',
      '444-ctrl-c-direct-sighup',
      ['run', 'tests/populated.test.yaml'],
      'SIGHUP',
    ))
  }, CELL_BUDGET_MS)

  it("two SIGHUPs 1 ms apart end a held direct run through agent-qa run's own path", async () => {
    const facts = await signalHeldRun(
      'direct SIGHUP twice',
      '444-ctrl-c-direct-sighup-twice',
      ['run', 'tests/populated.test.yaml'],
      'SIGHUP',
      { afterMs: 1 },
    )
    const seen = JSON.stringify({ ...facts, output: facts.output?.slice(-1_500) }, null, 2)
    expect(facts.reached, seen).toBe('held')
    expect(facts.secondSignal?.aliveAtSend, `the second SIGHUP reached a live run\n${seen}`).toBe(true)
    expect(facts.secondSignal?.delivered, `the second SIGHUP was delivered\n${seen}`).toBe(true)
    expect(facts.secondSignal?.sentAfterMs ?? Infinity, seen).toBeLessThan(50)
    expectOwnPath(facts)
  }, CELL_BUDGET_MS)

  it("a dashboard run still launches its browser with Playwright's signal handling", async () => {
    const facts = await driveDashboardHold()
    const seen = JSON.stringify(facts, null, 2)
    expect(facts.error, seen).toBeUndefined()
    expect(facts.closeError, `the dashboard scene's close failed\n${seen}`).toBeUndefined()
    expect(facts.reached, seen).toBe('held')
    expect(facts.addedAtHold?.SIGINT ?? 0, `the browser launch added a SIGINT listener\n${seen}`).toBeGreaterThanOrEqual(1)
    expect(facts.addedAtHold?.SIGTERM ?? 0, `the browser launch added a SIGTERM listener\n${seen}`).toBeGreaterThanOrEqual(1)
    expect(facts.finished, seen).toBe(true)
    expect(facts.attachedAfterFinish, `the launch's listeners left with its browser\n${seen}`).toBe(0)
  }, CELL_BUDGET_MS)

  it("only agent-qa run's two producer calls hand the browser's signals to the host", () => {
    const declarations = runTsDeclarations()
    const naming = declarations.filter((decl) => decl.body.includes('hostOwnsSignals')).map((decl) => decl.name)
    const body = (name: string): string => declarations.find((decl) => decl.name === name)?.body ?? ''
    const facts = JSON.stringify({
      naming,
      executeSuites: occurrences(body('executeSuites'), 'hostOwnsSignals: true'),
      createRunCommand: occurrences(body('createRunCommand'), 'hostOwnsSignals: true'),
      produceMembersFromPatterns: occurrences(body('produceMembersFromPatterns'), 'hostOwnsSignals'),
      optionFiles: sourcesNaming(/hostOwnsSignals/u),
      playwrightOptionFiles: sourcesNaming(/handleSIGINT|handleSIGTERM|handleSIGHUP/u),
      hangUpRoute: Object.fromEntries(['executeSuites', 'createRunCommand'].map((name) => [name, {
        on: occurrences(body(name), SIGHUP_ON),
        off: occurrences(body(name), SIGHUP_OFF),
      }])),
    }, null, 2)
    expect([...naming].sort(), facts).toEqual([
      'DirectRunMemberProductionInput',
      'SuiteRunMemberProductionInput',
      'createPlatformAdapter',
      'createRunCommand',
      'executeSuites',
      'produceDirectRunMembers',
      'produceSuiteRunMembers',
    ])
    expect(body('produceMembersFromPatterns'), facts).not.toBe('')
    expect(occurrences(body('executeSuites'), 'hostOwnsSignals: true'), facts).toBe(1)
    expect(occurrences(body('createRunCommand'), 'hostOwnsSignals: true'), facts).toBe(1)
    expect(occurrences(body('produceMembersFromPatterns'), 'hostOwnsSignals'), facts).toBe(0)
    expect(sourcesNaming(/hostOwnsSignals/u), facts).toEqual(['cli/src/commands/run.ts', 'web/src/adapter.ts'])
    for (const name of ['executeSuites', 'createRunCommand']) {
      expect(occurrences(body(name), SIGHUP_ON), `${name} routes SIGHUP to the controller\n${facts}`).toBe(1)
      expect(occurrences(body(name), SIGHUP_OFF), `${name} removes its SIGHUP route\n${facts}`).toBe(1)
    }
    expect(sourcesNaming(/handleSIGINT|handleSIGTERM|handleSIGHUP/u), facts).toEqual(['web/src/adapter.ts'])
  })
})
