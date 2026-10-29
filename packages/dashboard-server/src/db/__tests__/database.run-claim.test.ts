import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { DashboardDatabase } from '../database.js'
import type { RunOwner, RunOwnership } from '../run-owner.js'

const SELF: RunOwner = { pid: 4242, incarnation: 'proc-starttime:7', host: 'h' }
const inertProbe = { isAlive: () => true, incarnationOf: () => undefined }

let dir: string
let dbPath: string
const opened: DashboardDatabase[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-qa-443-claim-'))
  dbPath = join(dir, 'runs.db')
})

afterEach(() => {
  for (const handle of opened.splice(0)) handle.close()
  rmSync(dir, { recursive: true, force: true })
})

function handleFor(self: RunOwner): DashboardDatabase {
  const handle = new DashboardDatabase({ dbPath, runOwnership: { self, probe: inertProbe } })
  opened.push(handle)
  return handle
}

function claimFields(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Claimed run',
    filePath: 'tests/claimed.yaml',
    attributes: { 'agent-qa.trigger': 'cli' },
    startedAt: '2026-10-17T00:00:00.000Z',
    platform: 'web',
    ...overrides,
  }
}

function rawRows(handle: DashboardDatabase, id: string): Array<Record<string, unknown>> {
  return handle['db'].prepare('SELECT * FROM runs WHERE id = ?').all(id) as Array<Record<string, unknown>>
}

function byteSnapshot(handle: DashboardDatabase, id: string): string {
  return JSON.stringify(rawRows(handle, id))
}

function runningRowOf(handle: DashboardDatabase, name = 'Owned elsewhere'): string {
  const startedAt = '2026-10-16T23:00:00.000Z'
  return handle.insertRun({
    name,
    status: 'running',
    duration: 0,
    attributes: { 'agent-qa.trigger': 'mcp' },
    startedAt,
    endedAt: startedAt,
  })
}

describe('claiming a run id', () => {
  it('a claim on a fresh id inserts a running row stamped with this handle', () => {
    const own = handleFor(SELF)
    expect(own.claimRunningRow('r_fresh', claimFields({ testId: 't_one', suiteId: 's_one' }))).toBe(true)

    const run = own.getRun('r_fresh')!
    expect(run).toMatchObject({
      status: 'running',
      name: 'Claimed run',
      filePath: 'tests/claimed.yaml',
      platform: 'web',
      duration: 0,
      startedAt: '2026-10-17T00:00:00.000Z',
      endedAt: '2026-10-17T00:00:00.000Z',
      testId: 't_one',
      suiteId: 's_one',
    })
    expect(run.attributes).toEqual({ 'agent-qa.trigger': 'cli' })
    expect(own.readRunOwner('r_fresh')).toEqual(SELF)
    expect(own.isOwnStamp('r_fresh', SELF)).toBe(true)
  })

  it('a second claim of the same id by the same handle adopts it and leaves one row', () => {
    const own = handleFor(SELF)
    expect(own.claimRunningRow('r_twice', claimFields())).toBe(true)
    expect(own.claimRunningRow('r_twice', claimFields({
      name: 'Renamed run',
      startedAt: '2026-10-17T00:05:00.000Z',
    }))).toBe(true)

    const rows = rawRows(own, 'r_twice')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      status: 'running',
      name: 'Renamed run',
      started_at: '2026-10-17T00:05:00.000Z',
      ended_at: '2026-10-17T00:05:00.000Z',
    })
    expect(own.readRunOwner('r_twice')).toEqual(SELF)
  })

  it("the dashboard's own queue row is adopted once its flip stamped it", () => {
    const own = handleFor(SELF)
    const id = own.insertPendingRun({ name: 'Queued', attributes: { 'agent-qa.trigger': 'dashboard' } })
    own.updateRunStatus(id, 'running')
    expect(own.readRunOwner(id)).toEqual(SELF)

    expect(own.claimRunningRow(id, claimFields({ attributes: { 'agent-qa.trigger': 'api' } }))).toBe(true)

    expect(rawRows(own, id)).toHaveLength(1)
    const run = own.getRun(id)!
    expect(run.status).toBe('running')
    expect(run.name).toBe('Claimed run')
    expect(run.attributes).toEqual({ 'agent-qa.trigger': 'api' })
    expect(own.readRunOwner(id)).toEqual(SELF)
  })

  it('a running row another process owns is refused and left as it was', () => {
    const strangers: RunOwner[] = [
      { ...SELF, pid: SELF.pid + 1 },
      { ...SELF, incarnation: 'proc-starttime:other' },
      { ...SELF, incarnation: null },
      { ...SELF, host: 'another-host' },
    ]
    const own = handleFor(SELF)
    for (const stranger of strangers) {
      const id = runningRowOf(handleFor(stranger))
      const before = byteSnapshot(own, id)
      expect(JSON.parse(before)).toHaveLength(1)
      expect(own.readRunOwner(id)).toEqual(stranger)

      expect(own.claimRunningRow(id, claimFields())).toBe(false)

      expect(byteSnapshot(own, id)).toBe(before)
      expect(own.readRunOwner(id)).toEqual(stranger)
      expect(own.isOwnStamp(id, SELF)).toBe(false)
    }
  })

  it('a pending row this handle did not flip is refused', () => {
    const own = handleFor(SELF)
    const id = own.insertPendingRun({ name: 'Queued elsewhere' })
    const before = byteSnapshot(own, id)

    expect(own.claimRunningRow(id, claimFields())).toBe(false)

    expect(byteSnapshot(own, id)).toBe(before)
    expect(own.getRun(id)?.status).toBe('pending')
    expect(own.readRunOwner(id)).toBeUndefined()
  })

  it('a finished row is refused', () => {
    const own = handleFor(SELF)
    const id = own.insertRun({
      name: 'Finished',
      status: 'passed',
      duration: 10,
      startedAt: '2026-10-16T22:00:00.000Z',
      endedAt: '2026-10-16T22:00:01.000Z',
    })
    const before = byteSnapshot(own, id)

    expect(own.claimRunningRow(id, claimFields())).toBe(false)

    expect(byteSnapshot(own, id)).toBe(before)
    expect(own.getRun(id)?.status).toBe('passed')
  })

  it('a NULL own incarnation still matches itself', () => {
    const unread: RunOwner = { pid: 4343, incarnation: null, host: 'h' }
    const own = handleFor(unread)
    expect(own.claimRunningRow('r_null', claimFields())).toBe(true)
    expect(own.claimRunningRow('r_null', claimFields({ name: 'Again' }))).toBe(true)

    expect(rawRows(own, 'r_null')).toHaveLength(1)
    expect(own.getRun('r_null')?.name).toBe('Again')
    expect(own.readRunOwner('r_null')).toEqual(unread)
  })

  it('a row this handle stamped before its start time was read is still adopted as its own', () => {
    let selfReads = 0
    const lateRead: RunOwnership = {
      get self() {
        selfReads += 1
        return { ...SELF, incarnation: selfReads === 1 ? null : SELF.incarnation }
      },
      probe: inertProbe,
    }
    const own = new DashboardDatabase({ dbPath, runOwnership: lateRead })
    opened.push(own)
    const id = own.insertPendingRun({ name: 'Queued' })
    own.updateRunStatus(id, 'running')
    expect(own.readRunOwner(id)).toEqual({ ...SELF, incarnation: null })
    expect(own.runOwnership.self.incarnation).toBe(SELF.incarnation)

    expect(own.claimRunningRow(id, claimFields())).toBe(true)

    expect(rawRows(own, id)).toHaveLength(1)
    expect(own.getRun(id)?.name).toBe('Claimed run')
    expect(own.readRunOwner(id)).toEqual({ ...SELF, incarnation: null })
  })

  it('a handle names its resolved file', () => {
    const relativePath = relative(process.cwd(), dbPath)
    expect(isAbsolute(relativePath)).toBe(false)
    const handle = new DashboardDatabase({ dbPath: relativePath })
    opened.push(handle)
    expect(handle.dbPath).toBe(resolve(relativePath))
    expect(handle.dbPath).toBe(dbPath)

    const memory = new DashboardDatabase({ dbPath: ':memory:' })
    opened.push(memory)
    expect(memory.dbPath).toBe(':memory:')
  })
})

describe('the own-row finalizer', () => {
  const OTHER: RunOwner = { pid: 5151, incarnation: 'proc-starttime:9', host: 'h' }

  it('the own-row finalizer writes each verdict status once', () => {
    const own = handleFor(SELF)
    const other = handleFor(OTHER)
    const endedAt = '2026-10-17T00:10:00.000Z'
    const statuses = ['passed', 'healed', 'failed', 'timeout', 'cancelled'] as const
    for (const status of statuses) {
      const id = `r_final_${status}`
      expect(own.claimRunningRow(id, claimFields())).toBe(true)

      expect(other.finalizeOwnRun(id, { status, endedAt })).toBe(false)
      expect(own.getRun(id)?.status).toBe('running')

      expect(own.finalizeOwnRun(id, { status, endedAt, duration: 600_000 })).toBe(true)
      expect(own.getRun(id)).toMatchObject({ status, endedAt, duration: 600_000 })
      expect(own.finalizeOwnRun(id, { status: 'failed', endedAt })).toBe(false)
      expect(own.getRun(id)?.status).toBe(status)
    }
    expect(own.getRuns({ limit: 10 }).map((run) => run.status).sort()).toEqual([...statuses].sort())
  })
})

describe('the closing write', () => {
  const OTHER: RunOwner = { pid: 5151, incarnation: 'proc-starttime:9', host: 'h' }
  const endedAt = '2026-10-17T00:20:00.000Z'

  it('the closing write lands the verdict status after a member status write', () => {
    const own = handleFor(SELF)
    const id = 'r_member_wrote'
    expect(own.claimRunningRow(id, claimFields())).toBe(true)
    own.updateRun(id, { status: 'passed', endedAt: '2026-10-17T00:15:00.000Z' })
    expect(own.finalizeOwnRun(id, { status: 'failed', endedAt })).toBe(false)
    expect(own.getRun(id)?.status).toBe('passed')

    expect(own.closeOwnRun(id, { status: 'failed', endedAt })).toBe(true)

    expect(own.getRun(id)).toMatchObject({ status: 'failed', endedAt })
    expect(own.readRunOwner(id)?.pid).toBe(SELF.pid)

    const quiet = 'r_no_member'
    expect(own.claimRunningRow(quiet, claimFields())).toBe(true)
    expect(own.closeOwnRun(quiet, { status: 'passed', endedAt })).toBe(true)
    expect(own.getRun(quiet)).toMatchObject({ status: 'passed', endedAt })
    expect(own.readRunOwner(quiet)?.pid).toBe(SELF.pid)
  })

  it('the closing write never touches a row another process stamped', () => {
    const own = handleFor(SELF)
    const other = handleFor(OTHER)
    const foreign = 'r_foreign'
    expect(other.claimRunningRow(foreign, claimFields())).toBe(true)
    const pending = own.insertPendingRun({ name: 'Queued elsewhere' })
    const rows = [foreign, pending]
    const before = rows.map((id) => byteSnapshot(own, id))
    for (const snapshot of before) expect(JSON.parse(snapshot)).toHaveLength(1)

    for (const id of rows) {
      expect(own.closeOwnRun(id, { status: 'failed', endedAt })).toBe(false)
    }

    expect(rows.map((id) => byteSnapshot(own, id))).toEqual(before)
    expect(own.getRun(foreign)?.status).toBe('running')
    expect(own.readRunOwner(foreign)?.pid).toBe(OTHER.pid)
    expect(own.getRun(pending)?.status).toBe('pending')
    expect(own.readRunOwner(pending)).toBeUndefined()
  })
})
