// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'

import i18n, { applyLanguage } from '@/i18n'
import { browserLanguage, LANGUAGES } from '@/i18n/languages'
import en from '@/i18n/locales/en'

const OTHER_LANGUAGES = LANGUAGES.filter((language) => language !== 'en')

afterEach(async () => {
  await applyLanguage('en')
  for (const language of OTHER_LANGUAGES) i18n.removeResourceBundle(language, 'translation')
})

describe('text a language lacks', () => {
  it('shows the English text for a key the language does not have', async () => {
    i18n.addResourceBundle('fr', 'translation', { 'nav.runs': 'Exécutions' })
    await applyLanguage('fr')

    expect(i18n.t('nav.runs')).toBe('Exécutions')
    expect(i18n.t('nav.config')).toBe(en['nav.config'])
  })

  it('shows the English text for an empty translation', async () => {
    i18n.addResourceBundle('fr', 'translation', { 'nav.config': '' })
    await applyLanguage('fr')

    expect(i18n.t('nav.config')).toBe(en['nav.config'])
  })
})

describe('loading a language', () => {
  it.each(OTHER_LANGUAGES)('loads %s from its own chunk and sets the page language', async (language) => {
    await applyLanguage(language)

    expect(i18n.hasResourceBundle(language, 'translation')).toBe(true)
    expect(i18n.language).toBe(language)
    expect(document.documentElement.lang).toBe(language)
  })

  it('keeps the language it had when a chunk fails to load', async () => {
    await applyLanguage('de')

    await expect(applyLanguage('ja', () => Promise.reject(new Error('offline')))).resolves.toBeUndefined()

    expect(i18n.language).toBe('de')
    expect(document.documentElement.lang).toBe('de')
  })

  it('settles on the later of two requests made in a row', async () => {
    let release: () => void = () => {}
    const slow = applyLanguage(
      'ja',
      () => new Promise((resolve) => (release = () => resolve({ default: {} }))),
    )

    await applyLanguage('de')
    release()
    await slow

    expect(i18n.language).toBe('de')
    expect(document.documentElement.lang).toBe('de')
  })
})

describe('the browser language in a jsdom test', () => {
  it('reads US English when the test states no list of its own', () => {
    expect(navigator.languages).toEqual(['en-US'])
    expect(browserLanguage()).toBe('en')
  })
})
