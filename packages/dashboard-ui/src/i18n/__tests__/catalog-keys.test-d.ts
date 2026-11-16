import { expectTypeOf, test } from 'vitest'

import { t } from '@/i18n'
import type en from '@/i18n/locales/en'
import type { Translation } from '@/i18n/translation'

test('a key of the English catalog reads as text', () => {
  expectTypeOf(t('nav.config')).toBeString()
})

test('a key the English catalog lacks does not compile', () => {
  // @ts-expect-error not a key of the English catalog
  t('nav.notInTheCatalog')
})

test('a translation may leave a key out, write other plural forms, and add no key of its own', () => {
  type Language = Translation<typeof en>
  expectTypeOf<{ 'nav.config': string }>().toExtend<Language>()
  expectTypeOf<{ 'time.minutesAgoCompact_few': string }>().toExtend<Language>()
  ;({
    // @ts-expect-error not a key of the English catalog
    'nav.notInTheCatalog': 'text',
  }) satisfies Language
})
