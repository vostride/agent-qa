import { match } from '@formatjs/intl-localematcher'

export const LANGUAGES = [
  'en',
  'zh-Hans',
  'zh-Hant',
  'ja',
  'ko',
  'es',
  'pt-BR',
  'de',
  'fr',
  'ru',
] as const

export type Language = (typeof LANGUAGES)[number]

const LANGUAGE_STORAGE_KEY = 'agent-qa.language'

function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value)
}

function wellFormed(tag: string): boolean {
  try {
    return Intl.getCanonicalLocales(tag).length > 0
  } catch {
    return false
  }
}

function browserTags(): readonly string[] {
  const nav = globalThis.navigator
  if (!nav) return []
  if (nav.languages?.length) return nav.languages
  return nav.language ? [nav.language] : []
}

function browserLanguage(tags: readonly string[] = browserTags()): Language {
  const kept = tags.filter(wellFormed)
  if (kept.length === 0) return 'en'
  try {
    const matched = match(kept, LANGUAGES, 'en')
    return isLanguage(matched) ? matched : 'en'
  } catch {
    return 'en'
  }
}

function readLanguageChoice(storage?: Pick<Storage, 'getItem'>): Language | undefined {
  try {
    const stored = (storage ?? globalThis.localStorage)?.getItem(LANGUAGE_STORAGE_KEY)
    return isLanguage(stored) ? stored : undefined
  } catch {
    return undefined
  }
}

export function resolveLanguage(): Language {
  return readLanguageChoice() ?? browserLanguage()
}
