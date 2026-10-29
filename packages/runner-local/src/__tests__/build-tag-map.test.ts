// Phase 375 RED contract (D-14/D-16/D-17): durable per-product build-tag resolution
// lives beside build-ordinals.json and preserves the first ordinal seen for each tag.
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  BUILD_TAGS_FILE,
  latestBuildOrdinal,
  readBuildTagMap,
  recordBuildTag,
  resolveBuildTag,
} from '../build-tag-map.js'
import { BUILD_ORDINALS_FILE } from '../build-ordinal.js'

describe('build tag map', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'build-tag-map-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('persists exact newline-terminated JSON via atomic rename', async () => {
    await recordBuildTag({ root, product: 'shop', tag: 'v1.2.0', ordinal: 7 })

    expect(resolveBuildTag({ root, product: 'shop', tag: 'v1.2.0' })).toBe(7)
    expect(await readFile(join(root, BUILD_TAGS_FILE), 'utf8')).toBe(
      '{"shop":{"v1.2.0":7}}\n',
    )
    expect((await readdir(root)).some(file => file.endsWith('.tmp'))).toBe(false)
  })

  it('keeps the first-seen ordinal and performs no conflicting rewrite', async () => {
    await recordBuildTag({ root, product: 'shop', tag: 'v1.2.0', ordinal: 7 })
    const before = await readFile(join(root, BUILD_TAGS_FILE))

    await recordBuildTag({ root, product: 'shop', tag: 'v1.2.0', ordinal: 9 })

    expect(resolveBuildTag({ root, product: 'shop', tag: 'v1.2.0' })).toBe(7)
    expect(await readFile(join(root, BUILD_TAGS_FILE))).toEqual(before)
  })

  it('adds an unrelated tag without clobbering existing product truth', async () => {
    await recordBuildTag({ root, product: 'shop', tag: 'v1.2.0', ordinal: 7 })
    await recordBuildTag({ root, product: 'shop', tag: 'v1.3.0', ordinal: 8 })

    expect(readBuildTagMap({ root })).toEqual({
      shop: { 'v1.2.0': 7, 'v1.3.0': 8 },
    })
  })

  it('isolates tag mappings for two products', async () => {
    await recordBuildTag({ root, product: 'shop', tag: 'v1.2.0', ordinal: 7 })
    await recordBuildTag({ root, product: 'api', tag: 'v1.2.0', ordinal: 3 })

    expect(readBuildTagMap({ root })).toEqual({
      shop: { 'v1.2.0': 7 },
      api: { 'v1.2.0': 3 },
    })
  })

  it('returns undefined for an unknown product or tag', () => {
    expect(resolveBuildTag({ root, product: 'shop', tag: 'missing' })).toBeUndefined()
    expect(resolveBuildTag({ root, product: 'missing', tag: 'v1.2.0' })).toBeUndefined()
  })

  it('treats missing, corrupt, and non-object tag maps as empty', async () => {
    const tagFile = join(root, BUILD_TAGS_FILE)
    expect(readBuildTagMap({ root })).toEqual({})

    await writeFile(tagFile, '{ not valid json', 'utf8')
    expect(readBuildTagMap({ root })).toEqual({})

    for (const nonObject of ['null', '[]', '"value"']) {
      await writeFile(tagFile, nonObject, 'utf8')
      expect(readBuildTagMap({ root })).toEqual({})
    }
  })

  it('drops invalid products and non-number tag values while retaining valid entries', async () => {
    await writeFile(
      join(root, BUILD_TAGS_FILE),
      JSON.stringify({
        shop: { valid: 7, string: '8', nested: { ordinal: 9 }, absent: null },
        api: 'not-a-tag-map',
        mobile: ['v1.0.0', 2],
        empty: {},
      }),
      'utf8',
    )

    expect(readBuildTagMap({ root })).toEqual({ shop: { valid: 7 }, empty: {} })
  })

  it('starts fresh from corrupt state when recording a tag', async () => {
    await writeFile(join(root, BUILD_TAGS_FILE), '{ corrupt', 'utf8')

    await recordBuildTag({ root, product: 'shop', tag: 'v1.2.0', ordinal: 7 })

    expect(await readFile(join(root, BUILD_TAGS_FILE), 'utf8')).toBe(
      '{"shop":{"v1.2.0":7}}\n',
    )
  })

  it('reads latest ordinals purely and returns zero for missing or invalid values', async () => {
    expect(latestBuildOrdinal({ root, product: 'shop' })).toBe(0)

    const ordinalFile = join(root, BUILD_ORDINALS_FILE)
    await writeFile(ordinalFile, '{"shop":12,"invalid":"13"}\n', 'utf8')
    const before = await readFile(ordinalFile)

    expect(latestBuildOrdinal({ root, product: 'shop' })).toBe(12)
    expect(latestBuildOrdinal({ root, product: 'missing' })).toBe(0)
    expect(latestBuildOrdinal({ root, product: 'invalid' })).toBe(0)
    expect(await readFile(ordinalFile)).toEqual(before)
  })
})
