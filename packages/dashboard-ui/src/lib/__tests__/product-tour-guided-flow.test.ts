import { describe, expect, it } from 'vitest'

import {
  foundationProductTourSteps,
  getVisibleProductTourSteps,
  resolveProductTourStepRoute,
  type ProductTourRuntimeContext,
} from '@/lib/product-tour-steps'

function stepIds(context: ProductTourRuntimeContext = {}) {
  return getVisibleProductTourSteps(context).map((step) => step.id)
}

function step(id: string, context: ProductTourRuntimeContext = {}) {
  const match = getVisibleProductTourSteps(context).find((tourStep) => tourStep.id === id)
  expect(match, id).toBeDefined()
  return match!
}

describe('guided first-run product tour flow', () => {
  it('starts with installed-product agent-qa orientation copy', () => {
    const intro = foundationProductTourSteps[0]

    expect(intro).toMatchObject({
      id: 'intro',
      title: 'Welcome to agent-qa',
      centered: true,
    })
    expect(intro.body).toBe(
      'agent-qa lets you write tests in natural language for web and mobile. It runs them through a strict QA harness, learns from past runs, adapts when the UI changes, and shows you exactly what happened.',
    )
  })

  it('routes the LLM setup step to the registry LLM config page', () => {
    const llmSetup = step('llm-setup')

    expect(llmSetup.title).toBe('Configure your LLM first')
    expect(llmSetup.body).toBe(
      'A run needs an LLM. Add or choose one, test the connection, save the config, then continue.',
    )
    expect(resolveProductTourStepRoute(llmSetup)).toBe('/config?bucket=registry&item=llms')
  })

  it('keeps the wayfinding sweep short and outcome-focused', () => {
    expect(stepIds({ exampleTestId: 'example-test-id', runId: 'run-123' }).slice(0, 8)).toEqual([
      'intro',
      'llm-setup',
      'runs',
      'tests',
      'suites',
      'hooks',
      'memory',
      'config',
    ])

    expect(step('runs').body).toContain('outcomes')
    expect(step('tests').body).toContain('natural-language')
    expect(step('suites').body).toContain('repeatable')
    expect(step('hooks').body).toContain('between steps')
    expect(step('memory').body).toContain('learned')
    expect(step('config').body).toContain('model')
  })

  it('uses the resolved Example passing test when a real test id exists', () => {
    const context: ProductTourRuntimeContext = { exampleTestId: 'test-generated-pass' }

    expect(stepIds(context)).toContain('example-test')
    expect(stepIds(context)).not.toContain('example-missing')
    expect(resolveProductTourStepRoute(step('example-test', context), context)).toBe(
      '/test/test-generated-pass',
    )
    expect(step('example-test', context).body).toContain('safest first run')
  })

  it('falls back to Tests guidance when the generated example is missing', () => {
    const context: ProductTourRuntimeContext = { exampleTestId: null }

    expect(stepIds(context)).toContain('example-missing')
    expect(stepIds(context)).not.toContain('example-test')
    expect(resolveProductTourStepRoute(step('example-missing', context), context)).toBe('/tests')
    expect(step('example-missing', context).body).toContain(
      'agent-qa init normally creates Example passing test',
    )
  })

  it('routes live and run detail steps only when a run id is available', () => {
    const withRun: ProductTourRuntimeContext = {
      exampleTestId: 'test-generated-pass',
      runId: 'run-generated-pass',
    }
    const withoutRun: ProductTourRuntimeContext = { exampleTestId: 'test-generated-pass' }

    expect(resolveProductTourStepRoute(step('live-run', withRun), withRun)).toBe(
      '/runs/run-generated-pass/live',
    )
    expect(resolveProductTourStepRoute(step('run-detail', withRun), withRun)).toBe(
      '/runs/run-generated-pass',
    )
    expect(stepIds(withoutRun)).not.toContain('live-run')
    expect(stepIds(withoutRun)).not.toContain('run-detail')
    expect(resolveProductTourStepRoute(step('runs-fallback', withoutRun), withoutRun)).toBe(
      '/runs',
    )
  })

  it('does not include the GitHub value nudge in the base guided flow', () => {
    expect(stepIds({ exampleTestId: 'test-generated-pass', runId: 'run-generated-pass' })).not.toContain(
      'github-nudge',
    )
  })
})
