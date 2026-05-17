import { beforeEach, describe, it, expect, vi } from 'vitest'
import type { PlatformAdapter, ScreenState, Action, ActionResult } from '../../types/platform.js'
import type { ActionPlan } from '../../schema/action-schema.js'
import type { Planner, AgentLoopConfig, StepContext, HealingConfig } from '../types.js'
import type { TestDefinition } from '../../types/test.js'
import { runTest, runTestWithRetry } from '../runner.js'
import type { RunTestConfig } from '../runner.js'

const { mockRunAccessibilityCheck } = vi.hoisted(() => ({
  mockRunAccessibilityCheck: vi.fn(),
}))

const { mockFsWriteFile } = vi.hoisted(() => ({
  mockFsWriteFile: vi.fn(),
}))

vi.mock('@vostride/agent-qa-web', () => ({
  runAccessibilityCheck: mockRunAccessibilityCheck,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    writeFile: mockFsWriteFile,
  }
})

function makeScreenState(overrides?: Partial<ScreenState>): ScreenState {
  return {
    tree: 'button "OK" [ref=btn-1]',
    elements: [
      { ref: 'btn-1', role: 'button', name: 'OK', attributes: {} },
    ],
    url: 'https://example.com',
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
}): PlatformAdapter {
  let executeCallCount = 0
  const executeResults = options?.executeResults ?? [{ success: true }]
  return {
    platform: 'web',
    async setup() {},
    async cleanup() {},
    async observe() { return makeScreenState() },
    async execute(_action: Action) {
      const idx = Math.min(executeCallCount, executeResults.length - 1)
      executeCallCount++
      return executeResults[idx]
    },
  }
}

function createMockPlanner(): Planner {
  return {
    async plan() { return { plan: makeActionPlan() } },
  }
}

function makeRunTestConfig(overrides?: Partial<RunTestConfig>): RunTestConfig {
  return {
    adapter: createMockAdapter(),
    planner: createMockPlanner(),
    healingConfig: { maxAttempts: 0 },
    plannerModel: {} as any,
    verifierModel: {} as any,
    ...overrides,
  }
}

function makeTestDef(overrides?: Partial<TestDefinition>): TestDefinition {
  return {
    'test-id': 't_test-login',
    name: 'Test login flow',
    target: 'default',
    steps: ['Click Login', 'Enter email', 'Click Submit'],
    ...overrides,
  }
}

describe('runTest', () => {
  beforeEach(() => {
    mockRunAccessibilityCheck.mockReset()
    mockRunAccessibilityCheck.mockResolvedValue([])
    mockFsWriteFile.mockReset()
  })

  it('executes all steps in order, returns passed TestResult', async () => {
    const config = makeRunTestConfig()
    const test = makeTestDef()

    const result = await runTest(test, config, '/tests/login.yaml')

    expect(result.status).toBe('passed')
    expect(result.name).toBe('Test login flow')
    expect(result.filePath).toBe('/tests/login.yaml')
    expect(result.steps).toHaveLength(3)
    for (const step of result.steps) {
      expect(step.status).toBe('passed')
    }
  })

  it('stops on first failed step, remaining steps not executed', async () => {
    let executeCount = 0
    const adapter: PlatformAdapter = {
      platform: 'web',
      async setup() {},
      async cleanup() {},
      async observe() { return makeScreenState() },
      async execute() {
        executeCount++
        // First execute succeeds (step 1), all subsequent fail (step 2+)
        if (executeCount >= 2) return { success: false, error: 'Failed' }
        return { success: true }
      },
    }
    const config = makeRunTestConfig({
      adapter,
      healingConfig: { maxAttempts: 3 },
    })
    const test = makeTestDef()

    const result = await runTest(test, config, '/tests/login.yaml')

    expect(result.status).toBe('failed')
    expect(result.steps[0].status).toBe('passed')
    expect(result.steps[1].status).toBe('failed')
  })

  it('populates previousSteps context for rolling summary', async () => {
    const plannerSpy = vi.fn().mockResolvedValue({ plan: makeActionPlan() })
    const planner: Planner = { plan: plannerSpy }
    const config = makeRunTestConfig({ planner })
    const test = makeTestDef({
      steps: ['Step A', 'Step B', 'Step C'],
    })

    await runTest(test, config, '/tests/context.yaml')

    // Step A: no previousSteps
    const [, , ctxA] = plannerSpy.mock.calls[0]
    expect(ctxA.previousSteps).toHaveLength(0)

    // Step B: 1 previous step
    const [, , ctxB] = plannerSpy.mock.calls[1]
    expect(ctxB.previousSteps).toHaveLength(1)
    expect(ctxB.previousSteps[0].instruction).toBe('Step A')

    // Step C: 2 previous steps
    const [, , ctxC] = plannerSpy.mock.calls[2]
    expect(ctxC.previousSteps).toHaveLength(2)
  })

  it('includes test duration', async () => {
    const config = makeRunTestConfig()
    const test = makeTestDef({ steps: ['Step A'] })

    const result = await runTest(test, config, '/tests/dur.yaml')

    expect(result.duration).toBeGreaterThanOrEqual(0)
  })

  it('skips onTestStart but still fires onTestEnd when pre-started by a caller', async () => {
    const reporter = {
      onTestStart: vi.fn(),
      onTestEnd: vi.fn(),
    }
    const config = makeRunTestConfig({
      reporters: [reporter],
      skipReporterOnTestStart: true,
    })
    const test = makeTestDef({ steps: ['Step A'] })

    const result = await runTest(test, config, '/tests/pre-started.yaml')

    expect(result.status).toBe('passed')
    expect(reporter.onTestStart).not.toHaveBeenCalled()
    expect(reporter.onTestEnd).toHaveBeenCalledWith(expect.objectContaining({
      name: test.name,
      status: 'passed',
    }))
  })

  it('can skip onTestEnd when caller finalizes the result after post-test work', async () => {
    const reporter = {
      onTestStart: vi.fn(),
      onTestEnd: vi.fn(),
    }
    const config = makeRunTestConfig({
      reporters: [reporter],
      skipReporterOnTestEnd: true,
    })
    const test = makeTestDef({ steps: ['Step A'] })

    const result = await runTest(test, config, '/tests/post-finalize.yaml')

    expect(result.status).toBe('passed')
    expect(reporter.onTestStart).toHaveBeenCalled()
    expect(reporter.onTestEnd).not.toHaveBeenCalled()
  })

  it('aborts an in-flight planner when the step timeout expires', async () => {
    let plannerSignal: AbortSignal | undefined
    const planner: Planner = {
      async plan(_step, _screenState, _context, abortSignal) {
        plannerSignal = abortSignal
        return new Promise((resolve, reject) => {
          abortSignal?.addEventListener('abort', () => reject(new Error('planner aborted')), { once: true })
          setTimeout(() => resolve({ plan: makeActionPlan() }), 200)
        })
      },
    }
    const config = makeRunTestConfig({
      planner,
      timeouts: { step: 25 },
    })
    const test = makeTestDef({ steps: ['Wait for slow local model'] })

    const startedAt = Date.now()
    const result = await runTest(test, config, '/tests/step-timeout.yaml')

    expect(Date.now() - startedAt).toBeLessThan(180)
    expect(plannerSignal?.aborted).toBe(true)
    expect(result.status).toBe('failed')
    expect(result.failureSummary).toContain('Step timed out after 25ms')
    expect(result.steps[0].status).toBe('failed')
    expect(result.steps[0].error).toContain('Step timed out after 25ms')
  })

  it('aborts an in-flight planner when the test timeout expires', async () => {
    let plannerSignal: AbortSignal | undefined
    const planner: Planner = {
      async plan(_step, _screenState, _context, abortSignal) {
        plannerSignal = abortSignal
        return new Promise((resolve, reject) => {
          abortSignal?.addEventListener('abort', () => reject(new Error('planner aborted')), { once: true })
          setTimeout(() => resolve({ plan: makeActionPlan() }), 200)
        })
      },
    }
    const config = makeRunTestConfig({
      planner,
      timeouts: { test: 25 },
    })
    const test = makeTestDef({ steps: ['Wait for slow local model'] })

    const startedAt = Date.now()
    const result = await runTest(test, config, '/tests/test-timeout.yaml')

    expect(Date.now() - startedAt).toBeLessThan(180)
    expect(plannerSignal?.aborted).toBe(true)
    expect(result.status).toBe('failed')
    expect(result.failureSummary).toContain('Test timed out after 25ms')
    expect(result.steps[0].status).toBe('failed')
    expect(result.steps[0].error).toContain('Test timed out after 25ms')
  })

  it('fails promptly when adapter.observe never resolves and the step timeout expires', async () => {
    let observeCalls = 0
    const adapter = createMockAdapter()
    adapter.observe = async () => {
      observeCalls++
      return await new Promise<ScreenState>(() => {})
    }
    const config = makeRunTestConfig({
      adapter,
      timeouts: { step: 25 },
    })
    const test = makeTestDef({ steps: ['Wait for hung observation'] })

    const startedAt = Date.now()
    const result = await runTest(test, config, '/tests/observe-timeout.yaml')

    expect(Date.now() - startedAt).toBeLessThan(180)
    expect(observeCalls).toBe(1)
    expect(result.status).toBe('failed')
    expect(result.failureSummary).toContain('Step timed out after 25ms')
    expect(result.steps[0].status).toBe('failed')
    expect(result.steps[0].error).toContain('Step timed out after 25ms')
  })

  it('fails promptly when adapter.execute never resolves and the step timeout expires', async () => {
    let executeCalls = 0
    const adapter = createMockAdapter()
    adapter.execute = async () => {
      executeCalls++
      return await new Promise<ActionResult>(() => {})
    }
    const config = makeRunTestConfig({
      adapter,
      timeouts: { step: 25 },
    })
    const test = makeTestDef({ steps: ['Click a hung button'] })

    const startedAt = Date.now()
    const result = await runTest(test, config, '/tests/execute-timeout.yaml')

    expect(Date.now() - startedAt).toBeLessThan(180)
    expect(executeCalls).toBe(1)
    expect(result.status).toBe('failed')
    expect(result.failureSummary).toContain('Step timed out after 25ms')
    expect(result.steps[0].status).toBe('failed')
    expect(result.steps[0].error).toContain('Step timed out after 25ms')
  })

  it('fails promptly when initial navigation never resolves and the test timeout expires', async () => {
    let executeCalls = 0
    const adapter = createMockAdapter()
    adapter.execute = async () => {
      executeCalls++
      return await new Promise<ActionResult>(() => {})
    }
    const config = makeRunTestConfig({
      adapter,
      timeouts: { test: 25 },
    })
    const test = makeTestDef({
      url: 'https://example.com/slow',
      steps: ['Click after navigation'],
    } as Partial<TestDefinition>)

    const startedAt = Date.now()
    const result = await runTest(test, config, '/tests/navigation-timeout.yaml')

    expect(Date.now() - startedAt).toBeLessThan(180)
    expect(executeCalls).toBe(1)
    expect(result.status).toBe('failed')
    expect(result.failureSummary).toContain('Test timed out after 25ms')
    expect(result.steps[0].status).toBe('failed')
    expect(result.steps[0].error).toContain('Test timed out after 25ms')
  })

  it('cancels promptly when SIGINT aborts initial navigation', async () => {
    let resolveExecuteStarted!: () => void
    const executeStarted = new Promise<void>((resolve) => {
      resolveExecuteStarted = resolve
    })
    const adapter = createMockAdapter()
    adapter.execute = async () => {
      resolveExecuteStarted()
      return await new Promise<ActionResult>(() => {})
    }
    const config = makeRunTestConfig({ adapter })
    const test = makeTestDef({
      url: 'https://example.com/slow',
      steps: ['Click after navigation'],
    } as Partial<TestDefinition>)

    const resultPromise = runTest(test, config, '/tests/navigation-cancel.yaml')
    await executeStarted
    process.emit('SIGINT')
    const result = await resultPromise

    expect(result.status).toBe('cancelled')
    expect(result.failureSummary).toContain('Test cancelled')
    expect(result.steps[0].status).toBe('cancelled')
    expect(result.steps[0].error).toContain('Step cancelled')
  })

  it('fails promptly when post-step screenshot capture never resolves and the step timeout expires', async () => {
    let screenshotCalls = 0
    const adapter = createMockAdapter()
    adapter.screenshot = async () => {
      screenshotCalls++
      if (screenshotCalls <= 3) return Buffer.from('png')
      return await new Promise<Buffer>(() => {})
    }
    const config = makeRunTestConfig({
      adapter,
      captureScreenshots: true,
      timeouts: { step: 25 },
    })
    const test = makeTestDef({ steps: ['Click before hung screenshot'] })

    const startedAt = Date.now()
    const result = await runTest(test, config, '/tests/screenshot-timeout.yaml')

    expect(Date.now() - startedAt).toBeLessThan(180)
    expect(screenshotCalls).toBe(4)
    expect(result.status).toBe('failed')
    expect(result.failureSummary).toContain('Step timed out after 25ms')
    expect(result.steps[0].status).toBe('failed')
    expect(result.steps[0].error).toContain('Step timed out after 25ms')
  })

  it('captures post-step screenshots as buffers without writing files', async () => {
    let screenshotCalls = 0
    const adapter = createMockAdapter()
    adapter.screenshot = async () => {
      screenshotCalls++
      return Buffer.from(`png-${screenshotCalls}`)
    }
    const config = makeRunTestConfig({
      adapter,
      captureScreenshots: true,
    })
    const test = makeTestDef({ steps: ['Click before screenshot capture'] })

    const result = await runTest(test, config, '/tests/screenshot-buffer.yaml')

    expect(result.status).toBe('passed')
    expect(result.steps[0].screenshot?.toString()).toBe('png-4')
    expect(mockFsWriteFile).not.toHaveBeenCalled()
  })

  it('fails promptly when post-step accessibility never resolves and the step timeout expires', async () => {
    const adapter = createMockAdapter() as PlatformAdapter & { getPage: () => unknown }
    adapter.getPage = () => ({})
    mockRunAccessibilityCheck.mockImplementationOnce(async () => await new Promise(() => {}))
    const config = makeRunTestConfig({
      adapter,
      accessibility: { enabled: true, runAfter: 'every-step' },
      timeouts: { step: 25 },
    })
    const test = makeTestDef({ steps: ['Click before hung accessibility'] })

    const startedAt = Date.now()
    const result = await runTest(test, config, '/tests/accessibility-timeout.yaml')

    expect(Date.now() - startedAt).toBeLessThan(180)
    expect(mockRunAccessibilityCheck).toHaveBeenCalledOnce()
    expect(result.status).toBe('failed')
    expect(result.failureSummary).toContain('Step timed out after 25ms')
    expect(result.steps[0].status).toBe('failed')
    expect(result.steps[0].error).toContain('Step timed out after 25ms')
  })

  it('records accessibility violations without failing when failOnViolation is false', async () => {
    const page = {}
    const adapter = createMockAdapter() as PlatformAdapter & { getPage: () => unknown }
    adapter.getPage = () => page
    const violation = {
      ruleId: 'image-alt',
      impact: 'critical' as const,
      description: 'Images must have alternate text',
      help: 'Image elements must have alternate text',
      helpUrl: 'https://dequeuniversity.com/rules/axe/4.10/image-alt',
      nodes: [{ html: '<img src="hero.png">', target: ['img'] }],
    }
    mockRunAccessibilityCheck.mockResolvedValueOnce([violation])
    const config = makeRunTestConfig({
      adapter,
      accessibility: {
        enabled: true,
        standard: 'wcag2aa',
        runAfter: 'every-step',
        failOnViolation: false,
      },
    })
    const test = makeTestDef({ steps: ['Inspect WAI BAD page'] })

    const result = await runTest(test, config, '/tests/bad-a11y.yaml')

    expect(result.status).toBe('passed')
    expect(result.steps[0].status).toBe('passed')
    expect(result.steps[0].accessibilityViolations).toEqual([violation])
    expect(mockRunAccessibilityCheck).toHaveBeenCalledWith(page, {
      standard: 'wcag2aa',
      disableRules: undefined,
      exclude: undefined,
    })
  })

  it('uses an injected accessibility checker when provided', async () => {
    const page = {}
    const adapter = createMockAdapter() as PlatformAdapter & { getPage: () => unknown }
    adapter.getPage = () => page
    const violation = {
      ruleId: 'image-alt',
      impact: 'critical' as const,
      description: 'Images must have alternate text',
      help: 'Image elements must have alternate text',
      helpUrl: 'https://dequeuniversity.com/rules/axe/4.10/image-alt',
      nodes: [{ html: '<img src="hero.png">', target: ['img'] }],
    }
    const accessibilityCheck = vi.fn().mockResolvedValue([violation])
    const config = makeRunTestConfig({
      adapter,
      accessibility: {
        enabled: true,
        standard: 'wcag2aa',
        runAfter: 'every-step',
        failOnViolation: false,
      },
      accessibilityCheck,
    })
    const test = makeTestDef({ steps: ['Inspect WAI BAD page'] })

    const result = await runTest(test, config, '/tests/bad-a11y.yaml')

    expect(result.status).toBe('passed')
    expect(result.steps[0].accessibilityViolations).toEqual([violation])
    expect(accessibilityCheck).toHaveBeenCalledWith(page, {
      standard: 'wcag2aa',
      disableRules: undefined,
      exclude: undefined,
    })
    expect(mockRunAccessibilityCheck).not.toHaveBeenCalled()
  })

  it('fails promptly when post-step device log polling never resolves and the step timeout expires', async () => {
    let pollCalls = 0
    const adapter = createMockAdapter() as PlatformAdapter & { pollDeviceLogs: () => Promise<void> }
    adapter.pollDeviceLogs = async () => {
      pollCalls++
      return await new Promise<void>(() => {})
    }
    const config = makeRunTestConfig({
      adapter,
      timeouts: { step: 25 },
    })
    const test = makeTestDef({ steps: ['Click before hung device logs'] })

    const startedAt = Date.now()
    const result = await runTest(test, config, '/tests/device-log-timeout.yaml')

    expect(Date.now() - startedAt).toBeLessThan(180)
    expect(pollCalls).toBe(1)
    expect(result.status).toBe('failed')
    expect(result.failureSummary).toContain('Step timed out after 25ms')
    expect(result.steps[0].status).toBe('failed')
    expect(result.steps[0].error).toContain('Step timed out after 25ms')
  })

  it('cancels promptly when SIGINT aborts a never-resolving adapter observe', async () => {
    let resolveObserveStarted!: () => void
    const observeStarted = new Promise<void>((resolve) => {
      resolveObserveStarted = resolve
    })
    const adapter = createMockAdapter()
    adapter.observe = async () => {
      resolveObserveStarted()
      return await new Promise<ScreenState>(() => {})
    }
    const config = makeRunTestConfig({ adapter })
    const test = makeTestDef({ steps: ['Wait for cancellation'] })

    const resultPromise = runTest(test, config, '/tests/cancel-observe.yaml')
    await observeStarted
    process.emit('SIGINT')
    const result = await resultPromise

    expect(result.status).toBe('cancelled')
    expect(result.failureSummary).toContain('Test cancelled')
    expect(result.steps[0].status).toBe('cancelled')
    expect(result.steps[0].error).toContain('Step cancelled')
  })
})

describe('runTestWithRetry', () => {
  it('test passes on first try, retryCount=0', async () => {
    const config = makeRunTestConfig()
    const test = makeTestDef({ steps: ['Step A'] })

    const result = await runTestWithRetry(test, config, '/tests/pass.yaml')

    expect(result.status).toBe('passed')
    expect(result.retryCount).toBe(0)
  })

  it('test fails, retries entire test, succeeds on retry, retryCount=1', async () => {
    let executeCount = 0
    const adapter: PlatformAdapter = {
      platform: 'web',
      async setup() {},
      async cleanup() {},
      async observe() { return makeScreenState() },
      async execute() {
        executeCount++
        // First 3 calls fail (step fails in first test run with consecutive failure limit),
        // then succeed on retry (second test run)
        if (executeCount <= 3) return { success: false, error: 'Flaky test' }
        return { success: true }
      },
    }
    const config = makeRunTestConfig({
      adapter,
      healingConfig: { maxAttempts: 3 },
    })
    const test = makeTestDef({
      steps: ['Step A'],
      meta: { retries: 1 },
    })

    const result = await runTestWithRetry(test, config, '/tests/retry.yaml')

    expect(result.status).toBe('passed')
    expect(result.retryCount).toBe(1)
  })

  it('test fails all retries, returns failed with retryCount=N', async () => {
    const adapter = createMockAdapter({
      executeResults: [{ success: false, error: 'Always fails' }],
    })
    const config = makeRunTestConfig({
      adapter,
      healingConfig: { maxAttempts: 0 },
    })
    const test = makeTestDef({
      steps: ['Step A'],
      meta: { retries: 2 },
    })

    const result = await runTestWithRetry(test, config, '/tests/fail.yaml')

    expect(result.status).toBe('failed')
    expect(result.retryCount).toBe(2)
  })

  it('no retries configured (meta.retries undefined), fails on first attempt', async () => {
    const adapter = createMockAdapter({
      executeResults: [{ success: false, error: 'Fail' }],
    })
    const config = makeRunTestConfig({
      adapter,
      healingConfig: { maxAttempts: 0 },
    })
    const test = makeTestDef({ steps: ['Step A'] })

    const result = await runTestWithRetry(test, config, '/tests/noretry.yaml')

    expect(result.status).toBe('failed')
    expect(result.retryCount).toBe(0)
  })

  it('TestResult includes duration covering all retries', async () => {
    let runCount = 0
    const adapter: PlatformAdapter = {
      platform: 'web',
      async setup() {},
      async cleanup() {},
      async observe() { return makeScreenState() },
      async execute() {
        runCount++
        await new Promise(r => setTimeout(r, 5))
        if (runCount <= 1) return { success: false, error: 'Fail first' }
        return { success: true }
      },
    }
    const config = makeRunTestConfig({
      adapter,
      healingConfig: { maxAttempts: 0 },
    })
    const test = makeTestDef({
      steps: ['Step A'],
      meta: { retries: 1 },
    })

    const result = await runTestWithRetry(test, config, '/tests/dur.yaml')

    expect(result.duration).toBeGreaterThan(0)
  })
})

describe('browser disconnect detection', () => {
  it('returns cancelled status with "Browser closed by user" when adapter reports disconnect', async () => {
    const adapter = createMockAdapter()
    ;(adapter as any).isBrowserDisconnected = true
    const config = makeRunTestConfig({ adapter })
    const test = makeTestDef({ steps: ['Step A'] })

    const result = await runTest(test, config, '/tests/disconnect.yaml')

    expect(result.status).toBe('cancelled')
    expect(result.failureSummary).toBe('Browser closed by user')
  })

  it('does NOT cancel when isBrowserDisconnected is false', async () => {
    const adapter = createMockAdapter()
    ;(adapter as any).isBrowserDisconnected = false
    const config = makeRunTestConfig({ adapter })
    const test = makeTestDef({ steps: ['Step A'] })

    const result = await runTest(test, config, '/tests/no-disconnect.yaml')

    expect(result.status).toBe('passed')
  })

  it('does NOT cancel when adapter has no isBrowserDisconnected property', async () => {
    const config = makeRunTestConfig()
    const test = makeTestDef({ steps: ['Step A'] })

    const result = await runTest(test, config, '/tests/no-prop.yaml')

    expect(result.status).toBe('passed')
  })
})

describe('STEP-CTX-01 -- enriched previousSteps', () => {
  it('previousSteps include reasoning as separate field when trace.reasoning exists', async () => {
    const plannerSpy = vi.fn().mockResolvedValue({
      plan: makeActionPlan({ reasoning: 'Found the login button at ref=e5 and clicked it' }),
    })
    const planner: Planner = { plan: plannerSpy }
    const config = makeRunTestConfig({ planner })
    const test = makeTestDef({ steps: ['Click login', 'Enter email'] })

    await runTest(test, config, '/tests/context.yaml')

    const [, , ctxB] = plannerSpy.mock.calls[1]
    expect(ctxB.previousSteps[0].outcome).toContain('passed')
    expect(ctxB.previousSteps[0].reasoning).toBe('Found the login button at ref=e5 and clicked it')
  })

  it('full reasoning is preserved (no 200-char truncation)', async () => {
    const longReasoning = 'A'.repeat(300)
    const plannerSpy = vi.fn().mockResolvedValue({
      plan: makeActionPlan({ reasoning: longReasoning }),
    })
    const planner: Planner = { plan: plannerSpy }
    const config = makeRunTestConfig({ planner })
    const test = makeTestDef({ steps: ['Step A', 'Step B'] })

    await runTest(test, config, '/tests/trunc.yaml')

    const [, , ctxB] = plannerSpy.mock.calls[1]
    expect(ctxB.previousSteps[0].reasoning).toHaveLength(300)
  })

  it('previousSteps outcome still works without reasoning (trace undefined)', async () => {
    const plannerSpy = vi.fn().mockResolvedValue({
      plan: makeActionPlan({ reasoning: undefined as any }),
    })
    const planner: Planner = { plan: plannerSpy }
    const config = makeRunTestConfig({ planner })
    const test = makeTestDef({ steps: ['Step A', 'Step B'] })

    await runTest(test, config, '/tests/noreason.yaml')

    const [, , ctxB] = plannerSpy.mock.calls[1]
    expect(ctxB.previousSteps[0].outcome).toBe('passed')
    expect(ctxB.previousSteps[0].reasoning).toBeUndefined()
  })

  it('captured variables in outcome, reasoning as separate field', async () => {
    const plannerSpy = vi.fn().mockResolvedValue({
      plan: makeActionPlan({ reasoning: 'Extracted the ID from the header' }),
    })
    const planner: Planner = { plan: plannerSpy }
    const adapter = createMockAdapter()
    adapter.observe = async () => makeScreenState({ tree: 'heading "Order ID-42"' })
    const config = makeRunTestConfig({ planner, adapter })
    const test = makeTestDef({
      steps: [
        { step: 'Capture ID', capture: { variable: 'id', method: 'regex' as const, pattern: 'ID-(\\d+)' } },
        'Verify ID',
      ],
    })

    await runTest(test, config, '/tests/capture.yaml')

    const [, , ctxB] = plannerSpy.mock.calls[1]
    expect(ctxB.previousSteps[0].outcome).toContain('passed')
    expect(ctxB.previousSteps[0].outcome).toContain('(captured: id=42)')
    expect(ctxB.previousSteps[0].reasoning).toBe('Extracted the ID from the header')
  })

  it('previousSteps include plannedAction and verifierResponse fields', async () => {
    const plannerSpy = vi.fn().mockResolvedValue({
      plan: makeActionPlan({ reasoning: 'Click the button', action: { type: 'click', ref: 'btn-1' } }),
    })
    const planner: Planner = { plan: plannerSpy }
    const config = makeRunTestConfig({ planner })
    const test = makeTestDef({ steps: ['Click button', 'Next step'] })

    await runTest(test, config, '/tests/rich.yaml')

    const [, , ctxB] = plannerSpy.mock.calls[1]
    expect(ctxB.previousSteps[0]).toHaveProperty('reasoning')
    expect(ctxB.previousSteps[0]).toHaveProperty('plannedAction')
    expect(ctxB.previousSteps[0]).toHaveProperty('verifierResponse')
  })

  it('previousSteps sliced by plannerConfig.previousStepCount', async () => {
    const plannerSpy = vi.fn().mockResolvedValue({ plan: makeActionPlan() })
    const planner: Planner = { plan: plannerSpy }
    const config = makeRunTestConfig({
      planner,
      plannerConfig: { maxSubActions: 3, previousStepCount: 2 },
    })
    const test = makeTestDef({ steps: ['S1', 'S2', 'S3', 'S4'] })

    await runTest(test, config, '/tests/slice.yaml')

    const [, , ctxD] = plannerSpy.mock.calls[3]
    expect(ctxD.previousSteps).toHaveLength(2)
    expect(ctxD.previousSteps[0].instruction).toBe('S2')
    expect(ctxD.previousSteps[1].instruction).toBe('S3')
  })
})
