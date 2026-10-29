import { describe, expect, it } from 'vitest'

import { compactLogs, guardBlob, guardToolOutput, type LogEntry } from '../compact.js'

const TRUNCATION_MARKER = '…[truncated to fit context budget]'

function sampleLines(rendered: string): string[] {
  return rendered
    .split('\n')
    .filter(line => line.startsWith('  · '))
    .map(line => line.slice('  · '.length))
}

function headerLines(rendered: string): string[] {
  return rendered.split('\n').filter(line => !line.startsWith('  · '))
}

describe('compactLogs — normalization', () => {
  it('maps each variable-token kind to <*> in the grouped class header', () => {
    const entries: LogEntry[] = [
      { source: 'console', level: 'error', message: 'user 550e8400-e29b-41d4-a716-446655440000 failed' },
      { source: 'console', level: 'error', message: 'at 2026-07-04T12:34:56.789Z the host 192.168.1.24 replied' },
      { source: 'console', level: 'error', message: 'token 0xDEADBEEF hash a1b2c3d4e5f6a7b8 count 4217' },
    ]
    // Normalization is asserted on class headers; raw samples keep their original tokens.
    const headers = headerLines(compactLogs(entries)).join('\n')
    expect(headers).toContain('user <*> failed')
    expect(headers).toContain('at <*> the host <*> replied')
    expect(headers).toContain('token <*> hash <*> count <*>')
    expect(headers).not.toContain('550e8400')
    expect(headers).not.toContain('192.168.1.24')
    expect(headers).not.toContain('0xDEADBEEF')
  })
})

describe('compactLogs — grouping & counting', () => {
  it('groups by source::level::normalized_message and counts occurrences', () => {
    const entries: LogEntry[] = [
      { source: 'network', level: 'warn', message: 'GET /api/1 -> 500' },
      { source: 'network', level: 'warn', message: 'GET /api/2 -> 500' },
      { source: 'network', level: 'warn', message: 'GET /api/3 -> 500' },
      { source: 'console', level: 'info', message: 'ready' },
    ]
    const rendered = compactLogs(entries)
    expect(rendered).toContain('×3')
    expect(rendered).toMatch(/\[network\] warn ×3/)
    expect(rendered).toMatch(/\[console\] info ×1/)
  })

  it('maps unknown/absent level to a single defined default', () => {
    const entries: LogEntry[] = [
      { source: 'dom', message: 'click 12' },
      { source: 'dom', message: 'click 34' },
    ]
    const rendered = compactLogs(entries)
    expect(rendered).toMatch(/\[dom\] log ×2/)
  })
})

describe('compactLogs — first-5 monotonic sampling', () => {
  function burst(n: number): LogEntry[] {
    return Array.from({ length: n }, (_, i) => ({
      source: 'console',
      level: 'debug',
      message: `req ${i + 1}`,
    }))
  }

  it('keeps the first 5 seen samples and never churns them as the burst grows', () => {
    const five = sampleLines(compactLogs(burst(5)))
    const ten = sampleLines(compactLogs(burst(10)))
    expect(five).toEqual(['req 1', 'req 2', 'req 3', 'req 4', 'req 5'])
    expect(ten).toEqual(five)
    expect(ten).toContain('req 1') // onset always retained
    expect(ten).toHaveLength(5)
  })
})

describe('compactLogs — determinism', () => {
  it('same input twice ⇒ identical string', () => {
    const entries: LogEntry[] = [
      { source: 'z-source', level: 'error', message: 'boom 1' },
      { source: 'a-source', level: 'info', message: 'ok 2' },
      { source: 'z-source', level: 'error', message: 'boom 3' },
    ]
    expect(compactLogs(entries)).toBe(compactLogs(entries))
  })

  it('renders classes in a stable sorted order regardless of input order', () => {
    const forward: LogEntry[] = [
      { source: 'a', level: 'info', message: 'first' },
      { source: 'b', level: 'info', message: 'second' },
    ]
    const reversed: LogEntry[] = [...forward].reverse()
    expect(compactLogs(forward)).toBe(compactLogs(reversed))
  })
})

describe('guardBlob', () => {
  it('returns a short value verbatim (not token-normalized)', () => {
    const out = guardBlob({ id: '550e8400-e29b-41d4-a716-446655440000', n: 42 })
    expect(out).toBeDefined()
    expect(out).toContain('550e8400-e29b-41d4-a716-446655440000')
    expect(out).toContain('42')
    expect(out).not.toContain('<*>')
    expect(out?.endsWith(TRUNCATION_MARKER)).toBe(false)
  })

  it('bounds an oversized value with the visible truncation marker', () => {
    const out = guardBlob('x'.repeat(12000))
    expect(out).toBeDefined()
    expect(out?.endsWith(TRUNCATION_MARKER)).toBe(true)
    expect(out!.length).toBeLessThan(12000)
  })

  it('returns undefined for undefined', () => {
    expect(guardBlob(undefined)).toBeUndefined()
  })

  it('does not throw on cyclic input', () => {
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic
    expect(() => guardBlob(cyclic)).not.toThrow()
    expect(typeof guardBlob(cyclic)).toBe('string')
  })

  it('is deterministic (same input ⇒ same output)', () => {
    const value = { a: 1, b: [2, 3], c: 'four' }
    expect(guardBlob(value)).toBe(guardBlob(value))
  })
})

describe('guardToolOutput — log-shape routing', () => {
  it('routes a console-shaped burst through compactLogs (grouped, ≤5 samples)', () => {
    const burst = Array.from({ length: 40 }, (_, i) => ({
      level: 'error',
      text: `fetch failed for item ${i}`,
      timestamp: 1751970000000 + i,
    }))
    const out = guardToolOutput(burst)
    expect(out).toContain('[console] error ×40: fetch failed for item <*>')
    expect(sampleLines(out ?? '').length).toBeLessThanOrEqual(5)
  })

  it('routes a network-shaped burst through compactLogs keyed by method/url/status', () => {
    const burst = Array.from({ length: 12 }, (_, i) => ({
      url: `https://api.example.com/items/${i}`,
      method: 'GET',
      status: 500,
    }))
    const out = guardToolOutput(burst)
    expect(out).toContain('[network] 500 ×12: GET https://api.example.com/items/<*>')
  })

  it('falls back to guardBlob for non-log arrays and scalar/object values', () => {
    const elements = [{ role: 'button', name: 'Save' }]
    expect(guardToolOutput(elements)).toBe(guardBlob(elements))
    expect(guardToolOutput('plain string')).toBe(guardBlob('plain string'))
    expect(guardToolOutput({ a: 1 })).toBe(guardBlob({ a: 1 }))
    expect(guardToolOutput(undefined)).toBeUndefined()
  })

  it('bounds compacted output at the blob ceiling with the visible marker', () => {
    const burst = Array.from({ length: 3000 }, (_, i) => ({
      level: 'log',
      text: `wholly-distinct-alpha-${'x'.repeat(i % 97)}-beta`,
      source: `src-${'y'.repeat(i % 89)}`,
    }))
    const out = guardToolOutput(burst)
    expect(out?.length).toBeLessThanOrEqual(8000 + TRUNCATION_MARKER.length)
    expect(out?.endsWith(TRUNCATION_MARKER)).toBe(true)
  })

  it('is deterministic (same burst ⇒ same output)', () => {
    const burst = [
      { level: 'warn', text: 'slow response 1200ms' },
      { level: 'warn', text: 'slow response 3400ms' },
    ]
    expect(guardToolOutput(burst)).toBe(guardToolOutput(burst))
  })
})
