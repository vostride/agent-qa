// A started member keeps its run time even when an abort or throw ends it; a skipped one reads 0.
import { describe, expect, it } from 'vitest'

import { startRun } from '../shell.js'
import type { MemberTestExecutor, RunConfig } from '../shell.js'
import type { EventLogPort, HandoffStorePort } from '../ports.js'
import type { TestResult } from '../../result.js'
import type { CompletedRunHandoff, RunEventEnvelope } from '@vostride/agent-qa-schema'

interface Session {
  subscribe(fromSeq: number, handler: (event: RunEventEnvelope) => void): () => void
  cancel(): void
  readonly done: Promise<{ verdict: string; handoff: CompletedRunHandoff }>
}

const HOLD_MS = 60

function eventLog(): EventLogPort {
  const store: RunEventEnvelope[] = []
  return {
    append: (envelope) => { store.push(envelope) },
    read: (fromSeq) => store.filter((event) => event.seq >= fromSeq),
  }
}

function handoffStore(): HandoffStorePort {
  return { async save() {} }
}

function config(executor: MemberTestExecutor, runId: string): RunConfig {
  return {
    runId: runId as RunConfig['runId'],
    scope: { tier: 'suite', key: 'checkout' },
    executionContext: 'local-headless',
    buildOrdinal: 1,
    configDigests: { suiteConfigDigest: 'suite-d', testConfigDigest: 'test-d' },
    members: [
      { testId: 'm1', name: 'member one', filePath: 'm1.test.yaml' },
      { testId: 'm2', name: 'member two', filePath: 'm2.test.yaml' },
    ],
    executor,
    ports: { handoffStore: handoffStore(), eventLog: eventLog() },
  }
}

const finished = (events: readonly RunEventEnvelope[]) => events
  .filter((event) => event.type === 'testFinished')
  .map((event) => event.payload as { testId: string; outcome: string; durationMs?: number })

describe('member duration after a hold, an abort or a throw', () => {
  it('a member held and then aborted reports at least its hold, and a member the abort skipped reports 0', async () => {
    let calledAt = 0
    let arrived!: () => void
    const held = new Promise<void>((resolve) => { arrived = resolve })
    const executor: MemberTestExecutor = () => {
      calledAt = performance.now()
      arrived()
      return new Promise<TestResult>(() => {})
    }
    const session = startRun(config(executor, 'run-444-member-duration-abort')) as unknown as Session
    const events: RunEventEnvelope[] = []
    session.subscribe(1, (event) => { events.push(event) })
    await held
    await new Promise((resolve) => setTimeout(resolve, HOLD_MS))
    const hold = performance.now() - calledAt
    session.cancel()
    const { verdict } = await session.done

    expect(verdict).toBe('cancelled')
    const [first, second] = finished(events)
    expect([first?.testId, first?.outcome]).toEqual(['m1', 'cancelled'])
    expect(first?.durationMs ?? 0, 'the held member keeps the time it ran').toBeGreaterThanOrEqual(hold)
    expect([second?.testId, second?.outcome]).toEqual(['m2', 'skipped'])
    expect(second?.durationMs ?? 0, 'a member the abort skipped never started').toBe(0)
  })

  it('a member whose executor throws after a hold reports at least its hold', async () => {
    const holds = new Map<string, number>()
    const executor: MemberTestExecutor = async (member) => {
      const calledAt = performance.now()
      await new Promise((resolve) => setTimeout(resolve, HOLD_MS))
      holds.set(member.testId, performance.now() - calledAt)
      throw new Error('executor broke')
    }
    const session = startRun(config(executor, 'run-444-member-duration-error')) as unknown as Session
    const events: RunEventEnvelope[] = []
    session.subscribe(1, (event) => { events.push(event) })
    await session.done

    const published = finished(events)
    expect(published.map((payload) => [payload.testId, payload.outcome])).toEqual([['m1', 'failed'], ['m2', 'failed']])
    for (const payload of published) {
      expect(payload.durationMs ?? 0, `${payload.testId} keeps the time it ran`)
        .toBeGreaterThanOrEqual(holds.get(payload.testId) ?? Infinity)
    }
  })
})
