import { describe, it, expect, vi, afterEach } from 'vitest'
import { formatDuration, formatDate, statusColor, escapeHtml, debounce, createElement } from '../lib/utils.js'

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
