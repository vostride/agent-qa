import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { asRunId } from '@vostride/agent-qa-schema'
import { FsEvidenceArtifactStore } from '@vostride/agent-qa-runner-local'
import { createEvidenceBlobReader } from '../evidence-blob-reader.js'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('BLOB-RANGE-GUARDS: size and exact bytes use the store range verbs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'artifact-range-'))
  roots.push(root)
  const runId = asRunId('range-reader-fixture')
  const bytes = Uint8Array.from([1, 2, 3, 4, 5, 6])
  const { sha } = new FsEvidenceArtifactStore({ root, runId }).persistDecisionScreenshot(bytes)
  const wholeRead = vi.spyOn(FsEvidenceArtifactStore.prototype, 'getBlob')
  const reader = createEvidenceBlobReader({ agentQaRoot: root })
  expect(reader.stat).toBeTypeOf('function')
  expect(reader.readRange).toBeTypeOf('function')
  expect(await reader.stat!(runId, sha)).toEqual({ status: 'found', byteLength: 6 })
  expect(await reader.readRange!(runId, sha, 2, 4)).toEqual({
    status: 'found', bytes: Uint8Array.from([3, 4, 5]),
  })
  expect(await reader.readRange!(runId, sha, 5, 10)).toEqual({
    status: 'found', bytes: Uint8Array.from([6]),
  })
  expect(await reader.readRange!(runId, sha, 6, 10)).toEqual({ status: 'blob_absent' })
  expect(wholeRead).not.toHaveBeenCalled()
})

it('BLOB-RANGE-GUARDS: malformed sha wins before root access and absence stays distinct', async () => {
  const root = mkdtempSync(join(tmpdir(), 'artifact-range-'))
  roots.push(root)
  const runId = asRunId('range-reader-fixture')
  const missing = asRunId('missing-range-fixture')
  const { sha } = new FsEvidenceArtifactStore({ root, runId })
    .persistDecisionScreenshot(Uint8Array.from([7, 8]))
  const reader = createEvidenceBlobReader({ agentQaRoot: root })
  expect(reader.stat).toBeTypeOf('function')
  expect(reader.readRange).toBeTypeOf('function')
  for (const method of [
    (id: typeof runId, address: string) => reader.stat!(id, address),
    (id: typeof runId, address: string) => reader.readRange!(id, address, 0, 0),
  ]) {
    for (const invalid of ['../../escape', 'A'.repeat(64), 'bad']) {
      expect(await method(missing, invalid)).toEqual({ status: 'blob_absent' })
    }
    expect(await method(missing, sha)).toEqual({ status: 'unknown_run' })
    expect(await method(runId, 'b'.repeat(64))).toEqual({ status: 'blob_absent' })
  }
  const noPath = createEvidenceBlobReader({ get agentQaRoot(): string { throw new Error('path touched') } })
  expect(await noPath.stat!(runId, '../escape')).toEqual({ status: 'blob_absent' })
  expect(await noPath.readRange!(runId, '../escape', 0, 1)).toEqual({ status: 'blob_absent' })
})
