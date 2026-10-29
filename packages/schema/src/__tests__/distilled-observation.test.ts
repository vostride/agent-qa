import { describe, expect, it } from 'vitest'

import {
  DISTILLED_OBSERVATION_SCHEMA_VERSION,
  distilledObservationSchema,
  guardDistilledObservation,
} from '../knowledge/distilled-observation'
import { VersionGuardError } from '../versioning/create-version-guard'

const fullObservation = {
  schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION,
  step: { naturalKey: 'submit checkout', ordinal: 3 },
  platform: 'web' as const,
  test: { id: 'checkout-happy-path' },
  procedure: { id: 'complete-checkout' },
  flow: { name: 'checkout', precedes: 'confirmation' },
  surface: { kind: 'page' as const, naturalKey: '/checkout' },
  element: { naturalKey: 'button:submit order' },
  locator: { selector: '[data-testid="submit-order"]' },
  error: { naturalKey: 'submit remained disabled' },
  observedAtOrdinal: 44,
}

describe('distilled observation disk contract', () => {
  it('parses a full edge-feeding observation', () => {
    expect(distilledObservationSchema.parse(fullObservation)).toEqual(fullObservation)
  })

  it('rejects an unresolved-platform element with the binding diagnostic', () => {
    const { platform: _platform, ...unresolved } = fullObservation
    const result = distilledObservationSchema.safeParse(unresolved)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message).join(' '))
        .toMatch(/D-09.*Pitfall 8/)
    }
  })

  it('rejects a locator without its element', () => {
    const { element: _element, ...locatorOnly } = fullObservation

    expect(distilledObservationSchema.safeParse(locatorOnly).success).toBe(false)
  })

  it.each([
    ['web', 'screen'],
    ['mobile', 'page'],
  ] as const)('rejects a %s observation on a %s surface', (platform, kind) => {
    expect(distilledObservationSchema.safeParse({
      ...fullObservation,
      platform,
      surface: { ...fullObservation.surface, kind },
    }).success).toBe(false)
  })

  it('rejects a future per-line schema version through the shared guard', () => {
    expect(() => guardDistilledObservation({
      ...fullObservation,
      schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION + 1,
    })).toThrowError(VersionGuardError)
    expect(() => guardDistilledObservation({
      ...fullObservation,
      schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION + 1,
    })).toThrow('DistilledObservation')
  })

  it('parses the minimal platform-agnostic observation', () => {
    const minimal = {
      schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION,
      step: { naturalKey: 'open checkout', ordinal: 0 },
      observedAtOrdinal: 0,
    }

    expect(guardDistilledObservation(minimal)).toEqual(minimal)
  })

  it('strictly rejects unknown fields', () => {
    expect(distilledObservationSchema.safeParse({
      ...fullObservation,
      inferredEdge: true,
    }).success).toBe(false)
  })
})
