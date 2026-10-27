// Concrete filesystem action-plan cache store (CACHE-04).
//
// Implements the storage-neutral `ActionPlanCache` port from
// @vostride/agent-qa-runner. This is the storageImplementation home for
// node:fs/promises + node:path (D-01/D-02). On-disk layout:
//
//   <root>/<slug(branch)>/<cacheKey>.json
//
// The 16-hex CacheKey is the WHOLE filename (D-06) — no raw step text or secret
// can appear on disk. Writes go only to the current-branch namespace; reads fall
// back current-branch -> default-branch. An entry stamped with any other
// CACHE_SCHEMA_VERSION is never read as valid.

import { mkdir, readdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'

import type { ActionPlanCache, CachedPlanValue } from '@vostride/agent-qa-runner'
import type { CacheKey } from '@vostride/agent-qa-schema'

import { slugBranch } from './branch-resolver.js'
import { shouldWrite, type CachePolicy } from './write-policy.js'

/** Envelopes live under <root>/<branchSlug>/<key>.json; any other stamp reads as a miss. */
export const CACHE_SCHEMA_VERSION = 2

const CACHE_ENTRY_FILE_RE = /^[0-9a-f]{16}\.json$/

interface CacheEnvelope {
  schemaVersion: number
  value: CachedPlanValue
}

export interface FsActionCacheConfig {
  /** Cache root (e.g. DEFAULT_AGENT_QA_CACHE_DIR = '.agent-qa/cache'). */
  root: string
  /** Resolved branch context + write policy (branch + CI + flags). */
  policy: CachePolicy
}

export class FsActionCache implements ActionPlanCache {
  private readonly root: string
  private readonly policy: CachePolicy

  constructor(config: FsActionCacheConfig) {
    this.root = config.root
    this.policy = config.policy
  }

  async get(key: CacheKey): Promise<CachedPlanValue | null> {
    // --disable-cache short-circuits reads (D-15).
    if (this.policy.disableCache) return null

    const onCurrent = await this.readEntry(this.policy.currentBranch, key)
    if (onCurrent !== null) return onCurrent

    // branch -> default read fallback (D-14). Never the other direction.
    if (this.policy.currentBranch !== this.policy.defaultBranch) {
      return this.readEntry(this.policy.defaultBranch, key)
    }
    return null
  }

  async set(key: CacheKey, value: CachedPlanValue): Promise<void> {
    // No-op when the write policy forbids it (protected branch, disable, etc.).
    if (!shouldWrite(this.policy)) return

    // Writes go only to the current-branch namespace — a feature branch never
    // overwrites the default branch's entries (D-14).
    const dir = this.branchDir(this.policy.currentBranch)
    await mkdir(dir, { recursive: true })
    const envelope: CacheEnvelope = { schemaVersion: CACHE_SCHEMA_VERSION, value }
    await writeFile(this.entryPath(dir, key), `${JSON.stringify(envelope, null, 2)}\n`, 'utf-8')
  }

  async invalidate(key: CacheKey): Promise<void> {
    const dir = this.branchDir(this.policy.currentBranch)
    try {
      await unlink(this.entryPath(dir, key))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }

  private branchDir(branch: string): string {
    return join(this.root, slugBranch(branch))
  }

  private entryPath(dir: string, key: CacheKey): string {
    // The hex CacheKey is the whole filename (D-06).
    return join(dir, `${key}.json`)
  }

  private async readEntry(branch: string, key: CacheKey): Promise<CachedPlanValue | null> {
    let raw: string
    try {
      raw = await readFile(this.entryPath(this.branchDir(branch), key), 'utf-8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }

    let envelope: CacheEnvelope
    try {
      envelope = JSON.parse(raw) as CacheEnvelope
    } catch {
      return null // corrupt/partial entry is a miss, never a crash
    }

    if (envelope?.schemaVersion !== CACHE_SCHEMA_VERSION) return null
    return envelope.value ?? null
  }
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT'
}

/**
 * Removes every `<root>/<branch-slug>/<16-hex>.json` entry, and a branch directory only when that
 * leaves it empty. Nothing else under `root` is touched, so a cache root that also holds other
 * files keeps them. Returns the number of entries removed.
 */
export async function purgeActionCache(root: string): Promise<number> {
  let branches: Dirent[]
  try {
    branches = await readdir(root, { withFileTypes: true })
  } catch (err) {
    if (isMissing(err)) return 0
    throw err
  }

  let purged = 0
  for (const branch of branches) {
    if (!branch.isDirectory() || slugBranch(branch.name) !== branch.name) continue
    const dir = join(root, branch.name)
    const entries = await readdir(dir, { withFileTypes: true })
    let removed = 0
    for (const entry of entries) {
      if (!entry.isFile() || !CACHE_ENTRY_FILE_RE.test(entry.name)) continue
      try {
        await unlink(join(dir, entry.name))
      } catch (err) {
        if (!isMissing(err)) throw err
      }
      removed++
    }
    purged += removed
    if (removed > 0 && removed === entries.length) {
      await rmdir(dir).catch(() => {})
    }
  }
  return purged
}
