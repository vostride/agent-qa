import { describe, expectTypeOf, it } from 'vitest'

import type { ChainedJobRequest } from '@vostride/agent-qa-schema'

import type {
  FallbackContinuationInput,
  FallbackContinuationProducer,
  JobKindDeclaration,
} from '../kind-registry.js'

describe('the declaration surface', () => {
  // Exact equality, not a contains check. A per-field assertion list can only say what IS
  // present; this reddens when a field is dropped AND when one arrives, which is what makes
  // the matrix's iteration domain a pinned shape rather than whatever today's kinds happen
  // to carry.
  it('declares exactly the eight fields the engine reads', () => {
    expectTypeOf<keyof JobKindDeclaration>().toEqualTypeOf<
      | 'kind'
      | 'checkpointed'
      | 'checkpointSchedule'
      | 'allowedSuccessors'
      | 'maxAttempts'
      | 'backoff'
      | 'onPermanentFailure'
      | 'handler'
    >()
  })
})

describe('the fallback-continuation producer', () => {
  // The producer runs on the RESUME-legal side of the queue: it is what a permanently failed
  // job hands its chain so downstream work never waits on a dead head. It must therefore be
  // unable to reach a model at all, and the way that is guaranteed is the type — it receives
  // the failed job, the payload it was given, and the reason, and nothing else. There is no
  // capability parameter for a caller to pass one through.
  it('receives the job, its payload and the reason — and no capability at all', () => {
    expectTypeOf<keyof FallbackContinuationInput>().toEqualTypeOf<'job' | 'payload' | 'reason'>()
  })

  // SYNCHRONOUS on purpose, and this is the load-bearing half. A producer that returned a
  // promise could await anything, including a model call; one that must return its
  // continuation instances immediately can only compute them from what it was handed.
  it('returns its continuation instances immediately, never a promise', () => {
    expectTypeOf<ReturnType<FallbackContinuationProducer>>().toEqualTypeOf<
      readonly ChainedJobRequest[]
    >()
    expectTypeOf<ReturnType<FallbackContinuationProducer>>().not.toMatchTypeOf<Promise<unknown>>()
  })

  it('takes exactly one argument', () => {
    expectTypeOf<Parameters<FallbackContinuationProducer>>().toEqualTypeOf<
      [FallbackContinuationInput]
    >()
  })

  it('accepts the halt-chain literal as the other disposition', () => {
    expectTypeOf<JobKindDeclaration['onPermanentFailure']>().toMatchTypeOf<
      'halt-chain' | FallbackContinuationProducer
    >()
  })
})
