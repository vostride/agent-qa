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
    // A dispatch that fails here never escapes `enqueue()`.
    this.on('enqueued', () => this.dispatchReported('an enqueue'))
  }

  // The server closes the database after this; a run settling later still frees its slot.
  stop(): void {
    this.stopped = true
    if (this.pollInterval) {
      clearInterval(this.pollInterval)
      this.pollInterval = null
    }
    this.removeAllListeners('enqueued')
  }

  enqueue(opts: EnqueueOptions): string {
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

        // A row that left pending before the flip is not dispatched.
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

  // Only the owner stops its running row, never written here; a gone owner's row is an orphan.
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

  // `parallel` is cross-run concurrency of independent jobs; a suite is one run row.

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
