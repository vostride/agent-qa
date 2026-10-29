import { asRunId, RunDetailProjectionSchema } from '@vostride/agent-qa-schema'
import type { RecordingEntry, RunDetailRows } from '@vostride/agent-qa-schema'
import { expect, it, vi } from 'vitest'
import { runsDetailSpec } from '../ops/runs-detail.js'
import type { EvidenceBlobReaderPort, FunctionDeps } from '../spec.js'

const runId = asRunId('recording-detail-fixture')
const sha = 'a'.repeat(64)
const present: RecordingEntry = {
  state: 'present', ref: { id: `recording:${sha}`, sha },
  byteLength: 1234567, contentType: 'video/webm', durationMs: 1234.5,
}
const unavailable = { state: 'absent', reason: 'unavailable' }

async function read(recording?: RecordingEntry, has?: EvidenceBlobReaderPort['has']) {
  const rows: RunDetailRows = {
    runId,
    members: [{ testIndex: 0, attempts: 1, ...(recording === undefined ? {} : { recording }) }],
    steps: [],
    subActions: [0, undefined, 1250.5].map((offset, subActionIndex) => ({
      testIndex: 0, stepIndex: 0, subActionIndex, plan: 'recorded',
      plannedAction: { type: 'navigate', to: 'url', url: 'https://example.invalid' },
      result: { success: true }, screenStateHash: 'recorded',
      ...(offset === undefined ? {} : { recordingOffsetMs: offset }),
    })),
  }
  const before = JSON.stringify(rows)
  const forbidden = vi.fn(() => { throw new Error('No config, handoff or blob content reads') })
  const output = await runsDetailSpec.invoke({ runId }, {
    runDetail: { read: async () => rows }, runs: { get: forbidden },
    config: { getMasked: forbidden },
    ...(has === undefined ? {} : { evidenceBlobs: { read: forbidden, has } }),
  } as unknown as FunctionDeps)
  expect(RunDetailProjectionSchema.parse(output)).toEqual(output)
  expect(JSON.stringify(rows)).toBe(before)
  expect(forbidden).not.toHaveBeenCalled()
  return output
}

it('DETAIL-REC-PRESENT: a present blob preserves every recorded field', async () => {
  const has = vi.fn(async () => 'found' as const)
  expect((await read(present, has)).members[0]?.recording).toEqual(present)
  expect(has).toHaveBeenCalledWith(runId, sha)
})

it('DETAIL-REC-NULL-UNAVAILABLE: a historical omitted field gains only unavailable', async () => {
  expect((await read()).members[0]?.recording).toEqual(unavailable)
})

it.each(['blob_absent', 'unknown_run'] as const)(
  'DETAIL-REC-BYTES-GONE: %s becomes unavailable and incomplete', async answer => {
    expect((await read(present, async () => answer)).members[0]?.recording).toEqual({
      ...unavailable, evidenceIncomplete: true,
    })
  },
)

it.each([
  ['DETAIL-REC-UNSUPPORTED', 'unsupported'],
  ['DETAIL-REC-NOT-CAPTURED', 'not-captured'],
  ['DETAIL-REC-FAILED', 'failed'],
  ['DETAIL-REC-EMPTY', 'empty'],
  ['DETAIL-REC-UNAVAILABLE', 'unavailable'],
] as const)('%s: producer absence passes through verbatim', async (_cell, reason) => {
  const recording: RecordingEntry = { state: 'absent', reason, evidenceIncomplete: false }
  const has = vi.fn(async () => 'blob_absent' as const)
  expect((await read(recording, has)).members[0]?.recording).toEqual(recording)
  expect(has).not.toHaveBeenCalled()
})

it('DETAIL-REC-PRESENCE-UNKNOWN: an unbound presence port preserves the entry', async () => {
  expect((await read(present)).members[0]?.recording).toEqual(present)
})

it('DETAIL-REC-PRESENCE-UNKNOWN: a rejected presence check never claims missing bytes', async () => {
  expect((await read(present, async () => { throw new Error('stat failed') }))
    .members[0]?.recording).toEqual(present)
})

it('DETAIL-OFFSET-PASSTHROUGH: zero and fractional offsets remain unchanged', async () => {
  const output = await read(present)
  expect(output.subActions.map(row => row.recordingOffsetMs)).toEqual([0, undefined, 1250.5])
})

it('DETAIL-OFFSET-NEVER-SYNTHESIZED: exactly the unmeasured child remains ordinal', async () => {
  const output = await read(present)
  expect(output.subActions.filter(row => !Object.hasOwn(row, 'recordingOffsetMs'))
    .map(row => row.subActionIndex)).toEqual([1])
})
