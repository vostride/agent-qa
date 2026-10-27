import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { CachedPlanValue } from '@vostride/agent-qa-runner'
import type { CacheKey } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CACHE_SCHEMA_VERSION, FsActionCache, purgeActionCache } from '../fs-action-cache.js'
import type { CachePolicy } from '../write-policy.js'

const KEY = '0123456789abcdef' as CacheKey

function makeValue(outcome: 'passed' | 'failed' = 'passed'): CachedPlanValue {
  return {
    plannedActions: [],
    groundedLocator: [{ role: 'button', name: 'Submit' }],
    verificationOutcome: outcome,
  }
}

function makePolicy(overrides: Partial<CachePolicy> = {}): CachePolicy {
  return {
    currentBranch: 'main',
    defaultBranch: 'main',
    protectedBranches: [],
    isCI: false,
    saveCache: false,
    disableCache: false,
    ...overrides,
  }
}

describe('FsActionCache', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fs-action-cache-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('write -> read round-trips within a branch namespace', async () => {
    const cache = new FsActionCache({ root, policy: makePolicy({ currentBranch: 'feature-x' }) })
    const value = makeValue()

    await cache.set(KEY, value)
    const read = await cache.get(KEY)

    expect(read).toEqual(value)
  })

  it('writes exactly <cacheKey>.json under the slugged current-branch dir', async () => {
    const cache = new FsActionCache({ root, policy: makePolicy({ currentBranch: 'feature/login' }) })

    await cache.set(KEY, makeValue())

    // slug replaces the `/` — no nested dir, single safe segment.
    const files = await readdir(join(root, 'feature-login'))
    expect(files).toEqual([`${KEY}.json`])
  })

  it('falls back current-branch miss -> default-branch entry', async () => {
    // Seed the default branch only.
    const defaultCache = new FsActionCache({
      root,
      policy: makePolicy({ currentBranch: 'main', defaultBranch: 'main' }),
    })
    const value = makeValue('failed')
    await defaultCache.set(KEY, value)

    // Read from a feature branch with no entry of its own.
    const featureCache = new FsActionCache({
      root,
      policy: makePolicy({ currentBranch: 'feature-x', defaultBranch: 'main' }),
    })
    const read = await featureCache.get(KEY)

    expect(read).toEqual(value)
  })

  it('never falls default -> feature (feature entry is not visible from main)', async () => {
    const featureCache = new FsActionCache({
      root,
      policy: makePolicy({ currentBranch: 'feature-x', defaultBranch: 'main', saveCache: true }),
    })
    await featureCache.set(KEY, makeValue())

    const mainCache = new FsActionCache({
      root,
      policy: makePolicy({ currentBranch: 'main', defaultBranch: 'main' }),
    })
    expect(await mainCache.get(KEY)).toBeNull()
  })

  it.each([1, 9, 10, 11, 12])('stamps 2 and reads any other stamp as a miss (%i)', async (stamp) => {
    expect(CACHE_SCHEMA_VERSION).toBe(2)
    const dir = join(root, 'main')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, `${KEY}.json`),
      JSON.stringify({ schemaVersion: stamp, value: makeValue() }),
      'utf-8',
    )

    const cache = new FsActionCache({ root, policy: makePolicy() })
    expect(await cache.get(KEY)).toBeNull()
  })

  it('round-trips a current envelope', async () => {
    const dir = join(root, 'main')
    await mkdir(dir, { recursive: true })
    const value = makeValue()
    value.groundedLocator = [{ role: 'button', name: 'Edit label', row: '7 Elm Street' }]
    await writeFile(
      join(dir, `${KEY}.json`),
      JSON.stringify({ schemaVersion: CACHE_SCHEMA_VERSION, value }),
      'utf-8',
    )

    const cache = new FsActionCache({ root, policy: makePolicy() })
    expect(await cache.get(KEY)).toEqual(value)
  })

  it('returns null for a corrupt entry rather than throwing', async () => {
    const dir = join(root, 'main')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${KEY}.json`), '{ not json', 'utf-8')

    const cache = new FsActionCache({ root, policy: makePolicy() })
    expect(await cache.get(KEY)).toBeNull()
  })

  it('short-circuits get to null when disableCache is set', async () => {
    const writer = new FsActionCache({ root, policy: makePolicy() })
    await writer.set(KEY, makeValue())

    const disabled = new FsActionCache({ root, policy: makePolicy({ disableCache: true }) })
    expect(await disabled.get(KEY)).toBeNull()
  })

  it('set is a no-op when the write policy forbids it (protected, not save, not CI)', async () => {
    const cache = new FsActionCache({
      root,
      policy: makePolicy({ currentBranch: 'main', protectedBranches: ['main'] }),
    })

    await cache.set(KEY, makeValue())
    // Nothing written -> a fresh reader (unprotected) sees a miss.
    const reader = new FsActionCache({ root, policy: makePolicy({ currentBranch: 'main' }) })
    expect(await reader.get(KEY)).toBeNull()
  })

  it('invalidate removes the current-branch entry', async () => {
    const cache = new FsActionCache({ root, policy: makePolicy({ currentBranch: 'feature-x' }) })
    await cache.set(KEY, makeValue())
    expect(await cache.get(KEY)).not.toBeNull()

    await cache.invalidate(KEY)
    expect(await cache.get(KEY)).toBeNull()
  })

  it('invalidate is a no-op (no throw) when the entry is absent', async () => {
    const cache = new FsActionCache({ root, policy: makePolicy() })
    await expect(cache.invalidate(KEY)).resolves.toBeUndefined()
  })

  it('every written filename is exactly <cacheKey>.json (no raw text on disk, D-06)', async () => {
    const cache = new FsActionCache({ root, policy: makePolicy({ currentBranch: 'main' }) })
    await cache.set(KEY, makeValue())

    const files = await readdir(join(root, 'main'))
    expect(files).toHaveLength(1)
    expect(files[0]).toBe(`${KEY}.json`)
    // The whole filename is the hex key — no step text/secret leaks into it.
    const onDisk = await readFile(join(root, 'main', files[0]), 'utf-8')
    expect(files[0].replace('.json', '')).toBe(KEY)
    expect(onDisk).toContain(`"schemaVersion": ${CACHE_SCHEMA_VERSION}`)
  })
})

describe('purgeActionCache', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fs-action-cache-purge-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('removes the entries the cache wrote and the branch directories they leave empty', async () => {
    await new FsActionCache({ root, policy: makePolicy({ currentBranch: 'main' }) }).set(KEY, makeValue())
    await new FsActionCache({ root, policy: makePolicy({ currentBranch: 'feature/login' }) })
      .set(KEY, makeValue())

    expect(await purgeActionCache(root)).toBe(2)
    expect(await readdir(root)).toEqual([])
  })

  it('leaves every other file and directory under the root in place', async () => {
    await new FsActionCache({ root, policy: makePolicy({ currentBranch: 'main' }) }).set(KEY, makeValue())
    const kept = [
      join(root, 'notes.txt'),
      join(root, 'main', 'README.md'),
      join(root, 'runs', 'run-1', 'handoff.json'),
      join(root, 'runs', 'summary.json'),
    ]
    for (const path of kept) {
      await mkdir(join(path, '..'), { recursive: true })
      await writeFile(path, 'kept')
    }

    expect(await purgeActionCache(root)).toBe(1)
    for (const path of kept) expect(await readFile(path, 'utf-8')).toBe('kept')
    expect(await readdir(join(root, 'main'))).toEqual(['README.md'])
  })

  it('returns 0 for a root that does not exist', async () => {
    expect(await purgeActionCache(join(root, 'absent'))).toBe(0)
  })
})
