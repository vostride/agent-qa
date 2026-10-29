// The handoff loader's per-condition verdict block: a well-formed block loads, a malformed one is
// refused, and a handoff without it loads unchanged.
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { guardCompletedRunHandoff } from '../index'
import type { CompletedRunHandoff, ConditionVerdictsEvidence } from '../index'

const preChangeHandoff = new URL(
  '../../../../test-fixtures/legacy-handoff/handoff.json',
  import.meta.url,
)

function wellFormed(): ConditionVerdictsEvidence {
  return {
    ending: 'completion',
    conditions: [
      {
        quote: 'Save the setting',
        verdict: 'unverified',
        judged: 'met',
        guard: 'citation-missing',
        needs: 'persistence',
        reason: 'no cited evidence was found in what the verifier was given',
        citations: [
          { source: 'final-screen', quote: 'Saved', found: false },
          { source: 'screenshot', quote: 'green tick', found: 'unchecked' },
        ],
        file: { name: 'match', content: 'differs', firstDifference: 'line 2' },
      },
      { quote: 'setting', verdict: 'met', reason: 'shown', citations: [] },
    ],
    openDialogs: [{ name: 'Cookies', account: 'unrelated' }],
  }
}

function handoffWith(block: unknown): unknown {
  const handoff = JSON.parse(readFileSync(preChangeHandoff, 'utf8')) as CompletedRunHandoff
  const step = handoff.tests[0].steps[0] as unknown as Record<string, unknown>
  if (block !== undefined) step.conditionVerdicts = block
  return JSON.parse(JSON.stringify(handoff))
}

describe('the condition verdicts block at the handoff loader', () => {
  it('a handoff whose step carries a well-formed block loads', () => {
    const loaded = guardCompletedRunHandoff(handoffWith(wellFormed()))
    expect(loaded.tests[0].steps[0].conditionVerdicts).toEqual(wellFormed())
  })

  it('a block whose conditions are not an array is refused', () => {
    expect(() => guardCompletedRunHandoff(handoffWith({ ...wellFormed(), conditions: 'x' }))).toThrow()
  })

  it('a block with an unknown verdict literal is refused', () => {
    const block = wellFormed()
    ;(block.conditions[1] as unknown as Record<string, unknown>).verdict = 'passed'
    expect(() => guardCompletedRunHandoff(handoffWith(block))).toThrow()
  })

  it("a citation whose found is 'maybe' is refused", () => {
    const block = wellFormed()
    ;(block.conditions[0].citations[0] as unknown as Record<string, unknown>).found = 'maybe'
    expect(() => guardCompletedRunHandoff(handoffWith(block))).toThrow()
  })

  it('a handoff with no block loads unchanged', () => {
    const input = handoffWith(undefined)
    const loaded = guardCompletedRunHandoff(JSON.parse(JSON.stringify(input)))
    expect(loaded).toEqual(input)
    expect('conditionVerdicts' in loaded.tests[0].steps[0]).toBe(false)
  })
})
