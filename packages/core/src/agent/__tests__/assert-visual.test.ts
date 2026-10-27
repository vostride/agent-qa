import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import type { Action } from '@vostride/agent-qa-runner'

// Get the assert schema from the registry
import { defaultRegistry, formatAction } from '@vostride/agent-qa-runner'

function getAssertSchema(): z.ZodObject<any> {
  return defaultRegistry.getSchema('common_assertAI') as z.ZodObject<any>
}

describe('assert evidence field', () => {
  describe('schema parsing', () => {
    it('a claim alone defaults to multimodal', () => {
      const schema = getAssertSchema()
      const result = schema.safeParse({ claim: 'banner visible' })
      expect(result.success).toBe(true)
      expect(result.data).toEqual({ claim: 'banner visible', mode: 'multimodal' })
    })

    it('accepts an explicit visual mode', () => {
      const schema = getAssertSchema()
      const result = schema.safeParse({ claim: 'x', mode: 'visual' })
      expect(result.success).toBe(true)
      expect(result.data!.mode).toBe('visual')
    })

    it('rejects unknown assertion modes', () => {
      const schema = getAssertSchema()
      const result = schema.safeParse({ claim: 'x', mode: 'bogus' })
      expect(result.success).toBe(false)
    })
  })

  describe('formatAction', () => {
    // formatAction renders the assertion verbs (assertValue and assertAI) and the reportValue
    // answer channel.
    it('renders assertValue with its source, op and expected', () => {
      const action: Action = { type: 'assertValue', source: 'url', op: 'equals', expected: '42' }
      expect(formatAction(action)).toBe('assertValue url equals "42"')
    })

    it('renders assertAI with its claim and mode', () => {
      const action: Action = { type: 'assertAI', claim: 'button says Submit', mode: 'visual' }
      expect(formatAction(action)).toBe('assertAI "button says Submit" (visual)')
    })

    it('renders reportValue with its value', () => {
      const action: Action = { type: 'reportValue', value: 'title is Dashboard' }
      expect(formatAction(action)).toBe('reportValue "title is Dashboard"')
    })
  })
})
