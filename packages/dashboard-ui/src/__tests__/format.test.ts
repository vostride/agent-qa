import { describe, it, expect, vi, afterEach, type MockInstance } from 'vitest'
import i18n from '@/i18n'
import {
  formatLocale,
  formatNumber,
  formatPercent,
  formatRegionalDateTime,
  formatRegionalNumber,
  formatRelativeCompact,
  formatTokens,
  formatUnit,
  formatUnitList,
} from '../lib/format.js'

const DAY = 86_400_000

function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString()
}

let languagesSpy: MockInstance | undefined

function browserLists(tags: string[]): void {
  languagesSpy = vi.spyOn(navigator, 'languages', 'get').mockReturnValue(tags)
}

afterEach(async () => {
  languagesSpy?.mockRestore()
  languagesSpy = undefined
  i18n.removeResourceBundle('fr', 'translation')
  await i18n.changeLanguage('en')
})

describe('formatTokens', () => {
  it('formats zero', () => {
    expect(formatTokens(0)).toBe('0')
  })
  it('formats small numbers without commas', () => {
    expect(formatTokens(42)).toBe('42')
    expect(formatTokens(999)).toBe('999')
  })
  it('formats thousands with compact notation', () => {
    expect(formatTokens(1000)).toBe('1K')
    expect(formatTokens(1234)).toBe('1.2K')
  })
  it('formats millions with compact notation', () => {
    expect(formatTokens(1234567)).toBe('1.2M')
  })
})

describe('formatLocale', () => {
  it('picks the browser tag that is a regional variant of the dashboard language', () => {
    expect(formatLocale('en', ['en-IN', 'en'])).toBe('en-IN')
    expect(formatLocale('de', ['de-CH'])).toBe('de-CH')
    expect(formatLocale('zh-Hant', ['zh-TW'])).toBe('zh-TW')
    expect(formatLocale('zh-Hans', ['zh-TW', 'zh-CN'])).toBe('zh-CN')
    expect(formatLocale('pt-BR', ['pt-PT'])).toBe('pt-PT')
    expect(formatLocale('en', ['de-CH', 'en-GB'])).toBe('en-GB')
  })

  it('falls back to the dashboard language when the browser lists no variant of it', () => {
    expect(formatLocale('ja', ['en-US'])).toBe('ja')
    expect(formatLocale('en', [])).toBe('en')
  })

  it('skips a malformed browser tag', () => {
    expect(formatLocale('en', ['en_US', 'en-GB'])).toBe('en-GB')
  })
})

describe('the fixed formats ignore the browser region', () => {
  it('keeps US English numbers and percentages in a browser set to English (India)', () => {
    browserLists(['en-IN', 'en'])
    expect(formatTokens(1234567)).toBe('1.2M')
    expect(formatNumber(1234567)).toBe('1,234,567')
    expect(formatPercent(50)).toBe('50%')
  })
})

describe('the regional formats follow the browser region', () => {
  const date = new Date(2026, 10, 15, 14, 5)
  const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }

  it('groups numbers the way the browser region does', () => {
    expect(formatRegionalNumber(1234567)).toBe('1,234,567')
    browserLists(['en-IN', 'en'])
    expect(formatRegionalNumber(1234567)).toBe('12,34,567')
  })

  it('writes dates the way the browser region does', () => {
    const us = formatRegionalDateTime(date, options)
    browserLists(['en-IN', 'en'])
    const india = formatRegionalDateTime(date, options)
    expect(india).toBe(new Intl.DateTimeFormat('en-IN', options).format(date))
    expect(india).not.toBe(us)
  })
})

describe('English at a thousand and over', () => {
  it('never groups a unit, a list of units or a percentage', () => {
    expect(formatUnit(1234.5, 'second', { minimumFractionDigits: 1 })).toBe('1234.5s')
    expect(formatUnit(1200, 'second')).toBe('1200s')
    expect(formatUnit(1000, 'millisecond')).toBe('1000ms')
    expect(formatUnitList([formatUnit(1000, 'minute'), formatUnit(5, 'second')])).toBe('1000m 5s')
    expect(formatPercent(1000)).toBe('1000%')
  })

  it('never groups a compact relative time', () => {
    expect(formatRelativeCompact(ago(1000 * DAY + 60_000))).toBe('1000d ago')
  })
})

describe('the unit and percent formats print the number they are given', () => {
  it('does not round a finished number', () => {
    expect(
      formatUnit(Number((2050 / 1000).toFixed(1)), 'second', { minimumFractionDigits: 1 }),
    ).toBe('2.0s')
    expect(formatPercent(Math.round(0.285 * 100))).toBe('28%')
    expect(formatUnit(850.25, 'millisecond')).toBe('850.25ms')
  })
})

describe('German', () => {
  it('formats numbers, percentages and units with German conventions', async () => {
    await i18n.changeLanguage('de')
    expect(formatTokens(1234567)).toContain('1,2')
    expect(formatNumber(1234567)).toBe('1.234.567')
    expect(formatPercent(50)).not.toBe('50%')
    const seconds = formatUnit(1234.5, 'second', { minimumFractionDigits: 1 })
    expect(seconds).toContain('1234,5')
  })

  it('formats in the new language on the next call after a switch', async () => {
    expect(formatNumber(1234567)).toBe('1,234,567')
    await i18n.changeLanguage('de')
    expect(formatNumber(1234567)).toBe('1.234.567')
    await i18n.changeLanguage('en')
    expect(formatNumber(1234567)).toBe('1,234,567')
  })
})

describe('formatRelativeCompact', () => {
  it('writes compact relative times in English', () => {
    expect(formatRelativeCompact(ago(10_000))).toBe('just now')
    expect(formatRelativeCompact(ago(5 * 60_000 + 1000))).toBe('5m ago')
    expect(formatRelativeCompact(ago(2 * 3_600_000 + 1000))).toBe('2h ago')
    expect(formatRelativeCompact(ago(3 * DAY + 1000))).toBe('3d ago')
  })

  it('reads just now for an empty input unless told otherwise', () => {
    expect(formatRelativeCompact('')).toBe('just now')
    expect(formatRelativeCompact('', { empty: '' })).toBe('')
  })

  it('hands over to the caller once the instant is old enough', () => {
    const after = { days: 7, format: () => 'older' }
    expect(formatRelativeCompact(ago(8 * DAY), { after })).toBe('older')
    expect(formatRelativeCompact(ago(6 * DAY + 1000), { after })).toBe('6d ago')
  })

  it('hands an unparsable timestamp over to the caller', () => {
    const after = { days: 7, format: () => 'older' }
    expect(formatRelativeCompact('not a date', { after })).toBe('older')
  })

  it('takes its words from the catalog of the dashboard language', async () => {
    i18n.addResourceBundle('fr', 'translation', {
      'time.justNow': 'à l’instant',
      'time.minutesAgoCompact_one': 'il y a {{count}} min',
      'time.minutesAgoCompact_other': 'il y a {{count}} min',
      'time.hoursAgoCompact_one': 'il y a {{count}} h',
      'time.hoursAgoCompact_other': 'il y a {{count}} h',
      'time.daysAgoCompact_one': 'il y a {{count}} j',
      'time.daysAgoCompact_other': 'il y a {{count}} j',
    })
    await i18n.changeLanguage('fr')
    expect(formatRelativeCompact(ago(10_000))).toBe('à l’instant')
    expect(formatRelativeCompact(ago(5 * 60_000 + 1000))).toBe('il y a 5 min')
    expect(formatRelativeCompact(ago(2 * 3_600_000 + 1000))).toBe('il y a 2 h')
    expect(formatRelativeCompact(ago(3 * DAY + 1000))).toBe('il y a 3 j')
  })
})
