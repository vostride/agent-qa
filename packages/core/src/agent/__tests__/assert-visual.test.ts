import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { formatAction } from '../prompts.js'
import type { Action } from '../../types/platform.js'

// Get the assert schema from the registry
import { defaultRegistry } from '../../tools/index.js'

function getAssertSchema(): z.ZodObject<any> {
  const tools = (defaultRegistry as any).tools as Map<string, any>
  const assertTool = tools.get('assert')
  return assertTool.schema
}

describe('assert visual field', () => {
  describe('schema parsing', () => {
    it('accepts visual: false', () => {
      const schema = getAssertSchema()
      const result = schema.safeParse({ condition: 'check', visual: false })
      expect(result.success).toBe(true)
      expect(result.data!.visual).toBe(false)
    })

    it('defaults visual to true when omitted', () => {
      const schema = getAssertSchema()
      const result = schema.safeParse({ condition: 'check' })
      expect(result.success).toBe(true)
      expect(result.data!.visual).toBe(true)
    })

    it('accepts visual: true explicitly', () => {
      const schema = getAssertSchema()
      const result = schema.safeParse({ condition: 'check', visual: true })
      expect(result.success).toBe(true)
      expect(result.data!.visual).toBe(true)
    })
  })

  describe('formatAction', () => {
    it('includes [non-visual] suffix when visual is false', () => {
      const action: Action = { type: 'assert', condition: '42 equals 42', visual: false }
      expect(formatAction(action)).toBe('assert "42 equals 42" [non-visual]')
    })

    it('has no suffix when visual is true', () => {
      const action: Action = { type: 'assert', condition: 'button says Submit', visual: true }
      expect(formatAction(action)).toBe('assert "button says Submit"')
    })

    it('has no suffix when visual is undefined', () => {
      const action: Action = { type: 'assert', condition: 'title is Dashboard' }
      expect(formatAction(action)).toBe('assert "title is Dashboard"')
    })
  })
})
