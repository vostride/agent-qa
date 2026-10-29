import { asRunId } from '@vostride/agent-qa-schema'
import type { ClauseResult, RecordingEntry, RunDetailProjection } from '@vostride/agent-qa-schema'
import { expect, it } from 'vitest'
import * as renderer from '../commands/result-render.js'

const sha = 'b'.repeat(64)
const recording: RecordingEntry = {
  state: 'present', ref: { id: `recording:${sha}`, sha },
  byteLength: 1234567, contentType: 'video/webm', durationMs: 62050,
}

function fixture(entries: (RecordingEntry | undefined)[]): ClauseResult {
  const payload: RunDetailProjection = {
    runId: asRunId('recording-render-fixture'),
    members: entries.map((entry, testIndex) => ({
      testIndex, attempts: 1, ...(entry === undefined ? {} : { recording: entry }),
    })),
    steps: [], subActions: [], tokens: { measuredSteps: 0, unmeasuredSteps: 0 },
  }
  return { functionId: 'runs.detail', payload }
}

const metadataNotice = 'Member capture metadata omitted; use agent-qa fn runs.detail --json for the full result.'

function withoutRecording(result: ClauseResult) {
  const payload = result.payload as RunDetailProjection
  return { ...payload, members: payload.members.map(({ recording: _recording, ...member }) => member) }
}

it.each([
  [62050, '1:02'], [0, '0:00'], [59999.5, '0:59'], [3600000, '60:00'],
] as const)('CLI-RECORDING-SAVED-LINE: formats %s ms as %s without recording internals', (durationMs, duration) => {
  const result = fixture([{ ...recording, durationMs }])
  const before = JSON.stringify(result)
  const lines = renderer.renderClauseResults([result], 1)
  expect(lines).toHaveLength(3)
  expect(lines[1]).toBe(`Test 1: Recording saved: 1.2 MB, ${duration}. Open this run in the dashboard to play it.`)
  expect(renderer.RECORDING_SAVED_LINE).toBe('Recording saved: {size} MB{duration}. Open this run in the dashboard to play it.')
  expect(lines.join('\n')).not.toContain(sha)
  expect(lines.join('\n')).not.toMatch(/recording:|\.agent-qa|base64|video\/|file:\/\//u)
  expect(JSON.stringify(result)).toBe(before)
  expect(JSON.parse(lines[0]!)).toEqual(withoutRecording(result))
  expect(lines[2]).toBe(metadataNotice)
})

it('CLI-RECORDING-SAVED-LINE: unknown duration is omitted and members stay attributable', () => {
  const { durationMs: _duration, ...withoutDuration } = recording
  const lines = renderer.renderClauseResults([fixture([undefined, withoutDuration, recording])], 1)
  expect(lines.slice(1)).toEqual([
    'Test 2: Recording saved: 1.2 MB. Open this run in the dashboard to play it.',
    'Test 3: Recording saved: 1.2 MB, 1:02. Open this run in the dashboard to play it.',
    metadataNotice,
  ])
})

it('CLI-RECORDING-FAILED-LINE: states capture failure once for the member', () => {
  const lines = renderer.renderClauseResults([fixture([{ state: 'absent', reason: 'failed' }])], 1)
  expect(lines).toHaveLength(3)
  expect(renderer.RECORDING_FAILED_LINE).toBe('Recording could not be saved.')
  expect(lines[1]).toBe(`Test 1: ${renderer.RECORDING_FAILED_LINE}`)
})

it('CLI-RECORDING-QUIET-OTHERWISE: adds no recording line for other absence reasons', () => {
  const result = fixture([undefined,
    ...(['not-captured', 'unsupported', 'unavailable', 'empty'] as const)
      .map(reason => ({ state: 'absent' as const, reason })),
  ])
  expect(renderer.renderClauseResults([result], 1)).toEqual([
    JSON.stringify(withoutRecording(result), null, 2), metadataNotice,
  ])
  const absent = fixture([undefined])
  expect(renderer.renderClauseResults([absent], 1)).toEqual([JSON.stringify(absent.payload, null, 2)])
})

it('keeps unrelated results and receipt-count headings unchanged', () => {
  const result = { ...fixture([recording]), functionId: 'other.read' }
  expect(renderer.renderClauseResults([result], 1)).toEqual([JSON.stringify(result.payload, null, 2)])
  const lines = renderer.renderClauseResults([fixture([recording])], 2)
  expect(lines).toHaveLength(4)
  expect(lines[0]).toContain('runs.detail')
  expect(lines[2]).toContain('Test 1: Recording saved:')
})
