import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as core from '@vostride/agent-qa-eval'
import { FsHandoffStore, RUNS_SUBDIR } from '@vostride/agent-qa-runner-local'
import { MARK_RECEIPT_SCHEMA_VERSION, asRunId, slugBranch, type MarkReceipt } from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as local from '../index.js'
import { acquireMarkLock } from '../mark-lock.js'
import { makeLocalV2Handoff } from './fixtures/local-handoff-fixture.js'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const tempRoot = (prefix: string) => { const root = mkdtempSync(join(tmpdir(), prefix)); roots.push(root); return root }
const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'))

const SERIALIZATIONS: ((value: unknown) => string)[] = [
  value => JSON.stringify(value), value => `${JSON.stringify(value)}\n`, value => `${JSON.stringify(value, null, 2)}\n`,
  value => `${core.canonicalJson(value)}\n`, value => core.committedFileText(value),
]

function restamp(file: string, stamp: number, holder: (value: any) => { schemaVersion: number } = value => value): void {
  const text = readFileSync(file, 'utf8')
  const value = JSON.parse(text)
  const serialize = SERIALIZATIONS.find(candidate => candidate(value) === text)
  expect(serialize).toBeDefined()
  holder(value).schemaVersion = stamp
  writeFileSync(file, serialize!(value))
}

function markLedgerFixture() {
  const root = tempRoot('eval-runtime-stamps-marks-')
  const runId = asRunId('run-eval-runtime-stamps')
  new FsHandoffStore({ root, runId }).save({ ...makeLocalV2Handoff(), runId })
  const record: Omit<MarkReceipt, 'ordinal'> = { schemaVersion: MARK_RECEIPT_SCHEMA_VERSION, markId: 'mark_0123456789ab',
    runId, runSlug: slugBranch(runId), testIndex: 0, kind: 'false-fail', origin: 'user', markedAt: 0,
    disposition: { kind: 'confirmed-bug', confirmedRecords: 0 }, evidence: { confirmed: 0, overturned: 0 } }
  return { ledger: new local.FsMarkLedger({ root, runId }), record,
    intentPath: join(root, RUNS_SUBDIR, slugBranch(runId), local.MARK_INTENT_FILE) }
}

describe('eval runtime stamps', () => {
  it('checkpoints a mark intent at 2 and refuses one stamped 1 by naming the file to remove', async () => {
    const f = markLedgerFixture()
    const operationId = '11111111-2222-4333-8444-555555555555'
    await expect(f.ledger.transact(async ordinal => {
      f.ledger.prepareIntent({ ...f.record, ordinal }, operationId)
      throw new Error('crash before the receipt')
    })).rejects.toThrow('crash before the receipt')
    expect(readJson(f.intentPath).schemaVersion).toBe(2)
    restamp(f.intentPath, 1)
    const fn = vi.fn(async () => f.record)
    const refusal = await f.ledger.transact(fn).then(() => undefined, (error: unknown) => error as Error)
    expect(refusal).toBeInstanceOf(local.MarkIntentUnusableError)
    expect(refusal).toMatchObject({ intentPath: f.intentPath, reason: 'unreadable' })
    expect(refusal?.message).toContain(`${f.intentPath} is unreadable`)
    expect(refusal?.message).toContain('Remove that file, then mark again.')
    expect(fn).not.toHaveBeenCalled()
    expect(f.ledger.read()).toEqual([])
  })

  it('publishes a mark lock owner at 2 and keeps a dead owner stamped 1 busy until it reads 2', async () => {
    const lock = join(tempRoot('eval-runtime-stamps-lock-'), 'marks.jsonl.lock')
    const release = await acquireMarkLock(lock, 'run', () => new Error('busy'))
    const ownerFile = join(lock, 'owner.json')
    const written = readFileSync(ownerFile, 'utf8')
    expect(JSON.parse(written)).toMatchObject({ schemaVersion: 2, kind: 'mark-ledger-lock', pid: process.pid, runId: 'run' })
    release()
    mkdirSync(lock)
    writeFileSync(ownerFile, written)
    restamp(ownerFile, 1)
    const planted = readFileSync(ownerFile, 'utf8')
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) })
    vi.useFakeTimers()
    const rejected = expect(acquireMarkLock(lock, 'run', () => new Error('busy'))).rejects.toThrow('busy')
    await vi.advanceTimersByTimeAsync(10_000); await rejected
    vi.useRealTimers()
    expect(readFileSync(ownerFile, 'utf8')).toBe(planted)
    writeFileSync(ownerFile, written)
    const reaped = await acquireMarkLock(lock, 'run', () => new Error('busy'))
    expect(readJson(ownerFile).token).not.toBe(JSON.parse(written).token)
    reaped()
  })
})
