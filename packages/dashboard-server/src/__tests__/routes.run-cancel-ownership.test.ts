import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DashboardDatabase } from '../db/database.js'
import { createRunOwnerHostResolver } from '../db/run-owner-host.js'
import { orphanSummary, ownedElsewhere } from '../db/run-owner.js'
import type { RunOwner, RunOwnerProbe, RunOwnership } from '../db/run-owner.js'
import type { ExecutionBackend } from '../execution/execution-backend.js'
import { JobQueue } from '../queue/job-queue.js'
import { startServer } from '../server/server.js'

const HOST = 'h'
const SELF: RunOwner = { pid: 1000, incarnation: 'inc-self', host: HOST }
const ALIVE: RunOwner = { pid: 3001, incarnation: 'inc-3001', host: HOST }
const GONE: RunOwner = { pid: 3002, incarnation: 'inc-3002', host: HOST }
const OTHER_HOST: RunOwner = { pid: 3003, incarnation: 'inc-3003', host: 'elsewhere.invalid' }
const UNREADABLE: RunOwner = { pid: 3004, incarnation: 'inc-3004', host: HOST }
const RACED: RunOwner = { pid: 3005, incarnation: 'inc-3005', host: HOST }
const UNREAD_SELF: RunOwner = { pid: SELF.pid, incarnation: null, host: HOST }

const STOP_REQUESTED = {
  outcome: 'stop-requested',
  message: 'Stop requested. The run will end with its own verdict.',
}
const CLEANUP_LINE = /run\(s\) whose agent-qa process had ended/

let beforeProbe: (pid: number) => void = () => undefined

const probe: RunOwnerProbe = {
  isAlive: (pid) => {
    beforeProbe(pid)
    return pid !== GONE.pid && pid !== RACED.pid
  },
  incarnationOf: (pid) => (pid === ALIVE.pid ? 'inc-3001' : undefined),
}

class RecordingBackend extends EventEmitter {
  readonly killed: string[] = []
  execute = (): void => undefined
  kill = (runId: string): boolean => {
    this.killed.push(runId)
    return true
  }
  killAll = (): void => undefined
  getActiveExecutions = (): [] => []
}

let dir: string
let dbPath: string
let configPath: string
let reader: DashboardDatabase
let queue: JobQueue
let stopRequests: string[]
const started: Array<{ close: () => void }> = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-qa-442-cancel-'))
  dbPath = join(dir, 'runs.db')
  configPath = join(dir, 'agent-qa.config.yaml')
  writeFileSync(configPath, 'testDir: tests\n')
  reader = new DashboardDatabase({ dbPath, runOwnership: { self: SELF, probe } })
  stopRequests = []
  queue = new JobQueue({
    db: reader,
    requestStop: (runId) => {
      stopRequests.push(runId)
      return true
    },
  })
})

afterEach(() => {
  beforeProbe = () => undefined
  while (started.length > 0) started.pop()?.close()
  queue.stop()
  reader.close()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

function seedRunning(owner: RunOwner, name: string, runId?: string): string {
  const seeding = new DashboardDatabase({ dbPath, runOwnership: { self: owner, probe } })
  try {
    const startedAt = new Date(Date.now() - 60_000).toISOString()
    const id = seeding.insertRun({
      id: runId,
      name,
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

function snapshotOf(id: string): string {
  return JSON.stringify({
    row: reader.getRun(id),
    owner: reader.readRunOwner(id),
    artifact: reader.getRunArtifact(id),
  })
}

interface Dashboard {
  readonly origin: string
  readonly backend: RecordingBackend
  logged(): string[]
}

async function startDashboard(ownership: RunOwnership = { self: SELF, probe }): Promise<Dashboard> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  const backend = new RecordingBackend()
  const db = new DashboardDatabase({ dbPath, runOwnership: ownership })
  const handle = await startServer({
    declaredSecretMask: (text) => text,
    db,
    port: 0,
    configPath,
    executionBackend: backend as unknown as ExecutionBackend,
  })
  started.push(handle)
  const { port } = handle.server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    backend,
    logged: () => log.mock.calls.map((call) => String(call[0])),
  }
}

async function cancelOver(
  dashboard: Dashboard,
  id: string,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${dashboard.origin}/api/runs/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
  })
  const text = await response.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch { /* a non-JSON body is compared as text */ }
  return { status: response.status, body }
}

function expectOrphanFinalized(id: string, pid: number): void {
  const sentence = orphanSummary(pid)
  const row = reader.getRun(id)!
  expect(row.status).toBe('failed')
  expect(row.failureSummary).toBe(sentence)
  expect(reader.getRunArtifact(id)?.payload.errors).toEqual([
    { code: 'owner-gone', phase: 'orphan-cleanup', message: sentence },
  ])
}

function refusalOf(owner: RunOwner) {
  return {
    kind: 'owned-elsewhere',
    message: ownedElsewhere(owner.pid),
    ownerPid: owner.pid,
  }
}

function refusalBodyOf(owner: RunOwner) {
  return {
    error: ownedElsewhere(owner.pid),
    reason: 'owned-by-live-process',
    ownerPid: owner.pid,
  }
}

describe('a cancel on a run another process owns', () => {
  it("another live process's run is refused and nothing is written", async () => {
    const byQueue = seedRunning(ALIVE, 'Alive owner, queue')
    const byRoute = seedRunning(ALIVE, 'Alive owner, route')
    const before = [byQueue, byRoute].map(snapshotOf)

    expect(queue.cancel(byQueue)).toEqual(refusalOf(ALIVE))
    expect(stopRequests).toEqual([])

    const dashboard = await startDashboard()
    expect(await cancelOver(dashboard, byRoute)).toEqual({
      status: 409,
      body: refusalBodyOf(ALIVE),
    })
    expect(dashboard.backend.killed).toEqual([])
    expect([byQueue, byRoute].map(snapshotOf)).toEqual(before)
    for (const id of [byQueue, byRoute]) expect(reader.getRun(id)?.status).toBe('running')
  })

  it('an owner whose liveness cannot be shown is refused the same way', async () => {
    const owners = [OTHER_HOST, UNREADABLE]
    const ids = owners.map((owner) => seedRunning(owner, `Unknown owner ${String(owner.pid)}`))
    const before = ids.map(snapshotOf)

    const dashboard = await startDashboard()
    for (const [index, owner] of owners.entries()) {
      expect(queue.cancel(ids[index]!)).toEqual(refusalOf(owner))
      expect(await cancelOver(dashboard, ids[index]!)).toEqual({
        status: 409,
        body: refusalBodyOf(owner),
      })
    }
    expect(stopRequests).toEqual([])
    expect(dashboard.backend.killed).toEqual([])
    expect(ids.map(snapshotOf)).toEqual(before)
  })

  it('the dashboard still cancels its own queued and running runs', async () => {
    const pending = queue.enqueue({ name: 'Queued' })
    expect(queue.cancel(pending)).toEqual({ kind: 'cancelled' })
    expect(reader.getRun(pending)?.status).toBe('cancelled')
    expect(reader.getRunArtifact(pending)?.payload.errors?.[0]).toMatchObject({
      code: 'cancelled',
      message: 'Run cancelled before execution',
    })

    // 2026-10-17 (444-06, D-11): a running own row is asked to stop; its verdict is the run's.
    const ownByQueue = seedRunning(SELF, 'Own run, queue')
    expect(queue.cancel(ownByQueue)).toEqual({ kind: 'stop-requested' })
    expect(reader.getRun(ownByQueue)?.status).toBe('running')
    expect(stopRequests).toEqual([ownByQueue])

    const ownByRoute = seedRunning(SELF, 'Own run, route')
    const dashboard = await startDashboard()
    expect(await cancelOver(dashboard, ownByRoute)).toEqual({ status: 202, body: STOP_REQUESTED })
    const row = reader.getRun(ownByRoute)!
    expect(row.status).toBe('running')
    expect(row.failureSummary ?? null).toBeNull()
    expect(reader.getRunArtifact(ownByRoute)?.payload.errors ?? []).toEqual([])
    expect(dashboard.backend.killed).toEqual([ownByRoute])
  })
})

describe('a cancel on an orphaned run', () => {
  it('a cancel on a run whose process is gone finalizes it as an orphan', async () => {
    const dashboard = await startDashboard()
    const byQueue = seedRunning(GONE, 'Gone owner, queue')
    const byRoute = seedRunning(GONE, 'Gone owner, route')

    expect(queue.cancel(byQueue)).toEqual({
      kind: 'orphan-finalized',
      message: orphanSummary(GONE.pid),
    })
    expect(await cancelOver(dashboard, byRoute)).toEqual({
      status: 200,
      body: { cancelled: false, message: orphanSummary(GONE.pid) },
    })
    for (const id of [byQueue, byRoute]) expectOrphanFinalized(id, GONE.pid)
    expect(reader.getRun(byRoute)?.failureSummary).not.toBe('The run was cancelled before this test finished.')
    expect(stopRequests).toEqual([])
    expect(dashboard.backend.killed).toEqual([])
  })

  it('a cancel after the orphan was finalized writes nothing', async () => {
    const dashboard = await startDashboard()
    const id = seedRunning(GONE, 'Gone owner')
    expect((await cancelOver(dashboard, id)).status).toBe(200)
    expectOrphanFinalized(id, GONE.pid)
    const after = snapshotOf(id)

    expect(await cancelOver(dashboard, id)).toEqual({
      status: 200,
      body: { outcome: 'finished', status: 'failed', message: 'This run already finished: failed.' },
    })
    expect(queue.cancel(id)).toEqual({ kind: 'finished', status: 'failed' })
    expect(snapshotOf(id)).toBe(after)
    expect(dashboard.backend.killed).toEqual([])
  })

  it('a cancel and a dashboard start over one orphan finalize it once', async () => {
    const racedByStart = seedRunning(RACED, 'Raced by a dashboard start')
    beforeProbe = (pid) => {
      if (pid !== RACED.pid) return
      beforeProbe = () => undefined
      const other = new DashboardDatabase({ dbPath, runOwnership: { self: SELF, probe } })
      try {
        expect(other.finalizeOrphanRun(racedByStart, RACED)).toBe(true)
      } finally {
        other.close()
      }
    }
    expect(queue.cancel(racedByStart)).toEqual({ kind: 'finished', status: 'failed' })
    expectOrphanFinalized(racedByStart, RACED.pid)

    const cancelledFirst = seedRunning(GONE, 'Cancelled before a dashboard start')
    expect(queue.cancel(cancelledFirst).kind).toBe('orphan-finalized')
    const after = snapshotOf(cancelledFirst)
    const dashboard = await startDashboard()
    expect(snapshotOf(cancelledFirst)).toBe(after)
    expect(dashboard.logged().some((line) => line.startsWith('Dashboard running at'))).toBe(true)
    expect(dashboard.logged().filter((line) => CLEANUP_LINE.test(line))).toEqual([])
  })
})

describe('a cancel on a run stamped with no start time', () => {
  it('the dashboard cancels its own run stamped with no start time', () => {
    const own = new DashboardDatabase({ dbPath, runOwnership: { self: UNREAD_SELF, probe } })
    const ownStops: string[] = []
    const ownQueue = new JobQueue({
      db: own,
      requestStop: (runId) => {
        ownStops.push(runId)
        return true
      },
    })
    try {
      const id = ownQueue.enqueue({ name: 'Own run, no start time' })
      ownQueue.processNext()
      expect(reader.readRunOwner(id)).toEqual(UNREAD_SELF)
      expect(reader.getRun(id)?.status).toBe('running')

      expect(ownQueue.cancel(id)).toEqual({ kind: 'stop-requested' })
      expect(reader.getRun(id)?.status).toBe('running')
      expect(ownStops).toEqual([id])
    } finally {
      ownQueue.stop()
      own.close()
    }
  })

  it("a dashboard on a reused pid with no start time does not cancel a dead dashboard's run as its own", async () => {
    const byQueue = seedRunning(UNREAD_SELF, 'Dead dashboard, queue')
    const byRoute = seedRunning(UNREAD_SELF, 'Dead dashboard, route')
    const before = [byQueue, byRoute].map(snapshotOf)
    const reused: RunOwnership = { self: { ...UNREAD_SELF }, probe }
    const reusedDb = new DashboardDatabase({ dbPath, runOwnership: reused })
    const reusedStops: string[] = []
    const reusedQueue = new JobQueue({
      db: reusedDb,
      requestStop: (runId) => {
        reusedStops.push(runId)
        return true
      },
    })
    try {
      expect(reusedQueue.cancel(byQueue)).toEqual(refusalOf(UNREAD_SELF))

      const dashboard = await startDashboard(reused)
      expect(await cancelOver(dashboard, byRoute)).toEqual({
        status: 409,
        body: refusalBodyOf(UNREAD_SELF),
      })
      expect(reusedStops).toEqual([])
      expect(dashboard.backend.killed).toEqual([])
      expect([byQueue, byRoute].map(snapshotOf)).toEqual(before)
    } finally {
      reusedQueue.stop()
      reusedDb.close()
    }
  })
})

describe('a cancel when the start-time read throws', () => {
  it('a cancel answers 409, not 500, when the start-time read throws', async () => {
    const throwing: RunOwner = { pid: 3006, incarnation: 'inc-3006', host: HOST }
    const throwingProbe: RunOwnerProbe = {
      isAlive: probe.isAlive,
      incarnationOf: (pid) => {
        if (pid === throwing.pid) throw new Error('ps failed')
        return probe.incarnationOf(pid)
      },
    }
    const dashboard = await startDashboard({ self: SELF, probe: throwingProbe })
    const id = seedRunning(throwing, 'Start time read throws')
    const before = snapshotOf(id)

    expect(await cancelOver(dashboard, id)).toEqual({
      status: 409,
      body: refusalBodyOf(throwing),
    })
    expect(dashboard.backend.killed).toEqual([])
    expect(stopRequests).toEqual([])
    expect(snapshotOf(id)).toBe(before)
  })
})

function linuxResolver(
  name: string,
  readPidNamespace: () => string | undefined,
  readPlatformUuid?: () => string | undefined,
) {
  const options = {
    platform: 'linux' as const,
    hostname: () => name,
    readPidNamespace,
    readPlatformUuid,
  }
  return createRunOwnerHostResolver(options)
}

const namespaceProbe: RunOwnerProbe = {
  isAlive: (pid) => pid === 12,
  incarnationOf: (pid) => (pid === 12 ? 'proc-starttime:12' : undefined),
}

describe('a cancel on a run owned from another pid namespace', () => {
  it('a cancel on a run owned from another pid namespace under this host name is refused with 409 and writes nothing', async () => {
    const here = linuxResolver('build-box', () => 'pid:[4026531836]')()
    const container = linuxResolver('build-box', () => 'pid:[4026532001]')()
    const dashboard = await startDashboard({
      self: { pid: 1000, incarnation: 'proc-starttime:900000', host: here },
      probe: namespaceProbe,
    })
    const containerOwners: RunOwner[] = [
      { pid: 7, incarnation: 'proc-starttime:884211', host: container },
      { pid: 12, incarnation: 'proc-starttime:884300', host: container },
    ]
    const control: RunOwner = { pid: 3008, incarnation: 'proc-starttime:700', host: here }
    const seeded = containerOwners.map((owner) => ({
      owner,
      id: seedRunning(owner, `Container pid ${String(owner.pid)}`),
    }))
    const controlId = seedRunning(control, 'Same pid namespace, dead owner')
    for (const { owner, id } of [...seeded, { owner: control, id: controlId }]) {
      expect(reader.getRun(id)?.status).toBe('running')
      expect(reader.readRunOwner(id)).toEqual(owner)
    }
    const before = seeded.map(({ id }) => snapshotOf(id))

    for (const { owner, id } of seeded) {
      expect(await cancelOver(dashboard, id)).toEqual({ status: 409, body: refusalBodyOf(owner) })
    }
    expect(seeded.map(({ id }) => snapshotOf(id))).toEqual(before)
    expect(dashboard.backend.killed).toEqual([])
    expect(stopRequests).toEqual([])

    expect(await cancelOver(dashboard, controlId)).toEqual({
      status: 200,
      body: { cancelled: false, message: orphanSummary(control.pid) },
    })
    expectOrphanFinalized(controlId, control.pid)
  })
})

describe('a cancel addressed by run id', () => {
  it('a cancel on a run whose id needs encoding reaches that run', async () => {
    const dashboard = await startDashboard()
    const ownId = seedRunning(SELF, 'Own run, id needs encoding', 'run a/b?c')
    const orphanId = seedRunning(GONE, 'Gone owner, id needs encoding', 'orphan 1/2?3')
    expect([ownId, orphanId]).toEqual(['run a/b?c', 'orphan 1/2?3'])
    for (const [id, owner] of [
      [ownId, SELF],
      [orphanId, GONE],
    ] as const) {
      expect(reader.getRun(id)?.status).toBe('running')
      expect(reader.readRunOwner(id)).toEqual(owner)
    }

    expect(await cancelOver(dashboard, ownId)).toEqual({ status: 202, body: STOP_REQUESTED })
    const row = reader.getRun(ownId)!
    expect(row.status).toBe('running')
    expect(row.failureSummary ?? null).toBeNull()
    expect(dashboard.backend.killed).toEqual(['run a/b?c'])

    expect(await cancelOver(dashboard, orphanId)).toEqual({
      status: 200,
      body: { cancelled: false, message: orphanSummary(GONE.pid) },
    })
    expectOrphanFinalized(orphanId, GONE.pid)
    expect(dashboard.backend.killed).toEqual(['run a/b?c'])
  })

  it('a malformed run id is answered 400 and writes nothing', async () => {
    const dashboard = await startDashboard()
    const id = seedRunning(SELF, 'Own run, literal escape in its id', 'run%ZZ')
    expect(reader.getRun(id)?.status).toBe('running')
    const before = snapshotOf(id)

    const response = await fetch(`${dashboard.origin}/api/runs/run%ZZ/cancel`, { method: 'POST' })
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 400,
      body: { error: 'invalid_run_id' },
    })
    expect(snapshotOf(id)).toBe(before)
    expect(dashboard.backend.killed).toEqual([])
    expect(stopRequests).toEqual([])
  })
})
