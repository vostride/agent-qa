import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ToolRegistry } from '../registry.js'
import { registerAllActions } from '../actions/index.js'

const ELEMENT_DESCRIPTION_IDS = [
  'web_click',
  'web_fill',
  'mobile_fill',
  'web_select',
  'mobile_nativeSelect',
  'web_hover',
  'web_paste',
  'web_focus',
  'ios_pickerSelect',
  'mobile_tap',
  'mobile_longpress',
  'common_clearText',
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

const EXCLUDED_ELEMENT_DESCRIPTION_IDS = [
  'web_navigate',
  'common_delay',
  'common_waitFor',
  'common_assertAI',
  'common_assertValue',
  'common_extractAI',
  'common_openApp',
  'common_reportValue',
  'common_keypress',
  'web_inspect',
  'web_setCookies',
  'web_setLocalStorage',
  'mobile_hideKeyboard',
  'mobile_setOrientation',
  'common_setVariable',
  'web_tab',
  'web_waitForUrl',
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

function expectOptionalFieldOnEveryShape(registry: ToolRegistry, id: string, field: string): void {
  const shapes = schemaShapes(schemaFor(registry, id))
  expect(shapes.length).toBeGreaterThan(0)

  for (const shape of shapes) {
    expect(shape).toHaveProperty(field)
    const fieldSchema = shape[field]
    expect(fieldSchema).toBeDefined()
    expect(fieldSchema.safeParse(undefined).success).toBe(true)
  }
}

function expectFieldAbsentFromEveryShape(registry: ToolRegistry, id: string, field: string): void {
  const shapes = schemaShapes(schemaFor(registry, id))
  expect(shapes.length).toBeGreaterThan(0)

  for (const shape of shapes) {
    expect(shape).not.toHaveProperty(field)
  }
}

describe('elementDescription grounding companion', () => {
  it('adds optional elementDescription to the interaction set', () => {
    const registry = buildRegistry()

    for (const id of ELEMENT_DESCRIPTION_IDS) {
      expectOptionalFieldOnEveryShape(registry, id, 'elementDescription')
    }
  })

  it('adds fromDescription and toDescription to drag instead of elementDescription', () => {
    const registry = buildRegistry()

    expectOptionalFieldOnEveryShape(registry, 'mobile_drag', 'fromDescription')
    expectOptionalFieldOnEveryShape(registry, 'mobile_drag', 'toDescription')
    expectFieldAbsentFromEveryShape(registry, 'mobile_drag', 'elementDescription')
  })

  it('does not add elementDescription to excluded verbs', () => {
    const registry = buildRegistry()

    for (const id of EXCLUDED_ELEMENT_DESCRIPTION_IDS) {
      expectFieldAbsentFromEveryShape(registry, id, 'elementDescription')
    }
  })
})
