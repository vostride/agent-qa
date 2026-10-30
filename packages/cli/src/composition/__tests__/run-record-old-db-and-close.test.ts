import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

import { DashboardDatabase } from '@vostride/agent-qa-dashboard'
import { generateRunId } from '@vostride/agent-qa-ids'
import type { RunEventEnvelope } from '@vostride/agent-qa-schema'

import { RunRecordUnavailableError, createRunRecord, doorRunAttributes } from '../../commands/run.js'
import { composeRunOwnership } from '../run-owner-probe.js'

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function configDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-qa-record-v6-')))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, '.agent-qa'), { recursive: true })
  return dir
}

const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

describe("an old runs database and the incomplete record's close", () => {
  it('the record refuses a version 5 runs database before the run starts', async () => {
    const dir = configDir()
    const dbPath = join(dir, '.agent-qa', 'runs.db')
    const old = new DatabaseSync(dbPath)
    old.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, status TEXT); INSERT INTO runs VALUES ('r_old', 'flaky')")
    old.exec('PRAGMA user_version = 5')
    old.close()
    const before = sha256(dbPath)
    const record = createRunRecord({ attributes: doorRunAttributes('cli'), warn: () => {} })
    cleanups.push(() => record.close())

    let refusal: unknown
    try {
      await record.open({ runId: generateRunId(), configDir: dir })
    } catch (error) {
      refusal = error
    }

    expect(refusal, 'the record opened a version 5 runs.db').toBeInstanceOf(RunRecordUnavailableError)
    const message = (refusal as Error).message
    expect(message).toBe(
      `${dbPath}: SQLite database user_version 5 is not compatible with schema version 2. `
        + 'Remove the dashboard database or use a compatible agent-qa version. The run was not started.',
    )
    expect(message.endsWith('The run was not started.')).toBe(true)
    expect(record.db).toBeUndefined()
    expect(sha256(dbPath), 'the version 5 file changed').toBe(before)
    expect(existsSync(`${dbPath}-wal`)).toBe(false)
  })

  it("an incomplete record closes its own row with the verdict's own word", async () => {
    const dir = configDir()
    const real = new DashboardDatabase({
      dbPath: join(dir, '.agent-qa', 'runs.db'),
      runOwnership: composeRunOwnership(),
    })
    cleanups.push(() => real.close())
    let thrown = false
    const failing = new Proxy(real, {
      get(subject, property, receiver) {
        const value = Reflect.get(subject, property, receiver) as unknown
        if (typeof value !== 'function') return value
        if (property !== 'updateRun') return (value as (...rest: unknown[]) => unknown).bind(subject)
        return (...args: unknown[]) => {
          if (!thrown && (args[1] as { duration?: unknown } | undefined)?.duration !== undefined) {
            thrown = true
            throw new Error('disk I/O error')
          }
          return (value as (...rest: unknown[]) => unknown).apply(subject, args)
        }
      },
    })
    const warned: string[] = []
    const record = createRunRecord({
      attributes: doorRunAttributes('cli'),
      host: { db: failing, queueRun: () => undefined },
      warn: (line) => { warned.push(line) },
    })
    cleanups.push(() => record.close())
    const runId = generateRunId()
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
    send('testFinished', { testId: 't-a', testIndex: 0, outcome: 'healed', durationMs: 10 })
    send('verdict', { verdict: 'healed' })
    send('runFinished', { aggregateVerdict: 'healed', disposition: 'detached', finalSeq: seq + 1 })
    await subscriber.flush()

    expect(thrown, 'the failing write was never reached').toBe(true)
    expect(real.getRun(runId)?.status).toBe('healed')
    expect(warned.filter((line) => line.includes('The run finished (healed), but its dashboard record is incomplete')).length)
      .toBe(1)
  })
})
