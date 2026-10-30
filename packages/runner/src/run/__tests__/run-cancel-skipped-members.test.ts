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

function eventLog(): EventLogPort {
  const store: RunEventEnvelope[] = []
  return {
    append: (envelope) => { store.push(envelope) },
    read: (fromSeq) => store.filter((event) => event.seq >= fromSeq),
  }
}

function handoffStore(): HandoffStorePort & { saved: CompletedRunHandoff[] } {
  const saved: CompletedRunHandoff[] = []
  return { saved, async save(handoff) { saved.push(handoff) } }
}

async function cancelledDuringMemberOne() {
  let arrived!: () => void
  const firstArrived = new Promise<void>((resolve) => { arrived = resolve })
  const calls: string[] = []
  const executor: MemberTestExecutor = (member) => {
    calls.push(member.testId)
    arrived()
    return new Promise<TestResult>(() => {})
  }
  const store = handoffStore()
  const config: RunConfig = {
    runId: 'run-abort-skipped' as RunConfig['runId'],
    scope: { tier: 'suite', key: 'checkout' },
    executionContext: 'local-headless',
    buildOrdinal: 1,
    configDigests: { suiteConfigDigest: 'suite-d', testConfigDigest: 'test-d' },
    members: [
      { testId: 'm1', name: 'member one', filePath: 'm1.test.yaml' },
      { testId: 'm2', name: 'member two', filePath: 'm2.test.yaml' },
      { testId: 'm3', name: 'member three', filePath: 'm3.test.yaml' },
    ],
    executor,
    ports: { handoffStore: store, eventLog: eventLog() },
  }
  const session = startRun(config) as unknown as Session
  const events: RunEventEnvelope[] = []
  session.subscribe(1, (event) => { events.push(event) })
  await firstArrived
  session.cancel()
  const { verdict, handoff } = await session.done
  return { calls, events, verdict, handoff }
}

const finishedOf = (events: readonly RunEventEnvelope[]) => events
  .filter((event) => event.type === 'testFinished')
  .map((event) => event.payload as { testId: string; outcome: string })

describe('members a run-level cancel skips', () => {
  it('members a run-level cancel skips are published as skipped, in member order', async () => {
    const { calls, events, verdict } = await cancelledDuringMemberOne()

    expect(calls).toEqual(['m1'])
    expect(verdict).toBe('cancelled')
    expect(finishedOf(events).map((payload) => `${payload.testId}:${payload.outcome}`))
      .toEqual(['m1:cancelled', 'm2:skipped', 'm3:skipped'])
    const verdictAt = events.findIndex((event) => event.type === 'verdict')
    const lastFinishedAt = events.map((event) => event.type).lastIndexOf('testFinished')
    expect(verdictAt, 'no verdict was published').toBeGreaterThan(-1)
    expect(lastFinishedAt).toBeLessThan(verdictAt)
    expect(events.filter((event) => event.type === 'testStarted').length).toBe(1)
  })

  it('the published members agree with the handoff', async () => {
    const { events, handoff } = await cancelledDuringMemberOne()

    const published = finishedOf(events).map((payload) => `${payload.testId}:${payload.outcome}`)
    expect(published.length, 'no member was published').toBe(3)
    expect(published).toEqual(handoff.tests.map((test) => `${test.testId}:${test.outcome}`))
  })
})

describe('reporter words for a skipped member', () => {
  it('a member a run-level cancel skipped carries its test name and file', async () => {
    const { events } = await cancelledDuringMemberOne()

    type Finished = { testId: string; outcome: string; name?: string; filePath?: string }
    const skipped = events
      .filter((event) => event.type === 'testFinished')
      .map((event) => event.payload as Finished)
      .filter((payload) => payload.outcome === 'skipped')
    expect(skipped.map((payload) => payload.testId)).toEqual(['m2', 'm3'])
    expect(skipped.map((payload) => [payload.name, payload.filePath])).toEqual([
      ['member two', 'm2.test.yaml'],
      ['member three', 'm3.test.yaml'],
    ])
  })
})
