import { describe, it, expect } from 'vitest'
import type { PlatformAdapter, ScreenState, Action, ActionResult } from '../../types/platform.js'
import type { ActionPlan } from '../../schema/action-schema.js'
import type { Planner, Verifier, VerificationResult, AgentLoopConfig, StepContext } from '../types.js'
import { executeStep } from '../loop.js'

function makeScreenState(overrides?: Partial<ScreenState>): ScreenState {
  return {
    tree: 'button "Login" [ref=btn-1]\ninput "Email" [ref=input-1]',
    elements: [
      { ref: 'btn-1', role: 'button', name: 'Login', attributes: {} },
      { ref: 'input-1', role: 'textbox', name: 'Email', attributes: {} },
    ],
    url: 'https://example.com/login',
    timestamp: Date.now(),
    metadata: { coordSpace: 'viewport' as const, viewportWidth: 0, viewportHeight: 0 },
    ...overrides,
  }
}

function makeActionPlan(overrides?: Partial<ActionPlan>): ActionPlan {
  return {
    reasoning: 'Clicking Login button to submit credentials',
    action: { type: 'click', ref: 'btn-1' },
    confidence: 0.95,
    stepComplete: true,
    stepFailed: false,
    ...overrides,
  }
}

function makeStepContext(overrides?: Partial<StepContext>): StepContext {
  return {
    stepInstruction: 'Click Login',
    testName: 'Trace test',
    previousSteps: [],
    plannerModel: {} as any,
    verifierModel: {} as any,
    healingConfig: { maxAttempts: 3 },
    ...overrides,
  }
}

function createMockAdapter(options?: {
  observeResults?: ScreenState[]
  executeResults?: ActionResult[]
}): PlatformAdapter {
  let observeCallCount = 0
  let executeCallCount = 0
  const observeResults = options?.observeResults ?? [makeScreenState()]
  const executeResults = options?.executeResults ?? [{ success: true }]

  return {
    platform: 'web',
    async setup() {},
    async cleanup() {},
    async observe() {
      const idx = Math.min(observeCallCount, observeResults.length - 1)
      observeCallCount++
      return observeResults[idx]
    },
    async execute(_action: Action) {
      const idx = Math.min(executeCallCount, executeResults.length - 1)
      executeCallCount++
      return executeResults[idx]
    },
  }
}

function createMockPlanner(plans?: ActionPlan[]): Planner {
  let callCount = 0
  const planList = plans ?? [makeActionPlan()]
  return {
    async plan() {
      const idx = Math.min(callCount, planList.length - 1)
      callCount++
      return { plan: planList[idx] }
    },
  }
}

function createMockVerifier(results?: VerificationResult[]): Verifier {
  let callCount = 0
  const resultList = results ?? [{ success: true, reasoning: 'OK', isAppError: false }]
  return {
    async verify() {
      const idx = Math.min(callCount, resultList.length - 1)
      callCount++
      return { verification: resultList[idx] }
    },
  }
}

function makeConfig(overrides?: Partial<AgentLoopConfig>): AgentLoopConfig {
  return {
    adapter: createMockAdapter(),
    planner: createMockPlanner(),
    healingConfig: { maxAttempts: 3 },
    ...overrides,
  }
}

describe('step trace emission', () => {
  it('successful step includes trace with observation, reasoning, action, result=success', async () => {
    const screenBefore = makeScreenState()
    const screenAfter = makeScreenState({ url: 'https://example.com/dashboard' })

    const adapter = createMockAdapter({
      observeResults: [screenBefore, screenAfter],
      executeResults: [{ success: true }],
    })

    const plan = makeActionPlan({
      reasoning: 'Clicking Login to authenticate',
    })
    const planner = createMockPlanner([plan])

    const verifier = createMockVerifier([
      { success: true, reasoning: 'Login succeeded', isAppError: false },
    ])

    const config = makeConfig({ adapter, planner, verifier })
    const context = makeStepContext()

    const result = await executeStep('Click Login', config, context)

    expect(result.status).toBe('passed')
    expect(result.trace).toBeDefined()
    expect(result.trace!.observation).toBeDefined()
    expect(result.trace!.reasoning).toBe('Clicking Login to authenticate')
    expect(result.trace!.plannedAction).toEqual({ type: 'click', ref: 'btn-1' })
    expect(result.trace!.result).toBe('success')
    expect(result.trace!.error).toBeUndefined()
    expect(result.trace!.screenStateBefore).toBeDefined()
    expect(result.trace!.screenStateAfter).toBeDefined()
  })

  it('failed step includes trace with result=failure and error', async () => {
    const adapter = createMockAdapter({
      executeResults: [{ success: false, error: 'Element not found' }],
    })

    const plan = makeActionPlan({
      reasoning: 'Attempting to click missing button',
    })
    const planner = createMockPlanner([plan])

    // No verifier — uses ActionResult.success directly
    const config = makeConfig({
      adapter,
      planner,
      healingConfig: { maxAttempts: 0 },
    })
    const context = makeStepContext()

    const result = await executeStep('Click Missing Button', config, context)

    expect(result.status).toBe('failed')
    expect(result.trace).toBeDefined()
    expect(result.trace!.result).toBe('failure')
    expect(result.trace!.error).toBeDefined()
    expect(result.trace!.reasoning).toBe('Attempting to click missing button')
    expect(result.trace!.plannedAction).toEqual({ type: 'click', ref: 'btn-1' })
  })

  it('replanned step includes trace from the successful attempt', async () => {
    const screen1 = makeScreenState()
    const screen2 = makeScreenState({
      elements: [
        { ref: 'btn-2', role: 'button', name: 'Login', attributes: {} },
      ],
    })

    const adapter = createMockAdapter({
      observeResults: [screen1, screen2, screen2],
      executeResults: [
        { success: false, error: 'Wrong element' },
        { success: true },
      ],
    })

    const plan1 = makeActionPlan({
      reasoning: 'First attempt — wrong ref',
      action: { type: 'click', ref: 'btn-1' },
    })
    const plan2 = makeActionPlan({
      reasoning: 'Healed — correct ref',
      action: { type: 'click', ref: 'btn-2' },
    })
    const planner = createMockPlanner([plan1, plan2])

    const config = makeConfig({ adapter, planner })
    const context = makeStepContext()

    const result = await executeStep('Click Login', config, context)

    expect(result.status).toBe('passed')
    expect(result.trace).toBeDefined()
    expect(result.trace!.result).toBe('success')
    // Trace should reflect the successful replanned action
    expect(result.trace!.plannedAction).toEqual({ type: 'click', ref: 'btn-2' })
  })
})
