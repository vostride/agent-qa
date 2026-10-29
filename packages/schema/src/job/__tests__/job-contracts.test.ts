import { describe, expect, it } from 'vitest'

import { jobSchema } from '../job'
import { chainedJobRequestSchema, jobEnqueueRequestSchema } from '../job-enqueue'
import { JOB_CHECKPOINT_SCHEMA_VERSION, jobCheckpointEnvelopeSchema } from '../job-checkpoint'
import { jobHandlerOutcomeSchema } from '../job-outcome'

const VALID_REQUEST: Record<string, unknown> = {
  kind: 'analyze-run',
  payload: { runRef: 'run_1' },
  idempotencyKey: 'run_1',
}

const VALID_ENVELOPE: Record<string, unknown> = {
  schemaVersion: JOB_CHECKPOINT_SCHEMA_VERSION,
  jobId: 'job_1',
  checkpointId: 'analysis',
  payload: { verdict: 'analysed' },
}

describe('jobEnqueueRequestSchema', () => {
  it('accepts a well-formed enqueue request', () => {
    expect(jobEnqueueRequestSchema.safeParse(VALID_REQUEST).success).toBe(true)
  })

  // An empty key satisfies the unique index and collapses every job of the kind onto one row.
  it('rejects an enqueue request with no idempotency key at all', () => {
    const withoutKey = { ...VALID_REQUEST }
    delete withoutKey.idempotencyKey

    expect(jobEnqueueRequestSchema.safeParse(withoutKey).success).toBe(false)
  })

  it('rejects an empty-string idempotency key', () => {
    expect(
      jobEnqueueRequestSchema.safeParse({ ...VALID_REQUEST, idempotencyKey: '' }).success,
    ).toBe(false)
  })

  it('rejects a non-string idempotency key', () => {
    expect(
      jobEnqueueRequestSchema.safeParse({ ...VALID_REQUEST, idempotencyKey: 7 }).success,
    ).toBe(false)
  })

  // The payload key is REQUIRED, not merely typed. A request that forgot its payload is a
  // request whose handler will read `undefined` and blame itself.
  it('rejects an enqueue request missing its payload key', () => {
    const withoutPayload = { ...VALID_REQUEST }
    delete withoutPayload.payload

    expect(jobEnqueueRequestSchema.safeParse(withoutPayload).success).toBe(false)
  })

  it('accepts a null payload, which is a value rather than an omission', () => {
    expect(jobEnqueueRequestSchema.safeParse({ ...VALID_REQUEST, payload: null }).success).toBe(
      true,
    )
  })

  it('rejects unknown top-level keys', () => {
    expect(
      jobEnqueueRequestSchema.safeParse({ ...VALID_REQUEST, priority: 'high' }).success,
    ).toBe(false)
  })

  it('rejects a kind outside the declared set', () => {
    expect(jobEnqueueRequestSchema.safeParse({ ...VALID_REQUEST, kind: 'review-run' }).success).toBe(
      false,
    )
  })

  // If the two diverge, a chained enqueue could carry an empty key a root enqueue could not.
  it('holds a chained request to the identical rules', () => {
    expect(chainedJobRequestSchema.safeParse(VALID_REQUEST).success).toBe(true)
    expect(
      chainedJobRequestSchema.safeParse({ ...VALID_REQUEST, idempotencyKey: '' }).success,
    ).toBe(false)
    expect(chainedJobRequestSchema.safeParse({ ...VALID_REQUEST, extra: 1 }).success).toBe(false)
  })
})

describe('jobCheckpointEnvelopeSchema', () => {
  it('accepts an envelope stamped at the current version', () => {
    expect(jobCheckpointEnvelopeSchema.safeParse(VALID_ENVELOPE).success).toBe(true)
  })

  // The stamp is a literal, so a file another build wrote is refused, not reinterpreted.
  it.each([0, 1, 3, 99, '2', null])('rejects an envelope stamped %p', (version) => {
    expect(
      jobCheckpointEnvelopeSchema.safeParse({ ...VALID_ENVELOPE, schemaVersion: version }).success,
    ).toBe(false)
  })

  it('rejects an envelope with no version stamp', () => {
    const unstamped = { ...VALID_ENVELOPE }
    delete unstamped.schemaVersion

    expect(jobCheckpointEnvelopeSchema.safeParse(unstamped).success).toBe(false)
  })

  it.each(['jobId', 'checkpointId', 'payload'])('rejects an envelope missing %s', (field) => {
    const withoutField = { ...VALID_ENVELOPE }
    delete withoutField[field]

    expect(jobCheckpointEnvelopeSchema.safeParse(withoutField).success).toBe(false)
  })

  it('rejects empty id fields, which cannot name a checkpoint or its job', () => {
    expect(jobCheckpointEnvelopeSchema.safeParse({ ...VALID_ENVELOPE, jobId: '' }).success).toBe(
      false,
    )
    expect(
      jobCheckpointEnvelopeSchema.safeParse({ ...VALID_ENVELOPE, checkpointId: '' }).success,
    ).toBe(false)
  })

  it('rejects unknown top-level keys', () => {
    expect(
      jobCheckpointEnvelopeSchema.safeParse({ ...VALID_ENVELOPE, recordedAt: 'x' }).success,
    ).toBe(false)
  })
})

describe('jobHandlerOutcomeSchema', () => {
  it('round-trips a completion carrying successors', () => {
    const outcome = { status: 'complete', next: [VALID_REQUEST] }
    const parsed = jobHandlerOutcomeSchema.parse(outcome)

    expect(parsed).toEqual(outcome)
  })

  it('round-trips a completion carrying no successors', () => {
    expect(jobHandlerOutcomeSchema.safeParse({ status: 'complete', next: [] }).success).toBe(true)
  })

  it.each(['retryable', 'permanent'])('round-trips a %s failure with its reason', (status) => {
    const parsed = jobHandlerOutcomeSchema.parse({ status, reason: 'provider timed out' })

    expect(parsed).toEqual({ status, reason: 'provider timed out' })
  })

  // Without the discriminant a failed handler and one with no successors are the same shape.
  it('rejects an outcome with no status discriminant', () => {
    expect(jobHandlerOutcomeSchema.safeParse({ next: [] }).success).toBe(false)
    expect(jobHandlerOutcomeSchema.safeParse({ reason: 'boom' }).success).toBe(false)
  })

  it('rejects an unrecognised status', () => {
    expect(jobHandlerOutcomeSchema.safeParse({ status: 'failed', reason: 'boom' }).success).toBe(
      false,
    )
  })

  // Each arm carries exactly its own fields. A completion has no reason and a failure has no
  // successors, so "retry this, and by the way chain these" cannot be expressed at all.
  it('rejects fields belonging to another arm', () => {
    expect(
      jobHandlerOutcomeSchema.safeParse({ status: 'complete', next: [], reason: 'boom' }).success,
    ).toBe(false)
    expect(
      jobHandlerOutcomeSchema.safeParse({ status: 'retryable', reason: 'boom', next: [] }).success,
    ).toBe(false)
  })

  it('rejects a completion with no successor list', () => {
    expect(jobHandlerOutcomeSchema.safeParse({ status: 'complete' }).success).toBe(false)
  })

  it.each(['retryable', 'permanent'])('rejects a %s outcome with an empty reason', (status) => {
    expect(jobHandlerOutcomeSchema.safeParse({ status, reason: '' }).success).toBe(false)
    expect(jobHandlerOutcomeSchema.safeParse({ status }).success).toBe(false)
  })

  // NESTING PROOF. "The union accepts a completion with successors" is satisfied just as
  // well by `next: z.array(z.unknown())`, which would let a handler chain a successor with
  // an empty idempotency key — the exact payload the enqueue rules above exist to refuse.
  // This is the case that fails unless the successor list really is the request schema.
  it('rejects a successor that would not survive an enqueue on its own', () => {
    expect(
      jobHandlerOutcomeSchema.safeParse({
        status: 'complete',
        next: [{ ...VALID_REQUEST, idempotencyKey: '' }],
      }).success,
    ).toBe(false)
    expect(
      jobHandlerOutcomeSchema.safeParse({
        status: 'complete',
        next: [{ ...VALID_REQUEST, kind: 'review-run' }],
      }).success,
    ).toBe(false)
    expect(
      jobHandlerOutcomeSchema.safeParse({ status: 'complete', next: [{ nonsense: true }] }).success,
    ).toBe(false)
  })
})

// These DTOs are typed against `JobKind`, so a job-contract regression would show up here.
describe('jobSchema alongside the new vocabulary', () => {
  it('still parses a full job and still refuses unknown keys', () => {
    const job = {
      id: 'job_1',
      kind: 'analyze-run',
      status: 'queued',
      summary: 'Analyze failed checkout run',
      attempts: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
    }

    expect(jobSchema.safeParse(job).success).toBe(true)
    expect(jobSchema.safeParse({ ...job, idempotencyKey: 'k' }).success).toBe(false)
  })
})

describe('jobConclusionKind', () => {
  const CONCLUSIONS = ['unreadable_kind']

  const JOB: Record<string, unknown> = {
    id: 'job_1',
    kind: 'analyze-run',
    status: 'failed',
    summary: 'Analyze failed checkout run',
    attempts: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
  }

  it.each(CONCLUSIONS)('parses a job concluding %s', (conclusion) => {
    expect(jobSchema.safeParse({ ...JOB, conclusionKind: conclusion }).success).toBe(true)
  })

  it.each(['unreadable-kind', 'unreadableKind', 'illicit-conclusion-kind', 'quarantined', ''])(
    'refuses %p, which is not a declared conclusion',
    (conclusion) => {
      expect(jobSchema.safeParse({ ...JOB, conclusionKind: conclusion }).success).toBe(false)
    },
  )

  // Naming an outcome for an unreadable row must not widen the kinds this build reads.
  it('admits the unreadable-kind conclusion without admitting an unreadable kind', () => {
    expect(jobSchema.safeParse({ ...JOB, conclusionKind: 'unreadable_kind' }).success).toBe(true)
    expect(
      jobSchema.safeParse({ ...JOB, kind: 'retired-kind-fixture', conclusionKind: 'unreadable_kind' })
        .success,
    ).toBe(false)
  })

  it('leaves the conclusion optional, because most rows conclude nothing nameable', () => {
    expect(jobSchema.safeParse(JOB).success).toBe(true)
    expect(jobSchema.safeParse({ ...JOB, conclusionKind: undefined }).success).toBe(true)
  })
})
