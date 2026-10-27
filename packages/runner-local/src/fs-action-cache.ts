// Concrete filesystem action-plan cache store.
//
// Implements the storage-neutral `ActionPlanCache` port from
// @vostride/agent-qa-runner. On-disk layout:
//
//   <root>/<slug(branch)>/<cacheKey>.json
//
// The 16-hex CacheKey is the whole filename, so no raw step text or secret can
// appear on disk. Writes go only to the current-branch namespace. Reads fall back
// from the current branch to the default branch unless the current branch holds a
// suppression marker for the key. An entry stamped with any other
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

type CacheEnvelope =
  { schemaVersion: number; value: CachedPlanValue } | { schemaVersion: number; suppressed: true }

type ReadResult = { kind: 'value'; value: CachedPlanValue } | { kind: 'suppressed' } | null

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
    if (this.policy.disableCache) return null

    const onCurrent = await this.readEntry(this.policy.currentBranch, key)
    if (onCurrent?.kind === 'suppressed') return null
    if (onCurrent?.kind === 'value') return onCurrent.value

    if (this.policy.currentBranch !== this.policy.defaultBranch) {
      const onDefault = await this.readEntry(this.policy.defaultBranch, key)
      return onDefault?.kind === 'value' ? onDefault.value : null
    }
    return null
  }

  async set(key: CacheKey, value: CachedPlanValue): Promise<void> {
    if (!shouldWrite(this.policy)) return
    await this.writeEnvelope(key, { schemaVersion: CACHE_SCHEMA_VERSION, value })
  }

  async invalidate(key: CacheKey): Promise<void> {
    const { currentBranch, defaultBranch } = this.policy
    // The default branch's entry is never changed from another branch: a marker on the
    // current branch hides it instead.
    if (currentBranch !== defaultBranch) {
      const onDefault = await this.readEntry(defaultBranch, key)
      if (onDefault?.kind === 'value') {
        await this.writeEnvelope(key, { schemaVersion: CACHE_SCHEMA_VERSION, suppressed: true })
        return
      }
    }
    try {
      await unlink(this.entryPath(this.branchDir(currentBranch), key))
    } catch (err) {
      if (!isMissing(err)) throw err
    }
  }

  private async writeEnvelope(key: CacheKey, envelope: CacheEnvelope): Promise<void> {
    const dir = this.branchDir(this.policy.currentBranch)
    await mkdir(dir, { recursive: true })
    await writeFile(this.entryPath(dir, key), `${JSON.stringify(envelope, null, 2)}\n`, 'utf-8')
  }

  private branchDir(branch: string): string {
    return join(this.root, slugBranch(branch))
  }

  private entryPath(dir: string, key: CacheKey): string {
    return join(dir, `${key}.json`)
  }

  private async readEntry(branch: string, key: CacheKey): Promise<ReadResult> {
    let raw: string
    try {
      raw = await readFile(this.entryPath(this.branchDir(branch), key), 'utf-8')
    } catch (err) {
      if (isMissing(err)) return null
      throw err
    }

    let envelope: Partial<{ schemaVersion: number; value: CachedPlanValue; suppressed: boolean }>
    try {
      envelope = JSON.parse(raw) as typeof envelope
    } catch {
      return null // corrupt/partial entry is a miss, never a crash
    }

    if (envelope?.schemaVersion !== CACHE_SCHEMA_VERSION) return null
    if (envelope.suppressed === true) return { kind: 'suppressed' }
    return envelope.value ? { kind: 'value', value: envelope.value } : null
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
