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

export type LanguageChoice = Language | 'browser'

export const LANGUAGE_NAMES: Record<Language, string> = {
  en: 'English',
  'zh-Hans': '简体中文',
  'zh-Hant': '繁體中文',
  ja: '日本語',
  ko: '한국어',
  es: 'Español',
  'pt-BR': 'Português (Brasil)',
  de: 'Deutsch',
  fr: 'Français',
  ru: 'Русский',
}

export const LANGUAGE_STORAGE_KEY = 'agent-qa.language'

export function isLanguage(value: unknown): value is Language {
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

export function browserLanguage(tags: readonly string[] = browserTags()): Language {
  const kept = tags.filter(wellFormed)
  if (kept.length === 0) return 'en'
  try {
    const matched = match(kept, LANGUAGES, 'en')
    return isLanguage(matched) ? matched : 'en'
  } catch {
    return 'en'
  }
}

export function readLanguageChoice(storage?: Pick<Storage, 'getItem'>): Language | undefined {
  try {
    const stored = (storage ?? globalThis.localStorage)?.getItem(LANGUAGE_STORAGE_KEY)
    return isLanguage(stored) ? stored : undefined
  } catch {
    return undefined
  }
}

export function storeLanguageChoice(
  choice: LanguageChoice,
  storage?: Pick<Storage, 'setItem' | 'removeItem'>,
): void {
  try {
    const target = storage ?? globalThis.localStorage
    if (choice === 'browser') target?.removeItem(LANGUAGE_STORAGE_KEY)
    else target?.setItem(LANGUAGE_STORAGE_KEY, choice)
  } catch {
    // Storage is optional; the choice still applies to this page.
  }
}

export function resolveLanguage(): Language {
  return readLanguageChoice() ?? browserLanguage()
}
