import { describe, it, expect } from 'vitest'
import { idAgent } from 'id-agent'
import { isCanonicalObservationId, isObservationId, LEGACY_OBSERVATION_ID_WORDS } from '@vostride/agent-qa-ids'
import { generateObservationId } from '../observation-id.js'
import { BaseObservationSchema } from '../schema.js'

describe('generateObservationId', () => {
  it('returns string starting with obs_', () => {
    const id = generateObservationId()
    expect(id.startsWith('obs_')).toBe(true)
  })

  it('has 10 kebab-case words after prefix', () => {
    const id = generateObservationId()
    const words = id.replace('obs_', '').split('-')
    expect(words).toHaveLength(10)
    words.forEach(w => expect(w).toMatch(/^[a-z]+$/))
    expect(isCanonicalObservationId(id)).toBe(true)
  })

  it('produces unique values', () => {
    const ids = Array.from({ length: 5 }, () => generateObservationId())
    expect(new Set(ids).size).toBe(5)
  })

  it('passes BaseObservationSchema id validation', () => {
    const id = generateObservationId()
    const result = BaseObservationSchema.shape.id.safeParse(id)
    expect(result.success).toBe(true)
  })

  it('accepts legacy 6-word observation ids for read compatibility', () => {
    const legacyId = idAgent({ prefix: 'obs', words: LEGACY_OBSERVATION_ID_WORDS })
    expect(isObservationId(legacyId)).toBe(true)
    expect(BaseObservationSchema.shape.id.safeParse(legacyId).success).toBe(true)
  })
})
