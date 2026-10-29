import { randomUUID } from 'node:crypto'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect } from 'vitest'

import { DAEMON_EVENTS_FILE } from '../../daemon/events.js'
import { removeTempRoots } from '../temp-roots.js'

const PACKAGE_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const JITI = join(PACKAGE_ROOT, 'node_modules', '.bin', 'jiti')
const CHILD_FIXTURES: Record<FencingChildRole, string> = {
  'paused-drainer': fileURLToPath(new URL('./paused-drainer.fixture.ts', import.meta.url)),
  'reclaiming-daemon': fileURLToPath(new URL('./reclaiming-daemon.fixture.ts', import.meta.url)),
}

export const LEG_TIMEOUT_MS = 180_000
export const CHILD_TIMEOUT_MS = 120_000
export const MARKER_TIMEOUT_MS = 90_000

export const FENCING_ENV = {
  role: 'AGENT_QA_FENCING_ROLE',
  root: 'AGENT_QA_FENCING_ROOT',
  fixture: 'AGENT_QA_FENCING_FIXTURE',
  marker: 'AGENT_QA_FENCING_MARKER',
  permit: 'AGENT_QA_FENCING_PERMIT',
  report: 'AGENT_QA_FENCING_REPORT',
  readyMarker: 'AGENT_QA_FENCING_READY_MARKER',
  committedMarker: 'AGENT_QA_FENCING_COMMITTED_MARKER',
  control: 'AGENT_QA_FENCING_CONTROL',
  pauseAt: 'AGENT_QA_FENCING_PAUSE_AT',
  /** Seam-small takeover for the reclaiming daemon's own acquisition; production never sets it. */
  takeoverMs: 'AGENT_QA_FENCING_TAKEOVER_MS',
  /** Acquisition budget for the reclaiming daemon; the escalated reclaim must fit inside it. */
  acquireDeadlineMs: 'AGENT_QA_FENCING_ACQUIRE_DEADLINE_MS',
  /** JSONL of every reconcile report the reclaiming daemon's drain passes produced. */
  reconcileLog: 'AGENT_QA_FENCING_RECONCILE_LOG',
} as const

export type FencingChildRole = 'paused-drainer' | 'reclaiming-daemon'
export type FencingPauseAt =
  | 'beforeCommitAuthorityEntry'
  | 'afterIntentWritten'
  | 'afterFinalAuthorityCompare'
  | 'publish-rename'
  | 'afterBundlePublished'

export interface FencingPaths {
  readonly root: string
  readonly agentQaRoot: string
  readonly knowledgeRoot: string
  readonly fixture: string
  readonly marker: string
  readonly permit: string
  readonly drainerReport: string
  readonly daemonReport: string
  readonly readyMarker: string
  readonly committedMarker: string
  readonly reconcileLog: string
}

export interface RunningChild {
  readonly child: ChildProcess
  readonly exited: Promise<[number | null, string | null]>
  output(): string
}

const temporaryRoots: string[] = []

export function makeRoot(label: string): FencingPaths {
  const root = mkdtempSync(join(tmpdir(), `agent-fencing-${label}-`))
  temporaryRoots.push(root)
  return {
    root,
    agentQaRoot: join(root, '.agent-qa'),
    knowledgeRoot: join(root, 'agent-qa-knowledge'),
    fixture: join(root, 'candidate.fixture.json'),
    marker: join(root, 'paused.intent-durable.marker.json'),
    permit: join(root, 'resume.permit.json'),
    drainerReport: join(root, 'paused-drainer.report.json'),
    daemonReport: join(root, 'reclaiming-daemon.report.json'),
    readyMarker: join(root, 'daemon.ready.marker.json'),
    committedMarker: join(root, 'daemon.committed.marker.json'),
    reconcileLog: join(root, 'daemon.reconcile-reports.jsonl'),
  }
}

export function cleanupFencingRoots(): void {
  removeTempRoots(temporaryRoots.splice(0))
}

function bestEffortFsyncDirectory(dir: string): void {
  let fd: number | undefined
  try {
    fd = openSync(dir, 'r')
    fsyncSync(fd)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (!['EINVAL', 'EISDIR', 'EPERM', 'ENOTSUP'].includes(code ?? '')) throw error
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** Durable parent/child protocol: fsync bytes, rename in-directory, then fsync the directory. */
export function writeDurableJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${randomUUID()}`
  let fd: number | undefined
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeFileSync(fd, `${JSON.stringify(value)}\n`, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, file)
    bestEffortFsyncDirectory(dirname(file))
  } finally {
    if (fd !== undefined) closeSync(fd)
    rmSync(temporary, { force: true })
  }
}

export function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
}

export function startChild(
  role: FencingChildRole,
  paths: FencingPaths,
  extraEnv: Record<string, string> = {},
): RunningChild {
  const report = role === 'paused-drainer' ? paths.drainerReport : paths.daemonReport
  const child = spawn(
    JITI,
    [CHILD_FIXTURES[role]],
    {
      cwd: PACKAGE_ROOT,
      env: {
        ...process.env,
        [FENCING_ENV.role]: role,
        [FENCING_ENV.root]: paths.root,
        [FENCING_ENV.fixture]: paths.fixture,
        [FENCING_ENV.marker]: paths.marker,
        [FENCING_ENV.permit]: paths.permit,
        [FENCING_ENV.report]: report,
        [FENCING_ENV.readyMarker]: paths.readyMarker,
        [FENCING_ENV.committedMarker]: paths.committedMarker,
        [FENCING_ENV.reconcileLog]: paths.reconcileLog,
        AGENT_QA_MODEL_CACHE_DIR: join(paths.root, 'empty-model-cache'),
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  if (child.stdout === null || child.stderr === null) {
    throw new Error('fencing child pipes were not created')
  }
  let captured = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => { captured += chunk })
  child.stderr.on('data', (chunk: string) => { captured += chunk })
  return {
    child,
    exited: once(child, 'exit') as Promise<[number | null, string | null]>,
    output: () => captured,
  }
}

export function startPausedDrainer(
  paths: FencingPaths,
  pauseAt: FencingPauseAt,
): RunningChild {
  return startChild('paused-drainer', paths, {
    [FENCING_ENV.pauseAt]: pauseAt,
  })
}

export interface ReclaimingDaemonSeams {
  /** Seam-small takeover so the escalation fires without a real 45 s wait. */
  readonly mutationLockTakeoverMs: number
  /** Acquisition budget the whole escalated reclaim must complete inside. */
  readonly acquireDeadlineMs: number
}

/**
 * A reclaiming daemon whose own lease acquisition carries the seam-small takeover window.
 *
 * The seams reach `acquireWriterLease` through the daemon host's `operations` bag, which is a
 * test-only override point: production still calls the pinned constants. Passing them as env
 * rather than hard-coding them in the child keeps the shipped legs (which pass neither) on the
 * production defaults.
 */
export function startReclaimingDaemon(
  paths: FencingPaths,
  seams: ReclaimingDaemonSeams,
): RunningChild {
  return startChild('reclaiming-daemon', paths, {
    [FENCING_ENV.takeoverMs]: String(seams.mutationLockTakeoverMs),
    [FENCING_ENV.acquireDeadlineMs]: String(seams.acquireDeadlineMs),
  })
}

/**
 * The kernel's own view of a pid's run state, read through `ps`.
 *
 * `T` is the premise every SIGSTOP leg rests on and the one fact no in-process assertion can
 * supply: the child really is stopped, not merely slow. Read from outside this process so the
 * answer cannot come from the harness's own bookkeeping.
 */
export function processStateChar(pid: number): string | undefined {
  const observed = spawnSync('ps', ['-p', String(pid), '-o', 'state='], {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (observed.error !== undefined || observed.status !== 0) return undefined
  const state = (observed.stdout ?? '').trim()
  return state === '' ? undefined : state
}

/** Wait for the parent to reap a child, so `signalCode` reflects who actually killed it. */
export async function waitForChildTermination(
  running: RunningChild,
  selector: string,
): Promise<{ code: number | null; signal: string | null }> {
  const deadline = Date.now() + MARKER_TIMEOUT_MS
  while (running.child.exitCode === null && running.child.signalCode === null) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${selector}:\n${running.output()}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return { code: running.child.exitCode, signal: running.child.signalCode }
}

export function readDaemonEvents(agentQaRoot: string): Record<string, unknown>[] {
  const file = join(agentQaRoot, DAEMON_EVENTS_FILE)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

export async function waitForDaemonEvent(
  running: RunningChild,
  agentQaRoot: string,
  predicate: (event: Record<string, unknown>) => boolean,
  selector: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + MARKER_TIMEOUT_MS
  while (true) {
    const found = readDaemonEvents(agentQaRoot).find(predicate)
    if (found !== undefined) return found
    if (running.child.exitCode !== null || running.child.signalCode !== null) {
      throw new Error(`fencing child exited before ${selector}:\n${running.output()}`)
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${selector}:\n${running.output()}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/**
 * Every reconcile report the reclaiming daemon's drain passes produced, in pass order.
 *
 * A trailing line that does not parse is a read that landed mid-append, not a malformed report:
 * the writer is another process appending while this one polls. It is dropped rather than thrown
 * on, so the caller simply has not seen that pass yet.
 */
export function readReconcileReports(paths: FencingPaths): Record<string, unknown>[] {
  if (!existsSync(paths.reconcileLog)) return []
  const reports: Record<string, unknown>[] = []
  for (const line of readFileSync(paths.reconcileLog, 'utf8').split('\n').filter(Boolean)) {
    try {
      reports.push(JSON.parse(line) as Record<string, unknown>)
    } catch {
      break
    }
  }
  return reports
}

/**
 * Wait for the reclaiming daemon to have COMPLETED `count` reconcile passes.
 *
 * The daemon's job-lifecycle events are emitted from inside `drainQueue`, while its reconcile
 * report is recorded when that same call returns — so a leg that keyed off `job-completed` was
 * reading the log strictly before the pass it wanted could have been written. That window is
 * invisible on an idle machine and reliably open under a loaded suite.
 */
export async function waitForReconcilePasses(
  running: RunningChild,
  paths: FencingPaths,
  count: number,
  selector: string,
): Promise<Record<string, unknown>[]> {
  const deadline = Date.now() + MARKER_TIMEOUT_MS
  while (true) {
    const reports = readReconcileReports(paths)
    if (reports.length >= count) return reports
    if (running.child.exitCode !== null || running.child.signalCode !== null) {
      throw new Error(`fencing child exited before ${selector}:\n${running.output()}`)
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${selector} (${reports.length}/${count}):\n${running.output()}`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

export async function killIfRunning(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
}

async function awaitChildExit(running: RunningChild): Promise<{
  code: number | null
  signal: string | null
}> {
  const timer = setTimeout(() => running.child.kill('SIGKILL'), CHILD_TIMEOUT_MS)
  try {
    const [code, signal] = await running.exited
    return { code, signal }
  } finally {
    clearTimeout(timer)
  }
}

export async function waitForMarker(
  running: RunningChild,
  markerPath: string,
  selector: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + MARKER_TIMEOUT_MS
  while (!existsSync(markerPath)) {
    if (running.child.exitCode !== null || running.child.signalCode !== null) {
      throw new Error(`fencing child exited before ${selector}:\n${running.output()}`)
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${selector}:\n${running.output()}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return readJson(markerPath)
}

export function sendSignalWhileAlive(running: RunningChild, signal: NodeJS.Signals): void {
  expect(running.child.exitCode, `child must be alive before ${signal}`).toBeNull()
  expect(running.child.signalCode).toBeNull()
  expect(running.child.kill(signal)).toBe(true)
}

export async function completeChildExpectingRefusal(
  running: RunningChild,
  reportPath: string,
): Promise<Record<string, unknown>> {
  try {
    const { code, signal } = await awaitChildExit(running)
    expect(
      { exitedNonZero: code !== 0, signal },
      `child must report its expected refusal and exit non-zero:\n${running.output()}`,
    ).toEqual({ exitedNonZero: true, signal: null })
    const report = readJson(reportPath)
    expect(report.failed, `child report: ${JSON.stringify(report)}`).toBe(true)
    expect(report.pid).not.toBe(process.pid)
    const outcomes = report.outcomes as unknown[]
    expect(Array.isArray(outcomes)).toBe(true)
    expect(outcomes.length).toBeGreaterThan(0)
    for (const outcome of outcomes as Record<string, unknown>[]) {
      expect(outcome.kind).toBe('abandoned-stale-epoch')
      expect(outcome.observedEpoch).toEqual(expect.any(Number))
    }
    return report
  } finally {
    await killIfRunning(running.child)
  }
}

export async function completeChildSuccessfully(
  running: RunningChild,
  reportPath: string,
): Promise<Record<string, unknown>> {
  try {
    const { code, signal } = await awaitChildExit(running)
    expect(
      { code, signal, output: code === 0 ? '' : running.output() },
      'child must exit cleanly',
    ).toMatchObject({ code: 0, signal: null })
    const report = readJson(reportPath)
    expect(report.failed, `child report: ${JSON.stringify(report)}`).toBe(false)
    expect(report.pid).not.toBe(process.pid)
    return report
  } finally {
    await killIfRunning(running.child)
  }
}
