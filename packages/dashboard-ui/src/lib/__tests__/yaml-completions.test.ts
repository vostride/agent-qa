import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('monaco-editor', () => ({
  languages: {
    CompletionItemKind: {
      Module: 0,
      Value: 1,
      Property: 2,
      Enum: 3,
      EnumMember: 4,
    },
    CompletionItemInsertTextRule: {
      None: 0,
    },
    registerCompletionItemProvider: vi.fn(),
  },
}))

import i18n from '@/i18n'
import { yamlKeyDocumentation } from '../yaml-completions'

const STEPS_DOCUMENTATION =
  'Array of natural language test steps. Each step is a plain string like "Click the login button"'

describe('yamlKeyDocumentation', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en')
    i18n.removeResourceBundle('fr', 'translation')
  })

  it('returns the documentation of a YAML key in English', () => {
    expect(yamlKeyDocumentation(['steps'])).toBe(STEPS_DOCUMENTATION)
    expect(yamlKeyDocumentation(['config', 'browser', 'viewport', 'width'])).toBe(
      'Viewport width in pixels',
    )
  })

  it('keeps the variable syntax inside the sentence as written', () => {
    expect(yamlKeyDocumentation(['variables'])).toBe(
      'Key-value pairs for test variables. Access in steps via {{env:varName}} syntax. Overrides env file values.',
    )
  })

  it('returns nothing for the root and for a key it does not know', () => {
    expect(yamlKeyDocumentation([])).toBeUndefined()
    expect(yamlKeyDocumentation(['config', 'unknown'])).toBeUndefined()
  })

  it('follows the dashboard language each time it is asked', async () => {
    i18n.addResourceBundle('fr', 'translation', {
      'editor.yaml.steps': 'Liste des étapes du test en langage naturel.',
    })
    await i18n.changeLanguage('fr')
    expect(yamlKeyDocumentation(['steps'])).toBe('Liste des étapes du test en langage naturel.')

    await i18n.changeLanguage('en')
    expect(yamlKeyDocumentation(['steps'])).toBe(STEPS_DOCUMENTATION)
  })
})
