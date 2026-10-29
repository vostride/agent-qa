import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DashboardDatabase } from '../db/database.js'
import { createRunOwnerHostResolver } from '../db/run-owner-host.js'
import type { RunOwner, RunOwnership, RunOwnerProbe } from '../db/run-owner.js'
import { startServer } from '../server/server.js'

const HOST = 'h'
const SELF: RunOwner = { pid: 1000, incarnation: 'inc-self', host: HOST }

const GONE: RunOwner = { pid: 2001, incarnation: 'inc-2001', host: HOST }
const ALIVE: RunOwner = { pid: 2002, incarnation: 'inc-2002', host: HOST }
const UNREADABLE: RunOwner = { pid: 2003, incarnation: 'inc-2003', host: HOST }
const OTHER_HOST: RunOwner = { pid: 2004, incarnation: 'inc-2004', host: 'elsewhere.invalid' }
const NO_START_TIME: RunOwner = { pid: 2005, incarnation: null, host: HOST }
const REUSED: RunOwner = { pid: 2006, incarnation: 'inc-2006-before', host: HOST }

const probe: RunOwnerProbe = {
  isAlive: (pid) => pid !== GONE.pid && pid !== OTHER_HOST.pid,
  incarnationOf: (pid) => {
    if (pid === ALIVE.pid) return ALIVE.incarnation ?? undefined
    if (pid === REUSED.pid) return 'inc-2006-after'
    if (pid === NO_START_TIME.pid) return 'inc-2005'
    return undefined
  },
}

const CLEANUP_LINE = /run\(s\) whose agent-qa process had ended/

let dir: string
let dbPath: string
let configPath: string
let reader: DashboardDatabase
const started: Array<{ close: () => void }> = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-qa-442-orphan-startup-'))
  dbPath = join(dir, 'runs.db')
  configPath = join(dir, 'agent-qa.config.yaml')
  writeFileSync(configPath, 'testDir: tests\n')
  reader = new DashboardDatabase({ dbPath, runOwnership: { self: SELF, probe } })
})

afterEach(() => {
  while (started.length > 0) started.pop()?.close()
  reader.close()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

function seedRunning(owner: RunOwner, name: string): string {
  const seeding = new DashboardDatabase({ dbPath, runOwnership: { self: owner, probe } })
  try {
    const startedAt = new Date(Date.now() - 60_000).toISOString()
    const id = seeding.insertRun({ name, status: 'running', duration: 0, startedAt, endedAt: startedAt })
    seeding.insertRunArtifact({ runId: id, kind: 'test' })
    return id
  } finally {
    seeding.close()
  }
}

function seedPending(name: string): string {
  const id = reader.insertPendingRun({ name })
  reader.insertRunArtifact({ runId: id, kind: 'test' })
  return id
}

function snapshotOf(id: string): string {
  return JSON.stringify({
    row: reader.getRun(id),
    owner: reader.readRunOwner(id),
    artifact: reader.getRunArtifact(id),
  })
}

async function startDashboard(ownership: RunOwnership = { self: SELF, probe }): Promise<void> {
  const db = new DashboardDatabase({ dbPath, runOwnership: ownership })
  const handle = await startServer({ declaredSecretMask: (text) => text, db, port: 0, configPath })
  started.push(handle)
}

function stopDashboards(): void {
  while (started.length > 0) started.pop()?.close()
}

function expectOrphanFinalized(id: string, pid: number): void {
  const sentence = `The process running this run (pid ${pid}) ended before it finished.`
  const row = reader.getRun(id)!
  expect(row.status).toBe('failed')
  expect(row.failureSummary).toBe(sentence)
  expect(row.endedAt).toBeTruthy()
  expect(row.endedAt).not.toBe(row.startedAt)
  expect(row.duration).toBeGreaterThan(0)
  const artifact = reader.getRunArtifact(id)!
  expect(artifact.finalizedAt).not.toBeNull()
  expect(artifact.payload.errors).toEqual([
    { code: 'owner-gone', phase: 'orphan-cleanup', message: sentence },
  ])
  expect(artifact.payload.runtime).toMatchObject({ status: 'failed', duration: row.duration })
}

describe('the startup orphan sweep', () => {
  it("a starting dashboard finalizes a gone owner's run with the plain sentence", async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const id = seedRunning(GONE, 'Gone owner')
    expect(reader.getRun(id)?.status).toBe('running')

    await startDashboard()

    expectOrphanFinalized(id, GONE.pid)
    const lines = log.mock.calls.map((call) => String(call[0]))
    expect(lines.filter((line) => CLEANUP_LINE.test(line))).toEqual([
      'Finalized 1 run(s) whose agent-qa process had ended',
    ])
  })

  it('a starting dashboard leaves a live, unknown or own run running', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const kept = [
      seedRunning(ALIVE, 'Alive owner'),
      seedRunning(UNREADABLE, 'Unreadable start time'),
      seedRunning(OTHER_HOST, 'Another host'),
      seedRunning(NO_START_TIME, 'No stamped start time'),
      seedRunning(SELF, 'Own run'),
    ]
    const gone = seedRunning(GONE, 'Gone owner')
    const before = kept.map(snapshotOf)
    for (const id of kept) expect(reader.getRun(id)?.status).toBe('running')

    await startDashboard()

    expectOrphanFinalized(gone, GONE.pid)
    expect(kept.map(snapshotOf)).toEqual(before)
  })

  it('a reused pid is gone', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const id = seedRunning(REUSED, 'Reused pid')
    expect(reader.readRunOwner(id)).toEqual(REUSED)

    await startDashboard()

    expectOrphanFinalized(id, REUSED.pid)
  })

  it('pending rows are untouched by the startup sweep', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const pending = [seedPending('Queued one'), seedPending('Queued two')]
    const gone = seedRunning(GONE, 'Gone owner')
    const before = pending.map(snapshotOf)

    await startDashboard()

    expectOrphanFinalized(gone, GONE.pid)
    expect(pending.map(snapshotOf)).toEqual(before)
    for (const id of pending) expect(reader.getRun(id)?.status).toBe('pending')
  })

  it('an empty runs database starts with nothing finalized and no cleanup line', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    expect(reader.getRuns({})).toHaveLength(0)

    await startDashboard()

    const lines = log.mock.calls.map((call) => String(call[0]))
    expect(lines.some((line) => line.startsWith('Dashboard running at'))).toBe(true)
    expect(lines.filter((line) => CLEANUP_LINE.test(line))).toEqual([])
    expect(reader.getRuns({})).toHaveLength(0)
  })

  it('a second dashboard start finalizes nothing twice', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const id = seedRunning(GONE, 'Gone owner')

    await startDashboard()
    expectOrphanFinalized(id, GONE.pid)
    stopDashboards()
    const afterFirst = snapshotOf(id)

    await startDashboard({ self: { ...SELF, pid: 1001 }, probe })

    expect(snapshotOf(id)).toBe(afterFirst)
    expect(reader.listRunningRunOwners()).toEqual([])
    const lines = log.mock.calls.map((call) => String(call[0]))
    expect(lines.filter((line) => line.startsWith('Dashboard running at'))).toHaveLength(2)
    expect(lines.filter((line) => CLEANUP_LINE.test(line))).toEqual([
      'Finalized 1 run(s) whose agent-qa process had ended',
    ])
  })
})

describe('the startup sweep when the start-time read throws', () => {
  it('a dashboard starts and leaves the run running when the start-time read throws', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const throwing: RunOwner = { pid: 2007, incarnation: 'inc-2007', host: HOST }
    const throwingProbe: RunOwnerProbe = {
      isAlive: probe.isAlive,
      incarnationOf: (pid) => {
        if (pid === throwing.pid) throw new Error('ps failed')
        return probe.incarnationOf(pid)
      },
    }
    const id = seedRunning(throwing, 'Start time read throws')
    const before = snapshotOf(id)

    await startDashboard({ self: SELF, probe: throwingProbe })

    const lines = log.mock.calls.map((call) => String(call[0]))
    expect(lines.some((line) => line.startsWith('Dashboard running at'))).toBe(true)
    expect(lines.filter((line) => CLEANUP_LINE.test(line))).toEqual([])
    expect(reader.getRun(id)?.status).toBe('running')
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

describe('the startup sweep beside another pid namespace', () => {
  it("a dashboard started beside a container that shares its host name leaves the container's runs running and byte-equal", async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const here = linuxResolver('build-box', () => 'pid:[4026531836]')()
    const container = linuxResolver('build-box', () => 'pid:[4026532001]')()
    const containerOwners: RunOwner[] = [
      { pid: 7, incarnation: 'proc-starttime:884211', host: container },
      { pid: 12, incarnation: 'proc-starttime:884300', host: container },
    ]
    const control: RunOwner = { pid: 2008, incarnation: 'proc-starttime:700', host: here }
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

    await startDashboard({
      self: { pid: 1000, incarnation: 'proc-starttime:900000', host: here },
      probe: namespaceProbe,
    })

    expect(seeded.map(({ id }) => reader.getRun(id)?.status)).toEqual(['running', 'running'])
    expect(seeded.map(({ id }) => snapshotOf(id))).toEqual(before)
    expectOrphanFinalized(controlId, control.pid)
    const lines = log.mock.calls.map((call) => String(call[0]))
    expect(lines.filter((line) => CLEANUP_LINE.test(line))).toEqual([
      'Finalized 1 run(s) whose agent-qa process had ended',
    ])
  })
})
