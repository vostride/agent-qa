// The on-disk contract for one agent job checkpoint.
//
// Under the hybrid split each checkpoint is its own committed artifact, and every committed
// artifact in this repo carries a literal version stamp with no migration machinery behind
// it (the v51 convention). Literal, not a number range: a build that read a stamp it did not
// write would be guessing at the layout of bytes it is about to resume from, and a wrong
// guess about a resume point is indistinguishable from progress that never happened. On a
// mismatch the reader refuses and the operator clears queue state.
//
// The ENVELOPE is what this module owns; the payload stays `unknown` on purpose. What a
// checkpoint means belongs to the engine that publishes it, and pinning a payload shape here
// would make every new job kind a change to the shared contract.
//
// A note on the name. The store's own `PRAGMA user_version` is a DIFFERENT version with a
// different lifetime — it describes table layout, this describes file layout — so this
// constant is named for the checkpoint rather than for the store, and the two must not be
// collapsed into one number just because both currently read 1.

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
