// What a job handler reports when it returns.
//
// Three arms, discriminated. Without the discriminant, "the work finished and chains
// nothing" and "the work failed" are the same shape, and the engine would have to infer
// failure from an absence — which is how a handler that threw halfway lands as a clean
// completion. The split between `retryable` and `permanent` is D-18's: the handler knows
// whether the thing that went wrong could go right next time; only the engine knows whether
// any attempts remain. So this type is the handler's REPORT, and the disposition the store
// records is the engine's DECISION over it — a retryable report on the last permitted
// attempt still becomes a permanent disposition. Collapsing the two would delete that
// distinction and with it the bound on retries.
//
// Successors ride on the completion arm alone. A failed attempt that could still enqueue
// follow-on work would leave the chain half-built with no record of which half.

import { z } from 'zod'

import { chainedJobRequestSchema } from './job-enqueue'
import type { ChainedJobRequest } from './job-enqueue'

export type JobHandlerOutcome =
  | { status: 'complete'; next: ChainedJobRequest[] }
  | { status: 'retryable'; reason: string }
  | { status: 'permanent'; reason: string }

export const jobHandlerOutcomeSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('complete'),
      // The successor list is the request schema itself, so a successor that could not be
      // enqueued on its own cannot arrive through a completion either. An array of anything
      // looser would let a chain smuggle in the empty key the enqueue rules exist to refuse.
      next: z.array(chainedJobRequestSchema),
    })
    .strict(),
  z.object({ status: z.literal('retryable'), reason: z.string().min(1) }).strict(),
  z.object({ status: z.literal('permanent'), reason: z.string().min(1) }).strict(),
])
