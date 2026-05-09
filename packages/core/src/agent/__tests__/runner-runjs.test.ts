import { describe, it, expect, vi } from 'vitest'
import type { PlatformAdapter, ScreenState, Action, ActionResult } from '../../types/platform.js'
import type { ActionPlan } from '../../schema/action-schema.js'
import type { Planner, StepContext } from '../types.js'
import type { TestDefinition } from '../../types/test.js'
import { runTest } from '../runner.js'
import type { RunTestConfig } from '../runner.js'

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
  platform?: 'web' | 'android' | 'ios'
  getPage?: () => any
}): PlatformAdapter {
  let executeCallCount = 0
  const executeResults = options?.executeResults ?? [{ success: true }]
  const adapter: any = {
    platform: options?.platform ?? 'web',
    async setup() {},
    async cleanup() {},
    async observe() { return makeScreenState() },
    async execute(_action: Action) {
      const idx = Math.min(executeCallCount, executeResults.length - 1)
      executeCallCount++
      return executeResults[idx]
    },
  }
  if (options?.getPage) {
    adapter.getPage = options.getPage
  }
  return adapter as PlatformAdapter
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

function makeTestDef(overrides?: Partial<TestDefinition>): TestDefinition {
  return {
    'test-id': 't_runjs-test',
    name: 'RunJS test',
    target: 'default',
    steps: ['Click OK'],
    ...overrides,
  }
}

describe('runTest with runJS templates', () => {
  it('resolves runJS template on web platform via page.evaluate', async () => {
    const plannerSpy = vi.fn().mockResolvedValue({ plan: makeActionPlan() })
    const planner: Planner = { plan: plannerSpy }

    const config = makeRunTestConfig({
      adapter: createMockAdapter({
        platform: 'web',
        getPage: () => ({ evaluate: vi.fn().mockResolvedValue('Example Title') }),
      }),
      planner,
    })

    const test = makeTestDef({
      steps: ['Verify title is {{runJS:"document.title"}}'],
    })

    await runTest(test, config, '/tests/runjs.yaml')

    const instruction = plannerSpy.mock.calls[0][0]
    expect(instruction).toContain('Example Title')
    expect(instruction).not.toContain('{{runJS')
  })

  it('injects error text on JS execution failure', async () => {
    const plannerSpy = vi.fn().mockResolvedValue({ plan: makeActionPlan() })
    const planner: Planner = { plan: plannerSpy }

    const config = makeRunTestConfig({
      adapter: createMockAdapter({
        platform: 'web',
        getPage: () => ({
          evaluate: vi.fn().mockRejectedValue(new Error('ReferenceError: x is not defined')),
        }),
      }),
      planner,
    })

    const test = makeTestDef({
      steps: ['Check {{runJS:"x.y.z"}}'],
    })

    const result = await runTest(test, config, '/tests/runjs-err.yaml')

    const instruction = plannerSpy.mock.calls[0][0]
    expect(instruction).toContain('[runJS error: ReferenceError: x is not defined]')
    expect(result.steps.length).toBeGreaterThanOrEqual(1)
  })

  it('injects platform error on mobile', async () => {
    const plannerSpy = vi.fn().mockResolvedValue({ plan: makeActionPlan() })
    const planner: Planner = { plan: plannerSpy }

    const config = makeRunTestConfig({
      adapter: createMockAdapter({ platform: 'android' }),
      planner,
    })

    const test = makeTestDef({
      steps: ['Check {{runJS:"document.title"}}'],
    })

    await runTest(test, config, '/tests/runjs-mobile.yaml')

    const instruction = plannerSpy.mock.calls[0][0]
    expect(instruction).toContain('[runJS error: runJS is only supported on web platform]')
  })

  it('injects error when page is null', async () => {
    const plannerSpy = vi.fn().mockResolvedValue({ plan: makeActionPlan() })
    const planner: Planner = { plan: plannerSpy }

    const config = makeRunTestConfig({
      adapter: createMockAdapter({
        platform: 'web',
        getPage: () => null,
      }),
      planner,
    })

    const test = makeTestDef({
      steps: ['Check {{runJS:"document.title"}}'],
    })

    await runTest(test, config, '/tests/runjs-null.yaml')

    const instruction = plannerSpy.mock.calls[0][0]
    expect(instruction).toContain('[runJS error: no browser page available]')
  })

  it('stores originalStepName when runJS templates are present', async () => {
    const plannerSpy = vi.fn().mockResolvedValue({ plan: makeActionPlan() })
    const planner: Planner = { plan: plannerSpy }

    const config = makeRunTestConfig({
      adapter: createMockAdapter({
        platform: 'web',
        getPage: () => ({ evaluate: vi.fn().mockResolvedValue('Example Title') }),
      }),
      planner,
    })

    const test = makeTestDef({
      steps: ['Verify title is {{runJS:"document.title"}}'],
    })

    const result = await runTest(test, config, '/tests/runjs-original.yaml')

    expect(result.steps[0].originalStepName).toBe('Verify title is {{runJS:"document.title"}}')
  })

  it('resolves multiple runJS templates in one step', async () => {
    const evaluateFn = vi.fn()
      .mockResolvedValueOnce('Title')
      .mockResolvedValueOnce('https://example.com')
    const plannerSpy = vi.fn().mockResolvedValue({ plan: makeActionPlan() })
    const planner: Planner = { plan: plannerSpy }

    const config = makeRunTestConfig({
      adapter: createMockAdapter({
        platform: 'web',
        getPage: () => ({ evaluate: evaluateFn }),
      }),
      planner,
    })

    const test = makeTestDef({
      steps: ['Verify {{runJS:"document.title"}} on {{runJS:"window.location.href"}}'],
    })

    await runTest(test, config, '/tests/runjs-multi.yaml')

    const instruction = plannerSpy.mock.calls[0][0]
    expect(instruction).toContain('Title')
    expect(instruction).toContain('https://example.com')
    expect(instruction).not.toContain('{{runJS')
  })
})
