// Two real `agent-qa run` processes over one project and one runs.db, each parked at its browser
// launch until the cell releases it (442 D-05, D-15). It returns data and never asserts.

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DashboardDatabase, resolveDashboardDbPath } from '@vostride/agent-qa-dashboard'
import type { RunOwner, RunRow } from '@vostride/agent-qa-dashboard'

import { plantHoldableBrowser } from '../../commands/__tests__/holdable-browser.js'
import type { HoldableBrowser } from '../../commands/__tests__/holdable-browser.js'
import {
  CountingTarget,
  createInProcessFixture,
} from '../../composition/__tests__/in-process-run-fixture.js'
import type { InProcessFixture } from '../../composition/__tests__/in-process-run-fixture.js'
import {
  CLI_ENTRY,
  RUN_SERVICE_ANCHORED_BUILDS,
  buildFreshness,
  hermeticEnv,
} from './spawned-chat.js'
import { removeTempRoots } from '../temp-roots.js'

export interface CliRunExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
}

export interface StartedCliRun {
  readonly child: ChildProcess
  readonly pid: number
  readonly done: Promise<CliRunExit>
  exited(): boolean
  stderr(): string
}

export interface TwoRunProject extends InProcessFixture {
  readonly dbPath: string
  readonly db: DashboardDatabase
  close(): Promise<void>
}

/** This cell's view of the one planted browser: ordinals count from the cell's first arrival. */
export interface CellBrowsers {
  readonly browsersRoot: string
  arrivals(): string[]
  releasedOrdinals(): number[]
  release(ordinal: number): void
  releaseAll(): void
}

// populated-run-fixture.ts is not imported: it loads playwright-core at import, which fixes the
// browsers root before the plant below can pin it.
const RUN_OWNERSHIP_ANCHORED_BUILDS = [
  ...RUN_SERVICE_ANCHORED_BUILDS,
  { pkg: 'web', artifact: join('dist', 'index.js') },
  { pkg: 'runner-local', artifact: join('dist', 'index.js') },
]

export function refuseWithoutPosixRunLifecycle(): void {
  if (process.platform === 'win32') throw new Error('POSIX run lifecycle required; never skip')
  if (!existsSync(CLI_ENTRY)) throw new Error(`No built CLI at ${CLI_ENTRY}; run pnpm build`)
  const freshness = buildFreshness(RUN_OWNERSHIP_ANCHORED_BUILDS)
  if (freshness.missing.length > 0 || freshness.stale.length > 0) {
    throw new Error(`Run pnpm build before these cells: ${JSON.stringify(freshness)}`)
  }
}

// playwright fixes its browsers root on first use, so one process plants once and every cell
// shares that plant through its own ordinal offset.
let planted: HoldableBrowser | undefined
let plantedRoot: string | undefined

export function holdCellBrowsers(): CellBrowsers {
  if (planted === undefined) {
    plantedRoot = realpathSync(mkdtempSync(join(tmpdir(), 'run-ownership-browsers-')))
    planted = plantHoldableBrowser({ project: plantedRoot })
  }
  const browsers = planted
  const base = browsers.arrivals().length
  return {
    browsersRoot: browsers.browsersRoot,
    arrivals: () => browsers.arrivals().slice(base),
    releasedOrdinals: () =>
      browsers.releasedOrdinals().filter((n) => n >= base).map((n) => n - base),
    release: (ordinal) => { browsers.release(base + ordinal) },
    releaseAll: () => { browsers.releaseAll() },
  }
}

export function removePlantedCellBrowsers(): void {
  if (plantedRoot !== undefined) removeTempRoots([plantedRoot])
  plantedRoot = undefined
  planted = undefined
}

/** A direct test and a two-member suite over one counting target, with runs.db created up front. */
export async function twoRunProject(): Promise<TwoRunProject> {
  const target = new CountingTarget()
  await target.listen()
  try {
    const fixture = createInProcessFixture({
      origin: target.origin,
      environment: 'local',
      headedBrowser: true,
      secondSuiteMember: true,
    })
    appendFileSync(fixture.configPath, 'services:\n  dashboard: {}\n')
    const dbPath = resolveDashboardDbPath({ configDir: fixture.project })
    // Created once, before any child opens it, so the cells measure ownership and not bootstrap.
    const db = new DashboardDatabase({ dbPath })
    return {
      ...fixture,
      dbPath,
      db,
      close: async () => {
        db.close()
        await target.close()
      },
    }
  } catch (error) {
    await target.close()
    throw error
  }
}

export function startCliRun(
  project: InProcessFixture,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  budgetMs = 240_000,
): StartedCliRun {
  const childEnv: NodeJS.ProcessEnv = {
    ...hermeticEnv(project.project),
    CI: 'true',
    NO_COLOR: '1',
  }
  delete childEnv.AGENT_QA_RUN_ID
  Object.assign(childEnv, env)
  const child = spawn(process.execPath, [CLI_ENTRY, '--config', project.configPath, ...args], {
    cwd: project.project,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (child.pid === undefined) throw new Error('the CLI process did not start')
  let stdout = ''
  let stderr = ''
  child.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
  child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
  const budget = setTimeout(() => { child.kill('SIGKILL') }, budgetMs)
  const done = new Promise<CliRunExit>((settle, fail) => {
    child.once('error', fail)
    child.once('close', (code, signal) => settle({ code, signal, stdout, stderr }))
  }).finally(() => { clearTimeout(budget) })
  return {
    child,
    pid: child.pid,
    done,
    exited: () => child.exitCode !== null || child.signalCode !== null,
    stderr: () => stderr,
  }
}

// The second handle stamps the row with the given owner, as that owner's own process would.
export function seedRunningRow(dbPath: string, owner: RunOwner): string {
  const seeding = new DashboardDatabase({
    dbPath,
    runOwnership: { self: owner, probe: { isAlive: () => true, incarnationOf: () => undefined } },
  })
  try {
    const startedAt = new Date(Date.now() - 60_000).toISOString()
    const id = seeding.insertRun({
      name: `Seeded run owned by pid ${String(owner.pid)} on ${owner.host}`,
      status: 'running',
      duration: 0,
      startedAt,
      endedAt: startedAt,
    })
    seeding.insertRunArtifact({ runId: id, kind: 'test' })
    return id
  } finally {
    seeding.close()
  }
}

export async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  if (child.pid === undefined) throw new Error('the short-lived process did not start')
  const pid = child.pid
  await new Promise<void>((settle, fail) => {
    child.once('error', fail)
    child.once('close', () => { settle() })
  })
  return pid
}

export function readRow(project: TwoRunProject, id: string): RunRow {
  const row = project.db.getRun(id)
  if (row === undefined) throw new Error(`runs.db has no row ${id}`)
  return row
}

export function readOwner(project: TwoRunProject, id: string): RunOwner {
  const owner = project.db.readRunOwner(id)
  if (owner === undefined) throw new Error(`runs.db has no owner for ${id}`)
  return owner
}

export function rowIds(project: TwoRunProject): string[] {
  return project.db.getRuns({}).map((row) => row.id).sort()
}

export function runDirectory(project: InProcessFixture, runId: string): string {
  return join(project.agentQaRoot, 'runs', runId)
}

export function loggedEventTypes(project: InProcessFixture, runId: string): string[] {
  return readFileSync(join(runDirectory(project, runId), 'events.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => (JSON.parse(line) as { type: string }).type)
}
