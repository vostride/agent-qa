// D-08 type-level pin: a plan carrying an AI-assertion verb is UNWRITABLE into the cache value.
// CacheablePlannedAction Excludes assertAI/extractAI from the composed Action union, so the
// narrowed `CachedPlanValue.plannedActions` rejects them at compile time — the static half of
// the D-08 bypass (Plan 10's runtime write-site guard is the other half). This file typechecks
// under the package `tsc -p .` gate; the @ts-expect-error lines FAIL the build if the exclusion
// ever regresses (an un-triggered @ts-expect-error is itself a TS2578 error).
import type { CachedPlanValue, CacheablePlannedAction } from '../port.js'
import type { Action } from '../../platform.js'

// A cacheable verb (click) assigns cleanly into the value's action slot.
const cacheable: CachedPlanValue = {
  plannedActions: [{ type: 'click', ref: 'e1' } as unknown as CacheablePlannedAction],
  groundedLocator: [],
  completesStep: true,
}
void cacheable

// assertAI is excluded — a plan carrying it does NOT typecheck into CachedPlanValue.
const withAssertAI: CachedPlanValue = {
  // @ts-expect-error assertAI is excluded from CacheablePlannedAction — unwritable.
  plannedActions: [{ type: 'assertAI', claim: 'x', mode: 'multimodal' }],
  groundedLocator: [],
  completesStep: true,
}
void withAssertAI

// extractAI is excluded too.
const withExtractAI: CachedPlanValue = {
  // @ts-expect-error extractAI is excluded from CacheablePlannedAction — unwritable.
  plannedActions: [{ type: 'extractAI', query: 'q', schema: [] }],
  groundedLocator: [],
  completesStep: true,
}
void withExtractAI

// The exclusion is a strict subset of Action: a CacheablePlannedAction is always an Action.
const widen: Action = { type: 'click', ref: 'e1' } as unknown as CacheablePlannedAction
void widen
