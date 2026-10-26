import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'

const ownerSchema = z.object({ schemaVersion: z.literal(2), kind: z.literal('mark-ledger-lock'),
  pid: z.number().int().positive(), token: z.uuid(), runId: z.string().min(1) }).strict()
type Owner = z.infer<typeof ownerSchema>

function syncDirectory(path: string): void {
  const fd = openSync(path, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

function readOwner(path: string, runId: string): Owner | undefined {
  try {
    const directory = lstatSync(path)
    if (!directory.isDirectory() || directory.isSymbolicLink()) return undefined
    const ownerFile = join(path, 'owner.json')
    const file = lstatSync(ownerFile)
    if (!file.isFile() || file.isSymbolicLink()) return undefined
    const parsed = ownerSchema.safeParse(JSON.parse(readFileSync(ownerFile, 'utf8')))
    return parsed.success && parsed.data.runId === runId ? parsed.data : undefined
  } catch { return undefined }
}

function positivelyDead(pid: number): boolean {
  try { process.kill(pid, 0); return false }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' }
}

/** Complete owner publication; malformed, legacy and uncertain owners are never reaped. */
export async function acquireMarkLock(lock: string, runId: string, busy: () => Error): Promise<() => void> {
  const owner: Owner = { schemaVersion: 2, kind: 'mark-ledger-lock', pid: process.pid, token: randomUUID(), runId }
  const candidate = `${lock}.candidate-${owner.token}`
  mkdirSync(candidate)
  const fd = openSync(join(candidate, 'owner.json'), 'wx', 0o600)
  try { writeFileSync(fd, JSON.stringify(owner)); fsyncSync(fd) } finally { closeSync(fd) }
  syncDirectory(candidate)
  const started = Date.now()
  let acquired = false
  try {
    while (!acquired) {
      try {
        // mkdir is create-only even against an empty legacy/partial directory. Publish the
        // complete owner immediately afterward; death in this tiny gap remains busy by law.
        mkdirSync(lock)
        renameSync(join(candidate, 'owner.json'), join(lock, 'owner.json'))
        syncDirectory(lock)
        syncDirectory(dirname(lock))
        rmSync(candidate, { recursive: true })
        acquired = true
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        const current = readOwner(lock, runId)
        if (current !== undefined && positivelyDead(current.pid)) {
          try {
            // Retain this NONEMPTY generation tombstone. A delayed reclaimer of G cannot
            // rename a newer live H over dead-G after another contender already moved G.
            renameSync(lock, `${lock}.dead-${current.token}`)
            syncDirectory(dirname(lock))
            continue
          } catch (recoveryError) {
            if ((recoveryError as NodeJS.ErrnoException).code === 'ENOENT') continue
            if (!['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR', 'EPERM', 'EACCES'].includes((recoveryError as NodeJS.ErrnoException).code ?? '')) throw recoveryError
          }
        }
        const remaining = 10_000 - (Date.now() - started)
        if (remaining <= 0) throw busy()
        await new Promise(resolve => setTimeout(resolve, Math.min(50, remaining)))
      }
    }
  } finally {
    if (!acquired) rmSync(candidate, { recursive: true, force: true })
  }
  return () => {
    if (readOwner(lock, runId)?.token !== owner.token) return
    const released = `${lock}.released-${owner.token}`
    renameSync(lock, released)
    syncDirectory(dirname(lock))
    rmSync(released, { recursive: true })
    syncDirectory(dirname(lock))
  }
}
