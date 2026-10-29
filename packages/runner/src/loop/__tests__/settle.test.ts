// RED scaffold (Wave 0, CACHE-05 / D-09 / D-16). The bounded settle gate polls
// screenIdentityHash and proceeds on two consecutive matching hashes; it ignores
// benign text churn (same role+nameNormalized identity) and proceeds-on-latest at the
// maxPolls bound without hanging. The returned hash is the value downstream consumes
// (settle + key component + progress). Fails until Plan 04 creates ../settle.ts.
import { describe, expect, it } from 'vitest'

import { screenIdentityHash } from '@vostride/agent-qa-schema'
import type { ElementInfo, ScreenState } from '@vostride/agent-qa-schema'
import { makeScreenState } from '../../testing/screen-fixtures.js'

import { settle } from '../settle.js'

function cartElement(name: string, nameNormalized = 'cart'): ElementInfo {
  return {
    ref: 'e1' as ElementInfo['ref'],
    role: 'button',
    name,
    nameNormalized,
    state: { enabled: true, focused: false, visible: true },
    labels: {},
    attributes: {},
  }
}

function screen(name: string, nameNormalized?: string): ScreenState {
  return makeScreenState({ elements: [cartElement(name, nameNormalized)] })
}

function scriptedObserve(states: ScreenState[]) {
  let index = 0
  const rec = { count: 0, last: undefined as ScreenState | undefined }
  const observe = async (): Promise<ScreenState> => {
    const state = states[Math.min(index, states.length - 1)]
    index += 1
    rec.count += 1
    rec.last = state
    return state
  }
  return { observe, rec }
}

const OPTS = { maxPolls: 4, intervalMs: 0, deadline: 0 }

describe('settle gate', () => {
  it('an already-stable screen settles on two consecutive matching hashes and returns that hash', async () => {
    const stable = screen('Cart')
    const { observe, rec } = scriptedObserve([stable, stable, stable])

    const result = await settle(observe, OPTS)

    expect(result.hash).toBe(screenIdentityHash(stable))
    // The returned hash is exactly what a key builder / progress signal consumes.
    expect(result.hash).toBe(screenIdentityHash(result.state))
    // Two consecutive matching observations → settled with the minimal number of observes.
    expect(rec.count).toBe(2)
  })

  it('ignores benign text churn — same role+nameNormalized identity still settles', async () => {
    const before = screen('Cart (3)')
    const after = screen('Cart (0)')

    // Precondition: the visible text churns but the semantic identity is unchanged.
    expect(before.elements[0].name).not.toBe(after.elements[0].name)
    expect(screenIdentityHash(before)).toBe(screenIdentityHash(after))

    const { observe, rec } = scriptedObserve([before, after, after])
    const result = await settle(observe, OPTS)

    expect(result.hash).toBe(screenIdentityHash(before))
    expect(rec.count).toBeLessThanOrEqual(3)
  })

  it('a never-stable screen hits the bound and proceeds on the latest hash without hanging', async () => {
    const states = Array.from({ length: 10 }, (_, i) => screen(`item ${i}`, `item ${i}`))
    const { observe, rec } = scriptedObserve(states)

    const result = await settle(observe, OPTS)

    // Bounded: the poll never exceeds maxPolls + the initial observe (no infinite spin).
    expect(rec.count).toBeLessThanOrEqual(OPTS.maxPolls + 1)
    // Proceeds on the latest observation's hash.
    expect(result.state).toBe(rec.last)
    expect(result.hash).toBe(screenIdentityHash(rec.last as ScreenState))
  })
})
