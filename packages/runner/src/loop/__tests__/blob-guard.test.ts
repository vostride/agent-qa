import { describe, expect, it } from 'vitest'
import { guardActionData } from '../blob-guard.js'

const MARKER = '…[truncated to fit context budget]'

describe('guardActionData (pre-prompt blob-guard fallback)', () => {
  it('returns undefined for undefined input', () => {
    expect(guardActionData(undefined)).toBeUndefined()
  })

  it('round-trips a short value verbatim (no truncation, no marker)', () => {
    const value = { ok: true, items: [1, 2, 3], note: 'small' }
    const out = guardActionData(value)
    expect(out).toBe(JSON.stringify(value))
    expect(out).not.toContain(MARKER)
  })

  it('bounds a >10000-char value and ends with the truncation marker', () => {
    const huge = { blob: 'x'.repeat(12000) }
    const out = guardActionData(huge)
    expect(out).toBeDefined()
    expect(out!.endsWith(MARKER)).toBe(true)
    // Bounded to a generous ceiling well above the v1 2000-char slice.
    expect(out!.length).toBeGreaterThan(2000)
    expect(out!.length).toBeLessThan(12000)
  })

  it('does not reproduce the v1 2000-char guillotine', () => {
    const out = guardActionData({ blob: 'y'.repeat(10000) })
    expect(out!.length).not.toBe(2000)
    expect(out!.length).toBeGreaterThan(2000)
  })

  it('never throws on cyclic input', () => {
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic
    expect(() => guardActionData(cyclic)).not.toThrow()
    expect(guardActionData(cyclic)).toContain('[Circular]')
  })

  it('uses an injected guard fn in preference to the fallback', () => {
    const guard = (_v: unknown): string | undefined => 'GUARDED'
    expect(guardActionData({ big: 'z'.repeat(20000) }, guard)).toBe('GUARDED')
    // The injected guard governs undefined handling too.
    expect(guardActionData(undefined, () => 'from-guard')).toBe('from-guard')
  })
})
