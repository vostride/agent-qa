// A production target is a config declaration, and the environment a corpus entry records is
// the target's declared class carried as data.
import type { CompletedRunHandoff } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'
import {
  FIXTURE_ARTIFACT_SHA,
  FIXTURE_SCREENSHOT_SHA,
  makeArtifactRefV2Handoff,
} from '../../__tests__/fixtures/handoff-fixtures'
import { extractRunCassettes } from '../../extract/extract-run'
import type { ArtifactSource } from '../../ports'
import { buildSeedingPlan } from '../seeding-plan'

function fullArtifacts(): ArtifactSource {
  const entries = new Map<string, Uint8Array>([
    [FIXTURE_SCREENSHOT_SHA, new Uint8Array([1, 2, 3])],
    [FIXTURE_ARTIFACT_SHA, new Uint8Array([4, 5])],
  ])
  return { getBlob: (sha) => entries.get(sha) }
}

function fixtureHandoff(): CompletedRunHandoff {
  return makeArtifactRefV2Handoff()
}

describe('432 production target environment in eval (D-18)', () => {
  it('C432-TARGET-ENVIRONMENT-ROUNDTRIP: the seeding plan carries a declared production class as data and omits an absent one', () => {
    const handoff = fixtureHandoff()
    const cassettes = extractRunCassettes({ handoff, artifacts: fullArtifacts() }).cassettes
    const partition = { saltHex: '0'.repeat(64), heldOutFraction: 0.9, privateFraction: 0.4 }

    const production = buildSeedingPlan({ handoff, cassettes, partition, targetEnvironment: 'production' })
    expect(production.cases.length).toBeGreaterThan(0)
    for (const planCase of production.cases) {
      expect(planCase.corpusEntry.targetEnvironment).toBe('production')
    }

    const absent = buildSeedingPlan({ handoff, cassettes, partition })
    expect(absent.cases.length).toBe(production.cases.length)
    for (const planCase of absent.cases) {
      expect(Object.keys(planCase.corpusEntry)).not.toContain('targetEnvironment')
    }
  })
})
