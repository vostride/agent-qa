import i18n, { t } from '@/i18n'
import { browserTags, isLanguage } from '@/i18n/languages'

// Constructing an `Intl` object is the expensive half, so each one is kept per locale and options
// and built on first use, never at module load.
const formatters = new Map<string, unknown>()

function cached<T>(kind: string, locale: string, options: object, build: () => T): T {
  const key = `${kind}|${locale}|${JSON.stringify(options)}`
  let formatter = formatters.get(key) as T | undefined
  if (formatter === undefined) {
    formatter = build()
    formatters.set(key, formatter)
  }
  return formatter
}

function language(): string {
  return isLanguage(i18n.language) ? i18n.language : 'en'
}

// The browser's own regional variant of the dashboard's language, so `en` in an `en-IN` browser
// keeps Indian formats; the dashboard's language when the browser lists no variant of it.
export function formatLocale(
  dashboardLanguage: string = language(),
  tags: readonly string[] = browserTags(),
): string {
  const wanted = new Intl.Locale(dashboardLanguage).maximize()
  for (const tag of tags) {
    try {
      const offered = new Intl.Locale(tag)
      const { language: lang, script } = offered.maximize()
      if (lang === wanted.language && script === wanted.script) return offered.toString()
    } catch {
      // A malformed tag is skipped.
    }
  }
  return dashboardLanguage
}

function numberFormat(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  return cached('number', locale, options, () => new Intl.NumberFormat(locale, options))
}

function dateFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return cached('date', locale, options, () => new Intl.DateTimeFormat(locale, options))
}

function formatDateIn(locale: string, value: Date | number, options: Intl.DateTimeFormatOptions) {
  const time = typeof value === 'number' ? value : value.getTime()
  if (!Number.isFinite(time)) return String(new Date(Number.NaN))
  return dateFormat(locale, options).format(time)
}

export function formatNumber(value: number, options: Intl.NumberFormatOptions = {}): string {
  return numberFormat(language(), options).format(value)
}

export function formatRegionalNumber(value: number, options: Intl.NumberFormatOptions = {}): string {
  return numberFormat(formatLocale(), options).format(value)
}

export function formatTokens(n: number): string {
  return formatNumber(n, { notation: 'compact', maximumFractionDigits: 1 })
}

export function formatDateTime(value: Date | number, options: Intl.DateTimeFormatOptions): string {
  return formatDateIn(language(), value, options)
}

export function formatRegionalDateTime(
  value: Date | number,
  options: Intl.DateTimeFormatOptions,
): string {
  return formatDateIn(formatLocale(), value, options)
}

// These replace text built by hand, so they print the finished number they are given: never
// grouped, in any language, and never rounded. A caller showing fixed decimals passes the minimum.
function formatAsGiven(
  value: number,
  unit: string,
  options: Intl.NumberFormatOptions | undefined,
): string {
  // Adding zero turns -0 into 0: a template printed `0ms` for it, `Intl` prints `-0ms`.
  return formatNumber(value + 0, {
    style: 'unit',
    unit,
    unitDisplay: 'narrow',
    maximumFractionDigits: 20,
    ...options,
    useGrouping: false,
  })
}

export function formatUnit(
  value: number,
  unit: 'millisecond' | 'second' | 'minute' | 'hour',
  options?: Intl.NumberFormatOptions,
): string {
  return formatAsGiven(value, unit, options)
}

// `value` is the number shown before the sign: 50, not 0.5.
export function formatPercent(value: number, options?: Intl.NumberFormatOptions): string {
  return formatAsGiven(value, 'percent', options)
}

export function formatUnitList(parts: readonly string[]): string {
  const locale = language()
  const list = cached('list', locale, {}, () => {
    return new Intl.ListFormat(locale, { type: 'unit', style: 'narrow' })
  })
  return list.format(parts)
}

function formatRelative(value: number, unit: Intl.RelativeTimeFormatUnit): string {
  const locale = language()
  const relative = cached('relative', locale, {}, () => {
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  })
  return relative.format(value, unit)
}

export function formatTimeAgo(date: Date, older: () => string): string {
  const diffMs = Date.now() - date.getTime()
  const diffSec = Math.floor(diffMs / 1000)
  const diffMin = Math.floor(diffSec / 60)
  const diffHr = Math.floor(diffMin / 60)
  const diffDay = Math.floor(diffHr / 24)

  if (diffSec < 60) return t('time.justNow')
  if (diffMin < 60) return formatRelative(-diffMin, 'minute')
  if (diffHr < 24) return formatRelative(-diffHr, 'hour')
  if (diffDay < 7) return formatRelative(-diffDay, 'day')
  return older()
}

export function formatRelativeCompact(
  iso: string,
  options: { empty?: string; after?: { days: number; format: () => string } } = {},
): string {
  if (!iso) return options.empty ?? t('time.justNow')
  const diffSec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (diffSec < 60) return t('time.justNow')
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return t('time.minutesAgoCompact', { count: diffMin })
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return t('time.hoursAgoCompact', { count: diffHr })
  const diffDay = Math.floor(diffHr / 24)
  // Written as "not under" so an unparsable timestamp also hands over, as the viewers did.
  if (options.after && !(diffDay < options.after.days)) return options.after.format()
  return t('time.daysAgoCompact', { count: diffDay })
}
