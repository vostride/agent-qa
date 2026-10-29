// A mark's test edit, recorded durably before its write, so a retry answers it, not re-edits.

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

// A target with neither the read nor the written bytes is answered from the record, not re-edited.
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
