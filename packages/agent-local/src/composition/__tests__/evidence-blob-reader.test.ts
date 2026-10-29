// The evidence-blob reader's PRESENCE arm (406-03, D-17, DETL-05).
//
// `statEvidenceBlob` is `lookupEvidenceBlob` minus the bytes: the same three-way split, over the
// same run-existence rule, so the two can never disagree about WHICH absence a ref is in. These
// cells drive the split from the filesystem the store actually writes to rather than from a fake,
// because the whole claim is about what is on disk.
import { mkdtemp, rm } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RunId } from '@vostride/agent-qa-schema'
import { FsEvidenceArtifactStore, RUNS_SUBDIR, slugBranch } from '@vostride/agent-qa-runner-local'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createEvidenceBlobReader,
  lookupEvidenceBlob,
  statEvidenceBlob,
} from '../evidence-blob-reader.js'

const KNOWN_RUN = 'run-stat-1'

describe('statEvidenceBlob — the shared rule without the read', () => {
  let agentQaRoot: string

  beforeEach(async () => {
    agentQaRoot = await mkdtemp(join(tmpdir(), 'evidence-stat-'))
  })

  afterEach(async () => {
    await rm(agentQaRoot, { recursive: true, force: true })
  })

  function writeBlob(runId: string, bytes: Uint8Array): string {
    return new FsEvidenceArtifactStore({ root: agentQaRoot, runId }).persistDecisionScreenshot(bytes).sha
  }

  function startRunDir(runId: string): void {
    mkdirSync(join(agentQaRoot, RUNS_SUBDIR, slugBranch(runId)), { recursive: true })
  }

  it('answers unknown_run when the run directory itself is absent', () => {
    expect(statEvidenceBlob({ agentQaRoot }, 'run-never-happened', 'a'.repeat(64)))
      .toBe('unknown_run')
  })

  it('answers blob_absent for a run that exists and holds no such blob', () => {
    startRunDir(KNOWN_RUN)

    expect(statEvidenceBlob({ agentQaRoot }, KNOWN_RUN, 'b'.repeat(64))).toBe('blob_absent')
  })

  it('answers found for a blob the store wrote, and blob_absent again once it is gone', async () => {
    const sha = writeBlob(KNOWN_RUN, new Uint8Array([3, 1, 4, 1, 5]))

    expect(statEvidenceBlob({ agentQaRoot }, KNOWN_RUN, sha)).toBe('found')

    await rm(join(agentQaRoot, RUNS_SUBDIR, slugBranch(KNOWN_RUN), 'blobs', sha))
    expect(statEvidenceBlob({ agentQaRoot }, KNOWN_RUN, sha)).toBe('blob_absent')
  })

  it('answers blob_absent for a malformed sha before any path is assembled — even for a known run', () => {
    startRunDir(KNOWN_RUN)

    expect(statEvidenceBlob({ agentQaRoot }, KNOWN_RUN, '../../../../etc/passwd')).toBe('blob_absent')
    expect(statEvidenceBlob({ agentQaRoot }, KNOWN_RUN, 'not-a-sha')).toBe('blob_absent')
    expect(statEvidenceBlob({ agentQaRoot }, KNOWN_RUN, 'A'.repeat(64))).toBe('blob_absent')
  })

  it('contains a traversal-shaped runId exactly as the read does — the same slug, the same answer', () => {
    const hostile = '../../escape'
    const sha = writeBlob(hostile, new Uint8Array([9, 9]))

    expect(statEvidenceBlob({ agentQaRoot }, hostile, sha)).toBe('found')
    expect(statEvidenceBlob({ agentQaRoot }, hostile, 'c'.repeat(64))).toBe('blob_absent')
  })

  it('agrees with lookupEvidenceBlob on all three arms — one rule, two shapings', () => {
    const sha = writeBlob(KNOWN_RUN, new Uint8Array([2, 7, 1, 8]))

    for (const probe of [
      { runId: KNOWN_RUN, sha },
      { runId: KNOWN_RUN, sha: 'd'.repeat(64) },
      { runId: 'run-never-happened', sha },
      { runId: KNOWN_RUN, sha: 'not-a-sha' },
    ]) {
      expect(statEvidenceBlob({ agentQaRoot }, probe.runId, probe.sha))
        .toBe(lookupEvidenceBlob({ agentQaRoot }, probe.runId, probe.sha).status)
    }
  })
})

describe('createEvidenceBlobReader().has — the port member over the same rule', () => {
  let agentQaRoot: string

  beforeEach(async () => {
    agentQaRoot = await mkdtemp(join(tmpdir(), 'evidence-stat-port-'))
  })

  afterEach(async () => {
    await rm(agentQaRoot, { recursive: true, force: true })
  })

  it('resolves the same word statEvidenceBlob answers, and leaves read unchanged', async () => {
    const sha = new FsEvidenceArtifactStore({ root: agentQaRoot, runId: KNOWN_RUN })
      .persistDecisionScreenshot(new Uint8Array([1, 2, 3])).sha
    const reader = createEvidenceBlobReader({ agentQaRoot })

    expect(reader.has).toBeDefined()
    expect(await reader.has!(KNOWN_RUN as RunId, sha)).toBe('found')
    expect(await reader.has!(KNOWN_RUN as RunId, 'e'.repeat(64))).toBe('blob_absent')
    expect(await reader.has!('run-never-happened' as RunId, sha)).toBe('unknown_run')

    const read = await reader.read(KNOWN_RUN as RunId, sha)
    expect(read.status).toBe('found')
    expect(read.status === 'found' && Array.from(read.bytes)).toEqual([1, 2, 3])
  })
})
