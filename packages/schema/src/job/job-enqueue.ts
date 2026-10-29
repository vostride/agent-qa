// The key is mandatory and non-empty: an empty key would match every job of the kind.

import { z } from 'zod'

import { jobKindValues } from './job'
import type { JobKind } from './job'

export interface JobEnqueueRequest {
  kind: JobKind
  payload: unknown
  idempotencyKey: string
}

export type ChainedJobRequest = JobEnqueueRequest

export const jobEnqueueRequestSchema = z
  .object({
    kind: z.enum(jobKindValues),
    payload: z.unknown(),
    idempotencyKey: z.string().min(1),
  })
  .strict()

/**
 * The same rules, under the successor's name.
 *
 * Deliberately the identical schema value rather than a copy: two schemas would be free to
 * drift, and the direction that drift would take is obvious — a chained enqueue quietly
 * accepting a key a root enqueue refuses.
 */
export const chainedJobRequestSchema = jobEnqueueRequestSchema
