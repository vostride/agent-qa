import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import type { PlatformConfig } from '../config/platform-config'
import { deviceConfigSchema } from '../config/device'
import { platformConfigSchema } from '../config/platform-config'

describe('platformConfigSchema', () => {
  const config: PlatformConfig = {} as z.infer<typeof platformConfigSchema>
  void config

  it('accepts valid web config', () => {
    const result = platformConfigSchema.safeParse({
      platform: 'web',
      browser: { name: 'chromium' },
    })

    expect(result.success).toBe(true)
  })

  it('rejects web config with mobile-only bundleId', () => {
    const result = platformConfigSchema.safeParse({
      platform: 'web',
      browser: { name: 'chromium' },
      bundleId: 'com.x',
    })

    expect(result.success).toBe(false)
  })

  it('rejects android config with web-only browser key', () => {
    const result = platformConfigSchema.safeParse({
      platform: 'android',
      device: { name: 'pixel', platform: 'android', match: {} },
      browser: { name: 'chromium' },
    })

    expect(result.success).toBe(false)
  })

  it('accepts mobile configs with a local appiumUrl', () => {
    const android = {
      platform: 'android',
      device: { name: 'pixel', platform: 'android', match: {} },
      bundleId: 'com.x',
      appiumUrl: 'http://localhost:4723',
    }
    const ios = {
      platform: 'ios',
      device: { name: 'iphone', platform: 'ios', match: {} },
      bundleId: 'com.x',
      appiumUrl: 'http://localhost:4723',
    }

    expect(platformConfigSchema.safeParse(android).success).toBe(true)
    expect(platformConfigSchema.safeParse(ios).success).toBe(true)
  })

  it('rejects unknown platform discriminants', () => {
    const result = platformConfigSchema.safeParse({
      platform: 'desktop',
      browser: { name: 'chromium' },
    })

    expect(result.success).toBe(false)
  })
})

describe('deviceConfigSchema', () => {
  it('accepts a mobile device config', () => {
    expect(deviceConfigSchema.safeParse({
      name: 'pixel',
      platform: 'android',
      match: {},
    }).success).toBe(true)
  })

  it('rejects web platform values', () => {
    expect(deviceConfigSchema.safeParse({
      name: 'pixel',
      platform: 'web',
      match: {},
    }).success).toBe(false)
  })
})
