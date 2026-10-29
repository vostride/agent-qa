import { describe, expect, it } from 'vitest'
import * as api from '../../index'

describe('planner capability evidence', () => {
  it('discloses missing planner identity as degraded', () => {
    expect(api.plannerCapabilityTier?.(undefined)).toEqual({
      tier: 'degraded', evidence: { kind: 'missing' },
    })
  })

  it.each(['claude', 'gpt-4o', 'gpt-4.1', 'gpt-5', 'o1', 'o3', 'o4',
    'gemini-1.5', 'gemini-2.5', 'gemini-3'])('uses the existing boundaries for %s', (prefix) => {
    expect(api.plannerCapabilityTier).toBeTypeOf('function')
    for (const boundary of ['', '-', '.', '_', ':', '/']) {
      const modelIdentity = { provider: 'recorded-provider', modelId: ` ${prefix.toUpperCase()}${boundary}${boundary ? 'variant' : ''} ` }
      expect(api.plannerCapabilityTier(modelIdentity)).toEqual({
        tier: 'full', evidence: { kind: 'model-identity', modelIdentity },
      })
    }
    for (const modelId of [`${prefix}x`, `${prefix}0`, `proxy/${prefix}`]) {
      expect(api.plannerCapabilityTier({ provider: 'claude', modelId }).tier).toBe('degraded')
    }
  })

  it('never borrows verifier, provider or curator identity', () => {
    expect(api.plannerCapabilityTier).toBeTypeOf('function')
    const evidence = {
      provider: 'gpt-5', modelId: 'unknown', family: 'claude',
      verifierIdentity: { provider: 'provider', modelId: 'gpt-5' },
      authorship: { path: 'deterministic-fallback' },
    }
    expect(api.plannerCapabilityTier(evidence)).toEqual({
      tier: 'degraded',
      evidence: { kind: 'model-identity', modelIdentity: { provider: 'gpt-5', modelId: 'unknown' } },
    })
    expect(api.plannerCapabilityTier({ provider: 'gpt-5', modelId: '' })).toEqual({
      tier: 'degraded', evidence: { kind: 'missing' },
    })
  })

  it('uses floor only for explicitly recorded deterministic execution', () => {
    expect(api.plannerCapabilityTier).toBeTypeOf('function')
    const planner = { provider: 'provider', modelId: 'gpt-5' }
    expect(api.plannerCapabilityTier(undefined, true)).toEqual({
      tier: 'floor', evidence: { kind: 'deterministic' },
    })
    expect(api.plannerCapabilityTier(planner, true).tier).toBe('floor')
    expect(api.plannerCapabilityTier(undefined, false).tier).toBe('degraded')
    expect(api.plannerCapabilityTier(planner, false).tier).toBe('full')
  })

  it('preserves curator repair, fallback and family-precedence behavior', () => {
    expect(api.curatorTier({ executionContext: 'local-headless', path: 'llm-repaired', model: { id: 'gpt-5' } })).toBe('degraded')
    expect(api.curatorTier({ executionContext: 'local-headless', path: 'deterministic-fallback' })).toBe('floor')
    expect(api.curatorTier({ executionContext: 'local-headless', path: 'llm', model: { id: 'gpt-5', family: 'unknown' } })).toBe('degraded')
    expect(api.curatorTier({ executionContext: 'local-headless', path: 'llm', model: { id: 'unknown', family: 'claude' } })).toBe('full')
  })
})
