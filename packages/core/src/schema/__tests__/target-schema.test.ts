import { describe, it, expect } from 'vitest'
import { TargetSchema } from '../registry-schema.js'

// D-06 (phase 401): a target declares which environment it lives in, and an UNDECLARED target is
// left visibly undeclared here so the run gate's descriptor builder — not this schema — is the one
// place that decides undeclared means shared. A `.default('shared')` in this file would move that
// decision into config loading and make an honest declaration indistinguishable from a silence.
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
    // 432 D-18 made `production` a declared class, so the outside sample is `staging`.
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
