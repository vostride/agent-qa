import { describe, it, expect } from 'vitest'
import { estimateTokens } from '../token-budget.js'
import { PlannerConfigSchema, NamedLLMConfigSchema } from '../../schema/config-schema.js'

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('returns ceil(length / 4) for known string', () => {
    expect(estimateTokens('hello')).toBe(2) // ceil(5/4) = 2
    expect(estimateTokens('abcd')).toBe(1) // ceil(4/4) = 1
    expect(estimateTokens('abcdefgh')).toBe(2) // ceil(8/4) = 2
    expect(estimateTokens('a')).toBe(1) // ceil(1/4) = 1
  })
})

describe('PlannerConfigSchema', () => {
  const fullConfig = {
    maxSubActions: 10,
    previousStepCount: 5,
  }

  it('parses with all fields explicitly provided', () => {
    const result = PlannerConfigSchema.parse(fullConfig)

    expect(result.maxSubActions).toBe(10)
    expect(result.previousStepCount).toBe(5)
  })

  it('rejects missing previousStepCount', () => {
    const { previousStepCount, ...withoutPSC } = fullConfig
    const result = PlannerConfigSchema.safeParse(withoutPSC)
    expect(result.success).toBe(false)
  })

  it('rejects missing maxSubActions', () => {
    const { maxSubActions, ...withoutMSA } = fullConfig
    const result = PlannerConfigSchema.safeParse(withoutMSA)
    expect(result.success).toBe(false)
  })
})

describe('NamedLLMConfigSchema — contextWindow', () => {
  it('accepts contextWindow as optional size string', () => {
    const result = NamedLLMConfigSchema.parse({
      name: 'test-model',
      provider: 'anthropic-subscription',
      model: 'claude-sonnet-4-20250514',
      contextWindow: '128kb',
    })
    expect(result.contextWindow).toBe(131072)
  })

  it('allows omitting contextWindow', () => {
    const result = NamedLLMConfigSchema.parse({
      name: 'test-model',
      provider: 'anthropic-subscription',
      model: 'claude-sonnet-4-20250514',
    })
    expect(result.contextWindow).toBeUndefined()
  })
})
