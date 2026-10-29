import { expect, test } from 'vitest'
import * as api from '../index'

test('a live stream declaration parses each stream kind or none and refuses others', () => {
  expect(api.LIVE_STREAM_KINDS).toEqual(['cdp-screencast', 'snapshot', 'mjpeg', 'webrtc'])
  for (const kind of [...api.LIVE_STREAM_KINDS, 'none']) {
    expect(api.LiveStreamDeclarationSchema.parse({ kind })).toEqual({ kind })
  }
  expect(api.LiveStreamDeclarationSchema.safeParse({ kind: 'jpeg-poll' }).success).toBe(false)
  expect(api.LiveStreamDeclarationSchema.safeParse({ kind: 'snapshot', extra: 1 }).success).toBe(false)
})

test('a testStarted envelope parses and round-trips with or without stepTexts', () => {
  const bare: api.TestStartedPayload = { testId: 't1', testIndex: 0, name: 'a test', totalSteps: 2 }
  const withTexts: api.TestStartedPayload = { ...bare, stepTexts: ['Open the page', 'Type <SECRET_1> into Password'] }
  for (const payload of [bare, withTexts]) {
    const envelope = { seq: 2, ts: 1_000, runId: 'r1', type: 'testStarted', payload }
    const parsed = api.RunEventEnvelopeSchema.parse(envelope)
    expect(parsed).toEqual(envelope)
    expect(api.RunEventEnvelopeSchema.parse(JSON.parse(JSON.stringify(envelope)))).toEqual(envelope)
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(envelope)
  }
  expect(api.RunEventEnvelopeSchema.parse({ seq: 2, ts: 1_000, runId: 'r1', type: 'testStarted', payload: bare }).payload)
    .not.toHaveProperty('stepTexts')
})

test('EDITOR-LIVE-URL-DTOS-STRICT', () => {
  const input = api.EditorLiveUrlInputSchema
  expect(input.parse({ sessionId: 's1' })).toEqual({ sessionId: 's1' })
  expect(input.safeParse({ sessionId: '' }).success).toBe(false)
  expect(input.safeParse({ sessionId: 's1', runId: 'r' }).success).toBe(false)
  const result = {
    liveUrl: 'http://127.0.0.1:1/live/s1#v2.a.b',
    expiresAt: 1,
    stream: { kind: 'snapshot' },
  }
  expect(api.EditorLiveUrlResultSchema.parse(result)).toEqual(result)
  expect(api.EditorLiveUrlResultSchema.safeParse({ ...result, handle: 0 }).success).toBe(false)
})
