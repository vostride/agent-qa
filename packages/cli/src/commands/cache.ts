import { Command } from 'commander'
import pc from 'picocolors'
import { readdir, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { DEFAULT_AGENT_QA_CACHE_DIR } from '@vostride/agent-qa-core'
import { resolveConfig } from '../config.js'

const CACHE_DIR_FALLBACK = DEFAULT_AGENT_QA_CACHE_DIR || '.agent-qa/cache'

/**
 * Count + remove all `<branch-slug>/<cacheKey>.json` entries under the redesigned cache
 * root (Phase 356 layout, D-06/D-14). The 16-hex cacheKey is the whole filename and folds
 * a runtime screenIdentityHash, so entries are opaque and content-addressed — they cannot
 * be recomputed statically from a test file. Purge therefore operates over the on-disk
 * layout directly.
 */
async function removeCacheEntries(cacheRoot: string): Promise<number> {
  let branchDirs: string[]
  try {
    branchDirs = await readdir(cacheRoot)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw err
  }

  let purged = 0
  for (const branch of branchDirs) {
    const branchPath = join(cacheRoot, branch)
    let entryStat
    try {
      entryStat = await stat(branchPath)
    } catch {
      continue
    }
    if (!entryStat.isDirectory()) {
      await rm(branchPath, { force: true })
      continue
    }
    let files: string[]
    try {
      files = await readdir(branchPath)
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      await rm(join(branchPath, file), { force: true })
      purged++
    }
    // Remove the now-empty branch namespace directory (best-effort).
    await rm(branchPath, { recursive: true, force: true }).catch(() => {})
  }

  return purged
}

async function countCacheEntries(cacheRoot: string): Promise<number> {
  let branchDirs: string[]
  try {
    branchDirs = await readdir(cacheRoot)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw err
  }
  let count = 0
  for (const branch of branchDirs) {
    try {
      const files = await readdir(join(cacheRoot, branch))
      count += files.filter((f) => f.endsWith('.json')).length
    } catch {
      // not a directory — skip
    }
  }
  return count
}

// Running `cache purge --all` is the intent: there is no confirmation step.
export async function purgeAll(cacheDir: string): Promise<number> {
  const resolvedDir = resolve(cacheDir)
  const total = await countCacheEntries(resolvedDir)
  if (total === 0) return 0
  return removeCacheEntries(resolvedDir)
}

export function createCacheCommand(): Command {
  const cmd = new Command('cache').description('Manage action cache')

  cmd
    .command('purge')
    .description('Clear cached action plans')
    .option('--all', 'purge all cached plans')
    .action(async (opts) => {
      if (!opts.all) {
        console.error(pc.red('Specify --all'))
        process.exitCode = 1
        return
      }

      const parentOpts = cmd.parent?.opts() ?? {}
      const config = await resolveConfig({
        configPath: parentOpts.config as string | undefined,
      })
      const cacheDir = config.services?.cache?.dir ?? CACHE_DIR_FALLBACK

      const count = await purgeAll(cacheDir)
      if (count === 0) {
        console.log(pc.dim('No cached plans found'))
      } else {
        console.log(pc.green(`Purged ${count} cached plans (all)`))
      }
    })

  return cmd
}
