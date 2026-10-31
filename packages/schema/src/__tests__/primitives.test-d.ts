import { expectTypeOf, test } from 'vitest'
import { asRef, type BoundingBox, type Point, type Ref } from '../primitives/index'

test('points, bounding boxes and refs have fixed shapes', () => {
  expectTypeOf<Point>().toEqualTypeOf<{ x: number; y: number }>()
  expectTypeOf<BoundingBox>().toEqualTypeOf<{
    x: number
    y: number
    width: number
    height: number
  }>()
  expectTypeOf(asRef('e42')).toEqualTypeOf<Ref>()
})

test('a raw string is not a Ref', () => {
  // @ts-expect-error raw string is not a Ref
  const rawRef: Ref = 'e42'
})
