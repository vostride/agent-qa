import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { cpus, tmpdir } from 'node:os'
import { join } from 'node:path'
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
      expect(result).toEqual({ kind: 'cancelled' })

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

    // The stop request a cancel sends to a running run is checked in
    // routes.run-cancel-request.test.ts.

    // the cell that stood here asserted the child-cancellation fan-out.
    // The fan-out is deleted with the model that minted its children; this is the same claim with
    // the opposite sign.
    //
    // and it no longer seeds LINKED rows, because the link is gone. The
    // 402-09 version wrote two rows carrying the cancelled run's id in a parent column, to prove
    // the cancel reached neither. That column and its reader were deleted by this plan's census —
    // an operator's historical database is refused by version now, not carried — so the claim is
    // made over two unrelated in-flight rows: a cancel reaches the run it names and nothing else.
    it('leaves every other in-flight run alone when one run is cancelled', () => {
      const asked: string[] = []
      queue.stop()
      queue = new JobQueue({
        db,
        requestStop: (runId) => {
          asked.push(runId)
          return true
        },
      })
      const parentId = queue.enqueue({ name: 'Historical Suite' })
      queue.processNext()
      const startedAt = '2026-05-02T10:00:00.000Z'
      const runningChildId = db.insertRun({
        name: 'Member 1',
        status: 'running',
        duration: 0,
        startedAt,
        endedAt: startedAt,
      })
      const pendingChildId = db.insertRun({
        name: 'Member 2',
        status: 'pending',
        duration: 0,
        startedAt,
        endedAt: startedAt,
      })
      db.insertRunArtifact({ runId: runningChildId, kind: 'test', payload: { runtime: { status: 'running' } } })
      db.insertRunArtifact({ runId: pendingChildId, kind: 'test', payload: { runtime: { status: 'pending' } } })

      expect(queue.cancel(parentId)).toEqual({ kind: 'stop-requested' })

      // The stop request reaches the run it names, which keeps its row until its own verdict...
      expect(asked).toEqual([parentId])
      expect(db.getRun(parentId)?.status).toBe('running')
      // ...and reaches nothing else. The rows are still there, unchanged and still readable.
      expect(db.getRun(runningChildId)?.status).toBe('running')
      expect(db.getRun(pendingChildId)?.status).toBe('pending')
      expect(db.getRunArtifact(runningChildId)?.finalizedAt).toBeNull()
      expect(db.getRunArtifact(pendingChildId)?.finalizedAt).toBeNull()
    })

    it('returns false for a completed run', () => {
      const runId = queue.enqueue({ name: 'Done Job' })
      queue.processNext() // transition to running
      db.updateRunStatus(runId, 'passed') // transition to completed

      const result = queue.cancel(runId)
      expect(result).toEqual({ kind: 'finished', status: 'passed' })
      expect(db.getRun(runId)?.status).toBe('passed')
    })

    it('returns false for a non-existent run', () => {
      const result = queue.cancel('non-existent-id')
      expect(result).toEqual({ kind: 'not-cancellable' })
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

// ---- G-401-18-CR01: the belt at the one writer both doors go through -------
//
// The PRIMARY control is the `/api/queue/enqueue` allowlist, which does not admit `confirmScope` as
// a client-writable key at all. Until 432-14 the queue also refused a confirm scope this server did
// not mint, because a scope named which browser a run's question was delivered to.
//
// RE-SPELLED 2026-10-01: the question, the dialog and every reader of the scope are
// deleted, so the queue attaches no meaning to the key. The belt's surviving claims are carried
// where the value could still leave or be planted: the enqueue route refuses every client-supplied
// metadata key (`routes.test.ts`), and every run-reading response strips it off a row written
// before 432-14 (`routes.runs.test.ts`). What is pinned here is that the queue no longer interprets
// it: the row is written once, whole, with no throw.

// RE-TITLED 2026-10-03 (quick-261003-tsr, IN-30): was 'JobQueue refuses a confirm scope this
// server did not mint'.
describe('JobQueue no longer interprets a retired confirm-scope key', () => {
  it('a retired confirm-scope key no longer throws: the row and its artifact are written once', () => {
    const before = db.getRuns({ limit: 100 }).length
    for (const value of ['chat-1730000000-abc', { toString: () => 'run-trigger:x' }, 'run-trigger:2f1d0f2a-6f1e-4a2b-9c3d-5e6f70819200']) {
      const runId = queue.enqueue({ name: 'retired', metadata: { ['confirm' + 'Scope']: value } })
      expect(db.getRun(runId)).toBeDefined()
      expect(db.getRunArtifact(runId)).not.toBeNull()
    }
    expect(db.getRuns({ limit: 100 })).toHaveLength(before + 3)
  })

  it('a run with no confirmScope at all is unaffected — the no-op control', () => {
    const runId = queue.enqueue({ name: 'plain', metadata: { args: ['/w/tests/plain.yaml'] } })
    expect(db.getRun(runId)?.metadata).toEqual({ args: ['/w/tests/plain.yaml'] })
  })
})

describe('the pending-to-running flip', () => {
  const SELF = { pid: 4242, incarnation: 'proc-starttime:7', host: 'h' }
  const OTHER = { pid: 5151, incarnation: 'proc-starttime:9', host: 'h' }
  const inertProbe = { isAlive: () => true, incarnationOf: () => undefined }
  let dir: string
  let own: DashboardDatabase
  let other: DashboardDatabase

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-qa-443-queue-flip-'))
    const dbPath = join(dir, 'runs.db')
    own = new DashboardDatabase({ dbPath, runOwnership: { self: SELF, probe: inertProbe } })
    other = new DashboardDatabase({ dbPath, runOwnership: { self: OTHER, probe: inertProbe } })
  })

  afterEach(() => {
    own.close()
    other.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function statusAndOwner(id: string): string {
    return JSON.stringify(own['db'].prepare(
      'SELECT status, owner_pid, owner_incarnation, owner_host FROM runs WHERE id = ?',
    ).all(id))
  }

  function flipRefusedFor(victim: string): DashboardDatabase {
    return new Proxy(own, {
      get(target, prop) {
        if (prop === 'updateRunStatus') {
          return (id: string, status: string) => {
            if (id === victim && status === 'running') other.updateRunStatus(id, 'cancelled')
            return target.updateRunStatus(id, status)
          }
        }
        const value = Reflect.get(target, prop, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }

  it('the flip moves a pending row to running and stamps it', () => {
    const id = own.insertPendingRun({ name: 'Queued' })
    expect(own.readRunOwner(id)).toBeUndefined()

    expect(own.updateRunStatus(id, 'running')).toBe(true)

    expect(own.getRun(id)?.status).toBe('running')
    expect(own.readRunOwner(id)).toEqual(SELF)
    expect(own.isOwnStamp(id, SELF)).toBe(true)
  })

  it('the flip refuses a row that is not pending', () => {
    const startedAt = '2026-10-17T00:00:00.000Z'
    const finished = { duration: 1, startedAt, endedAt: startedAt }
    const rows = [
      other.insertRun({ name: 'Owned elsewhere', status: 'running', duration: 0, startedAt, endedAt: startedAt }),
      own.insertRun({ name: 'Passed', status: 'passed', ...finished }),
      own.insertRun({ name: 'Cancelled', status: 'cancelled', ...finished }),
    ]
    for (const id of rows) {
      const before = statusAndOwner(id)
      expect(JSON.parse(before)).toHaveLength(1)

      expect(own.updateRunStatus(id, 'running')).toBe(false)

      expect(statusAndOwner(id)).toBe(before)
      expect(own.isOwnStamp(id, SELF)).toBe(false)
    }
    expect(own.readRunOwner(rows[0])).toEqual(OTHER)
  })

  it('the queue does not dispatch a row it could not flip', () => {
    const victim = own.insertPendingRun({ name: 'Cancelled before the flip' })
    const queue = new JobQueue({ db: flipRefusedFor(victim), concurrency: 2 })
    const execute = vi.fn()
    queue.on('execute', execute)

    queue.processNext()

    expect(execute).not.toHaveBeenCalled()
    expect(queue.getActiveCount()).toBe(0)
    expect(own.getRun(victim)?.status).toBe('cancelled')
    expect(own.readRunOwner(victim)).toBeUndefined()
    queue.stop()
  })

  it('the slot a refused flip reserved is free for the next row', () => {
    const victim = own.insertPendingRun({ name: 'Refused', platform: 'android', priority: 5 })
    const next = own.insertPendingRun({ name: 'Next', platform: 'android' })
    const queue = new JobQueue({ db: flipRefusedFor(victim), concurrency: 2 })
    const executed: string[] = []
    queue.on('execute', (run) => executed.push(run.id))

    queue.processNext()

    expect(executed).toEqual([next])
    expect(queue.getActiveCount()).toBe(1)
    expect(own.getRun(next)?.status).toBe('running')
    queue.onSlotFreed(victim)
    expect(queue.getActiveCount()).toBe(1)
    queue.onSlotFreed(next)
    expect(queue.getActiveCount()).toBe(0)
    queue.stop()
  })
})

describe('a queue dispatch failure under GitHub Actions', () => {
  const PAIR = /^::stop-commands::([0-9a-f]{32})\n[\s\S]*\n::\1::\n$/u

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  function failDispatch(message: string): void {
    vi.spyOn(queue, 'processNext').mockImplementation(() => {
      throw new Error(message)
    })
    queue.start(60000)
    queue.enqueue({ name: 'Dispatch fails' })
  }

  it('prints the failure inside one stop-commands pair on stdout', () => {
    vi.stubEnv('GITHUB_ACTIONS', 'true')
    const writes: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk))
      return true
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    failDispatch('::set-output name=x::y')

    const blocks = writes.filter((chunk) => chunk.includes('Queue could not dispatch'))
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatch(PAIR)
    expect(blocks[0]).toContain(
      'Queue could not dispatch the next run after an enqueue: ::set-output name=x::y',
    )
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('prints the same console.error line as before off GitHub Actions', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    failDispatch('::set-output name=x::y')

    expect(errorSpy).toHaveBeenCalledOnce()
    expect(errorSpy).toHaveBeenCalledWith(
      'Queue could not dispatch the next run after an enqueue: ::set-output name=x::y',
    )
  })
})
