// RED scaffold (Wave 0, CACHE-02 / D-07). Env/secret read-or-set steps classify to
// NonCacheableStepInput; a config-env-dependent step yields value-free RedactedEnvVar
// shapes for the digest. Fails until Plan 03 creates ../classify.ts. The classifier
// must reuse the provenance surface (findSecretTemplates / the [secret:*] marker /
// onSetVariable), NOT a hand-rolled step-text regex.
import { describe, expect, it } from 'vitest'

import type { RedactedEnvVar } from '@vostride/agent-qa-schema'
import { findSecretTemplates } from '../../loop/secrets.js'

import { classifyStep } from '../classify.js'

describe('classifyStep — non-cacheable env/secret provenance', () => {
  it('a step that reads a live secret template classifies as NonCacheableStepInput', () => {
    const stepText = 'log in with password {{secret:API_KEY}}'
    // Provenance surface the classifier reuses (not a bespoke regex).
    expect(findSecretTemplates(stepText).map(t => t.name)).toContain('API_KEY')

    const result = classifyStep({ stepText })
    expect(result.cacheable).toBe(false)
    if (result.cacheable === false) {
      expect(typeof result.reason).toBe('string')
      expect(result.reason.length).toBeGreaterThan(0)
    }
  })

  it('a step that sets a live env/secret (setVariable provenance) classifies as non-cacheable', () => {
    const result = classifyStep({ stepText: 'save the session token', envSets: ['SESSION'] })
    expect(result.cacheable).toBe(false)
  })
})

describe('classifyStep — config-env-dependent step yields value-free env shapes', () => {
  it('returns RedactedEnvVar digest shapes with no value field', () => {
    const configEnv: RedactedEnvVar[] = [
      { name: 'BASE_URL', present: true, kind: 'string', lengthBucket: 2 },
    ]
    const result = classifyStep({ stepText: 'open the dashboard', configEnv })

    expect(result.cacheable).toBe(true)
    if (result.cacheable === true) {
      expect(result.envVars.length).toBe(1)
      const [envVar] = result.envVars
      expect(envVar.name).toBe('BASE_URL')
      expect(envVar.present).toBe(true)
      expect(envVar.kind).toBe('string')
      // value-freeness is structural — no raw env value ever rides in the digest input.
      expect(Object.hasOwn(envVar, 'value')).toBe(false)
      expect(JSON.stringify(result.envVars)).not.toContain('value')
    }
  })
})
