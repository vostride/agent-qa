// Turns a member's merged `use` blocks into planner config, and words the limits line.
import {
  resolvePlannerLimits,
  type PlannerLimits,
  type PlannerLimitsPerTest,
  type PlannerLimitsRecord,
} from '@vostride/agent-qa-schema'

export interface MemberPlannerBlocks {
  readonly project?: unknown
  readonly suite?: unknown
  readonly test?: unknown
}

export interface MemberPlannerConfig extends PlannerLimits {
  previousStepCount: number
}

export interface MemberPlannerLimits {
  readonly testName: string
  readonly filePath: string
  readonly limits: PlannerLimits
}

function previousStepCountOf(useBlock: unknown): number | undefined {
  if (typeof useBlock !== 'object' || useBlock === null) return undefined
  const planner = (useBlock as { planner?: unknown }).planner
  if (typeof planner !== 'object' || planner === null) return undefined
  const value = (planner as { previousStepCount?: unknown }).previousStepCount
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * The PlannerConfig both producers hand a member. The limits come from the schema resolver over
 * project, suite and test blocks in that precedence; previousStepCount takes the last block that
 * sets it, else the producer's own fallback (direct 3, suite member 5).
 */
export function memberPlannerConfig(
  blocks: MemberPlannerBlocks,
  previousStepFallback: number,
): MemberPlannerConfig {
  const ordered = [blocks.project, blocks.suite, blocks.test]
  let previousStepCount = previousStepFallback
  for (const block of ordered) {
    const value = previousStepCountOf(block)
    if (value !== undefined) previousStepCount = value
  }
  return { ...resolvePlannerLimits(...ordered), previousStepCount }
}

/** Information only: it states the limits and never asks. */
export function plannerLimitsInfoLine(limits: PlannerLimits, testName?: string): string {
  const values = `${limits.maxActions} actions, ${limits.maxPlanningTurns} planning turns per step`
  return testName === undefined ? `Limits: ${values}` : `Limits for "${testName}": ${values}`
}

function sameLimits(a: PlannerLimits, b: PlannerLimits): boolean {
  return a.maxActions === b.maxActions && a.maxPlanningTurns === b.maxPlanningTurns
}

/** The run's limits and, in member order, only the members whose own limits differ. */
export function plannerLimitsRecord(
  run: PlannerLimits,
  members: readonly MemberPlannerLimits[],
): PlannerLimitsRecord {
  const perTest: PlannerLimitsPerTest[] = members
    .filter((member) => !sameLimits(member.limits, run))
    .map((member) => ({
      testName: member.testName,
      filePath: member.filePath,
      maxActions: member.limits.maxActions,
      maxPlanningTurns: member.limits.maxPlanningTurns,
    }))
  return {
    maxActions: run.maxActions,
    maxPlanningTurns: run.maxPlanningTurns,
    ...(perTest.length === 0 ? {} : { perTest }),
  }
}

/** The lines the CLI prints before the first test: the run's limits, then each differing test. */
export function plannerLimitsInfoLines(record: PlannerLimitsRecord): string[] {
  return [
    plannerLimitsInfoLine(record),
    ...(record.perTest ?? []).map((entry) => plannerLimitsInfoLine(entry, entry.testName)),
  ]
}
