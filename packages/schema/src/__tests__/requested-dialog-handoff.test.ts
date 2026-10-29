// C446-REQUESTED-DIALOG-HANDOFF (446-11, D-25): a run whose step recorded an open dialog as the
// state the step asked for still loads, and the loader still refuses an account it has no reading for.
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { guardCompletedRunHandoff, stepOutcomeUnproven } from '../index'
import type { CompletedRunHandoff } from '../index'

const preChangeHandoff = new URL(
  '../../../../test-fixtures/legacy-handoff/handoff.json',
  import.meta.url,
)

function block(account: string) {
  return {
    ending: 'completion',
    conditions: [
      {
        quote: 'Find and open the product "Everyday Ceramic Mug"',
        verdict: 'met',
        reason: 'The product dialog is open.',
        citations: [
          { source: 'final-screen', quote: '- dialog "Everyday Ceramic Mug" [ref=e74]', found: true },
        ],
      },
    ],
    openDialogs: [{ name: 'Everyday Ceramic Mug', account }],
  }
}

function handoffWith(conditionVerdicts: unknown): unknown {
  const handoff = JSON.parse(readFileSync(preChangeHandoff, 'utf8')) as CompletedRunHandoff
  const step = handoff.tests[0].steps[0] as unknown as Record<string, unknown>
  step.conditionVerdicts = conditionVerdicts
  return JSON.parse(JSON.stringify(handoff))
}

describe('a requested open dialog at the handoff loader', () => {
  it('a handoff whose step records a requested dialog loads and reads as proven', () => {
    let loaded: CompletedRunHandoff | undefined
    expect(() => {
      loaded = guardCompletedRunHandoff(handoffWith(block('requested')))
    }).not.toThrow()
    const step = loaded?.tests[0].steps[0]
    expect(step?.conditionVerdicts).toEqual(block('requested'))
    expect(stepOutcomeUnproven(step ?? {})).toBe(false)
  })

  it('a dialog account the loader has no reading for is still refused', () => {
    expect(() => guardCompletedRunHandoff(handoffWith(block('maybe')))).toThrow()
    expect(() => guardCompletedRunHandoff(handoffWith(block('unrelated')))).not.toThrow()
  })
})
