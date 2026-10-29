import type { ExecutionContext } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import * as safety from '../../index'
import * as executionContext from '../execution-context'

// RE-SPELLED 2026-10-01 (432-19, D-15). This file pinned `requiresFailClosed`, the gate's reading of
// a context (fail closed everywhere but `local-interactive`). It is deleted with the ask ladder that
// was its one reader. The execution context ITSELF is retained: it is a durable field on handoffs,
// bus events, deltas, bundles and run DTOs, and D-08's CI switch reads it.
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
