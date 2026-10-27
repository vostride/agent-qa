import { afterEach, expect, it, vi } from 'vitest'
import {
  PROCEDURE_BODY_SCHEMA_VERSION, asRecordId, asRef, sha256hexBytes,
} from '@vostride/agent-qa-schema'
import type { RunEventEnvelope, SubActionRecordedPayload } from '@vostride/agent-qa-schema'
import { executeStep } from '../index.js'
import type { LoopPorts } from '../ports.js'
import { createRunEventBus } from '../../run/bus.js'
import { createMemberEventSink } from '../../run/event-sink.js'
import { SecretRedactor, SecretStore } from '../secrets.js'
import { makeActionPlan, makeAdapter, makePlanner, makeStepContext, makeVerifier } from './loop-harness.js'

function fixture(path: 'live' | 'cache' | 'procedure' = 'live', zeroMs?: number) {
  const events: RunEventEnvelope[] = []
  const bus = createRunEventBus({ runId: 'synthetic-offset-run' })
  bus.subscribe(1, event => events.push(event))
  const blobs = new Map<string, Uint8Array>()
  const persist = (bytes: Uint8Array, prefix: string) => {
    const sha = sha256hexBytes(bytes)
    blobs.set(sha, bytes)
    return { id: `${prefix}:${sha}`, sha }
  }
  const ports: LoopPorts & { recordingZeroMs?: number } = {
    adapter: makeAdapter({ screenshot: async () => Buffer.from('synthetic frame') }),
    planner: makePlanner(), verifier: makeVerifier(),
    secretRedactor: new SecretRedactor(new SecretStore()),
    ...(zeroMs === undefined ? {} : { recordingZeroMs: zeroMs }),
    evidenceArtifacts: {
      persistDecisionScreenshot: bytes => persist(bytes, 'decision-screenshot'),
      persistEvidenceDocument: doc => persist(new TextEncoder().encode(JSON.stringify(doc)), 'aria-state'),
      getBlob: sha => blobs.get(sha),
    },
    events: createMemberEventSink({ bus, mask: text => text, testIndex: 0 }).loopEmitFor(0),
  }
  if (path !== 'live') ports.planner = { plan: async () => { throw new Error('Replay must bypass planner') } }
  if (path === 'cache') ports.cache = {
    get: async () => ({ plannedActions: [{ type: 'click', ref: asRef('e2') }],
      groundedLocator: [{ role: 'button', name: 'Log in' }],
      completesStep: true }),
    set: async () => {}, invalidate: async () => {},
  }
  const logIn = { role: 'button', nameNormalized: 'log in', name: 'Log in' }
  if (path === 'procedure') ports.procedureFlow = { carry: {
    match: { id: asRecordId('procedure-recording-offset'), flowAnchor: { t: 'flow', name: 'login' },
      confidence: 0.9, authoringModelTier: 'full', parameterSchema: [], replayRecommendation: 'replay' },
    payload: { schemaVersion: PROCEDURE_BODY_SCHEMA_VERSION, parameters: [], steps: [{
      instruction: 'Click Log in',
      action: { type: 'click', targets: { ref: logIn }, values: {} },
      guard: { target: logIn, pageAnchor: { t: 'page', route: 'https://example.test/login' } },
    }], successAssertion: 'Logged in' }, nextIndex: 0,
  } }
  const children = () => events.filter(event => event.type === 'subActionRecorded')
    .map(event => event.payload as SubActionRecordedPayload)
  const run = () => executeStep('Click Log in', ports, makeStepContext())
  return { ports, children, run }
}

afterEach(() => vi.restoreAllMocks())

for (const [path, cell] of [['live', 'OFFSET-LIVE'], ['cache', 'OFFSET-CACHE-REPLAY'],
  ['procedure', 'OFFSET-PROCEDURE-REPLAY']] as const) {
  it(`${cell}: the real bus carries the measured offset`, async () => {
    vi.spyOn(performance, 'now').mockReturnValue(125.6)
    const f = fixture(path, 100)
    const result = await f.run()
    expect(result.status).toBe('passed')
    if (path === 'cache') expect(result.evidence?.cacheStatus).toBe('hit')
    if (path === 'procedure') expect(result.evidence?.planSource?.kind).toBe('procedure-replay')
    expect(f.children()).toHaveLength(1)
    expect(f.children()[0]?.recordingOffsetMs).toBe(26)
  })
}

it('OFFSET-ABSENT-WITHOUT-ZERO: every path distinguishes missing zero from measured zero', async () => {
  vi.spyOn(performance, 'now').mockReturnValue(0)
  for (const path of ['live', 'cache', 'procedure'] as const) {
    const absent = fixture(path)
    expect((await absent.run()).status).toBe('passed')
    expect(absent.children()).toHaveLength(1)
    expect(absent.children()[0]).not.toHaveProperty('recordingOffsetMs')
    const measured = fixture(path, 0)
    await measured.run()
    expect(measured.children()[0]?.recordingOffsetMs).toBe(0)
  }
})

it('OFFSET-INDEPENDENT-OF-SCREENSHOT: text-only turns still carry offsets', async () => {
  vi.spyOn(performance, 'now').mockReturnValue(125)
  const f = fixture('live', 100)
  f.ports.visionGate = { attachImage: false, captureMode: 'textOnly', promptNote: '' }
  expect((await f.run()).status).toBe('passed')
  expect(f.children()[0]?.artifactRefs?.some(ref => ref.id.startsWith('decision-screenshot:'))).toBe(false)
  expect(f.children()[0]?.recordingOffsetMs).toBe(25)
})

it('OFFSET-MONOTONIC-NOT-WALL: backward wall time cannot change the monotonic delta', async () => {
  const clock = vi.spyOn(performance, 'now').mockReturnValue(110)
  const wall = vi.spyOn(Date, 'now').mockReturnValue(9000)
  const f = fixture('live', 100)
  f.ports.planner = makePlanner([makeActionPlan({ stepComplete: false }), makeActionPlan()])
  let calls = 0
  f.ports.adapter.execute = async () => {
    clock.mockReturnValue(++calls === 1 ? 120 : 130)
    wall.mockReturnValue(calls === 1 ? 8000 : 1000)
    return { success: true }
  }
  expect((await f.run()).status).toBe('passed')
  expect(f.children().map(child => child.recordingOffsetMs)).toEqual([20, 30])
})

it('OFFSET-ROUNDED-NONNEGATIVE: fractional deltas round and future zero clamps', async () => {
  vi.spyOn(performance, 'now').mockReturnValue(125.6)
  for (const [zero, offset] of [[100, 26], [125.3, 0], [130, 0]]) {
    const f = fixture('live', zero)
    await f.run()
    expect(f.children()[0]?.recordingOffsetMs).toBe(offset)
    expect(Number.isFinite(f.children()[0]?.recordingOffsetMs)).toBe(true)
  }
})

it('OFFSET-EQUAL-BOTH-PUBLISHED: a frozen clock retains both events in order', async () => {
  vi.spyOn(performance, 'now').mockReturnValue(125)
  const f = fixture('live', 100)
  f.ports.planner = makePlanner([makeActionPlan({ stepComplete: false }), makeActionPlan()])
  expect((await f.run()).status).toBe('passed')
  expect(f.children().map(child => [child.subActionIndex, child.recordingOffsetMs])).toEqual([[0, 25], [1, 25]])
})

it('ANNOTATION-AFTER-GATE: actual dispatch interval reaches evidence and bus without changing completion offset', async () => {
  const clock = vi.spyOn(performance, 'now').mockReturnValue(110)
  const f = fixture('live', 100)
  const beginAnnotation = vi.fn(() => {
    const startMs = performance.now() - 100
    return () => ({ startMs, endMs: performance.now() - 100, scene: 'recorded-page' as const,
      transform: 'identity' as const, width: 390, height: 844 })
  })
  f.ports.adapter = { ...f.ports.adapter, recording: {
    start: async () => ({ zeroMs: 100 }), stop: async () => undefined, beginAnnotation,
  }, execute: async () => { clock.mockReturnValue(240); return { success: true, coordinates: { x: 40, y: 50 } } } }
  const result = await f.run()
  expect(beginAnnotation).toHaveBeenCalledOnce()
  const witness = { startMs: 10, endMs: 140, scene: 'recorded-page', transform: 'identity', width: 390, height: 844 }
  expect(result.evidence?.subActions[0]?.result.annotation?.recording).toEqual(witness)
  expect(f.children()[0]?.result.annotation?.recording).toEqual(witness)
  expect(f.children()[0]?.recordingOffsetMs).toBe(140)
})

it('ANNOTATION-RETRY-INTERVALS: failed and replanned attempts retain separate intervals', async () => {
  const f = fixture()
  let attempt = 0
  f.ports.adapter = { ...f.ports.adapter, recording: { start: async () => ({}), stop: async () => undefined,
    beginAnnotation: () => {
      const startMs = ++attempt * 100
      return () => ({ startMs, endMs: startMs + 30, scene: 'recorded-page', transform: 'identity', width: 390, height: 844 })
    },
  }, execute: async () => ({ success: attempt > 1, ...(attempt === 1 ? { error: 'temporary failure' } : {}), coordinates: { x: 40, y: 50 } }) }
  expect((await f.run()).status).toBe('passed')
  expect(f.children().map(child => [child.result.success, child.result.annotation?.recording?.startMs])).toEqual([[false, 100], [true, 200]])
})

it('ANNOTATION-HEAL-USES-FINAL-ATTEMPT: reground does not stretch the interval across failed dispatch', async () => {
  const f = fixture()
  let attempt = 0
  f.ports.adapter = { ...f.ports.adapter, recording: { start: async () => ({}), stop: async () => undefined,
    beginAnnotation: () => {
      const startMs = ++attempt * 100
      return () => ({ startMs, endMs: startMs + 20, scene: 'recorded-page', transform: 'identity', width: 390, height: 844 })
    },
  }, execute: async () => ({ success: attempt > 1, ...(attempt === 1 ? { error: 'Unknown ref "e2". Available refs: e1' } : {}), coordinates: { x: 40, y: 50 } }) }
  expect((await f.run()).status).toBe('passed')
  expect(attempt).toBe(2)
  expect(f.children()).toHaveLength(1)
  expect(f.children()[0]?.result.annotation?.recording).toMatchObject({ startMs: 200, endMs: 220 })
  expect(f.children()[0]?.grounding).toBeDefined()
})

it('ANNOTATION-NO-GUESSED-GEOMETRY: missing execution coordinates never turn legacy zero points into overlays', async () => {
  const f = fixture()
  f.ports.adapter = { ...f.ports.adapter, recording: { start: async () => ({}), stop: async () => undefined,
    beginAnnotation: () => () => ({ startMs: 10, endMs: 20, scene: 'recorded-page', transform: 'identity', width: 390, height: 844 }),
  } }
  await f.run()
  expect(f.children()[0]?.result.annotation?.recording).toBeUndefined()
})
