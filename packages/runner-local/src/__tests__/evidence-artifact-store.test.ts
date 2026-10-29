// Content-addressed blobs under the slugged run dir; malformed shas are rejected before path use.
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FsEvidenceArtifactStore, RUN_EVIDENCE_BLOBS_SUBDIR } from '../evidence-artifact-store.js'
import { slugBranch } from '../branch-resolver.js'
import { RUNS_SUBDIR } from '../event-log.js'

function sha256hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function blobsDir(root: string, runId: string): string {
  return join(root, RUNS_SUBDIR, slugBranch(runId), RUN_EVIDENCE_BLOBS_SUBDIR)
}

describe('FsEvidenceArtifactStore', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fs-evidence-artifact-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('mints a decision-screenshot ref whose sha is the byte-level SHA-256 of the exact bytes', () => {
    const store = new FsEvidenceArtifactStore({ root, runId: 'run-1' })
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10])

    const ref = store.persistDecisionScreenshot(bytes)

    const expectedSha = sha256hex(bytes)
    expect(ref.sha).toBe(expectedSha)
    expect(ref.id).toBe(`decision-screenshot:${expectedSha}`)
  })

  it('writes the bytes at blobs/<sha> and reads them back byte-for-byte', () => {
    const store = new FsEvidenceArtifactStore({ root, runId: 'run-1' })
    const bytes = new Uint8Array([1, 2, 3, 250, 0, 128])

    const ref = store.persistDecisionScreenshot(bytes)
    const read = store.getBlob(ref.sha)

    expect(read).toBeInstanceOf(Uint8Array)
    expect(read && Array.from(read)).toEqual(Array.from(bytes))
  })

  it('is idempotent — writing identical bytes twice retains exactly one content file', async () => {
    const store = new FsEvidenceArtifactStore({ root, runId: 'run-1' })
    const bytes = new Uint8Array([9, 8, 7, 6])

    const first = store.persistDecisionScreenshot(bytes)
    const second = store.persistDecisionScreenshot(bytes)

    expect(second.sha).toBe(first.sha)
    const entries = await readdir(blobsDir(root, 'run-1'))
    expect(entries).toEqual([first.sha])
  })

  it('returns undefined for a valid but absent sha', () => {
    const store = new FsEvidenceArtifactStore({ root, runId: 'run-1' })
    const absent = sha256hex(new Uint8Array([42]))

    expect(store.getBlob(absent)).toBeUndefined()
  })

  it('rejects a malformed/traversal-shaped sha before any path use and leaves the dir untouched', async () => {
    const store = new FsEvidenceArtifactStore({ root, runId: 'run-1' })
    store.persistDecisionScreenshot(new Uint8Array([1]))
    const before = await readdir(blobsDir(root, 'run-1'))

    expect(store.getBlob('../../../../etc/passwd')).toBeUndefined()
    expect(store.getBlob('not-a-sha')).toBeUndefined()
    expect(store.getBlob('ABCDEF')).toBeUndefined()
    // Uppercase 64-hex is not the canonical lowercase digest and must be rejected.
    expect(store.getBlob(sha256hex(new Uint8Array([1])).toUpperCase())).toBeUndefined()

    const after = await readdir(blobsDir(root, 'run-1'))
    expect(after).toEqual(before)
  })

  it('contains a hostile runId under the configured root via slugBranch', async () => {
    const evilRunId = '../../escape'
    const store = new FsEvidenceArtifactStore({ root, runId: evilRunId })
    const ref = store.persistDecisionScreenshot(new Uint8Array([5, 5, 5]))

    const slug = slugBranch(evilRunId)
    expect(slug).not.toContain('..')
    expect(slug).not.toContain('/')
    // The blob is reachable only through the slugged run dir under root — never outside it.
    const file = join(blobsDir(root, evilRunId), ref.sha)
    expect((await stat(file)).isFile()).toBe(true)
  })
})

// `hasBlob` stats, never reads, so a run-detail page does not read every screenshot.
describe('FsEvidenceArtifactStore.hasBlob — presence without a read', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fs-evidence-has-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('hasBlob answers true for a sha the store just wrote, and false once it is unlinked', async () => {
    const store = new FsEvidenceArtifactStore({ root, runId: 'run-1' })
    const ref = store.persistDecisionScreenshot(new Uint8Array([7, 7, 7, 7]))

    expect(store.hasBlob(ref.sha)).toBe(true)

    await rm(join(blobsDir(root, 'run-1'), ref.sha))
    expect(store.hasBlob(ref.sha)).toBe(false)
  })

  it('hasBlob answers false for a well-formed sha nothing ever wrote', () => {
    const store = new FsEvidenceArtifactStore({ root, runId: 'run-1' })
    store.persistDecisionScreenshot(new Uint8Array([1]))

    expect(store.hasBlob(sha256hex(new Uint8Array([42])))).toBe(false)
  })

  it('hasBlob refuses a malformed sha before any path use — a store over a root that does not exist still answers false, never throws', () => {
    // The root is deliberately absent: a guard that ran AFTER the join would surface the host's
    // ENOENT shape instead of the contract's `false`, and `existsSync` would answer about a path
    // assembled from the caller's string.
    const store = new FsEvidenceArtifactStore({ root: join(root, 'no-such-root'), runId: 'run-1' })

    expect(store.hasBlob('../../../../etc/passwd')).toBe(false)
    expect(store.hasBlob('not-a-sha')).toBe(false)
    expect(store.hasBlob(sha256hex(new Uint8Array([1])).toUpperCase())).toBe(false)
    expect(store.hasBlob('a'.repeat(63))).toBe(false)
    expect(store.hasBlob(sha256hex(new Uint8Array([1])))).toBe(false)
  })
})
