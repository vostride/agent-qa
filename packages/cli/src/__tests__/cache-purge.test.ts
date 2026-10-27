import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, writeFile, rm, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Command } from 'commander'

// Phase 356 cache layout: <cacheRoot>/<branch-slug>/<cacheKey>.json. The 16-hex cacheKey
// is opaque + content-addressed over masked step text and a runtime screenIdentityHash, so
// entries cannot be recomputed from a test file (no raw step text on disk, D-06). Purge
// therefore operates over the on-disk branch namespaces directly.

const TMP_DIR = join(tmpdir(), 'agent-qa-cache-purge-test-' + process.pid)

async function seedEntry(cacheDir: string, branch: string, key: string): Promise<void> {
  await mkdir(join(cacheDir, branch), { recursive: true })
  await writeFile(join(cacheDir, branch, `${key}.json`), '{"schemaVersion":10,"value":{}}')
}

beforeEach(async () => {
  await mkdir(TMP_DIR, { recursive: true })
})

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true })
})

describe('purgeAll', () => {
  // 2026-10-01 (432-15, D-14): re-spelled from "…with force=true"; purgeAll has no force flag.
  it('deletes all cache-key entries across branch namespaces', async () => {
    const { purgeAll } = await import('../commands/cache.js')
    const cacheDir = join(TMP_DIR, 'cache')
    for (let i = 0; i < 3; i++) await seedEntry(cacheDir, 'main', `key${i}0000000000000`)
    for (let i = 0; i < 2; i++) await seedEntry(cacheDir, 'feature-y', `keyf${i}000000000000`)

    const count = await purgeAll(cacheDir)
    expect(count).toBe(5)
    expect(await readdir(cacheDir)).toEqual([])
  })

  it('returns 0 for non-existent cache dir', async () => {
    const { purgeAll } = await import('../commands/cache.js')
    const count = await purgeAll(join(TMP_DIR, 'nonexistent'))
    expect(count).toBe(0)
  })

  it('returns 0 for empty cache dir', async () => {
    const { purgeAll } = await import('../commands/cache.js')
    const cacheDir = join(TMP_DIR, 'empty-cache')
    await mkdir(cacheDir, { recursive: true })

    const count = await purgeAll(cacheDir)
    expect(count).toBe(0)
  })

  it('uses .agent-qa/cache as the command fallback cache directory', async () => {
    const { createCacheCommand } = await import('../commands/cache.js')
    const cacheDir = join(TMP_DIR, '.agent-qa', 'cache')
    await seedEntry(cacheDir, 'main', 'abcabcabcabcabca')
    await writeFile(join(TMP_DIR, 'agent-qa.config.yaml'), `
workspace:
  testMatch:
    - tests/**/*.yaml
  suiteMatch:
    - suites/**/*.suite.yaml
  hooksFile: hooks.yaml
  envFile: .env
  secretsFile: .env.secrets.local
use:
  mobile:
    appState: preserve
`)

    const parent = new Command()
    parent.exitOverride()
    parent.addCommand(createCacheCommand())

    const originalCwd = process.cwd()
    process.chdir(TMP_DIR)
    try {
      await parent.parseAsync(['node', 'test', 'cache', 'purge', '--all'])
    } finally {
      process.chdir(originalCwd)
    }

    expect(await readdir(cacheDir)).toEqual([])
  })
})
