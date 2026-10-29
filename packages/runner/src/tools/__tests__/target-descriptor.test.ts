import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ToolRegistry } from '../registry.js'
import { registerAllActions } from '../actions/index.js'

// Every tool whose ref can name a current-screen element, enumerated by name.
const TARGET_COVERAGE_IDS = [
  'web_click',
  'web_fill',
  'mobile_fill',
  'web_select',
  'mobile_nativeSelect',
  'web_hover',
  'web_paste',
  'web_focus',
  'mobile_tap',
  'mobile_longpress',
  'common_clearText',
  'mobile_doubleTap',
  'web_doubleClick',
  'web_rightClick',
  'web_fileUpload',
  'web_copy',
  'ios_pickerSelect', // both union branches carry a ref
  'mobile_pinch', // ref-branch only (coord-branch has no ref)
  'mobile_multiTap', // ref-branch only
  'common_scroll', // container ref, both branches
  'mobile_swipe', // container ref, direction branch
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

// The shapes of a tool that carry a `ref` (or the named ref field) — the exact branches
// that must gain a `target` sibling. Non-ref branches (pinch/multiTap coords, swipe path)
// are excluded by construction.
function refBearingShapes(schema: z.ZodType, refField = 'ref'): Array<Record<string, z.ZodType>> {
  return schemaShapes(schema).filter(shape => Object.prototype.hasOwnProperty.call(shape, refField))
}

function expectOptional(fieldSchema: z.ZodType): void {
  expect(fieldSchema).toBeDefined()
  expect(fieldSchema.safeParse(undefined).success).toBe(true)
}

// A strict stated target: role, name and row words; never an ordinal, `near` or a selector field.
function expectTargetDescriptorShape(fieldSchema: z.ZodType): void {
  expectOptional(fieldSchema)
  expect(fieldSchema.safeParse({ role: 'button', name: 'Save', row: '7 Elm Street' }).success).toBe(true)
  expect(fieldSchema.safeParse({ role: 'button', name: 'Save', ordinal: 0 }).success).toBe(false)
  expect(fieldSchema.safeParse({ role: 'button', name: 'Save', near: { nameNormalized: 'email' } }).success).toBe(false)
  expect(fieldSchema.safeParse({ role: 'button', name: 'Save', selector: '#save' }).success).toBe(false)
}

function expectOmitWhenDescribe(fieldSchema: z.ZodType): void {
  expect(fieldSchema.description ?? '').toMatch(/omit when/i)
}

describe('target descriptor coverage (uniform scanner rule)', () => {
  it('adds an optional target sibling and makes ref optional on every ref-bearing tool', () => {
    const registry = buildRegistry()

    for (const id of TARGET_COVERAGE_IDS) {
      const shapes = refBearingShapes(schemaFor(registry, id))
      expect(shapes.length).toBeGreaterThan(0)

      for (const shape of shapes) {
        // ref becomes optional (was required on the single-ref tools).
        expect(shape).toHaveProperty('ref')
        expectOptional(shape.ref)
        // an optional TargetDescriptor sibling appears.
        expect(shape).toHaveProperty('target')
        expectTargetDescriptorShape(shape.target)
      }
    }
  })

  it('gives mobile_drag fromTarget/toTarget siblings alongside optional fromRef/toRef', () => {
    const registry = buildRegistry()
    const [shape] = schemaShapes(schemaFor(registry, 'mobile_drag'))

    expect(shape).toHaveProperty('fromRef')
    expect(shape).toHaveProperty('toRef')
    expectOptional(shape.fromRef)
    expectOptional(shape.toRef)

    expect(shape).toHaveProperty('fromTarget')
    expect(shape).toHaveProperty('toTarget')
    expectTargetDescriptorShape(shape.fromTarget)
    expectTargetDescriptorShape(shape.toTarget)
    // drag keeps its own describe companions; no generic `target` on drag.
    expect(shape).not.toHaveProperty('target')
  })

  it('carries an "Omit when" describe on every newly-optional target/ref and the exactly-one-of prose', () => {
    const registry = buildRegistry()

    for (const id of ['web_click', 'mobile_tap', 'common_scroll'] as const) {
      for (const shape of refBearingShapes(schemaFor(registry, id))) {
        expectOmitWhenDescribe(shape.ref)
        // The contract is stated in prose, because JSON schema cannot express it.
        expect(shape.target.description ?? '').toMatch(/alongside ref/i)
        expect(shape.target.description ?? '').toMatch(/no confident ref, send target alone/i)
      }
    }
  })

  it('never exposes near on the target descriptor surface', () => {
    const registry = buildRegistry()

    for (const id of TARGET_COVERAGE_IDS) {
      for (const shape of refBearingShapes(schemaFor(registry, id))) {
        if (!Object.prototype.hasOwnProperty.call(shape, 'target')) continue
        expect(shape.target.safeParse({ role: 'button', name: 'x', near: {} }).success).toBe(false)
      }
    }
  })

  // elementDescription keeps its surface, which element-description.test.ts checks.
})
