import { expect, test } from 'vitest'
import type { RecordingEntry, RunDetailArtifactRef, RunDetailStep, RunDetailSubAction } from '@vostride/agent-qa-schema'
import {
  frameUsable, latestUsableFrame, parkTargetForStep,
  playheadFromSelection, selectionFromPlayhead,
  buildTimelineModel, snapToMarker, nearestMarker, findMarkerBySha, formatOffset,
  TIMELINE_AXES, MARKER_RESULTS, MARKER_FRAMES, PLAYER_SOURCES, SNAP_THRESHOLD_PX,
} from '../playhead'
import { runDetailStepKey, type Selection } from '../selection'
import { TIMELINE_COPY, timelineValueText } from '../timeline-view'
import type { RunDetailGroup } from '../run-detail-view'

function frame(index: number, extra: Partial<RunDetailArtifactRef> = {}): RunDetailArtifactRef {
  const sha = String(index).padStart(64, '0')
  return { id: `decision-screenshot:${sha}`, sha, ...extra }
}

function action(subActionIndex: number, extra: Partial<RunDetailSubAction> = {}): RunDetailSubAction {
  return {
    testIndex: 2, stepIndex: 3, subActionIndex, plan: 'navigate',
    plannedAction: { type: 'navigate', to: 'url', url: 'https://example.test' }, result: { success: true },
    screenStateHash: 'a'.repeat(64), artifactRefs: [frame(subActionIndex)], ...extra,
  }
}

function step(stepIndex = 3, extra: Partial<RunDetailStep> = {}): RunDetailStep {
  return {
    testIndex: 2, stepIndex, cacheStatus: 'miss', verifierVerdict: { pass: true, reasoning: '' },
    selfHealOccurred: false, briefDigest: 'digest', ...extra,
  }
}

test('PARENT-FRAME-RESOLVED', () => {
  const actions = [action(0), action(1), action(2, {
    artifactRefs: [{ id: 'aria:other', sha: 'f'.repeat(64) }, frame(2)],
  })]
  expect(latestUsableFrame(actions)).toEqual({ index: 2, ref: frame(2) })
  expect(parkTargetForStep({ step: step(), subActions: actions })).toEqual({
    testIndex: 2, stepIndex: 3, subActionIndex: 2,
  })
})

test('PARENT-FRAME-SUBSTITUTED', () => {
  for (const missing of [{ evidenceIncomplete: true }, { present: false }]) {
    const actions = [action(0), action(1), action(2, { artifactRefs: [frame(2, missing)] })]
    expect(latestUsableFrame(actions)).toEqual({
      index: 1, ref: frame(1), substitution: { shown: 2, total: 3 },
    })
    expect(parkTargetForStep({ step: step(), subActions: actions })?.subActionIndex).toBe(1)
  }
})

test('PARENT-FRAME-NONE', () => {
  const actions = [action(0, { artifactRefs: [] }), action(1, {
    artifactRefs: [frame(1, { present: false })],
  })]
  expect(parkTargetForStep({ step: step(), subActions: actions })).toEqual({
    testIndex: 2, stepIndex: 3, subActionIndex: 1,
  })
  expect(latestUsableFrame(actions)).toBeUndefined()
  expect(latestUsableFrame([])).toBeUndefined()
  expect(parkTargetForStep({ step: step(), subActions: [] })).toEqual({
    testIndex: 2, stepIndex: 3, subActionIndex: null,
  })
})

test('FRAME-PRESENCE-UNKNOWN-USABLE', () => {
  expect(frameUsable(frame(0))).toBe(true)
  expect(frameUsable(frame(0, { present: true }))).toBe(true)
  expect(frameUsable(undefined)).toBe(false)
  expect(frameUsable(frame(0, { present: false }))).toBe(false)
  expect(frameUsable(frame(0, { present: true, evidenceIncomplete: true }))).toBe(false)
  expect(latestUsableFrame([action(0)])).toEqual({ index: 0, ref: frame(0) })
})

test('PLAYHEAD-SELECTION-ROUNDTRIP', () => {
  const stepId = runDetailStepKey(2, 3)
  const selections: Selection[] = [
    { type: 'step', stepId }, { type: 'subaction', stepId, subIndex: 0 },
  ]
  for (const selection of selections) {
    expect(selectionFromPlayhead(playheadFromSelection(selection))).toEqual(selection)
  }
  expect(playheadFromSelection(selections[0])).toEqual({
    testIndex: 2, stepIndex: 3, subActionIndex: null,
  })
  expect(playheadFromSelection(selections[1])).toEqual({
    testIndex: 2, stepIndex: 3, subActionIndex: 0,
  })
  for (const selection of [null, undefined, { type: 'test', testIndex: 2 } as const,
    { type: 'execution', stepId, logId: 'log' } as const,
    { type: 'step', stepId: 'bad' } as const,
    { type: 'subaction', stepId, subIndex: -1 } as const,
    { type: 'subaction', stepId, subIndex: 0.5 } as const]) {
    expect(playheadFromSelection(selection)).toBeNull()
  }
  expect(selectionFromPlayhead(null)).toBeNull()
  expect(selectionFromPlayhead({ testIndex: NaN, stepIndex: 3, subActionIndex: 0 })).toBeNull()
  expect(selectionFromPlayhead({ testIndex: 2, stepIndex: 3, subActionIndex: Infinity })).toBeNull()
})

function recording(durationMs: number | undefined = 10000): RecordingEntry {
  const sha = 'b'.repeat(64)
  return { state: 'present', ref: { id: `recording:${sha}`, sha },
    contentType: 'video/webm', byteLength: 32,
    ...(durationMs === undefined ? {} : { durationMs }) }
}

function group(recorded: RecordingEntry | undefined = recording()): RunDetailGroup {
  return {
    member: { testIndex: 2, attempts: 1, ...(recorded ? { recording: recorded } : {}) },
    steps: [
      { step: step(3), subActions: [action(0, { recordingOffsetMs: 1000 }), action(1, { recordingOffsetMs: 2000 })] },
      { step: step(4), subActions: [action(0, { stepIndex: 4, recordingOffsetMs: 7000 })] },
    ],
  }
}

test('AXIS-ALL-OFFSETS-TIME', () => {
  const input = group()
  const before = JSON.stringify(input)
  const model = buildTimelineModel(input)
  expect(model.axis).toBe('time')
  expect(model.extent).toBe(10000)
  expect(model.markers.map(marker => marker.position)).toEqual([0.1, 0.2, 0.7])
  expect(model.segments.map(segment => [segment.start, segment.end])).toEqual([[0.1, 0.7], [0.7, 1]])
  expect(JSON.stringify(input)).toBe(before)
})

test('AXIS-ONE-MISSING-ORDINAL', () => {
  const input = group()
  delete input.steps[0]!.subActions[1]!.recordingOffsetMs
  const model = buildTimelineModel(input)
  expect(model.axis).toBe('ordinal')
  expect(model.extent).toBe(3)
  expect(model.markers.map(marker => marker.position)).toEqual([1 / 6, 0.5, 5 / 6])
  expect(model.markers[1]).not.toHaveProperty('recordingOffsetMs')
  expect(model.markers[0]?.recordingOffsetMs).toBe(1000)
  expect(model.segments.map(segment => [segment.start, segment.end])).toEqual([[0, 2 / 3], [2 / 3, 1]])
})

test('AXIS-HISTORICAL-ORDINAL', () => {
  const input = group()
  delete input.member.recording
  for (const segment of input.steps) for (const subAction of segment.subActions) delete subAction.recordingOffsetMs
  expect(buildTimelineModel(input).axis).toBe('ordinal')
  expect(buildTimelineModel(group({ state: 'absent', reason: 'unavailable' })).axis).toBe('ordinal')
})

test('AXIS-NO-DURATION-ORDINAL', () => {
  const entry = recording()
  if (entry.state === 'present') delete entry.durationMs
  const input = group(entry)
  input.member.durationMs = 50000
  expect(buildTimelineModel(input).axis).toBe('ordinal')
  for (const bad of [Infinity, NaN]) {
    expect(buildTimelineModel(group(recording(bad))).axis).toBe('ordinal')
  }
})

test('AXIS-ORDINAL-ADDRESSABLE', () => {
  const timed = buildTimelineModel(group())
  expect(timed.markers).toHaveLength(3)
  const ordinal = buildTimelineModel(group({ state: 'absent', reason: 'not-captured' }))
  const addresses = (model: typeof timed) => model.markers.map(marker => ({
    ordinal: marker.ordinal, testIndex: marker.testIndex,
    stepIndex: marker.stepIndex, subActionIndex: marker.subActionIndex,
  }))
  expect(addresses(timed)).toEqual(addresses(ordinal))
  for (const marker of ordinal.markers) {
    expect(playheadFromSelection(selectionFromPlayhead(marker))).toEqual({
      testIndex: marker.testIndex, stepIndex: marker.stepIndex, subActionIndex: marker.subActionIndex,
    })
  }
})

test('AXIS-EXTENT-CLAMPS', () => {
  const input = group(recording(1000))
  input.member.durationMs = Infinity
  input.steps[0]!.subActions[0]!.recordingOffsetMs = 0
  expect(buildTimelineModel(input).markers.map(marker => marker.position)).toEqual([0, 1, 1])
  expect(buildTimelineModel(input).extent).toBe(1000)
  const zero = group(recording(0))
  zero.steps[0]!.subActions[0]!.recordingOffsetMs = 0
  expect(buildTimelineModel(zero).markers.map(marker => marker.position)).toEqual([0, 1, 1])
})

test('MARKER-GAP-STILL-NUMBERED', () => {
  const input = group()
  input.steps[0]!.subActions[0]!.artifactRefs = []
  input.steps[0]!.subActions[1]!.artifactRefs = [frame(1, { present: false })]
  const markers = buildTimelineModel(input).markers
  expect(markers.map(marker => marker.ordinal)).toEqual([1, 2, 3])
  expect(markers.map(marker => marker.frame)).toEqual(['absent', 'absent', 'available'])
})

test('MARKER-ORDER-STABLE', () => {
  const input = group()
  const reversed = { ...input, steps: [...input.steps].reverse().map(segment => ({
    ...segment, subActions: [...segment.subActions].reverse(),
  })) }
  for (const recordingEntry of [recording(), { state: 'absent', reason: 'unavailable' } as const]) {
    const model = buildTimelineModel({ ...reversed, member: { ...input.member, recording: recordingEntry } })
    expect(model.markers.map(marker => [marker.stepIndex, marker.subActionIndex])).toEqual([[3, 0], [3, 1], [4, 0]])
    expect(model.markers.map(marker => marker.ordinal)).toEqual([1, 2, 3])
    expect(model.segments.map(segment => segment.step.stepIndex)).toEqual([3, 4])
  }
})

test('MARKER-EQUAL-OFFSETS-KEEP-ORDER', () => {
  const input = group()
  for (const segment of input.steps) for (const subAction of segment.subActions) subAction.recordingOffsetMs = 2000
  const model = buildTimelineModel(input)
  expect(model.markers.map(marker => marker.ordinal)).toEqual([1, 2, 3])
  expect(model.markers.map(marker => marker.position)).toEqual([0.2, 0.2, 0.2])
  expect(model.markers.map(marker => [marker.stepIndex, marker.subActionIndex])).toEqual([[3, 0], [3, 1], [4, 0]])
})

test('MARKER-HEALED-NEVER-PRODUCED', () => {
  const input = group()
  input.steps[0]!.step.selfHealOccurred = true
  input.steps[0]!.step.status = 'healed'
  input.steps[0]!.subActions[1]!.result = { success: false, error: 'failed' }
  const model = buildTimelineModel(input)
  expect(model.markers.map(marker => marker.result)).toEqual(['passed', 'failed', 'passed'])
  expect(model.segments[0]?.step.status).toBe('healed')
})

function centres() {
  const markers = buildTimelineModel(group()).markers
  return markers.map((marker, index) => ({ marker, centrePx: 40 + index * 24 }))
}

test('SNAP-THRESHOLD-INCLUSIVE', () => {
  expect(SNAP_THRESHOLD_PX).toBe(12)
  const positions = centres()
  expect(snapToMarker(28, positions)?.ordinal).toBe(1)
  expect(snapToMarker(27, positions)).toBeUndefined()
  expect(snapToMarker(100, positions)?.ordinal).toBe(3)
  expect(snapToMarker(101, positions)).toBeUndefined()
  expect(snapToMarker(1, [])).toBeUndefined()
})

test('SNAP-TIE-EARLIER', () => {
  expect(snapToMarker(52, centres())?.ordinal).toBe(1)
  expect(snapToMarker(76, centres())?.ordinal).toBe(2)
})

test('NEAREST-TIE-EARLIER', () => {
  expect(nearestMarker(52, centres())?.ordinal).toBe(1)
  expect(nearestMarker(-100, centres())?.ordinal).toBe(1)
  expect(nearestMarker(500, centres())?.ordinal).toBe(3)
  expect(nearestMarker(0, [])).toBeUndefined()
})

test('MODEL-ZERO-STEPS', () => {
  expect(buildTimelineModel({ member: { testIndex: 2, attempts: 1 }, steps: [] })).toEqual({
    testIndex: 2, axis: 'ordinal', extent: 0, segments: [], markers: [], playhead: null,
  })
})

test('MODEL-ZERO-SUBACTIONS', () => {
  const input = group({ state: 'absent', reason: 'unavailable' })
  const model = buildTimelineModel({ ...input, steps: [{ step: step(2), subActions: [] }, ...input.steps] })
  expect(model.segments).toHaveLength(3)
  expect(model.segments[0]).toMatchObject({ start: 0, end: 0.25, markers: [] })
  expect(model.segments[2]).toMatchObject({ start: 0.75, end: 1 })
  expect(model.markers.map(marker => marker.position)).toEqual([0.375, 0.625, 0.875])
  expect(model.playhead).toEqual({ testIndex: 2, stepIndex: 2, subActionIndex: null })
  const timed = buildTimelineModel({ ...group(), steps: [{ step: step(2), subActions: [] }, ...group().steps] })
  expect(timed.segments[0]).toMatchObject({ start: 0.1, end: 0.1, markers: [] })
})

test('OFFSET-FORMAT-FLOOR', () => {
  for (const [offset, readout, popover] of [
    [0, '0:00', '0:00.0'], [999, '0:00', '0:00.9'], [59999, '0:59', '0:59.9'],
    [60000, '1:00', '1:00.0'], [3599999, '59:59', '59:59.9'],
    [3600000, '1:00:00', '1:00:00.0'], [3661999.9, '1:01:01', '1:01:01.9'],
  ] as const) {
    expect(formatOffset(offset)).toBe(readout)
    expect(formatOffset(offset, 'popover')).toBe(popover)
  }
  expect(formatOffset(undefined)).toBeUndefined()
})

test('CITED-SHA-FINDS-MARKER', () => {
  const model = buildTimelineModel(group())
  expect(findMarkerBySha(model, frame(1).sha)?.ordinal).toBe(2)
  expect(findMarkerBySha(model, 'c'.repeat(64))).toBeUndefined()
})

test('the timeline axes', () => expect(TIMELINE_AXES).toEqual(['time', 'ordinal']))
test('the marker results', () => expect(MARKER_RESULTS).toEqual(['passed', 'failed', 'healed', 'no-input']))
test('the marker frames', () => expect(MARKER_FRAMES).toEqual(['available', 'absent']))
test('the player sources', () => expect(PLAYER_SOURCES).toEqual(['frames', 'video']))

test('a skipped tap\'s timeline marker result is no-input', () => {
  const input = group()
  input.steps[0]!.subActions[0]!.result = {
    success: false, metadata: { idempotentNoop: { currentState: 'checked', inputSent: false } },
  }
  input.steps[0]!.subActions[1]!.result = { success: true, metadata: { idempotentNoop: { currentState: 'checked' } } }
  input.steps[1]!.subActions[0]!.result = { success: false, error: 'failed' }
  const markers = buildTimelineModel(input).markers
  expect(markers.map(marker => marker.result)).toEqual(['no-input', 'no-input', 'failed'])
  expect(MARKER_RESULTS).toContain('no-input')
  expect(TIMELINE_COPY.results[markers[0]!.result]).toBe('no input sent')
  expect(timelineValueText(markers[0]!, markers.length)).toContain(', no input sent')
})
