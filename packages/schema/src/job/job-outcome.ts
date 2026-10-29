// A retryable report on the last permitted attempt still becomes a permanent disposition.

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
