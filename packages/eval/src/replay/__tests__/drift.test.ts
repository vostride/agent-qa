import { sha256hex } from '@vostride/agent-qa-schema'
import type { CompletedRunHandoff } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'
import { makeV2Handoff } from '../../__tests__/fixtures/handoff-fixtures'
import { canonicalJson } from '../../canonical-json'
import { assembleReceipt, canonicalizeInputLeg } from '../../extract/receipt'
import { projectInputLeg } from '../../extract/input-leg'
import { computeReplayDrift } from '../drift'

function fixtureDecision(handoff: CompletedRunHandoff = makeV2Handoff()) {
  const handoffTest = handoff.tests[0]!
  const step = handoffTest.steps[0]!
  const subAction = step.subActions[0]!
  const inputLeg = projectInputLeg({
    handoffTest,
    step,
    subAction,
    testIndex: handoffTest.testIndex,
    stepIndex: step.stepIndex,
    decisionOrdinal: 0,
  })
  const receipt = assembleReceipt({ inputLeg, step, subAction, handoff })
  return { handoff, step, subAction, inputLeg, receipt }
}

describe('computeReplayDrift', () => {
  it('reports no drift when the reconstructed leg matches the recorded hash', () => {
    const { inputLeg, receipt } = fixtureDecision()

    const result = computeReplayDrift(inputLeg, receipt.promptInputHash)

    expect(result.drift).toBe(false)
    expect(result.harnessDrift).toBe(false)
    expect(result.recordedHash).toBe(receipt.promptInputHash)
    expect(result.recomputedHash).toBe(receipt.promptInputHash)
    expect(result.recomputedHash).toBe(sha256hex(canonicalizeInputLeg(inputLeg)))
  })

  it('reports drift with both hashes stamped when any single leg field mutates', () => {
    const { inputLeg, receipt } = fixtureDecision()
    const mutated = { ...inputLeg, stepText: `${inputLeg.stepText} (mutated)` }

    const result = computeReplayDrift(mutated, receipt.promptInputHash)

    expect(result.drift).toBe(true)
    expect(result.harnessDrift).toBe(true)
    expect(result.recordedHash).toBe(receipt.promptInputHash)
    expect(result.recomputedHash).not.toBe(receipt.promptInputHash)
    expect(result.recomputedHash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('canonicalJson', () => {
  it('sorts object keys recursively while retaining array order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(canonicalJson({ arr: [3, 1, 2] })).toBe('{"arr":[3,1,2]}')
    expect(canonicalJson({ b: 1, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":1}')
  })

  it('is stable across key-insertion-order permutations', () => {
    const a = { b: 1, a: { d: 4, c: 3 }, arr: [3, 1, 2] }
    const permuted = { arr: [3, 1, 2], a: { c: 3, d: 4 }, b: 1 }

    expect(canonicalJson(a)).toBe(canonicalJson(permuted))
  })
})
