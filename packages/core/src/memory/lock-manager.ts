import { writeFile, readFile, unlink, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

export class LockManager {
  private lockPath: string
  private timeout: number

  constructor(lockPath: string, timeout = 120_000) {
    this.lockPath = lockPath
    this.timeout = timeout
  }

  async acquire(): Promise<void> {
    await mkdir(dirname(this.lockPath), { recursive: true })
    const deadline = Date.now() + this.timeout
    while (Date.now() < deadline) {
      try {
        await writeFile(
          this.lockPath,
          JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() }),
          { flag: 'wx' },
        )
        try {
          const raw = await readFile(this.lockPath, 'utf-8')
          const { pid } = JSON.parse(raw) as { pid: number }
          if (pid === process.pid) return
        } catch {
          // Lock was deleted between create and verify -- retry
        }
        continue
      } catch (err: unknown) {
        if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EEXIST') {
          if (await this.isStale()) {
            await unlink(this.lockPath).catch(() => {})
            continue
          }
          await new Promise(r => setTimeout(r, 200))
          continue
        }
        throw err
      }
    }
    throw new Error('Lock acquisition timed out')
  }

  async release(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.lockPath, 'utf-8')
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return
      }
      throw err
    }
    let pid: number
    try {
      ({ pid } = JSON.parse(raw) as { pid: number })
    } catch {
      await unlink(this.lockPath).catch(() => {})
      return
    }
    if (pid === process.pid) {
      await unlink(this.lockPath).catch(() => {})
    }
  }

  private async isStale(): Promise<boolean> {
    let raw: string
    try {
      raw = await readFile(this.lockPath, 'utf-8')
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return true
      }
      throw err
    }
    let pid: number
    let timestamp: string
    try {
      ({ pid, timestamp } = JSON.parse(raw) as { pid: number; timestamp: string })
    } catch {
      return true
    }

    let pidAlive = false
    try {
      process.kill(pid, 0)
      pidAlive = true
    } catch {
      return true
    }

    if (Date.now() - new Date(timestamp).getTime() > this.timeout * 2) {
      return true
    }

    return !pidAlive
  }
}
