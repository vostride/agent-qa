import { describe, it, expect } from 'vitest'
import { resolveTarget, listTargets } from '../targets.js'
import type { AgentQaConfig } from '@vostride/agent-qa-core'

function makeConfig(targets?: Record<string, unknown>): AgentQaConfig {
  return {
    registry: {
      llms: [],
      ...(targets ? { targets } : {}),
    },
  } as unknown as AgentQaConfig
}

const sampleTargets = {
  webapp: {
    platform: 'web' as const,
    url: 'https://example.com',
  },
  mobile: {
    platform: 'ios' as const,
    bundleId: 'com.example.app',
  },
  android: {
    platform: 'android' as const,
    bundleId: 'com.example.android',
  },
}

describe('resolveTarget', () => {
  it('resolves web target with url', () => {
    const config = makeConfig(sampleTargets)
    const resolved = resolveTarget(config, 'webapp')
    expect(resolved.name).toBe('webapp')
    expect(resolved.platform).toBe('web')
    expect(resolved.url).toBe('https://example.com')
  })

  it('resolves mobile target with bundleId', () => {
    const config = makeConfig(sampleTargets)
    const resolved = resolveTarget(config, 'mobile')
    expect(resolved.name).toBe('mobile')
    expect(resolved.platform).toBe('ios')
    expect(resolved.bundleId).toBe('com.example.app')
  })

  it('resolves android target without device', () => {
    const config = makeConfig(sampleTargets)
    const resolved = resolveTarget(config, 'android')
    expect(resolved.platform).toBe('android')
    expect(resolved.bundleId).toBe('com.example.android')
  })

  it('throws for missing target', () => {
    const config = makeConfig(sampleTargets)
    expect(() => resolveTarget(config, 'nonexistent')).toThrow('Target "nonexistent" not found')
  })

  it('throws when no targets configured', () => {
    const config = makeConfig()
    expect(() => resolveTarget(config, 'anything')).toThrow('not found')
  })
})

describe('listTargets', () => {
  it('lists all targets with platform', () => {
    const config = makeConfig(sampleTargets)
    const targets = listTargets(config)
    expect(targets).toHaveLength(3)

    const webapp = targets.find((t) => t.name === 'webapp')!
    expect(webapp.platform).toBe('web')

    const mobile = targets.find((t) => t.name === 'mobile')!
    expect(mobile.platform).toBe('ios')
  })

  it('returns empty array when no targets configured', () => {
    const config = makeConfig()
    expect(listTargets(config)).toEqual([])
  })

  it('returns empty array when registry has no targets', () => {
    const config = { registry: { llms: [] } } as unknown as AgentQaConfig
    expect(listTargets(config)).toEqual([])
  })
})

describe('resolveTarget — product field', () => {
  it('returns explicit product when set', () => {
    const config = makeConfig({
      hn: { platform: 'web' as const, url: 'https://hn.com', product: 'hacker-news' },
    })
    const resolved = resolveTarget(config, 'hn')
    expect(resolved.product).toBe('hacker-news')
  })

  it('defaults product to target name when omitted', () => {
    const config = makeConfig({
      'my-target': { platform: 'web' as const, url: 'https://example.com' },
    })
    const resolved = resolveTarget(config, 'my-target')
    expect(resolved.product).toBe('my-target')
  })

  it('two targets with same product resolve to the same product string', () => {
    const config = makeConfig({
      webapp: { platform: 'web' as const, url: 'https://example.com', product: 'shared-product' },
      mobile: { platform: 'ios' as const, bundleId: 'com.example', product: 'shared-product' },
    })
    const r1 = resolveTarget(config, 'webapp')
    const r2 = resolveTarget(config, 'mobile')
    expect(r1.product).toBe('shared-product')
    expect(r2.product).toBe('shared-product')
    expect(r1.product).toBe(r2.product)
  })
})
