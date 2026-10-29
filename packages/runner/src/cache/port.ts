// Redesigned storage-neutral cache port.
// CRITICAL: provider-neutral + storage-neutral. No node:* imports, no fs/sharp,
// no core/model/adapter package imports. Type-only imports, exported interfaces,
// no implementation. This replaces the v1 sub-action trio + StepKeyInput: the port
// is now keyed only by a branded CacheKey and the value is descriptor-only so a
// cached plan never carries a raw ref/selector/coordinate or step data value.

import type { CacheKey } from '@vostride/agent-qa-schema'
import type { Action } from '../platform.js'

/**
 * The subset of the action union that may be persisted in a cached plan. The
 * non-deterministic AI-assertion verbs — `assertAI` (judge lane) and `extractAI`
 * (extraction lane) — are `Exclude`d from the composed `Action` union so a plan carrying
 * one CANNOT typecheck into a cache write. Plan 10's runtime guard at the write site is the
 * narrowing proof; this static boundary is the belt-and-suspenders (the 356
 * `NonCacheableStepInput` type-level idiom, mirrored at the value shape).
 */
export type CacheablePlannedAction = Exclude<Action, { type: 'assertAI' } | { type: 'extractAI' }>

/**
 * Descriptor-only locator. Identity is the observed role, the exact
 * observed name with spacing tidied (numbers and badges kept) and, when the planner stated a
 * row the element's row holds, those row words. Never a position, a ref, a selector or
 * coordinates: replay re-finds the one element with this identity in a fresh observation.
 */
export interface GroundedLocator {
  role: string
  name: string
  row?: string
}

// One turn's sanitized action and its descriptor locators. `completesStep` is true when that
// turn finished the step.
export interface CachedPlanValue {
  plannedActions: CacheablePlannedAction[]
  groundedLocator: GroundedLocator[]
  completesStep: boolean
}

/**
 * Redesigned per-key cache port. Get/set/invalidate over a branded CacheKey
 * — the v1 prefix/index sub-action model is dropped. A storage implementation (Plan
 * 05's FsActionCache) implements this interface; runner stays storage-neutral.
 */
export interface ActionPlanCache {
  get(key: CacheKey): Promise<CachedPlanValue | null>
  set(key: CacheKey, value: CachedPlanValue): Promise<void>
  invalidate(key: CacheKey): Promise<void>
}
