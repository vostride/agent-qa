import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ToolRegistry } from '../registry.js'
import { registerAllActions } from '../actions/index.js'

const INTERACTION_TOOL_IDS = [
  'web_click',
  'web_fill',
  'mobile_fill',
  'web_select',
  'mobile_nativeSelect',
  'web_hover',
  'web_paste',
  'mobile_tap',
  'mobile_longpress',
  'common_clearText',
  'mobile_drag',
  'mobile_doubleTap',
  'web_doubleClick',
  'web_rightClick',
  'web_copy',
  'web_fileUpload',
  'mobile_swipe',
  'common_scroll',
  'mobile_pinch',
  'mobile_multiTap',
  'mobile_tapCoordinate',
] as const

function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registerAllActions(registry)
  return registry
}

function schemaShapes(schema: z.ZodType): Array<Record<string, z.ZodType>> {
  if (schema instanceof z.ZodDiscriminatedUnion) {
    return schema.options.map(option => (option as z.ZodObject<any>).shape as Record<string, z.ZodType>)
  }

  if (schema instanceof z.ZodUnion) {
    return schema.options.map(option => (option as z.ZodObject<any>).shape as Record<string, z.ZodType>)
  }

  return [(schema as z.ZodObject<any>).shape as Record<string, z.ZodType>]
}

function schemaFor(registry: ToolRegistry, id: string): z.ZodType {
  const definition = registry.get(id)
  if (!definition) throw new Error(`Missing tool definition: ${id}`)
  return definition.schema
}

function hasField(schema: z.ZodType, field: string): boolean {
  return schemaShapes(schema).some(shape => Object.prototype.hasOwnProperty.call(shape, field))
}

describe('grounding surface', () => {
  it('does not expose selector as an interaction-tool argument', () => {
    const registry = buildRegistry()

    for (const id of INTERACTION_TOOL_IDS) {
      const schema = schemaFor(registry, id)
      for (const shape of schemaShapes(schema)) {
        expect(shape).not.toHaveProperty('selector')
      }
    }
  })

  it('keeps common_waitFor as the only selector-accepting verb', () => {
    const registry = buildRegistry()
    const selectorAcceptingIds = registry.getAll()
      .filter(definition => hasField(definition.schema, 'selector'))
      .map(definition => definition.id)

    expect(selectorAcceptingIds).toEqual(['common_waitFor'])

    const waitForSelectorShapes = schemaShapes(schemaFor(registry, 'common_waitFor'))
      .filter(shape => Object.prototype.hasOwnProperty.call(shape, 'selector'))

    expect(waitForSelectorShapes).toHaveLength(1)
    expect(waitForSelectorShapes[0]).toHaveProperty('on')
    expect(waitForSelectorShapes[0]).toHaveProperty('selector')
  })

  it('treats web_waitForUrl pattern as a URL glob, not a selector', () => {
    const registry = buildRegistry()

    for (const shape of schemaShapes(schemaFor(registry, 'web_waitForUrl'))) {
      expect(shape).toHaveProperty('pattern')
      expect(shape).not.toHaveProperty('selector')
    }
  })
})
