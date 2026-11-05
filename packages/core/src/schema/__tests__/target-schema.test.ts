import { describe, it, expect } from 'vitest'
import { AgentQaConfigSchema } from '../config-schema.js'
import { TargetSchema } from '../registry-schema.js'

// No default: the run gate's descriptor builder alone decides that undeclared means shared.
describe('TargetSchema.environment, the target class', () => {
  const webBase = { platform: 'web' as const, url: 'https://example.com' }

  it('accepts environment: local', () => {
    const result = TargetSchema.safeParse({ ...webBase, environment: 'local' })
    expect(result.success).toBe(true)
    expect(result.success && result.data.environment).toBe('local')
  })

  it('accepts environment: shared', () => {
    const result = TargetSchema.safeParse({ ...webBase, environment: 'shared' })
    expect(result.success).toBe(true)
    expect(result.success && result.data.environment).toBe('shared')
  })

  it('leaves an undeclared target undeclared — no schema-level default', () => {
    const result = TargetSchema.safeParse(webBase)
    expect(result.success).toBe(true)
    expect(result.success && result.data.environment).toBeUndefined()
    expect(result.success && Object.hasOwn(result.data, 'environment')).toBe(false)
  })

  it('refuses a value outside the enum', () => {
    // `production` is a declared class, so the outside sample is `staging`.
    const result = TargetSchema.safeParse({ ...webBase, environment: 'staging' })
    expect(result.success).toBe(false)
    expect(result.success ? [] : result.error.issues.map((i) => i.path.join('.'))).toContain(
      'environment',
    )
  })

  it('refuses a typoed sibling key rather than reading it as a declaration', () => {
    // The .strict() guarantee that makes `environmnet: shared` a refusal instead of a target that
    // silently classifies as undeclared while its author believes it is declared.
    const result = TargetSchema.safeParse({ ...webBase, environmnet: 'shared' })
    expect(result.success).toBe(false)
  })

  it('refuses a typoed environment key spelled as a plausible synonym', () => {
    const result = TargetSchema.safeParse({ ...webBase, env: 'local' })
    expect(result.success).toBe(false)
  })
})

describe('TargetSchema device and app reference', () => {
  const android = { platform: 'android' as const, appPackage: 'com.example.shop' }

  it('accepts the default device and an app reference beside the app file', () => {
    const result = TargetSchema.safeParse({
      ...android,
      device: 'pixel',
      app: { path: 'builds/shop.apk', ref: 'shop-latest' },
    })
    expect(result.success).toBe(true)
    expect(result.success && result.data.device).toBe('pixel')
    expect(result.success && result.data.app).toEqual({
      path: 'builds/shop.apk',
      ref: 'shop-latest',
    })
  })

  it('accepts an app reference without an app file', () => {
    const result = TargetSchema.safeParse({
      ...android,
      app: { ref: 'https://apps.example.com/shop.apk' },
    })
    expect(result.success).toBe(true)
  })

  it('refuses an empty device or app reference', () => {
    expect(TargetSchema.safeParse({ ...android, device: '' }).success).toBe(false)
    expect(TargetSchema.safeParse({ ...android, app: { ref: '  ' } }).success).toBe(false)
  })
})

describe("a target's device and app reference in the strict parse", () => {
  const workspace = {
    testMatch: ['tests/**/*.yaml'],
    suiteMatch: ['suites/**/*.suite.yaml'],
    hooksFile: 'hooks.yaml',
    envFile: '.env',
    secretsFile: '.env.secrets.local',
  }
  const farm = { name: 'farm', protocol: 'appium', url: 'https://farm.example.com/wd/hub' }
  const devices = {
    pixel: { platform: 'android', model: 'Pixel 8' },
    iphone: { platform: 'ios', model: 'iPhone 16' },
    'galaxy-farm': { platform: 'android', model: 'Samsung Galaxy S24', remote: 'farm' },
  }
  const shop = { platform: 'android', appPackage: 'com.example.shop' }

  function issues(targets: Record<string, unknown>, remotes: unknown[] = [farm]) {
    const result = AgentQaConfigSchema.safeParse({
      workspace,
      registry: { remotes, devices, targets },
    })
    return result.success
      ? []
      : result.error.issues.map((issue) => ({ path: issue.path, message: issue.message }))
  }

  it('accepts a device of the target platform', () => {
    expect(issues({ 'shop-android': { ...shop, device: 'pixel' } })).toEqual([])
    expect(issues({ 'shop-ios': { platform: 'ios', device: 'iphone' } })).toEqual([])
  })

  it('refuses a device registry.devices does not list, naming what it lists', () => {
    expect(issues({ 'shop-android': { ...shop, device: 'pixle' } })).toEqual([
      {
        path: ['registry', 'targets', 'shop-android', 'device'],
        message:
          'Target shop-android names device "pixle", which registry.devices does not list. registry.devices lists: pixel, iphone, galaxy-farm.',
      },
    ])
  })

  it('refuses a device of another platform', () => {
    expect(issues({ 'shop-android': { ...shop, device: 'iphone' } })).toEqual([
      {
        path: ['registry', 'targets', 'shop-android', 'device'],
        message: 'Target shop-android is android, but its device iphone is ios.',
      },
    ])
  })

  it('refuses a device on a web target', () => {
    const web = { platform: 'web', url: 'https://example.com', device: 'pixel' }
    expect(issues({ web })).toEqual([
      {
        path: ['registry', 'targets', 'web', 'device'],
        message: 'Target web is a web target; device applies to android and ios targets.',
      },
    ])
  })

  it('refuses a literal credential in an app reference url and accepts a server reference', () => {
    const signed = 'https://apps.example.com/shop.apk?X-Amz-Signature=abc123'
    expect(issues({ 'shop-android': { ...shop, app: { ref: signed } } })).toEqual([
      {
        path: ['registry', 'targets', 'shop-android', 'app', 'ref'],
        message:
          'Target shop-android: app.ref query "X-Amz-Signature" names a credential, so its value must be a {{secret:NAME}} reference.',
      },
    ])
    expect(issues({ 'shop-android': { ...shop, app: { ref: 'shop-latest' } } })).toEqual([])
  })

  it("refuses a credential in an app reference its device's remote gets over http:// to another host", () => {
    const plain = { ...farm, url: 'http://farm.example.com/wd/hub' }
    const target = { ...shop, device: 'galaxy-farm', app: { ref: 'storage:{{secret:SHOP_APP}}' } }
    expect(issues({ 'shop-android': target }, [plain])).toEqual([
      {
        path: ['registry', 'targets', 'shop-android', 'app', 'ref'],
        message:
          'Target shop-android sends a credential in its app.ref over http:// to farm.example.com through device galaxy-farm; use https://.',
      },
    ])
    expect(issues({ 'shop-android': target })).toEqual([])
  })
})
