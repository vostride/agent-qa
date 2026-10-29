import { randomUUID } from 'node:crypto'
import { LOG_LEVEL_PRIORITY } from './types.js'
import type { LogLevel, LogSource, LogEntry, LogStorage, ScopedLogger } from './types.js'
import { formatLogEntry } from './cli-formatter.js'
import { guardJsonText, printRunText, type RunTextEnv } from './run-text-output.js'
import { redactSecretValue, type SecretRedactor } from '@vostride/agent-qa-runner'

/**
 * One member's run-id binding, held in async context rather than on the manager.
 *
 * `pending` is that member's own not-yet-attributed entries — the lines it wrote before it minted
 * its run id. Only these are backfilled by its `setRunId`, so a sibling can never adopt them.
 */
export interface MemberLogScope {
  runId: string
  readonly pending: LogEntry[]
}

/**
 * The host's async-context primitive, named STRUCTURALLY so this package never imports
 * `node:async_hooks`.
 *
 * `packages/core`'s host baseline is a regenerable DEBT record with a per-area clearance map — a
 * list that is meant to shrink — so a new host import here would be new debt, not a permission.
 * The composition root already owns every other reach into the world, so it owns this one too and
 * injects it. `node:async_hooks`'s `AsyncLocalStorage<MemberLogScope>` satisfies this exactly, with
 * no adapter.
 */
export interface AsyncScopeStore<T> {
  getStore(): T | undefined
  run<R>(store: T, fn: () => R): R
}

/** Thrown when a caller asks for member isolation the composition root never wired up. */
export class MemberLogScopeUnavailableError extends Error {
  constructor() {
    super(
      'LogManager.runInMemberScope requires a memberScope store. Construct the manager with ' +
        '`memberScope: new AsyncLocalStorage()` — without it, concurrent members would silently ' +
        'share one run id (WINDOWS #233).',
    )
    this.name = 'MemberLogScopeUnavailableError'
  }
}

export class LogManager {
  private buffer: LogEntry[] = []
  private currentStepId: string | null = null
  private runId: string
  private runIdSet = false
  private readonly displayLevel: LogLevel
  private readonly storage?: LogStorage
  private readonly ndjson: boolean
  private redactor?: SecretRedactor
  private readonly memberScope?: AsyncScopeStore<MemberLogScope>
  private readonly env?: RunTextEnv

  constructor(opts: {
    runId?: string
    displayLevel: LogLevel
    storage?: LogStorage
    ndjson?: boolean
    redactor?: SecretRedactor
    memberScope?: AsyncScopeStore<MemberLogScope>
    env?: RunTextEnv
  }) {
    this.runId = opts.runId ?? ''
    this.runIdSet = !!opts.runId
    this.displayLevel = opts.displayLevel
    this.storage = opts.storage
    this.ndjson = opts.ndjson ?? false
    this.redactor = opts.redactor
    this.memberScope = opts.memberScope
    this.env = opts.env
  }

  setRedactor(redactor: SecretRedactor | undefined): void {
    this.redactor = redactor
  }

  /**
   * Run `fn` with its own run-id binding, so concurrent members cannot overwrite each other.
   *
   * ONE `LogManager` SERVES EVERY MEMBER of a run — `commands/run.ts` builds it once, outside the
   * per-member closure — and since 402-02/402-03 the direct path runs members concurrently. Without
   * a scope, `setRunId` is a single mutable field plus a whole-buffer backfill, so the LAST member
   * to mint an id claims every line in the buffer, its siblings' included (measured, not inferred).
   *
   * Outside a scope nothing changes: `setRunId` keeps its original whole-buffer behaviour, which is
   * what the sequential path and the run-level `onRunCreated` stamp rely on.
   */
  runInMemberScope<T>(fn: () => T): T {
    if (!this.memberScope) throw new MemberLogScopeUnavailableError()
    return this.memberScope.run({ runId: this.runId, pending: [] }, fn)
  }

  log(
    level: Exclude<LogLevel, 'silent'>,
    source: LogSource,
    message: string,
    data?: Record<string, unknown>,
  ): void {
    const scope = this.memberScope?.getStore()
    const entry: LogEntry = {
      id: randomUUID(),
      stepId: this.currentStepId,
      runId: scope ? scope.runId : this.runId,
      level,
      source,
      message: redactSecretValue(message, this.redactor),
      data: redactSecretValue(data ?? {}, this.redactor),
      timestamp: new Date().toISOString(),
    }
    this.buffer.push(entry)
    if (scope && !entry.runId) scope.pending.push(entry)

    if (this.shouldDisplay(level)) {
      printRunText(
        formatLogEntry(entry),
        (line) => {
          process.stderr.write(`${line}\n`)
        },
        { env: this.env },
      )
    }

    if (this.ndjson) {
      this.emitNdjson(entry)
    }
  }

  private shouldDisplay(entryLevel: Exclude<LogLevel, 'silent'>): boolean {
    if (this.displayLevel === 'silent') return false
    return LOG_LEVEL_PRIORITY[entryLevel] <= LOG_LEVEL_PRIORITY[this.displayLevel]
  }

  /**
   * The SECOND writer on the `AGENT_QA_EVENT:` stdout channel — the first is the CLI's
   * `reporters/wire-reporter.ts`, which prints run-event envelopes on the same prefix. Both are
   * armed by `AGENT_QA_LIVE_EVENTS=true` (this one indirectly: `commands/run.ts` passes
   * `ndjson: process.env.AGENT_QA_LIVE_EVENTS === 'true'`), both are off by default, and nothing in
   * the product sets that variable. Entries are already redacted above, and are printed verbatim.
   * A supported opt-in; the user-facing contract for both writers is the CLI README's
   * "Live events on stdout (opt-in)". Do not change this line shape without mirroring it there.
   */
  private emitNdjson(entry: LogEntry): void {
    process.stdout.write(
      `AGENT_QA_EVENT:${guardJsonText(JSON.stringify({ type: 'log', ...entry }), this.env)}\n`,
    )
  }

  setCurrentStep(stepId: string): void {
    this.currentStepId = stepId
  }

  clearCurrentStep(): void {
    this.currentStepId = null
  }

  setRunId(runId: string): void {
    const scope = this.memberScope?.getStore()
    if (scope) {
      scope.runId = runId
      // This member's OWN pre-mint lines only. A sibling's unattributed lines live in ITS scope.
      for (const entry of scope.pending) entry.runId = runId
      scope.pending.length = 0
      // The flush gate is a manager-level fact: a scoped stamp is still a real run id, and without
      // this a fully-attributed concurrent run would be silently discarded at flush().
      this.runIdSet = true
      return
    }
    this.runId = runId
    this.runIdSet = true
    for (const entry of this.buffer) {
      entry.runId = runId
    }
  }

  flush(): void {
    if (this.storage && this.buffer.length > 0) {
      if (!this.runIdSet) {
        this.buffer = []
        return
      }
      this.storage.insertLogs(this.buffer)
    }
    this.buffer = []
  }

  getBuffer(): LogEntry[] {
    return [...this.buffer]
  }

  createScopedLogger(source: LogSource): ScopedLogger {
    return {
      debug: (msg: string, data?: Record<string, unknown>) =>
        this.log('debug', source, msg, data),
      info: (msg: string, data?: Record<string, unknown>) =>
        this.log('info', source, msg, data),
      warn: (msg: string, data?: Record<string, unknown>) =>
        this.log('warn', source, msg, data),
      error: (msg: string, data?: Record<string, unknown>) =>
        this.log('error', source, msg, data),
    }
  }
}
