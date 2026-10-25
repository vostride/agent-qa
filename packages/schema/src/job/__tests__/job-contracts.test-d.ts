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

// The lockstep detectors, in the shape plan 01 established for the job contract: exact
// equality between what the runtime schema produces and what the interface promises. A
// `toMatchTypeOf` here would pass while the two drifted, which is the only drift these
// files can have. Do not weaken them.
expectTypeOf<z.infer<typeof jobEnqueueRequestSchema>>().toEqualTypeOf<JobEnqueueRequest>()
expectTypeOf<z.infer<typeof chainedJobRequestSchema>>().toEqualTypeOf<ChainedJobRequest>()
expectTypeOf<z.infer<typeof jobCheckpointEnvelopeSchema>>().toEqualTypeOf<JobCheckpointEnvelope>()
expectTypeOf<z.infer<typeof jobHandlerOutcomeSchema>>().toEqualTypeOf<JobHandlerOutcome>()

// D-08 at the TYPE level, complementing the runtime rejection cases. The key is a required
// `string`: an `.optional()` on either side of the lockstep, or a widening to
// `string | undefined`, reddens this line before any parse is ever attempted.
expectTypeOf<JobEnqueueRequest['idempotencyKey']>().toEqualTypeOf<string>()
expectTypeOf<JobEnqueueRequest['kind']>().toEqualTypeOf<JobKind>()
expectTypeOf<JobEnqueueRequest['payload']>().toEqualTypeOf<unknown>()

// A keyless enqueue request is not merely refused at parse time — it cannot be written.
// @ts-expect-error every enqueue carries an idempotency key; there is no keyless shape.
const keyless: JobEnqueueRequest = { kind: 'analyze-run', payload: null }

// D-04: the stamp is the literal, not `number`. A widening here is how a build would start
// accepting a checkpoint file some other build wrote.
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

// The three arms, pinned by exact equality on the discriminant. D-18's retryable/permanent
// split lives here; a fourth arm or a lost one is a contract change plans 03/04 build on.
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

// 422 D-16 (ADV-03): the compile-time half of the conclusion vocabulary, in the never-bar shape
// the closed-set instruments use. Every expectation is written out independently of its subject —
// neither side derives from the other — so removing a member from the UNION reddens here even
// while the value list still contains it, and adding one to the union reddens here even while the
// list does not. That independence is what makes the runtime list above and this file two
// instruments rather than one restated twice.
type DeclaredConclusion =
  | 'no_issue'
  | 'needs_user_input'
  | 'insufficient_evidence'
  | 'knowledge_skipped_draft'
  | 'model_capability_error'
  | 'provider_error'
  | 'insufficient_model_output'
  | 'unreadable_kind'

it('job conclusion kinds exact type bars', () => {
  expectTypeOf<JobConclusionKind>().toEqualTypeOf<DeclaredConclusion>()
  expectTypeOf<(typeof jobConclusionKindValues)[number]>().toEqualTypeOf<DeclaredConclusion>()
  expectTypeOf<Exclude<JobConclusionKind, (typeof jobConclusionKindValues)[number]>>().toBeNever()
  expectTypeOf<Exclude<(typeof jobConclusionKindValues)[number], JobConclusionKind>>().toBeNever()
  expectTypeOf<Exclude<JobConclusionKind, DeclaredConclusion>>().toBeNever()
  expectTypeOf<Exclude<DeclaredConclusion, JobConclusionKind>>().toBeNever()
  expectTypeOf<Exclude<(typeof jobConclusionKindValues)[number], DeclaredConclusion>>().toBeNever()
  expectTypeOf<Exclude<DeclaredConclusion, (typeof jobConclusionKindValues)[number]>>().toBeNever()
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
