// Abort / step-timeout helpers for the runner-owned step-execution loop.
// CRITICAL: provider-neutral + storage-neutral. No node:* imports, no fs/sharp,
// no model/core/adapter package imports. Pure AbortSignal plumbing.
// Moved verbatim from core/src/agent/loop.ts:15-64; core orchestration
// (agent/runner.ts, suite/runner.ts) imports these from the runner barrel.

export type AgentAbortScope = 'test' | 'step'

export interface AgentTimeoutAbortReason {
  type: 'agent-qa-timeout'
  scope: AgentAbortScope
  timeoutMs: number
  message: string
}

// Single mint site for the timeout-abort message format. Both the reason factory
// below and the isTestTimeoutMessage matcher derive from these — the label + shape
// live in exactly one place (RESEARCH Open Q3 resolution).
const TIMEOUT_LABEL: Record<AgentAbortScope, string> = { test: 'Test', step: 'Step' }

function timeoutAbortMessage(scope: AgentAbortScope, timeoutMs: number): string {
  return `${TIMEOUT_LABEL[scope]} timed out after ${timeoutMs}ms`
}

export function createTimeoutAbortReason(scope: AgentAbortScope, timeoutMs: number): AgentTimeoutAbortReason {
  return {
    type: 'agent-qa-timeout',
    scope,
    timeoutMs,
    message: timeoutAbortMessage(scope, timeoutMs),
  }
}

// Anchored to the exact test-scope shape minted by timeoutAbortMessage('test', ms).
// Label is single-sourced from TIMEOUT_LABEL; only the numeric ms varies.
const TEST_TIMEOUT_MESSAGE_PATTERN = new RegExp(`^${TIMEOUT_LABEL.test} timed out after \\d+ms$`)

/**
 * True iff `message` is the message createTimeoutAbortReason('test', ms) mints for
 * some ms — the D-16 member-timeout signal. Rejects the 'step'-scope variant (a step
 * timeout is an ordinary failure) and any arbitrary text.
 *
 * WHY match on the message string: the AgentTimeoutAbortReason object does NOT survive
 * onto TestResult — the only trace that reaches verdict derivation is a failed step
 * whose `error` equals this minted message (RESEARCH Q3). This matcher is the one place
 * that knowledge lives, exported beside the sole mint site so the format stays
 * single-sourced.
 */
export function isTestTimeoutMessage(message: string): boolean {
  return TEST_TIMEOUT_MESSAGE_PATTERN.test(message)
}

export function getTimeoutAbortReason(signal: AbortSignal | undefined): AgentTimeoutAbortReason | undefined {
  const reason = signal?.reason
  if (!reason || typeof reason !== 'object') return undefined
  const maybeReason = reason as Partial<AgentTimeoutAbortReason>
  return maybeReason.type === 'agent-qa-timeout'
    && (maybeReason.scope === 'test' || maybeReason.scope === 'step')
    && typeof maybeReason.timeoutMs === 'number'
    && typeof maybeReason.message === 'string'
    ? maybeReason as AgentTimeoutAbortReason
    : undefined
}

export async function withAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return await promise
  if (signal.aborted) throw signal.reason ?? new Error('Operation aborted')

  let onAbort: (() => void) | undefined
  const abortPromise = new Promise<T>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('Operation aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
  })

  try {
    return await Promise.race([promise, abortPromise])
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}
