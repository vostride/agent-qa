// C447 (447-07, D-13, D-20..D-22): nothing waits on the network while work runs; the exit waits at most 2 s

import { generateRunId, generateTestId } from '@vostride/agent-qa-ids'
import type { RunEventEnvelope, RunEventPayload, RunEventType } from '@vostride/agent-qa-schema'
import { describe, expect, it, vi } from 'vitest'
import type { AgentQaAnalyticsEvent } from '../events.js'
import { createAnalyticsPort, DEFAULT_ANALYTICS_SHUTDOWN_TIMEOUT_MS } from '../port.js'
import { createAnalyticsRunSubscriber } from '../run-subscriber.js'
import { createPosthogTransport } from '../transports.js'
import type { PosthogAnalyticsClient } from '../transports.js'
import { readOutgoingBody } from './wire-sink.js'

interface CapturedInput {
  distinctId: string
  event: string
  properties: Record<string, unknown>
}

interface FakeClient extends PosthogAnalyticsClient {
  readonly captured: CapturedInput[]
  readonly counts: { capture: number; flush: number; shutdown: number }
}

function fakeClient(behaviour: {
  capture?: 'record' | 'throw'
  flush?: 'settle' | 'never' | 'throw'
  shutdown?: 'settle' | 'never'
}): FakeClient {
  const counts = { capture: 0, flush: 0, shutdown: 0 }
  const captured: CapturedInput[] = []
  return {
    counts,
    captured,
    capture(input) {
      counts.capture += 1
      if (behaviour.capture === 'throw') throw new Error('sink failed')
      captured.push(input)
    },
    flush() {
      counts.flush += 1
      if (behaviour.flush === 'throw') throw new Error('sink failed')
      if (behaviour.flush === 'never') return new Promise<void>(() => {})
    },
    shutdown() {
      counts.shutdown += 1
      if (behaviour.shutdown === 'never') return new Promise<void>(() => {})
    },
  }
}

function portOver(client: PosthogAnalyticsClient) {
  return createAnalyticsPort<AgentQaAnalyticsEvent>({
    transport: createPosthogTransport({
      projectKey: 'phc_cell',
      host: 'http://127.0.0.1:1',
      client,
    }),
    identity: () => ({ distinctId: 'u_delivery-cell' }),
  })
}

function explainEvent(): AgentQaAnalyticsEvent {
  return {
    name: 'agent-qa.explain.answered',
    properties: { cited_row_count: 1 },
  } as AgentQaAnalyticsEvent
}

async function raceSentinel(promise: Promise<unknown>): Promise<'settled' | 'pending'> {
  return Promise.race([
    promise.then(
      () => 'settled' as const,
      () => 'settled' as const,
    ),
    new Promise<'pending'>((resolve) => setImmediate(() => resolve('pending'))),
  ])
}

const runId = generateRunId()
const testId = generateTestId()
let seq = 0

function envelope(type: RunEventType, payload: unknown): RunEventEnvelope {
  seq += 1
  return { seq, ts: 1_700_000_000_000 + seq, runId, type, payload: payload as RunEventPayload }
}

function feedFinishedPassedRun(handler: (envelope: RunEventEnvelope) => void): void {
  seq = 0
  handler(envelope('runStarted', { memberTestCount: 1 }))
  handler(envelope('testStarted', { testId, testIndex: 0, name: 'a test' }))
  handler(envelope('testFinished', { testId, testIndex: 0, outcome: 'passed', durationMs: 10 }))
  handler(envelope('runFinished', { aggregateVerdict: 'passed' }))
}

describe('C447-FLUSH-NONBLOCKING', () => {
  it('a mid-command flush returns before a transport flush that never settles', async () => {
    const client = fakeClient({ flush: 'never' })
    const port = portOver(client)

    port.capture(explainEvent())
    const outcome = await raceSentinel(port.flush())

    expect(outcome).toBe('settled')
    expect(client.counts.capture).toBe(1)
    expect(client.counts.flush).toBe(1)
  })
})

describe('C447-VERDICT-UNCHANGED', () => {
  it('a stalled transport and a failing sink leave the run subscriber flush settled and the reported verdict unchanged', async () => {
    const stalled = fakeClient({ flush: 'never' })
    const stalledSubscriber = createAnalyticsRunSubscriber({
      port: portOver(stalled),
      triggerSource: 'cli',
      runner: 'local',
    })
    feedFinishedPassedRun(stalledSubscriber.handler)

    const outcome = await raceSentinel(stalledSubscriber.flush())

    expect(outcome).toBe('settled')
    const completed = stalled.captured.filter(
      (input) => input.event === 'agent-qa.test_run.completed',
    )
    expect(completed).toHaveLength(1)
    expect(completed[0]?.properties.status).toBe('passed')

    const failing = fakeClient({ capture: 'throw', flush: 'throw' })
    const failingSubscriber = createAnalyticsRunSubscriber({
      port: portOver(failing),
      triggerSource: 'cli',
      runner: 'local',
    })

    expect(() => feedFinishedPassedRun(failingSubscriber.handler)).not.toThrow()
    await expect(failingSubscriber.flush()).resolves.toBeUndefined()
    expect(failing.counts.capture).toBe(1)
    expect(failing.counts.flush).toBe(1)
  })
})

describe('C447-SHUTDOWN-BUDGET', () => {
  it('shutdown with a never-settling transport returns when the 2 s budget fires and not before', async () => {
    vi.useFakeTimers()
    try {
      const client = fakeClient({ shutdown: 'never' })
      const port = portOver(client)
      port.capture(explainEvent())

      let settled = false
      const shutdown = port.shutdown().then(() => {
        settled = true
      })

      await vi.advanceTimersByTimeAsync(DEFAULT_ANALYTICS_SHUTDOWN_TIMEOUT_MS - 1)
      expect(client.counts.shutdown).toBe(1)
      expect(settled).toBe(false)

      await vi.advanceTimersByTimeAsync(1)
      expect(settled).toBe(true)
      await shutdown
      expect(client.counts.capture).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

interface BatchItem {
  event: string
  distinct_id: string
  properties: Record<string, unknown>
}

describe('C447-IS-INTERNAL', () => {
  it('an internal identity leaves is_internal true as an event property and no person-property stamp', async () => {
    async function sendOne(identity: { distinctId: string; isInternal?: boolean }) {
      const bodies: string[] = []
      const port = createAnalyticsPort<AgentQaAnalyticsEvent>({
        transport: createPosthogTransport({
          projectKey: 'phc_cell',
          host: 'http://127.0.0.1:1',
          fetch: async (_url: string, init: { body?: unknown }) => {
            bodies.push(await readOutgoingBody(init.body))
            return new Response(JSON.stringify({ status: 1 }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }) as never
          },
        }),
        identity: () => identity,
      })
      port.capture(explainEvent())
      await port.shutdown()
      const items = bodies.flatMap((body) => (JSON.parse(body) as { batch: BatchItem[] }).batch)
      return items.filter((item) => item.event === 'agent-qa.explain.answered')
    }

    const internal = await sendOne({ distinctId: 'u_internal-cell', isInternal: true })
    const external = await sendOne({ distinctId: 'u_external-cell' })

    expect(internal).toHaveLength(1)
    expect(internal[0]?.distinct_id).toBe('u_internal-cell')
    expect(internal[0]?.properties.is_internal).toBe(true)
    expect(internal[0]?.properties).not.toHaveProperty('$set')

    expect(external).toHaveLength(1)
    expect(external[0]?.distinct_id).toBe('u_external-cell')
    expect(external[0]?.properties).not.toHaveProperty('is_internal')
    expect(external[0]?.properties).not.toHaveProperty('$set')
  })
})
