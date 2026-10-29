/** The two per-step limits, each a positive integer consumed monotonically by the runner. */
export interface PlannerLimits {
  maxActions: number
  maxPlanningTurns: number
}

export const DEFAULT_PLANNER_LIMITS: Readonly<PlannerLimits> = Object.freeze({
  maxActions: 30,
  maxPlanningTurns: 30,
})

export const PLANNER_LIMIT_KEYS = ['maxActions', 'maxPlanningTurns'] as const

/** A test whose own `use.planner` limits differ from the project's. */
export interface PlannerLimitsPerTest {
  testName: string
  filePath: string
  maxActions: number
  maxPlanningTurns: number
}

/** The effective limits a run recorded, with the tests whose own limits differ. */
export interface PlannerLimitsRecord extends PlannerLimits {
  perTest?: PlannerLimitsPerTest[]
}

function plannerLimitValue(useBlock: unknown, key: keyof PlannerLimits): number | undefined {
  if (typeof useBlock !== 'object' || useBlock === null) return undefined
  const planner = (useBlock as { planner?: unknown }).planner
  if (typeof planner !== 'object' || planner === null) return undefined
  const value = (planner as Record<string, unknown>)[key]
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/**
 * The effective limits for a step, from `use` blocks in increasing precedence (project, suite,
 * test). Per key, the last block whose `planner.<key>` is a positive safe integer wins; otherwise
 * the default applies.
 */
export function resolvePlannerLimits(...useBlocks: unknown[]): PlannerLimits {
  const resolved: PlannerLimits = { ...DEFAULT_PLANNER_LIMITS }
  for (const block of useBlocks) {
    for (const key of PLANNER_LIMIT_KEYS) {
      const value = plannerLimitValue(block, key)
      if (value !== undefined) resolved[key] = value
    }
  }
  return resolved
}
