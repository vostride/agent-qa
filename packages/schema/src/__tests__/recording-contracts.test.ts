import { expect, test } from 'vitest'
import * as api from '../index'
import {
  RunDetailMemberSchema, RunDetailSubActionSchema, RunsArtifactInputSchema, RunsArtifactResultSchema,
} from '../functions/runs'
import { projectSubActionRecorded, projectTestFinished } from '../run/bus-projections'
import type { SubActionEvidence } from '../handoff/sub-action-evidence'
import type { PerTestOutcome } from '../handoff/per-test-outcome'

const sha = 'a'.repeat(64)
const ref = { id: `recording:${sha}`, sha }
const present = { state: 'present', ref, contentType: 'video/webm', byteLength: 42 }

test('C424-RECORDING-STATES-EXACT', () => {
  expect(api.RECORDING_STATES).toEqual(['present', 'absent'])
  expect(api.RecordingEntrySchema.safeParse({ ...present, state: 'pending' }).success).toBe(false)
})

test('C424-RECORDING-TYPES-EXACT', () => {
  expect(api.RECORDING_CONTENT_TYPES).toEqual(['video/webm', 'video/mp4'])
  for (const contentType of ['video/webm', 'video/mp4']) {
    expect(api.RecordingEntrySchema.safeParse({ ...present, contentType }).success).toBe(true)
  }
  expect(api.RecordingEntrySchema.safeParse({ ...present, contentType: 'text/html' }).success).toBe(false)
})

test('C424-RECORDING-REF-EXACT', () => {
  expect(api.RECORDING_REF_PREFIX).toBe('recording:')
  expect(api.RecordingRefSchema.parse(ref)).toEqual(ref)
  for (const invalid of [
    { ...ref, id: `decision-screenshot:${sha}` },
    { ...ref, sha: 'b'.repeat(64) },
    { ...ref, id: 'recording:../x' },
    { id: 'recording:../x', sha: '../x' },
    { ...ref, sha: sha.toUpperCase() },
  ]) expect(api.RecordingRefSchema.safeParse(invalid).success).toBe(false)
})

test('REC-PRESENT', () => {
  expect(api.RecordingEntrySchema).toBeDefined()
  expect(api.RecordingEntrySchema.parse(present)).toEqual(present)
  expect(api.RecordingEntrySchema.safeParse({ ...present, ref: undefined }).success).toBe(false)
  for (const byteLength of [-1, 1.5, Infinity, NaN]) {
    expect(api.RecordingEntrySchema.safeParse({ ...present, byteLength }).success).toBe(false)
  }
})

for (const [cell, reason] of [
  ['REC-EMPTY', 'empty'],
  ['REC-UNSUPPORTED', 'unsupported'],
  ['REC-NOT-CAPTURED', 'not-captured'],
  ['REC-FAILED', 'failed'],
  ['REC-UNAVAILABLE', 'unavailable'],
] as const) {
  test(cell, () => {
    expect(api.RecordingEntrySchema).toBeDefined()
    const absent = { state: 'absent', reason }
    expect(api.RecordingEntrySchema.parse(absent)).toEqual(absent)
    expect(api.RecordingEntrySchema.safeParse({ ...absent, ref }).success).toBe(false)
    expect(api.RecordingEntrySchema.safeParse({ ...absent, reason: 'unknown' }).success).toBe(false)
  })
}

test('REC-BYTES-GONE', () => {
  expect(api.RecordingEntrySchema).toBeDefined()
  const absent = { state: 'absent', reason: 'unavailable', evidenceIncomplete: true }
  expect(api.RecordingEntrySchema.parse(absent)).toEqual(absent)
})

const evidence: SubActionEvidence = {
  plan: 'Wait briefly',
  plannedAction: { type: 'navigate', to: 'url', url: 'https://example.test' },
  result: { success: true },
  stateBefore: {
    platform: 'web', tree: 'root', elements: [], refMap: {}, timestamp: 0,
    metadata: {
      captureMode: 'textOnly', coordSpace: 'viewport', viewportWidth: 1280, viewportHeight: 720,
      scroll: { offsetX: 0, offsetY: 0, contentWidth: 1280, contentHeight: 720 },
    },
  },
}
const ids = { testIndex: 0, stepIndex: 0, subActionIndex: 0 }
const outcome: PerTestOutcome = {
  testId: 'recording-fixture', testName: 'Recording', filePath: 'recording.yaml',
  testIndex: 0, outcome: 'passed', steps: [],
}

test('REC-OFFSET-OPTIONAL', () => {
  const historic = projectSubActionRecorded(evidence, ids, text => text)
  expect(historic).not.toHaveProperty('recordingOffsetMs')
  expect(RunDetailSubActionSchema.parse(historic)).toEqual(historic)
  for (const recordingOffsetMs of [0, 12.5]) {
    const payload = projectSubActionRecorded(evidence, ids, text => text, { recordingOffsetMs })
    expect(payload).toHaveProperty('recordingOffsetMs', recordingOffsetMs)
    expect(RunDetailSubActionSchema.parse(payload)).toEqual(payload)
  }
  expect(RunDetailSubActionSchema.safeParse({ ...historic, recordingOffsetMs: null }).success).toBe(false)
})

test('REC-NUMERIC-CONTRACT', () => {
  const historic = projectSubActionRecorded(evidence, ids, text => text)
  for (const value of [0, 12.5]) {
    expect(RunDetailSubActionSchema.safeParse({ ...historic, recordingOffsetMs: value }).success).toBe(true)
    expect(api.RecordingEntrySchema.safeParse({ ...present, durationMs: value }).success).toBe(true)
  }
  for (const value of [NaN, Infinity, -1, null]) {
    expect(RunDetailSubActionSchema.safeParse({ ...historic, recordingOffsetMs: value }).success).toBe(false)
    expect(api.RecordingEntrySchema.safeParse({ ...present, durationMs: value }).success).toBe(false)
  }
})

test('REC-PROJECTORS-MASK', () => {
  const recording = api.RecordingEntrySchema.parse(present)
  const seen: string[] = []
  const payload = projectTestFinished(outcome, text => {
    seen.push(text)
    return `[${text}]`
  }, { recording })
  expect(payload.recording).toEqual({
    state: '[present]', ref: { id: `[${ref.id}]`, sha: `[${sha}]` },
    contentType: '[video/webm]', byteLength: 42,
  })
  expect(seen).toEqual(expect.arrayContaining(['present', ref.id, sha, 'video/webm']))
  expect(projectTestFinished(outcome, text => text)).not.toHaveProperty('recording')
  const member = { testIndex: 0, attempts: 1 }
  expect(RunDetailMemberSchema.parse(member)).toEqual(member)
  expect(RunDetailMemberSchema.safeParse({ ...member, recording }).success).toBe(true)
  expect(RunDetailMemberSchema.safeParse({ ...member, recording: null }).success).toBe(false)
  const subAction = projectSubActionRecorded(evidence, ids, text => `[${text}]`, { recordingOffsetMs: 0 })
  expect(subAction.plan).toBe('[Wait briefly]')
  expect(subAction.recordingOffsetMs).toBe(0)
})

test('ARTIFACT-RANGE-INPUT', () => {
  const input = { runId: api.asRunId('recording-range-fixture'), sha }
  expect(RunsArtifactInputSchema.parse(input)).toEqual(input)
  for (const range of [{ start: 0, end: 0 }, { start: 4 }, { start: 4, end: 12 }]) {
    expect(RunsArtifactInputSchema.safeParse({ ...input, range }).success).toBe(true)
  }
  for (const range of [
    { start: 4, end: 3 }, { start: -1 }, { start: 0.5 }, { start: 0, end: 0.5 },
    { start: 0, end: -1 }, { start: Infinity }, { start: NaN },
    { start: 0, extra: true }, { end: 2 }, null,
  ]) expect(RunsArtifactInputSchema.safeParse({ ...input, range }).success).toBe(false)
})

test('ARTIFACT-RANGE-RESULT', () => {
  const result = { runId: 'recording-range-fixture', sha, contentType: 'video/webm', byteLength: 1, bytesBase64: 'YQ==' }
  expect(RunsArtifactResultSchema.parse(result)).toEqual(result)
  const ranged = { ...result, totalLength: 12, range: { start: 0, end: 0 } }
  expect(RunsArtifactResultSchema.safeParse(ranged).success).toBe(true)
  for (const totalLength of [-1, 0.5, Infinity, null]) {
    expect(RunsArtifactResultSchema.safeParse({ ...ranged, totalLength }).success).toBe(false)
  }
  for (const range of [{ start: -1, end: 0 }, { start: 0 }, { start: 0, end: 0.5 }, { start: 0, end: 0, extra: true }]) {
    expect(RunsArtifactResultSchema.safeParse({ ...ranged, range }).success).toBe(false)
  }
})
