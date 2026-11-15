import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import { LANGUAGES, resolveLanguage, type Language } from './languages'
import en from './locales/en'

type Bundle = { default: Record<string, string> }
type Loader = () => Promise<Bundle>

const loaders: Record<Exclude<Language, 'en'>, Loader> = {
  'zh-Hans': () => import('./locales/zh-Hans'),
  'zh-Hant': () => import('./locales/zh-Hant'),
  ja: () => import('./locales/ja'),
  ko: () => import('./locales/ko'),
  es: () => import('./locales/es'),
  'pt-BR': () => import('./locales/pt-BR'),
  de: () => import('./locales/de'),
  fr: () => import('./locales/fr'),
  ru: () => import('./locales/ru'),
}

i18n.on('languageChanged', (language) => {
  if (typeof document !== 'undefined') document.documentElement.lang = language
})

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en } },
  lng: 'en',
  fallbackLng: 'en',
  supportedLngs: LANGUAGES,
  keySeparator: false,
  initAsync: false,
  interpolation: { escapeValue: false },
})

let latestRequest = 0

export async function applyLanguage(language: Language, load?: Loader): Promise<void> {
  const request = ++latestRequest
  if (language !== 'en' && !i18n.hasResourceBundle(language, 'translation')) {
    const bundle = await (load ?? loaders[language])().then(
      (loaded) => loaded.default,
      () => undefined,
    )
    if (bundle) i18n.addResourceBundle(language, 'translation', bundle, true, true)
    if (request !== latestRequest || !bundle) return
  }
  if (request !== latestRequest) return
  await i18n.changeLanguage(language)
}

export async function startLanguage(): Promise<void> {
  try {
    await applyLanguage(resolveLanguage())
  } catch {
    // The page still renders in the language it already has.
  }
}

export const t = i18n.t.bind(i18n)

export { useTranslation } from 'react-i18next'
export default i18n
