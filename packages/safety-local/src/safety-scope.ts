import { AsyncLocalStorage } from 'node:async_hooks'

import { setActiveExecutionContextResolver } from '@vostride/agent-qa-safety'
import type { ExecutionContext } from '@vostride/agent-qa-schema'

import { detectExecutionContext } from './execution-context-detector'

export interface SafetyScopeBundle {
  executionContext?: ExecutionContext
}

// exactly ONE AsyncLocalStorage store carries the run-safety bundle, feeding the active
// execution-context resolver with one nesting-safe, concurrency-safe scope.
const als = new AsyncLocalStorage<SafetyScopeBundle>()

// Single install site (Pitfall 9). Reachable from the package barrel so any import of
// @vostride/agent-qa-safety-local wires the scope.
setActiveExecutionContextResolver(() => als.getStore()?.executionContext ?? detectExecutionContext())

export function runSafetyScope<T>(bundle: SafetyScopeBundle, fn: () => T): T {
  return als.run(bundle, fn)
}
