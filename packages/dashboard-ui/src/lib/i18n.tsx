import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react"

import zhCN from "@/lib/locales/zh-CN"

export type Locale = "en" | "zh-CN"

export const LOCALE_STORAGE_KEY = "agent-qa.locale"

const SUPPORTED_LOCALES: readonly Locale[] = ["en", "zh-CN"]

/** Values accepted by {@link t} / {@link translate} when interpolating a template. */
export type TParams = Record<string, string | number>

export type I18nContextValue = {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: (key: string, params?: TParams) => string
}

const I18nContext = createContext<I18nContextValue | null>(null)

function isLocale(value: unknown): value is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value as string)
}

function readStorageLocale(): Locale | null {
  try {
    const storage = globalThis.localStorage as Storage | undefined
    if (!storage) return null
    const raw = storage.getItem(LOCALE_STORAGE_KEY)
    return isLocale(raw) ? raw : null
  } catch {
    // A sandboxed page can throw on storage access; treat that as "no preference".
    return null
  }
}

function writeStorageLocale(locale: Locale): void {
  try {
    globalThis.localStorage?.setItem(LOCALE_STORAGE_KEY, locale)
  } catch {
    // Storage unavailable (private mode, sandboxed frame): the in-memory locale still applies.
  }
}

function detectBrowserLocale(): Locale {
  try {
    const nav = globalThis.navigator as Navigator | undefined
    if (!nav) return "en"
    const languages = nav.languages
    const candidates =
      Array.isArray(languages) && languages.length > 0 ? languages : [nav.language ?? ""]
    for (const candidate of candidates) {
      if (typeof candidate !== "string") continue
      const lowered = candidate.toLowerCase()
      if (lowered === "zh" || lowered.startsWith("zh-")) return "zh-CN"
    }
  } catch {
    // No usable navigator (non-DOM host).
  }
  return "en"
}

/**
 * Replace simple `{identifier}` placeholders in a template.
 *
 * Only `{[A-Za-z_][A-Za-z0-9_]*}` tokens are considered. Anything else (nested
 * braces, spaces, punctuation, `{1}`, `{}`) is left untouched, as is any token
 * whose name is absent from `params` or whose value is not a string/number, so a
 * missing value can never render as `[object Object]` or `undefined`.
 */
function format(template: string, params?: TParams): string {
  if (!params) return template
  return template.replace(/{([A-Za-z_][A-Za-z0-9_]*)}/g, (match: string, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(params, name)) return match
    const value = params[name]
    return typeof value === "string" || typeof value === "number" ? String(value) : match
  })
}

export function getLocale(): Locale {
  return readStorageLocale() ?? detectBrowserLocale()
}

export function setLocale(locale: Locale): void {
  writeStorageLocale(locale)
}

export function translate(locale: Locale, key: string, params?: TParams): string {
  if (locale !== "zh-CN") return format(key, params)
  const entry = (zhCN as Record<string, string>)[key]
  return format(typeof entry === "string" ? entry : key, params)
}

// Module-level helper for module-scope strings (e.g. the sidebar nav table).
// Safe because selecting a new language persists storage and reloads the page,
// so there is no module reactivity dependency. Reactive components must use
// useI18n().t, which re-renders on provider state change.
export function t(key: string, params?: TParams): string {
  return translate(getLocale(), key, params)
}

export function LanguageProvider({
  children,
  initialLocale,
}: {
  children: ReactNode
  initialLocale?: Locale
}) {
  const [locale, setLocaleState] = useState<Locale>(() => initialLocale ?? getLocale())

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale: (next: Locale) => {
        setLocale(next)
        setLocaleState(next)
      },
      t: (key: string, params?: TParams) => translate(locale, key, params),
    }),
    [locale],
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext)
  if (!context) throw new Error("useI18n must be used within a LanguageProvider")
  return context
}
