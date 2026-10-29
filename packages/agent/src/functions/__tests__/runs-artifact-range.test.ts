import { describe, expect, it, vi } from 'vitest'
import {
  asRunId, EVIDENCE_REF_PREFIXES, RECORDING_REF_PREFIX,
  RunsArtifactInputSchema, RunsArtifactResultSchema,
} from '@vostride/agent-qa-schema'
import { runsArtifactSpec, sniffEvidenceContentType } from '../ops/runs-artifact.js'
import type { FunctionDeps } from '../spec.js'

const runId = asRunId('range-fixture')
const sha = 'a'.repeat(64)
const webm = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, ...Array.from({ length: 60 }, (_, i) => i)])

function fixture(bytes = webm, ranged = true) {
  const read = vi.fn(async () => ({ status: 'found' as const, bytes }))
  const stat = vi.fn(async () => ({ status: 'found' as const, byteLength: bytes.length }))
  const readRange = vi.fn(async (_runId: unknown, _sha: string, start: number, end: number) => ({
    status: 'found' as const, bytes: bytes.slice(start, end + 1),
  }))
  const deps = { evidenceBlobs: { read, ...(ranged ? { stat, readRange } : {}) } } as unknown as FunctionDeps
  const invoke = (range?: { start: number; end?: number }) =>
    runsArtifactSpec.invoke(RunsArtifactInputSchema.parse({ runId, sha, ...(range ? { range } : {}) }), deps)
  return { read, stat, readRange, deps, invoke }
}

describe('bounded artifact reads', () => {
  it('ARTIFACT-NO-RANGE-UNCHANGED', async () => {
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2])
    const f = fixture(bytes)
    expect(await f.invoke()).toEqual({
      runId, sha, contentType: 'image/png', byteLength: bytes.length,
      bytesBase64: Buffer.from(bytes).toString('base64'),
    })
    expect(f.read).toHaveBeenCalledExactlyOnceWith(runId, sha)
    expect(f.stat).not.toHaveBeenCalled()
    expect(f.readRange).not.toHaveBeenCalled()
  })

  it.each([
    ['ARTIFACT-RANGE-SLICE', { start: 10, end: 19 }, 19],
    ['ARTIFACT-RANGE-TAIL-ONE-BYTE', { start: 63 }, 63],
    ['ARTIFACT-RANGE-END-CLAMPED', { start: 60, end: 100 }, 63],
  ] as const)('%s', async (_name, range, end) => {
    const f = fixture()
    const result = await f.invoke(range)
    expect(RunsArtifactResultSchema.parse(result)).toEqual({
      runId, sha, contentType: 'video/webm', byteLength: end - range.start + 1,
      bytesBase64: Buffer.from(webm.slice(range.start, end + 1)).toString('base64'),
      totalLength: webm.length, range: { start: range.start, end },
    })
    expect(f.read).not.toHaveBeenCalled()
    expect(f.readRange).toHaveBeenCalledWith(runId, sha, range.start, end)
  })

  it('ARTIFACT-RANGE-CAP', async () => {
    const f = fixture(new Uint8Array(3 * 1024 * 1024))
    const result = await f.invoke({ start: 100 })
    expect(result.byteLength).toBe(1048576)
    expect(result.range).toEqual({ start: 100, end: 1048675 })
    expect(result.totalLength).toBe(3 * 1024 * 1024)
    expect(Buffer.from(result.bytesBase64, 'base64')).toHaveLength(1048576)
    expect(f.read).not.toHaveBeenCalled()
  })

  it.each([64, 65])('ARTIFACT-RANGE-UNSATISFIABLE at %s', async start => {
    const f = fixture()
    await expect(f.invoke({ start })).rejects.toMatchObject({
      name: 'ArtifactRangeNotSatisfiableError', totalLength: 64,
    })
    expect(f.readRange).not.toHaveBeenCalled()
    expect(f.read).not.toHaveBeenCalled()
  })

  it('SNIFF-FROM-HEAD-NOT-SLICE', async () => {
    const bytes = new Uint8Array(webm)
    bytes.set([0x89, 0x50, 0x4e, 0x47], 20)
    const f = fixture(bytes)
    expect((await f.invoke({ start: 20, end: 23 })).contentType).toBe('video/webm')
    expect(f.readRange).toHaveBeenCalledWith(runId, sha, 0, 11)
  })

  it('uses the whole-read fallback when range verbs are absent', async () => {
    const f = fixture(webm, false)
    const result = await f.invoke({ start: 60 })
    expect(result.range).toEqual({ start: 60, end: 63 })
    expect(result.bytesBase64).toBe(Buffer.from(webm.slice(60)).toString('base64'))
    expect(result.contentType).toBe('video/webm')
    expect(f.read).toHaveBeenCalledOnce()
    await expect(f.invoke({ start: 64 })).rejects.toMatchObject({
      name: 'ArtifactRangeNotSatisfiableError', totalLength: 64,
    })
  })

  it.each(['unknown_run', 'blob_absent'] as const)('preserves %s refusal on stat', async status => {
    const f = fixture()
    f.stat.mockResolvedValueOnce({ status } as never)
    await expect(f.invoke({ start: 0 })).rejects.toMatchObject({
      name: status === 'unknown_run' ? 'RunNotFoundError' : 'EvidenceBlobAbsentError',
    })
  })

  it.each([...EVIDENCE_REF_PREFIXES, RECORDING_REF_PREFIX])(
    'REF-FAMILIES-RESOLVE-BY-SHA %s', async prefix => {
      const ref = { id: `${prefix}${sha}`, sha }
      const f = fixture()
      expect((await runsArtifactSpec.invoke({ runId, sha: ref.sha }, f.deps)).bytesBase64)
        .toBe(Buffer.from(webm).toString('base64'))
      expect(f.read).toHaveBeenCalledExactlyOnceWith(runId, sha)
    },
  )
})

it('SNIFF-WEBM', () => expect(sniffEvidenceContentType(webm)).toBe('video/webm'))
it('SNIFF-MP4', () => {
  expect(sniffEvidenceContentType(Uint8Array.from([0, 0, 0, 24, 102, 116, 121, 112, 1, 2, 3, 4])))
    .toBe('video/mp4')
})
it.each(['<html><script>alert(1)</script>', '<svg onload="alert(1)">', 'alert(1)', 'ftyp']) (
  'SNIFF-NEVER-MARKUP %s', value => {
    expect(sniffEvidenceContentType(new TextEncoder().encode(value))).toBe('application/octet-stream')
  },
)
