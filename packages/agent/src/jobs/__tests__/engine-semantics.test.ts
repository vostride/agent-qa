import { beforeEach, describe, expect, it } from 'vitest'

import type { ChainedJobRequest, JobId, JobKind } from '@vostride/agent-qa-schema'

import type { ClockPort } from '../../ports/clock.js'
import type { JobStoreFence } from '../../ports/job-store.js'
import { StaleJobStoreEpochError } from '../../ports/job-store.js'
import {
  createAgentJobQueue,
  UndeclaredJobSuccessorError,
} from '../engine.js'
import type { AgentJobQueue, JobIdSource, RunNextJobOutcome } from '../engine.js'
import { createJobKindRegistry } from '../kind-registry.js'
import type { JobKindDeclaration, JobKindRegistry } from '../kind-registry.js'
import { createRealJobKindRegistry } from '../kinds.js'
import type { JobModelCapability } from '../record-llm-authorship.js'
import { createFakeJobStore } from './fake-job-store.js'
import type { FakeJobStore } from './fake-job-store.js'

/** Deterministic and arithmetic-free: the engine never parses a timestamp, so nor does this. */
function createSteppingClock(): ClockPort {
  let tick = 0
  return {
    now: () => {
      tick += 1
      return `2026-01-01T00:00:${String(tick).padStart(2, '0')}.000Z`
    },
  }
}

const idSource: JobIdSource = {
  jobIdFor: (kind, idempotencyKey) => `job_${kind}_${idempotencyKey}` as JobId,
}

/**
 * The queue needs a model bound (385 plan 05, D-10) and nothing in this file authors, so this
 * one refuses. A capability that answered would let a test in here start depending on model
 * output by accident; a capability that throws keeps the authorship proofs where they belong.
 */
const unusedModel: JobModelCapability = {
  modelId: 'test:unused',
  generate: async () => {
    throw new Error('engine-semantics tests never author; see record-llm-authorship.test.ts')
  },
}

function declaration(overrides: Partial<JobKindDeclaration> = {}): JobKindDeclaration {
  return {
    kind: 'analyze-run',
    checkpointed: true,
    checkpointSchedule: ['verdicts-authored'],
    allowedSuccessors: [],
    maxAttempts: 3,
    backoff: { kind: 'none' },
    onPermanentFailure: 'halt-chain',
    handler: async () => ({ status: 'complete', next: [] }),
    ...overrides,
  }
}

interface Harness {
  readonly store: FakeJobStore
  readonly queue: AgentJobQueue
  readonly fence: JobStoreFence
  readonly registry: JobKindRegistry
}

async function harnessFor(
  declarations: readonly JobKindDeclaration[] | JobKindRegistry,
): Promise<Harness> {
  const clock = createSteppingClock()
  const store = createFakeJobStore(clock)
  const registry = Array.isArray(declarations)
    ? createJobKindRegistry(declarations)
    : (declarations as JobKindRegistry)
  const queue = createAgentJobQueue({ store, registry, clock, idSource, model: unusedModel })
  const fence = await store.adoptEpoch(1)
  return { store, queue, fence, registry }
}

function statusOf(store: FakeJobStore, jobId: string): string | undefined {
  return store.rows().find((row) => row.id === jobId)?.status
}

type DispositionVerb = 'recordFailure' | 'failAndChain'

function dispositionCallCount(store: FakeJobStore, verb: DispositionVerb): number {
  return store.callCount(verb)
}

describe('bounded retry (D-18)', () => {
  it('retries a retryable report until the bound is spent, then fails', async () => {
    const invocations: number[] = []
    const harness = await harnessFor([
      declaration({
        maxAttempts: 3,
        handler: async (context) => {
          invocations.push(context.job.attempts)
          return { status: 'retryable', reason: 'transient' }
        },
      }),
    ])
    const enqueued = await harness.queue.enqueue('analyze-run', {}, 'key')

    const first = await harness.queue.runNextJob({ fence: harness.fence })
    expect(first).toMatchObject({
      ran: true,
      disposition: 'retry-scheduled',
      reason: 'transient',
      attemptsRemaining: 2,
    })
    expect(statusOf(harness.store, String(enqueued.job.id))).toBe('queued')

    const second = await harness.queue.runNextJob({ fence: harness.fence })
    expect(second).toMatchObject({ disposition: 'retry-scheduled', attemptsRemaining: 1 })

    // The third attempt is the last permitted one, so a retryable REPORT becomes a permanent
    // DECISION here — the distinction the two types exist to carry.
    const third = await harness.queue.runNextJob({ fence: harness.fence })
    expect(third).toMatchObject({ ran: true, disposition: 'failed', reason: 'transient' })
    expect(statusOf(harness.store, String(enqueued.job.id))).toBe('failed')

    expect(invocations).toEqual([1, 2, 3])
    // Terminal: a failed job is never claimed again.
    expect(await harness.queue.runNextJob({ fence: harness.fence })).toEqual({
      ran: false,
      reason: 'no-job',
    })
    expect(invocations).toEqual([1, 2, 3])
  })

  // The negative control for the bound. Without it, an engine that failed EVERY retryable
  // report on its first attempt would satisfy the sequence above from its third assertion on.
  it('does not fail a job that succeeds within its bound', async () => {
    let calls = 0
    const harness = await harnessFor([
      declaration({
        maxAttempts: 3,
        handler: async () => {
          calls += 1
          return calls === 1
            ? { status: 'retryable', reason: 'first attempt' }
            : { status: 'complete', next: [] }
        },
      }),
    ])
    const enqueued = await harness.queue.enqueue('analyze-run', {}, 'key')

    await harness.queue.runNextJob({ fence: harness.fence })
    const second = await harness.queue.runNextJob({ fence: harness.fence })

    expect(second).toMatchObject({ ran: true, disposition: 'completed' })
    expect(statusOf(harness.store, String(enqueued.job.id))).toBe('done')
  })

  it('fails a permanent report immediately, spending no further attempt', async () => {
    let calls = 0
    const harness = await harnessFor([
      declaration({
        maxAttempts: 5,
        handler: async () => {
          calls += 1
          return { status: 'permanent', reason: 'malformed input' }
        },
      }),
    ])
    const enqueued = await harness.queue.enqueue('analyze-run', {}, 'key')

    const outcome = await harness.queue.runNextJob({ fence: harness.fence })

    expect(outcome).toMatchObject({ disposition: 'failed', reason: 'malformed input' })
    expect(statusOf(harness.store, String(enqueued.job.id))).toBe('failed')
    expect(calls).toBe(1)
    expect(await harness.queue.runNextJob({ fence: harness.fence })).toEqual({
      ran: false,
      reason: 'no-job',
    })
  })

  // The control that distinguishes "reads the discriminant" from "fails on any report at
  // all": the SAME declaration, the same attempt, a retryable report instead.
  it('does not fail a retryable report on the same attempt a permanent one would', async () => {
    const harness = await harnessFor([
      declaration({
        maxAttempts: 5,
        handler: async () => ({ status: 'retryable', reason: 'transient' }),
      }),
    ])
    const enqueued = await harness.queue.enqueue('analyze-run', {}, 'key')

    const outcome = await harness.queue.runNextJob({ fence: harness.fence })

    expect(outcome).toMatchObject({ disposition: 'retry-scheduled' })
    expect(statusOf(harness.store, String(enqueued.job.id))).toBe('queued')
  })

  it('lands a thrown handler as a fenced retry with declaration backoff', async () => {
    const clock = createSteppingClock()
    const store = createFakeJobStore(clock)
    const recordFailureCalls: Parameters<FakeJobStore['recordFailure']>[] = []
    const observed = {
      ...store,
      recordFailure: async (...args: Parameters<FakeJobStore['recordFailure']>) => {
        recordFailureCalls.push(args)
        return store.recordFailure(...args)
      },
    }
    const registry = createJobKindRegistry([
      declaration({
        maxAttempts: 3,
        backoff: {
          kind: 'exponential',
          initialDelayMs: 125,
          factor: 2,
          maxDelayMs: 1_000,
        },
        handler: async () => {
          throw new Error('synthetic engine crash')
        },
      }),
    ])
    const queue = createAgentJobQueue({
      store: observed,
      registry,
      clock,
      idSource,
      model: unusedModel,
    })
    const fence = await store.adoptEpoch(7)
    const enqueued = await queue.enqueue('analyze-run', {}, 'thrown-retry')

    const outcome = await queue.runNextJob({ fence })

    expect(outcome).toMatchObject({
      ran: true,
      disposition: 'retry-scheduled',
      job: { id: enqueued.job.id, attempts: 1 },
      handlerInvoked: true,
      reason: 'handler-threw: synthetic engine crash',
      retryDelayMs: 125,
      attemptsRemaining: 2,
    })
    expect(recordFailureCalls).toEqual([
      [
        enqueued.job.id,
        { kind: 'retry', reason: 'handler-threw: synthetic engine crash', retryAfterMs: 125 },
        fence,
      ],
    ])
    expect(store.rows().find((row) => row.id === String(enqueued.job.id))).toMatchObject({
      status: 'queued',
      claimed: false,
      attempts: 1,
    })
  })
})

describe('C444.1-RETRY-BACKOFF', () => {
  it('a retry hands the store the backoff it reports', async () => {
    let calls = 0
    const harness = await harnessFor([
      declaration({
        maxAttempts: 3,
        backoff: { kind: 'exponential', initialDelayMs: 125, factor: 2, maxDelayMs: 1_000 },
        handler: async () => {
          calls += 1
          if (calls === 1) throw new Error('synthetic engine crash')
          return { status: 'retryable', reason: 'transient' }
        },
      }),
    ])
    const enqueued = await harness.queue.enqueue('analyze-run', {}, 'key')

    const thrown = await harness.queue.runNextJob({ fence: harness.fence })
    const returned = await harness.queue.runNextJob({ fence: harness.fence })

    expect(thrown).toMatchObject({ disposition: 'retry-scheduled', retryDelayMs: 125 })
    expect(returned).toMatchObject({ disposition: 'retry-scheduled', retryDelayMs: 250 })
    expect(harness.store.failureDispositions()).toEqual([
      {
        jobId: String(enqueued.job.id),
        disposition: {
          kind: 'retry',
          reason: 'handler-threw: synthetic engine crash',
          retryAfterMs: (thrown as { retryDelayMs: number }).retryDelayMs,
        },
      },
      {
        jobId: String(enqueued.job.id),
        disposition: {
          kind: 'retry',
          reason: 'transient',
          retryAfterMs: (returned as { retryDelayMs: number }).retryDelayMs,
        },
      },
    ])
  })
})

describe('thrown-handler disposition edges (386-21)', () => {
  it('proves both adjacent sides of the max-attempts boundary with declared successors', async () => {
    const harness = await harnessFor([
      declaration({
        maxAttempts: 2,
        allowedSuccessors: ['curate-memory'],
        onPermanentFailure: ({ reason }) => [
          {
            kind: 'curate-memory',
            payload: { fallbackReason: reason },
            idempotencyKey: 'throw-fallback',
          },
        ],
        handler: async () => {
          throw new Error('adjacent-boundary failure')
        },
      }),
      declaration({ kind: 'curate-memory', checkpointSchedule: ['candidates-authored'] }),
    ])
    const enqueued = await harness.queue.enqueue('analyze-run', {}, 'boundary')

    const oneAttemptRemains = await harness.queue.runNextJob({ fence: harness.fence })
    expect(oneAttemptRemains).toMatchObject({
      disposition: 'retry-scheduled',
      job: { attempts: 1 },
      reason: 'handler-threw: adjacent-boundary failure',
      attemptsRemaining: 1,
    })

    const boundConsumed = await harness.queue.runNextJob({ fence: harness.fence })
    expect(boundConsumed).toMatchObject({
      disposition: 'failed',
      job: { attempts: 2 },
      reason: 'handler-threw: adjacent-boundary failure',
      handlerInvoked: true,
      continuation: [{ deduped: false }],
    })
    expect(statusOf(harness.store, String(enqueued.job.id))).toBe('failed')
    expect(harness.store.rows().find((row) => row.kind === 'curate-memory')).toMatchObject({
      status: 'queued',
      payload: { fallbackReason: 'handler-threw: adjacent-boundary failure' },
    })
    expect(dispositionCallCount(harness.store, 'recordFailure')).toBe(1)
    expect(dispositionCallCount(harness.store, 'failAndChain')).toBe(1)
  })

  it('propagates a stale-fence refusal without a partial disposition', async () => {
    const clock = createSteppingClock()
    const store = createFakeJobStore(clock)
    const registry = createJobKindRegistry([
      declaration({
        handler: async () => {
          await store.adoptEpoch(2)
          throw new Error('authority moved')
        },
      }),
    ])
    const queue = createAgentJobQueue({
      store,
      registry,
      clock,
      idSource,
      model: unusedModel,
    })
    const staleFence = await store.adoptEpoch(1)
    const enqueued = await queue.enqueue('analyze-run', {}, 'stale-disposition')

    await expect(queue.runNextJob({ fence: staleFence })).rejects.toBeInstanceOf(
      StaleJobStoreEpochError,
    )

    expect(dispositionCallCount(store, 'recordFailure')).toBe(1)
    expect(dispositionCallCount(store, 'failAndChain')).toBe(0)
    const row = store.rows().find((candidate) => candidate.id === String(enqueued.job.id))
    expect(row).toMatchObject({
      status: 'queued',
      attempts: 1,
    })
    expect(row).not.toHaveProperty('lastFailureKind')
    expect(row).not.toHaveProperty('lastFailureReason')
  })

  it('calls the retry disposition exactly once for one thrown claim', async () => {
    let handlerCalls = 0
    const harness = await harnessFor([
      declaration({
        handler: async () => {
          handlerCalls += 1
          throw new Error('single disposition')
        },
      }),
    ])
    const enqueued = await harness.queue.enqueue('analyze-run', {}, 'exactly-once')

    const outcome = await harness.queue.runNextJob({ fence: harness.fence })

    expect(outcome).toMatchObject({
      disposition: 'retry-scheduled',
      job: { id: enqueued.job.id, attempts: 1 },
    })
    expect(handlerCalls).toBe(1)
    expect(dispositionCallCount(harness.store, 'recordFailure')).toBe(1)
    expect(dispositionCallCount(harness.store, 'failAndChain')).toBe(0)
    expect(harness.store.rows().find((row) => row.id === String(enqueued.job.id))).toMatchObject({
      status: 'queued',
      claimed: false,
      lastFailureKind: 'retry',
      lastFailureReason: 'handler-threw: single disposition',
    })
  })
})

describe('the poison job: a handler that throws still exhausts its bound (D-18)', () => {
  it('lands each thrown attempt and terminates on the declared bound', async () => {
    let calls = 0
    const harness = await harnessFor([
      declaration({
        maxAttempts: 3,
        handler: async () => {
          calls += 1
          throw new Error('host died mid-handler')
        },
      }),
    ])
    const enqueued = await harness.queue.enqueue('analyze-run', {}, 'key')

    const outcomes: RunNextJobOutcome[] = []
    for (let pump = 0; pump < 3; pump += 1) {
      outcomes.push(await harness.queue.runNextJob({ fence: harness.fence }))
    }

    expect(calls).toBe(3)
    expect(statusOf(harness.store, String(enqueued.job.id))).toBe('failed')
    expect(outcomes.map((outcome) => outcome.ran && outcome.disposition)).toEqual([
      'retry-scheduled',
      'retry-scheduled',
      'failed',
    ])
    expect(outcomes[2]).toMatchObject({
      ran: true,
      disposition: 'failed',
      handlerInvoked: true,
      reason: 'handler-threw: host died mid-handler',
    })
  })

  it('runs the exhausted job to completion when the bound has NOT been spent', async () => {
    // Negative control for the claim-time guard: a job whose attempts sit below the bound is
    // still handed to its handler. A guard that refused every claim would satisfy the test
    // above perfectly.
    const harness = await harnessFor([declaration({ maxAttempts: 3 })])
    await harness.queue.enqueue('analyze-run', {}, 'key')

    const outcome = await harness.queue.runNextJob({ fence: harness.fence })

    expect(outcome).toMatchObject({ disposition: 'completed', handlerInvoked: true })
  })
})

describe('abandoned claims', () => {
  it('releases a claim its host never finished, preserving the attempt it spent', async () => {
    const harness = await harnessFor([declaration()])
    const enqueued = await harness.queue.enqueue('analyze-run', {}, 'key')
    const claimed = await harness.store.claimNext(harness.fence)
    expect(claimed).toMatchObject({ claimed: true, job: { id: enqueued.job.id } })

    expect(harness.store.rows()[0]?.claimed).toBe(true)
    const recovered = await harness.queue.recoverAbandonedClaims({ fence: harness.fence })

    expect(recovered.released).toEqual([enqueued.job.id])
    expect(harness.store.rows()[0]?.claimed).toBe(false)
    // The attempt stays spent: that is what makes the bound hold across a crash.
    expect(harness.store.rows()[0]?.attempts).toBe(1)
  })

  it('releases nothing when no claim is outstanding', async () => {
    const harness = await harnessFor([declaration()])
    await harness.queue.enqueue('analyze-run', {}, 'key')

    expect(await harness.queue.recoverAbandonedClaims({ fence: harness.fence })).toEqual({
      released: [],
    })

    await harness.queue.runNextJob({ fence: harness.fence })
    expect(await harness.queue.recoverAbandonedClaims({ fence: harness.fence })).toEqual({
      released: [],
    })
  })
})

describe('backoff as data (D-18)', () => {
  it.each([
    { backoff: { kind: 'none' } as const, expected: [0, 0, 0] },
    { backoff: { kind: 'fixed', delayMs: 500 } as const, expected: [500, 500, 500] },
    {
      backoff: {
        kind: 'exponential',
        initialDelayMs: 100,
        factor: 2,
        maxDelayMs: 300,
      } as const,
      expected: [100, 200, 300],
    },
  ])('spaces the retries of $backoff.kind', async ({ backoff, expected }) => {
    const harness = await harnessFor([
      declaration({
        maxAttempts: 4,
        backoff,
        handler: async () => ({ status: 'retryable', reason: 'transient' }),
      }),
    ])
    await harness.queue.enqueue('analyze-run', {}, 'key')

    const delays: number[] = []
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const outcome = await harness.queue.runNextJob({ fence: harness.fence })
      delays.push((outcome as { retryDelayMs: number }).retryDelayMs)
    }

    expect(delays).toEqual(expected)
  })
})

describe('declared-topology chaining (D-17)', () => {
  it('chains a declared successor and stores it', async () => {
    const harness = await harnessFor([
      declaration({
        kind: 'analyze-run',
        allowedSuccessors: ['curate-memory'],
        handler: async () => ({
          status: 'complete',
          next: [{ kind: 'curate-memory', payload: { n: 1 }, idempotencyKey: 'chained' }],
        }),
      }),
      declaration({ kind: 'curate-memory', checkpointSchedule: ['candidates-authored'] }),
    ])
    await harness.queue.enqueue('analyze-run', {}, 'key')

    const outcome = await harness.queue.runNextJob({ fence: harness.fence })

    expect(outcome).toMatchObject({ disposition: 'completed' })
    expect(harness.store.rows().map((row) => row.kind).sort()).toEqual([
      'analyze-run',
      'curate-memory',
    ])
  })

  it('refuses an undeclared successor by name, before anything is written', async () => {
    const harness = await harnessFor([
      declaration({
        kind: 'analyze-run',
        allowedSuccessors: [],
        handler: async () => ({
          status: 'complete',
          next: [{ kind: 'curate-memory', payload: {}, idempotencyKey: 'smuggled' }],
        }),
      }),
      declaration({ kind: 'curate-memory', checkpointSchedule: ['candidates-authored'] }),
    ])
    const enqueued = await harness.queue.enqueue('analyze-run', {}, 'key')

    await expect(harness.queue.runNextJob({ fence: harness.fence })).rejects.toBeInstanceOf(
      UndeclaredJobSuccessorError,
    )

    expect(harness.store.rows()).toHaveLength(1)
    expect(statusOf(harness.store, String(enqueued.job.id))).toBe('queued')
  })
})

describe('the permanent-failure disposition (D-20)', () => {
  function producerHarness(
    next: readonly ChainedJobRequest[],
    allowedSuccessors: readonly JobKind[] = ['curate-memory'],
  ): { calls: () => number; harness: Promise<Harness> } {
    let calls = 0
    return {
      calls: () => calls,
      harness: harnessFor([
        declaration({
          kind: 'analyze-run',
          allowedSuccessors,
          maxAttempts: 1,
          onPermanentFailure: () => {
            calls += 1
            return next
          },
          handler: async () => ({ status: 'permanent', reason: 'dead head' }),
        }),
        declaration({ kind: 'curate-memory', checkpointSchedule: ['candidates-authored'] }),
      ]),
    }
  }

  it('invokes the producer exactly once and enqueues its continuation', async () => {
    const probe = producerHarness([
      { kind: 'curate-memory', payload: { verdicts: 'unknown' }, idempotencyKey: 'fallback' },
    ])
    const harness = await probe.harness
    const enqueued = await harness.queue.enqueue('analyze-run', {}, 'key')

    const outcome = await harness.queue.runNextJob({ fence: harness.fence })

    expect(probe.calls()).toBe(1)
    expect(outcome).toMatchObject({ disposition: 'failed' })
    expect(statusOf(harness.store, String(enqueued.job.id))).toBe('failed')
    expect(harness.store.rows().filter((row) => row.kind === 'curate-memory')).toHaveLength(1)
  })

  it('does not invoke it a second time when the queue is pumped again', async () => {
    const probe = producerHarness([
      { kind: 'curate-memory', payload: {}, idempotencyKey: 'fallback' },
    ])
    const harness = await probe.harness
    await harness.queue.enqueue('analyze-run', {}, 'key')
    await harness.queue.runNextJob({ fence: harness.fence })

    // The continuation IS claimable, so the pump has work to do — this is not the empty-queue
    // case wearing a disguise.
    const next = await harness.queue.runNextJob({ fence: harness.fence })
    expect(next).toMatchObject({ ran: true, job: { kind: 'curate-memory' } })
    await harness.queue.runNextJob({ fence: harness.fence })

    expect(probe.calls()).toBe(1)
    expect(harness.store.rows().filter((row) => row.kind === 'curate-memory')).toHaveLength(1)
  })

  // A continuation may already exist through another producer. The compound store verb must
  // preserve idempotent enqueue semantics while committing the parent's failure atomically.
  it('reuses an existing continuation row by idempotency key', async () => {
    const probe = producerHarness([
      { kind: 'curate-memory', payload: {}, idempotencyKey: 'fallback' },
    ])
    const harness = await probe.harness
    await harness.queue.enqueue('analyze-run', {}, 'key')
    // Stand in for an independently materialized continuation with the same identity.
    await harness.queue.enqueue('curate-memory', {}, 'fallback')

    await harness.queue.runNextJob({ fence: harness.fence })

    expect(probe.calls()).toBe(1)
    expect(harness.store.rows().filter((row) => row.kind === 'curate-memory')).toHaveLength(1)
  })

  // The port call count is the proof boundary. Validation and deterministic request construction
  // happen first, then the store receives the parent and complete continuation set exactly once.
  it('lands the failure and every continuation through one failAndChain call', async () => {
    const clock = createSteppingClock()
    const store = createFakeJobStore(clock)
    const calls: string[] = []
    const observed = {
      ...store,
      enqueue: async (...args: Parameters<FakeJobStore['enqueue']>) => {
        calls.push('enqueue')
        return store.enqueue(...args)
      },
      recordFailure: async (...args: Parameters<FakeJobStore['recordFailure']>) => {
        calls.push('recordFailure')
        return store.recordFailure(...args)
      },
      failAndChain: async (...args: Parameters<FakeJobStore['failAndChain']>) => {
        calls.push('failAndChain')
        return store.failAndChain(...args)
      },
    }
    const registry = createJobKindRegistry([
      declaration({
        kind: 'analyze-run',
        allowedSuccessors: ['curate-memory'],
        maxAttempts: 1,
        onPermanentFailure: () => [
          { kind: 'curate-memory', payload: {}, idempotencyKey: 'fallback' },
        ],
        handler: async () => ({ status: 'permanent', reason: 'dead head' }),
      }),
      declaration({ kind: 'curate-memory', checkpointSchedule: ['candidates-authored'] }),
    ])
    const queue = createAgentJobQueue({
      store: observed,
      registry,
      clock,
      idSource,
      model: unusedModel,
    })
    const fence = await store.adoptEpoch(1)
    await queue.enqueue('analyze-run', {}, 'key')
    calls.length = 0

    const outcome = await queue.runNextJob({ fence })

    expect(calls).toEqual(['failAndChain'])
    expect(outcome).toMatchObject({
      disposition: 'failed',
      continuation: [{ deduped: false }],
    })
    expect(store.rows().filter((row) => row.kind === 'curate-memory')).toHaveLength(1)
    expect(store.rows().find((row) => row.kind === 'analyze-run')?.status).toBe('failed')
  })

  it('mirrors failAndChain all-or-nothing behavior in the fake store', async () => {
    const clock = createSteppingClock()
    const store = createFakeJobStore(clock)
    const fence = await store.adoptEpoch(1)
    const head = await store.enqueue({
      id: 'job_head' as JobId,
      kind: 'analyze-run',
      idempotencyKey: 'head',
      summary: 'head',
      payload: {},
    })
    await store.enqueue({
      id: 'job_taken' as JobId,
      kind: 'analyze-run',
      idempotencyKey: 'taken',
      summary: 'taken',
      payload: {},
    })
    await store.claimNext(fence)

    await expect(
      store.failAndChain(
        head.job.id,
        { kind: 'permanent', reason: 'must roll back' },
        [
          {
            id: 'job_ok' as JobId,
            kind: 'analyze-run',
            idempotencyKey: 'ok',
            summary: 'ok',
            payload: {},
          },
          {
            id: 'job_taken' as JobId,
            kind: 'analyze-run',
            idempotencyKey: 'different-key',
            summary: 'collision',
            payload: {},
          },
        ],
        fence,
      ),
    ).rejects.toThrow()

    expect(store.rows().map((row) => row.id).sort()).toEqual(['job_head', 'job_taken'])
    const parent = store.rows().find((row) => row.id === 'job_head')
    expect(parent).toMatchObject({
      status: 'queued',
      claimed: true,
    })
    expect(parent?.lastFailureKind).toBeUndefined()
    expect(parent?.lastFailureReason).toBeUndefined()
  })

  // Without this, "invoked exactly once" is satisfied by an engine that invokes it zero times.
  it('never invokes it for a job that does not permanently fail', async () => {
    let calls = 0
    const harness = await harnessFor([
      declaration({
        maxAttempts: 3,
        onPermanentFailure: () => {
          calls += 1
          return []
        },
        handler: async () => ({ status: 'complete', next: [] }),
      }),
    ])
    await harness.queue.enqueue('analyze-run', {}, 'key')
    await harness.queue.runNextJob({ fence: harness.fence })

    expect(calls).toBe(0)
  })

  it('enqueues nothing for a halt-chain kind', async () => {
    const harness = await harnessFor([
      declaration({
        maxAttempts: 1,
        allowedSuccessors: ['curate-memory'],
        onPermanentFailure: 'halt-chain',
        handler: async () => ({ status: 'permanent', reason: 'dead head' }),
      }),
      declaration({ kind: 'curate-memory', checkpointSchedule: ['candidates-authored'] }),
    ])
    await harness.queue.enqueue('analyze-run', {}, 'key')

    const outcome = await harness.queue.runNextJob({ fence: harness.fence })

    expect(outcome).toMatchObject({ disposition: 'failed', continuation: [] })
    expect(harness.store.rows()).toHaveLength(1)
  })

  it('refuses a continuation outside the declared topology, before anything is written', async () => {
    const probe = producerHarness(
      [{ kind: 'curate-memory', payload: {}, idempotencyKey: 'smuggled' }],
      [],
    )
    const harness = await probe.harness
    await harness.queue.enqueue('analyze-run', {}, 'key')

    await expect(harness.queue.runNextJob({ fence: harness.fence })).rejects.toBeInstanceOf(
      UndeclaredJobSuccessorError,
    )
    expect(harness.store.rows()).toHaveLength(1)
    expect(harness.store.rows()[0]?.status).toBe('queued')
  })
})

describe('the five real kinds, driven through the engine', () => {
  let harness: Harness

  beforeEach(async () => {
    harness = await harnessFor(createRealJobKindRegistry())
  })

  it('publishes a chat turn with no checkpoint at all', async () => {
    await harness.queue.enqueue('chat', {}, 'turn-1')
    const outcome = await harness.queue.runNextJob({ fence: harness.fence })

    expect(outcome).toMatchObject({ disposition: 'completed', checkpointsPublished: [] })
    expect(harness.store.checkpoints()).toEqual([])
  })

  it('publishes every declared checkpoint of a checkpointed kind', async () => {
    await harness.queue.enqueue('curate-memory', {}, 'run-1')
    const outcome = await harness.queue.runNextJob({ fence: harness.fence })

    expect(outcome).toMatchObject({
      disposition: 'completed',
      checkpointsPublished: ['candidates-authored', 'bundle-committed'],
    })
  })

  it('chains analyze-run into its declared successors', async () => {
    await harness.queue.enqueue('analyze-run', { chain: true }, 'run-1')
    await harness.queue.runNextJob({ fence: harness.fence })

    expect(harness.store.rows().map((row) => row.kind).sort()).toEqual([
      'analyze-run',
      'curate-memory',
    ])
  })

  // Declared equals produced, so the case above (the success path, driven through the scripted
  // stand-in that maps over the declared set) and the case below (the permanent-failure
  // fallback) now measure the same one-element list from opposite sides. They agree on purpose:
  // a build that narrowed one side without the other REDs whichever side moved, by name.
  //
  // 2026-09-01 (Phase 409): the reserved sixth kind left with the Issue-slot cleanup, and 388
  // D-04's declared/produced split collapsed with it.
  it('proceeds with unknown verdicts, and only into curate-memory, when analyze-run permanently fails', async () => {
    await harness.queue.enqueue('analyze-run', { fail: 'permanent', reason: 'no model' }, 'run-1')
    const outcome = await harness.queue.runNextJob({ fence: harness.fence })

    expect(outcome).toMatchObject({ disposition: 'failed', reason: 'no model' })
    const continuation = harness.store.rows().filter((row) => row.kind !== 'analyze-run')
    expect(continuation.map((row) => row.kind).sort()).toEqual(['curate-memory'])
    for (const row of continuation) {
      expect(row.payload).toMatchObject({ verdicts: 'unknown' })
    }
  })

  it('halts the chain when a halt-chain kind permanently fails', async () => {
    await harness.queue.enqueue('curate-memory', { fail: 'permanent', reason: 'bad bundle' }, 'r')
    const outcome = await harness.queue.runNextJob({ fence: harness.fence })

    expect(outcome).toMatchObject({ disposition: 'failed', continuation: [] })
    expect(harness.store.rows()).toHaveLength(1)
  })

  it('spends the declared bound of a real kind and no more', async () => {
    await harness.queue.enqueue('consolidate', { fail: 'retryable' }, 'run-1')
    const bound = harness.registry.require('consolidate').maxAttempts
    // The derived sequence below says the engine spends whatever bound is declared; these two
    // literals say WHICH bound consolidate declares. Without them a changed bound re-derives
    // the expectation and this cell stays green through the change it exists to catch.
    expect(bound).toBe(2)
    expect(harness.registry.require('consolidate').backoff).toEqual({
      kind: 'fixed',
      delayMs: 5_000,
    })

    const dispositions: string[] = []
    for (let pump = 0; pump < bound + 2; pump += 1) {
      const outcome = await harness.queue.runNextJob({ fence: harness.fence })
      dispositions.push(outcome.ran ? outcome.disposition : outcome.reason)
    }

    expect(dispositions).toEqual([
      ...Array.from({ length: bound - 1 }, () => 'retry-scheduled'),
      'failed',
      'no-job',
      'no-job',
    ])
  })
})

describe('construction-time unclaimable kinds (388-09, G-388-2 substrate)', () => {
  it('passes the constructed exclusion set to the store on every runNextJob, and nothing without it', async () => {
    const clock = createSteppingClock()
    const store = createFakeJobStore(clock)
    const registry = createRealJobKindRegistry()
    const queue = createAgentJobQueue({
      store,
      registry,
      clock,
      idSource,
      model: unusedModel,
      unclaimableKinds: ['curate-memory'],
    })
    const fence = await store.adoptEpoch(1)
    await queue.enqueue('curate-memory', {}, 'run-1')
    await queue.enqueue('analyze-run', {}, 'run-1')

    const first = await queue.runNextJob({ fence })
    expect(first).toMatchObject({ ran: true, job: { kind: 'analyze-run' } })
    await queue.runNextJob({ fence })
    expect(store.claimNextCalls()).toEqual([
      { excludeKinds: ['curate-memory'] },
      { excludeKinds: ['curate-memory'] },
    ])

    // The queue built WITHOUT the option calls claimNext(fence) exactly as it does today.
    const bareStore = createFakeJobStore(clock)
    const bareQueue = createAgentJobQueue({
      store: bareStore,
      registry,
      clock,
      idSource,
      model: unusedModel,
    })
    const bareFence = await bareStore.adoptEpoch(1)
    await bareQueue.enqueue('curate-memory', {}, 'run-1')
    const bare = await bareQueue.runNextJob({ fence: bareFence })
    expect(bare).toMatchObject({ ran: true, job: { kind: 'curate-memory' } })
    expect(bareStore.claimNextCalls()).toEqual([undefined])
  })
})
