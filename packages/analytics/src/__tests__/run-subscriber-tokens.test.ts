// An unmeasured run carries none of the token keys: a zero would read as a real measurement.
import { generateRunId, generateTestId } from '@vostride/agent-qa-ids'
import type { RunEventEnvelope, RunEventPayload, RunEventType } from '@vostride/agent-qa-schema'
import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentQaAnalyticsEvent } from '../events.js'
import { createAnalyticsPort } from '../port.js'
import type { AnalyticsCapturePayload, AnalyticsTransport } from '../port.js'
import { createAnalyticsRunSubscriber } from '../run-subscriber.js'

interface RecordingTransport extends AnalyticsTransport {
  readonly payloads: AnalyticsCapturePayload[]
}

function recordingTransport(): RecordingTransport {
  const payloads: AnalyticsCapturePayload[] = []
  return {
    payloads,
    capture(payload) {
      payloads.push(payload)
    },
    flush() {},
    shutdown() {},
  }
}

const runId = generateRunId()
const testId = generateTestId()

let seq = 0

beforeEach(() => {
  seq = 0
})

function envelope(type: RunEventType, payload: unknown): RunEventEnvelope {
  seq += 1
  return { seq, ts: 1_700_000_000_000 + seq, runId, type, payload: payload as RunEventPayload }
}

function harness() {
  const transport = recordingTransport()
  const port = createAnalyticsPort<AgentQaAnalyticsEvent>({
    transport,
    identity: () => ({ distinctId: 'u_test-identity' }),
  })
  const subscriber = createAnalyticsRunSubscriber({
    port,
    triggerSource: 'cli',
    runner: 'local',
    standardProperties: { surface: 'cli', runtime_context: 'user' },
  })
  return { transport, subscriber }
}

/** The single captured `agent-qa.test_run.completed` properties bag. */
function completionProperties(transport: RecordingTransport): Record<string, unknown> {
  const events = transport.payloads.map((payload) => payload.event as AgentQaAnalyticsEvent)
  const completion = events.find((event) => event.name === 'agent-qa.test_run.completed')
  expect(completion, 'no agent-qa.test_run.completed was captured').toBeDefined()
  return completion!.properties as unknown as Record<string, unknown>
}

/** A whole `stepFinalized` payload; `tokenUsage` is spread in only when the caller measured one. */
function step(
  stepIndex: number,
  tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number },
): Record<string, unknown> {
  return {
    testIndex: 0,
    stepIndex,
    cacheStatus: tokenUsage === undefined ? 'hit' : 'miss',
    verifierVerdict: { pass: true, reasoning: 'ok' },
    selfHealOccurred: false,
    briefDigest: 'brief-digest-fixture',
    status: 'passed',
    ...(tokenUsage === undefined ? {} : { tokenUsage }),
  }
}

describe('analytics token sums on a completed run', () => {
  it('sums every measured step of the member into input/output/total', async () => {
    const { transport, subscriber } = harness()

    subscriber.handler(envelope('testStarted', { testId, testIndex: 0, name: 'a test' }))
    subscriber.handler(envelope('stepFinalized', step(0, { promptTokens: 10, completionTokens: 5, totalTokens: 15 })))
    subscriber.handler(envelope('stepFinalized', step(1, { promptTokens: 1, completionTokens: 1, totalTokens: 2 })))
    subscriber.handler(envelope('testFinished', { testId, testIndex: 0, outcome: 'passed', durationMs: 420 }))
    subscriber.handler(envelope('runFinished', { aggregateVerdict: 'passed' }))
    await subscriber.flush()

    const properties = completionProperties(transport)
    expect(properties.input_tokens).toBe(11)
    expect(properties.output_tokens).toBe(6)
    expect(properties.total_tokens).toBe(17)
  })

  it('a partly-measured member sums only the measured steps — the cache hits contribute nothing', async () => {
    const { transport, subscriber } = harness()

    subscriber.handler(envelope('testStarted', { testId, testIndex: 0, name: 'a test' }))
    subscriber.handler(envelope('stepFinalized', step(0, { promptTokens: 10, completionTokens: 5, totalTokens: 15 })))
    subscriber.handler(envelope('stepFinalized', step(1)))
    subscriber.handler(envelope('stepFinalized', step(2)))
    subscriber.handler(envelope('testFinished', { testId, testIndex: 0, outcome: 'passed', durationMs: 90 }))
    subscriber.handler(envelope('runFinished', { aggregateVerdict: 'passed' }))
    await subscriber.flush()

    const properties = completionProperties(transport)
    expect(properties.input_tokens).toBe(10)
    expect(properties.output_tokens).toBe(5)
    expect(properties.total_tokens).toBe(15)
    // The step counts still cover every step — an unmeasured step happened, it just cost nothing
    // anyone can report.
    expect(properties.step_count).toBe(3)
  })

  it('a run where NOTHING was measured carries none of the three keys — absent, never zero', async () => {
    const { transport, subscriber } = harness()

    subscriber.handler(envelope('testStarted', { testId, testIndex: 0, name: 'a test' }))
    subscriber.handler(envelope('stepFinalized', step(0)))
    subscriber.handler(envelope('stepFinalized', step(1)))
    subscriber.handler(envelope('testFinished', { testId, testIndex: 0, outcome: 'passed', durationMs: 60 }))
    subscriber.handler(envelope('runFinished', { aggregateVerdict: 'passed' }))
    await subscriber.flush()

    const properties = completionProperties(transport)
    expect('input_tokens' in properties).toBe(false)
    expect('output_tokens' in properties).toBe(false)
    expect('total_tokens' in properties).toBe(false)
  })

  it('a measured step that genuinely spent zero still produces the three keys', async () => {
    // The other side of absent-is-not-zero: a provider that reported a zero-token call MEASURED
    // something, and reporting nothing would erase a real observation.
    const { transport, subscriber } = harness()

    subscriber.handler(envelope('testStarted', { testId, testIndex: 0, name: 'a test' }))
    subscriber.handler(envelope('stepFinalized', step(0, { promptTokens: 0, completionTokens: 0, totalTokens: 0 })))
    subscriber.handler(envelope('testFinished', { testId, testIndex: 0, outcome: 'passed', durationMs: 10 }))
    subscriber.handler(envelope('runFinished', { aggregateVerdict: 'passed' }))
    await subscriber.flush()

    const properties = completionProperties(transport)
    expect(properties.input_tokens).toBe(0)
    expect(properties.output_tokens).toBe(0)
    expect(properties.total_tokens).toBe(0)
  })

  it('testRetryScheduled discards the abandoned attempt’s usage — only the final attempt is billed', async () => {
    const { transport, subscriber } = harness()

    subscriber.handler(envelope('testStarted', { testId, testIndex: 0, name: 'a test' }))
    subscriber.handler(envelope('stepFinalized', step(0, { promptTokens: 500, completionTokens: 200, totalTokens: 700 })))
    subscriber.handler(envelope('testRetryScheduled', { testIndex: 0, attempt: 2, reason: 'failed' }))
    subscriber.handler(envelope('stepFinalized', step(0, { promptTokens: 10, completionTokens: 5, totalTokens: 15 })))
    subscriber.handler(envelope('testFinished', { testId, testIndex: 0, outcome: 'passed', durationMs: 30, retryCount: 1 }))
    subscriber.handler(envelope('runFinished', { aggregateVerdict: 'passed' }))
    await subscriber.flush()

    const properties = completionProperties(transport)
    expect(properties.input_tokens).toBe(10)
    expect(properties.output_tokens).toBe(5)
    expect(properties.total_tokens).toBe(15)
    expect(properties.step_count).toBe(1)
  })
})
