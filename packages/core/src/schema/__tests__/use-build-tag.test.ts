import { describe, expect, it } from 'vitest'
import { UseSchema } from '../use-schema.js'

describe('UseSchema buildTag', () => {
  it('accepts and trims a non-empty build tag', () => {
    expect(UseSchema.parse({ buildTag: '  v1.2.0  ' }).buildTag).toBe('v1.2.0')
  })

  it.each(['', '   '])('rejects an empty build tag %#', (buildTag) => {
    expect(UseSchema.safeParse({ buildTag }).success).toBe(false)
  })

  it('remains optional', () => {
    expect(UseSchema.safeParse({}).success).toBe(true)
  })

  it('retains strict rejection of unknown keys', () => {
    expect(UseSchema.safeParse({ unknownKey: true }).success).toBe(false)
  })
})
