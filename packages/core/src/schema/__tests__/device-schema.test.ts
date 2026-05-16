import { describe, it, expect } from 'vitest'
import { z } from 'zod'

describe('TransportSchema', () => {
  let TransportSchema: z.ZodType<'local' | 'browserstack'>

  it('imports from primitives', async () => {
    const mod = await import('../primitives.js')
    TransportSchema = (mod as any).TransportSchema
    expect(TransportSchema).toBeDefined()
  })

  it('accepts local', async () => {
    const { TransportSchema } = await import('../primitives.js') as any
    expect(TransportSchema.parse('local')).toBe('local')
  })

  it('accepts browserstack', async () => {
    const { TransportSchema } = await import('../primitives.js') as any
    expect(TransportSchema.parse('browserstack')).toBe('browserstack')
  })

  it('rejects saucelabs', async () => {
    const { TransportSchema } = await import('../primitives.js') as any
    expect(TransportSchema.safeParse('saucelabs').success).toBe(false)
  })

  it('rejects lambdatest', async () => {
    const { TransportSchema } = await import('../primitives.js') as any
    expect(TransportSchema.safeParse('lambdatest').success).toBe(false)
  })

  it('rejects invalid transport', async () => {
    const { TransportSchema } = await import('../primitives.js') as any
    expect(TransportSchema.safeParse('invalid').success).toBe(false)
  })
})

describe('DeviceProfileSchema', () => {
  async function getSchema() {
    const mod = await import('../registry-schema.js') as any
    return mod.DeviceProfileSchema as z.ZodType<{ match: Record<string, unknown> }>
  }

  it('accepts android local device with valid match', async () => {
    const schema = await getSchema()
    const result = schema.safeParse({
      platform: 'android',
      transport: 'local',
      match: { avd: 'Pixel_7' },
    })
    expect(result.success).toBe(true)
  })

  it('accepts ios browserstack device', async () => {
    const schema = await getSchema()
    const result = schema.safeParse({
      platform: 'ios',
      transport: 'browserstack',
      match: { deviceName: 'iPhone 15' },
    })
    expect(result.success).toBe(true)
  })

  it('rejects android local with iOS-only field (udid)', async () => {
    const schema = await getSchema()
    const result = schema.safeParse({
      platform: 'android',
      transport: 'local',
      match: { udid: 'xxx' },
    })
    expect(result.success).toBe(false)
  })

  it('rejects ios local with Android-only field (avd)', async () => {
    const schema = await getSchema()
    const result = schema.safeParse({
      platform: 'ios',
      transport: 'local',
      match: { avd: 'xxx' },
    })
    expect(result.success).toBe(false)
  })

  it('allows udid on android for farm transport (passthrough per D-08)', async () => {
    const schema = await getSchema()
    const result = schema.safeParse({
      platform: 'android',
      transport: 'browserstack',
      match: { udid: 'xxx' },
    })
    expect(result.success).toBe(true)
  })

  it('defaults match to empty object', async () => {
    const schema = await getSchema()
    const result = schema.safeParse({
      platform: 'android',
      transport: 'local',
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
      transport: 'local',
      match: {},
    })
    expect(result.success).toBe(false)
  })

  it('rejects android local match.noReset', async () => {
    const schema = await getSchema()
    const result = schema.safeParse({
      platform: 'android',
      transport: 'local',
      match: { noReset: true },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const message = result.error.issues.map(issue => issue.message).join('\n')
      expect(message).toContain('Allowed: avd, serial, appPackage, appActivity, automationName, browserName, platformVersion')
      expect(message).not.toContain('noReset,')
    }
  })

  it('rejects ios local match.noReset', async () => {
    const schema = await getSchema()
    const result = schema.safeParse({
      platform: 'ios',
      transport: 'local',
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

describe('RegistrySchema with devices + providers', () => {
  async function getSchema() {
    const mod = await import('../registry-schema.js') as any
    return mod.RegistrySchema as z.ZodType
  }

  it('accepts devices and providers fields', async () => {
    const schema = await getSchema()
    const result = schema.safeParse({
      llms: [],
      devices: {
        pixel: { platform: 'android', transport: 'local', match: {} },
      },
      providers: {},
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

describe('TargetSchema no longer has device field (D-17/D-18)', () => {
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
        browserstack: 'WikipediaApp',
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

  it('allows browserstack app references', async () => {
    const schema = await getSchema()
    for (const browserstack of ['bs://abc', 'CalculatorApp', 'exampleuser/CalculatorApp']) {
      const result = schema.safeParse({
        platform: 'android',
        app: { browserstack },
      })
      expect(result.success).toBe(true)
    }
  })
})
