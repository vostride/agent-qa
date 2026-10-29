// Raw round-trip, traversal-safe names, stable fingerprints and `undefined` for a missing name.
import { readdir, rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FsStorageStateStore, STORAGE_STATES_SUBDIR } from '../storage-state-store.js'

interface StorageBlob {
  cookies: { name: string; value: string; domain: string }[]
  origins: { origin: string; localStorage: { name: string; value: string }[] }[]
}

function makeBlob(token = 'sekret-abc'): StorageBlob {
  return {
    cookies: [{ name: 'session', value: token, domain: 'example.test' }],
    origins: [{ origin: 'https://example.test', localStorage: [{ name: 'jwt', value: token }] }],
  }
}

describe('FsStorageStateStore', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fs-storage-state-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('round-trips a raw storage-state blob byte-identical', async () => {
    const store = new FsStorageStateStore({ root })
    const blob = makeBlob()

    const ref = await store.save('admin', blob)
    const loaded = await store.load('admin')

    expect(loaded).toEqual(blob)
    // The reference carries only name and fingerprint, never the blob.
    expect(ref.name).toBe('admin')
    expect(ref.fingerprint).toMatch(/^[0-9a-f]{16}$/)
    expect(Object.keys(ref)).toEqual(['name', 'fingerprint'])
  })

  it('slugs a traversal-shaped name to a file that stays INSIDE storage-states/', async () => {
    const store = new FsStorageStateStore({ root })
    const evilName = '../../etc/passwd'

    await store.save(evilName, makeBlob())

    const statesDir = resolve(root, STORAGE_STATES_SUBDIR)
    const files = await readdir(statesDir)
    expect(files).toHaveLength(1)

    // The single written file resolves under storage-states/ — no escape.
    const resolvedEntry = resolve(statesDir, files[0])
    expect(resolvedEntry.startsWith(statesDir + sep)).toBe(true)
    expect(files[0]).not.toContain('..')
    expect(files[0]).not.toContain('/')

    // And it is still loadable by the original (un-slugged) name.
    expect(await store.load(evilName)).toEqual(makeBlob())
  })

  it('fingerprints identical content stably and different content differently', async () => {
    const store = new FsStorageStateStore({ root })

    const a1 = await store.save('a', makeBlob('same'))
    const a2 = await store.save('a2', makeBlob('same'))
    const b = await store.save('b', makeBlob('different'))

    expect(a1.fingerprint).toBe(a2.fingerprint)
    expect(a1.fingerprint).not.toBe(b.fingerprint)
  })

  it('returns undefined for a missing name — never throws', async () => {
    const store = new FsStorageStateStore({ root })
    await expect(store.load('never-saved')).resolves.toBeUndefined()
  })
})
