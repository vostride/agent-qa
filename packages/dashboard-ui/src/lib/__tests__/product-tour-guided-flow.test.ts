import { afterEach, describe, expect, it } from 'vitest'

import i18n from '@/i18n'
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

  it('routes the LLM setup step to the Models tab', () => {
    const llmSetup = step('llm-setup')

    expect(llmSetup.title).toBe('Configure your LLM first')
    expect(llmSetup.body).toBe(
      "A run needs a model. Add one: choose how you connect, and it's tested and saved as soon as it works.",
    )
    expect(llmSetup.body).not.toContain('save the config')
    expect(resolveProductTourStepRoute(llmSetup)).toBe('/config/models')
  })

  it('keeps the wayfinding sweep short and outcome-focused', () => {
    expect(stepIds({ exampleTestId: 'example-test-id', runId: 'run-123' }).slice(0, 7)).toEqual([
      'intro',
      'llm-setup',
      'runs',
      'tests',
      'suites',
      'hooks',
      'config',
    ])

    expect(step('runs').body).toContain('outcomes')
    expect(step('tests').body).toContain('natural-language')
    expect(step('suites').body).toContain('repeatable')
    expect(step('hooks').body).toContain('between steps')
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

describe('tour steps after a language change', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en')
    i18n.removeResourceBundle('fr', 'translation')
  })

  it('reads the same step objects in the current language each time they are read', async () => {
    i18n.addResourceBundle('fr', 'translation', {
      'tour.intro.title': 'Bienvenue dans agent-qa',
      'tour.intro.body': 'agent-qa exécute vos tests écrits en langage naturel.',
    })
    const intro = foundationProductTourSteps[0]

    await i18n.changeLanguage('fr')
    expect(intro.title).toBe('Bienvenue dans agent-qa')
    expect(intro.body).toBe('agent-qa exécute vos tests écrits en langage naturel.')
    expect(getVisibleProductTourSteps()[0].title).toBe('Bienvenue dans agent-qa')

    await i18n.changeLanguage('en')
    expect(foundationProductTourSteps[0].title).toBe('Welcome to agent-qa')
    expect(getVisibleProductTourSteps()[0].title).toBe('Welcome to agent-qa')
  })

  it('labels the GitHub link in the current language and keeps its address and icon', async () => {
    const nudge = foundationProductTourSteps.find((tourStep) => tourStep.id === 'github-nudge')
    expect(nudge?.action?.label).toBe('View on GitHub')

    i18n.addResourceBundle('fr', 'translation', {
      'tour.githubNudge.actionLabel': 'Voir sur GitHub',
    })
    await i18n.changeLanguage('fr')

    expect(nudge?.action).toMatchObject({
      label: 'Voir sur GitHub',
      href: 'https://github.com/vostride/agent-qa',
      icon: 'github',
    })
  })
})
