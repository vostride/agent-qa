import type { RunAttributes } from '@vostride/agent-qa-core'
import type { EventEmitter } from 'node:events'

export interface ExecuteOptions {
  runId: string
  args: string[]
  source: string
  attributes?: RunAttributes
  timeout?: number
  // The Appium lease URL for a mobile run, an argument because the run happens in this process.
  appiumUrl?: string
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
