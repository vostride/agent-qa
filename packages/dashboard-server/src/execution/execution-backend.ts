import type { RunAttributes } from '@vostride/agent-qa-core'
import type { EventEmitter } from 'node:events'

// The host's Appium, asked only for a device here when AGENT_QA_APPIUM_URL is unset.
export interface AppiumProvider {
  acquire(platform: 'android' | 'ios'): Promise<string>
}

export interface ExecuteOptions {
  runId: string
  args: string[]
  source: string
  attributes?: RunAttributes
  timeout?: number
  // Bound to this run, so a lease it takes is released when the run settles.
  appium?: AppiumProvider
}

// The host reconciles the row, releases the Appium lease and frees the queue slot off this event.
export interface RunSettledDetails {
  // A human-readable reason when the run did not simply finish; no remedy list rides it.
  readonly reason?: string
  // The run never began; a boolean because the reconciliation does not branch on which refusal.
  readonly refusedBeforeStart?: true
  /** Diagnostic lines — a rejection's own message. The typed successor to scraped stderr. */
  readonly output: readonly string[]
}

export type RunSettledStatus = 'completed' | 'failed' | 'cancelled' | 'timeout'

export interface ExecutionBackend extends EventEmitter {
  execute(opts: ExecuteOptions): void
  kill(runId: string): boolean
  killAll(): void
  // `testName` is absent until a member starts, never filled with the run id or a placeholder.
  getActiveExecutions(): {
    runId: string
    status: string
    startedAt: string
    duration: number
    testName?: string
  }[]
}
