// Descriptor-only value projection.
// CRITICAL: storage-neutral — no node:* imports. Projects a planned action + the
// fresh elements into a role + exact name (+ stated row words) descriptor and assembles a
// CachedPlanValue that provably omits raw refs/selectors/coordinates, positions and any step
// `data` value (the overfit guard: nothing run-specific survives into the cache).

import type { ElementInfo } from '@vostride/agent-qa-schema'
import { rowContains, rowTextOf, wordTokens } from '../grounding/row-text.js'
import type { StatedTarget, StatedTargets } from '../grounding/stated-target.js'
import { tidyName } from '../grounding/strict-match.js'
import type { Action } from '../platform.js'
import type { CacheablePlannedAction, CachedPlanValue, GroundedLocator } from './port.js'

export type { CacheablePlannedAction, CachedPlanValue, GroundedLocator } from './port.js'

// Fields that would overfit a cached plan to one run: locator bindings (single- AND
// multi-ref lanes + emission-side target descriptors) and the raw step data value.
// Stripped from every stored planned action so nothing run-specific ever persists —
// grounding is carried SOLELY by the descriptor locators (D-12, Pitfall 5). The stated
// target never persists inside an action; its row reaches the store only through a locator.
const OVERFIT_KEYS = new Set([
  'ref',
  'fromRef',
  'toRef',
  'target',
  'fromTarget',
  'toTarget',
  'selector',
  'coordinates',
  'coords',
  'x',
  'y',
  'center',
  'bounds',
  'data',
])

// The ordered multi-ref lanes of a drag (Pitfall 5a): one locator per ref field,
// fromRef before toRef, so replay re-resolves BOTH in a stable order.
const MULTI_REF_LANES = ['fromRef', 'toRef'] as const

function actionRef(action: Action): string | undefined {
  const ref = (action as { ref?: unknown }).ref
  return typeof ref === 'string' ? ref : undefined
}

function fieldRef(action: Action, field: string): string | undefined {
  const ref = (action as unknown as Record<string, unknown>)[field]
  return typeof ref === 'string' ? ref : undefined
}

function locatorForRef(
  ref: string,
  elements: readonly ElementInfo[],
  stated: StatedTarget | undefined,
): GroundedLocator | null {
  const target = elements.find((element) => element.ref === ref)
  if (target === undefined) return null

  const locator: GroundedLocator = { role: target.role, name: tidyName(target.name) }
  const row = stated?.row
  if (row !== undefined && wordTokens(row).length > 0) {
    const observedRow = rowTextOf(target, elements)
    if (observedRow !== undefined && rowContains(observedRow, row)) locator.row = row.trim()
  }
  return locator
}

// The sanitized, stored form statically excludes the AI-assertion verbs: a completing
// plan carrying assertAI/extractAI is bypassed at the write site (Plan 10 runtime guard), so
// the stored value only ever holds cacheable verbs. The cast asserts that boundary at the type.
function sanitizeAction(action: Action): CacheablePlannedAction {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(action)) {
    if (OVERFIT_KEYS.has(key)) continue
    out[key] = value
  }
  return out as unknown as CacheablePlannedAction
}

/**
 * Project a planned action's target element to a descriptor-only locator: its role, its exact
 * name, and the stated row when the element's known row holds it. Returns null when the action
 * targets no element (e.g. navigate) or the ref no longer resolves.
 */
export function toGroundedLocator(
  action: Action,
  elements: readonly ElementInfo[],
  stated?: StatedTarget,
): GroundedLocator | null {
  const ref = actionRef(action)
  if (ref === undefined) return null
  return locatorForRef(ref, elements, stated)
}

/**
 * Derive the ordered per-lane descriptor locators for an action (Pitfall 5). A drag
 * yields one locator per ref field (fromRef, toRef order-stable) so replay re-resolves
 * BOTH; a single-ref action yields one locator; a coordinate/ref-less action yields
 * none. A drag whose lanes cannot all be grounded yields a partial list — replay treats
 * a locator-count shortfall as non-replayable (invalidate → replan).
 */
export function deriveLaneLocators(
  action: Action,
  elements: readonly ElementInfo[],
  statedTargets?: StatedTargets,
): GroundedLocator[] {
  if ((action as { type?: unknown }).type === 'drag') {
    const locators: GroundedLocator[] = []
    for (const field of MULTI_REF_LANES) {
      const ref = fieldRef(action, field)
      if (ref === undefined) break
      const locator = locatorForRef(ref, elements, statedTargets?.[field])
      if (locator === null) break
      locators.push(locator)
    }
    return locators
  }
  const single = toGroundedLocator(action, elements, statedTargets?.ref)
  return single !== null ? [single] : []
}

export interface BuildCachedPlanValueInput {
  plannedActions: readonly Action[]
  elements: readonly ElementInfo[]
  completesStep: boolean
  /** The completing decision's stated target per lane; supplies a locator's row words. */
  statedTargets?: StatedTargets
}

/**
 * Assemble a descriptor-only CachedPlanValue. Planned actions are sanitized of every
 * locator binding and step `data` value; grounding is carried solely by the
 * descriptor locators so nothing run-specific is ever persisted (D-12 overfit guard).
 */
export function buildCachedPlanValue(input: BuildCachedPlanValueInput): CachedPlanValue {
  const groundedLocator: GroundedLocator[] = []
  for (const action of input.plannedActions) {
    groundedLocator.push(...deriveLaneLocators(action, input.elements, input.statedTargets))
  }

  return {
    plannedActions: input.plannedActions.map(sanitizeAction),
    groundedLocator,
    completesStep: input.completesStep,
  }
}
