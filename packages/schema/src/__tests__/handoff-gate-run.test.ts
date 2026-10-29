// `gateRun` is a separate axis from `excludedFromOutcomes`; neither implies the other.
import { describe, expect, it } from 'vitest'

import { guardCompletedRunHandoff, HANDOFF_MIGRATIONS } from '../handoff/load-completed-run-handoff'
import {
  CURRENT_HANDOFF_SCHEMA_VERSION,
  type CompletedRunHandoff,
} from '../handoff/completed-run-handoff'
import { asRunId } from '../run/run-id'
import type { ScopeKey } from '../identity/scope-key'

const scope: ScopeKey = { tier: 'suite', key: 'checkout' }

function makeHandoff(): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: asRunId('run-gate-1'),
    scope,
    buildOrdinal: 4,
    executionContext: 'local-headless',
    aggregateVerdict: 'passed',
    configDigests: { suiteConfigDigest: 'suite-d', testConfigDigest: 'test-d' },
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_010_000,
    tests: [],
  }
}

describe('CompletedRunHandoff gateRun carrier, minted at v4', () => {
  it('pins the current handoff schema version at 2', () => {
    expect(CURRENT_HANDOFF_SCHEMA_VERSION).toBe(2)
  })

  it('registers no migration', () => {
    expect(Object.keys(HANDOFF_MIGRATIONS)).toEqual([])
  })

  it('admits a current-version document carrying the literal gateRun marker', () => {
    const doc = { ...makeHandoff(), gateRun: true as const }

    const guarded = guardCompletedRunHandoff(doc)

    expect(guarded.gateRun).toBe(true)
  })

  it('rejects a document whose gateRun is present but not the literal true', () => {
    const withFalse = { ...makeHandoff(), gateRun: false }
    const withString = { ...makeHandoff(), gateRun: 'yes' }

    expect(() => guardCompletedRunHandoff(withFalse)).toThrow()
    expect(() => guardCompletedRunHandoff(withString)).toThrow()
  })

  it('keeps gateRun and excludedFromOutcomes independent axes', () => {
    const gateOnly = guardCompletedRunHandoff({ ...makeHandoff(), gateRun: true })
    const excludedOnly = guardCompletedRunHandoff({
      ...makeHandoff(),
      excludedFromOutcomes: true,
    })
    const both = guardCompletedRunHandoff({
      ...makeHandoff(),
      gateRun: true,
      excludedFromOutcomes: true,
    })

    expect('excludedFromOutcomes' in gateOnly).toBe(false)
    expect('gateRun' in excludedOnly).toBe(false)
    expect(both.gateRun).toBe(true)
    expect(both.excludedFromOutcomes).toBe(true)
  })
})
