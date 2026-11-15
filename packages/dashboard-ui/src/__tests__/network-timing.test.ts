import { describe, it, expect, afterEach } from 'vitest'
import i18n from '@/i18n'
import { formatRelativeTime, filterTimingEntries } from '../components/run-detail/tab-network.js'

afterEach(async () => {
  await i18n.changeLanguage('en')
})

describe('formatRelativeTime', () => {
  it('formats zero offset', () => {
    expect(formatRelativeTime(0)).toBe('+0ms')
  })
  it('formats sub-second offset', () => {
    expect(formatRelativeTime(120)).toBe('+120ms')
  })
  it('formats just below 1s', () => {
    expect(formatRelativeTime(999)).toBe('+999ms')
  })
  it('formats exactly 1s', () => {
    expect(formatRelativeTime(1000)).toBe('+1.0s')
  })
  it('formats fractional seconds', () => {
    expect(formatRelativeTime(1400)).toBe('+1.4s')
  })
  it('formats large offsets', () => {
    expect(formatRelativeTime(12345)).toBe('+12.3s')
  })
  it('keeps a thousand seconds and over ungrouped', () => {
    expect(formatRelativeTime(1234500)).toBe('+1234.5s')
  })
  it('rounds seconds to one decimal as toFixed does', () => {
    expect(formatRelativeTime(2050)).toBe('+2.0s')
  })
  it('rounds milliseconds to a whole number', () => {
    expect(formatRelativeTime(999.6)).toBe('+1000ms')
  })
  it('writes the decimal comma in German and the point again in English', async () => {
    await i18n.changeLanguage('de')
    const german = formatRelativeTime(12300)
    expect(german).toContain('12,3')
    expect(german).not.toContain('12.3')
    await i18n.changeLanguage('en')
    expect(formatRelativeTime(12300)).toBe('+12.3s')
  })
})

describe('filterTimingEntries', () => {
  it('filters out startTime, -1 sentinels, and 0 values', () => {
    const timing = {
      startTime: 1774773632832.19,
      domainLookupStart: -1,
      domainLookupEnd: -1,
      requestStart: 514.228,
      responseStart: 774.217,
      responseEnd: 776.267,
    }
    expect(filterTimingEntries(timing)).toEqual([
      ['requestStart', 514.228],
      ['responseStart', 774.217],
      ['responseEnd', 776.267],
    ])
  })
  it('returns empty array when all values are filtered', () => {
    expect(filterTimingEntries({ startTime: 1774773632832.19, domainLookupStart: 0 })).toEqual([])
  })
  it('returns empty array for all -1 values', () => {
    expect(filterTimingEntries({ domainLookupStart: -1, domainLookupEnd: -1, connectStart: -1 })).toEqual([])
  })
})
