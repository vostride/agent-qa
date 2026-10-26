import { describe, expect, it } from 'vitest'
import { GATE_NUMBERS, GATE_VERDICTS, BENEFITS, MARKS } from '../knowledge/gate-receipt'

describe('receipt closed vocabularies', () => {
  it('declares exactly the mark-and-approval gate number', () => {
    expect([...GATE_NUMBERS]).toEqual([3])
  })
  it('declares exactly the three gate verdicts, in declaration order', () => {
    expect([...GATE_VERDICTS]).toEqual(['pass', 'fail', 'abstain'])
  })
  it('declares exactly the three benefits, in declaration order', () => {
    expect([...BENEFITS]).toEqual(['exercised-benefited', 'rode-along', 'exercised-harmed'])
  })
  it('declares exactly the three marks, in declaration order', () => {
    expect([...MARKS]).toEqual(['false-fail', 'false-pass', 'confirmed-bug'])
  })
})
