import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tool } from 'ai'
import { z } from 'zod'
import { buildTools, defaultRegistry } from '../../tools/index.js'
import {
  executePlanningTurn,
  DEFAULT_NON_ACTION_TOOL_BUDGET,
  type ExecutePlanningTurnOptions,
  type NonActionToolHandler,
} from '../planning-turn.js'

vi.mock('ai', async (importActual) => {
  const actual = await importActual<typeof import('ai')>()
  return { ...actual, generateText: vi.fn() }
})

const ENVELOPE = { reasoning: 'go', confidence: 0.9, stepComplete: true, doesActionAdvanceUsTowardsGoal: true }
const USAGE = { inputTokens: 10, outputTokens: 2 }

let toolCallSeq = 0
function actionCall(toolName: string, input: Record<string, unknown>) {
  return { type: 'tool-call', toolCallId: `tc-${++toolCallSeq}`, toolName, input }
}
function nonActionCall(toolName: string, input: Record<string, unknown>) {
  return { type: 'tool-call', toolCallId: `tc-${++toolCallSeq}`, toolName, input }
}

function fakeNonActionTool(): NonActionToolHandler {
  return {
    tool: tool({ description: 'fake non-action tool', inputSchema: z.object({ q: z.string().optional() }) }),
    execute: vi.fn((args: Record<string, unknown>) => ({ echoed: args })),
  }
}

async function scriptResponses(responses: unknown[]) {
  const { generateText } = await import('ai')
  const queue = [...responses]
  vi.mocked(generateText).mockImplementation(async () => {
    const next = queue.shift()
    if (!next) throw new Error('scripted response queue exhausted')
    return next as never
  })
}

function turnOptions(overrides: Partial<ExecutePlanningTurnOptions> = {}): ExecutePlanningTurnOptions {
  return {
    model: {} as never,
    registry: defaultRegistry,
    actionTools: buildTools(defaultRegistry, { platform: 'web' }),
    system: 'system prompt',
    messages: [{ role: 'user', content: 'do the thing' }],
    ...overrides,
  }
}

async function generateTextCalls() {
  const { generateText } = await import('ai')
  return vi.mocked(generateText).mock.calls as { 0: { messages: unknown[] } }[]
}

describe('executePlanningTurn', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    toolCallSeq = 0
  })

  it('exposes K as an internal constant defaulting to 4', () => {
    expect(DEFAULT_NON_ACTION_TOOL_BUDGET).toBe(4)
  })

  it('records the provider unsupported seed warning on the call record', async () => {
    await scriptResponses([{
      toolCalls: [actionCall('web_click', { ref: 'e1', ...ENVELOPE })],
      usage: USAGE,
      warnings: [{ type: 'unsupported', feature: 'seed' }],
    }])

    const res = await executePlanningTurn(turnOptions({ sampling: { seed: 11 } }))

    expect(res.ok).toBe(true)
    expect(res.callRecord?.unsupportedFeatures).toEqual(['seed'])
    const { generateText } = await import('ai')
    expect(vi.mocked(generateText).mock.calls[0]![0].seed).toBe(11)
  })

  it.each([[], undefined])('omits unsupported features when warnings are %j', async warnings => {
    await scriptResponses([{
      toolCalls: [actionCall('web_click', { ref: 'e1', ...ENVELOPE })],
      usage: USAGE,
      ...(warnings !== undefined ? { warnings } : {}),
    }])

    const res = await executePlanningTurn(turnOptions({ sampling: { seed: 11 } }))

    expect(res.ok).toBe(true)
    expect(res.callRecord).not.toHaveProperty('unsupportedFeatures')
  })

  it('sorts and deduplicates unsupported features across two tool-loop rounds', async () => {
    const note = fakeNonActionTool()
    await scriptResponses([
      {
        toolCalls: [nonActionCall('fake_note', { q: 'a' })],
        usage: USAGE,
        warnings: [
          { type: 'unsupported', feature: 'temperature' },
          { type: 'unsupported', feature: 'seed' },
        ],
      },
      {
        toolCalls: [actionCall('web_click', { ref: 'e1', ...ENVELOPE })],
        usage: USAGE,
        warnings: [
          { type: 'unsupported', feature: 'topP' },
          { type: 'unsupported', feature: 'seed' },
        ],
      },
    ])

    const res = await executePlanningTurn(turnOptions({ nonActionTools: { fake_note: note } }))

    expect(res.ok).toBe(true)
    expect(note.execute).toHaveBeenCalledTimes(1)
    expect(await generateTextCalls()).toHaveLength(2)
    expect(res.callRecord?.unsupportedFeatures).toEqual(['seed', 'temperature', 'topP'])
  })

  it('ignores other and compatibility warnings even when they mention seed', async () => {
    await scriptResponses([{
      toolCalls: [actionCall('web_click', { ref: 'e1', ...ENVELOPE })],
      usage: USAGE,
      warnings: [
        { type: 'other', message: 'seed is mentioned here' },
        { type: 'compatibility', feature: 'seed' },
      ],
    }])

    const res = await executePlanningTurn(turnOptions({ sampling: { seed: 11 } }))

    expect(res.ok).toBe(true)
    expect(res.callRecord).not.toHaveProperty('unsupportedFeatures')
  })

  it('preserves an earlier unsupported seed warning on a later structured failure', async () => {
    await scriptResponses([
      { toolCalls: [], warnings: [{ type: 'unsupported', feature: 'seed' }] },
      { toolCalls: [], warnings: [] },
    ])

    const res = await executePlanningTurn(turnOptions({ sampling: { seed: 11 } }))

    expect(res).toMatchObject({ ok: false, reason: 'no_action_tool_called' })
    expect(res.callRecord?.unsupportedFeatures).toEqual(['seed'])
  })

  it.each([
    ['reports', { finalStep: { response: { modelId: 'resolved-unscoped-model' } } }],
    ['omits', {}],
  ] as const)('PLANNING-TURN-UNSCOPED-IDENTITY: an unscoped turn keeps the SDK response model id when it %s one', async (_label, response) => {
    await scriptResponses([{
      toolCalls: [actionCall('web_click', { ref: 'e1', ...ENVELOPE })],
      usage: USAGE,
      ...response,
    }])

    const res = await executePlanningTurn(turnOptions())

    expect(res.ok).toBe(true)
    if ('finalStep' in response) expect(res.callRecord?.resolvedModelId).toBe('resolved-unscoped-model')
    else expect(res.callRecord).not.toHaveProperty('resolvedModelId')
  })

  it('Test 1: an immediate action call returns the plan with zero exchanges (v1 one-shot path)', async () => {
    await scriptResponses([{ toolCalls: [actionCall('web_click', { ref: 'e1', ...ENVELOPE })], usage: USAGE }])

    const res = await executePlanningTurn(turnOptions())

    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected success')
    expect(res.plan.action.type).toBe('click')
    expect(res.plan.action.ref).toBe('e1')
    expect(res.exchanges).toHaveLength(0)
    expect(res.tokenUsage).toEqual({ promptTokens: 10, completionTokens: 2, totalTokens: 12 })
  })

  it('Test 2: two non-action calls then an action execute in order with exchanges recorded', async () => {
    const note = fakeNonActionTool()
    const search = fakeNonActionTool()
    await scriptResponses([
      { toolCalls: [nonActionCall('fake_note', { q: 'a' })], usage: USAGE },
      { toolCalls: [nonActionCall('fake_search', { q: 'b' })], usage: USAGE },
      { toolCalls: [actionCall('web_click', { ref: 'e1', ...ENVELOPE })], usage: USAGE },
    ])

    const res = await executePlanningTurn(turnOptions({ nonActionTools: { fake_note: note, fake_search: search } }))

    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected success')
    expect(res.plan.action.type).toBe('click')
    expect(res.exchanges).toEqual([
      { tool: 'fake_note', args: { q: 'a' }, result: { echoed: { q: 'a' } } },
      { tool: 'fake_search', args: { q: 'b' }, result: { echoed: { q: 'b' } } },
    ])
    expect(note.execute).toHaveBeenCalledTimes(1)
    expect(search.execute).toHaveBeenCalledTimes(1)
  })

  it('binds a dotted logical id to an API-safe name and reverse-maps evidence and execution', async () => {
    const search = fakeNonActionTool()
    const { generateText } = await import('ai')
    let providerName = ''
    vi.mocked(generateText)
      .mockImplementationOnce(async (options) => {
        const tools = options.tools as Record<string, unknown>
        providerName = Object.keys(tools).find((name) => tools[name] === search.tool) ?? ''
        expect(providerName).not.toBe('memory.search')
        expect(providerName).toMatch(/^[A-Za-z0-9_-]+$/)
        expect(providerName.length).toBeLessThanOrEqual(64)
        return {
          toolCalls: [nonActionCall(providerName, { q: 'checkout' })],
          usage: USAGE,
        } as never
      })
      .mockResolvedValueOnce({
        toolCalls: [actionCall('web_click', { ref: 'e1', ...ENVELOPE })],
        usage: USAGE,
      } as never)

    const res = await executePlanningTurn(turnOptions({
      nonActionTools: { 'memory.search': search },
    }))

    expect(res.ok).toBe(true)
    expect(res.exchanges).toEqual([{
      tool: 'memory.search',
      args: { q: 'checkout' },
      result: { echoed: { q: 'checkout' } },
    }])
    const calls = await generateTextCalls()
    expect(JSON.stringify(calls[1][0].messages)).toContain(providerName)
    expect(JSON.stringify(calls[1][0].messages)).not.toContain('memory.search')
  })

  it('Test 3: the over-budget call gets the exhausted result; a further non-action-only response fails, no throw', async () => {
    const note = fakeNonActionTool()
    const withinBudget = Array.from({ length: DEFAULT_NON_ACTION_TOOL_BUDGET }, (_, index) => ({
      toolCalls: [nonActionCall('fake_note', { q: String(index + 1) })],
      usage: USAGE,
    }))
    await scriptResponses([
      ...withinBudget,
      { toolCalls: [nonActionCall('fake_note', { q: 'over-budget' })], usage: USAGE },
      { toolCalls: [nonActionCall('fake_note', { q: 'still-no-action' })], usage: USAGE },
    ])

    const res = await executePlanningTurn(turnOptions({ nonActionTools: { fake_note: note } }))

    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected failure')
    expect(res.reason).toBe('non_action_tool_budget_exhausted')
    expect(res.exchanges).toHaveLength(DEFAULT_NON_ACTION_TOOL_BUDGET)
    expect(note.execute).toHaveBeenCalledTimes(DEFAULT_NON_ACTION_TOOL_BUDGET)
    // The call after the over-budget response carries its structured exhausted result.
    const calls = await generateTextCalls()
    expect(
      JSON.stringify(calls[DEFAULT_NON_ACTION_TOOL_BUDGET + 1][0].messages),
    ).toContain('Tool budget exhausted')
  })

  it('Test 4: a text-only response triggers exactly one re-prompt then a planning failure', async () => {
    await scriptResponses([
      { toolCalls: [], usage: USAGE },
      { toolCalls: [], usage: USAGE },
    ])

    const res = await executePlanningTurn(turnOptions())

    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected failure')
    expect(res.reason).toBe('no_action_tool_called')
    const { generateText } = await import('ai')
    expect(generateText).toHaveBeenCalledTimes(2)
    const calls = await generateTextCalls()
    expect(JSON.stringify(calls[1][0].messages)).toContain('must call exactly one action tool')
  })

  it('a tool-choice violation is a text-only answer: one re-prompt, then no_action_tool_called with its usage', async () => {
    const { generateText, ToolChoiceViolationError } = await import('ai')
    vi.mocked(generateText).mockImplementation(async (options) => {
      await options.onLanguageModelCallEnd?.({
        usage: USAGE,
        modelId: 'responding-model',
      } as never)
      throw new ToolChoiceViolationError({
        toolChoice: { type: 'required' },
        finishReason: 'stop',
        provider: 'test',
        modelId: 'requested-model',
        content: [{ type: 'text', text: 'I would click the button.' }],
      })
    })

    const res = await executePlanningTurn(turnOptions())

    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected failure')
    expect(res.reason).toBe('no_action_tool_called')
    expect(generateText).toHaveBeenCalledTimes(2)
    const calls = await generateTextCalls()
    expect(JSON.stringify(calls[1][0].messages)).toContain('must call exactly one action tool')
    expect(res.tokenUsage).toEqual({ promptTokens: 20, completionTokens: 4, totalTokens: 24 })
    expect(res.callRecord?.resolvedModelId).toBe('responding-model')
  })

  it('any other model error rejects the turn unchanged', async () => {
    const { generateText } = await import('ai')
    const failure = new Error('provider unavailable')
    vi.mocked(generateText).mockRejectedValue(failure)

    await expect(executePlanningTurn(turnOptions())).rejects.toBe(failure)
    expect(generateText).toHaveBeenCalledTimes(1)
  })

  it('Test 5: [non-action, action, action] processes the first, terminates on the second, discards the third', async () => {
    const note = fakeNonActionTool()
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    await scriptResponses([
      {
        toolCalls: [
          nonActionCall('fake_note', { q: 'x' }),
          actionCall('web_click', { ref: 'e1', ...ENVELOPE }),
          actionCall('web_click', { ref: 'e2', ...ENVELOPE }),
        ],
        usage: USAGE,
      },
    ])

    const res = await executePlanningTurn(turnOptions({ nonActionTools: { fake_note: note }, logger }))

    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected success')
    expect(res.plan.action.ref).toBe('e1') // terminated on the first action
    expect(res.exchanges).toHaveLength(1) // the leading non-action call ran
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Discarded tool calls'),
      expect.objectContaining({ discarded: 1 }),
    )
  })

  it('Test 6: K is injectable — with budget 0 the first non-action call gets the exhausted error', async () => {
    const note = fakeNonActionTool()
    await scriptResponses([
      { toolCalls: [nonActionCall('fake_note', { q: 'z' })], usage: USAGE }, // over budget immediately
      { toolCalls: [actionCall('web_click', { ref: 'e1', ...ENVELOPE })], usage: USAGE },
    ])

    const res = await executePlanningTurn(turnOptions({ nonActionTools: { fake_note: note }, budget: 0 }))

    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected success')
    expect(note.execute).not.toHaveBeenCalled() // over budget → never executed
    expect(res.exchanges).toHaveLength(0)
    const calls = await generateTextCalls()
    expect(JSON.stringify(calls[1][0].messages)).toContain('Tool budget exhausted')
  })

  it('a bound gate debits each model call and a refused debit ends the turn with planning_limit_reached', async () => {
    const note = fakeNonActionTool()
    await scriptResponses([
      { toolCalls: [nonActionCall('fake_note', { q: 'a' })], usage: USAGE },
      { toolCalls: [actionCall('web_click', { ref: 'e1', ...ENVELOPE })], usage: USAGE },
    ])
    let allowed = 1
    let debits = 0
    const gate = { tryDebitPlanningCall: () => { debits++; return allowed-- > 0 } }

    const res = await executePlanningTurn(turnOptions({ nonActionTools: { fake_note: note }, planningCallGate: gate }))

    expect(res).toMatchObject({ ok: false, reason: 'planning_limit_reached', message: 'planning-turn limit reached' })
    if (res.ok) throw new Error('expected failure')
    expect(res.exchanges).toHaveLength(1)
    expect(debits).toBe(2)
    const calls = await generateTextCalls()
    expect(calls).toHaveLength(1)
  })
})
