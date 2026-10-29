import type { ExecutionContext } from '@vostride/agent-qa-schema'

// the execution context stays. It is a durable field on handoffs, bus
// events, deltas, bundles and run DTOs, and D-08's CI switch reads it. Only the gate's fail-closed
// reading of a context left, with the ask ladder that was its one reader.

export interface ExecutionContextSignals {
  isTty: boolean
  ciMarkers: boolean
}

export function resolveExecutionContext(
  signals: ExecutionContextSignals,
  override?: ExecutionContext,
): ExecutionContext {
  if (override !== undefined) return override
  if (signals.ciMarkers) return 'ci'
  if (signals.isTty) return 'local-interactive'
  return 'local-headless'
}

export type ExecutionContextResolver = () => ExecutionContext

let active: ExecutionContextResolver = () => 'local-headless'

export function setActiveExecutionContextResolver(resolve: ExecutionContextResolver): void {
  active = resolve
}

export function getActiveExecutionContext(): ExecutionContext {
  return active()
}
