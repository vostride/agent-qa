import { readFile, writeFile, mkdir, unlink, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import ms from 'ms'
import type { ActionPlan } from '../schema/action-schema.js'
import type { ActionCache } from '../agent/types.js'
import type { ScopedLogger } from '../logging/types.js'
import { CACHE_SCHEMA_VERSION, type CacheEntry } from './types.js'

export class FileActionCache implements ActionCache {
  private dir: string
  private ttlMs: number
  private logger?: ScopedLogger

  constructor(config: { dir: string; ttl: number | string; logger?: ScopedLogger }) {
    this.dir = config.dir
    this.ttlMs = typeof config.ttl === 'number' ? config.ttl : parseTTL(config.ttl)
    this.logger = config.logger
  }

  async get(stepHash: string, screenHash: string): Promise<ActionPlan | null> {
    const filePath = this.buildPath(stepHash, screenHash)

    let raw: string
    try {
      raw = await readFile(filePath, 'utf-8')
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        this.logger?.debug('Cache miss', { operation: 'get', stepHash, hit: false })
        return null
      }
      throw err
    }

    let entry: CacheEntry
    try {
      entry = JSON.parse(raw)
    } catch {
      this.logger?.debug('Cache miss', { operation: 'get', stepHash, hit: false })
      return null
    }

    // Schema version check — entries without version or with older version are cache misses
    if ((entry.schemaVersion ?? 1) !== CACHE_SCHEMA_VERSION) {
      this.logger?.debug('Cache miss', { operation: 'get', stepHash, hit: false })
      return null
    }

    const age = Date.now() - new Date(entry.createdAt).getTime()
    if (age > this.ttlMs) {
      this.logger?.debug('Cache expired', { operation: 'get', stepHash, hit: false })
      return null
    }

    this.logger?.debug('Cache hit', { operation: 'get', stepHash, hit: true })
    return entry.plan
  }

  async set(
    stepHash: string,
    screenHash: string,
    plan: ActionPlan,
    metadata?: { model: string; provider: string; stepInstruction: string },
  ): Promise<void> {
    const dirPath = join(this.dir, stepHash)
    await mkdir(dirPath, { recursive: true })

    const entry: CacheEntry = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      stepInstruction: metadata?.stepInstruction ?? '',
      stepHash,
      screenHash,
      plan,
      createdAt: new Date().toISOString(),
      model: metadata?.model ?? 'unknown',
      provider: metadata?.provider ?? 'unknown',
    }

    const filePath = this.buildPath(stepHash, screenHash)
    await writeFile(filePath, JSON.stringify(entry, null, 2), 'utf-8')
    this.logger?.debug('Cache set', { operation: 'set', stepHash })
  }

  async invalidate(stepHash: string, screenHash: string): Promise<void> {
    const filePath = this.buildPath(stepHash, screenHash)
    try {
      await unlink(filePath)
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err
    }
  }

  async getSubAction(stepHash: string, index: number): Promise<ActionPlan | null> {
    const filePath = this.buildPath(stepHash, `sub-${index}`)

    let raw: string
    try {
      raw = await readFile(filePath, 'utf-8')
    } catch (err: any) {
      if (err.code === 'ENOENT') return null
      throw err
    }

    let entry: CacheEntry
    try {
      entry = JSON.parse(raw)
    } catch {
      return null
    }

    if ((entry.schemaVersion ?? 1) !== CACHE_SCHEMA_VERSION) {
      return null
    }

    const age = Date.now() - new Date(entry.createdAt).getTime()
    if (age > this.ttlMs) {
      return null
    }

    return entry.plan
  }

  async setSubAction(stepHash: string, index: number, plan: ActionPlan): Promise<void> {
    const dirPath = join(this.dir, stepHash)
    await mkdir(dirPath, { recursive: true })

    const entry: CacheEntry = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      stepInstruction: '',
      stepHash,
      screenHash: `sub-${index}`,
      plan,
      createdAt: new Date().toISOString(),
      model: 'unknown',
      provider: 'unknown',
    }

    const filePath = this.buildPath(stepHash, `sub-${index}`)
    await writeFile(filePath, JSON.stringify(entry, null, 2), 'utf-8')
  }

  async invalidateSubActionsFrom(stepHash: string, fromIndex: number): Promise<void> {
    const dirPath = join(this.dir, stepHash)

    let files: string[]
    try {
      files = await readdir(dirPath)
    } catch (err: any) {
      if (err.code === 'ENOENT') return
      throw err
    }

    const subPattern = /^sub-(\d+)\.json$/
    for (const file of files) {
      const match = file.match(subPattern)
      if (match) {
        const idx = parseInt(match[1], 10)
        if (idx >= fromIndex) {
          try {
            await unlink(join(dirPath, file))
          } catch (err: any) {
            if (err.code !== 'ENOENT') throw err
          }
        }
      }
    }
  }

  private buildPath(stepHash: string, screenHash: string): string {
    return join(this.dir, stepHash, `${screenHash}.json`)
  }
}

export function parseTTL(ttl: string): number {
  return ms(ttl as ms.StringValue) ?? 7 * 86400000
}
