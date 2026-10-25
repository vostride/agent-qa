import {
  asEvidenceToken,
  COLD_START_TRUST_DISCOUNT,
  type Anchor,
  type VettedCandidateInput,
} from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import {
  applyLifecycleTrustTreatments,
  rerankPrecedence,
  UNCONFIRMED_DOWNRANK_FACTOR,
  UNCONFIRMED_WINDOW_DURABLE_BUILDS,
  UNCONFIRMED_WINDOW_VOLATILE_BUILDS,
} from '../rerank.js'
import type { RerankEntry } from '../rerank.js'

const anchor: Anchor = { t: 'el', role: 'button', name: 'Submit order' }

function vettedCandidate(
  overrides: Partial<VettedCandidateInput> = {},
): VettedCandidateInput {
  return {
    kind: 'fact',
    status: 'candidate',
    validityOpen: true,
    anchors: [anchor],
    originClass: 'agent-verified',
    withheld: false,
    needsEnrichment: false,
    evidenceIncomplete: false,
    confirmedOutcomeEvidenceTokens: [asEvidenceToken('confirmed-token')],
    hasUserDeprecateInLineage: false,
    memoryOffForAnchorGroup: false,
    ...overrides,
  }
}

function entry(
  bundleId: string,
  overrides: Partial<RerankEntry> = {},
): RerankEntry {
  return {
    bundleId,
    validityClass: 'current',
    trust: 1,
    scope: { tier: 'test', key: 'test:checkout' },
    recencyOrdinal: 16,
    createdAtOrdinal: 10,
    originClass: 'agent',
    anchors: [anchor],
    subtype: 'selector',
    lastConfirmedOrdinal: 10,
    ...overrides,
  }
}

describe('read-side lifecycle trust treatments', () => {
  it('dampens a durable fact at the exact window without crossing the validity wall', () => {
    const asOfBuild = 15
    const treated = applyLifecycleTrustTreatments([
      entry('r_stale', {
        lastConfirmedOrdinal: asOfBuild - UNCONFIRMED_WINDOW_DURABLE_BUILDS,
      }),
      entry('r_recent', { trust: 0.8, lastConfirmedOrdinal: asOfBuild }),
      entry('r_prior', {
        validityClass: 'priorBuildHypothesis',
        trust: 100,
        lastConfirmedOrdinal: asOfBuild,
      }),
    ], asOfBuild)

    expect(treated.find(({ bundleId }) => bundleId === 'r_stale')).toMatchObject({
      trust: UNCONFIRMED_DOWNRANK_FACTOR,
      unconfirmedSinceOrdinal: asOfBuild - UNCONFIRMED_WINDOW_DURABLE_BUILDS,
    })
    expect(treated.map(({ bundleId }) => bundleId)).toEqual([
      'r_stale',
      'r_recent',
      'r_prior',
    ])
    expect(rerankPrecedence(treated).map(({ bundleId }) => bundleId)).toEqual([
      'r_recent',
      'r_stale',
      'r_prior',
    ])
  })

  it('leaves a durable fact unchanged one build below the window', () => {
    const asOfBuild = 14
    const [treated] = applyLifecycleTrustTreatments([
      entry('r_durable', {
        lastConfirmedOrdinal:
          asOfBuild - UNCONFIRMED_WINDOW_DURABLE_BUILDS + 1,
      }),
    ], asOfBuild)

    expect(treated).toMatchObject({ trust: 1 })
    expect(treated).not.toHaveProperty('unconfirmedSinceOrdinal')
    expect(treated).not.toHaveProperty('unverified')
  })

  it('dampens a volatile fact at the exact shorter window', () => {
    const asOfBuild = 15
    const [treated] = applyLifecycleTrustTreatments([
      entry('r_measurement', {
        subtype: 'measurement',
        lastConfirmedOrdinal: asOfBuild - UNCONFIRMED_WINDOW_VOLATILE_BUILDS,
      }),
    ], asOfBuild)

    expect(treated).toMatchObject({
      trust: UNCONFIRMED_DOWNRANK_FACTOR,
      unconfirmedSinceOrdinal: asOfBuild - UNCONFIRMED_WINDOW_VOLATILE_BUILDS,
    })
  })

  it('leaves a volatile fact unchanged one build below its shorter window', () => {
    const asOfBuild = 14
    const [treated] = applyLifecycleTrustTreatments([
      entry('r_measurement', {
        subtype: 'measurement',
        lastConfirmedOrdinal:
          asOfBuild - UNCONFIRMED_WINDOW_VOLATILE_BUILDS + 1,
      }),
    ], asOfBuild)

    expect(treated).toMatchObject({ trust: 1 })
    expect(treated).not.toHaveProperty('unconfirmedSinceOrdinal')
    expect(treated).not.toHaveProperty('unverified')
  })

  it('exempts sovereign user records at and beyond both decay windows', () => {
    const asOfBuild = 15
    const treated = applyLifecycleTrustTreatments([
      entry('r_user_durable', {
        originClass: 'user',
        lastConfirmedOrdinal: asOfBuild - UNCONFIRMED_WINDOW_DURABLE_BUILDS,
      }),
      entry('r_user_measurement', {
        originClass: 'user',
        subtype: 'measurement',
        lastConfirmedOrdinal:
          asOfBuild - UNCONFIRMED_WINDOW_VOLATILE_BUILDS - 1,
      }),
    ], asOfBuild)

    expect(treated).toHaveLength(2)
    for (const userEntry of treated) {
      expect(userEntry).toMatchObject({ trust: 1 })
      expect(userEntry).not.toHaveProperty('unconfirmedSinceOrdinal')
      expect(userEntry).not.toHaveProperty('unverified')
    }
  })

  it('keeps a dampened current fact ahead of a greater-trust worse-validity fact', () => {
    const asOfBuild = 16
    const treated = applyLifecycleTrustTreatments([
      entry('r_stale', {
        lastConfirmedOrdinal: asOfBuild - UNCONFIRMED_WINDOW_DURABLE_BUILDS,
      }),
      entry('r_prior', {
        validityClass: 'priorBuildHypothesis',
        trust: 100,
        lastConfirmedOrdinal: asOfBuild,
      }),
    ], asOfBuild)

    expect(treated).toHaveLength(2)
    expect(treated[0]).toMatchObject({
      bundleId: 'r_stale',
      trust: UNCONFIRMED_DOWNRANK_FACTOR,
      unconfirmedSinceOrdinal: asOfBuild - UNCONFIRMED_WINDOW_DURABLE_BUILDS,
    })
    expect(rerankPrecedence(treated).map(({ bundleId }) => bundleId)).toEqual([
      'r_stale',
      'r_prior',
    ])
  })

  it('discounts only candidates admitted by the canonical vetted predicate', () => {
    const treated = applyLifecycleTrustTreatments([
      entry('r_candidate', {
        lastConfirmedOrdinal: 16,
        vettedCandidateInput: vettedCandidate(),
      }),
      entry('r_active', { lastConfirmedOrdinal: 16 }),
    ], 16)

    expect(treated[0]).toMatchObject({
      trust: COLD_START_TRUST_DISCOUNT,
      unverified: true,
    })
    expect(rerankPrecedence(treated).map(({ bundleId }) => bundleId)).toEqual([
      'r_active',
      'r_candidate',
    ])
  })
})
