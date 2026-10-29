import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, chmod, lstat, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// A whole fixed-length temp file renamed over the target, through a symlink, with its mode.
export async function replaceFileAtomic(absolutePath: string, content: string): Promise<void> {
  const isLink = await lstat(absolutePath).then(
    (stats) => stats.isSymbolicLink(),
    (err: unknown) => {
      if (isMissingFile(err)) return false
      throw err
    },
  )
  const target = isLink ? await realpath(absolutePath) : absolutePath
  let mode: number | undefined
  try {
    await access(target, constants.W_OK)
    mode = (await stat(target)).mode & 0o777
  } catch (err) {
    if (!isMissingFile(err)) throw err
  }
  const tempPath = join(dirname(target), `.agent-qa-${randomUUID()}.tmp`)
  try {
    await writeFile(tempPath, content, { encoding: 'utf-8', flag: 'wx', ...(mode === undefined ? {} : { mode }) })
    if (mode !== undefined) await chmod(tempPath, mode)
    await rename(tempPath, target)
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined)
    throw error
  }
}

export function createPathLock(): <T>(key: string, work: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<void>>()
  return <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const result = (tails.get(key) ?? Promise.resolve()).then(work)
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    tails.set(key, tail)
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key)
    })
    return result
  }
}

function isMissingFile(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}
