// Barrel for the runner-owned pure cache core.
// Storage-neutral: re-exports the port, the descriptor value, and the re-ground seam.

export type { ActionPlanCache, CacheablePlannedAction, CachedPlanValue, GroundedLocator } from './port.js'
export { buildCachedPlanValue, toGroundedLocator } from './value.js'
export type { BuildCachedPlanValueInput } from './value.js'
export { deterministicDescriptorMatcher } from './reground.js'
export type { GroundingStrategy } from './reground.js'
export { buildCacheableStepInput, CACHE_ENV_DIGEST_SALT } from './key.js'
export type { BuildCacheableStepInputArgs } from './key.js'
export { classifyStep } from './classify.js'
export type { CacheableClassification, ClassifyStepInput } from './classify.js'
