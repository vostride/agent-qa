import { describe, expect, it } from 'vitest'

import { browserLanguage, readLanguageChoice } from '../languages'

describe('browserLanguage', () => {
  it.each([
    [['de-CH'], 'de'],
    [['de-AT'], 'de'],
    [['gsw-CH'], 'de'],
    [['pt-PT'], 'pt-BR'],
    [['pt'], 'pt-BR'],
    [['es-MX'], 'es'],
    [['es-419'], 'es'],
    [['fr-CA'], 'fr'],
    [['zh-TW'], 'zh-Hant'],
    [['zh-HK'], 'zh-Hant'],
    [['zh-MO'], 'zh-Hant'],
    [['zh-Hant'], 'zh-Hant'],
    [['zh-Hant-HK'], 'zh-Hant'],
    [['zh'], 'zh-Hans'],
    [['zh-CN'], 'zh-Hans'],
    [['zh-SG'], 'zh-Hans'],
    [['it'], 'en'],
    [['nl-BE'], 'en'],
    [['uk'], 'en'],
  ])('gives the closest shipped language for %j: %s', (tags, expected) => {
    expect(browserLanguage(tags)).toBe(expected)
  })

  it.each([
    [['zh-TW', 'zh', 'en'], 'zh-Hant'],
    [['it', 'de-CH', 'en'], 'de'],
  ])('reads the list %j in order: %s', (tags, expected) => {
    expect(browserLanguage(tags)).toBe(expected)
  })

  it.each([[['en_US']], [['C']], [['*']], [['']], [[]]])(
    'ignores the malformed list %j and gives English',
    (tags) => {
      expect(browserLanguage(tags)).toBe('en')
    },
  )

  it('skips a malformed tag and matches the next one', () => {
    expect(browserLanguage(['zh_TW', 'de'])).toBe('de')
  })

  it('reads US English from the browser when a test states no list of its own', () => {
    expect(navigator.languages).toEqual(['en-US'])
    expect(browserLanguage()).toBe('en')
  })
})

describe('readLanguageChoice', () => {
  const storing = (value: string | null) => ({ getItem: () => value })

  it('returns a saved language', () => {
    expect(readLanguageChoice(storing('de'))).toBe('de')
  })

  it.each([['xx'], ['../de'], [''], [null]])('ignores the saved value %j', (value) => {
    expect(readLanguageChoice(storing(value))).toBeUndefined()
  })

  it('ignores a storage that throws', () => {
    const storage = {
      getItem: () => {
        throw new Error('storage is disabled')
      },
    }
    expect(readLanguageChoice(storage)).toBeUndefined()
  })
})
