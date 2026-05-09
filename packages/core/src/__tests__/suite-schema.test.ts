import { describe, it, expect } from 'vitest'
import { SuiteDefinitionSchema } from '../schema/suite-schema.js'

const VALID_TEST_ID = 't_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle'

describe('SuiteDefinitionSchema', () => {
  it('rejects YAML containing a variables: block (strict parse, Phase 181)', () => {
    const input = {
      name: 'S',
      target: 't',
      tests: [{ test: 'a.yaml', id: VALID_TEST_ID }],
      variables: { FOO: 'bar' },
    }
    const result = SuiteDefinitionSchema.safeParse(input)
    expect(result.success).toBe(false)
    if (!result.success) {
      const hasUnrecognized = result.error.issues.some(
        (i) => i.message.toLowerCase().includes('unrecognized') || i.path.includes('variables'),
      )
      expect(hasUnrecognized).toBe(true)
    }
  })

  it('accepts a minimal valid suite (no variables key)', () => {
    const input = { name: 'S', target: 't', tests: [{ test: 'a.yaml', id: VALID_TEST_ID }] }
    const result = SuiteDefinitionSchema.safeParse(input)
    expect(result.success).toBe(true)
  })
})
