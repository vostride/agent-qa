import { describe, expect, it } from 'vitest'

import { computeCacheKey, relevantEnvDigest } from '@vostride/agent-qa-schema'
import type { MaskFn, RedactedEnvVar } from '@vostride/agent-qa-schema'

import { buildCacheableStepInput } from '../key.js'
import { redactSecretValue, SecretRedactor, SecretStore } from '../../loop/secrets.js'

const SECRET = 'sk-live-abcdef0123456789'
const ENV_SALT = 'salt'
const STEP_TEXT = `call API with ${SECRET}`

function redactedEnvVars(): RedactedEnvVar[] {
  return [{ name: 'API_KEY', present: true, kind: 'string', lengthBucket: 4 }]
}

function declaredMask(): MaskFn {
  const redactor = new SecretRedactor(new SecretStore({ API_TOKEN: SECRET }))
  return (text) => redactSecretValue(text, redactor)
}

function buildInput(stepText: string, mask?: MaskFn) {
  return buildCacheableStepInput({
    mask,
    platform: 'web',
    suiteConfigDigest: 'suite-digest',
    testConfigDigest: 'test-digest',
    stepText,
    stepIndex: 0,
    testIndex: 0,
    envVars: redactedEnvVars(),
    envSalt: ENV_SALT,
    screenIdentityHash: 'screen-hash',
  })
}

describe('runtime cache-key masking floor', () => {
  it('masks stepText before it enters key material — masked key differs from raw key', () => {
    const masked = buildInput(STEP_TEXT, declaredMask())
    const raw = buildInput(STEP_TEXT)

    // Leg 1: the masked step text carries no raw secret substring.
    expect(masked.stepText).not.toContain(SECRET)
    expect(raw.stepText).toContain(SECRET)

    // The env digest is value-free by construction (no secret leak through env).
    expect(masked.relevantEnvDigest).toBe(relevantEnvDigest(redactedEnvVars(), ENV_SALT))
    expect(JSON.stringify(redactedEnvVars())).not.toContain(SECRET)

    // Leg 2: masking before hashing changes the key — a raw secret can never reach it.
    expect(computeCacheKey(masked)).not.toBe(computeCacheKey(raw))
  })

  it('the ${key}.json filename derived from the masked input carries no raw secret', () => {
    const masked = buildInput(STEP_TEXT, declaredMask())
    const filename = `${computeCacheKey(masked)}.json`

    expect(filename).not.toContain(SECRET)
    expect(filename.endsWith('.json')).toBe(true)
  })

  it('two masking contexts over the same secret produce the same masked key (deterministic mask)', () => {
    const maskedA = buildInput(STEP_TEXT, declaredMask())
    const maskedB = buildInput(STEP_TEXT, declaredMask())

    expect(maskedA.stepText).toBe(maskedB.stepText)
    expect(computeCacheKey(maskedA)).toBe(computeCacheKey(maskedB))
  })
})

describe('masked step text in the cache key', () => {
  it('the cache key folds the masked step text', () => {
    const mask = declaredMask()

    const rawForm = buildInput(`call API with ${SECRET}`, mask)
    const markerForm = buildInput('call API with [secret:API_TOKEN]', mask)
    expect(rawForm.stepText).toBe('call API with [secret:API_TOKEN]')
    expect(computeCacheKey(rawForm)).toBe(computeCacheKey(markerForm))

    const undeclared = buildInput('log in as qa@example.com', mask)
    expect(undeclared.stepText).toBe('log in as qa@example.com')
    expect(computeCacheKey(undeclared)).toBe(computeCacheKey(buildInput('log in as qa@example.com')))
  })
})
