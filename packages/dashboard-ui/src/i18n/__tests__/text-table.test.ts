import { afterEach, describe, expect, it } from 'vitest'

import i18n, { t } from '@/i18n'
import { textTable } from '@/i18n/text-table'
import { RESULT_WORDS } from '@/lib/action-vocabulary'

afterEach(async () => {
  await i18n.changeLanguage('en')
  i18n.removeResourceBundle('de', 'translation')
})

describe('a text table', () => {
  it('reads each member through its getter', () => {
    const table = textTable({ a: () => 'x', b: () => 'y' })
    const key = 'b' as 'a' | 'b'

    expect(table.a).toBe('x')
    expect(table[key]).toBe('y')
    expect(Object.keys(table)).toEqual(['a', 'b'])
    expect(Object.values(table)).toEqual(['x', 'y'])
    expect({ ...table }).toEqual({ a: 'x', b: 'y' })
  })

  it('reads a member again on every read', () => {
    let calls = 0
    const table = textTable({ a: () => `read ${++calls}` })

    expect(table.a).toBe('read 1')
    expect(table.a).toBe('read 2')
  })

  it('refuses a write to a member', () => {
    const table = textTable({ a: () => 'x' })

    expect(() => {
      ;(table as { a: string }).a = 'y'
    }).toThrow(TypeError)
    expect(table.a).toBe('x')
  })

  it('returns the text of the language in use after a change, from the same table', async () => {
    const table = textTable({ runs: () => t('nav.runs') })
    expect(table.runs).toBe('Runs')

    i18n.addResourceBundle('de', 'translation', { 'nav.runs': 'Läufe' })
    await i18n.changeLanguage('de')

    expect(table.runs).toBe('Läufe')
  })

  it('keeps a member that returns a function callable', () => {
    const table = textTable({ shown: () => (count: number) => `Showing ${count}` })

    expect(table.shown(3)).toBe('Showing 3')
  })
})

describe('the result words', () => {
  it('read passed, failed, healed and no input sent in English', () => {
    expect({ ...RESULT_WORDS }).toEqual({
      passed: 'passed',
      failed: 'failed',
      healed: 'healed',
      'no-input': 'no input sent',
    })
  })

  it('follow a language change without reloading the module', async () => {
    i18n.addResourceBundle('de', 'translation', { 'action.result.noInput': 'keine Eingabe gesendet' })
    await i18n.changeLanguage('de')

    expect(RESULT_WORDS['no-input']).toBe('keine Eingabe gesendet')
    expect(RESULT_WORDS.passed).toBe('passed')
  })
})
