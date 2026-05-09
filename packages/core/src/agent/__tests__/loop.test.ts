import { describe, it, expect, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import type { PlatformAdapter, ScreenState, Action, ActionResult } from '../../types/platform.js'
import type { ActionPlan } from '../../schema/action-schema.js'
import type { Planner, Verifier, VerificationResult, AgentLoopConfig, StepContext, HealingConfig } from '../types.js'
import { createTimeoutAbortReason, executeStep } from '../loop.js'
import sharp from 'sharp'

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
    reasoning: 'Clicking the Sign In button to submit the form',
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

describe('executeStep', () => {
  it('happy path: observe → plan → execute → verify → done(passed)', async () => {
    const config = makeConfig()
    const context = makeStepContext()

    const result = await executeStep('Click the Sign In button', config, context)

    expect(result.status).toBe('passed')
    expect(result.name).toBe('Click the Sign In button')
    expect(result.action).toEqual({ type: 'click', ref: 'btn-1' })
  })

  it('execution failure → replan with different action → succeed', async () => {
    const screen1 = makeScreenState()
    const screen2 = makeScreenState({
      elements: [
        { ref: 'btn-2', role: 'button', name: 'Sign In', attributes: {} },
        { ref: 'input-1', role: 'textbox', name: 'Email', attributes: {} },
      ],
    })

    const adapter = createMockAdapter({
      observeResults: [screen1, screen2, screen2],
      executeResults: [
        { success: false, error: 'Element not found' },
        { success: true },
      ],
    })

    const plan1 = makeActionPlan({ action: { type: 'click', ref: 'btn-1' } })
    const plan2 = makeActionPlan({ action: { type: 'click', ref: 'btn-2' } })
    const planner = createMockPlanner([plan1, plan2])

    const config = makeConfig({ adapter, planner })
    const context = makeStepContext()

    const result = await executeStep('Click the Sign In button', config, context)

    expect(result.status).toBe('passed')
  })

  it('execution failure → max consecutive failures → done(failed)', async () => {
    const screens = [
      makeScreenState({ elements: [{ ref: 'a', role: 'button', name: 'A', attributes: {} }] }),
      makeScreenState({ elements: [{ ref: 'b', role: 'button', name: 'B', attributes: {} }] }),
      makeScreenState({ elements: [{ ref: 'c', role: 'button', name: 'C', attributes: {} }] }),
      makeScreenState({ elements: [{ ref: 'd', role: 'button', name: 'D', attributes: {} }] }),
      makeScreenState({ elements: [{ ref: 'e', role: 'button', name: 'E', attributes: {} }] }),
    ]

    const adapter = createMockAdapter({
      observeResults: screens,
      executeResult: { success: false, error: 'Always fails' },
    })

    const planner = createMockPlanner([
      makeActionPlan({ action: { type: 'click', ref: 'a' } }),
      makeActionPlan({ action: { type: 'click', ref: 'b' } }),
      makeActionPlan({ action: { type: 'click', ref: 'c' } }),
      makeActionPlan({ action: { type: 'click', ref: 'd' } }),
    ])

    const config = makeConfig({
      adapter,
      planner,
      healingConfig: { maxAttempts: 3 },
    })
    const context = makeStepContext()

    const result = await executeStep('Click the Submit button', config, context)

    expect(result.status).toBe('failed')
  })

  it('consecutive identical failed actions → done(failed)', async () => {
    const sameScreen = makeScreenState()

    const adapter = createMockAdapter({
      observeResults: [sameScreen, sameScreen, sameScreen],
      executeResult: { success: false, error: 'Element not interactable' },
    })

    const planner = createMockPlanner([
      makeActionPlan({ action: { type: 'click', ref: 'btn-1' } }),
      makeActionPlan({ action: { type: 'click', ref: 'btn-1' } }),
    ])

    const config = makeConfig({ adapter, planner })
    const context = makeStepContext()

    const result = await executeStep('Click the Sign In button', config, context)

    expect(result.status).toBe('failed')
  })

  it('step context is passed to planner', async () => {
    const plannerSpy = vi.fn().mockResolvedValue({ plan: makeActionPlan() })

    const planner: Planner = { plan: plannerSpy }

    const adapter = createMockAdapter()

    const context = makeStepContext({
      testContext: 'This is a banking app',
      previousSteps: [
        { instruction: 'Navigate to login', outcome: 'navigated ✓' },
      ],
    })

    const config = makeConfig({ adapter, planner })

    await executeStep('Click the Sign In button', config, context)

    expect(plannerSpy).toHaveBeenCalledOnce()
    const [step, screenState, passedContext] = plannerSpy.mock.calls[0]
    expect(step).toBe('Click the Sign In button')
    expect(passedContext.testContext).toBe('This is a banking app')
    expect(passedContext.previousSteps).toHaveLength(1)
  })

  it('duration tracking: StepResult.duration > 0', async () => {
    const config = makeConfig()
    const context = makeStepContext()
    const result = await executeStep('Test step', config, context)
    expect(result.duration).toBeGreaterThanOrEqual(0)
  })

  it('verifier not provided: uses ActionResult.success directly', async () => {
    const adapter = createMockAdapter({ executeResult: { success: true } })
    const config = makeConfig({ adapter, verifier: undefined })
    const context = makeStepContext()

    const result = await executeStep('Click the Sign In button', config, context)

    expect(result.status).toBe('passed')
  })

  it('verifier detects app error: fails hard without replanning', async () => {
    const adapter = createMockAdapter({
      observeResults: [makeScreenState(), makeScreenState()],
      executeResult: { success: true },
    })

    const verifier = createMockVerifier([
      { success: false, reasoning: 'HTTP 500 error page detected', isAppError: true },
    ])

    const config = makeConfig({ adapter, verifier })
    const context = makeStepContext()

    const result = await executeStep('Click the Sign In button', config, context)

    expect(result.status).toBe('failed')
    expect(result.error).toContain('500')
  })

  it('verify failure → replan with different action → succeed', async () => {
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
      { success: false, reasoning: 'Button not clicked successfully', isAppError: false },
      { success: true, reasoning: 'Step completed after replanning', isAppError: false },
    ])

    const plan1 = makeActionPlan({ action: { type: 'click', ref: 'btn-1' } })
    const plan2 = makeActionPlan({ action: { type: 'click', ref: 'btn-2' } })
    const planner = createMockPlanner([plan1, plan2])

    const config = makeConfig({ adapter, planner, verifier })
    const context = makeStepContext()

    const result = await executeStep('Click the Sign In button', config, context)

    expect(result.status).toBe('passed')
  })

  it('app error from verifier → no further replanning', async () => {
    const screen = makeScreenState()
    const adapter = createMockAdapter({
      observeResults: [screen, screen],
      executeResult: { success: true },
    })

    const plannerSpy = vi.fn().mockResolvedValue({ plan: makeActionPlan() })
    const planner: Planner = { plan: plannerSpy }

    const verifier = createMockVerifier([
      { success: false, reasoning: 'Application crashed with error', isAppError: true },
    ])

    const config = makeConfig({ adapter, planner, verifier })
    const context = makeStepContext()

    const result = await executeStep('Click the Sign In button', config, context)

    expect(result.status).toBe('failed')
    expect(plannerSpy).toHaveBeenCalledTimes(1)
  })

  describe('abort semantics', () => {
    it('abort before planning returns cancelled without calling the planner', async () => {
      const controller = new AbortController()
      controller.abort(new Error('User cancelled'))
      const plannerSpy = vi.fn().mockResolvedValue({ plan: makeActionPlan() })
      const config = makeConfig({
        planner: { plan: plannerSpy },
        abortSignal: controller.signal,
      })
      const context = makeStepContext()

      const result = await executeStep('Click the Sign In button', config, context)

      expect(result.status).toBe('cancelled')
      expect(result.error).toBe('Step cancelled by user')
      expect(plannerSpy).not.toHaveBeenCalled()
    })

    it('timeout abort during planner call returns failed timeout semantics', async () => {
      const controller = new AbortController()
      let plannerSignal: AbortSignal | undefined
      const planner: Planner = {
        async plan(_step, _screenState, _context, abortSignal) {
          plannerSignal = abortSignal
          return new Promise((resolve, reject) => {
            abortSignal?.addEventListener('abort', () => reject(new Error('planner aborted')), { once: true })
            setTimeout(() => controller.abort(createTimeoutAbortReason('step', 30)), 10)
            setTimeout(() => resolve({ plan: makeActionPlan() }), 100)
          })
        },
      }
      const config = makeConfig({
        planner,
        abortSignal: controller.signal,
      })
      const context = makeStepContext()

      const result = await executeStep('Click the Sign In button', config, context)

      expect(plannerSignal).toBe(controller.signal)
      expect(result.status).toBe('failed')
      expect(result.error).toBe('Step timed out after 30ms')
      expect(result.trace?.result).toBe('failure')
    })

    it('timeout abort during verifier call cannot be converted to passed', async () => {
      const controller = new AbortController()
      let verifierSignal: AbortSignal | undefined
      const verifier: Verifier = {
        async verify(_step, _before, _after, _action, _screenshot, abortSignal) {
          verifierSignal = abortSignal
          controller.abort(createTimeoutAbortReason('step', 30))
          return {
            verification: { success: true, reasoning: 'Would have passed without abort', isAppError: false },
          }
        },
      }
      const config = makeConfig({
        abortSignal: controller.signal,
        verifier,
      })
      const context = makeStepContext()

      const result = await executeStep('Click the Sign In button', config, context)

      expect(verifierSignal).toBe(controller.signal)
      expect(result.status).toBe('failed')
      expect(result.error).toBe('Step timed out after 30ms')
    })
  })

  describe('stepFailed agentic signaling', () => {
    it('stepFailed on first action → step fails immediately, no action executed', async () => {
      const executeSpy = vi.fn().mockResolvedValue({ success: true })
      const adapter: PlatformAdapter = {
        platform: 'web',
        async setup() {},
        async cleanup() {},
        async observe() { return makeScreenState() },
        execute: executeSpy,
      }

      const planner = createMockPlanner([
        makeActionPlan({
          reasoning: 'Button is red, step requires it to be blue — cannot change button color',
          action: { type: 'assert', condition: 'button is blue' },
          confidence: 1.0,
          stepComplete: false,
          stepFailed: true,
        }),
      ])

      const config = makeConfig({ adapter, planner })
      const context = makeStepContext()

      const result = await executeStep('Verify button is blue', config, context)

      expect(result.status).toBe('failed')
      expect(executeSpy).not.toHaveBeenCalled()
    })

    it('stepFailed after 2 successful actions → step fails on 3rd, first 2 executed', async () => {
      let executeCount = 0
      const adapter: PlatformAdapter = {
        platform: 'web',
        async setup() {},
        async cleanup() {},
        async observe() { return makeScreenState() },
        async execute() { executeCount++; return { success: true } },
      }

      const planner = createMockPlanner([
        makeActionPlan({ stepComplete: false, stepFailed: false, action: { type: 'click', ref: 'btn-1' } }),
        makeActionPlan({ stepComplete: false, stepFailed: false, action: { type: 'fill', ref: 'input-1', value: 'test' } }),
        makeActionPlan({
          reasoning: 'Form is disabled, cannot submit',
          action: { type: 'click', ref: 'btn-1' },
          stepComplete: false,
          stepFailed: true,
          confidence: 1.0,
        }),
      ])

      const config = makeConfig({ adapter, planner })
      const context = makeStepContext()

      const result = await executeStep('Fill form and submit', config, context)

      expect(result.status).toBe('failed')
      expect(executeCount).toBe(2)
    })

    it('stepComplete=true → step succeeds (existing behavior)', async () => {
      const config = makeConfig()
      const context = makeStepContext()

      const result = await executeStep('Click the Sign In button', config, context)

      expect(result.status).toBe('passed')
    })

    it('stepFailed failure message includes planner reasoning', async () => {
      const adapter = createMockAdapter()
      const planner = createMockPlanner([
        makeActionPlan({
          reasoning: 'The checkout button does not exist on this page',
          action: { type: 'assert', condition: 'checkout exists' },
          stepComplete: false,
          stepFailed: true,
          confidence: 1.0,
        }),
      ])

      const config = makeConfig({ adapter, planner })
      const context = makeStepContext()

      const result = await executeStep('Click checkout', config, context)

      expect(result.status).toBe('failed')
      expect(result.error).toContain('The checkout button does not exist on this page')
    })

    it('maxSubActions=50 is respected as safety net', async () => {
      let planCallCount = 0
      const planner: Planner = {
        async plan() {
          planCallCount++
          return { plan: makeActionPlan({ stepComplete: false, stepFailed: false }) }
        },
      }

      const adapter = createMockAdapter({
        executeResult: { success: true },
      })

      const config = makeConfig({ adapter, planner })
      const context = makeStepContext()

      const result = await executeStep('Do something forever', config, context)

      expect(result.status).toBe('failed')
      expect(planCallCount).toBe(50)
      expect(result.error).toContain('Sub-action limit reached (50')
    })
  })

  describe('non-visual assert bypass', () => {
    it('non-visual assert with stepComplete bypasses verifier', async () => {
      const screen = makeScreenState()
      const adapter = createMockAdapter({
        observeResults: [screen],
        executeResult: { success: true },
      })

      const planner = createMockPlanner([
        makeActionPlan({
          action: { type: 'assert', condition: '42 equals 42', visual: false } as any,
          stepComplete: true,
          reasoning: 'tautology check',
          confidence: 1.0,
        }),
      ])

      const verifySpy = vi.fn().mockResolvedValue({
        verification: { success: true, reasoning: 'ok', isAppError: false },
      })
      const verifier: Verifier = { verify: verifySpy }

      const config = makeConfig({ adapter, planner, verifier })
      const context = makeStepContext()

      const result = await executeStep('Verify 42 equals 42', config, context)

      expect(result.status).toBe('passed')
      expect(verifySpy).not.toHaveBeenCalled()
    })

    it('visual assert with stepComplete still calls verifier', async () => {
      const screen = makeScreenState()
      const adapter = createMockAdapter({
        observeResults: [screen, screen],
        executeResult: { success: true },
      })

      const planner = createMockPlanner([
        makeActionPlan({
          action: { type: 'assert', condition: 'button says Submit', visual: true } as any,
          stepComplete: true,
          reasoning: 'button text visible',
          confidence: 1.0,
        }),
      ])

      const verifySpy = vi.fn().mockResolvedValue({
        verification: { success: true, reasoning: 'confirmed', isAppError: false },
      })
      const verifier: Verifier = { verify: verifySpy }

      const config = makeConfig({ adapter, planner, verifier })
      const context = makeStepContext()

      const result = await executeStep('Verify button says Submit', config, context)

      expect(result.status).toBe('passed')
      expect(verifySpy).toHaveBeenCalled()
    })

    it('assert with visual omitted still calls verifier', async () => {
      const screen = makeScreenState()
      const adapter = createMockAdapter({
        observeResults: [screen, screen],
        executeResult: { success: true },
      })

      const planner = createMockPlanner([
        makeActionPlan({
          action: { type: 'assert', condition: 'title is Dashboard' },
          stepComplete: true,
          reasoning: 'title visible',
          confidence: 1.0,
        }),
      ])

      const verifySpy = vi.fn().mockResolvedValue({
        verification: { success: true, reasoning: 'confirmed', isAppError: false },
      })
      const verifier: Verifier = { verify: verifySpy }

      const config = makeConfig({ adapter, planner, verifier })
      const context = makeStepContext()

      const result = await executeStep('Verify title is Dashboard', config, context)

      expect(result.status).toBe('passed')
      expect(verifySpy).toHaveBeenCalled()
    })

    it('non-visual assert without stepComplete does not bypass', async () => {
      const screen = makeScreenState()
      const adapter = createMockAdapter({
        observeResults: [screen, screen],
        executeResults: [{ success: true }, { success: true }],
      })

      const planner = createMockPlanner([
        makeActionPlan({
          action: { type: 'assert', condition: 'check', visual: false } as any,
          stepComplete: false,
          reasoning: 'intermediate check',
          confidence: 1.0,
        }),
        makeActionPlan({
          action: { type: 'click', ref: 'btn-1' },
          stepComplete: true,
          reasoning: 'click to complete',
          confidence: 1.0,
        }),
      ])

      const config = makeConfig({ adapter, planner })
      const context = makeStepContext()

      const result = await executeStep('Check then click', config, context)

      expect(result.status).toBe('passed')
      expect(result.trace?.subActions).toHaveLength(2)
    })
  })

  it('replanning with different strategy still recovers', async () => {
    const screen1 = makeScreenState()
    const screen2 = makeScreenState({
      elements: [
        { ref: 'btn-2', role: 'button', name: 'Sign In', attributes: {} },
      ],
    })

    const adapter = createMockAdapter({
      observeResults: [screen1, screen1, screen2, screen2],
      executeResults: [{ success: true }, { success: true }],
    })

    const verifier = createMockVerifier([
      { success: false, reasoning: 'Wrong element clicked', isAppError: false },
      { success: true, reasoning: 'OK', isAppError: false },
    ])

    const plan1 = makeActionPlan({ action: { type: 'click', ref: 'btn-1' } })
    const plan2 = makeActionPlan({ action: { type: 'click', ref: 'btn-2' } })
    const planner = createMockPlanner([plan1, plan2])

    const config = makeConfig({
      adapter,
      planner,
      verifier,
      healingConfig: { maxAttempts: 3 },
    })
    const context = makeStepContext()

    const result = await executeStep('Click the Sign In button', config, context)

    expect(result.status).toBe('passed')
  })

  describe('public action-proof mode removal', () => {
    it('keeps ordinary fallback behavior when an alternate action completes the step', async () => {
      const adapter = createMockAdapter({ executeResult: { success: true } })
      const planner = createMockPlanner([
        makeActionPlan({
          action: { type: 'navigate', url: 'wdio://forms' },
          stepComplete: true,
        }),
      ])

      const result = await executeStep(
        'Use openLink with wdio://forms and verify the Forms screen is visible.',
        makeConfig({ adapter, planner }),
        makeStepContext(),
      )

      expect(result.status).toBe('passed')
    })

    it('does not include strict action proof prompt text', async () => {
      const promptsSource = await readFile(new URL('../prompts.ts', import.meta.url), 'utf-8')
      expect(promptsSource).not.toContain('STRICT ACTION PROOF MODE')
    })
  })
})
