// Seam proof for the ONE sanctioned Phase 368 runner change (368-01, D-01): the optional
// `nonActionTools?: NonActionToolMap` constructor param on LLMPlanner threaded to
// executePlanningTurn. This is the injection point the recorded-exchange server (plan
// 368-03) plugs into; RPLY-02's "unmodified planner" holds because omitting the param is
// byte-compatible with every existing call site. `ai.generateText` is mocked (only the
// call is replaced) so `tool`/`z`/buildTools stay real and the fake non-action tool
// carries a real `ai` definition — the planning-turn.test pattern.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tool } from 'ai'
import { z } from 'zod'
import type { ScreenState } from '@vostride/agent-qa-schema'
import { makeScreenState } from '../../testing/screen-fixtures.js'
import type { StepContext } from '../types.js'
import { LLMPlanner, PlanningTurnError } from '../planner.js'
import type { NonActionToolHandler, NonActionToolMap } from '../planning-turn.js'
import { makeFakeTokenAccounting } from './loop-harness.js'

vi.mock('ai', async (importActual) => {
  const actual = await importActual<typeof import('ai')>()
  return { ...actual, generateText: vi.fn() }
})

const screen: ScreenState = makeScreenState()

// The sampling-provider-boundary action envelope (JSON-string input shape): a grounded
// web_click on ref e1, which exists in the makeScreenState fixture so the D-09 gate passes.
const CLICK_ENVELOPE = {
  reasoning: 'Click the Log in button to submit',
  confidence: 0.9,
  stepComplete: true,
  doesActionAdvanceUsTowardsGoal: true,
}

function makeContext(overrides: Partial<StepContext> = {}): StepContext {
  return {
    stepInstruction: 'Click log in',
    testName: 'replay seam test',
    previousSteps: [],
    plannerModel: {} as never,
    verifierModel: {} as never,
    ...overrides,
  }
}

// A synthesized non-action tool named `recorded_lookup` — the shape the exchange server
// registers. `execute` is injected per test so we can assert invocation / throw behavior.
function recordedLookupTool(
  execute: NonActionToolHandler['execute'],
): NonActionToolHandler {
  return {
    tool: tool({
      description: 'recorded exchange lookup',
      inputSchema: z.object({ key: z.string() }),
    }),
    execute,
  }
}

// A typed error whose message avoids the rewrap substrings plan()'s catch inspects
// (no 'unknown tool' / 'invalid_tool_input' / 'schema validation') and which carries no
// provider statusCode/responseBody — so plan() must rethrow it by identity.
class RecordedExchangeMiss extends Error {
  constructor(readonly stepKey: string) {
    super(`recorded exchange miss for ${stepKey}`)
    this.name = 'RecordedExchangeMiss'
  }
}

describe('LLMPlanner nonActionTools seam', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('Test 1: invokes a registered non-action handler with the parsed args and threads its result back into the loop', async () => {
    const { generateText } = await import('ai')
    const execute = vi.fn((args: Record<string, unknown>) => ({ found: true, forKey: args.key }))
    const nonActionTools: NonActionToolMap = { recorded_lookup: recordedLookupTool(execute) }

    const queue: unknown[] = [
      { toolCalls: [{ toolName: 'recorded_lookup', input: { key: 'sign-in-step' } }], usage: { inputTokens: 5, outputTokens: 1 } },
      { toolCalls: [{ toolName: 'web_click', input: { ref: 'e1', ...CLICK_ENVELOPE } }], usage: { inputTokens: 10, outputTokens: 2 } },
    ]
    vi.mocked(generateText).mockImplementation(async () => queue.shift() as never)

    const planner = new LLMPlanner(
      {} as never,
      'web',
      undefined,
      undefined,
      makeFakeTokenAccounting(),
      undefined,
      nonActionTools,
    )
    const result = await planner.plan('Click log in', screen, makeContext())

    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledWith({ key: 'sign-in-step' })
    expect(result.plan.action.type).toBe('click')
    expect(result.plan.action.ref).toBe('e1')
    // The handler's result was fed back as an exchange the loop recorded.
    expect(result.exchanges).toEqual([
      { tool: 'recorded_lookup', args: { key: 'sign-in-step' }, result: { found: true, forKey: 'sign-in-step' } },
    ])
    // Seam proof: the synthesized non-action tool reached the always-send-all slice.
    const firstCall = vi.mocked(generateText).mock.calls[0][0] as { tools: Record<string, unknown> }
    expect(Object.keys(firstCall.tools)).toContain('recorded_lookup')
  })

  it('Test 2: omitting the param is byte-compatible — no non-action tool merged, an immediate action resolves as today', async () => {
    const { generateText } = await import('ai')
    vi.mocked(generateText).mockResolvedValueOnce({
      toolCalls: [{ toolName: 'web_click', input: { ref: 'e1', ...CLICK_ENVELOPE } }],
      usage: { inputTokens: 10, outputTokens: 2 },
    } as never)

    const planner = new LLMPlanner({} as never, 'web', undefined, undefined, makeFakeTokenAccounting())
    const result = await planner.plan('Click log in', screen, makeContext())

    expect(result.plan.action.type).toBe('click')
    expect(result.plan.action.ref).toBe('e1')
    // executePlanningTurn received undefined nonActionTools → nothing extra merged.
    const firstCall = vi.mocked(generateText).mock.calls[0][0] as { tools: Record<string, unknown> }
    expect(Object.keys(firstCall.tools)).not.toContain('recorded_lookup')
  })

  it('Test 3: a typed error thrown from a handler propagates out of plan() by identity (same instance)', async () => {
    const { generateText } = await import('ai')
    const miss = new RecordedExchangeMiss('sign-in-step')
    const execute = vi.fn(() => {
      throw miss
    })
    const nonActionTools: NonActionToolMap = { recorded_lookup: recordedLookupTool(execute) }

    vi.mocked(generateText).mockResolvedValueOnce({
      toolCalls: [{ toolName: 'recorded_lookup', input: { key: 'sign-in-step' } }],
      usage: { inputTokens: 5, outputTokens: 1 },
    } as never)

    const planner = new LLMPlanner(
      {} as never,
      'web',
      undefined,
      undefined,
      makeFakeTokenAccounting(),
      undefined,
      nonActionTools,
    )

    await expect(planner.plan('Click log in', screen, makeContext())).rejects.toBe(miss)
  })

  it('Test 4: PlanningTurnError is the same class across the runner barrel (instanceof-classifiable)', async () => {
    // The replay engine (plan 368-04) imports PlanningTurnError from the package entry and
    // instanceof-classifies structured planner failures — this must be the SAME class the
    // loop internals throw, or the classification silently misses.
    const barrel = await import('../../index.js')
    expect(barrel.PlanningTurnError).toBe(PlanningTurnError)
    const err = new PlanningTurnError('no_action_tool_called', 'x', [])
    expect(err instanceof barrel.PlanningTurnError).toBe(true)
  })
})
