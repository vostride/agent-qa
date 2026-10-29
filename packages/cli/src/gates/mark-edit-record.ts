// 2026-10-02 (quick 261002-mrk, 432-09 #4): a mark's test edit, recorded ahead of its write.
//
// `authoring.draft.edit` is one call (a model call, then a digest-guarded write), so the mark host
// cannot checkpoint between the write and the return. The mark host therefore opens a scope keyed
// by its intent's operation id, and the CLI's final-test writer records, inside that scope, which
// bytes it is about to write over which bytes, durably and before the write. A retry consults the
// record before invoking the edit again: the recorded bytes on disk are the first answer. An edit
// outside a mark has no scope and records nothing. The record lives in the run's directory under
// `.agent-qa/`, beside the mark intent.

import { AsyncLocalStorage } from 'node:async_hooks'
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { resolve } from 'node:path'

import { sha256hexBytes, type TestFileWrite } from '@vostride/agent-qa-schema'
import { z } from 'zod'

export const MARK_EDIT_RECORD_FILE = 'mark-edit.json'

const recordSchema = z.object({
  schemaVersion: z.literal(2),
  operationId: z.string().min(1),
  filePath: z.string().min(1),
  /** Absent when the target did not exist. */
  sourceDigest: z.string().optional(),
  contentDigest: z.string().min(1),
}).strict()

export interface MarkEditScope {
  readonly recordPath: string
  readonly operationId: string
}

export interface PendingTestWrite {
  readonly filePath: string
  readonly sourceDigest?: string
  readonly contentDigest: string
}

const scope = new AsyncLocalStorage<MarkEditScope>()

export class MarkEditRecordUnreadableError extends Error {
  constructor(readonly recordPath: string) {
    super(
      `The mark's edit record at ${recordPath} is unreadable; nothing was edited again. `
        + 'Inspect or remove it, then retry the mark.',
    )
    this.name = 'MarkEditRecordUnreadableError'
  }
}

export function withMarkEditScope<T>(value: MarkEditScope, run: () => Promise<T>): Promise<T> {
  return scope.run(value, run)
}

/** Called by the final-test writer after its digest guard and before its write. */
export function recordMarkEditAhead(write: PendingTestWrite): void {
  const active = scope.getStore()
  if (active === undefined) return
  const record = recordSchema.parse({ schemaVersion: 2, operationId: active.operationId, ...write })
  const staged = `${active.recordPath}.pending`
  const fd = openSync(staged, 'w', 0o600)
  try {
    writeFileSync(fd, `${JSON.stringify(record)}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(staged, active.recordPath)
}

function digestOf(path: string): string | undefined {
  try {
    return sha256hexBytes(readFileSync(path))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * The recorded write's answer for this operation, or `undefined` when the edit must run: no record
 * for this operation, or the target still holds the bytes the edit read (the write never landed).
 *
 * 2026-10-03 (quick 261003-lgd, Phase 432 review WR-04): a target holding neither the bytes the
 * edit read nor the bytes it wrote (a person edited or deleted the test after the crash) is
 * answered from the record too: the mark completes with the write it recorded, and the person's
 * later change stays theirs. It is never edited again and the model is never asked again. It used to be
 * refused as `target-changed`, and since neither the record nor the intent was ever cleared on that
 * path, every retry, and every other mark on the run, failed the same way for good.
 *
 * What this cannot tell apart: the record is written just before the write, so a crash in the
 * moment between the two, followed by a person's change, also reads as "neither". The receipt then
 * names a write that did not land. Both windows are a few milliseconds of one synchronous call.
 */
export function answerRecordedMarkEdit(
  input: MarkEditScope & { readonly configDir: string },
): TestFileWrite | undefined {
  let text: string
  try {
    text = readFileSync(input.recordPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  let record: z.infer<typeof recordSchema>
  try {
    record = recordSchema.parse(JSON.parse(text))
  } catch {
    throw new MarkEditRecordUnreadableError(input.recordPath)
  }
  if (record.operationId !== input.operationId) return undefined
  const found = digestOf(resolve(input.configDir, record.filePath))
  if (found !== record.contentDigest && found === record.sourceDigest) return undefined
  return { kind: 'written', filePath: record.filePath, contentDigest: record.contentDigest }
}

export function clearMarkEditRecord(recordPath: string): void {
  rmSync(recordPath, { force: true })
}
