import { describe, expect, it } from 'vitest'
import { idAgent } from 'id-agent'
import {
  CANONICAL_ID_WORDS,
  ENTITY_ID_TYPES,
  LEGACY_OBSERVATION_ID_WORDS,
  generateCanonicalId,
  generateHookId,
  generateObservationId,
  generateRunId,
  generateSuiteId,
  generateTestId,
  getEntityIdContract,
  getEntityIdContracts,
  isCanonicalId,
  isCanonicalHookId,
  isCanonicalObservationId,
  isCanonicalRunId,
  isCanonicalSuiteId,
  isCanonicalTestId,
  isObservationId,
} from '../persistent-id.js'

function getWordCount(id: string): number {
  return id.slice(id.indexOf('_') + 1).split('-').length
}

describe('persistent ID contract', () => {
  it('generates canonical test, suite, hook, observation, and run ids', () => {
    const cases = [
      { id: generateTestId(), prefix: 't_', validate: isCanonicalTestId },
      { id: generateSuiteId(), prefix: 's_', validate: isCanonicalSuiteId },
      { id: generateHookId(), prefix: 'h_', validate: isCanonicalHookId },
      { id: generateObservationId(), prefix: 'obs_', validate: isCanonicalObservationId },
      { id: generateRunId(), prefix: 'r_', validate: isCanonicalRunId },
    ]

    for (const testCase of cases) {
      expect(testCase.id.startsWith(testCase.prefix)).toBe(true)
      expect(getWordCount(testCase.id)).toBe(CANONICAL_ID_WORDS)
      expect(testCase.validate(testCase.id)).toBe(true)
    }
  })

  it('generates and validates IDs through the generic entity contract', () => {
    for (const type of ENTITY_ID_TYPES) {
      const id = generateCanonicalId(type)
      const contract = getEntityIdContract(type)
      expect(id.startsWith(contract.prefixWithSeparator)).toBe(true)
      expect(isCanonicalId(type, id)).toBe(true)
    }
  })

  it('exposes one ID contract per entity type', () => {
    const contracts = getEntityIdContracts()
    expect(contracts.map(contract => contract.type)).toEqual(ENTITY_ID_TYPES)
    for (const contract of contracts) {
      expect(contract.words).toBe(CANONICAL_ID_WORDS)
      expect(contract.examplePattern.startsWith(contract.prefixWithSeparator)).toBe(true)
    }
  })

  it('rejects wrong prefixes and legacy 6-word ids in canonical validators', () => {
    const legacyTestId = idAgent({ prefix: 't', words: LEGACY_OBSERVATION_ID_WORDS })
    const legacySuiteId = idAgent({ prefix: 's', words: LEGACY_OBSERVATION_ID_WORDS })
    const legacyHookId = idAgent({ prefix: 'h', words: LEGACY_OBSERVATION_ID_WORDS })
    const legacyObservationId = idAgent({ prefix: 'obs', words: LEGACY_OBSERVATION_ID_WORDS })
    const legacyRunId = idAgent({ prefix: 'r', words: LEGACY_OBSERVATION_ID_WORDS })

    expect(isCanonicalTestId(legacyTestId)).toBe(false)
    expect(isCanonicalSuiteId(legacySuiteId)).toBe(false)
    expect(isCanonicalHookId(legacyHookId)).toBe(false)
    expect(isCanonicalObservationId(legacyObservationId)).toBe(false)
    expect(isCanonicalRunId(legacyRunId)).toBe(false)

    expect(isCanonicalTestId(generateRunId())).toBe(false)
    expect(isCanonicalSuiteId(generateTestId())).toBe(false)
    expect(isCanonicalHookId(generateSuiteId())).toBe(false)
    expect(isCanonicalObservationId(generateSuiteId())).toBe(false)
    expect(isCanonicalRunId(generateObservationId())).toBe(false)
  })

  it('accepts both canonical and legacy observation ids for read compatibility', () => {
    const canonicalObservationId = generateObservationId()
    const legacyObservationId = idAgent({ prefix: 'obs', words: LEGACY_OBSERVATION_ID_WORDS })

    expect(isObservationId(canonicalObservationId)).toBe(true)
    expect(isObservationId(legacyObservationId)).toBe(true)
    expect(isObservationId(generateTestId())).toBe(false)
  })
})
