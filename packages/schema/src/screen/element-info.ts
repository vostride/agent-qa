import type { BoundingBox } from '../primitives/bounding-box'
import type { Point } from '../primitives/point'
import type { Ref } from '../primitives/ref'

export interface ElementState {
  enabled: boolean
  focused: boolean
  visible: boolean
  selected?: boolean
  checked?: boolean
  editable?: boolean
  clickable?: boolean
}

export interface ElementLabels {
  testId?: string
  ariaLabel?: string
  placeholder?: string
  title?: string
}

export interface ElementHierarchy {
  parentRef?: Ref
  childRefs?: Ref[]
}

export interface ElementInfo {
  /**
   * Evidence and execution detail only. Never use ref as the identity key:
   * identity is role + nameNormalized plus a same-screen ordinal derived from
   * elements[] order at match time, never stored or reused across runs.
   */
  ref: Ref
  role: string
  // App-observed data.
  name: string
  // App-observed data, normalized from `name`.
  nameNormalized: string
  value?: string
  bounds?: BoundingBox
  center?: Point
  state: ElementState
  labels: ElementLabels
  hierarchy?: ElementHierarchy
  attributes: Record<string, string>
  // App-observed data from non-element children; never part of identity hashing or serialization.
  text?: string
}
