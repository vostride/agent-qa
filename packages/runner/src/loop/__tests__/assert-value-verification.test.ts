// A passing assertValue is judged by the verifier, with its read as cited evidence.

import { describe, expect, it } from 'vitest'
import type { ScreenState } from '@vostride/agent-qa-schema'
import type { Action, ActionResult, PlatformAdapter } from '../../platform.js'
import { makeScreenState } from '../../testing/screen-fixtures.js'
import { executeStep } from '../index.js'
import type { LoopPorts } from '../ports.js'
import type { ConditionJudgment, VerificationResult, Verifier } from '../types.js'
import { makeActionPlan, makePlanner, makeStepContext } from './loop-harness.js'

const URL_READ = 'url contains "/orders": passed'

function readingAdapter(read: ActionResult): PlatformAdapter & { executed: Action[] } {
  const executed: Action[] = []
  return {
    executed,
    platform: 'web',
    async setup() {},
    async cleanup() {},
    async observe(): Promise<ScreenState> {
      return makeScreenState({
        tree: ['[Viewport: 390x844] [1 elements]', '- heading "Your orders" [ref=e1]'].join('\n'),
      })
    },
    async execute(action: Action): Promise<ActionResult> {
      executed.push(action)
      return read
    },
  }
}

function condition(quote: string, overrides: Partial<ConditionJudgment>): ConditionJudgment {
  return {
    quote,
    verdict: 'met',
    needs: 'none',
    controlRef: '',
    file: { name: '', match: 'none', text: '' },
    citations: [],
    reasoning: '',
    ...overrides,
  }
}

function recordingVerifier(result: VerificationResult): Verifier & { actions: Action[] } {
  const actions: Action[] = []
  return {
    actions,
    async verify(_step, _before, _after, action) {
      actions.push(action)
      return { verification: result }
    },
  }
}

const assertUrl = makeActionPlan({
  reasoning: 'The URL ends with /orders',
  action: { type: 'assertValue', source: 'url', op: 'contains', expected: '/orders' } as never,
  stepComplete: true,
})

const giveUp = makeActionPlan({
  reasoning: 'The total could not be read',
  stepComplete: false,
  stepFailed: true,
})

function ports(overrides: Partial<LoopPorts> & Pick<LoopPorts, 'adapter' | 'planner'>): LoopPorts {
  return { plannerConfig: { maxActions: 4, maxPlanningTurns: 4, previousStepCount: 0 }, ...overrides }
}

describe('assertValue reads as evidence for requested conditions', () => {
  it('two requested things cannot pass on one check', async () => {
    const step = 'Verify the URL ends with /orders and the total is 42.50'
    const adapter = readingAdapter({ success: true, data: 'https://shop.test/orders' })
    const verifier = recordingVerifier({
      conditions: [
        condition('Verify the URL ends with /orders', {
          citations: [{ source: 'read', quote: URL_READ }],
          reasoning: 'The URL read passed',
        }),
        condition('the total is 42.50', { verdict: 'unverified', reasoning: 'no total was read' }),
      ],
      dialogs: [],
      isAppError: false,
      reasoning: 'Only the URL was checked',
    })
    const result = await executeStep(
      step,
      ports({ adapter, planner: makePlanner([assertUrl, giveUp]), verifier }),
      makeStepContext({ stepInstruction: step }),
    )
    expect(result.status).not.toBe('passed')
    expect(verifier.actions.length).toBeGreaterThanOrEqual(1)
    expect(verifier.actions[0].type).toBe('assertValue')
    expect(result.evidence?.verdictSource).toBeUndefined()
    expect(result.evidence?.assertOutcome).toMatchObject({ source: 'url', op: 'contains', passed: true })
    const verdicts = result.evidence?.conditionVerdicts?.conditions ?? []
    expect(verdicts.map((c) => c.verdict)).toEqual(['met', 'unverified'])
  })

  it('a passing read is cited evidence for its own condition', async () => {
    const step = 'Verify the URL ends with /orders'
    const adapter = readingAdapter({ success: true, data: 'https://shop.test/orders' })
    const verifier = recordingVerifier({
      conditions: [
        condition(step, {
          citations: [{ source: 'read', quote: URL_READ }],
          reasoning: 'The URL read passed',
        }),
      ],
      dialogs: [],
      isAppError: false,
      reasoning: 'The URL ends with /orders',
    })
    const result = await executeStep(
      step,
      ports({ adapter, planner: makePlanner([assertUrl]), verifier }),
      makeStepContext({ stepInstruction: step }),
    )
    expect(result.status).toBe('passed')
    expect(verifier.actions).toHaveLength(1)
    expect(result.evidence?.verdictSource).toBe('verifier-model')
    expect(result.evidence?.conditionVerdicts?.ending).toBe('completion')
    expect(result.evidence?.conditionVerdicts?.conditions[0].citations[0]).toEqual({
      source: 'read',
      quote: URL_READ,
      found: true,
    })
  })

  it('setVariable with stepComplete stays call-free', async () => {
    const adapter = readingAdapter({ success: true })
    const verifier = recordingVerifier({ conditions: [], dialogs: [], isAppError: false, reasoning: '' })
    const set: Record<string, string> = {}
    const result = await executeStep(
      'Remember the order number as ORDER',
      ports({
        adapter,
        planner: makePlanner([
          makeActionPlan({
            action: { type: 'setVariable', name: 'ORDER', value: '1042' } as never,
            stepComplete: true,
          }),
        ]),
        verifier,
        onSetVariable: (name, value) => { set[name] = value },
      }),
      makeStepContext(),
    )
    expect(result.status).toBe('passed')
    expect(verifier.actions).toHaveLength(0)
    expect(set).toEqual({ ORDER: '1042' })
    expect(result.evidence?.limitUsage?.verifierCalls).toBe(0)
  })
})
