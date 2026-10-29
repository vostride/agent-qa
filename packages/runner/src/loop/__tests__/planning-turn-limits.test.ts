import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tool } from 'ai'
import { z } from 'zod'
import type { ActionPlanCache, CacheablePlannedAction, CachedPlanValue } from '../../cache/port.js'
import type { Action, ActionResult, PlatformAdapter } from '../../platform.js'
import { makeScreenState } from '../../testing/screen-fixtures.js'
import { executeStep } from '../index.js'
import { LLMPlanner } from '../planner.js'
import type { NonActionToolMap } from '../planning-turn.js'
import type { LoopPorts } from '../ports.js'
import type { ActionPlan, Planner } from '../types.js'
import { makeActionPlan, makeFakeTokenAccounting, makeStepContext } from './loop-harness.js'

vi.mock('ai', async (importActual) => {
  const actual = await importActual<typeof import('ai')>()
  return { ...actual, generateText: vi.fn() }
})

const CLICK = {
  toolCalls: [{
    toolName: 'web_click',
    input: { ref: 'e2', reasoning: 'Click Log in', confidence: 0.9, stepComplete: true, doesActionAdvanceUsTowardsGoal: true },
  }],
  usage: { inputTokens: 10, outputTokens: 2 },
}
const CLICK_STALE_REF = {
  toolCalls: [{
    toolName: 'web_click',
    input: { ref: 'e99', reasoning: 'Click Log in', confidence: 0.9, stepComplete: true, doesActionAdvanceUsTowardsGoal: true },
  }],
  usage: { inputTokens: 10, outputTokens: 2 },
}
const LOOKUP = {
  toolCalls: [{ toolName: 'recorded_lookup', input: { key: 'login' } }],
  usage: { inputTokens: 5, outputTokens: 1 },
}
const TEXT_ONLY = { toolCalls: [], text: 'I think I should click', usage: { inputTokens: 5, outputTokens: 1 } }

const lookupTools: NonActionToolMap = {
  recorded_lookup: {
    tool: tool({ description: 'lookup', inputSchema: z.object({ key: z.string() }) }),
    execute: () => ({ found: true }),
  },
}

function llmPlanner(nonActionTools?: NonActionToolMap): LLMPlanner {
  return new LLMPlanner({} as never, 'web', undefined, undefined, makeFakeTokenAccounting(), undefined, nonActionTools)
}

async function scriptModel(responses: Array<unknown | Error>) {
  const { generateText } = await import('ai')
  const mock = vi.mocked(generateText)
  const queue = [...responses]
  mock.mockImplementation(async () => {
    const next = queue.length > 1 ? queue.shift() : queue[0]
    if (next instanceof Error) throw next
    return next as never
  })
  return mock
}

function adapter(options: { results?: ActionResult[]; screenshot?: boolean } = {}): PlatformAdapter & { executed: Action[] } {
  const executed: Action[] = []
  let call = 0
  const a: PlatformAdapter & { executed: Action[] } = {
    executed,
    platform: 'web',
    async setup() {},
    async cleanup() {},
    async observe() { return makeScreenState() },
    async execute(action: Action) {
      executed.push(action)
      const results = options.results ?? [{ success: true }]
      return results[Math.min(call++, results.length - 1)]
    },
  }
  if (options.screenshot) a.screenshot = async () => Buffer.from('png')
  return a
}

function scriptedPlanner(plans: ActionPlan[]): Planner & { calls: number } {
  const planner = {
    calls: 0,
    async plan() {
      const plan = plans[Math.min(planner.calls, plans.length - 1)]
      planner.calls++
      return { plan }
    },
  }
  return planner
}

const limits = (maxActions: number, maxPlanningTurns: number) => ({ maxActions, maxPlanningTurns, previousStepCount: 0 })

function ports(overrides: Partial<LoopPorts> & Pick<LoopPorts, 'adapter' | 'planner'>): LoopPorts {
  return overrides
}

describe('planner calls debited against the planning-turn limit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('each read-only non-action round is one planner call', async () => {
    const model = await scriptModel([LOOKUP, LOOKUP, CLICK])
    const result = await executeStep(
      'Click Log in',
      ports({ adapter: adapter(), planner: llmPlanner(lookupTools), plannerConfig: limits(10, 10) }),
      makeStepContext(),
    )
    expect(result.status).toBe('passed')
    expect(model).toHaveBeenCalledTimes(3)
    expect(result.evidence?.limitUsage).toMatchObject({ actionsUsed: 1, planningCallsUsed: 3 })
  })

  it('a refused call mid-turn stops at the planning limit', async () => {
    const model = await scriptModel([LOOKUP, LOOKUP, CLICK])
    const a = adapter()
    const result = await executeStep(
      'Click Log in',
      ports({ adapter: a, planner: llmPlanner(lookupTools), plannerConfig: limits(10, 2) }),
      makeStepContext(),
    )
    const reason = 'Stopped: planning-turn limit reached — 2 of 2 planner calls used'
    expect(model).toHaveBeenCalledTimes(2)
    expect(a.executed).toHaveLength(0)
    expect(result.status).toBe('failed')
    expect(result.error).toBe(reason)
    expect(result.evidence?.limitStop).toEqual({
      limit: 'planning-turns',
      configured: 2,
      used: 2,
      reason,
      requestedOutcome: 'unverified',
    })
    expect(result.evidence?.planningFailure).toBeUndefined()
    expect(result.evidence?.termination).toBeUndefined()
    expect(result.evidence?.verdictSource).toBeUndefined()
    expect(result.evidence?.limitUsage).toMatchObject({ actionsUsed: 0, planningCallsUsed: 2 })
  })

  describe('the text-only re-prompt, the grounding retry, the clamp overflow retry and the screenshot fallback each cost one call', () => {
    it('the text-only re-prompt', async () => {
      const model = await scriptModel([TEXT_ONLY, CLICK])
      const result = await executeStep('Click Log in', ports({ adapter: adapter(), planner: llmPlanner(), plannerConfig: limits(10, 10) }), makeStepContext())
      expect(result.status).toBe('passed')
      expect(model).toHaveBeenCalledTimes(2)
      expect(result.evidence?.limitUsage?.planningCallsUsed).toBe(2)
    })

    it('the grounding retry', async () => {
      const model = await scriptModel([CLICK_STALE_REF, CLICK])
      const result = await executeStep('Click Log in', ports({ adapter: adapter(), planner: llmPlanner(), plannerConfig: limits(10, 10) }), makeStepContext())
      expect(result.status).toBe('passed')
      expect(model).toHaveBeenCalledTimes(2)
      expect(result.evidence?.limitUsage?.planningCallsUsed).toBe(2)
    })

    it('the clamp overflow retry', async () => {
      const model = await scriptModel([new Error('This model maximum context length is 8192 tokens'), CLICK])
      const result = await executeStep('Click Log in', ports({ adapter: adapter(), planner: llmPlanner(), plannerConfig: limits(10, 10) }), makeStepContext())
      expect(result.status).toBe('passed')
      expect(model).toHaveBeenCalledTimes(2)
      expect(result.evidence?.limitUsage?.planningCallsUsed).toBe(2)
    })

    it('the screenshot fallback', async () => {
      const model = await scriptModel([new Error('image payload too large'), CLICK])
      const result = await executeStep(
        'Click Log in',
        ports({ adapter: adapter({ screenshot: true }), planner: llmPlanner(), plannerConfig: limits(10, 10) }),
        makeStepContext(),
      )
      expect(result.status).toBe('passed')
      expect(model).toHaveBeenCalledTimes(2)
      expect(result.evidence?.limitUsage?.planningCallsUsed).toBe(2)
    })

    it('a refused fallback call is a planning-limit stop, not a planning failure', async () => {
      const model = await scriptModel([new Error('image payload too large'), CLICK])
      const result = await executeStep(
        'Click Log in',
        ports({ adapter: adapter({ screenshot: true }), planner: llmPlanner(), plannerConfig: limits(10, 1) }),
        makeStepContext(),
      )
      expect(model).toHaveBeenCalledTimes(1)
      expect(result.status).toBe('failed')
      expect(result.evidence?.limitStop).toMatchObject({ limit: 'planning-turns', configured: 1, used: 1 })
      expect(result.evidence?.planningFailure).toBeUndefined()
    })
  })

  it('a heal-replan turn after an execution failure is debited', async () => {
    const model = await scriptModel([CLICK])
    const a = adapter({ results: [{ success: false, error: 'Element is not interactable' }, { success: true }] })
    const result = await executeStep('Click Log in', ports({ adapter: a, planner: llmPlanner(), plannerConfig: limits(10, 10) }), makeStepContext())
    expect(result.status).toBe('passed')
    expect(a.executed).toHaveLength(2)
    expect(model).toHaveBeenCalledTimes(2)
    expect(result.evidence?.limitUsage).toMatchObject({ actionsUsed: 2, planningCallsUsed: 2 })
  })

  it('a scripted planner is debited once per plan()', async () => {
    const a = adapter()
    const planner = scriptedPlanner([makeActionPlan({ stepComplete: false })])
    const result = await executeStep('Keep clicking', ports({ adapter: a, planner, plannerConfig: limits(10, 2) }), makeStepContext())
    expect(planner.calls).toBe(2)
    expect(a.executed).toHaveLength(2)
    expect(result.status).toBe('failed')
    expect(result.error).toBe('Stopped: planning-turn limit reached — 2 of 2 planner calls used')
    expect(result.evidence?.limitStop).toMatchObject({ limit: 'planning-turns', configured: 2, used: 2 })
    expect(result.evidence?.limitUsage).toMatchObject({ actionsUsed: 2, planningCallsUsed: 2 })
  })

  it('a cache hit dispatches after the planning limit is spent', async () => {
    const cachedValue: CachedPlanValue = {
      plannedActions: [{ type: 'click' } as unknown as CacheablePlannedAction],
      groundedLocator: [{ role: 'button', name: 'Log in' }],
      completesStep: true,
    }
    let gets = 0
    const cache: ActionPlanCache = {
      async get() { return gets++ === 0 ? null : cachedValue },
      async set() {},
      async invalidate() {},
    }
    const a = adapter()
    const planner = scriptedPlanner([makeActionPlan({ stepComplete: false })])
    const result = await executeStep('Click Log in', ports({ adapter: a, planner, cache, plannerConfig: limits(5, 1) }), makeStepContext())
    expect(planner.calls).toBe(1)
    expect(a.executed).toHaveLength(2)
    expect(result.status).toBe('passed')
    expect(result.evidence?.limitStop).toBeUndefined()
    expect(result.evidence?.limitUsage).toMatchObject({ actionsUsed: 2, planningCallsUsed: 1 })
  })
})
