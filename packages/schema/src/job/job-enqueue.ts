// What a caller asks the agent job queue for.
//
// This is the REQUEST vocabulary: the three facts a caller actually knows. It is deliberately
// not the row the store inserts — the job's id is derived from the kind and the key by an
// injected id source at the engine boundary, and its summary is composed there too, so a
// caller that had to supply either could make the same logical job carry two identities.
// The port's insert type is that resolved shape and extends this one; keeping the two apart
// is what lets a handler ask for a successor without minting ids on the store's behalf.
//
// The idempotency key is MANDATORY here and nowhere is it optional. Dedupe rests on a
// `(kind, idempotencyKey)` unique index, so a missing key leaves the index nothing to match
// on and an EMPTY key matches everything — one shared row for every job of the kind. The
// type forbids the first and the min-length rule forbids the second; neither alone is
// enough, because a runtime schema cannot police a compile-time caller and a type cannot
// police bytes arriving from another process.

import { z } from 'zod'

import { jobKindValues } from './job'
import type { JobKind } from './job'

export interface JobEnqueueRequest {
  kind: JobKind
  payload: unknown
  idempotencyKey: string
}

/**
 * A successor a handler's deterministic tail asks for.
 *
 * Structurally an enqueue request, and named separately because the ROLE differs: the
 * topology of what may chain to what is declared once on the kind, while the instances come
 * back from the handler as ordinary data. An outcome-dependent chain is then a value, not a
 * special case in the engine.
 */
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
