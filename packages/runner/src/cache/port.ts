// Keyed by a branded CacheKey; the value is descriptor-only, never a ref, selector or data value.

import type { CacheKey } from '@vostride/agent-qa-schema'
import type { Action } from '../platform.js'

// AI-assertion verbs are excluded, so a plan carrying one cannot typecheck into a cache write.
export type CacheablePlannedAction = Exclude<Action, { type: 'assertAI' } | { type: 'extractAI' }>

// Role, exact name and stated row words; replay re-finds the one element with this identity.
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

// Get, set and invalidate over a branded CacheKey; storage lives outside runner.
export interface ActionPlanCache {
  get(key: CacheKey): Promise<CachedPlanValue | null>
  set(key: CacheKey, value: CachedPlanValue): Promise<void>
  invalidate(key: CacheKey): Promise<void>
}
