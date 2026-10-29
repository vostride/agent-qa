// a crash or interrupt finalizes only its own run's row.

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { orphanSummary, ownedElsewhere, resolveRunOwnerHost } from '@vostride/agent-qa-dashboard'
import type { RunOwner } from '@vostride/agent-qa-dashboard'
import { resolveProcessIncarnation } from '@vostride/agent-qa-knowledge-local'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

import {
  exitedPid,
  holdCellBrowsers,
  loggedEventTypes,
  readOwner,
  readRow,
  refuseWithoutPosixRunLifecycle,
  removePlantedCellBrowsers,
  rowIds,
  runDirectory,
  seedRunningRow,
  startCliRun,
  twoRunProject,
} from './cli-run-fixture.js'
import type { CellBrowsers, StartedCliRun, TwoRunProject } from './cli-run-fixture.js'
import { removeInProcessFixtures } from '../../composition/__tests__/in-process-run-fixture.js'

const CELL_BUDGET_MS = 300_000
const ARRIVAL_BUDGET_MS = 120_000

interface Parked {
  readonly run: StartedCliRun
  readonly id: string
}

interface Cell {
  readonly project: TwoRunProject
  readonly browsers: CellBrowsers
  readonly runs: StartedCliRun[]
}

let cell: Cell | undefined

afterEach(async () => {
  const open = cell
  cell = undefined
  if (open === undefined) return
  open.browsers.releaseAll()
  for (const run of open.runs) if (!run.exited()) run.child.kill('SIGKILL')
  await Promise.allSettled(open.runs.map((run) => run.done))
  await open.project.close()
})
afterAll(() => {
  removeInProcessFixtures()
  removePlantedCellBrowsers()
})

async function openCell(): Promise<Cell> {
  refuseWithoutPosixRunLifecycle()
  const browsers = holdCellBrowsers()
  const project = await twoRunProject()
  cell = { project, browsers, runs: [] }
  return cell
}

function suiteArgs(project: TwoRunProject): string[] {
  return ['run', '--suite', project.suitePattern]
}

function directArgs(project: TwoRunProject): string[] {
  return ['run', project.testPattern]
}

async function until(condition: () => boolean, describeWait: () => string): Promise<void> {
  const startedAt = Date.now()
  while (!condition()) {
    if (Date.now() - startedAt > ARRIVAL_BUDGET_MS) throw new Error(`Timed out: ${describeWait()}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

// Started one at a time and each awaited to its own arrival, so ordinal N names run N.
async function startParked(at: Cell, args: string[], ordinal: number): Promise<Parked> {
  const known = rowIds(at.project)
  const run = startCliRun(at.project, args, { PLAYWRIGHT_BROWSERS_PATH: at.browsers.browsersRoot })
  at.runs.push(run)
  await until(
    () => {
      if (run.exited()) {
        throw new Error(
          `run ${String(ordinal)} exited before its browser arrived:\n${run.stderr()}`,
        )
      }
      return at.browsers.arrivals().length === ordinal + 1
    },
    () => `browser arrival ${String(ordinal)}`,
  )
  expect(at.browsers.arrivals()[ordinal]).toContain('--remote-debugging-pipe')
  let id = ''
  await until(
    () => {
      const fresh = rowIds(at.project).filter((row) => !known.includes(row))
      if (fresh.length !== 1) return false
      id = fresh[0]!
      return readRow(at.project, id).status === 'running'
    },
    () => `a running row for run ${String(ordinal)}`,
  )
  return { run, id }
}

function printedRunIds(stdout: string): string[] {
  return [...stdout.matchAll(/^Run ID: (\S+)$/gmu)].map((match) => match[1]!)
}

function expectUnfinalizedAndRunning(project: TwoRunProject, id: string): void {
  const row = readRow(project, id)
  expect(row.status).toBe('running')
  expect(row.failureSummary).toBeNull()
  expect(project.db.getRunArtifact(id)?.finalizedAt ?? null).toBeNull()
}

async function expectFinishesOnItsOwn(at: Cell, b: Parked, otherId: string): Promise<void> {
  const exit = await b.run.done
  expect(exit.code).toBe(1)
  const row = readRow(at.project, b.id)
  expect(row.status).toBe('failed')
  for (const foreign of ['Framework error', 'The browser closed before this test finished.']) {
    expect(row.failureSummary ?? '').not.toContain(foreign)
  }
  const artifact = at.project.db.getRunArtifact(b.id)
  expect(artifact?.finalizedAt ?? null).not.toBeNull()
  const payload = JSON.stringify(artifact!.payload)
  const foreignTexts = [
    'process-close', 'browser-disconnect', 'Framework error', 'The browser closed before this test finished.', otherId,
  ]
  for (const foreign of foreignTexts) expect(payload).not.toContain(foreign)
  const types = loggedEventTypes(at.project, b.id)
  const finishedAt = types.indexOf('runFinished')
  expect(finishedAt).toBeGreaterThan(0)
  expect(types.slice(0, finishedAt)).toContain('verdict')
  const postRun = (type: string): boolean =>
    type.startsWith('analysis') || type.startsWith('curation')
  expect(types.slice(finishedAt + 1).filter((type) => !postRun(type))).toEqual([])
  expect(existsSync(join(runDirectory(at.project, b.id), 'handoff.json'))).toBe(true)
  expect(existsSync(join(runDirectory(at.project, b.id), 'curation-tail-receipt.json'))).toBe(true)
  expect(exit.stdout).not.toContain(otherId)
}

async function interruptOneOfTwo(signal: 'SIGINT' | 'SIGTERM'): Promise<void> {
  const at = await openCell()
  const a = await startParked(at, suiteArgs(at.project), 0)
  const b = await startParked(at, suiteArgs(at.project), 1)
  expect(at.browsers.releasedOrdinals()).toEqual([])

  a.run.child.kill(signal)
  const aExit = await a.run.done
  expect(aExit.code).toBe(130)
  expect(readRow(at.project, a.id).status).toBe('cancelled')

  expect(at.browsers.releasedOrdinals()).toEqual([])
  expectUnfinalizedAndRunning(at.project, b.id)

  at.browsers.release(1)
  await expectFinishesOnItsOwn(at, b, a.id)
}

describe('each signal reaches only its own run', () => {
  it(
    "a crash of one run leaves the other run's row, artifact and post-run work intact",
    async () => {
      const at = await openCell()
      const a = await startParked(at, directArgs(at.project), 0)
      const b = await startParked(at, suiteArgs(at.project), 1)
      expect(at.browsers.releasedOrdinals()).toEqual([])

      at.browsers.release(0)
      const aExit = await a.run.done
      expect(aExit.code).toBe(2)
      expect(aExit.stderr).toContain('Framework error')
      expect(at.browsers.releasedOrdinals()).toEqual([0])
      expectUnfinalizedAndRunning(at.project, b.id)
      expect(printedRunIds(aExit.stdout)).toEqual([a.id])
      expect(aExit.stdout + aExit.stderr).not.toContain(b.id)

      at.browsers.release(1)
      await expectFinishesOnItsOwn(at, b, a.id)
    },
    CELL_BUDGET_MS,
  )

  it('SIGINT to one run cancels only that run', async () => {
    await interruptOneOfTwo('SIGINT')
  }, CELL_BUDGET_MS)

  it('SIGTERM to one run cancels only that run', async () => {
    await interruptOneOfTwo('SIGTERM')
  }, CELL_BUDGET_MS)

  it("each run's row names its own process", async () => {
    const at = await openCell()
    const a = await startParked(at, suiteArgs(at.project), 0)
    const b = await startParked(at, suiteArgs(at.project), 1)
    expect(at.browsers.releasedOrdinals()).toEqual([])
    expect(a.run.pid).not.toBe(b.run.pid)

    for (const parked of [a, b]) {
      const incarnation = resolveProcessIncarnation(parked.run.pid)
      expect(incarnation).toEqual(expect.any(String))
      expect(parked.run.exited()).toBe(false)
      expect(readOwner(at.project, parked.id)).toEqual({
        pid: parked.run.pid,
        incarnation,
        host: resolveRunOwnerHost(),
      })
    }

    at.browsers.release(0)
    at.browsers.release(1)
    expect((await a.run.done).code).toBe(1)
    expect((await b.run.done).code).toBe(1)
  }, CELL_BUDGET_MS)

  it('an interrupted single-test run finalizes its own row', async () => {
    const at = await openCell()
    const a = await startParked(at, directArgs(at.project), 0)
    expect(at.browsers.releasedOrdinals()).toEqual([])

    a.run.child.kill('SIGINT')
    const aExit = await a.run.done
    expect(aExit.code).toBe(130)
    expect(at.browsers.releasedOrdinals()).toEqual([])
    expect(readRow(at.project, a.id).status).toBe('cancelled')
  }, CELL_BUDGET_MS)
})

interface SeededRow {
  readonly id: string
  readonly owner: RunOwner
}

interface DashboardStartedMidRun {
  readonly at: Cell
  readonly b: Parked
  readonly exitedHere: SeededRow
  readonly reusedPid: SeededRow
  readonly otherHost: SeededRow
}

// This process's own start-time format, so the stamp reads as a reused pid rather than unknown.
function reusedPidStamp(): string {
  return `${String(resolveProcessIncarnation(process.pid)).split(':')[0]}:never`
}

function seeded(at: Cell, owner: RunOwner): SeededRow {
  const id = seedRunningRow(at.project.dbPath, owner)
  expect(readRow(at.project, id).status).toBe('running')
  expect(readOwner(at.project, id)).toEqual(owner)
  return { id, owner }
}

function expectOrphanFinalized(project: TwoRunProject, row: SeededRow): void {
  const sentence = orphanSummary(row.owner.pid)
  const read = readRow(project, row.id)
  expect(read.status).toBe('failed')
  expect(read.failureSummary).toBe(sentence)
  expect(project.db.getRunArtifact(row.id)?.payload.errors).toEqual([
    { code: 'owner-gone', phase: 'orphan-cleanup', message: sentence },
  ])
}

// The scene is the dashboard as `agent-qa dashboard` composes it, with the real run ownership. Its
// fixture loads playwright-core, so it is imported only after this process has planted its browser.
async function openSceneOver(at: Cell) {
  const { openDashboardScene } = await import('./run-doors-fixture.js')
  return openDashboardScene(
    {
      root: at.project.project,
      configPath: at.project.configPath,
      agentQaRoot: at.project.agentQaRoot,
      suitePath: at.project.suitePattern,
      testPath: at.project.testPattern,
      testId: at.project.directTestId,
    },
    { dbPath: at.project.dbPath },
  )
}

async function startDashboardWhileBRuns(): Promise<DashboardStartedMidRun> {
  const at = await openCell()
  const b = await startParked(at, suiteArgs(at.project), 0)
  expect(b.run.exited()).toBe(false)
  expect(at.browsers.releasedOrdinals()).toEqual([])
  expectUnfinalizedAndRunning(at.project, b.id)

  const here = resolveRunOwnerHost()
  const exitedHere = seeded(at, { pid: await exitedPid(), incarnation: 'ps-lstart:exited', host: here })
  const reusedPid = seeded(at, { pid: process.pid, incarnation: reusedPidStamp(), host: here })
  const otherHost = seeded(at, {
    pid: await exitedPid(),
    incarnation: 'ps-lstart:exited',
    host: 'elsewhere.invalid',
  })
  const bOwner = readOwner(at.project, b.id)
  const otherHostBefore = JSON.stringify({
    row: readRow(at.project, otherHost.id),
    artifact: at.project.db.getRunArtifact(otherHost.id),
  })

  const scene = await openSceneOver(at)
  try {
    expect(b.run.exited()).toBe(false)
    expect(at.browsers.releasedOrdinals()).toEqual([])
    expectUnfinalizedAndRunning(at.project, b.id)
    expect(readOwner(at.project, b.id)).toEqual(bOwner)
    expectOrphanFinalized(at.project, exitedHere)
    expectOrphanFinalized(at.project, reusedPid)
    expect(JSON.stringify({
      row: readRow(at.project, otherHost.id),
      artifact: at.project.db.getRunArtifact(otherHost.id),
    })).toBe(otherHostBefore)
    expect(readRow(at.project, otherHost.id).status).toBe('running')
  } finally {
    await scene.close()
  }
  return { at, b, exitedHere, reusedPid, otherHost }
}

describe('a dashboard started while a run is in flight', () => {
  it('a dashboard started while a run is in flight leaves it running', async () => {
    const { at, b } = await startDashboardWhileBRuns()
    at.browsers.release(0)
    expect((await b.run.done).code).toBe(1)
  }, CELL_BUDGET_MS)

  it('the run in flight still finishes as itself', async () => {
    const { at, b, exitedHere, reusedPid } = await startDashboardWhileBRuns()
    expectUnfinalizedAndRunning(at.project, b.id)

    at.browsers.release(0)
    await expectFinishesOnItsOwn(at, b, exitedHere.id)
    const row = readRow(at.project, b.id)
    const payload = JSON.stringify(at.project.db.getRunArtifact(b.id)!.payload)
    for (const foreign of [
      'ended before it finished',
      'owner-gone',
      'orphan-cleanup',
      reusedPid.id,
    ]) {
      expect(row.failureSummary ?? '').not.toContain(foreign)
      expect(payload).not.toContain(foreign)
    }
  }, CELL_BUDGET_MS)
})

describe('a dashboard cancel of a CLI-owned run', () => {
  it('a dashboard cancel leaves a CLI-owned run in flight untouched', async () => {
    const at = await openCell()
    const a = await startParked(at, suiteArgs(at.project), 0)
    expect(a.run.exited()).toBe(false)
    expect(at.browsers.releasedOrdinals()).toEqual([])
    expectUnfinalizedAndRunning(at.project, a.id)
    const aOwner = readOwner(at.project, a.id)
    expect(aOwner.pid).toBe(a.run.pid)

    const scene = await openSceneOver(at)
    try {
      const response = await fetch(
        `${scene.origin}/api/runs/${encodeURIComponent(a.id)}/cancel`,
        { method: 'POST' },
      )
      const body: unknown = await response.json()
      const after = readRow(at.project, a.id)
      expect(
        { status: response.status, body, rowStatus: after.status },
        `the row read '${after.status}' right after the cancel, failure summary ${
          JSON.stringify(after.failureSummary)
        }`,
      ).toEqual({
        status: 409,
        body: {
          error: ownedElsewhere(a.run.pid),
          reason: 'owned-by-live-process',
          ownerPid: a.run.pid,
        },
        rowStatus: 'running',
      })
      expect(a.run.exited()).toBe(false)
      expect(at.browsers.releasedOrdinals()).toEqual([])
      expectUnfinalizedAndRunning(at.project, a.id)
      expect(readOwner(at.project, a.id)).toEqual(aOwner)
    } finally {
      await scene.close()
    }

    at.browsers.release(0)
    await expectFinishesOnItsOwn(at, a, 'The run was cancelled before this test finished.')
    expect(readRow(at.project, a.id).failureSummary ?? '').not.toContain('The run was cancelled before this test finished.')
    expect(JSON.stringify(at.project.db.getRunArtifact(a.id)!.payload))
      .not.toContain('Run cancellation requested')
  }, CELL_BUDGET_MS)
})
