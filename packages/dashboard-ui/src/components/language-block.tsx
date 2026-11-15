import { useId } from 'react'

import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useTranslation } from '@/i18n'
import { useLanguage } from '@/i18n/language-provider'
import { LANGUAGES, LANGUAGE_NAMES, browserLanguage, isLanguage } from '@/i18n/languages'

export function LanguageBlock() {
  const { t } = useTranslation()
  const { choice, setChoice } = useLanguage()
  const selectId = useId()

  return (
    <section data-language-block className="mt-6 space-y-2">
      <Label htmlFor={selectId}>{t('language.label')}</Label>
      <Select
        value={choice}
        onValueChange={(value) => {
          if (value === 'browser' || isLanguage(value)) setChoice(value)
        }}
      >
        <SelectTrigger id={selectId} data-language-select className="w-full max-w-md">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="browser">
            {t('language.followBrowser', { language: LANGUAGE_NAMES[browserLanguage()] })}
          </SelectItem>
          {LANGUAGES.map((code) => (
            <SelectItem key={code} value={code} lang={code}>
              {LANGUAGE_NAMES[code]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{t('language.help')}</p>
    </section>
  )
}
