import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '../registry.js'
import { registerAllActions } from '../actions/index.js'

function registryWithActions(): ToolRegistry {
  const registry = new ToolRegistry()
  registerAllActions(registry)
  return registry
}

describe('assertion and extraction schemas', () => {
  it('registers the new assertion and extraction tools and removes free-text assert', () => {
    const registry = registryWithActions()

    expect(registry.get('common_assert')).toBeUndefined()
    expect(registry.get('common_assertAI')?.surface).toBe('common')
    expect(registry.get('common_assertValue')?.surface).toBe('common')
    expect(registry.get('common_extractAI')?.surface).toBe('common')
  })

  it('assertAI takes a claim and a mode, and refuses consensus, video and effort', () => {
    const schema = registryWithActions().getSchema('common_assertAI')

    const claimOnly = schema.safeParse({ claim: 'cart shows 3 items' })
    expect(claimOnly.success).toBe(true)
    if (claimOnly.success) {
      expect(claimOnly.data).toEqual({ claim: 'cart shows 3 items', mode: 'multimodal' })
    }

    expect(schema.safeParse({ claim: 'cart shows 3 items', mode: 'visual' }).success).toBe(true)

    expect(schema.safeParse({ claim: 'cart shows 3 items', consensus: 3 }).success).toBe(false)
    expect(schema.safeParse({ claim: 'cart shows 3 items', video: true }).success).toBe(false)
    expect(schema.safeParse({ claim: 'cart shows 3 items', effort: 'high' }).success).toBe(false)

    expect(schema.safeParse({
      claim: 'cart shows 3 items',
      unknown: true,
    }).success).toBe(false)
  })

  it('validates deterministic assertValue source, expr, and op shapes', () => {
    const schema = registryWithActions().getSchema('common_assertValue')

    expect(schema.safeParse({
      source: 'url',
      op: 'contains',
      expected: '/checkout',
    }).success).toBe(true)

    expect(schema.safeParse({
      expr: 'window.cartCount',
      op: 'isDefined',
    }).success).toBe(true)

    expect(schema.safeParse({
      source: 'url',
      op: 'startsWith',
      expected: '/checkout',
    }).success).toBe(false)
  })

  it('validates extractAI typed field-list schema and rejects nested arrays', () => {
    const schema = registryWithActions().getSchema('common_extractAI')

    expect(schema.safeParse({
      query: 'list the line items',
      schema: [{
        name: 'items',
        type: 'array',
        description: 'item names',
        item: { type: 'string' },
      }],
      scope: 'run',
    }).success).toBe(true)

    expect(schema.safeParse({
      query: 'list the line items',
      schema: [{
        name: 'items',
        type: 'array',
        description: 'item groups',
        item: { type: 'array' },
      }],
    }).success).toBe(false)

    expect(schema.safeParse({
      query: 'list the line items',
      schema: [{
        name: 'items',
        type: 'array',
        description: 'item names',
        item: { type: 'string', extra: 'not allowed' },
      }],
    }).success).toBe(false)
  })
})
