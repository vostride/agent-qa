// 2026-10-07, 436-09 (D-03, D-06): every CLI producer resolves a member's limits through one helper
// over the same merged blocks, and the run states them before it starts without asking anything.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  memberPlannerConfig,
  plannerLimitsInfoLine,
  plannerLimitsInfoLines,
  plannerLimitsRecord,
} from '../run-planner-limits.js'

const DIRECT_FALLBACK = 3
const SUITE_FALLBACK = 5

function use(planner: Record<string, unknown>): Record<string, unknown> {
  return { planner }
}

describe('effective planner limits', () => {
  it('direct and suite members resolve the same limits from the same blocks', () => {
    const blocks = {
      project: use({ maxActions: 30, maxPlanningTurns: 30 }),
      suite: use({ maxPlanningTurns: 40 }),
      test: use({ maxActions: 45 }),
    }
    const direct = memberPlannerConfig(blocks, DIRECT_FALLBACK)
    const suite = memberPlannerConfig(blocks, SUITE_FALLBACK)
    expect({ maxActions: direct.maxActions, maxPlanningTurns: direct.maxPlanningTurns })
      .toEqual({ maxActions: 45, maxPlanningTurns: 40 })
    expect({ maxActions: suite.maxActions, maxPlanningTurns: suite.maxPlanningTurns })
      .toEqual({ maxActions: direct.maxActions, maxPlanningTurns: direct.maxPlanningTurns })
  })

  it('a test override raises only that test', () => {
    const project = use({ maxActions: 30, maxPlanningTurns: 30 })
    const bulk = memberPlannerConfig({ project, test: use({ maxActions: 60 }) }, SUITE_FALLBACK)
    const sibling = memberPlannerConfig({ project, test: undefined }, SUITE_FALLBACK)
    const plain = memberPlannerConfig({ project, test: use({ previousStepCount: 2 }) }, SUITE_FALLBACK)
    expect(bulk).toMatchObject({ maxActions: 60, maxPlanningTurns: 30 })
    expect(sibling).toMatchObject({ maxActions: 30, maxPlanningTurns: 30 })
    expect(plain).toMatchObject({ maxActions: 30, maxPlanningTurns: 30 })
  })

  it('previousStepCount keeps each path\'s fallback when unset', () => {
    const unset = { project: use({ maxActions: 30 }) }
    expect(memberPlannerConfig(unset, DIRECT_FALLBACK).previousStepCount).toBe(3)
    expect(memberPlannerConfig(unset, SUITE_FALLBACK).previousStepCount).toBe(5)

    const configured = { project: use({ previousStepCount: 7 }), test: use({ previousStepCount: 9 }) }
    expect(memberPlannerConfig(configured, DIRECT_FALLBACK).previousStepCount).toBe(9)
    expect(memberPlannerConfig(configured, SUITE_FALLBACK).previousStepCount).toBe(9)
    expect(memberPlannerConfig({ project: use({ previousStepCount: 7 }) }, SUITE_FALLBACK).previousStepCount)
      .toBe(7)
  })

  it('the information line names both limits and never asks', () => {
    const run = plannerLimitsInfoLine({ maxActions: 30, maxPlanningTurns: 30 })
    const perTest = plannerLimitsInfoLine({ maxActions: 60, maxPlanningTurns: 30 }, 'Bulk archive')
    expect(run).toBe('Limits: 30 actions, 30 planning turns per step')
    expect(perTest).toBe('Limits for "Bulk archive": 60 actions, 30 planning turns per step')
    expect(run.endsWith('?')).toBe(false)
    expect(perTest.endsWith('?')).toBe(false)
    expect(run).not.toContain('?')
    expect(perTest).not.toContain('?')
  })

  it('plannerLimitsRecord lists only differing members, in member order', () => {
    const run = { maxActions: 30, maxPlanningTurns: 30 }
    const record = plannerLimitsRecord(run, [
      { testName: 'Zeta bulk', filePath: 'tests/zeta.yaml', limits: { maxActions: 60, maxPlanningTurns: 30 } },
      { testName: 'Checkout', filePath: 'tests/checkout.yaml', limits: { maxActions: 30, maxPlanningTurns: 30 } },
      { testName: 'Alpha search', filePath: 'tests/alpha.yaml', limits: { maxActions: 30, maxPlanningTurns: 12 } },
    ])
    expect(record).toEqual({
      maxActions: 30,
      maxPlanningTurns: 30,
      perTest: [
        { testName: 'Zeta bulk', filePath: 'tests/zeta.yaml', maxActions: 60, maxPlanningTurns: 30 },
        { testName: 'Alpha search', filePath: 'tests/alpha.yaml', maxActions: 30, maxPlanningTurns: 12 },
      ],
    })
    expect(plannerLimitsInfoLines(record)).toEqual([
      'Limits: 30 actions, 30 planning turns per step',
      'Limits for "Zeta bulk": 60 actions, 30 planning turns per step',
      'Limits for "Alpha search": 30 actions, 12 planning turns per step',
    ])

    const uniform = plannerLimitsRecord(run, [
      { testName: 'Checkout', filePath: 'tests/checkout.yaml', limits: run },
    ])
    expect(uniform).toEqual({ maxActions: 30, maxPlanningTurns: 30 })
    expect('perTest' in uniform).toBe(false)
  })

  it('both producers in run.ts build PlannerConfig through memberPlannerConfig', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(join(here, '..', 'commands', 'run.ts'), 'utf-8')
    expect(source.match(/memberPlannerConfig\(/g) ?? []).toHaveLength(2)
    expect(source).not.toContain('resolvePlannerLimits(testMergedConfig')
    expect(source).toMatch(/memberPlannerConfig\(\s*\{ project: config\.use, suite: prepared\.suite\.use, test: test\.use \},\s*5,?\s*\)/)
    expect(source).toMatch(/memberPlannerConfig\(\{ project: config\.use, test: test\.use \}, 3\)/)
  })
})
