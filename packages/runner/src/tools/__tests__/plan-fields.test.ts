import { describe, it, expect, beforeEach } from 'vitest'
import type { z } from 'zod'
import { ToolRegistry } from '../registry.js'
import { registerAllActions } from '../actions/index.js'
import { buildTools, toolCallToActionPlan } from '../builder.js'

const ENVELOPE = { reasoning: 'act', confidence: 0.9, stepComplete: false }
const REMEMBER = [{ key: 'otp', value: '4821', kind: 'extracted-value', provenance: 'observation' }]
const PREDICATE = 'until no rows with a delete button remain'

describe('toolCallToActionPlan — remember[] + bulk-predicate round-trip', () => {
  let registry: ToolRegistry
  beforeEach(() => {
    registry = new ToolRegistry()
    registerAllActions(registry)
  })

  it('round-trips a remember array and a bulkCompletionPredicate onto the returned plan', () => {
    const result = toolCallToActionPlan('web_click', { ...ENVELOPE, ref: 'e1', remember: REMEMBER, bulkCompletionPredicate: PREDICATE }, registry) as Record<string, unknown>
    expect(result.remember).toEqual(REMEMBER)
    expect(result.bulkCompletionPredicate).toBe(PREDICATE)
  })

  it('does NOT leak the new fields into plan.action (envelope stripped, same as reasoning/stepComplete)', () => {
    const result = toolCallToActionPlan('web_click', { ...ENVELOPE, ref: 'e1', remember: REMEMBER, bulkCompletionPredicate: PREDICATE }, registry)
    expect(result.action).toEqual({ type: 'click', ref: 'e1' })
    expect(result.action).not.toHaveProperty('remember')
    expect(result.action).not.toHaveProperty('bulkCompletionPredicate')
  })

  it('rejects a remember item with an unknown kind or provenance (closed enums)', () => {
    expect(() => toolCallToActionPlan('web_click', { ...ENVELOPE, ref: 'e1', remember: [{ key: 'k', value: 'v', kind: 'bogus-kind', provenance: 'observation' }] }, registry)).toThrow()
    expect(() => toolCallToActionPlan('web_click', { ...ENVELOPE, ref: 'e1', remember: [{ key: 'k', value: 'v', kind: 'extracted-value', provenance: 'bogus-provenance' }] }, registry)).toThrow()
  })
})

describe('PLAN_FIELDS descriptors — omit guidance on optional fields', () => {
  it('both new plan-fields carry .describe() text including omit-when guidance', () => {
    const tools = buildTools(registerAll(), { platform: 'web' })
    const clickTool = tools['web_click'] as { inputSchema?: z.ZodObject<never>; parameters?: z.ZodObject<never> }
    const shape = (clickTool.inputSchema ?? clickTool.parameters)!.shape as Record<string, { description?: string }>
    expect(shape).toHaveProperty('remember')
    expect(shape).toHaveProperty('bulkCompletionPredicate')
    expect(shape.remember.description ?? '').toMatch(/omit/i)
    expect(shape.bulkCompletionPredicate.description ?? '').toMatch(/omit/i)
  })
})

describe('frozen tool catalog — plan-fields register no tools', () => {
  it('keeps 56 registered / web 33 / android 30 / ios 27', () => {
    const registry = new ToolRegistry()
    registerAllActions(registry)
    expect(registry.getAll()).toHaveLength(56)
    expect(registry.getForPlatform('web')).toHaveLength(33)
    expect(registry.getForPlatform('android')).toHaveLength(30)
    expect(registry.getForPlatform('ios')).toHaveLength(27)
  })
})

// Helper: a fresh fully-registered registry for the descriptor test above.
function registerAll(): ToolRegistry {
  const registry = new ToolRegistry()
  registerAllActions(registry)
  return registry
}
