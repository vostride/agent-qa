import { EventEmitter } from 'node:events'
import { cpus } from 'node:os'
import { printRunText } from '@vostride/agent-qa-core'
import type { RunAttributes } from '@vostride/agent-qa-core'
import type { RunArtifactKind } from '@vostride/agent-qa-schema'
import type { DashboardDatabase, RunRow } from '../db/database.js'
import { classifyRunOwner, orphanSummary, ownedElsewhere } from '../db/run-owner.js'

interface EnqueueOptions {
  name: string
  filePath?: string
  kind?: RunArtifactKind
  attributes?: RunAttributes
  priority?: number
  platform?: string
  testFileContent?: string
  modelName?: string
  llmProvider?: string
  metadata?: Record<string, unknown>
  parallel?: boolean
}

export type RunCancelOutcome =
  | { kind: 'cancelled' }
  | { kind: 'stop-requested' }
  | { kind: 'not-stoppable-here' }
  | { kind: 'finished'; status: string }
  | { kind: 'orphan-finalized'; message: string }
  | { kind: 'owned-elsewhere'; message: string; ownerPid: number }
  | { kind: 'not-cancellable' }

const NOT_CANCELLABLE: RunCancelOutcome = { kind: 'not-cancellable' }

export class JobQueue extends EventEmitter {
  private db: DashboardDatabase
  private pollInterval: ReturnType<typeof setInterval> | null = null
  private isProcessing = false
  private concurrency: number
  private activeCount = 0
  private activePlatforms = new Set<string>()
  private activeRuns = new Map<string, { platform: string }>()
  private requestStop: ((runId: string) => boolean) | undefined
  private stopped = false

  constructor(opts: {
    db: DashboardDatabase
    concurrency?: number
    requestStop?: (runId: string) => boolean
  }) {
    super()
    this.db = opts.db
    this.concurrency = opts.concurrency ?? cpus().length
    this.requestStop = opts.requestStop
  }

  start(intervalMs = 1000): void {
    this.stopped = false
    this.pollInterval = setInterval(() => this.dispatchReported('a poll'), intervalMs)
    // 2026-10-18 (444-27, D-62 IN-06): a dispatch that fails here never escapes enqueue().
    this.on('enqueued', () => this.dispatchReported('an enqueue'))
  }

  // 2026-10-17 (444-16, D-50): the server closes the database after this; a run that settles later
  // still frees its slot, and nothing reads the closed database.
  stop(): void {
    this.stopped = true
    if (this.pollInterval) {
      clearInterval(this.pollInterval)
      this.pollInterval = null
    }
    this.removeAllListeners('enqueued')
  }

  enqueue(opts: EnqueueOptions): string {
    // 2026-10-01 (432-14, D-14): the belt that refused an unminted confirm scope here is deleted
    // with the run-confirm pair. A confirm scope addressed a browser's dialog; there is no dialog and
    // no reader of the key, so the queue attaches no meaning to it. The allowlist at
    // `/api/queue/enqueue` still refuses every client-supplied metadata key.
    const runId = this.db.insertPendingRun({
      name: opts.name,
      filePath: opts.filePath,
      attributes: opts.attributes,
      priority: opts.priority ?? 0,
      platform: opts.platform,
      testFileContent: opts.testFileContent,
      modelName: opts.modelName,
      llmProvider: opts.llmProvider,
      metadata: opts.metadata,
      parallel: opts.parallel,
    })
    this.db.insertRunArtifact({
      runId,
      kind: opts.kind ?? 'test',
      payload: {
        runtime: {
          platform: opts.platform ?? 'web',
          queued: true,
        },
        source: {
          name: opts.name,
          filePath: opts.filePath ?? null,
          loadStatus: 'queued',
        },
        metadata: {
          ...opts.metadata,
          attributes: opts.attributes ?? {},
        },
      },
    })
    this.emit('enqueued', runId)
    return runId
  }

  processNext(): void {
    if (this.stopped || this.isProcessing) return
    this.isProcessing = true
    try {
      while (true) {
        const next = this.findNextEligible()
        if (!next) break

        const isParallel = Boolean(next.parallel)
        const platform = next.platform ?? 'web'
        const isMobile = platform === 'ios' || platform === 'android'

        this.activeCount++
        if (isMobile) this.activePlatforms.add(platform)
        this.activeRuns.set(next.id, { platform })

        // 2026-10-17 (443-02, D-07): a row that left pending before the flip is not dispatched.
        if (!this.db.updateRunStatus(next.id, 'running')) {
          this.activeCount--
          if (isMobile) this.activePlatforms.delete(platform)
          this.activeRuns.delete(next.id)
          continue
        }
        this.db.updateRun(next.id, { startedAt: new Date().toISOString() })
        this.emit('execute', next)

        // Sequential jobs get exclusive access — stop filling slots after dequeue
        if (!isParallel && !isMobile) break
      }
    } finally {
      this.isProcessing = false
    }
  }

  onSlotFreed(runId: string): void {
    const info = this.activeRuns.get(runId)
    if (!info) return
    this.activeCount--
    if (info.platform === 'ios' || info.platform === 'android') {
      this.activePlatforms.delete(info.platform)
    }
    this.activeRuns.delete(runId)
    this.dispatchReported(`run ${runId} finished`)
  }

  private dispatchReported(trigger: string): void {
    try {
      this.processNext()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      printRunText(`Queue could not dispatch the next run after ${trigger}: ${message}`, (text) =>
        console.error(text),
      )
    }
  }

  getActiveCount(): number {
    return this.activeCount
  }

  getConcurrency(): number {
    return this.concurrency
  }

  // 2026-10-16 (442-05, D-06 to D-08): only the owner cancels a running row; gone is an orphan.
  // 442-15 (GAP-D2): own is the stamp this handle wrote, or equal non-null start times.
  // 2026-10-17 (444-06, D-11): a running row is never written here; the run answers with its verdict.
  cancel(runId: string): RunCancelOutcome {
    const run = this.db.getRun(runId)
    if (!run) return NOT_CANCELLABLE
    if (run.status === 'pending') {
      this.db.updateRun(runId, { status: 'cancelled', endedAt: new Date().toISOString() })
      this.db.finalizeRunArtifact(runId, {
        errors: [{ code: 'cancelled', phase: 'queue', message: 'Run cancelled before execution' }],
        runtime: { status: 'cancelled' },
      })
      return { kind: 'cancelled' }
    }
    if (run.status !== 'running') return { kind: 'finished', status: run.status }
    const owner = this.db.readRunOwner(runId)
    if (owner === undefined) return NOT_CANCELLABLE
    const own = this.db.isOwnStamp(runId, owner)
    switch (own ? 'self' : classifyRunOwner(owner, this.db.runOwnership)) {
      case 'self':
        return this.requestStop?.(runId) === true
          ? { kind: 'stop-requested' }
          : { kind: 'not-stoppable-here' }
      case 'gone':
        return this.db.finalizeOrphanRun(runId, owner)
          ? { kind: 'orphan-finalized', message: orphanSummary(owner.pid) }
          : this.finishedOrMissing(runId)
      case 'alive':
      case 'unknown':
        return { kind: 'owned-elsewhere', message: ownedElsewhere(owner.pid), ownerPid: owner.pid }
    }
  }

  private finishedOrMissing(runId: string): RunCancelOutcome {
    const run = this.db.getRun(runId)
    return run && run.status !== 'running' && run.status !== 'pending'
      ? { kind: 'finished', status: run.status }
      : NOT_CANCELLABLE
  }

  // 2026-08-24 (Phase 402 plan 09, D-11): THE CHILD-RUN CANCELLATION FAN-OUT IS DELETED WITH THE
  // MODEL THAT MINTED ITS CHILDREN.
  //
  // ~19 lines stood here walking the run's child rows and cancelling each member row. Under
  // the one-run model a parallel suite is ONE run row with member handles (402-04) — nothing writes
  // the run row's parent-link column any more (405-07 then deleted the column outright), so the
  // walk could only ever have read an empty list while reading as live cancellation policy.
  // Cancelling the run cancels the run.
  //
  // WHAT THIS DOES NOT TOUCH: `parallel` below. D-11 keeps the queue's parallel flag as CROSS-RUN
  // concurrency of INDEPENDENT jobs, which is what `findNextEligible` has always used it for. What
  // was deleted is parallel-SUITE semantics, not the queue's ability to run two unrelated jobs.
  //
  // HISTORICAL ROWS: a pre-402 suite run still lists its members on the read side; cancelling
  // such a run now leaves those member rows in whatever state their own process left them.

  private findNextEligible(): RunRow | undefined {
    if (this.activeCount >= this.concurrency) return undefined

    const pending = this.db.getPendingRuns()
    for (const run of pending) {
      const isParallel = Boolean(run.parallel)
      const platform = run.platform ?? 'web'
      const isMobile = platform === 'ios' || platform === 'android'

      if (isMobile) {
        // Mobile: needs a slot AND its platform not already active
        // parallel flag is ignored — mobile tests serialize per platform via device mutex
        if (this.activePlatforms.has(platform)) continue
        return run
      }

      if (!isParallel) {
        // Sequential web: needs ALL slots free (exclusive access)
        if (this.activeCount > 0) continue
        return run
      }

      // Parallel web: just needs an available slot
      return run
    }

    return undefined
  }
}
