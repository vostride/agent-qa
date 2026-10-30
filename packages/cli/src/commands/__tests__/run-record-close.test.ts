import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

import { DashboardDatabase } from '@vostride/agent-qa-dashboard'
import { generateRunId } from '@vostride/agent-qa-ids'
import type { RunEventEnvelope } from '@vostride/agent-qa-schema'

import { composeRunOwnership } from '../../composition/run-owner-probe.js'
import { createRunRecord, doorRunAttributes, type RunRecordHostBinding } from '../run.js'

const NO_VERDICT = 'The run ended before it reached a verdict.'
const CLOSED = 'This run record is closed.'
const GATE_RUN = 'agent-qa.gate-run'

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function configDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-qa-run-record-')))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, '.agent-qa'), { recursive: true })
  return dir
}

const runsDbOf = (dir: string): string => join(dir, '.agent-qa', 'runs.db')

function ownDatabase(dir: string): DashboardDatabase {
  const db = new DashboardDatabase({ dbPath: runsDbOf(dir), runOwnership: composeRunOwnership() })
  cleanups.push(() => db.close())
  return db
}

function failOn(real: DashboardDatabase, method: 'insertRunArtifact'): {
  db: DashboardDatabase
  reached: () => boolean
} {
  let thrown = false
  const db = new Proxy(real, {
    get(subject, property, receiver) {
      const value = Reflect.get(subject, property, receiver) as unknown
      if (property === method && typeof value === 'function') {
        return () => {
          thrown = true
          throw new Error('disk I/O error')
        }
      }
      return typeof value === 'function'
        ? (value as (...rest: unknown[]) => unknown).bind(subject)
        : value
    },
  })
  return { db, reached: () => thrown }
}

async function attachedRecord(dir: string, host: RunRecordHostBinding, runId = generateRunId()) {
  const warned: string[] = []
  const record = createRunRecord({
    attributes: doorRunAttributes('cli'),
    host,
    warn: (line) => { warned.push(line) },
  })
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
  return { record, runId, send, subscriber, warned }
}

function rawRow(dbPath: string, runId: string): string {
  const db = new DatabaseSync(dbPath)
  try {
    return JSON.stringify(db.prepare('SELECT * FROM runs WHERE id = ?').all(runId))
  } finally {
    db.close()
  }
}

describe('a run that ends with no verdict closes its own row', () => {
  it('a run that ends with no verdict closes its own row failed with the plain sentence', async () => {
    const dir = configDir()
    const real = ownDatabase(dir)
    const { record, runId, send, subscriber, warned } = await attachedRecord(dir, {
      db: real,
      queueRun: () => undefined,
    })
    send('runStarted', { memberTestCount: 1 })
    send('testStarted', { testId: 't-a', testIndex: 0, name: 'Member A', filePath: 'tests/a.yaml' })
    expect(record.ownRowId(), 'the record claimed no row').toBe(runId)
    expect(real.getRun(runId)?.status).toBe('running')
    const owner = real.readRunOwner(runId)
    expect(owner?.pid, 'the claim stamped no owner').toBe(process.pid)

    await subscriber.flush()

    const row = real.getRun(runId)
    expect(row?.status).toBe('failed')
    expect(row?.failureSummary).toBe(NO_VERDICT)
    expect(row?.endedAt, 'the close wrote no end time').toBeTruthy()
    expect(real.readRunOwner(runId), 'the owner columns moved').toEqual(owner)
    expect(real.listRunningRunOwners()).toEqual([])
    expect(warned, 'a complete record warned').toEqual([])
  })

  it('a run with a verdict is never closed by the no-verdict branch', async () => {
    const dir = configDir()
    const real = ownDatabase(dir)
    const { runId, send, subscriber } = await attachedRecord(dir, { db: real, queueRun: () => undefined })
    send('runStarted', { memberTestCount: 1 })
    send('testStarted', { testId: 't-a', testIndex: 0, name: 'Member A', filePath: 'tests/a.yaml' })
    send('testFinished', { testId: 't-a', testIndex: 0, outcome: 'passed', durationMs: 10 })
    send('verdict', { verdict: 'passed' })
    send('runFinished', { aggregateVerdict: 'passed', disposition: 'detached', finalSeq: 6 })

    await subscriber.flush()

    const row = real.getRun(runId)
    expect(row?.status).toBe('passed')
    expect(row?.failureSummary ?? undefined).toBeUndefined()
  })

  it('a row another process owns is untouched', async () => {
    const dir = configDir()
    const real = ownDatabase(dir)
    const { record, runId, send, subscriber, warned } = await attachedRecord(dir, {
      db: real,
      queueRun: () => undefined,
    })
    const elsewhere = new DashboardDatabase({
      dbPath: runsDbOf(dir),
      runOwnership: {
        self: { pid: 4343, incarnation: 'proc-starttime:elsewhere', host: 'elsewhere' },
        probe: { isAlive: () => true, incarnationOf: () => undefined },
      },
    })
    cleanups.push(() => elsewhere.close())
    elsewhere.insertRun({
      id: runId,
      name: 'owned elsewhere',
      status: 'running',
      duration: 0,
      startedAt: '2026-10-17T00:00:00.000Z',
      endedAt: '2026-10-17T00:00:00.000Z',
      platform: 'web',
    })
    const before = rawRow(runsDbOf(dir), runId)
    send('runStarted', { memberTestCount: 1 })
    send('testStarted', { testId: 't-a', testIndex: 0, name: 'Member A', filePath: 'tests/a.yaml' })
    expect(record.ownRowId(), 'the record claimed a row another process owns').toBeUndefined()

    await subscriber.flush()

    expect(rawRow(runsDbOf(dir), runId)).toBe(before)
    expect(real.getRun(runId)?.status).toBe('running')
    expect(warned.length, `warnings: ${warned.join(' | ')}`).toBe(1)
  })

  it('an incomplete record with no verdict closes the same way and warns once', async () => {
    const dir = configDir()
    const real = ownDatabase(dir)
    const failing = failOn(real, 'insertRunArtifact')
    const { record, runId, send, subscriber, warned } = await attachedRecord(dir, {
      db: failing.db,
      queueRun: () => undefined,
    })
    send('runStarted', { memberTestCount: 1 })
    send('testStarted', { testId: 't-a', testIndex: 0, name: 'Member A', filePath: 'tests/a.yaml' })
    expect(failing.reached(), 'the failing write was never reached').toBe(true)
    expect(record.ownRowId(), 'the record claimed no row').toBe(runId)

    await subscriber.flush()
    await subscriber.flush()

    const row = real.getRun(runId)
    expect(row?.status).toBe('failed')
    expect(row?.failureSummary).toBe(NO_VERDICT)
    expect(real.listRunningRunOwners()).toEqual([])
    const incomplete = warned.filter((line) => line.includes('but its dashboard record is incomplete'))
    expect(incomplete.length, `warnings: ${warned.join(' | ')}`).toBe(1)
    expect(warned.length, `warnings: ${warned.join(' | ')}`).toBe(1)
  })
})

function ownRecord(attributes = doorRunAttributes('cli')) {
  const record = createRunRecord({ attributes, warn: () => {} })
  cleanups.push(() => record.close())
  return record
}

describe('a closed run record refuses to open', () => {
  it('a record closed while its open is in flight releases the handle and refuses', async () => {
    const control = configDir()
    const opened = ownRecord()
    await opened.open({ runId: generateRunId(), configDir: control })
    expect(existsSync(`${runsDbOf(control)}-wal`), 'an open record holds no -wal file').toBe(true)
    opened.close()
    expect(existsSync(`${runsDbOf(control)}-wal`), 'a closed record left its -wal file').toBe(false)

    const dir = configDir()
    const record = ownRecord()
    const opening = record.open({ runId: generateRunId(), configDir: dir })
    record.close()

    await expect(opening).rejects.toThrow(CLOSED)
    expect(record.db, 'the record bound a handle after its close').toBeUndefined()
    expect(existsSync(runsDbOf(dir)), 'the open never reached the runs.db file').toBe(true)
    expect(existsSync(`${runsDbOf(dir)}-wal`), 'the late handle left its -wal file').toBe(false)
  })

  it('a closed record refuses a later open', async () => {
    const dir = configDir()
    const runId = generateRunId()
    const record = ownRecord()
    await record.open({ runId, configDir: dir })
    record.close()

    await expect(record.open({ runId, configDir: dir })).rejects.toThrow(CLOSED)
    expect(existsSync(`${runsDbOf(dir)}-wal`), 'the refused open left a -wal file').toBe(false)

    const never = ownRecord()
    never.close()
    await expect(never.open({ runId: generateRunId(), configDir: configDir() })).rejects.toThrow(CLOSED)
  })
})

describe('the gate-run mark', () => {
  it("a verify run's own flag still marks its row", async () => {
    const dir = configDir()
    const runId = generateRunId()
    const record = ownRecord()
    await record.open({ runId, configDir: dir })
    const subscriber = record.subscriber({
      mask: (text) => text,
      members: [{ testId: 't-a', name: 'Member A', filePath: 'tests/a.yaml' }],
      gateRun: true,
    })
    subscriber.handler({ seq: 1, ts: 1, runId, type: 'runStarted', payload: { memberTestCount: 1 } } as RunEventEnvelope)

    expect(record.db?.getRun(runId)?.attributes?.[GATE_RUN]).toBe('true')
  })
})
