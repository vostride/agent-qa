import { describe, it, expect } from 'vitest'
import { NullActionCache } from '../null-cache.js'
import type { ActionPlan } from '../../schema/action-schema.js'

function makePlan(overrides?: Partial<ActionPlan>): ActionPlan {
  return {
    reasoning: 'Click the button to sign in',
    action: { type: 'click', ref: 'btn-1' },
    confidence: 0.95,
    stepComplete: true,
    stepFailed: false,
    ...overrides,
  }
}

describe('NullActionCache', () => {
  const cache = new NullActionCache()

  it('get() always returns null', async () => {
    const result = await cache.get('step-abc', 'screen-123')
    expect(result).toBeNull()
  })

  it('set() is a no-op and does not throw', async () => {
    const plan = makePlan()
    await expect(cache.set('step-abc', 'screen-123', plan)).resolves.toBeUndefined()
  })

  it('invalidate() is a no-op and does not throw', async () => {
    await expect(cache.invalidate('step-abc', 'screen-123')).resolves.toBeUndefined()
  })

  it('getSubAction() always returns null', async () => {
    const result = await cache.getSubAction('step-abc', 0)
    expect(result).toBeNull()
  })

  it('setSubAction() is a no-op and does not throw', async () => {
    const plan = makePlan()
    await expect(cache.setSubAction('step-abc', 0, plan)).resolves.toBeUndefined()
  })

  it('invalidateSubActionsFrom() is a no-op and does not throw', async () => {
    await expect(cache.invalidateSubActionsFrom('step-abc', 0)).resolves.toBeUndefined()
  })

  it('accepts same parameter types as ActionCache interface', async () => {
    const plan = makePlan({ reasoning: 'Complex plan', confidence: 0.8 })

    // All methods should accept valid ActionCache parameters without error
    await cache.get('hash123', 'screen456')
    await cache.set('hash123', 'screen456', plan)
    await cache.invalidate('hash123', 'screen456')
    await cache.getSubAction('hash123', 5)
    await cache.setSubAction('hash123', 5, plan)
    await cache.invalidateSubActionsFrom('hash123', 3)
  })
})
