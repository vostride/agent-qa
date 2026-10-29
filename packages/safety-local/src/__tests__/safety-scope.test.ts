import { describe, expect, it } from 'vitest'

import { getActiveExecutionContext } from '@vostride/agent-qa-safety'

import * as surface from '../index'
import { detectExecutionContext } from '../execution-context-detector'
import { runSafetyScope } from '../safety-scope'

// 2026-10-15 (441-33, D-12): the scope carries no masking member, so each cell below keeps its
// title and asserts the execution context only.
describe('runSafetyScope', () => {
  it('resolves the full bundle inside the scope, across awaits (Test 1)', async () => {
    await runSafetyScope({ executionContext: 'cloud' }, async () => {
      expect(getActiveExecutionContext()).toBe('cloud')

      await Promise.resolve()

      expect(getActiveExecutionContext()).toBe('cloud')
    })
  })

  it('falls back outside any scope: masking undefined, ctx=detector, sink=memoized default (Test 2)', () => {
    expect(getActiveExecutionContext()).toBe(detectExecutionContext())
  })

  it('restores the outer bundle after an inner scope returns (Test 3)', () => {
    runSafetyScope({ executionContext: 'ci' }, () => {
      expect(getActiveExecutionContext()).toBe('ci')

      runSafetyScope({ executionContext: 'cloud' }, () => {
        expect(getActiveExecutionContext()).toBe('cloud')
      })

      expect(getActiveExecutionContext()).toBe('ci')
    })

    expect(getActiveExecutionContext()).toBe(detectExecutionContext())
  })

  it('returns fn() result, including resolved async values (Test 4)', async () => {
    const sync = runSafetyScope({}, () => 42)
    expect(sync).toBe(42)

    const asyncValue = await runSafetyScope({}, async () => {
      await Promise.resolve()
      return 'done'
    })
    expect(asyncValue).toBe('done')
  })

  it('keeps interleaved sibling scopes isolated across concurrent runs (Test 6)', async () => {
    await Promise.all([
      runSafetyScope({ executionContext: 'ci' }, async () => {
        expect(getActiveExecutionContext()).toBe('ci')
        await Promise.resolve()
        expect(getActiveExecutionContext()).toBe('ci')
      }),
      runSafetyScope({ executionContext: 'cloud' }, async () => {
        expect(getActiveExecutionContext()).toBe('cloud')
        await Promise.resolve()
        expect(getActiveExecutionContext()).toBe('cloud')
      }),
    ])

    expect(getActiveExecutionContext()).toBe(detectExecutionContext())
  })

  it('is exported from the safety-local barrel (reachability)', () => {
    expect(surface.runSafetyScope).toBe(runSafetyScope)
  })

  // 2026-10-15 (441-44, D-15): moved from the deleted jsonl-audit-sink.test.ts with the sink class
  // gone from the roster. 2026-10-15 (441-33, D-12): the ambient masking resolver left the roster.
  it('exports only the fingerprint helper, masking scope binding and its ambient resolver, and execution-context detector', () => {
    expect(Object.keys(surface).sort()).toEqual([
      'detectExecutionContext',
      'fingerprint',
      'runSafetyScope',
    ])
  })
})
