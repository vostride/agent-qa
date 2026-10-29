import { describe, expect, it } from 'vitest'
import {
  deriveLeafCassetteId,
  deriveProcedureCassetteId,
  deriveRunSlug,
} from '../ids'

describe('deterministic cassette ids', () => {
  it('pins the human-readable leaf and procedure id formats', () => {
    expect(
      deriveLeafCassetteId({
        runSlug: 'demo-run',
        testIndex: 0,
        stepIndex: 3,
        decisionOrdinal: 0,
      }),
    ).toBe('demo-run/test-00-step-03-d00-leaf')
    expect(deriveProcedureCassetteId({ runSlug: 'demo-run', testIndex: 1 })).toBe(
      'demo-run/test-01-procedure',
    )
  })

  it('derives one traversal-safe run slug from hostile run identity text', () => {
    expect(deriveRunSlug('run / checkout suite 42')).toBe('run---checkout-suite-42')
  })

  it('is idempotent and does not append content hashes to names', () => {
    const input = {
      runSlug: 'demo-run',
      testIndex: 12,
      stepIndex: 34,
      decisionOrdinal: 5,
    }
    const first = deriveLeafCassetteId(input)

    expect(deriveLeafCassetteId(input)).toBe(first)
    expect(first).toBe('demo-run/test-12-step-34-d05-leaf')
    expect(first).not.toMatch(/[0-9a-f]{64}/)
  })
})
