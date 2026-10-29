// Engine-complete cooperative cancellation.
//
// D-19 names TWO behaviours and the lazy implementation collapses them into one. A queued job
// cancels immediately, because nothing is running and there is nothing to be cooperative
// about. A CLAIMED job does not: it becomes cancel-requested and the driver honours that at
// the next checkpoint boundary, so work already done stays done and no half-finished side
// effect is abandoned mid-step. An implementation that cancels both immediately passes any
// test that only asks "does cancel work", and destroys the in-flight semantics 386's daemon is
// written against; one that only ever records the request passes any test that only checks the
// request was recorded. Every claim below therefore carries the control that separates it from
// its opposite.
//
// "The next checkpoint boundary" is a specific place and the tests pin it: the checkpoint
// already published stays published, the next one never starts, and a cancel that arrives
// after the last boundary does not retroactively cancel a job that finished its work.

import { describe, expect, it } from 'vitest'

import type { JobId } from '@vostride/agent-qa-schema'

import type { ClockPort } from '../../ports/clock.js'
import { JobCancellationNotRequestedError, StaleJobStoreEpochError } from '../../ports/job-store.js'
import type { JobStoreFence } from '../../ports/job-store.js'
import { createAgentJobQueue, JobCancelledError } from '../engine.js'
import type { AgentJobQueue, JobIdSource } from '../engine.js'
import { createJobKindRegistry } from '../kind-registry.js'
import type { JobKindDeclaration } from '../kind-registry.js'
import type { JobModelCapability } from '../record-llm-authorship.js'
import { createFakeJobStore } from './fake-job-store.js'
import type { FakeJobStore } from './fake-job-store.js'

function steppingClock(): ClockPort {
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

const unusedModel: JobModelCapability = {
  modelId: 'test:unused',
  generate: async () => {
    throw new Error('cancel semantics never author')
  },
}

function declaration(overrides: Partial<JobKindDeclaration> = {}): JobKindDeclaration {
  return {
    kind: 'curate-memory',
    checkpointed: true,
    checkpointSchedule: ['candidates-authored', 'bundle-committed'],
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
}

async function harnessFor(declarations: readonly JobKindDeclaration[]): Promise<Harness> {
  const clock = steppingClock()
  const store = createFakeJobStore(clock)
  const queue = createAgentJobQueue({
    store,
    registry: createJobKindRegistry(declarations),
    clock,
    idSource,
    model: unusedModel,
  })
  const fence = await store.adoptEpoch(1)
  return { store, queue, fence }
}

async function rowOf(store: FakeJobStore, jobId: JobId) {
  const dump = await store.dumpState()
  return dump.jobs.find((row) => row.id === String(jobId))
}

describe('cancel on a QUEUED job: immediate', () => {
  it('lands the job cancelled and no later claim ever returns it', async () => {
    let handlerCalls = 0
    const harness = await harnessFor([
      declaration({
        handler: async () => {
          handlerCalls += 1
          return { status: 'complete', next: [] }
        },
      }),
    ])
    const enqueued = await harness.queue.enqueue('curate-memory', {}, 'run-1')

    const cancelled = await harness.queue.cancel({
      jobId: enqueued.job.id,
      fence: harness.fence,
    })

    expect(cancelled).toEqual({ outcome: 'cancelled' })
    expect((await rowOf(harness.store, enqueued.job.id))?.status).toBe('cancelled')
    expect(await harness.queue.runNextJob({ fence: harness.fence })).toEqual({
      ran: false,
      reason: 'no-job',
    })
    expect(handlerCalls).toBe(0)
  })

  // The positive control. Without it, "the handler never ran" is satisfied by a queue that
  // never runs anything, and "no-job" by a queue that claims nothing at all.
  it('claims and runs the very same job when it was not cancelled', async () => {
    let handlerCalls = 0
    const harness = await harnessFor([
      declaration({
        handler: async () => {
          handlerCalls += 1
          return { status: 'complete', next: [] }
        },
      }),
    ])
    const enqueued = await harness.queue.enqueue('curate-memory', {}, 'run-1')

    const outcome = await harness.queue.runNextJob({ fence: harness.fence })

    expect(outcome).toMatchObject({ ran: true, disposition: 'completed' })
    expect(handlerCalls).toBe(1)
    expect((await rowOf(harness.store, enqueued.job.id))?.status).toBe('done')
  })
})

describe('cancel on a CLAIMED job: requested, then honoured at a boundary', () => {
  /**
   * A kind whose handler publishes its schedule step by step and cancels itself partway, the
   * way an operator's cancel would arrive while the job is in flight.
   */
  function interruptedHarness(options: {
    readonly schedule: readonly string[]
    /** Cancel just after this checkpoint has been published. */
    readonly cancelAfter: string
    readonly swallow?: boolean
  }): {
    readonly harness: Promise<Harness>
    reached(): readonly string[]
    swallowed(): number
    request(): { queue: AgentJobQueue; fence: JobStoreFence; jobId: JobId } | undefined
  } {
    const reached: string[] = []
    let swallowed = 0
    let bound: { queue: AgentJobQueue; fence: JobStoreFence; jobId: JobId } | undefined

    const harness = harnessFor([
      declaration({
        checkpointSchedule: options.schedule,
        handler: async (context) => {
          for (const checkpointId of options.schedule) {
            reached.push(`enter:${checkpointId}`)
            try {
              await context.publishCheckpoint(checkpointId, { checkpointId })
            } catch (error) {
              if (options.swallow === true && error instanceof JobCancelledError) {
                swallowed += 1
                reached.push(`swallowed:${checkpointId}`)
                continue
              }
              throw error
            }
            reached.push(`published:${checkpointId}`)
            if (checkpointId === options.cancelAfter && bound !== undefined) {
              await bound.queue.cancel({ jobId: bound.jobId, fence: bound.fence })
              reached.push('cancel-requested')
            }
          }
          reached.push('handler-returned')
          return { status: 'complete', next: [] }
        },
      }),
    ]).then(async (ready) => {
      const enqueued = await ready.queue.enqueue('curate-memory', {}, 'run-1')
      bound = { queue: ready.queue, fence: ready.fence, jobId: enqueued.job.id }
      return ready
    })

    return {
      harness,
      reached: () => [...reached],
      swallowed: () => swallowed,
      request: () => bound,
    }
  }

  it('records the request WITHOUT terminating a job that is still running', async () => {
    // The claimed job is not terminal at the moment the cancel is recorded — an implementation
    // that cancelled it outright here would throw away work already in progress.
    const clock = steppingClock()
    const store = createFakeJobStore(clock)
    const fence = await store.adoptEpoch(1)
    let observed: { status: string; cancelRequested: boolean } | undefined
    const queue = createAgentJobQueue({
      store,
      registry: createJobKindRegistry([
        declaration({
          handler: async (context) => {
            await queue.cancel({ jobId: context.job.id, fence })
            const row = (await store.dumpState()).jobs.find(
              (candidate) => candidate.id === String(context.job.id),
            )
            observed = {
              status: String(row?.status),
              cancelRequested: row?.cancelRequested === true,
            }
            return { status: 'complete', next: [] }
          },
          checkpointSchedule: ['candidates-authored'],
        }),
      ]),
      clock,
      idSource,
      model: unusedModel,
    })
    await queue.enqueue('curate-memory', {}, 'run-1')

    await queue.runNextJob({ fence })

    expect(observed).toEqual({ status: 'queued', cancelRequested: true })
  })

  it('reports cancel-requested rather than cancelled for a job in flight', async () => {
    const clock = steppingClock()
    const store = createFakeJobStore(clock)
    const fence = await store.adoptEpoch(1)
    let reported: unknown
    const queue = createAgentJobQueue({
      store,
      registry: createJobKindRegistry([
        declaration({
          checkpointSchedule: ['candidates-authored'],
          handler: async (context) => {
            reported = await queue.cancel({ jobId: context.job.id, fence })
            return { status: 'complete', next: [] }
          },
        }),
      ]),
      clock,
      idSource,
      model: unusedModel,
    })
    await queue.enqueue('curate-memory', {}, 'run-1')
    await queue.runNextJob({ fence })

    expect(reported).toEqual({ outcome: 'cancel-requested' })
  })

  it('keeps the checkpoint in flight, never starts the next, and lands cancelled', async () => {
    const probe = interruptedHarness({
      schedule: ['candidates-authored', 'bundle-committed'],
      cancelAfter: 'candidates-authored',
    })
    const harness = await probe.harness

    const outcome = await harness.queue.runNextJob({ fence: harness.fence })

    expect(outcome).toMatchObject({
      ran: true,
      disposition: 'cancelled',
      handlerInvoked: true,
      checkpointsPublished: ['candidates-authored'],
      honoredAtCheckpoint: 'bundle-committed',
    })
    // The work already done stayed done, the next step never ran, and the handler never got
    // to its tail. Each of those is a different wrong implementation ruled out.
    expect(probe.reached()).toEqual([
      'enter:candidates-authored',
      'published:candidates-authored',
      'cancel-requested',
      'enter:bundle-committed',
    ])
    expect(harness.store.checkpoints().map((entry) => entry.checkpointId)).toEqual([
      'candidates-authored',
    ])
    const row = await rowOf(harness.store, probe.request()!.jobId)
    expect(row?.status).toBe('cancelled')
    expect(row?.claimed).toBe(false)
  })

  it('a handler that swallows the refusal cannot un-cancel itself', async () => {
    // Cooperative means cooperative, not optional. Every remaining boundary refuses too, and
    // the job lands cancelled at the FIRST one whatever the handler eventually reports —
    // otherwise a `catch` in a handler would be a way to opt out of cancellation entirely.
    const probe = interruptedHarness({
      schedule: ['one', 'two', 'three'],
      cancelAfter: 'one',
      swallow: true,
    })
    const harness = await probe.harness

    const outcome = await harness.queue.runNextJob({ fence: harness.fence })

    expect(probe.swallowed()).toBe(2)
    expect(probe.reached()).toContain('handler-returned')
    expect(outcome).toMatchObject({
      disposition: 'cancelled',
      checkpointsPublished: ['one'],
      honoredAtCheckpoint: 'two',
    })
    expect((await rowOf(harness.store, probe.request()!.jobId))?.status).toBe('cancelled')
  })

  // The control for "at a boundary" rather than "everywhere". A cancel that arrives once the
  // last checkpoint is behind the job has no boundary left to be honoured at, and the job has
  // already done its work — so it completes. An engine that cancelled after the handler
  // returned would satisfy every test above and quietly discard finished work.
  it('lets a job whose cancel arrives after its last checkpoint complete', async () => {
    const probe = interruptedHarness({
      schedule: ['candidates-authored', 'bundle-committed'],
      cancelAfter: 'bundle-committed',
    })
    const harness = await probe.harness

    const outcome = await harness.queue.runNextJob({ fence: harness.fence })

    expect(outcome).toMatchObject({ ran: true, disposition: 'completed' })
    expect(probe.reached()).toContain('handler-returned')
    expect((await rowOf(harness.store, probe.request()!.jobId))?.status).toBe('done')
  })

  it('never honours a request inside a kind that declares no checkpoint at all', async () => {
    // chat's posture, stated as a consequence rather than left to be discovered: a kind with no
    // boundary has nowhere to honour a cooperative cancel, and its turn runs to the end.
    const clock = steppingClock()
    const store = createFakeJobStore(clock)
    const fence = await store.adoptEpoch(1)
    const queue = createAgentJobQueue({
      store,
      registry: createJobKindRegistry([
        declaration({
          kind: 'chat',
          checkpointed: false,
          checkpointSchedule: [],
          maxAttempts: 1,
          handler: async (context) => {
            await queue.cancel({ jobId: context.job.id, fence })
            return { status: 'complete', next: [] }
          },
        }),
      ]),
      clock,
      idSource,
      model: unusedModel,
    })
    const enqueued = await queue.enqueue('chat', {}, 'turn-1')

    const outcome = await queue.runNextJob({ fence })

    expect(outcome).toMatchObject({ ran: true, disposition: 'completed' })
    expect((await rowOf(store, enqueued.job.id))?.status).toBe('done')
  })
})

describe('cancel on a TERMINAL job: refused as a typed outcome', () => {
  it.each([
    { label: 'done', script: {}, expected: 'done' },
    { label: 'failed', script: { fail: true }, expected: 'failed' },
  ])('reports already-terminal for a $label job and changes nothing', async (row) => {
    const harness = await harnessFor([
      declaration({
        maxAttempts: 1,
        handler: async () =>
          'fail' in row.script
            ? { status: 'permanent', reason: 'gave up' }
            : { status: 'complete', next: [] },
      }),
    ])
    const enqueued = await harness.queue.enqueue('curate-memory', {}, 'run-1')
    await harness.queue.runNextJob({ fence: harness.fence })
    const before = JSON.stringify(await harness.store.dumpState())

    const outcome = await harness.queue.cancel({
      jobId: enqueued.job.id,
      fence: harness.fence,
    })

    expect(outcome).toEqual({ outcome: 'already-terminal', status: row.expected })
    expect(JSON.stringify(await harness.store.dumpState())).toBe(before)
  })

  it('reports already-terminal for a job that was already cancelled', async () => {
    const harness = await harnessFor([declaration()])
    const enqueued = await harness.queue.enqueue('curate-memory', {}, 'run-1')
    await harness.queue.cancel({ jobId: enqueued.job.id, fence: harness.fence })
    const before = JSON.stringify(await harness.store.dumpState())

    const outcome = await harness.queue.cancel({
      jobId: enqueued.job.id,
      fence: harness.fence,
    })

    expect(outcome).toEqual({ outcome: 'already-terminal', status: 'cancelled' })
    expect(JSON.stringify(await harness.store.dumpState())).toBe(before)
  })
})

describe('cancel crosses the fence like every other mutation', () => {
  it('refuses a stale epoch, changes nothing, and the current holder still succeeds', async () => {
    const harness = await harnessFor([declaration()])
    const enqueued = await harness.queue.enqueue('curate-memory', {}, 'run-1')
    const current = await harness.store.adoptEpoch(2)
    const before = JSON.stringify(await harness.store.dumpState())

    await expect(
      harness.queue.cancel({ jobId: enqueued.job.id, fence: harness.fence }),
    ).rejects.toBeInstanceOf(StaleJobStoreEpochError)
    expect(JSON.stringify(await harness.store.dumpState())).toBe(before)

    // The paired success: the verb works, it just refused the writer that had fallen behind.
    expect(await harness.queue.cancel({ jobId: enqueued.job.id, fence: current })).toEqual({
      outcome: 'cancelled',
    })
  })
})

describe('cancelled is only ever reachable through a request', () => {
  it('refuses to record a cancellation nobody asked for', async () => {
    const harness = await harnessFor([declaration()])
    const enqueued = await harness.queue.enqueue('curate-memory', {}, 'run-1')
    const before = JSON.stringify(await harness.store.dumpState())

    await expect(
      harness.store.recordCancellation(enqueued.job.id, harness.fence),
    ).rejects.toBeInstanceOf(JobCancellationNotRequestedError)
    expect(JSON.stringify(await harness.store.dumpState())).toBe(before)
  })

  // The paired success, so "it refuses" is not satisfied by a verb that refuses everything.
  it('records one that was asked for', async () => {
    const harness = await harnessFor([declaration()])
    const enqueued = await harness.queue.enqueue('curate-memory', {}, 'run-1')
    await harness.store.claimNext(harness.fence)
    await harness.queue.cancel({ jobId: enqueued.job.id, fence: harness.fence })

    await harness.store.recordCancellation(enqueued.job.id, harness.fence)

    const row = await rowOf(harness.store, enqueued.job.id)
    expect(row?.status).toBe('cancelled')
    expect(row?.claimed).toBe(false)
  })
})
