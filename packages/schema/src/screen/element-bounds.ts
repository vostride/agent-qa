import type { BoundingBox } from '../primitives/bounding-box'
import type { Point } from '../primitives/point'
import type { Ref } from '../primitives/ref'

export interface ScrollContext {
  // An absent container means page-level scrolling.
  container?: Ref
  offsetX: number
  offsetY: number
}

export interface ElementBounds {
  bounds: BoundingBox
  center: Point
  scrollContext?: ScrollContext
}
