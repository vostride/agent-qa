import { describe, it, expect } from 'vitest'
import type { PlatformAdapter, ScreenState, Action, ActionResult } from '../../types/platform.js'
import type { ActionPlan } from '../../schema/action-schema.js'
import type { Planner, Verifier, VerificationResult, AgentLoopConfig, StepContext, HealingConfig } from '../types.js'
import { executeStep } from '../loop.js'

function makeScreenState(overrides?: Partial<ScreenState>): ScreenState {
  return {
    tree: 'button "Sign In" [ref=btn-1]\ninput "Email" [ref=input-1]',
    elements: [
      { ref: 'btn-1', role: 'button', name: 'Sign In', attributes: {} },
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
    reasoning: 'Clicking the Sign In button',
    action: { type: 'click', ref: 'btn-1' },
    confidence: 0.95,
    stepComplete: true,
    stepFailed: false,
    ...overrides,
  }
}

function makeStepContext(overrides?: Partial<StepContext>): StepContext {
  return {
    stepInstruction: 'Click the Sign In button',
    testName: 'Login test',
    previousSteps: [],
    plannerModel: {} as any,
    verifierModel: {} as any,
    healingConfig: { maxAttempts: 3 },
    ...overrides,
  }
}

function createMockAdapter(options?: {
  observeResults?: ScreenState[]
  executeResult?: ActionResult
  executeResults?: ActionResult[]
}): PlatformAdapter {
  let observeCallCount = 0
  let executeCallCount = 0
  const observeResults = options?.observeResults ?? [makeScreenState()]
  const executeResults = options?.executeResults
  const singleExecuteResult = options?.executeResult ?? { success: true }

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
      if (executeResults) {
        const idx = Math.min(executeCallCount, executeResults.length - 1)
        executeCallCount++
        return executeResults[idx]
      }
      executeCallCount++
      return singleExecuteResult
    },
  }
}

function createMockPlanner(plans?: ActionPlan[]): Planner {
  let callCount = 0
  const planList = plans ?? [makeActionPlan()]

  return {
    async plan(_step: string, _screenState: ScreenState, _context: StepContext) {
      const idx = Math.min(callCount, planList.length - 1)
      callCount++
      return { plan: planList[idx] }
    },
  }
}

function createMockVerifier(results?: VerificationResult[]): Verifier {
  let callCount = 0
  const resultList = results ?? [{ success: true, reasoning: 'Step completed', isAppError: false }]

  return {
    async verify(_step: string, _before: ScreenState, _after: ScreenState, _action: Action) {
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

describe('Verifier integration with loop', () => {
  it('verifier returns success → StepResult status is passed', async () => {
    const screen = makeScreenState()
    const adapter = createMockAdapter({
      observeResults: [screen, screen],
      executeResult: { success: true },
    })

    const verifier = createMockVerifier([
      { success: true, reasoning: 'Step goal accomplished', isAppError: false },
    ])

    const config = makeConfig({ adapter, verifier })
    const context = makeStepContext()

    const result = await executeStep('Click the Sign In button', config, context)

    expect(result.status).toBe('passed')
    expect(result.healingAttempts).toBeUndefined()
  })

  it('verifier returns app error → StepResult status is failed, no healing attempted', async () => {
    const screen = makeScreenState()
    const adapter = createMockAdapter({
      observeResults: [screen, screen],
      executeResult: { success: true },
    })

    const verifier = createMockVerifier([
      { success: false, reasoning: 'HTTP 500 Internal Server Error detected', isAppError: true },
    ])

    const config = makeConfig({ adapter, verifier })
    const context = makeStepContext()

    const result = await executeStep('Click the Sign In button', config, context)

    expect(result.status).toBe('failed')
    expect(result.error).toContain('500')
    expect(result.healingAttempts).toBeUndefined()
  })

  it('verifier returns agent mistake → routes to replanning', async () => {
    const screen1 = makeScreenState()
    const screen2 = makeScreenState({
      elements: [
        { ref: 'btn-2', role: 'button', name: 'Sign In', attributes: {} },
        { ref: 'input-1', role: 'textbox', name: 'Email', attributes: {} },
      ],
    })

    const adapter = createMockAdapter({
      observeResults: [screen1, screen1, screen2, screen2],
      executeResults: [{ success: true }, { success: true }],
    })

    const verifier = createMockVerifier([
      { success: false, reasoning: 'Button was not clicked correctly', isAppError: false },
      { success: true, reasoning: 'Step completed after healing', isAppError: false },
    ])

    const plan1 = makeActionPlan({ action: { type: 'click', ref: 'btn-1' } })
    const plan2 = makeActionPlan({ action: { type: 'click', ref: 'btn-2' } })
    const planner = createMockPlanner([plan1, plan2])

    const config = makeConfig({ adapter, planner, verifier })
    const context = makeStepContext()

    const result = await executeStep('Click the Sign In button', config, context)

    expect(result.status).toBe('passed')
  })

  it('verifier receives both before and after screen states', async () => {
    const beforeScreen = makeScreenState({ url: 'https://example.com/before' })
    const afterScreen = makeScreenState({ url: 'https://example.com/after' })

    let capturedBefore: ScreenState | undefined
    let capturedAfter: ScreenState | undefined

    const verifier: Verifier = {
      async verify(_step: string, before: ScreenState, after: ScreenState, _action: Action) {
        capturedBefore = before
        capturedAfter = after
        return { verification: { success: true, reasoning: 'OK', isAppError: false } }
      },
    }

    const adapter = createMockAdapter({
      observeResults: [beforeScreen, afterScreen],
      executeResult: { success: true },
    })

    const config = makeConfig({ adapter, verifier })
    const context = makeStepContext()

    await executeStep('Click the Sign In button', config, context)

    expect(capturedBefore!.url).toBe('https://example.com/before')
    expect(capturedAfter!.url).toBe('https://example.com/after')
  })
})
