// RED scaffold (Wave 0, D-09 · Pitfall 8 · Q2). Pins the in-turn grounding-feedback
// contract on executePlanningTurn BEFORE the groundability seam exists. The turn gains
// an injected `groundability` callback (Plan 06): a parsed action that fails grounding
// returns an error-text tool result in the SAME conversation and the model corrects its
// next call; the turn contract becomes "exactly one GROUNDABLE action call". Two
// consecutive grounding failures ⇒ a structured PlanningTurnFailure reason
// 'ungroundable_action' (never a throw). The grounding retry is turn-local and NEVER
// consumes the K non-action budget. `schema_invalid` keeps its existing throw path (Q2).
//
// These fail because the current turn ignores an unknown `groundability` option and
// returns the first parsed action ungrounded — that failure IS the intended RED (GREEN
// when Plan 06 lands the callback + the 'ungroundable_action' reason).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tool } from 'ai'
import { z } from 'zod'
import { buildTools, defaultRegistry } from '../../tools/index.js'
import {
  executePlanningTurn,
  type ExecutePlanningTurnOptions,
  type NonActionToolHandler,
} from '../planning-turn.js'
import type { ActionPlan } from '../types.js'

vi.mock('ai', async (importActual) => {
  const actual = await importActual<typeof import('ai')>()
  return { ...actual, generateText: vi.fn() }
})

const ENVELOPE = { reasoning: 'go', confidence: 0.9, stepComplete: true, doesActionAdvanceUsTowardsGoal: true }
const USAGE = { inputTokens: 10, outputTokens: 2 }

const UNGROUNDABLE_MESSAGE =
  "no element matching { role:'button', name:'Save' } — re-observe or refine the descriptor"

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

// The Plan-06 groundability seam under test: a parsed plan whose action ref is 'e-bad'
// is ungroundable; everything else grounds. Returned as an extension of the options type
// so the local test is typed today and redundant (harmless) once Plan 06 adds the field.
type GroundabilityResult = { ok: true } | { ok: false; message: string }
type GroundedTurnOptions = ExecutePlanningTurnOptions & {
  groundability?: (plan: ActionPlan) => GroundabilityResult
}

function fakeGroundability(): (plan: ActionPlan) => GroundabilityResult {
  return (plan) => {
    const ref = (plan.action as { ref?: string }).ref
    return ref === 'e-bad' ? { ok: false, message: UNGROUNDABLE_MESSAGE } : { ok: true }
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

function turnOptions(overrides: Partial<GroundedTurnOptions> = {}): GroundedTurnOptions {
  return {
    model: {} as never,
    registry: defaultRegistry,
    actionTools: buildTools(defaultRegistry, { platform: 'web' }),
    system: 'system prompt',
    messages: [{ role: 'user', content: 'do the thing' }],
    groundability: fakeGroundability(),
    ...overrides,
  }
}

async function generateTextCalls() {
  const { generateText } = await import('ai')
  return vi.mocked(generateText).mock.calls as { 0: { messages: unknown[] } }[]
}

describe('executePlanningTurn — in-turn grounding feedback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    toolCallSeq = 0
  })

  it('injects an error-text tool result for an ungroundable action and the corrected next call succeeds', async () => {
    await scriptResponses([
      { toolCalls: [actionCall('web_click', { ref: 'e-bad', ...ENVELOPE })], usage: USAGE }, // ungroundable
      { toolCalls: [actionCall('web_click', { ref: 'e1', ...ENVELOPE })], usage: USAGE }, // corrected
    ])

    const res = await executePlanningTurn(turnOptions())

    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected success')
    expect(res.plan.action.ref).toBe('e1')
    const { generateText } = await import('ai')
    expect(generateText).toHaveBeenCalledTimes(2) // the retry happened in the same turn
    const calls = await generateTextCalls()
    expect(JSON.stringify(calls[1][0].messages)).toContain('no element matching')
  })

  it('two consecutive grounding failures return a structured ungroundable_action failure, never a throw', async () => {
    await scriptResponses([
      { toolCalls: [actionCall('web_click', { ref: 'e-bad', ...ENVELOPE })], usage: USAGE },
      { toolCalls: [actionCall('web_click', { ref: 'e-bad', ...ENVELOPE })], usage: USAGE },
    ])

    const res = await executePlanningTurn(turnOptions())

    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected failure')
    expect(res.reason).toBe('ungroundable_action')
  })

  it('the grounding retry is independent of the K budget — it still runs with budget 0', async () => {
    await scriptResponses([
      { toolCalls: [actionCall('web_click', { ref: 'e-bad', ...ENVELOPE })], usage: USAGE },
      { toolCalls: [actionCall('web_click', { ref: 'e1', ...ENVELOPE })], usage: USAGE },
    ])

    const res = await executePlanningTurn(turnOptions({ budget: 0 }))

    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected success')
    expect(res.plan.action.ref).toBe('e1')
  })

  it('interleaves a non-action call before a grounding retry without tripping the iteration backstop', async () => {
    const note = fakeNonActionTool()
    await scriptResponses([
      { toolCalls: [nonActionCall('fake_note', { q: 'a' })], usage: USAGE }, // non-action (1 of K)
      { toolCalls: [actionCall('web_click', { ref: 'e-bad', ...ENVELOPE })], usage: USAGE }, // ungroundable → retry
      { toolCalls: [actionCall('web_click', { ref: 'e1', ...ENVELOPE })], usage: USAGE }, // corrected
    ])

    const res = await executePlanningTurn(turnOptions({ nonActionTools: { fake_note: note } }))

    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected success')
    expect(res.plan.action.ref).toBe('e1')
    expect(res.exchanges).toHaveLength(1) // the non-action call ran; the grounding retry did not consume budget
    expect(note.execute).toHaveBeenCalledTimes(1)
  })

  it('preserves the schema_invalid throw path — malformed args are NOT converted to in-turn feedback', async () => {
    // web_fill requires `text`; omitting it makes toolCallToActionPlan throw schema_invalid.
    await scriptResponses([
      { toolCalls: [actionCall('web_fill', { ref: 'e1', ...ENVELOPE })], usage: USAGE },
    ])

    await expect(executePlanningTurn(turnOptions())).rejects.toThrow()
  })
})
