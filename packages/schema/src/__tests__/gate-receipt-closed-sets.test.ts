import { describe, expect, it } from 'vitest'
import {
  GATE_NUMBERS,
  GATE_VERDICTS,
  CROSS_CHECKS,
  DEGRADATIONS,
  BENEFITS,
  MARKS,
  STATE_VALIDITIES,
} from '../knowledge/gate-receipt'

describe('receipt closed vocabularies', () => {
  it('declares exactly the two gate numbers, in declaration order', () => {
    expect([...GATE_NUMBERS]).toEqual([1, 3])
  })
  it('declares exactly the three gate verdicts, in declaration order', () => {
    expect([...GATE_VERDICTS]).toEqual(['pass', 'fail', 'abstain'])
  })
  it('declares exactly the four cross checks, in declaration order', () => {
    expect([...CROSS_CHECKS]).toEqual(['flipped', 'held', 'inconclusive', 'not-run'])
  })
  it('declares exactly the two degradations, in declaration order', () => {
    expect([...DEGRADATIONS]).toEqual(['replay-diff', 'tier-not-implemented'])
  })
  it('declares exactly the three benefits, in declaration order', () => {
    expect([...BENEFITS]).toEqual(['exercised-benefited', 'rode-along', 'exercised-harmed'])
  })
  it('declares exactly the three marks, in declaration order', () => {
    expect([...MARKS]).toEqual(['false-fail', 'false-pass', 'confirmed-bug'])
  })
  it('declares exactly the three state validities, in declaration order', () => {
    expect([...STATE_VALIDITIES]).toEqual(['valid', 'stale', 'unknown'])
  })
})

import {
  GATE1_REASONS,
  GATE1_TARGET_SOURCES,
  GATE1_K_SOURCES,
  GATE1_HARM_ORIGINS,
  gate1SpendSchema,
} from '../knowledge/gate-receipt'

describe('Gate-1 closed vocabularies', () => {
  it('declares exactly the twelve Gate-1 reasons, in declaration order', () => {
    expect([...GATE1_REASONS]).toEqual([
      'tier-not-implemented',
      'unprovenanced-candidate',
      'empty-gate-set',
      'target-unavailable',
      'baseline-uncached',
      'collateral-unscorable',
      'cap-exceeded',
      'no-positive-value',
      'collateral-harm',
      'target-not-reproduced',
      'inconclusive',
      'same-family-refused',
    ])
  })
  it('declares exactly the two Gate-1 target sources, in declaration order', () => {
    expect([...GATE1_TARGET_SOURCES]).toEqual(['committed', 'extracted'])
  })
  it('declares exactly the three Gate-1 k sources, in declaration order', () => {
    expect([...GATE1_K_SOURCES]).toEqual(['flag', 'config', 'default'])
  })
  it('declares exactly the two Gate-1 harm origins, in declaration order', () => {
    expect([...GATE1_HARM_ORIGINS]).toEqual(['gate-set', 'target-step'])
  })
  it('accepts exactly the five Gate-1 spend keys', () => {
    const spend = {
      screens: 0,
      modelCalls: 0,
      promptTokens: 0,
      completionTokens: 0,
      wallClockMs: 0,
    }
    expect(gate1SpendSchema.safeParse(spend).success).toBe(true)
    for (const key of Object.keys(spend)) {
      const missing: Record<string, number> = { ...spend }
      delete missing[key]
      expect(gate1SpendSchema.safeParse(missing).success).toBe(false)
    }
    expect(gate1SpendSchema.safeParse({ ...spend, cost: 0 }).success).toBe(false)
  })
})
