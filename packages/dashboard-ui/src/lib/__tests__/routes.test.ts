import { describe, it, expect } from 'vitest'
import { routes } from '@/lib/routes'

describe('canonical dashboard routes', () => {
  it('keeps only the live top-level helpers', () => {
    expect(routes.runs).toBe('/runs')
    expect(routes.tests).toBe('/tests')
    expect(routes.testNew).toBe('/tests/new')
    expect(routes.hooks).toBe('/hooks')
    expect(routes.hookNew).toBe('/hooks/new')
    expect(routes.insights).toBe('/insights')
    expect(routes.config).toBe('/config')
  })

  it('does not expose stale analytics/trends helpers', () => {
    expect('analytics' in routes).toBe(false)
    expect('trends' in routes).toBe(false)
  })

  it('adds canonical memory routes without alternate helpers', () => {
    expect(routes.memory).toBe('/memory')
    expect(routes.memoryProduct('my-product')).toBe('/memory/my-product')
    expect('memoryProducts' in routes).toBe(false)
  })
})

describe('hook route helpers', () => {
  it('hookView returns /hook/:id (singular)', () => {
    expect(routes.hookView('h_foo-bar')).toBe('/hook/h_foo-bar')
  })

  it('hookEdit returns /hook/:id/edit', () => {
    expect(routes.hookEdit('h_foo-bar')).toBe('/hook/h_foo-bar/edit')
  })

  it('hooks list remains plural and hookNew unchanged', () => {
    expect(routes.hooks).toBe('/hooks')
    expect(routes.hookNew).toBe('/hooks/new')
  })
})

describe('suite route helpers', () => {
  it('suiteView returns /suite/:suite-id (singular)', () => {
    expect(routes.suiteView('s_foo-bar')).toBe('/suite/s_foo-bar')
  })
  it('suiteEdit returns /suite/:suite-id/edit', () => {
    expect(routes.suiteEdit('s_foo-bar')).toBe('/suite/s_foo-bar/edit')
  })
  it('suites list remains plural and suiteNew unchanged', () => {
    expect(routes.suites).toBe('/suites')
    expect(routes.suiteNew).toBe('/suites/new')
  })
  it('does not percent-encode opaque suite ids', () => {
    expect(routes.suiteView('s_abc-def')).not.toContain('%')
  })
})

describe('config route helpers', () => {
  it('configItem returns canonical bucket/item query params', () => {
    expect(routes.configItem('registry', 'targets')).toBe('/config?bucket=registry&item=targets')
  })
})
