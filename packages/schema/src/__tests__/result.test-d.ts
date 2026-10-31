import { expectTypeOf, test } from 'vitest'
import type { ActionAnnotation, ActionResult, Viewport } from '../index'

test('action results and annotations have fixed shapes', () => {
  expectTypeOf<ActionResult>().toEqualTypeOf<{
    success: boolean
    error?: string
    screenshot?: Uint8Array
    data?: unknown
    metadata?: Record<string, unknown>
    annotation?: ActionAnnotation
  }>()

  expectTypeOf<ActionResult['screenshot']>().toEqualTypeOf<Uint8Array | undefined>()
  expectTypeOf<Viewport>().toEqualTypeOf<{ width: number; height: number }>()
  expectTypeOf<ActionAnnotation>().toMatchTypeOf<{
    viewport: Viewport
    direction?: 'up' | 'down' | 'left' | 'right'
    failureHighlight?: { x: number; y: number; width: number; height: number }
  }>()
  expectTypeOf<ActionAnnotation['kind']>().toEqualTypeOf<'point' | 'path' | 'pinch' | 'region'>()
})

declare const a: ActionAnnotation
declare const producedAnnotation: ActionAnnotation
declare const consumedAnnotation: ActionAnnotation

test('annotation geometry lives under its narrowed arm', () => {
  expectTypeOf(producedAnnotation).toEqualTypeOf<ActionAnnotation>()
  expectTypeOf(consumedAnnotation).toEqualTypeOf<ActionAnnotation>()

  if (a.kind === 'pinch') {
    expectTypeOf(a.pinch.center).toEqualTypeOf<{ x: number; y: number }>()
    expectTypeOf(a.pinch.scale).toEqualTypeOf<number>()

    // @ts-expect-error geometry is nested under the narrowed arm.
    void a.center
  }

  if (a.kind === 'path') {
    expectTypeOf(a.path.start).toEqualTypeOf<{ x: number; y: number }>()
    expectTypeOf(a.path.end).toEqualTypeOf<{ x: number; y: number }>()
  }

  // @ts-expect-error there is no cross-arm geometry field on the envelope.
  void a.coordinates
})

test('removed positional result keys and annotations without a viewport are refused', () => {
  // @ts-expect-error removed positional result key is rejected.
  const invalidResultA: ActionResult = { success: true, coordinates: { x: 1, y: 2 } }

  // @ts-expect-error removed positional result key is rejected.
  const invalidResultB: ActionResult = { success: true, boundingBox: { x: 1, y: 2, width: 3, height: 4 } }

  // @ts-expect-error removed positional result key is rejected.
  const invalidResultC: ActionResult = { success: true, startCoordinates: { x: 1, y: 2 } }

  // @ts-expect-error removed positional result key is rejected.
  const invalidResultD: ActionResult = { success: true, endCoordinates: { x: 1, y: 2 } }

  // @ts-expect-error annotation arms require viewport.
  const annotationWithoutViewport: ActionAnnotation = { kind: 'point', point: { x: 1, y: 2 } }

  void invalidResultA
  void invalidResultB
  void invalidResultC
  void invalidResultD
  void annotationWithoutViewport
})
