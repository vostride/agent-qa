import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FsHandoffStore, RUNS_SUBDIR, slugBranch } from '@vostride/agent-qa-runner-local'
import { asRunId, canonicalJson, MARK_RECEIPT_SCHEMA_VERSION, type MarkReceipt } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  FsMarkLedger, MARK_INTENT_FILE, MARKS_LEDGER_FILE, MARKS_LEDGER_LOCK_FILE,
  MarkIntentUnusableError, MarkLedgerBusyError, MarkLedgerCorruptError, MarkLedgerNoRunError,
} from '../store/mark-ledger.js'
import { makeLocalV2Handoff } from './fixtures/local-handoff-fixture.js'

describe('FsMarkLedger', () => {
  let root: string
  let ledger: FsMarkLedger
  let dir: string
  let record: Omit<MarkReceipt, 'ordinal'>
  const runId = asRunId('run-mark-ledger')
  const runSlug = slugBranch(runId)

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mark-ledger-'))
    dir = join(root, RUNS_SUBDIR, runSlug)
    const handoff = { ...makeLocalV2Handoff(), runId }
    new FsHandoffStore({ root, runId }).save(handoff)
    ledger = new FsMarkLedger({ root, runId })
    record = {
      schemaVersion: MARK_RECEIPT_SCHEMA_VERSION, markId: 'mark_0123456789ab', runId, runSlug, testIndex: 0,
      kind: 'false-fail', origin: 'user', markedAt: 0,
      disposition: { kind: 'confirmed-bug', confirmedRecords: 0 },
      evidence: { confirmed: 0, overturned: 0 },
    }
  })
  afterEach(() => { vi.useRealTimers(); rmSync(root, { recursive: true, force: true }) })

  it('appends ordinals 1/2/3, preserves prior bytes and selects the latest address independent of time', async () => {
    expect(ledger.read()).toEqual([])
    expect(await ledger.append({ ...record, markedAt: 100 })).toMatchObject({ ordinal: 1 })
    const firstBytes = readFileSync(join(dir, MARKS_LEDGER_FILE), 'utf8')
    expect(await ledger.append({ ...record, stepIndex: 2 })).toMatchObject({ ordinal: 2 })
    expect(await ledger.append(record)).toMatchObject({ ordinal: 3 })
    expect(readFileSync(join(dir, MARKS_LEDGER_FILE), 'utf8').startsWith(firstBytes)).toBe(true)
    expect(ledger.read().map(row => row.ordinal)).toEqual([1, 2, 3])
    expect(ledger.latestPerAddress().map(row => row.ordinal)).toEqual([3, 2])
    expect(ledger.latestFor({ runId, testIndex: 0 })?.ordinal).toBe(3)
    expect(ledger.latestFor({ runId, testIndex: 0, stepIndex: 2 })?.ordinal).toBe(2)
    expect(ledger.latestFor({ runId: asRunId('other-run'), testIndex: 0 })).toBeUndefined()
  })

  it.each([
    { origin: 'agent' }, { schemaVersion: 3 }, { ordinal: 1 }, { runId: 'other-run' },
    { runSlug: 'other-run' }, { unexpected: true },
  ])('refuses corrupt or foreign line 2 with safe typed diagnostics: %j', async patch => {
    await ledger.append(record)
    writeFileSync(join(dir, MARKS_LEDGER_FILE), `${JSON.stringify({ ...record, ordinal: 2, ...patch })}\n`, { flag: 'a' })
    expect(() => ledger.read()).toThrow(MarkLedgerCorruptError)
    expect(() => ledger.read()).toThrow('line 2')
    const fn = vi.fn(async () => record)
    await expect(ledger.transact(fn)).rejects.toThrow(MarkLedgerCorruptError)
    expect(fn).not.toHaveBeenCalled()
    expect(existsSync(join(dir, MARKS_LEDGER_LOCK_FILE))).toBe(false)
  })

  it('a marks.jsonl line stamped 1 is refused', () => {
    writeFileSync(join(dir, MARKS_LEDGER_FILE), `${JSON.stringify({ ...record, schemaVersion: 1, ordinal: 1 })}\n`)
    expect(() => ledger.read()).toThrow(MarkLedgerCorruptError)
    expect(() => ledger.read()).toThrow('line 1')
  })

  it.each(['not JSON\n', '\n', '{"credential":"never-echo-this"}\n', JSON.stringify({ ordinal: 1 })])(
    'refuses malformed, empty and unterminated lines without echoing raw bytes', text => {
      writeFileSync(join(dir, MARKS_LEDGER_FILE), text)
      expect(() => ledger.read()).toThrow('Mark ledger is corrupt at line 1')
    },
  )

  it('never creates a ledger or run directory without a handoff', async () => {
    const missing = new FsMarkLedger({ root, runId: 'absent-run' })
    await expect(missing.append(record)).rejects.toThrow(MarkLedgerNoRunError)
    expect(existsSync(join(root, RUNS_SUBDIR, 'absent-run'))).toBe(false)
  })

  it('serializes two same-tick transactions across store instances and exposes prior completion', async () => {
    const second = new FsMarkLedger({ root, runId })
    const observed: number[] = []
    const results = await Promise.all([
      ledger.transact(async nextOrdinal => {
        observed.push(nextOrdinal)
        await new Promise(resolve => setTimeout(resolve, 100))
        return record
      }),
      second.transact(async nextOrdinal => {
        observed.push(nextOrdinal)
        expect(second.latestFor({ runId, testIndex: 0 })?.ordinal).toBe(1)
        return { ...record, markId: 'mark_abcdef012345' }
      }),
    ])
    expect(results.map(row => row?.ordinal)).toEqual([1, 2])
    expect(observed).toEqual([1, 2])
    expect(ledger.read()).toHaveLength(2)
    expect(existsSync(join(dir, MARKS_LEDGER_LOCK_FILE))).toBe(false)
  })

  it('a throwing callback appends nothing and releases its lock', async () => {
    await expect(ledger.transact(async () => { throw new Error('draft failed') })).rejects.toThrow('draft failed')
    expect(ledger.read()).toEqual([])
    expect(existsSync(join(dir, MARKS_LEDGER_LOCK_FILE))).toBe(false)
    expect(await ledger.append(record)).toMatchObject({ ordinal: 1 })
  })
  it('resumes a strictly validated intent at the same ordinal and rejects a different request', async () => {
    const operationId = '01234567-89ab-4def-8123-456789abcdef'
    await expect(ledger.transact(async ordinal => {
      ledger.prepareIntent({ ...record, ordinal }, operationId)
      throw new Error('after intent')
    })).rejects.toThrow('after intent')
    await expect(ledger.transact(async ordinal => {
      ledger.prepareIntent({ ...record, ordinal, kind: 'false-pass' }, operationId)
      return undefined
    })).rejects.toThrow('unfinished mark')
    const recovered = await ledger.transact(async ordinal => {
      const intent = ledger.prepareIntent({ ...record, markId: 'mark_abcdef012345', ordinal }, operationId)
      expect(intent.mark.markId).toBe(record.markId)
      expect(intent.operationId, 'the first attempt\'s identity is the retry\'s').toBe(operationId)
      ledger.checkpointIntent({ ...intent, stage: 'applied' })
      return intent.mark
    })
    expect(recovered).toMatchObject({ ordinal: 1, markId: record.markId })
    expect(ledger.read()).toEqual([recovered])
    expect(existsSync(join(dir, 'mark-intent.json'))).toBe(false)
  })
  // 2026-09-30, 432-09 (D-04/D-22): the intent names a stable operation identity and an `applied`
  // stage; a pre-432 intent that names a proposal or a drafted stage is refused before any effect.
  // 2026-10-03 (quick 261003-lgd, Phase 432 review IN-23): refused by the intent file's own name.
  // It used to say "Mark ledger is corrupt at line N", a line marks.jsonl does not have, so the
  // person was sent to the wrong file. D-02: still no migration; the message says what to remove.
  // OBSERVED RED on agent-qa 481f0a153: "Mark ledger is corrupt at line 1" (MarkLedgerCorruptError).
  it.each([
    ['a proposalUuid', { proposalUuid: '01234567-89ab-4def-8123-456789abcdef', stage: 'evidence' }],
    ['the drafted stage', { operationId: '01234567-89ab-4def-8123-456789abcdef', stage: 'drafted' }],
    ['a stored test draft', { operationId: '01234567-89ab-4def-8123-456789abcdef', stage: 'evidence', testDraft: {} }],
  ])('refuses a pre-432 intent carrying %s before invoking any side effect, naming the intent file', async (_name, legacy) => {
    const intentPath = join(dir, 'mark-intent.json')
    writeFileSync(intentPath, JSON.stringify({ schemaVersion: 1, mark: { ...record, ordinal: 1 }, ...legacy }))
    const fn = vi.fn(async () => record)
    const refusal = await ledger.transact(fn).then(() => undefined, (error: unknown) => error as Error)
    expect(refusal).toBeInstanceOf(MarkIntentUnusableError)
    expect(refusal).toMatchObject({ intentPath, reason: 'earlier-version' })
    expect(refusal?.message).toBe(`The unfinished-mark record ${intentPath} was written by an earlier `
      + 'agent-qa version, which this version does not read; nothing was marked. Remove that file, '
      + 'then mark again.')
    expect(refusal?.message).not.toMatch(/line \d/)
    expect(fn).not.toHaveBeenCalled()
    expect(ledger.read()).toEqual([])
  })

  it('an applied intent resumes straight to its receipt, value for value, and an applied fix is never a draft', async () => {
    const operationId = '11111111-2222-4333-8444-555555555555'
    const applied = { ...record, disposition: { kind: 'applied' as const, fix: 'test-edit' as const,
      change: { kind: 'test-file' as const, filePath: 'tests/naïve-café.yaml', contentDigest: 'a'.repeat(64) } } }
    await expect(ledger.transact(async ordinal => {
      const intent = ledger.prepareIntent({ ...applied, ordinal }, operationId)
      ledger.checkpointIntent({ ...intent, stage: 'applied' })
      throw new Error('crash before the receipt')
    })).rejects.toThrow('crash before the receipt')
    const resumed = await ledger.transact(async ordinal => {
      const intent = ledger.prepareIntent({ ...record, ordinal }, '99999999-2222-4333-8444-555555555555')
      expect(intent.stage).toBe('applied')
      expect(intent.operationId, 'the first attempt\'s identity survives the crash').toBe(operationId)
      return intent.mark
    })
    expect(resumed).toEqual({ ...applied, ordinal: 1 })
    expect(JSON.parse(readFileSync(join(dir, MARKS_LEDGER_FILE), 'utf8').trim())).toEqual(resumed)
    // A drafted disposition cannot be checkpointed as applied.
    await expect(ledger.transact(async ordinal => {
      const intent = ledger.prepareIntent({ ...record, markId: 'mark_abcdef012345', ordinal,
        disposition: { kind: 'drafted', fix: 'fact', proposalId: 'prop_0123456789ab', proposalKind: 'knowledge' } }, operationId)
      ledger.checkpointIntent({ ...intent, stage: 'applied' })
      return intent.mark
    })).rejects.toThrow()
    expect(ledger.read()).toHaveLength(1)
  })

  it('refuses malformed intent bytes before invoking any side effect, naming the intent file', async () => {
    const intentPath = join(dir, 'mark-intent.json')
    writeFileSync(intentPath, JSON.stringify({ schemaVersion: 2, mark: record, extra: true }))
    const fn = vi.fn(async () => record)
    const refusal = await ledger.transact(fn).then(() => undefined, (error: unknown) => error as Error)
    expect(refusal).toBeInstanceOf(MarkIntentUnusableError)
    expect(refusal).toMatchObject({ intentPath, reason: 'unreadable' })
    expect(refusal?.message).toContain(intentPath)
    expect(refusal?.message).toContain('Remove that file, then mark again.')
    expect(refusal?.message).not.toMatch(/line \d/)
    expect(fn).not.toHaveBeenCalled()
    expect(ledger.read()).toEqual([])
  })

  it('a no-op callback consumes no ordinal and appends no file', async () => {
    expect(await ledger.transact(async () => undefined)).toBeUndefined()
    expect(existsSync(join(dir, MARKS_LEDGER_FILE))).toBe(false)
    expect(await ledger.append(record)).toMatchObject({ ordinal: 1 })
  })

  it('invalid callback records release the lock without a write', async () => {
    await expect(ledger.append({ ...record, runId: asRunId('other-run') })).rejects.toThrow('does not belong')
    await expect(ledger.append({ ...record, origin: 'agent' as 'user' })).rejects.toThrow()
    expect(ledger.read()).toEqual([])
    expect(await ledger.append(record)).toMatchObject({ ordinal: 1 })
  })

  it('retries a held lock every 50 ms and refuses at exactly 10 seconds without deleting it', async () => {
    vi.useFakeTimers()
    writeFileSync(join(dir, MARKS_LEDGER_LOCK_FILE), 'external holder')
    const fn = vi.fn(async () => record)
    let settled = false
    const result = ledger.transact(fn).catch(error => { settled = true; return error })
    await vi.advanceTimersByTimeAsync(9_999)
    expect(settled).toBe(false)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toBeInstanceOf(MarkLedgerBusyError)
    expect(fn).not.toHaveBeenCalled()
    expect(readFileSync(join(dir, MARKS_LEDGER_LOCK_FILE), 'utf8')).toBe('external holder')
    expect(ledger.read()).toEqual([])
  })

  it('checkpoints a mark intent at 2 and refuses one stamped 1 by naming the file to remove', async () => {
    const intentPath = join(dir, MARK_INTENT_FILE)
    const operationId = '11111111-2222-4333-8444-555555555555'
    await expect(ledger.transact(async ordinal => {
      ledger.prepareIntent({ ...record, ordinal }, operationId)
      throw new Error('crash before the receipt')
    })).rejects.toThrow('crash before the receipt')
    const written = JSON.parse(readFileSync(intentPath, 'utf8'))
    expect(readFileSync(intentPath, 'utf8')).toBe(`${canonicalJson(written)}\n`)
    expect(written.schemaVersion).toBe(2)
    writeFileSync(intentPath, `${canonicalJson({ ...written, schemaVersion: 1 })}\n`)
    const fn = vi.fn(async () => record)
    const refusal = await ledger.transact(fn).then(() => undefined, (error: unknown) => error as Error)
    expect(refusal).toBeInstanceOf(MarkIntentUnusableError)
    expect(refusal).toMatchObject({ intentPath, reason: 'unreadable' })
    expect(refusal?.message).toContain(`${intentPath} is unreadable`)
    expect(refusal?.message).toContain('Remove that file, then mark again.')
    expect(fn).not.toHaveBeenCalled()
    expect(ledger.read()).toEqual([])
  })
})
