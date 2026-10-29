import { describe, it, expect } from 'vitest'
import { z } from 'zod'

describe('DeviceProfileSchema', () => {
  async function getSchema() {
    const mod = await import('../registry-schema.js') as any
    return mod.DeviceProfileSchema as z.ZodType<{ match: Record<string, unknown> }>
  }

  it('accepts an android device with a valid match', async () => {
    const schema = await getSchema()
    const result = schema.safeParse({
      platform: 'android',
      match: { avd: 'Pixel_7' },
    })
    expect(result.success).toBe(true)
  })

  it('refuses a match key outside the allowlist on any device, naming the platform', async () => {
    const schema = await getSchema()
    const result = schema.safeParse({
      platform: 'ios',
      match: { deviceName: 'iPhone 15' },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map(issue => issue.message)).toEqual([
        'Match field "deviceName" is not valid for an ios device. Allowed: udid, bundleId, automationName, platformVersion',
      ])
    }
  })

  it('rejects an android device with the iOS-only field udid', async () => {
    const schema = await getSchema()
    const result = schema.safeParse({
      platform: 'android',
      match: { udid: 'xxx' },
    })
    expect(result.success).toBe(false)
  })

  it('rejects an ios device with the Android-only field avd', async () => {
    const schema = await getSchema()
    const result = schema.safeParse({
      platform: 'ios',
      match: { avd: 'xxx' },
    })
    expect(result.success).toBe(false)
  })

  it('defaults match to empty object', async () => {
    const schema = await getSchema()
    const result = schema.safeParse({
      platform: 'android',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.match).toEqual({})
    }
  })

  it('rejects unknown platform', async () => {
    const schema = await getSchema()
    const result = schema.safeParse({
      platform: 'windows',
      match: {},
    })
    expect(result.success).toBe(false)
  })

  it('rejects match.noReset on an android device', async () => {
    const schema = await getSchema()
    const result = schema.safeParse({
      platform: 'android',
      match: { noReset: true },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const message = result.error.issues.map(issue => issue.message).join('\n')
      expect(message).toContain('Allowed: avd, serial, appPackage, appActivity, automationName, browserName, platformVersion')
      expect(message).not.toContain('noReset,')
    }
  })

  it('rejects match.noReset on an ios device', async () => {
    const schema = await getSchema()
    const result = schema.safeParse({
      platform: 'ios',
      match: { noReset: true },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const message = result.error.issues.map(issue => issue.message).join('\n')
      expect(message).toContain('Allowed: udid, bundleId, automationName, platformVersion')
      expect(message).not.toContain('noReset,')
    }
  })
})

describe('RegistrySchema with devices', () => {
  async function getSchema() {
    const mod = await import('../registry-schema.js') as any
    return mod.RegistrySchema as z.ZodType
  }

  it('accepts a devices field', async () => {
    const schema = await getSchema()
    const result = schema.safeParse({
      llms: [],
      devices: {
        pixel: { platform: 'android', match: {} },
      },
    })
    expect(result.success).toBe(true)
  })

  it('still accepts registry without devices (optional)', async () => {
    const schema = await getSchema()
    const result = schema.safeParse({ llms: [] })
    expect(result.success).toBe(true)
  })

  it('accepts slug-safe target keys', async () => {
    const schema = await getSchema()
    const result = schema.safeParse({
      targets: {
        'staging-web': { platform: 'web', url: 'https://staging.example.com' },
      },
    })
    expect(result.success).toBe(true)
  })

  it('rejects unsafe target keys before path resolution', async () => {
    const schema = await getSchema()
    for (const targetName of ['Staging', 'staging_web', 'bad/path', '.', '..', '../staging', '', 'staging-']) {
      const result = schema.safeParse({
        targets: {
          [targetName]: { platform: 'web', url: 'https://staging.example.com' },
        },
      })
      expect(result.success, JSON.stringify(targetName)).toBe(false)
    }
  })
})

describe('UseSchema mobile app state', () => {
  async function getSchema() {
    const mod = await import('../use-schema.js') as any
    return mod.UseSchema as z.ZodType
  }

  it('accepts preserve app state', async () => {
    const schema = await getSchema()
    const result = schema.safeParse({ mobile: { appState: 'preserve' } })
    expect(result.success).toBe(true)
  })

  it('accepts reset app state', async () => {
    const schema = await getSchema()
    const result = schema.safeParse({ mobile: { appState: 'reset' } })
    expect(result.success).toBe(true)
  })

  it('rejects invalid app state', async () => {
    const schema = await getSchema()
    const result = schema.safeParse({ mobile: { appState: 'fresh' } })
    expect(result.success).toBe(false)
  })

  it('rejects stale global device', async () => {
    const schema = await getSchema()
    const result = schema.safeParse({ device: 'pixel-7' })
    expect(result.success).toBe(false)
  })

  it('rejects stale global action proofs', async () => {
    const schema = await getSchema()
    const result = schema.safeParse({ actionProofs: 'strict' })
    expect(result.success).toBe(false)
  })
})

describe('UseOverrideSchema mobile device and app state', () => {
  async function getSchema() {
    const mod = await import('../use-schema.js') as any
    return mod.UseOverrideSchema as z.ZodType
  }

  it('accepts explicit device and app-state override', async () => {
    const schema = await getSchema()
    const result = schema.safeParse({ device: 'ios-sim', mobile: { appState: 'reset' } })
    expect(result.success).toBe(true)
  })

  it('rejects stale action proofs override', async () => {
    const schema = await getSchema()
    const result = schema.safeParse({ actionProofs: 'recover' })
    expect(result.success).toBe(false)
  })
})

describe('DeviceConfigSchema removed from primitives', () => {
  it('no longer exports DeviceConfigSchema', async () => {
    const mod = await import('../primitives.js')
    expect((mod as any).DeviceConfigSchema).toBeUndefined()
  })
})

describe('TargetSchema no longer has device field', () => {
  it('rejects device field on target', async () => {
    const mod = await import('../registry-schema.js') as any
    const result = mod.TargetSchema.safeParse({
      platform: 'android',
      device: 'some-device',
    })
    expect(result.success).toBe(false)
  })
})

describe('TargetSchema app install fields', () => {
  async function getSchema() {
    const mod = await import('../registry-schema.js') as any
    return mod.TargetSchema as z.ZodType
  }

  it('accepts mobile target app install fields', async () => {
    const schema = await getSchema()
    const result = schema.safeParse({
      platform: 'android',
      appPackage: 'org.wikipedia.alpha',
      appActivity: '.MainActivity',
      app: {
        path: 'apps/wikipedia.apk',
      },
    })

    expect(result.success).toBe(true)
  })

  it('rejects unknown target app keys', async () => {
    const schema = await getSchema()
    const result = schema.safeParse({
      platform: 'android',
      app: {
        path: 'apps/wikipedia.apk',
        appPackage: 'org.wikipedia.alpha',
      },
    })

    expect(result.success).toBe(false)
  })

  it('rejects absolute target app path', async () => {
    const schema = await getSchema()
    const paths = ['/tmp/app.apk', 'C:\\tmp\\app.apk', '\\\\server\\share\\app.apk']

    for (const path of paths) {
      const result = schema.safeParse({
        platform: 'android',
        app: { path },
      })
      expect(result.success).toBe(false)
    }
  })
})
