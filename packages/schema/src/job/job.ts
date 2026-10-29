import { z } from 'zod'

import { runIdSchema } from '../run/run-id'
import type { RunId } from '../run/run-id'
import { asJobId } from './job-id'
import type { JobId } from './job-id'

export type JobKind =
  | 'chat'
  | 'analyze-run'
  | 'curate-memory'
  | 'consolidate'

// The statuses the agent job store writes: a row is inserted `queued` and ends `done`, `failed`
// or `cancelled`.
export type JobStatus = 'queued' | 'done' | 'failed' | 'cancelled'

// Derived at read time for a row whose kind this build cannot read; such a row is landed at claim
// with its attempt spent, so the queue neither loops on it nor hides it.
export type JobConclusionKind = 'unreadable_kind'

// 385 C6: `attempts` is incremented at CLAIM, so a job that kills its host
// every time still exhausts its bound instead of crash-looping. `createdAt`/`updatedAt` are
// ISO strings minted by the injected ClockPort — never the ambient wall clock and never a
// SQL-side default, or the D-03 logical dump can never be compared across an interrupted
// history. (This package's module-discipline guard forbids naming that ambient API here,
// even in prose, so the rule is stated rather than quoted.)
export interface Job {
  id: JobId
  kind: JobKind
  status: JobStatus
  runRef?: RunId
  summary: string
  conclusionKind?: JobConclusionKind
  attempts: number
  createdAt: string
  updatedAt: string
}

// Exported for the sibling job DTO modules only (385 plan 02). They enumerate the same kind
// set, and a second hand-written literal list is how one of them ends up admitting a kind the
// other refuses. It is not on the package barrel: the kind vocabulary consumers need is the
// `JobKind` type, and publishing the array as well would invite a caller to iterate it and
// build a parallel registry beside the declared one.
export const jobKindValues = [
  'chat',
  'analyze-run',
  'curate-memory',
  'consolidate',
] as const satisfies readonly JobKind[]

const jobStatusValues = [
  'queued',
  'done',
  'failed',
  'cancelled',
] as const satisfies readonly JobStatus[]

// Exported on the same terms as `jobKindValues`: for sibling modules, never on the package
// barrel. A consumer that needs to talk about a conclusion has the `JobConclusionKind` type.
export const jobConclusionKindValues = [
  'unreadable_kind',
] as const satisfies readonly JobConclusionKind[]

/**
 * Whether this build reads `value` as a job kind.
 *
 * A PREDICATE rather than the array, so a caller can ask the question without gaining a list it
 * could iterate into a second registry. The store asks it of raw column bytes before those bytes
 * reach `jobSchema`, which is what lets a row written under a retired kind be recognised and
 * landed instead of throwing out of the transaction that had just spent its attempt.
 */
export function isJobKind(value: unknown): value is JobKind {
  return typeof value === 'string' && (jobKindValues as readonly string[]).includes(value)
}

const jobIdSchema = z.string().transform(asJobId)

export const jobSchema = z.object({
  id: jobIdSchema,
  kind: z.enum(jobKindValues),
  status: z.enum(jobStatusValues),
  runRef: runIdSchema.optional(),
  summary: z.string(),
  conclusionKind: z.enum(jobConclusionKindValues).optional(),
  // REQUIRED, not optional. A store reads its rows back through this schema, so an optional
  // field here would let a row that never recorded an attempt or a timestamp parse clean —
  // and the C6 break exists precisely so that row cannot exist.
  attempts: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).strict()
