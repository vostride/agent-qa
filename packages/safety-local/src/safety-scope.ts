import { AsyncLocalStorage } from 'node:async_hooks'

import { setActiveExecutionContextResolver } from '@vostride/agent-qa-safety'
import type { ExecutionContext } from '@vostride/agent-qa-schema'

import { detectExecutionContext } from './execution-context-detector'

export interface SafetyScopeBundle {
  executionContext?: ExecutionContext
}

// One `AsyncLocalStorage` store gives one nesting-safe, concurrency-safe scope.
const als = new AsyncLocalStorage<SafetyScopeBundle>()

// The single install site, reached from the barrel so any import wires the scope.
setActiveExecutionContextResolver(() => als.getStore()?.executionContext ?? detectExecutionContext())

export function runSafetyScope<T>(bundle: SafetyScopeBundle, fn: () => T): T {
  return als.run(bundle, fn)
}
