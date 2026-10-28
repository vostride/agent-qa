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

  // D-08 / JOBQ-05. The mandatory-key guarantee is NOT proved by any accepting case: a
  // schema that declared the key `.optional()`, or declared it as a bare string, keeps every
  // accepting case above green while admitting exactly the two payloads that break dedupe.
  // An absent key means the store has nothing to deduplicate on; an EMPTY key is worse,
  // because it satisfies the unique index and therefore collapses every job of the kind onto
  // one row. Both must be rejections, and each gets its own case.
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

  it('rejects unknown top-level keys (T-385-06)', () => {
    expect(
      jobEnqueueRequestSchema.safeParse({ ...VALID_REQUEST, priority: 'high' }).success,
    ).toBe(false)
  })

  it('rejects a kind outside the declared set', () => {
    expect(jobEnqueueRequestSchema.safeParse({ ...VALID_REQUEST, kind: 'review-run' }).success).toBe(
      false,
    )
  })

  // A successor is an enqueue request; the alias exists to name the D-17 role, not to relax
  // anything. If the two ever diverge, a chained enqueue could carry an empty key that a
  // root enqueue could not.
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

  // D-04: stamp and hard-fail, no migration machinery. The stamp is a literal, so a file
  // written by a different build is refused rather than reinterpreted. A plain
  // `z.number()` would accept every one of these.
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

  it('rejects unknown top-level keys (T-385-06)', () => {
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

  // The discriminant is the whole point of the union: without it, "a handler failed" and "a
  // handler finished with no successors" are the same shape, and D-18's retryable/permanent
  // distinction has nowhere to live.
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

// The C6 break from plan 01, re-asserted from the new vocabulary's own test file: these DTOs
// are typed against `JobKind`, so a regression in the job contract would surface here as a
// puzzling enqueue failure rather than as a job-contract failure.
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

  // D-16's other half, asserted from the conclusion's own file: naming an outcome for a row this
  // build cannot read must not widen what it CAN read. The five kinds are untouched.
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
