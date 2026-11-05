import { describe, it, expect } from 'vitest'
import { parse as parseYaml } from 'yaml'
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

  it('accepts a device described by model and a quoted os', async () => {
    const schema = await getSchema()
    const result = schema.safeParse({
      platform: 'android',
      model: 'Samsung Galaxy S24',
      os: '14',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toMatchObject({ model: 'Samsung Galaxy S24', os: '14' })
    }
  })

  it('refuses os written as a number, with a hint to quote it', async () => {
    const schema = await getSchema()
    const result = schema.safeParse({
      platform: 'ios',
      model: 'iPhone 16',
      os: 17.10,
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map(issue => ({ path: issue.path, message: issue.message }))).toEqual([
        { path: ['os'], message: 'os must be text, so write it in quotes, such as os: "17.10".' },
      ])
    }
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

describe('a device on a remote', () => {
  const workspace = {
    testMatch: ['tests/**/*.yaml'],
    suiteMatch: ['suites/**/*.suite.yaml'],
    hooksFile: 'hooks.yaml',
    envFile: '.env',
    secretsFile: '.env.secrets.local',
  }
  const farm = { name: 'farm', protocol: 'appium', url: 'https://farm.example.com/wd/hub' }
  const teamServer = { name: 'team-server', protocol: 'playwright', url: 'wss://grid.example.com/playwright' }
  const galaxyFarm = { platform: 'android', model: 'Samsung Galaxy S24', os: '14', remote: 'farm' }

  async function issues(remotes: unknown[], device: Record<string, unknown>) {
    const { AgentQaConfigSchema } = await import('../config-schema.js')
    const result = AgentQaConfigSchema.safeParse({
      workspace,
      registry: { remotes, devices: { 'galaxy-farm': device } },
    })
    return result.success ? [] : result.error.issues.map(issue => ({ path: issue.path, message: issue.message }))
  }

  it('parses a device described by model and os on a listed appium remote', async () => {
    expect(await issues([farm, teamServer], galaxyFarm)).toEqual([])
  })

  it('refuses a remote that registry.remotes does not list, naming the device and what is listed', async () => {
    expect(await issues([farm, teamServer], { ...galaxyFarm, remote: 'fram' })).toEqual([
      {
        path: ['registry', 'devices', 'galaxy-farm', 'remote'],
        message:
          'Device galaxy-farm names remote "fram", which registry.remotes does not list. registry.remotes lists: farm, team-server.',
      },
    ])
    expect(await issues([], galaxyFarm)).toEqual([
      {
        path: ['registry', 'devices', 'galaxy-farm', 'remote'],
        message:
          'Device galaxy-farm names remote "farm", which registry.remotes does not list. registry.remotes lists no remotes.',
      },
    ])
  })

  it('refuses a remote that is not an appium remote', async () => {
    expect(await issues([farm, teamServer], { ...galaxyFarm, remote: 'team-server' })).toEqual([
      {
        path: ['registry', 'devices', 'galaxy-farm', 'remote'],
        message:
          "Device galaxy-farm names remote team-server, a playwright remote; a device's remote needs protocol: appium.",
      },
    ])
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

describe('the device config, here and on a remote', () => {
  const example = `
workspace:
  testMatch: ['tests/**/*.yaml']
  suiteMatch: ['suites/**/*.suite.yaml']
  hooksFile: hooks.yaml
  envFile: .env
  secretsFile: .env.secrets.local
use:
  mobile:
    appState: reset
registry:
  remotes:
    - name: farm
      protocol: appium
      url: https://farm.example.com/wd/hub
      basicAuth:
        user: "{{secret:FARM_USER}}"
        password: "{{secret:FARM_KEY}}"
  devices:
    pixel:
      platform: android
      model: Pixel 8
    iphone:
      platform: ios
      model: iPhone 16
      os: "18.4"
    galaxy-farm:
      platform: android
      remote: farm
      model: Samsung Galaxy S24
      os: "14"
    rack-s24-b:
      platform: android
      model: SM-S921B
      id: R58M41ABCDE
  targets:
    shop-android:
      platform: android
      appPackage: com.example.shop
      device: pixel
      app:
        path: builds/shop.apk
        ref: shop-latest
    shop-ios:
      platform: ios
      bundleId: com.example.shop
      device: iphone
      app:
        path: builds/Shop.app
`

  it('parses the example config with local and remote devices and each target naming its device', async () => {
    const { AgentQaConfigSchema } = await import('../config-schema.js')
    const result = AgentQaConfigSchema.safeParse(parseYaml(example))
    expect(result.success ? [] : result.error.issues.map(issue => issue.message)).toEqual([])
    if (!result.success) return
    expect(result.data.registry?.devices?.['rack-s24-b']).toMatchObject({ id: 'R58M41ABCDE' })
    expect(result.data.registry?.devices?.['galaxy-farm']).toMatchObject({
      remote: 'farm',
      os: '14',
    })
    expect(result.data.registry?.targets?.['shop-android']).toMatchObject({
      device: 'pixel',
      app: { path: 'builds/shop.apk', ref: 'shop-latest' },
    })
    expect(result.data.registry?.targets?.['shop-ios']?.device).toBe('iphone')
  })

  it('accepts capabilities on a device, here or remote', async () => {
    const mod = await import('../registry-schema.js') as any
    const result = mod.DeviceProfileSchema.safeParse({
      platform: 'android',
      model: 'Pixel 8',
      capabilities: {
        'appium:automationName': 'Espresso',
        'farm:options': { realDevice: true, accessKey: '{{secret:FARM_KEY}}' },
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.capabilities['farm:options']).toEqual({
        realDevice: true,
        accessKey: '{{secret:FARM_KEY}}',
      })
    }
  })

  it('refuses an empty id', async () => {
    const mod = await import('../registry-schema.js') as any
    const result = mod.DeviceProfileSchema.safeParse({
      platform: 'android',
      model: 'Pixel 8',
      id: ' ',
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
