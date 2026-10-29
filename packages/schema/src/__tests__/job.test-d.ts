import { expectTypeOf } from 'vitest'
import type { z } from 'zod'
import type { Job } from '../job/job'
import { jobSchema } from '../job/job'

// Exact equality: `toMatchTypeOf` would pass while the interface and the zod schema drift.
expectTypeOf<z.infer<typeof jobSchema>>().toEqualTypeOf<Job>()

expectTypeOf<Job['attempts']>().toEqualTypeOf<number>()
expectTypeOf<Job['createdAt']>().toEqualTypeOf<string>()
expectTypeOf<Job['updatedAt']>().toEqualTypeOf<string>()

const ok: Job = {
  id: 'job_1' as Job['id'],
  kind: 'analyze-run',
  status: 'queued',
  summary: 'Analyze failed checkout run',
  attempts: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const invalidKind: Job = {
  id: 'job_2' as Job['id'],
  // @ts-expect-error Job kind must be one of the v2 QA Agent job types.
  kind: 'review-run',
  status: 'queued',
  summary: 'Invalid job kind',
  attempts: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

void ok
void invalidKind
