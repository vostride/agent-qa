// Literal stamp, no migration: a misread resume point is indistinguishable from lost progress.

import { z } from 'zod'

import { asJobId } from './job-id'
import type { JobId } from './job-id'

export const JOB_CHECKPOINT_SCHEMA_VERSION = 2

export interface JobCheckpointEnvelope {
  schemaVersion: typeof JOB_CHECKPOINT_SCHEMA_VERSION
  jobId: JobId
  checkpointId: string
  payload: unknown
}

const jobIdSchema = z.string().min(1).transform(asJobId)

export const jobCheckpointEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(JOB_CHECKPOINT_SCHEMA_VERSION),
    jobId: jobIdSchema,
    // Both ids become path segments in the local store, so neither may be empty here even
    // before the store applies its own stricter segment rule.
    checkpointId: z.string().min(1),
    payload: z.unknown(),
  })
  .strict()
