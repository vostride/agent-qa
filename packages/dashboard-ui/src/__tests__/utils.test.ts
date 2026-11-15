import { describe, it, expect, vi, afterEach, type MockInstance } from 'vitest'
import i18n from '@/i18n'
import { formatDuration, formatDate, formatDateShort, statusColor, escapeHtml, debounce, createElement } from '../lib/utils.js'

describe('formatDuration', () => {
  it('formats milliseconds', () => {
    expect(formatDuration(42)).toBe('42ms')
  })

  it('formats seconds', () => {
    expect(formatDuration(1200)).toBe('1.2s')
  })

  it('formats minutes and seconds', () => {
    expect(formatDuration(150_000)).toBe('2m 30s')
  })

  it('formats hours and minutes', () => {
    expect(formatDuration(3_900_000)).toBe('1h 5m')
  })

  it('formats exact minutes without seconds', () => {
    expect(formatDuration(120_000)).toBe('2m')
  })

  it('formats exact hours without minutes', () => {
    expect(formatDuration(3_600_000)).toBe('1h')
  })
})

describe('formatDate', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns "just now" for recent timestamps', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-03T12:00:30Z'))
    expect(formatDate('2026-03-03T12:00:00Z')).toBe('just now')
  })

  it('returns minutes ago', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-03T12:10:00Z'))
    expect(formatDate('2026-03-03T12:00:00Z')).toBe('10 minutes ago')
  })

  it('returns hours ago', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-03T14:00:00Z'))
    expect(formatDate('2026-03-03T12:00:00Z')).toBe('2 hours ago')
  })

  it('returns yesterday', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-04T12:00:00Z'))
    expect(formatDate('2026-03-03T12:00:00Z')).toBe('yesterday')
  })
})

describe('durations and dates at every size and in every browser', () => {
  let languagesSpy: MockInstance | undefined

  afterEach(async () => {
    vi.useRealTimers()
    languagesSpy?.mockRestore()
    languagesSpy = undefined
    await i18n.changeLanguage('en')
  })

  it('keeps US English in a browser set to English (India)', () => {
    const iso = '2026-11-15T14:05:00Z'
    const us = formatDateShort(iso)
    languagesSpy = vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['en-IN', 'en'])
    expect(formatDuration(1200)).toBe('1.2s')
    expect(formatDateShort(iso)).toBe(us)
  })

  it('never groups hours and keeps the arithmetic it has', () => {
    expect(formatDuration((1000 * 60 + 5) * 60_000)).toBe('1000h 5m')
    expect(formatDuration(3_599_600)).toBe('59m 60s')
  })

  it('formats durations and relative dates in German', async () => {
    await i18n.changeLanguage('de')
    expect(formatDuration(43_400)).toContain('43,4')
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-03T12:05:00Z'))
    expect(formatDate('2026-03-03T12:00:00Z')).toContain('vor')
  })

  it('says yesterday in Japanese', async () => {
    await i18n.changeLanguage('ja')
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-04T12:00:00Z'))
    expect(formatDate('2026-03-03T12:00:00Z')).toBe('昨日')
  })

  it('writes a past time in Russian', async () => {
    await i18n.changeLanguage('ru')
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-03T12:05:00Z'))
    expect(formatDate('2026-03-03T12:00:00Z')).toContain('назад')
  })
})

describe('statusColor', () => {
  it('returns success for passed', () => {
    expect(statusColor('passed')).toBe('var(--success)')
  })

  it('returns failure for failed', () => {
    expect(statusColor('failed')).toBe('var(--failure)')
  })

  it('returns healed color for flaky', () => {
    expect(statusColor('flaky')).toBe('var(--healed)')
  })

  it('returns default for unknown', () => {
    expect(statusColor('unknown')).toBe('var(--text-secondary)')
  })
})

describe('escapeHtml', () => {
  it('escapes HTML entities', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;')
  })

  it('escapes ampersands', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b')
  })

  it('escapes single quotes', () => {
    expect(escapeHtml("it's")).toBe("it&#39;s")
  })
})

describe('debounce', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('delays function execution', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const debounced = debounce(fn, 100)
    debounced()
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(fn).toHaveBeenCalledOnce()
  })

  it('resets timer on subsequent calls', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const debounced = debounce(fn, 100)
    debounced()
    vi.advanceTimersByTime(80)
    debounced()
    vi.advanceTimersByTime(80)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(20)
    expect(fn).toHaveBeenCalledOnce()
  })
})
