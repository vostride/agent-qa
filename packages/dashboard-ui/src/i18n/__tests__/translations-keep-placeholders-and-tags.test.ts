import { describe, expect, it } from 'vitest'

import { LANGUAGES, type Language } from '@/i18n/languages'
import de from '@/i18n/locales/de'
import en from '@/i18n/locales/en'
import es from '@/i18n/locales/es'
import fr from '@/i18n/locales/fr'
import ja from '@/i18n/locales/ja'
import ko from '@/i18n/locales/ko'
import ptBR from '@/i18n/locales/pt-BR'
import ru from '@/i18n/locales/ru'
import zhHans from '@/i18n/locales/zh-Hans'
import zhHant from '@/i18n/locales/zh-Hant'

type Catalog = Readonly<Record<string, string>>
type Translated = Exclude<Language, 'en'>
type EnglishPair = { text: string; pluralForm?: string }

const ENGLISH: Catalog = en

const CATALOGS: Record<Translated, Catalog> = {
  de,
  es,
  fr,
  ja,
  ko,
  'pt-BR': ptBR,
  ru,
  'zh-Hans': zhHans,
  'zh-Hant': zhHant,
}

const TRANSLATED = LANGUAGES.filter((language): language is Translated => language !== 'en')

function problems(_english: string, _translation: string, _pluralForm?: string): string[] {
  return []
}

function englishFor(_key: string, _english: Catalog = ENGLISH): EnglishPair | undefined {
  return undefined
}

function issuesIn(catalog: Catalog, english: Catalog = ENGLISH): string[] {
  const issues: string[] = []
  for (const [key, translation] of Object.entries(catalog)) {
    const pair = englishFor(key, english)
    if (!pair) continue
    const found = problems(pair.text, translation, pair.pluralForm)
    if (found.length) issues.push(`${key}: ${found.join('; ')}`)
  }
  return issues
}

describe('the slots of a translation', () => {
  it('passes the same slots in another order', () => {
    expect(problems('Ran {{name}} {{count}} times', '{{count}} Mal {{name}} ausgeführt')).toEqual([])
  })

  it('reports a slot the translation leaves out', () => {
    expect(problems('Ran {{name}} {{count}} times', '{{count}} Mal ausgeführt')).toContain(
      'missing {{name}}',
    )
  })

  it('reports a misspelled slot as missing and added', () => {
    expect(problems('Ran {{name}}', '{{nmae}} ausgeführt')).toEqual([
      'missing {{name}}',
      'added {{nmae}}',
    ])
  })

  it('reports a slot the English text does not have', () => {
    expect(problems('Ran {{name}}', '{{name}} von {{user}} ausgeführt')).toEqual(['added {{user}}'])
  })

  it('reads a slot with a format as the slot itself', () => {
    expect(problems('{{count}} runs', '{{count, number}} Läufe')).toEqual([])
  })

  it('lets a singular form leave the count out', () => {
    expect(problems('{{count}} run', 'Ein Lauf', 'one')).toEqual([])
  })

  it('lets a plural form write the count where the English does not', () => {
    expect(problems('once', '{{count}} раз', 'one')).toEqual([])
  })

  it('reports a count left out of a form that is not singular', () => {
    expect(problems('{{count}} runs', 'запуска', 'few')).toEqual(['missing {{count}}'])
  })
})

describe('the tags of a translation', () => {
  it('passes bare opening, closing and self-closing tags the English text has', () => {
    expect(problems('Read <b>this</b> in <docs/>', 'Lies <b>das</b> in <docs/>')).toEqual([])
  })

  it('reports a tag that carries an attribute', () => {
    expect(
      problems(
        'See <docs>the docs</docs>',
        'Siehe <docs href="https://elsewhere.example">die Doku</docs>',
      ),
    ).toEqual(['tag <docs href="https://elsewhere.example"> is not bare'])
  })

  it('passes the same sentence with a bare tag', () => {
    expect(problems('See <docs>the docs</docs>', 'Siehe <docs>die Doku</docs>')).toEqual([])
  })

  it('reports anything after a tag name', () => {
    expect(problems('Read <b>this</b>', 'Lies <b class=x>das</b>')).toEqual([
      'tag <b class=x> is not bare',
    ])
  })

  it('reports a tag the English text does not have', () => {
    expect(problems('Read this', 'Lies <i>das</i>')).toEqual([
      'tag <i> is not in the English text',
      'tag </i> is not in the English text',
    ])
  })

  it('reports a tag of the English text the translation leaves out', () => {
    expect(problems('No targets. <link>Add one.</link>', 'Keine Ziele. Eines hinzufügen.')).toEqual(
      ['missing tag <link>'],
    )
  })
})

describe('pairing a translated key with its English text', () => {
  const english = { 'run.count_one': '{{count}} run', 'run.count_other': '{{count}} runs' }

  it('pairs a key with the same English key', () => {
    expect(englishFor('run.count_one', english)).toEqual({ text: '{{count}} run', pluralForm: 'one' })
  })

  it('pairs a plural form English does not write with the English other form', () => {
    expect(englishFor('run.count_few', english)).toEqual({ text: '{{count}} runs', pluralForm: 'few' })
  })

  it('pairs a key that is not plural with its English text alone', () => {
    expect(englishFor('nav.runs')).toEqual({ text: en['nav.runs'] })
  })

  it('looks only at the keys a language has', () => {
    expect(issuesIn({ 'run.count_other': '{{count}} Läufe' }, english)).toEqual([])
  })

  it('names each key with what is wrong', () => {
    expect(issuesIn({ 'run.count_other': 'Läufe' }, english)).toEqual([
      'run.count_other: missing {{count}}',
    ])
  })

  it('passes an empty catalog', () => {
    expect(issuesIn({})).toEqual([])
  })
})

describe('every translation that exists', () => {
  it.each(TRANSLATED)('%s keeps the slots and bare tags of its English text', (language) => {
    expect(issuesIn(CATALOGS[language])).toEqual([])
  })
})
