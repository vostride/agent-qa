// the planner's stated target reaches the loop's
// pre-dispatch check from a real planning turn (`ai.generateText` mocked, the real LLMPlanner and
// gate run), on the descriptor lane and per drag lane, and a refusal sends nothing, is not debited
// as an action, and records both identities only after the declared-secret mask.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { asRef, readTargetRefusalMeta } from '@vostride/agent-qa-schema'
import type { ScreenState } from '@vostride/agent-qa-schema'
import type { Action, PlatformAdapter } from '../../platform.js'
import type { StepResult } from '../../result.js'
import { makeScreenState } from '../../testing/screen-fixtures.js'
import { executeStep } from '../index.js'
import { LLMPlanner } from '../planner.js'
import { SecretRedactor, SecretStore } from '../secrets.js'
import type { LoopPorts } from '../ports.js'
import type { ActionPlan, Planner, StepContext } from '../types.js'
import { makeFakeTokenAccounting, makeStepContext } from './loop-harness.js'

vi.mock('ai', async (importActual) => {
  const actual = await importActual<typeof import('ai')>()
  return { ...actual, generateText: vi.fn() }
})

const LOG_IN = { role: 'button', name: 'Log in' }

function click(ref: string, target: { role: string; name: string }) {
  return {
    toolCalls: [{
      toolName: 'web_click',
      input: {
        ref,
        target,
        reasoning: 'Click Log in',
        confidence: 0.9,
        stepComplete: true,
        doesActionAdvanceUsTowardsGoal: true,
      },
    }],
    usage: { inputTokens: 10, outputTokens: 2 },
  }
}

async function scriptModel(responses: unknown[]) {
  const { generateText } = await import('ai')
  const mock = vi.mocked(generateText)
  const queue = [...responses]
  mock.mockImplementation(async () => (queue.length > 1 ? queue.shift() : queue[0]) as never)
  return mock
}

function llmPlanner(): LLMPlanner {
  return new LLMPlanner({} as never, 'web', undefined, undefined, makeFakeTokenAccounting())
}

type RecordingAdapter = PlatformAdapter & { executed: Action[] }

function adapter(screen: ScreenState = makeScreenState()): RecordingAdapter {
  const executed: Action[] = []
  return {
    executed,
    platform: 'web',
    async setup() {},
    async cleanup() {},
    async observe() { return screen },
    async execute(action: Action) {
      executed.push(action)
      return { success: true }
    },
  }
}

function refOf(action: Action | undefined): unknown {
  return (action as { ref?: unknown } | undefined)?.ref
}

function plan(action: ActionPlan['action']): ActionPlan {
  return { reasoning: 'scripted', action, confidence: 0.9, stepComplete: true, stepFailed: false }
}

const GIVE_UP: ActionPlan = {
  reasoning: 'giving up',
  action: { type: 'delay', ms: 0 },
  confidence: 0.9,
  stepComplete: false,
  stepFailed: true,
}

function scriptedPlanner(
  turns: Array<ActionPlan | ((context: StepContext) => ActionPlan)>,
): Planner & { calls: number } {
  const planner = {
    calls: 0,
    async plan(_step: string, _screen: ScreenState, context: StepContext) {
      const turn = turns[Math.min(planner.calls, turns.length - 1)]
      planner.calls++
      return { plan: typeof turn === 'function' ? turn(context) : turn }
    },
  }
  return planner
}

const limits = (maxActions: number, maxPlanningTurns: number) => ({
  maxActions,
  maxPlanningTurns,
  previousStepCount: 0,
})

function refusal(result: StepResult, index = 0): Record<string, unknown> | undefined {
  return result.evidence?.subActions[index]?.result.metadata?.['targetRefusal'] as
    | Record<string, unknown>
    | undefined
}

describe('the stated-target check in the loop', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("a planning turn's ref plus target reaches the check", async () => {
    await scriptModel([click('e1', LOG_IN), click('e2', LOG_IN)])
    const a = adapter()
    const result = await executeStep(
      'Click Log in',
      { adapter: a, planner: llmPlanner(), plannerConfig: limits(10, 10) },
      makeStepContext(),
    )

    expect(result.status).toBe('passed')
    expect(refOf(a.executed[0])).toBe('e2')
    expect(a.executed).toHaveLength(1)
    expect(a.executed[0]?.type).toBe('click')
    expect(a.executed[0]).not.toHaveProperty('target')
    expect(refusal(result)).toMatchObject({
      kind: 'target-mismatch',
      lane: 'ref',
      path: 'live',
      stated: { role: 'button', name: 'Log in' },
      observed: { role: 'textbox', name: 'Email' },
      inputSent: false,
    })
    expect(refusal(result)?.['reasons']).toContain('role-kind')
    expect(refusal(result, 1)).toBeUndefined()
  })

  it('the descriptor lane is checked after a loose rung', async () => {
    const a = adapter()
    const result = await executeStep(
      'Click Email',
      {
        adapter: a,
        planner: scriptedPlanner([
          plan({ type: 'click', target: { role: 'button', name: 'Email' } }),
          GIVE_UP,
        ]),
        plannerConfig: limits(10, 10),
      },
      makeStepContext(),
    )

    expect(a.executed).toHaveLength(0)
    const first = result.evidence!.subActions[0]
    expect(first.result.error).toMatch(/^target-mismatch: /)
    expect(refusal(result)).toMatchObject({
      lane: 'ref',
      stated: { role: 'button', name: 'Email' },
      observed: { role: 'textbox', name: 'Email' },
      inputSent: false,
    })
    expect(refusal(result)?.['reasons']).toEqual(['role-kind'])
  })

  it('a drag is checked per lane', async () => {
    const a = adapter()
    const drag = {
      type: 'drag',
      fromRef: 'e1',
      fromTarget: { role: 'textbox', name: 'Email' },
      toRef: 'e2',
      toTarget: { role: 'textbox', name: 'Password' },
    }
    const result = await executeStep(
      'Drag Email onto Password',
      {
        adapter: a,
        planner: scriptedPlanner([plan(drag), GIVE_UP]),
        plannerConfig: limits(10, 10),
      },
      makeStepContext(),
    )

    expect(a.executed).toHaveLength(0)
    expect(refusal(result)).toMatchObject({
      lane: 'toRef',
      stated: { role: 'textbox', name: 'Password' },
      observed: { role: 'button', name: 'Log in' },
      inputSent: false,
    })
    expect(refusal(result)?.['reasons']).toContain('role-kind')
  })

  it('a refusal is not debited and the re-plan is a planning turn', async () => {
    const model = await scriptModel([click('e1', LOG_IN), click('e2', LOG_IN)])
    const a = adapter()
    const result = await executeStep(
      'Click Log in',
      {
        adapter: a,
        planner: llmPlanner(),
        plannerConfig: { maxActions: 1, maxPlanningTurns: 3, previousStepCount: 0 },
      },
      makeStepContext(),
    )

    expect(result.status).toBe('passed')
    expect(refOf(a.executed[0])).toBe('e2')
    expect(a.executed).toHaveLength(1)
    expect(model).toHaveBeenCalledTimes(2)
    expect(result.evidence?.limitUsage).toMatchObject({ actionsUsed: 1, planningCallsUsed: 2 })
  })

  it('both identities are redacted before record', async () => {
    const secret = 'zz-secret-label'
    const masked = 'zz-masked-word'
    const fieldRef = asRef('e1')
    const saveRef = asRef('e2')
    const base = makeScreenState()
    const screen = makeScreenState({
      elements: [
        {
          ...base.elements[0],
          ref: fieldRef,
          name: `${secret} ${masked}`,
          nameNormalized: secret,
          labels: {},
        },
        { ...base.elements[1], ref: saveRef, name: 'Save', nameNormalized: 'save', labels: {} },
      ],
    })
    const contexts: Array<string | undefined> = []
    const a = adapter(screen)
    const ports: LoopPorts = {
      adapter: a,
      planner: scriptedPlanner([
        plan({
          type: 'click',
          ref: 'e1',
          target: { role: 'button', name: `Open ${secret} ${masked}` },
        }),
        (context) => {
          contexts.push(context.failureContext)
          return GIVE_UP
        },
      ]),
      plannerConfig: limits(10, 10),
      secretRedactor: new SecretRedactor(new SecretStore({ FIELD_LABEL: secret, FIELD_WORD: masked })),
    }
    const result = await executeStep('Open the secret label', ports, makeStepContext())

    expect(a.executed).toHaveLength(0)
    const block = refusal(result)
    expect(block).toMatchObject({
      stated: { role: 'button', name: 'Open [secret:FIELD_LABEL] [secret:FIELD_WORD]' },
      observed: { role: 'textbox', name: '[secret:FIELD_LABEL] [secret:FIELD_WORD]' },
      inputSent: false,
    })
    const error = result.evidence!.subActions[0].result.error ?? ''
    expect(error).toMatch(/^target-mismatch: /)
    expect(contexts).toHaveLength(1)
    expect(contexts[0]).toContain('target-mismatch: ')
    for (const recorded of [JSON.stringify(block), error, contexts[0] ?? '']) {
      expect(recorded).not.toContain(secret)
      expect(recorded).not.toContain(masked)
    }
  })

  it('a recorded refusal reads back through the schema reader', async () => {
    const base = makeScreenState()
    const screen = makeScreenState({
      elements: [
        { ...base.elements[0], name: '', nameNormalized: '', labels: {} },
        { ...base.elements[1], name: 'Submit', nameNormalized: 'submit', labels: {} },
      ],
    })
    const a = adapter(screen)
    const result = await executeStep(
      'Click Submit',
      {
        adapter: a,
        planner: scriptedPlanner([
          plan({ type: 'click', ref: 'e1', target: { role: 'button', name: 'Submit' } }),
          GIVE_UP,
        ]),
        plannerConfig: limits(10, 10),
      },
      makeStepContext(),
    )

    expect(a.executed).toHaveLength(0)
    const meta = readTargetRefusalMeta(result.evidence?.subActions[0]?.result)
    expect(meta?.kind).toBe('target-mismatch')
    expect(meta).toMatchObject({
      kind: 'target-mismatch',
      lane: 'ref',
      path: 'live',
      stated: { role: 'button', name: 'Submit' },
      observed: { role: 'textbox', name: '' },
      rowStated: false,
      inputSent: false,
    })
    expect(meta?.reasons).toContain('role-kind')
  })

  it('the grounding evidence carries the exact name and the stated identity', async () => {
    const base = makeScreenState()
    const screen = makeScreenState({
      elements: [
        {
          ...base.elements[1],
          ref: asRef('e1'),
          role: 'link',
          name: 'Invoice 946',
          nameNormalized: 'invoice',
          labels: {},
        },
        {
          ...base.elements[1],
          ref: asRef('e2'),
          role: 'link',
          name: 'Invoice 947',
          nameNormalized: 'invoice',
          labels: {},
        },
      ],
    })
    const a = adapter(screen)
    const result = await executeStep(
      'Open invoice 947',
      {
        adapter: a,
        planner: scriptedPlanner([
          plan({ type: 'click', ref: 'e2', target: { role: 'link', name: 'Invoice 947' } }),
        ]),
        plannerConfig: limits(10, 10),
      },
      makeStepContext(),
    )

    expect(a.executed).toHaveLength(1)
    const grounding = result.evidence?.subActions[0]?.grounding
    expect(grounding?.descriptor.name).toBe('Invoice 947')
    expect(grounding?.descriptor).not.toHaveProperty('ordinal')
    expect(grounding?.stated).toEqual({ role: 'link', name: 'Invoice 947' })
    expect(grounding?.stated).not.toHaveProperty('row')
  })

  it('grounding evidence is redacted before record', async () => {
    const secret = 'zz-secret-label'
    const masked = 'zz-masked-word'
    const base = makeScreenState()
    const name = `Pay ${secret} ${masked}`
    const screen = makeScreenState({
      elements: [
        base.elements[0],
        { ...base.elements[1], name, nameNormalized: name.toLowerCase(), labels: {} },
      ],
    })
    const a = adapter(screen)
    const result = await executeStep(
      'Pay',
      {
        adapter: a,
        planner: scriptedPlanner([
          plan({ type: 'click', ref: 'e2', target: { role: 'button', name } }),
        ]),
        plannerConfig: limits(10, 10),
        secretRedactor: new SecretRedactor(new SecretStore({ FIELD_LABEL: secret, FIELD_WORD: masked })),
      },
      makeStepContext(),
    )

    expect(a.executed).toHaveLength(1)
    const grounding = result.evidence?.subActions[0]?.grounding
    expect(grounding?.stated?.name).toBe('Pay [secret:FIELD_LABEL] [secret:FIELD_WORD]')
    expect(grounding?.descriptor.name).toBe('Pay [secret:FIELD_LABEL] [secret:FIELD_WORD]')
    const recorded = JSON.stringify(grounding)
    expect(recorded).not.toContain(secret)
    expect(recorded).not.toContain(masked)
  })
})
