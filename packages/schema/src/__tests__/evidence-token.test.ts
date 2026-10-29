import { describe, expect, expectTypeOf, it } from 'vitest'
import type { EvidenceToken } from '../ids/record-id'
import type { Anchor } from '../identity/anchor'
import { deriveEvidenceToken } from '../knowledge/evidence-token'

const pageAnchor = (route: string): Anchor => ({ t: 'page', route })

describe('deriveEvidenceToken', () => {
  it('derives a stable branded token from observation, normalized anchor, and ordinal', () => {
    const input = {
      attributingObservationId: 'observation-checkout-submit',
      anchor: pageAnchor('/Checkout/#receipt'),
      buildOrdinal: 42,
    }

    const first = deriveEvidenceToken(input)
    const second = deriveEvidenceToken(input)

    expect(first).toBe(second)
    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expectTypeOf(first).toEqualTypeOf<EvidenceToken>()
  })

  it('collapses cosmetic anchor variants but separates observations and builds', () => {
    const base = {
      attributingObservationId: 'observation-checkout-submit',
      anchor: pageAnchor('/Checkout/#receipt'),
      buildOrdinal: 42,
    }
    const token = deriveEvidenceToken(base)

    expect(
      deriveEvidenceToken({
        ...base,
        anchor: pageAnchor('/checkout/'),
      }),
    ).toBe(token)
    expect(
      deriveEvidenceToken({
        ...base,
        attributingObservationId: 'observation-checkout-confirmation',
      }),
    ).not.toBe(token)
    expect(
      deriveEvidenceToken({
        ...base,
        buildOrdinal: 43,
      }),
    ).not.toBe(token)
  })
})
