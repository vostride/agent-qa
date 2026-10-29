import { describe, expect, it } from 'vitest'
import { jobSchema } from '../job/job'

const VALID_JOB: Record<string, unknown> = {
  id: 'job_1',
  kind: 'analyze-run',
  status: 'queued',
  summary: 'Analyze failed checkout run',
  attempts: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

describe('jobSchema', () => {
  it('accepts a valid queued analyze-run job', () => {
    expect(jobSchema.safeParse(VALID_JOB).success).toBe(true)
  })

  it('rejects unknown top-level keys', () => {
    const result = jobSchema.safeParse({ ...VALID_JOB, checkpoint: 'cp_1' })

    expect(result.success).toBe(false)
  })

  it('rejects an invalid job kind', () => {
    const result = jobSchema.safeParse({ ...VALID_JOB, kind: 'review-run' })

    expect(result.success).toBe(false)
  })

  // Each required field gets its own rejection case; an optional one passes every accepting case.
  it.each(['attempts', 'createdAt', 'updatedAt'])('rejects a job missing %s', (field) => {
    const withoutField = { ...VALID_JOB }
    delete withoutField[field]

    expect(jobSchema.safeParse(withoutField).success).toBe(false)
  })

  it('rejects a negative or fractional attempt count', () => {
    expect(jobSchema.safeParse({ ...VALID_JOB, attempts: -1 }).success).toBe(false)
    expect(jobSchema.safeParse({ ...VALID_JOB, attempts: 1.5 }).success).toBe(false)
  })

  it('accepts the failed and cancelled terminal statuses', () => {
    expect(jobSchema.safeParse({ ...VALID_JOB, status: 'failed' }).success).toBe(true)
    expect(jobSchema.safeParse({ ...VALID_JOB, status: 'cancelled' }).success).toBe(true)
  })

  it('rejects a status outside the declared set', () => {
    expect(jobSchema.safeParse({ ...VALID_JOB, status: 'claimed' }).success).toBe(false)
  })
})
