import { describe, it, expect } from 'vitest'
import { formatRelativeTime, filterTimingEntries } from '../components/run-detail/tab-network.js'

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
