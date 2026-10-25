import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { canonicalJson } from '@vostride/agent-qa-eval'
import { HANDOFF_FILE, RUNS_SUBDIR, slugBranch } from '@vostride/agent-qa-runner-local'
import { ImprovementPlanSchema, MarkReceiptSchema, markAddressKey, type MarkAddress, type MarkReceipt } from '@vostride/agent-qa-schema'
import { z } from 'zod'
import { acquireMarkLock } from './mark-lock.js'

export const MARKS_LEDGER_FILE = 'marks.jsonl'
export const MARKS_LEDGER_LOCK_FILE = 'marks.jsonl.lock'
/** A run's one unfinished mark, beside its ledger. */
export const MARK_INTENT_FILE = 'mark-intent.json'
/**
 * 2026-09-30, 432-09 (D-04/D-11): the resumable mark. `operationId` is the stable identity every
 * effect of this mark carries (the knowledge change id derives from it), so a retry at any stage
 * lands the same fix once. `applied` is the last stage: the fix is published and the receipt is
 * next, and only the receipt remains to be written. The applied change itself rides the mark's
 * own disposition, so there is one record of what changed.
 */
export const MARK_INTENT_STAGES = ['prepared', 'evidence', 'applied'] as const
const intentSchema = z.object({
  schemaVersion: z.literal(2), mark: MarkReceiptSchema,
  stage: z.enum(MARK_INTENT_STAGES),
  operationId: z.uuid(),
  plan: ImprovementPlanSchema.optional(),
}).strict().superRefine((intent, ctx) => {
  if (intent.stage === 'applied' && intent.mark.disposition.kind === 'drafted') {
    ctx.addIssue({ code: 'custom', path: ['mark', 'disposition'], message: 'a mark applies its fix; it never files a draft' })
  }
})
export type MarkIntent = z.infer<typeof intentSchema>

function atomicPublish(path: string, text: string): void {
  const staged = `${path}.pending`
  const fd = openSync(staged, 'w', 0o600)
  try { writeFileSync(fd, text); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(staged, path)
}

export class MarkLedgerBusyError extends Error {
  constructor() {
    super('Mark ledger is busy; retry the mark after the current transaction finishes')
    this.name = 'MarkLedgerBusyError'
  }
}

export class MarkLedgerCorruptError extends Error {
  constructor(readonly line: number) {
    // Never echo malformed user text or parser diagnostics into a host surface.
    super(`Mark ledger is corrupt at line ${line}`)
    this.name = 'MarkLedgerCorruptError'
  }
}

/**
 * 2026-10-03 (quick 261003-lgd, Phase 432 review IN-23): the run's unfinished-mark record cannot be
 * resumed, refused by the record's own name. It used to surface as `MarkLedgerCorruptError` at the
 * NEXT ordinal, a line `marks.jsonl` does not have. D-02: nothing is migrated or read further; the
 * message names the file to remove, after which the run can be marked again.
 */
export class MarkIntentUnusableError extends Error {
  constructor(
    readonly intentPath: string,
    readonly reason: 'earlier-version' | 'unreadable' | 'mismatched',
  ) {
    const what = reason === 'earlier-version'
      ? 'was written by an earlier agent-qa version, which this version does not read'
      : reason === 'unreadable' ? 'is unreadable' : 'does not match this run\'s mark ledger'
    // Never echo the record's bytes or parser diagnostics into a host surface.
    super(`The unfinished-mark record ${intentPath} ${what}; nothing was marked. Remove that file, `
      + 'then mark again.')
    this.name = 'MarkIntentUnusableError'
  }
}

/** Keys only a pre-432 intent carried: a filed proposal, the drafted stage, a stored test draft. */
function isEarlierVersionIntent(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const intent = value as Record<string, unknown>
  return 'proposalUuid' in intent || 'testDraft' in intent || intent['stage'] === 'drafted'
}

/** The one latest-per-address rule, over receipts a caller has already read once. */
export function latestMarkReceiptsPerAddress(receipts: readonly MarkReceipt[]): MarkReceipt[] {
  const latest = new Map<string, MarkReceipt>()
  for (const receipt of receipts) {
    const key = markAddressKey(receipt)
    if ((latest.get(key)?.ordinal ?? 0) < receipt.ordinal) latest.set(key, receipt)
  }
  return [...latest.values()].sort((a, b) =>
    a.testIndex - b.testIndex || (a.stepIndex ?? -1) - (b.stepIndex ?? -1),
  )
}

export function latestMarkReceiptFor(
  receipts: readonly MarkReceipt[],
  runId: string,
  address: MarkAddress,
): MarkReceipt | undefined {
  if (address.runId !== runId) return undefined
  return latestMarkReceiptsPerAddress(receipts).find(receipt => markAddressKey(receipt) === markAddressKey(address)
    && (address.testId === undefined || receipt.testId === address.testId))
}

export class MarkLedgerNoRunError extends Error {
  constructor() {
    super('run-not-found: mark ledger requires a completed run handoff')
    this.name = 'MarkLedgerNoRunError'
  }
}

/** Gate-side runtime ledger. The proposer reader entry never exports this store. */
export class FsMarkLedger {
  private readonly dir: string
  private readonly file: string
  private readonly lock: string
  private readonly runId: string
  private readonly runSlug: string
  private inTransaction = false
  private intentValue: MarkIntent | undefined

  constructor(config: { root: string; runId: string }) {
    this.runId = config.runId
    this.runSlug = slugBranch(config.runId)
    this.dir = join(config.root, RUNS_SUBDIR, this.runSlug)
    this.file = join(this.dir, MARKS_LEDGER_FILE)
    this.lock = join(this.dir, MARKS_LEDGER_LOCK_FILE)
  }

  read(): MarkReceipt[] {
    let text: string
    try {
      text = readFileSync(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    if (text === '') return []
    const lines = text.split('\n')
    // A missing terminator may be a torn append; concatenating another receipt would corrupt it.
    if (lines.pop() !== '') throw new MarkLedgerCorruptError(lines.length + 1)
    return lines.map((line, index) => {
      try {
        const receipt = MarkReceiptSchema.parse(JSON.parse(line))
        if (receipt.ordinal !== index + 1 || receipt.runId !== this.runId || receipt.runSlug !== this.runSlug) {
          throw new Error('ledger identity or ordinal mismatch')
        }
        return receipt
      } catch {
        throw new MarkLedgerCorruptError(index + 1)
      }
    })
  }

  latestPerAddress(): MarkReceipt[] {
    return latestMarkReceiptsPerAddress(this.read())
  }

  latestFor(address: MarkAddress): MarkReceipt | undefined {
    // A foreign address never reads this run's ledger.
    if (address.runId !== this.runId) return undefined
    return latestMarkReceiptFor(this.read(), this.runId, address)
  }

  /** Private resumable state is admitted only while this run's existing lock is held. */
  prepareIntent(mark: MarkReceipt, operationId: string): MarkIntent {
    if (!this.inTransaction) throw new Error('mark intent requires the run transaction')
    const prior = this.intentValue
    if (prior !== undefined) {
      const request = (value: MarkReceipt) => ({ runId: value.runId, testIndex: value.testIndex,
        testId: value.testId, stepIndex: value.stepIndex, kind: value.kind, note: value.note })
      if (canonicalJson(request(prior.mark)) !== canonicalJson(request(mark))) {
        throw new Error('An unfinished mark must be retried with its original address, kind and note')
      }
      return prior
    }
    return this.checkpointIntent({ schemaVersion: 2, mark, operationId, stage: 'prepared' })
  }

  checkpointIntent(value: MarkIntent): MarkIntent {
    if (!this.inTransaction) throw new Error('mark intent requires the run transaction')
    const intent = intentSchema.parse(value)
    if (intent.mark.runId !== this.runId || intent.mark.runSlug !== this.runSlug
      || intent.mark.ordinal !== this.read().length + 1) throw new MarkLedgerCorruptError(intent.mark.ordinal)
    atomicPublish(join(this.dir, MARK_INTENT_FILE), `${canonicalJson(intent)}\n`)
    this.intentValue = intent
    return intent
  }

  async transact(
    fn: (nextOrdinal: number) => Promise<Omit<MarkReceipt, 'ordinal'> | undefined>,
  ): Promise<MarkReceipt | undefined> {
    if (!existsSync(join(this.dir, HANDOFF_FILE))) throw new MarkLedgerNoRunError()
    const release = await acquireMarkLock(this.lock, this.runId, () => new MarkLedgerBusyError())
    try {
      // Freeze and draft inside this callback: the next host sees the entire prior receipt.
      const receipts = this.read()
      const nextOrdinal = receipts.length + 1
      const intentPath = join(this.dir, MARK_INTENT_FILE)
      this.intentValue = undefined
      if (existsSync(intentPath)) {
        let raw: unknown
        try {
          raw = JSON.parse(readFileSync(intentPath, 'utf8'))
        } catch { throw new MarkIntentUnusableError(intentPath, 'unreadable') }
        const parsed = intentSchema.safeParse(raw)
        if (!parsed.success) {
          throw new MarkIntentUnusableError(intentPath,
            isEarlierVersionIntent(raw) ? 'earlier-version' : 'unreadable')
        }
        const intent = parsed.data
        if (intent.mark.runId !== this.runId || intent.mark.runSlug !== this.runSlug) {
          throw new MarkIntentUnusableError(intentPath, 'mismatched')
        }
        if (intent.mark.ordinal === nextOrdinal) this.intentValue = intent
        else if (canonicalJson(receipts[intent.mark.ordinal - 1]) === canonicalJson(intent.mark)) unlinkSync(intentPath)
        else throw new MarkIntentUnusableError(intentPath, 'mismatched')
      }
      this.inTransaction = true
      const record = await fn(nextOrdinal)
      if (record === undefined) return undefined
      const receipt = MarkReceiptSchema.parse({ ...record, ordinal: nextOrdinal })
      if (receipt.runId !== this.runId || receipt.runSlug !== this.runSlug) {
        throw new Error('mark receipt does not belong to this run ledger')
      }
      if (this.intentValue !== undefined && (this.intentValue.stage !== 'applied'
        || canonicalJson(this.intentValue.mark) !== canonicalJson(receipt))) {
        throw new MarkLedgerCorruptError(nextOrdinal)
      }
      // Preserve the exact historical prefix while atomically publishing the next complete line.
      const before = existsSync(this.file) ? readFileSync(this.file, 'utf8') : ''
      atomicPublish(this.file, `${before}${canonicalJson(receipt)}\n`)
      if (this.intentValue !== undefined) unlinkSync(intentPath)
      return receipt
    } finally {
      this.inTransaction = false
      this.intentValue = undefined
      release()
    }
  }

  append(record: Omit<MarkReceipt, 'ordinal'>): Promise<MarkReceipt | undefined> {
    return this.transact(async () => record)
  }
}
