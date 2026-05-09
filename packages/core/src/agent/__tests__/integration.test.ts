import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PlatformAdapter, ScreenState, Action, ActionResult } from '../../types/platform.js'
import type { ActionPlan } from '../../schema/action-schema.js'
import type { Planner, Verifier, VerificationResult, AgentLoopConfig, StepContext } from '../types.js'
import { executeStep } from '../loop.js'
import { FileActionCache } from '../../cache/file-cache.js'

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
    reasoning: 'Click Sign In button',
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

describe('integration: agent loop with FileActionCache', () => {
  let cacheDir: string
  let cache: FileActionCache

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'agent-qa-integ-'))
    cache = new FileActionCache({ dir: cacheDir, ttl: '7d' })
  })

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true })
  })

  it('cache-first: first call plans (miss), second uses cache (hit)', async () => {
    const screen = makeScreenState()
    const plan = makeActionPlan()
    const plannerSpy = vi.fn().mockResolvedValue({ plan })
    const planner: Planner = { plan: plannerSpy }

    const adapter = createMockAdapter({
      observeResults: [screen, screen, screen, screen],
      executeResults: [{ success: true }, { success: true }],
    })

    const config: AgentLoopConfig = {
      adapter,
      planner,
      cache,
      healingConfig: { maxAttempts: 3 },
    }
    const context = makeStepContext()

    // First call: cache miss → planner called
    const result1 = await executeStep('Click the Sign In button', config, context)
    expect(result1.status).toBe('passed')
    expect(plannerSpy).toHaveBeenCalledTimes(1)

    // Second call: cache hit → planner NOT called
    const result2 = await executeStep('Click the Sign In button', config, context)
    expect(result2.status).toBe('passed')
    expect(plannerSpy).toHaveBeenCalledTimes(1) // still 1, not 2
  })

  it('cache miss on different step instruction', async () => {
    const plan = makeActionPlan()
    const plannerSpy = vi.fn().mockResolvedValue({ plan })
    const planner: Planner = { plan: plannerSpy }

    const adapterA = createMockAdapter({
      executeResults: [{ success: true }],
    })

    const adapterB = createMockAdapter({
      executeResults: [{ success: true }],
    })

    const contextA = makeStepContext()
    const contextB = makeStepContext()

    // First call with step instruction A
    const configA: AgentLoopConfig = {
      adapter: adapterA,
      planner,
      cache,
      healingConfig: { maxAttempts: 3 },
    }
    await executeStep('Click the Sign In button', configA, contextA)
    expect(plannerSpy).toHaveBeenCalledTimes(1)

    // Second call with different step instruction → cache miss
    const configB: AgentLoopConfig = {
      adapter: adapterB,
      planner,
      cache,
      healingConfig: { maxAttempts: 3 },
    }
    await executeStep('Click the Submit button', configB, contextB)
    expect(plannerSpy).toHaveBeenCalledTimes(2) // called again for different step
  })

  it('cached plan fails → re-plan and cache updated', async () => {
    const screen1 = makeScreenState()
    const screen2 = makeScreenState({
      elements: [
        { ref: 'btn-2', role: 'button', name: 'Sign In', attributes: {} },
        { ref: 'input-1', role: 'textbox', name: 'Email', attributes: {} },
      ],
    })

    const planOld = makeActionPlan({ reasoning: 'Old plan', action: { type: 'click', ref: 'btn-1' } })
    const planNew = makeActionPlan({ reasoning: 'New plan', action: { type: 'click', ref: 'btn-2' } })

    let planCallCount = 0
    const plannerSpy = vi.fn().mockImplementation(() => {
      planCallCount++
      return { plan: planCallCount <= 1 ? planOld : planNew }
    })
    const planner: Planner = { plan: plannerSpy }

    // First run: cache miss, plan cached, succeeds
    const adapter1 = createMockAdapter({
      observeResults: [screen1],
      executeResults: [{ success: true }],
    })
    const config1: AgentLoopConfig = {
      adapter: adapter1,
      planner,
      cache,
      healingConfig: { maxAttempts: 3 },
    }
    const context = makeStepContext()

    const result1 = await executeStep('Click the Sign In button', config1, context)
    expect(result1.status).toBe('passed')
    expect(plannerSpy).toHaveBeenCalledTimes(1)

    // Second run: cache hit returns old plan, but verification fails → healing → re-plan → new plan cached
    const verifier: Verifier = {
      async verify(_step, _before, _after, action) {
        // Old plan's action (btn-1) fails verification, new plan's action (btn-2) passes
        if (action.type === 'click' && action.ref === 'btn-1') {
          return { verification: { success: false, reasoning: 'Wrong element', isAppError: false } }
        }
        return { verification: { success: true, reasoning: 'Correct', isAppError: false } }
      },
    }

    const adapter2 = createMockAdapter({
      observeResults: [screen1, screen1, screen2, screen2],
      executeResults: [{ success: true }, { success: true }],
    })

    const config2: AgentLoopConfig = {
      adapter: adapter2,
      planner,
      verifier,
      cache,
      healingConfig: { maxAttempts: 3 },
    }

    const result2 = await executeStep('Click the Sign In button', config2, context)
    expect(result2.status).toBe('passed')

    // Planner was called again for re-plan
    expect(plannerSpy).toHaveBeenCalledTimes(2)
  })

  it('full happy path with cache: observe → plan (cached) → execute → verify → done', async () => {
    const screen = makeScreenState()
    const plan = makeActionPlan()
    const plannerSpy = vi.fn().mockResolvedValue({ plan })
    const planner: Planner = { plan: plannerSpy }

    const verifier: Verifier = {
      async verify() {
        return { verification: { success: true, reasoning: 'Step completed', isAppError: false } }
      },
    }

    const adapter = createMockAdapter({
      observeResults: [screen, screen],
      executeResults: [{ success: true }],
    })

    const config: AgentLoopConfig = {
      adapter,
      planner,
      verifier,
      cache,
      healingConfig: { maxAttempts: 3 },
    }
    const context = makeStepContext()

    const result = await executeStep('Click the Sign In button', config, context)

    expect(result.status).toBe('passed')
    expect(result.name).toBe('Click the Sign In button')
    expect(result.action).toEqual({ type: 'click', ref: 'btn-1' })
    expect(result.duration).toBeGreaterThanOrEqual(0)
    expect(plannerSpy).toHaveBeenCalledTimes(1)
  })

  it('step context (testContext) passed through to planner', async () => {
    const screen = makeScreenState()
    const plan = makeActionPlan()
    const plannerSpy = vi.fn().mockResolvedValue({ plan })
    const planner: Planner = { plan: plannerSpy }

    const adapter = createMockAdapter({
      observeResults: [screen],
      executeResults: [{ success: true }],
    })

    const config: AgentLoopConfig = {
      adapter,
      planner,
      cache,
      healingConfig: { maxAttempts: 3 },
    }

    const context = makeStepContext({
      testContext: 'This is a banking app. Amounts are in USD.',
    })

    await executeStep('Click the Sign In button', config, context)

    expect(plannerSpy).toHaveBeenCalledTimes(1)
    const passedContext = plannerSpy.mock.calls[0][2] as StepContext
    expect(passedContext.testContext).toBe('This is a banking app. Amounts are in USD.')
  })

  it('configuration wiring: full loop with all components', async () => {
    const screen = makeScreenState()
    const plan = makeActionPlan()

    const adapter = createMockAdapter({
      observeResults: [screen, screen],
      executeResults: [{ success: true }],
    })

    const planner: Planner = {
      async plan() { return { plan } },
    }

    const verifier: Verifier = {
      async verify() {
        return { verification: { success: true, reasoning: 'OK', isAppError: false } }
      },
    }

    const config: AgentLoopConfig = {
      adapter,
      planner,
      verifier,
      cache,
      healingConfig: { maxAttempts: 3 },
    }

    const context = makeStepContext()
    const result = await executeStep('Click the Sign In button', config, context)

    expect(result.status).toBe('passed')
  })
})
