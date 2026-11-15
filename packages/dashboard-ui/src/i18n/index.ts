import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import { LANGUAGES, resolveLanguage, type Language } from './languages'
import en from './locales/en'

type Bundle = { default: Record<string, string> }
type Loader = () => Promise<Bundle>

const loaders: Partial<Record<Exclude<Language, 'en'>, Loader>> = {
  de: () => import('./locales/de'),
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
    const loader = load ?? loaders[language]
    if (loader) {
      const bundle = await loader().then(
        (loaded) => loaded.default,
        () => undefined,
      )
      if (bundle) i18n.addResourceBundle(language, 'translation', bundle, true, true)
      if (request !== latestRequest || !bundle) return
    }
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

export { useTranslation } from 'react-i18next'
export default i18n
