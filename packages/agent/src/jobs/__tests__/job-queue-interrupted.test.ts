import { describe, expect, it } from 'vitest'

import type { JobId } from '@vostride/agent-qa-schema'

import type { ClockPort } from '../../ports/clock.js'
import { createAgentJobQueue } from '../engine.js'
import type { JobIdSource } from '../engine.js'
import { createJobKindRegistry } from '../kind-registry.js'
import type { JobKindDeclaration } from '../kind-registry.js'
import type { JobModelCapability, JobModelRequest } from '../record-llm-authorship.js'
import { createFakeJobStore } from './fake-job-store.js'

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

interface WaitingModel {
  readonly model: JobModelCapability
  readonly requests: JobModelRequest[]
  readonly called: Promise<void>
}

// Listens on the test's controller, not on the request, so the engine's signal is observed
// rather than relied on.
function waitingModel(controller: AbortController): WaitingModel {
  const requests: JobModelRequest[] = []
  let markCalled: () => void = () => {}
  const called = new Promise<void>((resolve) => {
    markCalled = resolve
  })
  const model: JobModelCapability = {
    modelId: 'test:waiting',
    generate: (request) => {
      requests.push(request)
      markCalled()
      return new Promise((_, reject) => {
        const abort = (): void =>
          reject(new DOMException('the model request was aborted', 'AbortError'))
        if (controller.signal.aborted) abort()
        else controller.signal.addEventListener('abort', abort, { once: true })
      })
    },
  }
  return { model, requests, called }
}

function authoringDeclaration(overrides: Partial<JobKindDeclaration> = {}): JobKindDeclaration {
  return {
    kind: 'analyze-run',
    checkpointed: true,
    checkpointSchedule: ['verdicts-authored'],
    allowedSuccessors: [],
    maxAttempts: 3,
    backoff: { kind: 'fixed', delayMs: 1_000 },
    onPermanentFailure: 'halt-chain',
    handler: async (context) => {
      await context.recordLlmAuthorship('verdicts-authored', (model) =>
        model.generate({ prompt: 'author the verdicts' }),
      )
      return { status: 'complete', next: [] }
    },
    ...overrides,
  }
}

async function harnessFor(declaration: JobKindDeclaration, model: JobModelCapability) {
  const clock = createSteppingClock()
  const store = createFakeJobStore(clock)
  const queue = createAgentJobQueue({
    store,
    registry: createJobKindRegistry([declaration]),
    clock,
    idSource,
    model,
  })
  const fence = await store.adoptEpoch(1)
  return { store, queue, fence }
}

describe('C444.1-INTERRUPTED', () => {
  it('an aborted model request returns its job to the queue without spending an attempt', async () => {
    const controller = new AbortController()
    const waiting = waitingModel(controller)
    const { store, queue, fence } = await harnessFor(authoringDeclaration(), waiting.model)
    await queue.enqueue('analyze-run', {}, 'key')

    const running = queue.runNextJob({ fence, signal: controller.signal })
    await waiting.called
    controller.abort()
    const outcome = await running

    expect(outcome).toMatchObject({ ran: true, disposition: 'interrupted', handlerInvoked: true })
    expect(outcome.ran && 'reason' in outcome ? outcome.reason : undefined).toContain(
      'the model request was aborted',
    )
    expect(waiting.requests).toHaveLength(1)
    expect(waiting.requests[0]?.signal, 'the request carried the job signal').toBeDefined()
    expect(waiting.requests[0]?.signal?.aborted).toBe(true)
    expect(store.callCount('releaseInterrupted')).toBe(1)
    expect(store.callCount('recordFailure')).toBe(0)
    expect(store.callCount('failAndChain')).toBe(0)
    expect(store.rows()).toMatchObject([{ status: 'queued', claimed: false, attempts: 0 }])
  })

  it('an aborted last attempt is not a permanent failure', async () => {
    const controller = new AbortController()
    const waiting = waitingModel(controller)
    const declaration = authoringDeclaration({
      maxAttempts: 2,
      handler: async (context) => {
        if (context.job.attempts === 1) return { status: 'retryable', reason: 'first attempt' }
        try {
          await context.recordLlmAuthorship('verdicts-authored', (model) =>
            model.generate({ prompt: 'author the verdicts' }),
          )
        } catch {
          return { status: 'retryable', reason: 'the model did not answer' }
        }
        return { status: 'complete', next: [] }
      },
    })
    const { store, queue, fence } = await harnessFor(declaration, waiting.model)
    await queue.enqueue('analyze-run', {}, 'key')
    expect(await queue.runNextJob({ fence })).toMatchObject({ disposition: 'retry-scheduled' })
    expect(store.rows()).toMatchObject([{ attempts: 1 }])

    const running = queue.runNextJob({ fence, signal: controller.signal })
    await waiting.called
    controller.abort()
    const outcome = await running

    expect(outcome).toMatchObject({
      ran: true,
      disposition: 'interrupted',
      reason: 'the model did not answer',
      job: { attempts: 2 },
    })
    expect(waiting.requests[0]?.signal?.aborted).toBe(true)
    expect(store.callCount('failAndChain')).toBe(0)
    expect(store.callCount('releaseInterrupted')).toBe(1)
    expect(store.rows()).toMatchObject([
      { status: 'queued', claimed: false, attempts: 1, lastFailureReason: 'first attempt' },
    ])
  })
})
