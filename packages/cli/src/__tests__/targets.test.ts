import { describe, it, expect, expectTypeOf } from 'vitest'
import { resolveTarget, listTargets, type ResolvedTarget } from '../targets.js'
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

describe('resolveTarget — environment declaration', () => {
  it('carries a declared local environment through', () => {
    const config = makeConfig({
      'local-form': { platform: 'web' as const, url: 'http://127.0.0.1:8931/form.html', environment: 'local' },
    })
    expect(resolveTarget(config, 'local-form').environment).toBe('local')
  })

  it('carries a declared shared environment through', () => {
    const config = makeConfig({
      'automation-exercise': { platform: 'web' as const, url: 'https://automationexercise.com', environment: 'shared' },
    })
    expect(resolveTarget(config, 'automation-exercise').environment).toBe('shared')
  })

  it('leaves an undeclared target undeclared rather than inventing a class', () => {
    // The resolver must NOT default here. Undeclared→shared is the gate descriptor's decision
    // (buildRunRiskDescriptor), made once, where the audit row records it.
    const config = makeConfig(sampleTargets)
    expect(resolveTarget(config, 'webapp').environment).toBeUndefined()
  })
})

// Production joins the declared classes; resolvers carry every state and never read a hostname.
describe('CLI target environment', () => {
  const STATES = ['local', 'shared', 'production', undefined] as const

  it('resolveTarget carries local, shared, production and absence unchanged', () => {
    expectTypeOf<ResolvedTarget['environment']>().toEqualTypeOf<'local' | 'shared' | 'production' | undefined>()
    for (const environment of STATES) {
      const config = makeConfig({
        shop: {
          platform: 'web' as const,
          url: 'https://shop.example.com',
          ...(environment === undefined ? {} : { environment }),
        },
      })
      const resolved = resolveTarget(config, 'shop')
      expect(resolved.environment, String(environment)).toBe(environment)
    }
  })

  it('never infers production from a hostname', () => {
    for (const url of ['https://prod.example.com', 'https://production.shop.com', 'https://www.shop.com']) {
      const config = makeConfig({ shop: { platform: 'web' as const, url } })
      expect(resolveTarget(config, 'shop').environment, url).toBeUndefined()
    }
  })
})
