import 'i18next'
import type en from './locales/en'

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation'
    keySeparator: false
    resources: { translation: typeof en }
  }
}
