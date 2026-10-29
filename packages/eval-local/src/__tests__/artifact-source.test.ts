import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FsEvidenceArtifactStore } from '@vostride/agent-qa-runner-local'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  DirArtifactSource,
  FsRunArtifactSource,
  absentArtifactSource,
} from '../artifact-source.js'
import {
  LOCAL_FIXTURE_BLOB_BYTES,
  LOCAL_FIXTURE_BLOB_SHA,
} from './fixtures/local-handoff-fixture.js'

describe('artifact sources', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'eval-local-artifacts-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('models a run with no sha-keyed blob store as honest absence', () => {
    expect(absentArtifactSource.getBlob(LOCAL_FIXTURE_BLOB_SHA)).toBeUndefined()
  })

  it('serves an existing lowercase 64-hex blob and reports an absent blob', async () => {
    await writeFile(join(dir, LOCAL_FIXTURE_BLOB_SHA), LOCAL_FIXTURE_BLOB_BYTES)
    const source = new DirArtifactSource({ dir })

    expect(source.getBlob(LOCAL_FIXTURE_BLOB_SHA)).toEqual(LOCAL_FIXTURE_BLOB_BYTES)
    expect(source.getBlob('f'.repeat(64))).toBeUndefined()
  })

  it('rejects malformed shas before any filesystem read', () => {
    const source = new DirArtifactSource({ dir: '\0must-not-reach-fs' })

    expect(source.getBlob('../outside')).toBeUndefined()
    expect(source.getBlob('A'.repeat(64))).toBeUndefined()
  })
})

describe('FsRunArtifactSource over the production run store', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'eval-local-run-source-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('reads exact bytes persisted by the production store at the same root/runId', () => {
    const runId = 'run / eval-local artifact-source'
    const ref = new FsEvidenceArtifactStore({ root, runId }).persistDecisionScreenshot(
      LOCAL_FIXTURE_BLOB_BYTES,
    )
    expect(ref.sha).toBe(LOCAL_FIXTURE_BLOB_SHA)

    const source = new FsRunArtifactSource({ root, runId })
    expect(source.getBlob(ref.sha)).toEqual(LOCAL_FIXTURE_BLOB_BYTES)
  })

  it('returns undefined for a valid but absent sha', () => {
    const source = new FsRunArtifactSource({ root, runId: 'run / eval-local absent' })

    expect(source.getBlob(LOCAL_FIXTURE_BLOB_SHA)).toBeUndefined()
    expect(source.getBlob('f'.repeat(64))).toBeUndefined()
  })

  it('rejects malformed, traversal, and uppercase shas before any filesystem read', () => {
    const source = new FsRunArtifactSource({ root, runId: 'run / eval-local malformed' })

    expect(source.getBlob('../outside')).toBeUndefined()
    expect(source.getBlob('A'.repeat(64))).toBeUndefined()
    expect(source.getBlob('not-hex')).toBeUndefined()
  })

  it('cannot read another run scope from a differently scoped source', () => {
    const runA = 'run / eval-local source A'
    const runB = 'run / eval-local source B'
    new FsEvidenceArtifactStore({ root, runId: runA }).persistDecisionScreenshot(
      LOCAL_FIXTURE_BLOB_BYTES,
    )

    const sourceB = new FsRunArtifactSource({ root, runId: runB })
    expect(sourceB.getBlob(LOCAL_FIXTURE_BLOB_SHA)).toBeUndefined()

    const sourceA = new FsRunArtifactSource({ root, runId: runA })
    expect(sourceA.getBlob(LOCAL_FIXTURE_BLOB_SHA)).toEqual(LOCAL_FIXTURE_BLOB_BYTES)
  })
})
