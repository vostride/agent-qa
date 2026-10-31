// Each `@ts-expect-error` below fails the build (TS2578) if the exclusion regresses.
import { test } from 'vitest'
import type { CachedPlanValue, CacheablePlannedAction } from '../port.js'
import type { Action } from '../../platform.js'

test('a cacheable verb fits the cached plan value', () => {
  // A cacheable verb (click) assigns cleanly into the value's action slot.
  const cacheable: CachedPlanValue = {
    plannedActions: [{ type: 'click', ref: 'e1' } as unknown as CacheablePlannedAction],
    groundedLocator: [],
    completesStep: true,
  }
  void cacheable
})

test('assertAI and extractAI cannot be written into a cached plan value', () => {
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
})

test('a cacheable planned action is always an action', () => {
  // The exclusion is a strict subset of Action: a CacheablePlannedAction is always an Action.
  const widen: Action = { type: 'click', ref: 'e1' } as unknown as CacheablePlannedAction
  void widen
})
