import type { ActionPlan } from '../schema/action-schema.js'

// Increment when cache entry format changes (new fields, type changes, etc.)
// Old entries with different/missing version are treated as cache misses.
// v8 (138.1): invalidated pre-fix cached coord entries. Phase 138.1.1.1 reverted
// scaling — coords are viewport-space identity. Phase 142 removed all dead scaling
// code (setScaleFactor, scaleCoord, CompressResult.scaleFactor).
// v9 (148.1): identity fields added (test-id, suite-id), HealingMetaSchema removed,
// suite tests changed from string[] to {test, id}[] objects.
export const CACHE_SCHEMA_VERSION = 9

export interface CacheEntry {
  schemaVersion?: number // undefined for v1, 2 for v5.0 initial, 3 for v5.0 multi-action
  stepInstruction: string
  stepHash: string
  screenHash: string
  plan: ActionPlan
  createdAt: string
  model: string
  provider: string
}
