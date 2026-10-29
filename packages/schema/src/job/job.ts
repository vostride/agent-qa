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

// `attempts` increments at claim, so a job that kills its host still exhausts its bound.
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

// Not on the barrel: consumers need the `JobKind` type, not an array to build a registry from.
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

// A predicate, so a row with a retired kind is recognised before `jobSchema` instead of throwing.
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
  // Required: a store reads rows back through this schema, so optional fields admit bad rows.
  attempts: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).strict()
