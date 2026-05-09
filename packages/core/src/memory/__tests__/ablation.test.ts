import { describe, it, expect } from 'vitest'
import { shouldAblate, collectAllInjectedIds } from '../ablation.js'
import type { MemoryProvider } from '../provider.js'

function mockProvider(injections: Record<number, string[]>): MemoryProvider {
  return {
    getInjectedObservations(stepIndex: number) {
      return injections[stepIndex] ?? []
    },
  } as MemoryProvider
}

function mockResult(status: string, stepCount: number) {
  return {
    status,
    steps: Array.from({ length: stepCount }, () => ({})),
  }
}

describe('shouldAblate', () => {
  it('returns false when result status is passed', () => {
    const provider = mockProvider({ 0: ['obs_abc'] })
    const result = mockResult('passed', 2)
    expect(shouldAblate(result, provider)).toBe(false)
  })

  it('returns false when test failed but no memory was injected at any step', () => {
    const provider = mockProvider({})
    const result = mockResult('failed', 3)
    expect(shouldAblate(result, provider)).toBe(false)
  })

  it('returns true when test failed and memory was injected at step 0', () => {
    const provider = mockProvider({ 0: ['obs_login-hint'] })
    const result = mockResult('failed', 2)
    expect(shouldAblate(result, provider)).toBe(true)
  })

  it('returns true when test failed and memory was injected at step 2 (not step 0)', () => {
    const provider = mockProvider({ 2: ['obs_checkout-tip'] })
    const result = mockResult('failed', 4)
    expect(shouldAblate(result, provider)).toBe(true)
  })
})

describe('collectAllInjectedIds', () => {
  it('returns empty map when no injections', () => {
    const provider = mockProvider({})
    const result = mockResult('failed', 3)
    const map = collectAllInjectedIds(result, provider)
    expect(map.size).toBe(0)
  })

  it('gathers IDs from all steps with injections', () => {
    const provider = mockProvider({
      0: ['obs_step0-a', 'obs_step0-b'],
      2: ['obs_step2-a'],
    })
    const result = mockResult('failed', 4)
    const map = collectAllInjectedIds(result, provider)
    expect(map.size).toBe(2)
    expect(map.get(0)).toEqual(['obs_step0-a', 'obs_step0-b'])
    expect(map.get(2)).toEqual(['obs_step2-a'])
  })

  it('skips steps with no injections', () => {
    const provider = mockProvider({ 1: ['obs_only-step1'] })
    const result = mockResult('failed', 3)
    const map = collectAllInjectedIds(result, provider)
    expect(map.size).toBe(1)
    expect(map.has(0)).toBe(false)
    expect(map.has(1)).toBe(true)
    expect(map.has(2)).toBe(false)
  })
})
