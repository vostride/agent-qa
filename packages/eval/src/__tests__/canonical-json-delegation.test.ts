import {
  canonicalJson as schemaCanonicalJson,
  canonicalValue as schemaCanonicalValue,
} from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'
import {
  canonicalJson as evalCanonicalJson,
  canonicalValue as evalCanonicalValue,
} from '../canonical-json'

describe('schema-owned canonical JSON delegation', () => {
  it('exposes the same canonical JSON functions through eval', () => {
    const value = { z: [{ b: 2, a: 1 }], a: { d: 4, c: 3 } }

    expect(evalCanonicalValue).toBe(schemaCanonicalValue)
    expect(evalCanonicalJson).toBe(schemaCanonicalJson)
    expect(evalCanonicalJson(value)).toBe(schemaCanonicalJson(value))
  })
})
