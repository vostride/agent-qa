// RED scaffold (Wave 0, GROUND-01 · D-04/D-05/D-06). Pins the uniform `target`
// tool-surface coverage rule the way element-description.test.ts pins its companion
// field: wherever a ref can name an element, an optional `target` TargetDescriptor
// sibling can too, and the ref becomes optional (438 D-01: the target is sent beside the
// ref and checked against it at the grounding gate). The `target` fields do not exist yet, so these assertions fail
// (assertion failures, not import/syntax errors); they turn GREEN when Plan 05 lands the
// tool-schema change. The enumerated ID list is the D-05 "one scanner rule, no exception
// list" spec (357-RESEARCH Pitfall 10 verified inventory).
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ToolRegistry } from '../registry.js'
import { registerAllActions } from '../actions/index.js'

// Every tool whose ref can name a current-screen element — single-ref tools, the
// union ref-branches (pinch/multiTap ref XOR coords), and the optional container-ref
// tools (scroll/swipe). Enumerated by name (no invented count): D-05 uniform coverage.
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

// The `target` field must be an optional strict stated target: role, name and row words ONLY
// (438 D-01, D-02) — never an ordinal (438 D-12), never `near` (D-06, omitted from the M1 LLM
// surface) and never a selector-like field (the grounding-surface rule).
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
        // 438 D-01: the target is sent alongside the ref, and alone only with no confident ref;
        // the contract is stated in prose (invisible to JSON schema otherwise — Pitfall 4).
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

  // NOTE: elementDescription (D-07) is intentionally untouched — its surface is pinned
  // unchanged by element-description.test.ts, which must keep passing verbatim.
})
