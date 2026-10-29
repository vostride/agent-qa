// Provider- and storage-neutral: pure AbortSignal plumbing, no host or model imports.

export type AgentAbortScope = 'test' | 'step'

export interface AgentTimeoutAbortReason {
  type: 'agent-qa-timeout'
  scope: AgentAbortScope
  timeoutMs: number
  message: string
}

// The label and shape live only here; the reason factory and the matcher both derive from them.
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

// The timeout reason object never reaches TestResult; only the failed step's minted message does.
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
