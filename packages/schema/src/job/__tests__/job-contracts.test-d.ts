import { expectTypeOf, it } from 'vitest'
import type { z } from 'zod'

import type { JobId } from '../job-id'
import { jobConclusionKindValues } from '../job'
import type { Job, JobConclusionKind, JobKind } from '../job'
import type { ChainedJobRequest, JobEnqueueRequest } from '../job-enqueue'
import { chainedJobRequestSchema, jobEnqueueRequestSchema } from '../job-enqueue'
import type { JobCheckpointEnvelope } from '../job-checkpoint'
import { JOB_CHECKPOINT_SCHEMA_VERSION, jobCheckpointEnvelopeSchema } from '../job-checkpoint'
import type { JobHandlerOutcome } from '../job-outcome'
import { jobHandlerOutcomeSchema } from '../job-outcome'

// Exact equality: `toMatchTypeOf` would pass while the schema and the interface drift.
expectTypeOf<z.infer<typeof jobEnqueueRequestSchema>>().toEqualTypeOf<JobEnqueueRequest>()
expectTypeOf<z.infer<typeof chainedJobRequestSchema>>().toEqualTypeOf<ChainedJobRequest>()
expectTypeOf<z.infer<typeof jobCheckpointEnvelopeSchema>>().toEqualTypeOf<JobCheckpointEnvelope>()
expectTypeOf<z.infer<typeof jobHandlerOutcomeSchema>>().toEqualTypeOf<JobHandlerOutcome>()

// The key is a required `string`: `.optional()` or `string | undefined` on either side fails here.
expectTypeOf<JobEnqueueRequest['idempotencyKey']>().toEqualTypeOf<string>()
expectTypeOf<JobEnqueueRequest['kind']>().toEqualTypeOf<JobKind>()
expectTypeOf<JobEnqueueRequest['payload']>().toEqualTypeOf<unknown>()

// A keyless enqueue request is not merely refused at parse time — it cannot be written.
// @ts-expect-error every enqueue carries an idempotency key; there is no keyless shape.
const keyless: JobEnqueueRequest = { kind: 'analyze-run', payload: null }

// The stamp is the literal, not `number`, or a build would accept another build's checkpoint.
expectTypeOf<JobCheckpointEnvelope['schemaVersion']>().toEqualTypeOf<
  typeof JOB_CHECKPOINT_SCHEMA_VERSION
>()
expectTypeOf<JobCheckpointEnvelope['jobId']>().toEqualTypeOf<JobId>()

const misstamped: JobCheckpointEnvelope = {
  // @ts-expect-error the version stamp is a literal; an arbitrary number is not an envelope.
  schemaVersion: 3,
  jobId: 'job_1' as JobId,
  checkpointId: 'analysis',
  payload: null,
}

expectTypeOf<JobHandlerOutcome['status']>().toEqualTypeOf<'complete' | 'retryable' | 'permanent'>()

const completion: JobHandlerOutcome = {
  status: 'complete',
  next: [{ kind: 'curate-memory', payload: { runRef: 'run_1' }, idempotencyKey: 'run_1' }],
}

// Narrowing on the discriminant is what makes the union load-bearing rather than decorative:
// `next` is unreachable until the outcome is known to be a completion.
if (completion.status === 'complete') {
  expectTypeOf(completion.next).toEqualTypeOf<ChainedJobRequest[]>()
}

const mixed: JobHandlerOutcome = {
  status: 'retryable',
  reason: 'timeout',
  // @ts-expect-error a failure carries a reason and no successors; the two arms do not mix.
  next: [],
}

void keyless
void misstamped
void completion
void mixed

// The conclusion type and its value list are two declarations; these bars check they agree.
it('the conclusion type and its value list agree', () => {
  expectTypeOf<Exclude<JobConclusionKind, (typeof jobConclusionKindValues)[number]>>().toBeNever()
  expectTypeOf<Exclude<(typeof jobConclusionKindValues)[number], JobConclusionKind>>().toBeNever()
})

it('the job kinds stay fixed while the conclusion vocabulary grows', () => {
  // Written out rather than read from `jobKindValues`, so a retired kind quietly re-admitted to
  // either declaration reddens here.
  expectTypeOf<JobKind>().toEqualTypeOf<
    'chat' | 'analyze-run' | 'curate-memory' | 'consolidate'
  >()
  expectTypeOf<Job['kind']>().toEqualTypeOf<JobKind>()
  // Optional, and optional of the WHOLE union: a narrowing here would let the store record a
  // conclusion the contract publishes but a reader could not receive.
  expectTypeOf<Job['conclusionKind']>().toEqualTypeOf<JobConclusionKind | undefined>()
})
