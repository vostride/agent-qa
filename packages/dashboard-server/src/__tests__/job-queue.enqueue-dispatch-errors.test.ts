// A dispatch that throws after the pending row is written is reported, not thrown from `enqueue()`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DashboardDatabase } from '../db/database.js'
import { JobQueue } from '../queue/job-queue.js'

let db: DashboardDatabase
let queue: JobQueue

beforeEach(() => {
  db = new DashboardDatabase({ dbPath: ':memory:' })
  queue = new JobQueue({ db })
})

afterEach(() => {
  queue.stop()
  vi.restoreAllMocks()
  db.close()
})

describe('a dispatch that throws on enqueue', () => {
  it('a dispatch that throws on enqueue is reported and enqueue still returns the queued run', () => {
    queue.start(60_000)
    const pending = vi.spyOn(db, 'getPendingRuns').mockImplementationOnce(() => {
      throw new Error('enqueue dispatch probe')
    })
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})

    let runId: string | undefined
    expect(() => { runId = queue.enqueue({ name: 'Queued run' }) }).not.toThrow()

    expect(pending, 'the enqueue tried to dispatch').toHaveBeenCalledOnce()
    expect(typeof runId, 'enqueue returned the queued run').toBe('string')
    expect(db.getRun(runId!)?.status, 'the row stays queued').toBe('pending')
    expect(db.getRunArtifact(runId!)?.payload, 'the queued artifact').toMatchObject({
      runtime: { queued: true },
      source: { name: 'Queued run', loadStatus: 'queued' },
    })
    expect(reported, 'one reported line').toHaveBeenCalledOnce()
    const line = String(reported.mock.calls[0]?.[0] ?? '')
    expect(line, 'the reported line names the trigger').toContain('an enqueue')
    expect(line, 'the reported line names the error').toContain('enqueue dispatch probe')
  })
})
