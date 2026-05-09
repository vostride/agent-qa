import { describe, it, expect, vi } from 'vitest'
import type { PlatformAdapter, ScreenState, Action, ActionResult } from '../../types/platform.js'
import type { ActionPlan } from '../../schema/action-schema.js'
import type { ActionCache, Planner, StepContext } from '../types.js'
import type { TestDefinition } from '../../types/test.js'
import { runTest } from '../runner.js'
import type { RunTestConfig } from '../runner.js'
import { SecretRedactor, SecretStore } from '../secrets.js'

function makeScreenState(overrides?: Partial<ScreenState>): ScreenState {
  return {
    tree: 'heading "Order #ORD-789 confirmed"\ntext "ID-12345 is your reference"',
    elements: [
      { ref: 'h-1', role: 'heading', name: 'Order #ORD-789 confirmed', attributes: {} },
      { ref: 'txt-1', role: 'text', name: 'ID-12345 is your reference', attributes: {} },
    ],
    url: 'https://example.com/order',
    timestamp: Date.now(),
    metadata: { coordSpace: 'viewport' as const, viewportWidth: 0, viewportHeight: 0 },
    ...overrides,
  }
}

function makeActionPlan(overrides?: Partial<ActionPlan>): ActionPlan {
  return {
    reasoning: 'Clicking OK',
    action: { type: 'click', ref: 'btn-1' },
    confidence: 0.9,
    stepComplete: true,
    stepFailed: false,
    ...overrides,
  }
}

function createMockAdapter(options?: {
  executeResults?: ActionResult[]
  screenState?: ScreenState
}): PlatformAdapter {
  let executeCallCount = 0
  const executeResults = options?.executeResults ?? [{ success: true }]
  const screen = options?.screenState ?? makeScreenState()
  return {
    platform: 'web',
    async setup() {},
    async cleanup() {},
    async observe() { return screen },
    async execute(_action: Action) {
      const idx = Math.min(executeCallCount, executeResults.length - 1)
      executeCallCount++
      return executeResults[idx]
    },
  }
}

function makeRunTestConfig(overrides?: Partial<RunTestConfig>): RunTestConfig {
  return {
    adapter: createMockAdapter(),
    planner: { async plan() { return { plan: makeActionPlan() } } },
    healingConfig: { maxAttempts: 0 },
    plannerModel: {} as any,
    verifierModel: {} as any,
    ...overrides,
  }
}

describe('runTest with variable capture', () => {
  it('interpolates {{env:variable}} in step instructions using previously captured values', async () => {
    const plannerSpy = vi.fn().mockResolvedValue({ plan: makeActionPlan() })
    const planner: Planner = { plan: plannerSpy }

    const config = makeRunTestConfig({
      adapter: createMockAdapter({
        screenState: makeScreenState({
          tree: 'text "Order ORD-789 placed"',
          elements: [{ ref: 'txt-1', role: 'text', name: 'Order ORD-789 placed', attributes: {} }],
        }),
      }),
      planner,
    })

    const test: TestDefinition = {
      'test-id': 't_var-interpolation',
      name: 'Variable interpolation test',
      target: 'default',
      steps: [
        {
          step: 'Place order',
          capture: { variable: 'orderNum', method: 'regex', pattern: 'Order (\\S+)' },
        },
        { step: 'Verify order {{env:orderNum}}' },
      ],
    }

    await runTest(test, config, '/tests/vars.yaml')

    // Step 2 should have received interpolated instruction
    const secondCallInstruction = plannerSpy.mock.calls[1][0]
    expect(secondCallInstruction).toBe('Verify order ORD-789')
  })

  it('capture config triggers extraction after successful step', async () => {
    const config = makeRunTestConfig({
      adapter: createMockAdapter({
        screenState: makeScreenState({
          tree: 'text "Reference: ID-12345"',
          elements: [{ ref: 'txt-1', role: 'text', name: 'Reference: ID-12345', attributes: {} }],
        }),
      }),
    })

    const test: TestDefinition = {
      'test-id': 't_capture-test',
      name: 'Capture test',
      target: 'default',
      steps: [
        {
          step: 'Go to order page',
          capture: { variable: 'refId', method: 'regex', pattern: 'ID-(\\d+)' },
        },
      ],
    }

    const result = await runTest(test, config, '/tests/capture.yaml')

    expect(result.status).toBe('passed')
    expect(result.steps[0].capturedVariables).toEqual({ refId: '12345' })
  })

  it('failed step does NOT trigger capture', async () => {
    const config = makeRunTestConfig({
      adapter: createMockAdapter({
        executeResults: [{ success: false, error: 'Click failed' }],
      }),
      healingConfig: { maxAttempts: 0 },
    })

    const test: TestDefinition = {
      'test-id': 't_no-capture-fail',
      name: 'No capture on failure',
      target: 'default',
      steps: [
        {
          step: 'Click something',
          capture: { variable: 'val', method: 'regex', pattern: '(\\S+)' },
        },
      ],
    }

    const result = await runTest(test, config, '/tests/fail.yaml')

    expect(result.status).toBe('failed')
    expect(result.steps[0].capturedVariables).toBeUndefined()
  })

  it('unresolved {{env:missing}} variable fails the step before reaching planner', async () => {
    const plannerSpy = vi.fn().mockResolvedValue({ plan: makeActionPlan() })
    const planner: Planner = { plan: plannerSpy }

    const config = makeRunTestConfig({ planner })

    const test: TestDefinition = {
      'test-id': 't_unresolved-vars',
      name: 'Unresolved vars test',
      target: 'default',
      steps: [
        { step: 'Check {{env:missing}} value' },
      ],
    }

    const result = await runTest(test, config, '/tests/unresolved.yaml')

    expect(plannerSpy).not.toHaveBeenCalled()
    expect(result.status).toBe('failed')
    expect(result.steps[0].status).toBe('failed')
    expect(result.steps[0].error).toContain("variable 'missing' not set")
  })

  it('previousSteps outcome includes capture info', async () => {
    const plannerSpy = vi.fn().mockResolvedValue({ plan: makeActionPlan() })
    const planner: Planner = { plan: plannerSpy }

    const config = makeRunTestConfig({
      adapter: createMockAdapter({
        screenState: makeScreenState({
          tree: 'text "Order ORD-555"',
          elements: [{ ref: 'txt-1', role: 'text', name: 'Order ORD-555', attributes: {} }],
        }),
      }),
      planner,
    })

    const test: TestDefinition = {
      'test-id': 't_capture-outcome',
      name: 'Capture outcome test',
      target: 'default',
      steps: [
        {
          step: 'Place order',
          capture: { variable: 'orderNum', method: 'regex', pattern: 'Order (\\S+)' },
        },
        { step: 'Next step' },
      ],
    }

    await runTest(test, config, '/tests/outcome.yaml')

    // Step 2's context should include capture info in previousSteps
    const [, , ctx] = plannerSpy.mock.calls[1]
    expect(ctx.previousSteps[0].outcome).toContain('orderNum=ORD-555')
  })
})

describe('runTest with layered variable loading', () => {
  it('loads envFileVars with source env', async () => {
    const plannerSpy = vi.fn().mockResolvedValue({ plan: makeActionPlan() })
    const config = makeRunTestConfig({
      planner: { plan: plannerSpy },
      envFileVars: { BASE_URL: 'https://staging.example.com' },
    })

    const test: TestDefinition = {
      'test-id': 't_env-vars',
      name: 'env vars test',
      target: 'default',
      steps: [{ step: 'Navigate to {{env:BASE_URL}}' }],
    }

    await runTest(test, config, '/tests/env.yaml')
    expect(plannerSpy.mock.calls[0][0]).toBe('Navigate to https://staging.example.com')
  })

  it('cliVars override envFileVars', async () => {
    const plannerSpy = vi.fn().mockResolvedValue({ plan: makeActionPlan() })
    const config = makeRunTestConfig({
      planner: { plan: plannerSpy },
      envFileVars: { USER: 'envuser' },
      cliVars: { USER: 'cliuser' },
    })

    const test: TestDefinition = {
      'test-id': 't_cli-override',
      name: 'cli override test',
      target: 'default',
      steps: [{ step: 'Login as {{env:USER}}' }],
    }

    await runTest(test, config, '/tests/override.yaml')
    expect(plannerSpy.mock.calls[0][0]).toBe('Login as cliuser')
  })

  it('full precedence chain: env < inline < suite < cli', async () => {
    const plannerSpy = vi.fn().mockResolvedValue({ plan: makeActionPlan() })
    const config = makeRunTestConfig({
      planner: { plan: plannerSpy },
      envFileVars: { A: 'env', B: 'env', C: 'env', D: 'env', E: 'env' },
      inlineVars: { B: 'inline', C: 'inline', D: 'inline', E: 'inline' },
      suiteVars: { C: 'suite', D: 'suite', E: 'suite' },
      cliVars: { E: 'cli' },
    })

    const test: TestDefinition = {
      'test-id': 't_precedence',
      name: 'precedence test',
      target: 'default',
      steps: [{ step: '{{env:A}} {{env:B}} {{env:C}} {{env:D}} {{env:E}}' }],
    }

    await runTest(test, config, '/tests/prec.yaml')
    expect(plannerSpy.mock.calls[0][0]).toBe('env inline suite suite cli')
  })

  it('interpolates URL before navigation', async () => {
    const executeSpy = vi.fn().mockResolvedValue({ success: true })
    const adapter: PlatformAdapter = {
      platform: 'web',
      async setup() {},
      async cleanup() {},
      async observe() { return makeScreenState() },
      execute: executeSpy,
    }

    const plannerSpy = vi.fn().mockResolvedValue({ plan: makeActionPlan() })
    const config = makeRunTestConfig({
      adapter,
      planner: { plan: plannerSpy },
      envFileVars: { HOST: 'https://staging.example.com' },
    })

    const test = {
      name: 'url interpolation test',
      target: 'default',
      url: '{{env:HOST}}/login',
      steps: [{ step: 'Enter credentials' }],
    } as any as TestDefinition

    await runTest(test, config, '/tests/url.yaml')

    const navigateCall = executeSpy.mock.calls[0]
    expect(navigateCall[0]).toEqual({ type: 'navigate', url: 'https://staging.example.com/login' })
  })
})

describe('runTest with secret placeholders', () => {
  it('resolves secrets only for adapter execution and redacts results', async () => {
    const executeSpy = vi.fn().mockResolvedValue({ success: true })
    const adapter: PlatformAdapter = {
      platform: 'web',
      async setup() {},
      async cleanup() {},
      async observe() { return makeScreenState() },
      execute: executeSpy,
    }
    const plannerSpy = vi.fn().mockResolvedValue({
      plan: makeActionPlan({
        reasoning: 'Fill the password field with {{secret:loginPassword}}',
        action: { type: 'fill', ref: 'password-input', value: '{{secret:loginPassword}}' },
      }),
    })
    const secretStore = new SecretStore({ loginPassword: 'raw-secret-sentinel' })
    const config = makeRunTestConfig({
      adapter,
      planner: { plan: plannerSpy },
      secretStore,
      secretRedactor: new SecretRedactor(secretStore),
    })

    const test: TestDefinition = {
      'test-id': 't_secret-fill',
      name: 'secret fill test',
      target: 'default',
      steps: [{ step: 'Fill password with {{secret:loginPassword}}' }],
    }

    const result = await runTest(test, config, '/tests/secrets.yaml')

    expect(executeSpy).toHaveBeenCalledWith({
      type: 'fill',
      ref: 'password-input',
      value: 'raw-secret-sentinel',
    })
    expect(plannerSpy.mock.calls[0][0]).toBe('Fill password with {{secret:loginPassword}}')
    expect(JSON.stringify(plannerSpy.mock.calls[0][2])).not.toContain('raw-secret-sentinel')
    expect(JSON.stringify(result)).not.toContain('raw-secret-sentinel')
    expect(result.steps[0].trace?.reasoning).toContain('[secret:loginPassword]')
    expect(result.steps[0].trace?.plannedAction).toEqual({
      type: 'fill',
      ref: 'password-input',
      value: '[secret:loginPassword]',
    })
  })

  it('stores runtime secret templates in cache instead of redacted markers', async () => {
    const executeSpy = vi.fn().mockResolvedValue({ success: true })
    const adapter: PlatformAdapter = {
      platform: 'web',
      async setup() {},
      async cleanup() {},
      async observe() { return makeScreenState() },
      execute: executeSpy,
    }
    const plannerSpy = vi.fn().mockResolvedValue({
      plan: makeActionPlan({
        reasoning: 'Fill the password field with {{secret:loginPassword}}',
        action: { type: 'fill', ref: 'password-input', value: '{{secret:loginPassword}}' },
      }),
    })
    const storedPlans: ActionPlan[] = []
    const cache: ActionCache = {
      async get() { return null },
      async set() {},
      async invalidate() {},
      async getSubAction() { return null },
      async setSubAction(_stepHash, _index, plan) {
        storedPlans.push(structuredClone(plan) as ActionPlan)
      },
      async invalidateSubActionsFrom() {},
    }
    const secretStore = new SecretStore({ loginPassword: 'raw-secret-sentinel' })
    const config = makeRunTestConfig({
      adapter,
      planner: { plan: plannerSpy },
      cache,
      secretStore,
      secretRedactor: new SecretRedactor(secretStore),
    })

    const test: TestDefinition = {
      'test-id': 't_secret-cache-store',
      name: 'secret cache store test',
      target: 'default',
      steps: [{ step: 'Fill password with {{secret:loginPassword}}' }],
    }

    const result = await runTest(test, config, '/tests/secrets.yaml')

    expect(result.status).toBe('passed')
    expect(executeSpy).toHaveBeenCalledWith({
      type: 'fill',
      ref: 'password-input',
      value: 'raw-secret-sentinel',
    })
    expect(storedPlans).toHaveLength(1)
    const cachedPlan = storedPlans[0]!
    expect(cachedPlan.action).toEqual({
      type: 'fill',
      ref: 'password-input',
      value: '{{secret:loginPassword}}',
    })
    expect(JSON.stringify(cachedPlan)).not.toContain('[secret:loginPassword]')
    expect(JSON.stringify(cachedPlan)).not.toContain('raw-secret-sentinel')
  })

  it('invalidates stale cached redacted secret markers before execution', async () => {
    const executeSpy = vi.fn().mockResolvedValue({ success: true })
    const adapter: PlatformAdapter = {
      platform: 'web',
      async setup() {},
      async cleanup() {},
      async observe() { return makeScreenState() },
      execute: executeSpy,
    }
    const plannerSpy = vi.fn().mockResolvedValue({
      plan: makeActionPlan({
        reasoning: 'Fill the password field with {{secret:loginPassword}}',
        action: { type: 'fill', ref: 'password-input', value: '{{secret:loginPassword}}' },
      }),
    })
    const invalidateSpy = vi.fn()
    const cache: ActionCache = {
      async get() { return null },
      async set() {},
      async invalidate() {},
      async getSubAction() {
        return makeActionPlan({
          reasoning: 'Fill the password field with [secret:loginPassword]',
          action: { type: 'fill', ref: 'password-input', value: '[secret:loginPassword]' },
        })
      },
      async setSubAction() {},
      async invalidateSubActionsFrom(stepHash, index) {
        invalidateSpy(stepHash, index)
      },
    }
    const secretStore = new SecretStore({ loginPassword: 'raw-secret-sentinel' })
    const config = makeRunTestConfig({
      adapter,
      planner: { plan: plannerSpy },
      cache,
      secretStore,
      secretRedactor: new SecretRedactor(secretStore),
    })

    const test: TestDefinition = {
      'test-id': 't_secret-cache-stale',
      name: 'secret stale cache test',
      target: 'default',
      steps: [{ step: 'Fill password with {{secret:loginPassword}}' }],
    }

    const result = await runTest(test, config, '/tests/secrets.yaml')

    expect(result.status).toBe('passed')
    expect(invalidateSpy).toHaveBeenCalledWith(expect.any(String), 0)
    expect(plannerSpy).toHaveBeenCalled()
    expect(executeSpy).toHaveBeenCalledWith({
      type: 'fill',
      ref: 'password-input',
      value: 'raw-secret-sentinel',
    })
    expect(executeSpy).not.toHaveBeenCalledWith(expect.objectContaining({ value: '[secret:loginPassword]' }))
  })

  it('fails missing secrets without sending an action to the adapter', async () => {
    const executeSpy = vi.fn().mockResolvedValue({ success: true })
    const adapter: PlatformAdapter = {
      platform: 'web',
      async setup() {},
      async cleanup() {},
      async observe() { return makeScreenState() },
      execute: executeSpy,
    }
    const secretStore = SecretStore.empty()
    const config = makeRunTestConfig({
      adapter,
      planner: {
        async plan() {
          return {
            plan: makeActionPlan({
              action: { type: 'fill', ref: 'password-input', value: '{{secret:loginPassword}}' },
            }),
          }
        },
      },
      secretStore,
      secretRedactor: new SecretRedactor(secretStore),
      healingConfig: { maxAttempts: 0 },
    })

    const test: TestDefinition = {
      'test-id': 't_secret-missing',
      name: 'missing secret test',
      target: 'default',
      steps: [{ step: 'Fill password with {{secret:loginPassword}}' }],
    }

    const result = await runTest(test, config, '/tests/secrets.yaml')

    expect(executeSpy).not.toHaveBeenCalled()
    expect(result.status).toBe('failed')
    expect(result.steps[0].error).toContain('Secret not found: loginPassword')
    expect(JSON.stringify(result)).not.toContain('raw-secret-sentinel')
  })
})
