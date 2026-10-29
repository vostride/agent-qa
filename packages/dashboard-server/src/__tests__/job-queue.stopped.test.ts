// C444-STOPPED-QUEUE (444-16, D-50): a stopped queue never dispatches. The dashboard's close calls
// `jobQueue.stop()` and then `db.close()`; a run that settles afterwards frees its slot from inside
// the backend's promise chain, so a throw there surfaces as an unhandled rejection.

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
  vi.useRealTimers()
  vi.restoreAllMocks()
  try {
    db.close()
  } catch {
    // already closed by the cell
  }
})

function startOne(platform?: string): string {
  const runId = queue.enqueue({ name: 'Held run', ...(platform === undefined ? {} : { platform }) })
  queue.enqueue({ name: 'Next run' })
  queue.processNext()
  expect(db.getRun(runId)?.status, 'the first run is dispatched').toBe('running')
  expect(queue.getActiveCount(), 'one slot is taken').toBe(1)
  return runId
}

function failingPendingReads(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(db, 'getPendingRuns').mockImplementation(() => {
    throw new Error('database is not open')
  })
}

describe('C444-STOPPED-QUEUE', () => {
  it('after stop(), onSlotFreed for an active run neither reads the database nor rejects', async () => {
    const runId = startOne('android')
    queue.stop()
    db.close()
    const pending = vi.spyOn(db, 'getPendingRuns')

    await expect(Promise.resolve().then(() => queue.onSlotFreed(runId))).resolves.toBeUndefined()

    expect(pending, 'pending rows read after stop()').not.toHaveBeenCalled()
    expect(queue.getActiveCount(), 'the slot is released').toBe(0)
    expect(queue['activePlatforms'].has('android'), 'the platform is released').toBe(false)
  })

  it('a dispatch from onSlotFreed that fails is reported, never thrown', async () => {
    const runId = startOne()
    const pending = failingPendingReads()
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(Promise.resolve().then(() => queue.onSlotFreed(runId))).resolves.toBeUndefined()

    expect(pending, 'the queue tried to dispatch the next run').toHaveBeenCalled()
    expect(queue.getActiveCount(), 'the slot is released').toBe(0)
    expect(String(reported.mock.calls[0]?.[0] ?? ''), 'the reported failure').toContain('database is not open')
  })

  it('a poll whose dispatch fails is reported, never thrown', () => {
    vi.useFakeTimers()
    const pending = failingPendingReads()
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    queue.start(10)

    expect(() => vi.advanceTimersByTime(25), 'two polls').not.toThrow()

    expect(pending.mock.calls.length, 'the polls tried to dispatch').toBeGreaterThanOrEqual(2)
    expect(String(reported.mock.calls[0]?.[0] ?? ''), 'the reported failure').toContain('database is not open')
  })
})
