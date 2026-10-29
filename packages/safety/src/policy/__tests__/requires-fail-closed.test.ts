import type { ExecutionContext } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import * as safety from '../../index'
import * as executionContext from '../execution-context'

// The execution context is a durable field on handoffs, bus events, bundles and run DTOs.
const ALL_CONTEXTS: readonly ExecutionContext[] = ['local-interactive', 'local-headless', 'ci', 'cloud']

describe('requiresFailClosed', () => {
  it('is deleted from the module and the barrel; no context reads as fail-closed any more', () => {
    expect(Object.keys(executionContext)).not.toContain('requiresFailClosed')
    expect(Object.keys(safety)).not.toContain('requiresFailClosed')
  })
})

describe('all four execution contexts and their resolver stay', () => {
  it.each(ALL_CONTEXTS)('an explicit %s override resolves to itself', (context) => {
    expect(safety.resolveExecutionContext({ isTty: false, ciMarkers: false }, context)).toBe(context)
    expect(safety.resolveExecutionContext({ isTty: true, ciMarkers: true }, context)).toBe(context)
  })

  it('the signal table and the active resolver seam are unchanged', () => {
    expect(safety.resolveExecutionContext({ isTty: false, ciMarkers: true })).toBe('ci')
    expect(safety.resolveExecutionContext({ isTty: true, ciMarkers: false })).toBe('local-interactive')
    expect(safety.resolveExecutionContext({ isTty: false, ciMarkers: false })).toBe('local-headless')
    for (const context of ALL_CONTEXTS) {
      safety.setActiveExecutionContextResolver(() => context)
      expect(safety.getActiveExecutionContext()).toBe(context)
    }
    safety.setActiveExecutionContextResolver(() => 'local-headless')
    expect(Object.keys(executionContext).sort()).toEqual([
      'getActiveExecutionContext',
      'resolveExecutionContext',
      'setActiveExecutionContextResolver',
    ])
  })
})
