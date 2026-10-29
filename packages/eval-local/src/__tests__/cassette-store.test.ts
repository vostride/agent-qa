import { isAbsolute, join, relative } from 'node:path'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import {
  extractRunCassettes,
  guardCassette,
  type ExtractedCassette,
} from '@vostride/agent-qa-eval'
import { slugBranch } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  BLOBS_SUBDIR,
  CASSETTE_FILE,
  DEFAULT_EVAL_CASSETTES_SUBDIR,
  FsCassetteStore,
} from '../cassette-store.js'
import {
  LOCAL_FIXTURE_BLOB_BYTES,
  LOCAL_FIXTURE_BLOB_SHA,
  makeLocalV2Handoff,
} from './fixtures/local-handoff-fixture.js'

function fixtureLeaf(): ExtractedCassette {
  const result = extractRunCassettes({
    handoff: makeLocalV2Handoff(),
    artifacts: {
      getBlob: sha => (sha === LOCAL_FIXTURE_BLOB_SHA ? LOCAL_FIXTURE_BLOB_BYTES : undefined),
    },
  })
  const leaf = result.cassettes.find(entry => entry.cassette.granularity === 'leaf')
  if (leaf === undefined) throw new Error('local fixture did not emit a leaf cassette')
  return leaf
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

describe('FsCassetteStore', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'eval-local-cassettes-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('writes a leaf bundle under the default run/id layout with verified blob bytes', async () => {
    const extracted = fixtureLeaf()
    const written = new FsCassetteStore({ root }).write(extracted)
    const outputRoot = join(root, DEFAULT_EVAL_CASSETTES_SUBDIR)
    const expectedDir = join(
      outputRoot,
      ...extracted.cassette.id.split('/').map(segment => slugBranch(segment)),
    )

    expect(written).toEqual({
      id: extracted.cassette.id,
      dir: expectedDir,
      writtenBlobShas: [LOCAL_FIXTURE_BLOB_SHA],
      corruptBlobShas: [],
    })
    expect(await readFile(join(expectedDir, BLOBS_SUBDIR, LOCAL_FIXTURE_BLOB_SHA))).toEqual(
      Buffer.from(LOCAL_FIXTURE_BLOB_BYTES),
    )
  })

  it('writes text-only cassettes without creating a blobs directory', async () => {
    const source = fixtureLeaf()
    const extracted: ExtractedCassette = {
      cassette: {
        ...source.cassette,
        blobs: [],
        completeness: { status: 'complete' },
      },
      blobs: [],
    }
    const written = new FsCassetteStore({ root }).write(extracted)

    expect(await exists(join(written.dir, CASSETTE_FILE))).toBe(true)
    expect(await exists(join(written.dir, BLOBS_SUBDIR))).toBe(false)
  })

  it('serializes cassette.json as stable two-space human-diffable JSON', async () => {
    const extracted = fixtureLeaf()
    const written = new FsCassetteStore({ root }).write(extracted)
    const raw = await readFile(join(written.dir, CASSETTE_FILE), 'utf8')

    expect(raw).toBe(`${JSON.stringify(extracted.cassette, null, 2)}\n`)
    expect(guardCassette(JSON.parse(raw))).toEqual(extracted.cassette)
  })

  it('omits byte-sha mismatches and persists evidence-incomplete completeness', async () => {
    const source = fixtureLeaf()
    const claimedSha = 'f'.repeat(64)
    const extracted: ExtractedCassette = {
      cassette: {
        ...source.cassette,
        blobs: [claimedSha],
        completeness: { status: 'complete' },
      },
      blobs: [{ sha: claimedSha, bytes: Uint8Array.from([1, 2, 3]) }],
    }
    const written = new FsCassetteStore({ root }).write(extracted)
    const persisted = guardCassette(
      JSON.parse(await readFile(join(written.dir, CASSETTE_FILE), 'utf8')),
    )

    expect(written.writtenBlobShas).toEqual([])
    expect(written.corruptBlobShas).toEqual([claimedSha])
    expect(persisted.completeness).toEqual({
      status: 'evidence-incomplete',
      missingBlobShas: [claimedSha],
    })
    expect(await exists(join(written.dir, BLOBS_SUBDIR))).toBe(false)
  })

  it('recreates an idempotent bundle with byte-identical JSON and no stale leftovers', async () => {
    const store = new FsCassetteStore({ root })
    const extracted = fixtureLeaf()
    const first = store.write(extracted)
    const firstJson = await readFile(join(first.dir, CASSETTE_FILE))
    await writeFile(join(first.dir, 'stale.txt'), 'must be removed')

    const second = store.write(extracted)
    const secondJson = await readFile(join(second.dir, CASSETTE_FILE))

    expect(second.dir).toBe(first.dir)
    expect(secondJson).toEqual(firstJson)
    expect(await exists(join(second.dir, 'stale.txt'))).toBe(false)
  })

  it('sanitizes every hostile cassette id segment under the configured output root', () => {
    const source = fixtureLeaf()
    const extracted: ExtractedCassette = {
      ...source,
      cassette: {
        ...source.cassette,
        id: '../../hostile/run\\escape/../cassette',
      },
    }
    const outputRoot = join(root, DEFAULT_EVAL_CASSETTES_SUBDIR)
    const written = new FsCassetteStore({ root }).write(extracted)
    const destination = relative(outputRoot, written.dir)

    expect(isAbsolute(destination)).toBe(false)
    expect(destination).not.toMatch(/^\.\.(?:[/\\]|$)/)
    expect(written.dir.startsWith(`${outputRoot}/`)).toBe(true)
  })

  it('never uses a malformed blob sha as a filename and reports the skipped blob', async () => {
    const source = fixtureLeaf()
    const invalidSha = '../not-a-content-sha'
    const extracted: ExtractedCassette = {
      cassette: { ...source.cassette, blobs: [], completeness: { status: 'complete' } },
      blobs: [{ sha: invalidSha, bytes: Uint8Array.from([9, 8, 7]) }],
    }
    const written = new FsCassetteStore({ root }).write(extracted)

    expect(written.writtenBlobShas).toEqual([])
    expect(written.corruptBlobShas).toEqual([invalidSha])
    expect(await exists(join(written.dir, BLOBS_SUBDIR))).toBe(false)
    expect(await exists(join(root, 'not-a-content-sha'))).toBe(false)
  })
})
