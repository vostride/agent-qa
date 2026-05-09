import { describe, it, expect } from 'vitest'
import { MemoryConfigSchema } from '../../schema/services-schema.js'
import { ServicesSchema } from '../../schema/services-schema.js'
import { DEFAULT_MEMORY_DIR, resolveMemoryRoot } from '../config.js'

describe('MemoryConfigSchema', () => {
  it('returns correct defaults for empty object', () => {
    const result = MemoryConfigSchema.parse({})
    expect(result).toEqual({
      enabled: true,
      provider: 'local',
      dir: DEFAULT_MEMORY_DIR,
      minTrust: 0.3,
      maxInjections: 3,
      curatorEnabled: true,
      curatorLockTimeout: 120_000,
      trustConfirmDelta: 0.05,
      trustContradictDelta: 0.10,
      ablationEnabled: true,
      circuitBreakerEnabled: true,
      circuitBreakerWindowSize: 20,
      circuitBreakerBaselineSize: 3,
      circuitBreakerThreshold: 0.15,
    })
  })

  it('accepts overrides with remaining defaults', () => {
    const result = MemoryConfigSchema.parse({ minTrust: 0.5, maxInjections: 5 })
    expect(result).toEqual({
      enabled: true,
      provider: 'local',
      dir: DEFAULT_MEMORY_DIR,
      minTrust: 0.5,
      maxInjections: 5,
      curatorEnabled: true,
      curatorLockTimeout: 120_000,
      trustConfirmDelta: 0.05,
      trustContradictDelta: 0.10,
      ablationEnabled: true,
      circuitBreakerEnabled: true,
      circuitBreakerWindowSize: 20,
      circuitBreakerBaselineSize: 3,
      circuitBreakerThreshold: 0.15,
    })
  })

  it('rejects minTrust above 1', () => {
    const result = MemoryConfigSchema.safeParse({ minTrust: 1.5 })
    expect(result.success).toBe(false)
  })

  it('rejects minTrust below 0', () => {
    const result = MemoryConfigSchema.safeParse({ minTrust: -0.1 })
    expect(result.success).toBe(false)
  })

  it('rejects non-integer maxInjections', () => {
    const result = MemoryConfigSchema.safeParse({ maxInjections: 2.5 })
    expect(result.success).toBe(false)
  })

  it('rejects negative maxInjections', () => {
    const result = MemoryConfigSchema.safeParse({ maxInjections: -1 })
    expect(result.success).toBe(false)
  })

  it('accepts a custom memory directory', () => {
    const result = MemoryConfigSchema.parse({ dir: '.agent-qa/custom-memory' })
    expect(result.dir).toBe('.agent-qa/custom-memory')
  })

  it('rejects an empty memory directory', () => {
    const result = MemoryConfigSchema.safeParse({ dir: '' })
    expect(result.success).toBe(false)
  })
})

describe('ServicesSchema with memory', () => {
  it('accepts memory config', () => {
    const result = ServicesSchema.safeParse({ memory: { enabled: true } })
    expect(result.success).toBe(true)
  })

  it('accepts memory config with all fields', () => {
    const result = ServicesSchema.safeParse({
      memory: {
        enabled: false,
        provider: 'local',
        dir: '.agent-qa/custom-memory',
        minTrust: 0.7,
        maxInjections: 10,
      },
    })
    expect(result.success).toBe(true)
  })
})

describe('resolveMemoryRoot', () => {
  it('resolves the default memory root from the config directory', () => {
    expect(resolveMemoryRoot({}, '/workspace/project')).toBe('/workspace/project/agent-qa-memory')
  })

  it('resolves a relative custom memory root from the config directory', () => {
    expect(
      resolveMemoryRoot({ services: { memory: { dir: '.agent-qa/custom-memory' } } }, '/workspace/project'),
    ).toBe('/workspace/project/.agent-qa/custom-memory')
  })

  it('preserves an absolute custom memory root', () => {
    expect(
      resolveMemoryRoot({ services: { memory: { dir: '/var/tmp/agent-qa-memory' } } }, '/workspace/project'),
    ).toBe('/var/tmp/agent-qa-memory')
  })
})
