import { afterEach, expect, test, vi } from 'vitest'
import type { RecordingEntry, SubActionRecordedPayload } from '@vostride/agent-qa-schema'
import { executeStep } from '../../loop/index.js'
import { createRunEventBus } from '../bus.js'
import { createMemberEventSink } from '../event-sink.js'
import { runMemberTest, type MemberRunConfig, type MemberTest } from '../member-runner.js'
import { fakeModel, makeAdapter, makePlanner } from '../../loop/__tests__/loop-harness.js'

const ref = { id: `recording:${'a'.repeat(64)}` as const, sha: 'a'.repeat(64) }
const present: RecordingEntry = { state: 'present', ref, byteLength: 42, contentType: 'video/webm' }
const absent = (reason: 'failed' | 'unsupported' | 'not-captured'): RecordingEntry => ({ state: 'absent', reason })

function fixture() {
  const order: string[] = []
  const children: SubActionRecordedPayload[] = []
  const bus = createRunEventBus({ runId: 'synthetic-recording-run' })
  bus.subscribe(1, event => {
    if (event.type === 'subActionRecorded') children.push(event.payload as SubActionRecordedPayload)
  })
  const start = vi.fn(async () => { order.push('start'); return {} as { zeroMs?: number } })
  const stop = vi.fn(async () => {
    order.push('stop')
    return { stagingPath: 'staging.webm', contentType: 'video/webm' as const }
  })
  const persist = vi.fn((path: string) => { order.push(`persist:${path}`); return { ref, byteLength: 42 } })
  const discard = vi.fn((path: string) => { order.push(`discard:${path}`) })
  const adapter = { ...makeAdapter(), recording: { start, stop } }
  const config: MemberRunConfig = {
    adapter, planner: makePlanner(), plannerModel: fakeModel, verifierModel: fakeModel,
    sink: createMemberEventSink({ bus,
      mask: text => text, testIndex: 0 }),
    testIndex: 0, abortSignal: new AbortController().signal,
    recording: { enabled: true },
    evidenceArtifacts: { persistDecisionScreenshot: () => ({ id: `decision-screenshot:${ref.sha}`, sha: ref.sha }),
      getBlob: () => undefined, persistRecording: persist, discardRecording: discard },
    executeStep: async instruction => {
      order.push('step')
      return { name: instruction, status: 'passed', duration: 0 }
    },
  }
  const member: MemberTest = { testId: 'synthetic-recording-member', name: 'Recording', filePath: 'synthetic.yaml', steps: ['Run'] }
  return { config, member, adapter, start, stop, persist, discard, order, children }
}

afterEach(() => vi.restoreAllMocks())

test('REC-MEMBER-PRESENT: finalized bytes alone reach the store, including zero actions', async () => {
  for (const steps of [['Run'], []]) {
    const f = fixture()
    f.member.steps = steps
    expect((await runMemberTest(f.member, f.config)).recording).toEqual(present)
    expect(f.order).toEqual(['start', ...(steps.length ? ['step'] : []), 'stop', 'persist:staging.webm'])
    expect(f.discard).not.toHaveBeenCalled()
  }
})

test('REC-MEMBER-NOT-REQUESTED: absent config and disabled capture never start', async () => {
  for (const recording of [undefined, { enabled: false }]) {
    const f = fixture()
    f.config.recording = recording
    expect((await runMemberTest(f.member, f.config)).recording).toEqual(absent('not-captured'))
    expect(f.start).not.toHaveBeenCalled()
    expect(f.stop).not.toHaveBeenCalled()
  }
})

test('REC-MEMBER-UNSUPPORTED: no capability is explicit', async () => {
  const f = fixture()
  f.config.adapter = makeAdapter()
  expect((await runMemberTest(f.member, f.config)).recording).toEqual(absent('unsupported'))
})

for (const arm of ['START-THROWS', 'STOP-THROWS', 'STOP-UNDEFINED', 'PERSIST-THROWS', 'NO-STORE-VERB'] as const) {
  test(`REC-MEMBER-${arm}: recording failure is explicit and staging is consumed when known`, async () => {
    const f = fixture()
    if (arm === 'START-THROWS') f.start.mockRejectedValue(new Error('start'))
    if (arm === 'STOP-THROWS') f.stop.mockRejectedValue(new Error('stop'))
    if (arm === 'STOP-UNDEFINED') f.stop.mockResolvedValue(undefined as never)
    if (arm === 'PERSIST-THROWS') f.persist.mockImplementation(() => { throw new Error('empty or failed store') })
    if (arm === 'NO-STORE-VERB') delete f.config.evidenceArtifacts!.persistRecording
    expect((await runMemberTest(f.member, f.config)).recording).toEqual(absent('failed'))
    if (arm === 'PERSIST-THROWS' || arm === 'NO-STORE-VERB') expect(f.discard).toHaveBeenCalledExactlyOnceWith('staging.webm')
    else expect(f.persist).not.toHaveBeenCalled()
  })
}

test('REC-MEMBER-KEEP-FAILURES-ONLY: only passed final attempts are dropped', async () => {
  for (const keepFailuresOnly of [false, true]) {
    for (const status of ['passed', 'failed', 'cancelled'] as const) {
      const f = fixture()
      f.config.recording = { enabled: true, keepFailuresOnly }
      if (status === 'cancelled') f.config.abortSignal = AbortSignal.abort()
      else f.config.executeStep = async name => ({ name, status, duration: 0 })
      const result = await runMemberTest(f.member, f.config)
      expect(result.recording).toEqual(keepFailuresOnly && status === 'passed' ? absent('not-captured') : present)
      expect(result.status).toBe(status)
      if (keepFailuresOnly && status === 'passed') expect(f.discard).toHaveBeenCalledExactlyOnceWith('staging.webm')
      else expect(f.persist).toHaveBeenCalledExactlyOnceWith('staging.webm')
    }
  }
})

test('REC-MEMBER-PER-ATTEMPT: retry discards first staging and snapshots no recording', async () => {
  const f = fixture()
  f.member.meta = { retries: 1 }
  f.stop.mockImplementationOnce(async () => {
    f.order.push('stop')
    return { stagingPath: 'first.webm', contentType: 'video/webm' }
  })
  let attempt = 0
  f.config.executeStep = async name => ({ name, status: attempt++ === 0 ? 'failed' : 'passed', duration: 0 })
  const result = await runMemberTest(f.member, f.config)
  expect(result.recording).toEqual(present)
  expect(result.firstFailedAttempt?.result).not.toHaveProperty('recording')
  expect(result.retryCount).toBe(1)
  expect(f.order).toEqual(['start', 'stop', 'discard:first.webm', 'start', 'stop', 'persist:staging.webm'])
})

test('REC-MEMBER-DURATION-ONLY-WITH-ZERO: duration uses the monotonic stop-call instant', async () => {
  const f = fixture()
  f.start.mockImplementation(async () => ({ zeroMs: 100 }))
  vi.spyOn(performance, 'now').mockReturnValue(125.6)
  f.stop.mockImplementation(async () => {
    vi.mocked(performance.now).mockReturnValue(999)
    return { stagingPath: 'staging.webm', contentType: 'video/webm' }
  })
  expect((await runMemberTest(f.member, f.config)).recording).toEqual({ ...present, durationMs: 26 })
  const noZero = fixture()
  expect((await runMemberTest(noZero.member, noZero.config)).recording).toEqual(present)
})

test('OFFSET-PER-ATTEMPT-ZERO: retries use their own start and absent clocks stay absent', async () => {
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
  const f = fixture()
  f.member.meta = { retries: 1 }
  f.member.steps = ['Click Log in', 'Click Log in again']
  f.start.mockImplementationOnce(async () => {
    clock.mockReturnValue(125)
    return { zeroMs: 100 }
  }).mockImplementationOnce(async () => {
    clock.mockReturnValue(1050)
    return { zeroMs: 1000 }
  })
  let executed = 0
  f.config.executeStep = async (...args) => {
    const result = await executeStep(...args)
    return executed++ === 0 ? { ...result, status: 'failed' } : result
  }
  const result = await runMemberTest(f.member, f.config)
  expect(result.retryCount).toBe(1)
  expect(result.status).toBe('passed')
  expect(result.recording).toEqual({ ...present, durationMs: 50 })
  expect(f.children.map(child => [child.stepIndex, child.recordingOffsetMs]))
    .toEqual([[0, 25], [0, 50], [1, 50]])
  expect(f.discard).toHaveBeenCalledOnce()
  expect(f.start).toHaveBeenCalledTimes(2)
  expect(f.stop).toHaveBeenCalledTimes(2)

  for (const arm of ['android-no-zero', 'off', 'unsupported', 'failed-start'] as const) {
    const missing = fixture()
    missing.config.executeStep = executeStep
    if (arm === 'android-no-zero') missing.config.adapter = { ...missing.adapter, platform: 'android' }
    if (arm === 'off') missing.config.recording = { enabled: false }
    if (arm === 'unsupported') missing.config.adapter = makeAdapter()
    if (arm === 'failed-start') missing.start.mockRejectedValue(new Error('start failed'))
    const result = await runMemberTest(missing.member, missing.config)
    expect(result.status).toBe('passed')
    expect(result.recording).toEqual(arm === 'android-no-zero' ? present
      : absent(arm === 'off' ? 'not-captured' : arm === 'unsupported' ? 'unsupported' : 'failed'))
    expect(missing.children).toHaveLength(1)
    expect(missing.children[0]).not.toHaveProperty('recordingOffsetMs')
  }
})

test('REC-NEVER-SUPPRESSES-RUN: failure folds preserve verdict, steps and summary', async () => {
  const run = async (arm: string) => {
    const f = fixture()
    f.config.executeStep = async name => ({ name, status: 'failed', duration: 0, error: 'original failure' })
    if (arm === 'control') f.config.recording = { enabled: false }
    if (arm === 'start') f.start.mockRejectedValue(new Error('start'))
    if (arm === 'stop') f.stop.mockRejectedValue(new Error('stop'))
    if (arm === 'undefined') f.stop.mockResolvedValue(undefined as never)
    if (arm === 'persist') f.persist.mockImplementation(() => { throw new Error('persist') })
    if (arm === 'missing') f.config.evidenceArtifacts = undefined
    if (arm === 'discard') {
      delete f.config.evidenceArtifacts!.persistRecording
      f.discard.mockImplementation(() => { throw new Error('discard') })
    }
    const result = await runMemberTest(f.member, f.config)
    expect(result.recording).toEqual(absent(arm === 'control' ? 'not-captured' : 'failed'))
    return { status: result.status, steps: result.steps, failureSummary: result.failureSummary }
  }
  const control = await run('control')
  for (const arm of ['start', 'stop', 'undefined', 'persist', 'missing', 'discard']) expect(await run(arm)).toEqual(control)
})
