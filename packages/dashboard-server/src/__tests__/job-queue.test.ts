import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { cpus } from 'node:os'
import { isCanonicalRunId } from '@vostride/agent-qa-ids'
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
  db.close()
})

describe('JobQueue', () => {
  describe('enqueue', () => {
    it('creates a pending run in the database and returns a runId', () => {
      const attributes = {
        'agent-qa.trigger': 'api',
        'agent-qa.runner': 'local',
        'git.branch': 'phase223-main',
      }
      const runId = queue.enqueue({ name: 'Test Job', attributes })
      expect(runId).toBeDefined()
      expect(typeof runId).toBe('string')
      expect(isCanonicalRunId(runId)).toBe(true)

      const run = db.getRun(runId)
      expect(run).toBeDefined()
      expect(run!.status).toBe('pending')
      expect(run!.name).toBe('Test Job')
      expect(run!.id).toBe(runId)
      expect(run!.attributes).toEqual(attributes)

      const artifact = db.getRunArtifact(runId)
      expect(artifact?.kind).toBe('test')
      expect(artifact?.finalizedAt).toBeNull()
      expect(artifact?.payload.runtime).toMatchObject({ queued: true, platform: 'web' })
      expect(artifact?.payload.metadata?.attributes).toEqual(attributes)
    })

    it('passes priority to the database', () => {
      const runId = queue.enqueue({ name: 'Priority Job', priority: 5 })
      const run = db.getRun(runId)
      expect(run!.priority).toBe(5)
    })
  })

  describe('processNext', () => {
    it('picks up a pending run, transitions to running, and emits execute', () => {
      const runId = queue.enqueue({ name: 'Process Me' })
      const executeSpy = vi.fn()
      queue.on('execute', executeSpy)

      queue.processNext()

      const run = db.getRun(runId)
      expect(run!.status).toBe('running')
      expect(executeSpy).toHaveBeenCalledOnce()
      expect(executeSpy.mock.calls[0][0].id).toBe(runId)
    })

    it('skips if isProcessing is true (no double-dequeue)', () => {
      queue.enqueue({ name: 'Job 1' })
      queue.enqueue({ name: 'Job 2' })

      const executeSpy = vi.fn()
      queue.on('execute', executeSpy)

      // Simulate isProcessing by calling processNext from within an execute handler
      queue.on('execute', () => {
        queue.processNext()
      })

      queue.processNext()

      // Only one job should have been dequeued
      expect(executeSpy).toHaveBeenCalledOnce()
    })

    it('does nothing when no pending runs exist', () => {
      const executeSpy = vi.fn()
      queue.on('execute', executeSpy)

      queue.processNext()

      expect(executeSpy).not.toHaveBeenCalled()
    })
  })

  describe('priority ordering', () => {
    it('higher priority runs are dequeued before lower priority', () => {
      queue.enqueue({ name: 'Low', priority: 0 })
      queue.enqueue({ name: 'High', priority: 10 })
      queue.enqueue({ name: 'Medium', priority: 5 })

      const executeSpy = vi.fn()
      queue.on('execute', executeSpy)

      queue.processNext()
      expect(executeSpy.mock.calls[0][0].name).toBe('High')
    })

    it('same priority runs are dequeued in FIFO order', () => {
      const id1 = queue.enqueue({ name: 'First' })
      const id2 = queue.enqueue({ name: 'Second' })
      const id3 = queue.enqueue({ name: 'Third' })

      const names: string[] = []
      queue.on('execute', (run) => names.push(run.name))

      // Sequential jobs need slot freed between each
      queue.processNext()
      db.updateRunStatus(id1, 'passed')
      queue.onSlotFreed(id1)
      db.updateRunStatus(id2, 'passed')
      queue.onSlotFreed(id2)

      expect(names).toEqual(['First', 'Second', 'Third'])
    })
  })

  describe('cancel', () => {
    it('cancels a pending run and sets status to cancelled', () => {
      const runId = queue.enqueue({ name: 'Cancel Me' })
      const result = queue.cancel(runId)
      expect(result).toBe(true)

      const run = db.getRun(runId)
      expect(run!.status).toBe('cancelled')
      const artifact = db.getRunArtifact(runId)
      expect(artifact?.finalizedAt).toBeTruthy()
      expect(artifact?.payload.errors?.[0]).toMatchObject({
        code: 'cancelled',
        phase: 'queue',
        message: 'Run cancelled before execution',
      })
    })

    it('cancels a running run and emits cancel-running event', () => {
      const runId = queue.enqueue({ name: 'Running Job' })
      queue.processNext() // transition to running

      const cancelSpy = vi.fn()
      queue.on('cancel-running', cancelSpy)

      const result = queue.cancel(runId)
      expect(result).toBe(true)

      const run = db.getRun(runId)
      expect(run!.status).toBe('cancelled')
      expect(cancelSpy).toHaveBeenCalledWith(runId)
    })

    it('cancels pending and running children when a running parent is cancelled', () => {
      const parentId = queue.enqueue({ name: 'Retry Parent' })
      queue.processNext()
      const startedAt = '2026-05-02T10:00:00.000Z'
      const runningChildId = db.insertRun({
        name: 'Attempt 1',
        status: 'running',
        duration: 0,
        startedAt,
        endedAt: startedAt,
        parentRunId: parentId,
        attemptNumber: 1,
        maxRetries: 2,
      })
      const pendingChildId = db.insertRun({
        name: 'Attempt 2',
        status: 'pending',
        duration: 0,
        startedAt,
        endedAt: startedAt,
        parentRunId: parentId,
        attemptNumber: 2,
        maxRetries: 2,
      })
      db.insertRunArtifact({ runId: runningChildId, kind: 'test', payload: { runtime: { status: 'running' } } })
      db.insertRunArtifact({ runId: pendingChildId, kind: 'test', payload: { runtime: { status: 'pending' } } })

      expect(queue.cancel(parentId)).toBe(true)

      expect(db.getRun(parentId)?.status).toBe('cancelled')
      expect(db.getRun(runningChildId)?.status).toBe('cancelled')
      expect(db.getRun(pendingChildId)?.status).toBe('cancelled')
      expect(db.getRunArtifact(runningChildId)?.finalizedAt).toBeTruthy()
      expect(db.getRunArtifact(pendingChildId)?.finalizedAt).toBeTruthy()
    })

    it('returns false for a completed run', () => {
      const runId = queue.enqueue({ name: 'Done Job' })
      queue.processNext() // transition to running
      db.updateRunStatus(runId, 'passed') // transition to completed

      const result = queue.cancel(runId)
      expect(result).toBe(false)
    })

    it('returns false for a non-existent run', () => {
      const result = queue.cancel('non-existent-id')
      expect(result).toBe(false)
    })
  })

  describe('start/stop', () => {
    it('start begins polling and stop clears the interval', () => {
      vi.useFakeTimers()

      queue.enqueue({ name: 'Polled Job' })
      const executeSpy = vi.fn()
      queue.on('execute', executeSpy)

      queue.start(500)
      expect(executeSpy).not.toHaveBeenCalled()

      vi.advanceTimersByTime(500)
      expect(executeSpy).toHaveBeenCalledOnce()

      queue.stop()

      queue.enqueue({ name: 'Another Job' })
      vi.advanceTimersByTime(1000)
      // stop should have cleared the interval, so no more processing
      expect(executeSpy).toHaveBeenCalledOnce()

      vi.useRealTimers()
    })

    it('enqueued event triggers immediate processNext', () => {
      const executeSpy = vi.fn()
      queue.on('execute', executeSpy)

      queue.start(60000) // long interval so polling won't fire

      queue.enqueue({ name: 'Immediate Job' })

      expect(executeSpy).toHaveBeenCalledOnce()
      expect(executeSpy.mock.calls[0][0].name).toBe('Immediate Job')

      queue.stop()
    })
  })

  describe('concurrency', () => {
    let cQueue: JobQueue

    beforeEach(() => {
      cQueue = new JobQueue({ db, concurrency: 2 })
    })

    afterEach(() => {
      cQueue.stop()
    })

    it('default concurrency equals os.cpus().length', () => {
      const defaultQueue = new JobQueue({ db })
      expect(defaultQueue.getConcurrency()).toBe(cpus().length)
      defaultQueue.stop()
    })

    it('with concurrency=2, enqueue 3 parallel jobs — only first 2 execute', () => {
      const id1 = cQueue.enqueue({ name: 'P1', parallel: true, platform: 'web' })
      const id2 = cQueue.enqueue({ name: 'P2', parallel: true, platform: 'web' })
      const id3 = cQueue.enqueue({ name: 'P3', parallel: true, platform: 'web' })

      const executed: string[] = []
      cQueue.on('execute', (run) => executed.push(run.id))

      cQueue.processNext()

      expect(executed).toEqual([id1, id2])
      expect(executed).not.toContain(id3)
    })

    it('onSlotFreed releases slot — 3rd job executes', () => {
      const id1 = cQueue.enqueue({ name: 'P1', parallel: true, platform: 'web' })
      const id2 = cQueue.enqueue({ name: 'P2', parallel: true, platform: 'web' })
      const id3 = cQueue.enqueue({ name: 'P3', parallel: true, platform: 'web' })

      const executed: string[] = []
      cQueue.on('execute', (run) => executed.push(run.id))

      cQueue.processNext()
      expect(executed).toEqual([id1, id2])

      // Simulate first job completing
      db.updateRunStatus(id1, 'passed')
      cQueue.onSlotFreed(id1)

      expect(executed).toEqual([id1, id2, id3])
    })

    it('sequential job (parallel=false) does NOT dequeue when activeCount > 0', () => {
      cQueue.enqueue({ name: 'Parallel', parallel: true, platform: 'web' })
      cQueue.enqueue({ name: 'Sequential', parallel: false, platform: 'web' })

      const executed: string[] = []
      cQueue.on('execute', (run) => executed.push(run.name))

      cQueue.processNext()

      expect(executed).toEqual(['Parallel'])
    })

    it('sequential job dequeues when activeCount === 0 (all slots free)', () => {
      const id1 = cQueue.enqueue({ name: 'Sequential', parallel: false, platform: 'web' })

      const executed: string[] = []
      cQueue.on('execute', (run) => executed.push(run.name))

      cQueue.processNext()

      expect(executed).toEqual(['Sequential'])
    })

    it('after dequeuing a sequential job, no other jobs dequeue until it completes (exclusive access)', () => {
      const seqId = cQueue.enqueue({ name: 'Sequential', parallel: false, platform: 'web' })
      cQueue.enqueue({ name: 'Parallel', parallel: true, platform: 'web' })

      const executed: string[] = []
      cQueue.on('execute', (run) => executed.push(run.name))

      cQueue.processNext()

      // Only sequential should run — it gets exclusive access
      expect(executed).toEqual(['Sequential'])
    })

    it('mobile test (platform=ios) blocks another ios test from dequeuing (device mutex)', () => {
      const id1 = cQueue.enqueue({ name: 'iOS-1', parallel: true, platform: 'ios' })
      cQueue.enqueue({ name: 'iOS-2', parallel: true, platform: 'ios' })

      const executed: string[] = []
      cQueue.on('execute', (run) => executed.push(run.name))

      cQueue.processNext()

      // Only first iOS test should run
      expect(executed).toEqual(['iOS-1'])
    })

    it('mobile test (platform=android) does NOT block an ios test (different platform)', () => {
      // Use concurrency=3 so slots aren't the bottleneck
      const wideQueue = new JobQueue({ db, concurrency: 3 })
      const id1 = wideQueue.enqueue({ name: 'iOS', parallel: true, platform: 'ios' })
      const id2 = wideQueue.enqueue({ name: 'Android', parallel: true, platform: 'android' })

      const executed: string[] = []
      wideQueue.on('execute', (run) => executed.push(run.name))

      wideQueue.processNext()

      expect(executed).toContain('iOS')
      expect(executed).toContain('Android')
      wideQueue.stop()
    })

    it('parallel=true is ignored for mobile tests — ios/android still serialize per platform', () => {
      const id1 = cQueue.enqueue({ name: 'iOS-Parallel', parallel: true, platform: 'ios' })
      cQueue.enqueue({ name: 'iOS-Parallel-2', parallel: true, platform: 'ios' })

      const executed: string[] = []
      cQueue.on('execute', (run) => executed.push(run.name))

      cQueue.processNext()

      // Even with parallel=true, only one iOS test should run
      expect(executed).toEqual(['iOS-Parallel'])
    })

    it('processNext fills multiple available slots in one call (not just one)', () => {
      cQueue.enqueue({ name: 'A', parallel: true, platform: 'web' })
      cQueue.enqueue({ name: 'B', parallel: true, platform: 'web' })

      const executed: string[] = []
      cQueue.on('execute', (run) => executed.push(run.name))

      cQueue.processNext()

      // Both should be filled in a single processNext call
      expect(executed).toEqual(['A', 'B'])
    })

    it('getActiveCount reflects current active slot usage', () => {
      const id1 = cQueue.enqueue({ name: 'P1', parallel: true, platform: 'web' })
      cQueue.processNext()

      expect(cQueue.getActiveCount()).toBe(1)

      db.updateRunStatus(id1, 'passed')
      cQueue.onSlotFreed(id1)

      expect(cQueue.getActiveCount()).toBe(0)
    })
  })
})
