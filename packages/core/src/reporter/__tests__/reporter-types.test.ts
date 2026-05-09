import { describe, it, expect, vi } from 'vitest'
import { MultiReporter } from '../types.js'
import type { Reporter, RunSummary, StepEventContext } from '../types.js'
import type { StepResult, TestResult } from '../../types/result.js'
import type { TestDefinition } from '../../types/test.js'

function makeStepResult(overrides?: Partial<StepResult>): StepResult {
  return {
    name: 'Click button',
    status: 'passed',
    duration: 100,
    ...overrides,
  }
}

function makeTestResult(overrides?: Partial<TestResult>): TestResult {
  return {
    name: 'Login test',
    filePath: '/tests/login.yaml',
    status: 'passed',
    steps: [makeStepResult()],
    duration: 500,
    ...overrides,
  }
}

function makeTestDef(overrides?: Partial<TestDefinition>): TestDefinition {
  return {
    'test-id': 't_login-test',
    name: 'Login test',
    target: 'default',
    steps: ['Click Login'],
    ...overrides,
  }
}

function makeSummary(overrides?: Partial<RunSummary>): RunSummary {
  return {
    results: [makeTestResult()],
    duration: 1000,
    passed: 1,
    failed: 0,
    skipped: 0,
    ...overrides,
  }
}

describe('MultiReporter', () => {
  it('calls onTestStart on all child reporters', async () => {
    const r1: Reporter = { onTestStart: vi.fn() }
    const r2: Reporter = { onTestStart: vi.fn() }
    const multi = new MultiReporter([r1, r2])
    const test = makeTestDef()

    await multi.onTestStart(test, '/test.yaml')

    expect(r1.onTestStart).toHaveBeenCalledWith(test, '/test.yaml')
    expect(r2.onTestStart).toHaveBeenCalledWith(test, '/test.yaml')
  })

  it('forwards run ID context to all child reporters', async () => {
    const r1: Reporter = { onTestStart: vi.fn() }
    const r2: Reporter = { onTestStart: vi.fn() }
    const multi = new MultiReporter([r1, r2])
    const test = makeTestDef()
    const context = {
      runId: 'r_able-baker-charlie-delta-echo-foxtrot-golf-hotel-india-juliet',
    }

    await multi.onTestStart(test, '/test.yaml', context)

    expect(r1.onTestStart).toHaveBeenCalledWith(test, '/test.yaml', context)
    expect(r2.onTestStart).toHaveBeenCalledWith(test, '/test.yaml', context)
  })

  it('calls onStepEnd on all child reporters', async () => {
    const r1: Reporter = { onStepEnd: vi.fn() }
    const r2: Reporter = { onStepEnd: vi.fn() }
    const multi = new MultiReporter([r1, r2])
    const result = makeStepResult()

    await multi.onStepEnd(result, 'Login test')

    expect(r1.onStepEnd).toHaveBeenCalledWith(result, 'Login test')
    expect(r2.onStepEnd).toHaveBeenCalledWith(result, 'Login test')
  })

  it('forwards optional step metadata to all child reporters', async () => {
    const r1: Reporter = {
      onStepStart: vi.fn(),
      onStepPhase: vi.fn(),
      onStepEnd: vi.fn(),
    }
    const r2: Reporter = {
      onStepStart: vi.fn(),
      onStepPhase: vi.fn(),
      onStepEnd: vi.fn(),
    }
    const multi = new MultiReporter([r1, r2])
    const context: StepEventContext = {
      runId: 'r_child',
      parentRunId: 'r_suite',
      suiteIndex: 1,
      testIndex: 1,
      stepIndex: 2,
      stepId: 'step-2',
    }
    const phase = { phase: 'observe' as const, subActionIndex: 0, duration: 5 }
    const result = makeStepResult({ id: 'step-2' })

    await multi.onStepStart('Repeat action', 'Login test', context)
    await multi.onStepPhase(phase, 'Repeat action', 'Login test', context)
    await multi.onStepEnd(result, 'Login test', context)

    expect(r1.onStepStart).toHaveBeenCalledWith('Repeat action', 'Login test', context)
    expect(r2.onStepStart).toHaveBeenCalledWith('Repeat action', 'Login test', context)
    expect(r1.onStepPhase).toHaveBeenCalledWith(phase, 'Repeat action', 'Login test', context)
    expect(r2.onStepPhase).toHaveBeenCalledWith(phase, 'Repeat action', 'Login test', context)
    expect(r1.onStepEnd).toHaveBeenCalledWith(result, 'Login test', context)
    expect(r2.onStepEnd).toHaveBeenCalledWith(result, 'Login test', context)
  })

  it('handles reporter that throws without breaking others', async () => {
    const r1: Reporter = {
      onTestEnd: vi.fn().mockRejectedValue(new Error('boom')),
    }
    const r2: Reporter = { onTestEnd: vi.fn() }
    const multi = new MultiReporter([r1, r2])
    const result = makeTestResult()

    await multi.onTestEnd(result)

    expect(r1.onTestEnd).toHaveBeenCalled()
    expect(r2.onTestEnd).toHaveBeenCalledWith(result)
  })

  it('handles empty reporter array', async () => {
    const multi = new MultiReporter([])

    await expect(multi.onRunStart([])).resolves.toBeUndefined()
    await expect(multi.onStepEnd(makeStepResult(), 'test')).resolves.toBeUndefined()
    await expect(multi.onRunEnd(makeSummary())).resolves.toBeUndefined()
  })

  it('calls onRunStart and onRunEnd', async () => {
    const r1: Reporter = { onRunStart: vi.fn(), onRunEnd: vi.fn() }
    const multi = new MultiReporter([r1])
    const tests = [makeTestDef()]
    const summary = makeSummary()

    await multi.onRunStart(tests)
    await multi.onRunEnd(summary)

    expect(r1.onRunStart).toHaveBeenCalledWith(tests)
    expect(r1.onRunEnd).toHaveBeenCalledWith(summary)
  })

  it('works with partial implementation (only some methods)', async () => {
    const r1: Reporter = { onStepEnd: vi.fn() }
    const multi = new MultiReporter([r1])

    await expect(multi.onRunStart([])).resolves.toBeUndefined()
    await expect(multi.onTestStart(makeTestDef(), '/x.yaml')).resolves.toBeUndefined()
    await expect(multi.onStepStart('step', 'test')).resolves.toBeUndefined()

    const result = makeStepResult()
    await multi.onStepEnd(result, 'test')
    expect(r1.onStepEnd).toHaveBeenCalledWith(result, 'test')
  })

  it('calls onStepStart on all child reporters', async () => {
    const r1: Reporter = { onStepStart: vi.fn() }
    const r2: Reporter = { onStepStart: vi.fn() }
    const multi = new MultiReporter([r1, r2])

    await multi.onStepStart('Click button', 'Login test')

    expect(r1.onStepStart).toHaveBeenCalledWith('Click button', 'Login test')
    expect(r2.onStepStart).toHaveBeenCalledWith('Click button', 'Login test')
  })
})
