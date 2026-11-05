import { describe, it, expect } from 'vitest'
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
