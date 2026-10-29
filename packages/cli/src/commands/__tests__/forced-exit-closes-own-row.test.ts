import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { DashboardDatabase } from '@vostride/agent-qa-dashboard'
import { generateRunId } from '@vostride/agent-qa-ids'
import type { RunEventEnvelope } from '@vostride/agent-qa-schema'

import { composeRunOwnership } from '../../composition/run-owner-probe.js'
import * as runModule from '../run.js'
import { createRunRecord, doorRunAttributes, type RunRecord } from '../run.js'
import { createShutdownController, type ShutdownControllerDeps } from '../shutdown-controller.js'

const STOPPED = 'The run was stopped before it reached a verdict.'
const RUN_SOURCE = readFileSync(fileURLToPath(new URL('../run.ts', import.meta.url)), 'utf8')
const CONTROLLER_SOURCE = readFileSync(
  fileURLToPath(new URL('../shutdown-controller.ts', import.meta.url)),
  'utf8',
)

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function closeAtForcedExit(record: RunRecord): void {
  const close = (runModule as Record<string, unknown>).closeOwnRowAtForcedExit
  expect(typeof close, 'run.ts exports no closeOwnRowAtForcedExit').toBe('function')
  ;(close as (record: RunRecord) => void)(record)
}

function configDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-qa-444-signal-asks-')))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, '.agent-qa'), { recursive: true })
  return dir
}

async function startedRecord(dir: string, runId = generateRunId()) {
  const record = createRunRecord({ attributes: doorRunAttributes('cli'), warn: () => {} })
  cleanups.push(() => record.close())
  await record.open({ runId, configDir: dir })
  const subscriber = record.subscriber({
    mask: (text) => text,
    members: [{ testId: 't-a', name: 'Member A', filePath: 'tests/a.yaml' }],
  })
  let seq = 0
  const send = (type: RunEventEnvelope['type'], payload: Record<string, unknown>): void => {
    seq += 1
    subscriber.handler({ seq, ts: seq, runId, type, payload } as RunEventEnvelope)
  }
  send('runStarted', { memberTestCount: 1 })
  send('testStarted', { testId: 't-a', testIndex: 0, name: 'Member A', filePath: 'tests/a.yaml' })
  return { record, runId, send, subscriber }
}

function rawRow(dbPath: string, runId: string): string {
  const db = new DatabaseSync(dbPath)
  try {
    return JSON.stringify(db.prepare('SELECT * FROM runs WHERE id = ?').all(runId))
  } finally {
    db.close()
  }
}

const count = (text: string, needle: string): number => text.split(needle).length - 1

describe('C444-SIGNAL-ASKS', () => {
  it('the first signal cancels the session and arms the grace timer, and nothing else', () => {
    const deps: ShutdownControllerDeps = {
      cancel: vi.fn(),
      exit: vi.fn(),
      setExitCode: vi.fn(),
      armGrace: vi.fn(),
    }
    const passed = { ...deps, finalizeOwnRun: vi.fn() }
    const controller = createShutdownController(passed)

    controller.handleSignal()

    expect(deps.cancel).toHaveBeenCalledTimes(1)
    expect(deps.armGrace).toHaveBeenCalledTimes(1)
    expect(deps.setExitCode).toHaveBeenCalledWith(130)
    expect(deps.exit).not.toHaveBeenCalled()
    expect(passed.finalizeOwnRun, 'the first signal reached a row writer').not.toHaveBeenCalled()
  })

  it("a forced exit closes this process's own running row as cancelled with the plain sentence", async () => {
    const dir = configDir()
    const { record, runId } = await startedRecord(dir)
    expect(record.ownRowId(), 'the record claimed no row').toBe(runId)
    expect(record.db?.getRun(runId)?.status).toBe('running')

    closeAtForcedExit(record)

    const row = record.db?.getRun(runId)
    expect(row?.status).toBe('cancelled')
    expect(row?.failureSummary).toBe(STOPPED)
    expect(row?.endedAt, 'the forced exit wrote no end time').toBeTruthy()
    expect(record.db?.listRunningRunOwners()).toEqual([])
  })

  it('a forced exit after the verdict writes nothing', async () => {
    const dir = configDir()
    const { record, runId, send } = await startedRecord(dir)
    send('testFinished', { testId: 't-a', testIndex: 0, outcome: 'failed', durationMs: 10 })
    send('verdict', { verdict: 'failed' })
    const atVerdict = record.db?.getRun(runId)
    expect(atVerdict?.status).toBe('failed')
    expect(atVerdict?.endedAt, 'the verdict wrote no end time').toBeTruthy()
    const before = rawRow(join(dir, '.agent-qa', 'runs.db'), runId)

    closeAtForcedExit(record)

    expect(rawRow(join(dir, '.agent-qa', 'runs.db'), runId)).toBe(before)
    expect(record.db?.getRun(runId)?.failureSummary).not.toBe(STOPPED)
  })

  it('a forced exit never touches a row another process owns', async () => {
    const dir = configDir()
    const dbPath = join(dir, '.agent-qa', 'runs.db')
    const elsewhere = new DashboardDatabase({
      dbPath,
      runOwnership: {
        self: { pid: 4343, incarnation: 'proc-starttime:elsewhere', host: 'elsewhere' },
        probe: { isAlive: () => true, incarnationOf: () => undefined },
      },
    })
    cleanups.push(() => elsewhere.close())
    const foreignId = generateRunId()
    elsewhere.insertRun({
      id: foreignId,
      name: 'owned elsewhere',
      status: 'running',
      duration: 0,
      startedAt: '2026-10-17T00:00:00.000Z',
      endedAt: '2026-10-17T00:00:00.000Z',
      platform: 'web',
    })
    const foreignBefore = rawRow(dbPath, foreignId)

    const own = await startedRecord(dir)
    const claimedId = generateRunId()
    const claimed = createRunRecord({ attributes: doorRunAttributes('cli'), warn: () => {} })
    cleanups.push(() => claimed.close())
    await claimed.open({ runId: claimedId, configDir: dir })
    const subscriber = claimed.subscriber({
      mask: (text) => text,
      members: [{ testId: 't-b', name: 'Member B', filePath: 'tests/b.yaml' }],
    })
    elsewhere.insertRun({
      id: claimedId,
      name: 'claimed elsewhere first',
      status: 'running',
      duration: 0,
      startedAt: '2026-10-17T00:00:00.000Z',
      endedAt: '2026-10-17T00:00:00.000Z',
      platform: 'web',
    })
    const claimedBefore = rawRow(dbPath, claimedId)
    subscriber.handler({ seq: 1, ts: 1, runId: claimedId, type: 'runStarted', payload: { memberTestCount: 1 } } as RunEventEnvelope)
    expect(claimed.ownRowId(), 'the record claimed a row another process wrote').toBeUndefined()

    closeAtForcedExit(claimed)
    closeAtForcedExit(own.record)

    expect(rawRow(dbPath, foreignId), 'the forced exit changed a foreign row').toBe(foreignBefore)
    expect(rawRow(dbPath, claimedId), 'the forced exit changed a foreign row').toBe(claimedBefore)
    expect(own.record.db?.getRun(own.runId)?.status).toBe('cancelled')
    const running = new DashboardDatabase({ dbPath, runOwnership: composeRunOwnership() })
    cleanups.push(() => running.close())
    expect(running.listRunningRunOwners().map((row) => row.id).sort()).toEqual([foreignId, claimedId].sort())
  })

  it('both agent-qa run sites force-exit through the close', () => {
    expect(count(RUN_SOURCE, 'export function closeOwnRowAtForcedExit')).toBe(1)
    expect(count(RUN_SOURCE, 'exit: forceExit')).toBe(2)
    expect(count(RUN_SOURCE, 'setTimeout(() => forceExit(130), cancelGraceMs())')).toBe(2)
    expect(count(RUN_SOURCE, 'closeOwnRowAtForcedExit(record)')).toBe(2)
    for (const writer of ['finalizeOwnRun', 'closeOwnRun', 'updateRun', 'finalizeRunArtifact']) {
      expect(CONTROLLER_SOURCE, `the controller names ${writer}`).not.toContain(writer)
    }
  })
})
