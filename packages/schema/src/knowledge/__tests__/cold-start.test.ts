import { describe, expect, it } from 'vitest'

import { asEvidenceToken } from '../../ids/record-id'
import type { IndexEntry } from '../../reader/reader-types'
import {
  COLD_START_MAX_BUDGET_FRACTION,
  COLD_START_MAX_RECORDS,
  COLD_START_TRUST_DISCOUNT,
  applyColdStartSubCap,
  isVettedCandidate,
  type VettedCandidateInput,
} from '../index'

function candidateInput(
  overrides: Partial<VettedCandidateInput> = {},
): VettedCandidateInput {
  return {
    kind: 'fact',
    status: 'candidate',
    validityOpen: true,
    anchors: [
      { t: 'el', role: 'button', name: 'submit order', ordinal: 0 },
      { t: 'platform', platform: 'web' },
    ],
    originClass: 'agent-verified',
    evidenceIncomplete: false,
    confirmedOutcomeEvidenceTokens: [asEvidenceToken('confirmed:checkout:42')],
    withheld: false,
    needsEnrichment: false,
    memoryOffForAnchorGroup: false,
    hasUserDeprecateInLineage: false,
    ...overrides,
  }
}

describe('isVettedCandidate positive and exclusion checks', () => {
  it('admits a fact candidate satisfying every positive and exclusion check', () => {
    expect(isVettedCandidate(candidateInput())).toBe(true)
  })

  const negativeCases: ReadonlyArray<[
    name: string,
    override: Partial<VettedCandidateInput>,
  ]> = [
    ['non-candidate status', { status: 'active' }],
    ['closed validity window', { validityOpen: false }],
    ['import origin', { originClass: 'import' }],
    ['incomplete evidence', { evidenceIncomplete: true }],
    ['no confirmed outcome', { confirmedOutcomeEvidenceTokens: [] }],
    ['withheld provenance', { withheld: true }],
    ['needs-enrichment provenance', { needsEnrichment: true }],
    ['memory-off anchor group', { memoryOffForAnchorGroup: true }],
    ['user-deprecated lineage', { hasUserDeprecateInLineage: true }],
    ['procedure kind', { kind: 'procedure' }],
  ]

  it.each(negativeCases)('rejects %s', (_name, override) => {
    expect(isVettedCandidate(candidateInput(override))).toBe(false)
  })

  it('keeps locked hard exclusions primal regardless of a record trust score', () => {
    const highestTrustWithheld = {
      ...candidateInput({ withheld: true }),
      trust: Number.POSITIVE_INFINITY,
    }

    expect(isVettedCandidate(highestTrustWithheld)).toBe(false)
  })
})

describe('applyColdStartSubCap locked walls', () => {
  it('selects at most two records even under a generous token budget', () => {
    const ranked = Array.from({ length: 5 }, (_, index) => ({
      id: `candidate-${index}`,
      tokenEstimate: 1,
    }))

    expect(applyColdStartSubCap(ranked, 1_000)).toEqual(ranked.slice(0, 2))
  })

  it('keeps the largest budget-fitting prefix in caller-provided trust order', () => {
    const firstOrder = [
      { id: 'higher-discounted-trust', tokenEstimate: 12 },
      { id: 'lower-discounted-trust', tokenEstimate: 9 },
    ]
    const secondOrder = [...firstOrder].reverse()

    expect(applyColdStartSubCap(firstOrder, 100)).toEqual([firstOrder[0]])
    expect(applyColdStartSubCap(secondOrder, 100)).toEqual([secondOrder[0]])
  })

  it('exports the locked cap values and provisional trust discount', () => {
    expect(COLD_START_MAX_RECORDS).toBe(2)
    expect(COLD_START_MAX_BUDGET_FRACTION).toBe(0.2)
    expect(COLD_START_TRUST_DISCOUNT).toBe(0.5)
  })
})

describe('cold-start serving annotations', () => {
  it('types the unconfirmedSinceOrdinal and unverified annotations without making them mandatory', () => {
    const annotations: Pick<IndexEntry, 'unconfirmedSinceOrdinal' | 'unverified'> = {
      unconfirmedSinceOrdinal: 42,
      unverified: true,
    }

    expect(annotations).toEqual({ unconfirmedSinceOrdinal: 42, unverified: true })
  })
})
