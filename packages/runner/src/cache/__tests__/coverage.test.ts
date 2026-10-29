import { describe, expect, it } from 'vitest'

import {
  asRef,
  computeCacheKey,
  relevantEnvDigest,
  screenIdentityHash,
} from '@vostride/agent-qa-schema'
import type {
  ElementInfo,
  MaskFn,
  RedactedEnvVar,
  ScreenState,
} from '@vostride/agent-qa-schema'

import type { Action } from '../../platform.js'
import { makeScreenState } from '../../testing/screen-fixtures.js'
import { settle } from '../../loop/settle.js'
import { redactSecretValue, SecretRedactor, SecretStore } from '../../loop/secrets.js'

import { buildCacheableStepInput } from '../key.js'
import { buildCachedPlanValue, toGroundedLocator } from '../value.js'
import { classifyStep } from '../classify.js'
import { deterministicDescriptorMatcher } from '../reground.js'

const SECRET = 'sk-live-abcdef0123456789'
const SENTINEL_REF = 'ref-DO-NOT-STORE-9f9f'
const SENTINEL_DATA = 'order-id-should-never-persist-4242'

function envVars(name = 'API_KEY'): RedactedEnvVar[] {
  return [{ name, present: true, kind: 'string', lengthBucket: 4 }]
}

function keyInput(stepText: string, mask?: MaskFn, branch = 'main') {
  return buildCacheableStepInput({
    mask,
    platform: 'web',
    suiteConfigDigest: 'suite',
    testConfigDigest: 'test',
    stepText,
    stepIndex: 0,
    testIndex: 0,
    envVars: envVars(),
    envSalt: 'salt',
    screenIdentityHash: 'screen-hash',
    branch,
  })
}

function element(ref: string, role: string, nameNormalized: string, name?: string): ElementInfo {
  return {
    ref: asRef(ref),
    role,
    name: name ?? nameNormalized,
    nameNormalized,
    state: { enabled: true, focused: false, visible: true },
    labels: {},
    attributes: {},
  }
}

function screen(name: string, nameNormalized = 'cart'): ScreenState {
  return makeScreenState({ elements: [element('e1', 'button', nameNormalized, name)] })
}

function scriptedObserve(states: ScreenState[]) {
  let index = 0
  return async (): Promise<ScreenState> => {
    const state = states[Math.min(index, states.length - 1)]
    index += 1
    return state
  }
}

describe('CACHE roll-call — one green proof per acceptance criterion', () => {
  it('mask() is applied before hashing — the masked key differs from the raw key and the filename carries no secret', () => {
    const redactor = new SecretRedactor(new SecretStore({ API_TOKEN: SECRET }))
    const stepText = `call API with ${SECRET}`

    const masked = keyInput(stepText, (text) => redactSecretValue(text, redactor))
    const raw = keyInput(stepText)

    // Masked step text — and therefore the derived key/filename — carry no raw secret.
    expect(masked.stepText).not.toContain(SECRET)
    expect(computeCacheKey(masked)).not.toBe(computeCacheKey(raw))
    const filename = `${computeCacheKey(masked)}.json`
    expect(filename).not.toContain(SECRET)
    expect(filename.endsWith('.json')).toBe(true)
    // The env digest is value-free by construction.
    expect(masked.relevantEnvDigest).toBe(relevantEnvDigest(envVars(), 'salt'))
  })

  it('an env/secret read-or-set step classifies NonCacheable → no key/entry is built, maps to bypass', () => {
    // Reads a live secret template.
    const readResult = classifyStep({ stepText: 'log in with password {{secret:API_KEY}}' })
    expect(readResult.cacheable).toBe(false)
    // Sets a live env variable (setVariable provenance).
    const setResult = classifyStep({ stepText: 'save the session token', envSets: ['SESSION'] })
    expect(setResult.cacheable).toBe(false)
    // A non-cacheable classification carries no envVars digest surface — no key material
    // is assembled and no descriptor value is stored (the loop bypasses instead).
    expect('envVars' in readResult).toBe(false)
    if (readResult.cacheable === false) {
      expect(typeof readResult.reason).toBe('string')
      expect(readResult.reason.length).toBeGreaterThan(0)
    }
    // A config-env-dependent step is cacheable and carries only value-free shapes.
    const cacheable = classifyStep({
      stepText: 'open the dashboard',
      configEnv: [{ name: 'BASE_URL', present: true, kind: 'string', lengthBucket: 2 }],
    })
    expect(cacheable.cacheable).toBe(true)
  })

  it('the cached value is descriptor-only (no ref/coords/data) and the deterministic matcher re-grounds it', () => {
    const elements = [element(SENTINEL_REF, 'button', 'checkout', 'Checkout')]
    const action = { type: 'click', ref: SENTINEL_REF, data: SENTINEL_DATA } as unknown as Action

    const value = buildCachedPlanValue({
      plannedActions: [action],
      elements,
      completesStep: true,
    })

    // Descriptor-only: the serialized value never carries the raw ref or step data.
    const serialized = JSON.stringify(value)
    expect(serialized).not.toContain(SENTINEL_REF)
    expect(serialized).not.toContain(SENTINEL_DATA)
    expect(value.groundedLocator[0]).toEqual({ role: 'button', name: 'Checkout' })

    // The deterministic matcher re-derives a fresh ref from the descriptor against a
    // fresh observation (the replay → re-ground rung).
    const locator = toGroundedLocator(action, elements)
    expect(locator).not.toBeNull()
    const fresh = [element('e-fresh', 'button', 'checkout', 'Checkout')]
    expect(deterministicDescriptorMatcher.reground(locator!, fresh)).toEqual({ kind: 'resolved', ref: fresh[0].ref })
    // No match → absent (fall through to replan).
    expect(deterministicDescriptorMatcher.reground({ role: 'button', name: 'Missing' }, fresh)).toEqual({ kind: 'absent' })
  })

  it('branch is never a key component — the same tuple under two branches yields the same key', () => {
    expect(computeCacheKey(keyInput('click the log in button', undefined, 'main'))).toBe(
      computeCacheKey(keyInput('click the log in button', undefined, 'feature/x')),
    )
  })

  it('the settle gate proceeds on two consecutive matching hashes and returns that stable hash', async () => {
    const stable = screen('Cart')
    const observe = scriptedObserve([stable, stable, stable])

    const result = await settle(observe, { maxPolls: 4, intervalMs: 0, deadline: 0 })

    // The returned hash is the single value downstream consumes (settle + key component + progress).
    expect(result.hash).toBe(screenIdentityHash(stable))
    expect(result.hash).toBe(screenIdentityHash(result.state))
  })
})
