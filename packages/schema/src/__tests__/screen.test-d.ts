import { expectTypeOf } from 'vitest'
import type {
  BoundingBox,
  ElementBounds,
  ElementInfo,
  ModelCapabilities,
  Ref,
  ScreenState,
  ScreenStateMetadata,
} from '../index'

const full: ScreenStateMetadata = {
  captureMode: 'full',
  coordSpace: 'viewport',
  viewportWidth: 1,
  viewportHeight: 1,
  scroll: { offsetX: 0, offsetY: 0, contentWidth: 1, contentHeight: 1 },
  imageWidth: 1920,
  imageHeight: 1080,
}

// @ts-expect-error textOnly captures carry no image dimensions.
const bad: ScreenStateMetadata = { captureMode: 'textOnly', coordSpace: 'viewport', viewportWidth: 1, viewportHeight: 1, scroll: { offsetX: 0, offsetY: 0, contentWidth: 1, contentHeight: 1 }, imageWidth: 1920 }

expectTypeOf<ModelCapabilities>().toEqualTypeOf<{
  text: boolean
  vision: boolean
  visionToolMessages: boolean
  toolCalling: boolean
  structuredOutput: boolean
  streaming: boolean
  contextWindow: number
  maxOutput: number
}>()
expectTypeOf<ScreenState['refMap']>().toEqualTypeOf<Record<Ref, ElementBounds>>()
expectTypeOf<ScreenState['elements']>().toEqualTypeOf<ElementInfo[]>()
expectTypeOf<ScreenState['platform']>().toEqualTypeOf<'web' | 'android' | 'ios'>()

expectTypeOf<ElementInfo>().toMatchTypeOf<{
  ref: Ref
  role: string
  name: string
  nameNormalized: string
  state: { enabled: boolean; focused: boolean; visible: boolean }
  labels: { testId?: string }
}>()

expectTypeOf<ElementInfo['ref']>().toEqualTypeOf<Ref>()
expectTypeOf<ElementInfo['nameNormalized']>().toEqualTypeOf<string>()
expectTypeOf<ElementInfo['role']>().toEqualTypeOf<string>()

// the same-screen ordinal is derived from elements[] order at match
// time, never stored on ElementInfo and never a cross-run key. Phase 311 proves
// that structurally; positive ordinal disambiguation lands in Phase 313.
expectTypeOf<ElementBounds['bounds']>().toEqualTypeOf<BoundingBox>()
expectTypeOf<ElementBounds['center']>().toEqualTypeOf<{ x: number; y: number }>()
expectTypeOf<ElementInfo['bounds']>().toEqualTypeOf<BoundingBox | undefined>()

// vision false corresponds to the textOnly metadata arm, whose
// discriminated union structurally carries no image dimensions; the bad literal
// above proves the impossible textOnly + imageWidth state stays rejected.

void full
void bad
