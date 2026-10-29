import { describe, expect, it } from 'vitest'

import type { RunId, ScopeKey } from '@vostride/agent-qa-schema'
import {
  CURRENT_HANDOFF_SCHEMA_VERSION,
  guardCompletedRunHandoff,
} from '@vostride/agent-qa-schema'
import type { RunConfig, RunMemberDescriptor } from '../ports.js'
import type { TestResult } from '../../result.js'
import { assembleHandoff } from '../handoff-assembly.js'

// Phase 384 plan 02, D-10: `gateRun` threads run config -> assembled handoff exactly like
// the shipped `excludedFromOutcomes` marker — literal true is copied, absence stays absent
// in the persisted JSON (the D-01 presence rule). The two markers are distinct axes
// (RESEARCH Pitfall 5): a gate run is not an outcome-excluded run.

const scope: ScopeKey = { tier: 'suite', key: 'checkout' }
const member: RunMemberDescriptor = {
  testId: 'checkout-guest-1',
  name: 'Guest checkout with promo',
  filePath: 'checkout.spec.yaml',
}

function passingResult(): TestResult {
  return {
    name: 'checkout',
    filePath: 'checkout.spec.yaml',
    status: 'passed',
    duration: 1,
    steps: [],
  }
}

const baseConfig = {
  runId: 'run-ordinary' as RunId,
  scope,
  executionContext: 'local-headless',
  configDigests: { suiteConfigDigest: 'suite-d', testConfigDigest: 'test-d' },
  buildOrdinal: 7,
  members: [member],
  executor: async () => passingResult(),
} satisfies RunConfig

describe('gateRun threading run config -> handoff', () => {
  it('copies the literal marker onto the assembled handoff when the run config opts in', () => {
    const config = {
      ...baseConfig,
      runId: 'run-gate' as RunId,
      gateRun: true,
    } satisfies RunConfig

    const handoff = assembleHandoff(config, [], 'passed', { startedAt: 1, endedAt: 2 })

    expect(handoff.gateRun).toBe(true)
    expect(JSON.parse(JSON.stringify(handoff))).toHaveProperty('gateRun', true)
  })

  it('leaves the gateRun key ABSENT for an ordinary run, in the object and in JSON', () => {
    const handoff = assembleHandoff(baseConfig, [], 'passed', { startedAt: 1, endedAt: 2 })

    expect('gateRun' in handoff).toBe(false)
    expect(JSON.stringify(handoff)).not.toContain('gateRun')
  })

  it('keeps gateRun independent of the shipped excludedFromOutcomes marker', () => {
    const gateOnly = assembleHandoff(
      { ...baseConfig, runId: 'run-gate-only' as RunId, gateRun: true } satisfies RunConfig,
      [],
      'passed',
      { startedAt: 1, endedAt: 2 },
    )
    const excludedOnly = assembleHandoff(
      {
        ...baseConfig,
        runId: 'run-excluded-only' as RunId,
        excludedFromOutcomes: true,
      } satisfies RunConfig,
      [],
      'passed',
      { startedAt: 1, endedAt: 2 },
    )

    expect('excludedFromOutcomes' in gateOnly).toBe(false)
    expect('gateRun' in excludedOnly).toBe(false)
  })

  it('round-trips a gate-run handoff through the one load-boundary guard', () => {
    const config = {
      ...baseConfig,
      runId: 'run-gate-roundtrip' as RunId,
      gateRun: true,
    } satisfies RunConfig

    const handoff = assembleHandoff(config, [], 'passed', { startedAt: 1, endedAt: 2 })
    const reloaded = guardCompletedRunHandoff(JSON.parse(JSON.stringify(handoff)))

    expect(reloaded.gateRun).toBe(true)
    // The claim this case is FOR is that what the runner writes is what the guard accepts:
    // the stamp survives the JSON round-trip and the guard's migration walk unrewritten.
    // 387-02 replaced a hardcoded `4` here — the exact number belongs to the schema
    // package, which pins it and the migration-key set by exact equality. Restating it in
    // the runner only re-broke this case on every bump while asserting nothing the schema
    // suite did not already assert more precisely.
    expect(handoff.schemaVersion).toBe(CURRENT_HANDOFF_SCHEMA_VERSION)
    expect(reloaded.schemaVersion).toBe(CURRENT_HANDOFF_SCHEMA_VERSION)
  })

  it('stamps a version the load-boundary guard accepts, whatever the current version is', () => {
    // The failure this actually guards: the runner writing a version the guard refuses.
    // Stamps 3 to 7 read as current, so 8 is the first stamp above current the guard refuses.
    const handoff = assembleHandoff(baseConfig, [], 'passed', { startedAt: 1, endedAt: 2 })
    const persisted = JSON.parse(JSON.stringify(handoff)) as Record<string, unknown>

    expect(() => guardCompletedRunHandoff(persisted)).not.toThrow()
    expect(() =>
      guardCompletedRunHandoff({
        ...persisted,
        schemaVersion: 8,
      }),
    ).toThrow()
  })
})
