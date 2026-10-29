import { describe, expect, it } from 'vitest'

const modules = import.meta.glob('../drawer-view.ts', { eager: true })

function drawer() {
  const view = modules['../drawer-view.ts'] as Record<string, unknown> | undefined
  expect(view, 'drawer view exports are available').toBeDefined()
  return view!
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings)
  return []
}

describe('drawer view', () => {
  it('DRAWER-NO-STATUS-WORDS', () => {
    const view = drawer()
    const copy = strings(view)
    expect(copy.length).toBeGreaterThan(20)
    for (const value of copy) expect(value).not.toMatch(/\b(finalized|open)\b/i)
    expect((view.DRAWER_TITLE_FALLBACK as (id: string) => string)('sample')).toBe('Run sample')
  })

  it('DRAWER-KIND-NARROWED', () => {
    expect(drawer().RUN_ARTIFACT_KIND_LABELS).toEqual({ test: 'Test', unknown: 'Not recorded' })
  })

  it('an artifact is sealed only once it has a finalizedAt', () => {
    const view = drawer()
    expect(view.CAPTURE_STATES).toEqual(['sealed', 'unsealed'])
    const stateOf = view.captureStateOf as (artifact: { finalizedAt?: string | null }) => string
    expect(stateOf({})).toBe('unsealed')
    expect(stateOf({ finalizedAt: null })).toBe('unsealed')
    expect(stateOf({ finalizedAt: '' })).toBe('unsealed')
    expect(stateOf({ finalizedAt: '2026-09-20T00:00:00Z' })).toBe('sealed')
  })

  it('DRAWER-RAN-AGAINST-DEGRADES', () => {
    const parts = drawer().ranAgainstParts as (config: unknown) => string[]
    expect(parts({
      runtime: { targetName: 'staging', platform: 'web' },
      effectiveConfig: { use: { browser: { name: 'chromium' } } },
      model: { planner: { provider: 'test-provider', model: 'test-model' } },
    })).toEqual(['staging', 'web chromium', 'test-model'])
    expect(parts({ effectiveConfig: { baseUrl: 'https://example.test', use: { platform: 'web' } } }))
      .toEqual(['https://example.test', 'web'])
    expect(parts({ runtime: { platform: 'android' }, model: { planner: { model: 'mobile-model' } } }))
      .toEqual(['android', 'mobile-model'])
    for (const config of [undefined, null, {}, [], 'unknown', {
      runtime: { targetName: 'unknown', platform: 'Unknown' },
      effectiveConfig: { use: { browser: { name: 'unknown' } } },
      model: { planner: { model: 'unknown' } },
    }]) expect(parts(config)).toEqual([])
    expect(parts({ runtime: { targetName: '  ', platform: 42 }, model: [] })).toEqual([])
  })
})
