// New for 353-03: the D-13 re-run context block (LOOP-03 planner visibility).
// The re-run flag surfaces to the planner as prompt context; when absent the turn
// content is byte-identical to a non-rerun turn (no empty re-run block leaks).
//
// 355-02 redirect (Wave-0, RED pending Plan 03): the monolithic step-prompt builder is
// retired. The re-run context block now rides in the per-turn content emitted by
// `composeTurnMessages(...)` (D-04). Every content assertion is preserved byte-for-byte;
// only the producing call changes.
import { describe, it, expect } from 'vitest'
import type { ModelMessage } from 'ai'
// Plan-03 turn API — intentionally unresolved today (the RED reason for this suite):
import { composeTurnMessages } from '../prompts.js'
import type { ScreenState } from '@vostride/agent-qa-schema'
import type { StepContext } from '../types.js'
import { buildAgentScreenState } from './screen-fixtures.js'

function makeScreenState(): ScreenState {
  return buildAgentScreenState({
    tree: '- button "Submit" [ref=e1]',
    elements: [{ ref: 'e1', role: 'button', name: 'Submit', attributes: {} }],
    timestamp: 0,
    metadata: { coordSpace: 'viewport', viewportWidth: 0, viewportHeight: 0 },
  })
}

function makeContext(overrides: Partial<StepContext> = {}): StepContext {
  return {
    stepInstruction: 'click submit',
    testName: 'checkout test',
    previousSteps: [],
    plannerModel: {} as any,
    verifierModel: {} as any,
    ...overrides,
  }
}

// Concatenate the text parts of the per-turn ModelMessage[] into one rendered string
// so the existing content assertions run unchanged against the turn content.
function renderTurn(messages: ModelMessage[]): string {
  return messages
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : m.content
            .map((part) => ('text' in part && typeof part.text === 'string' ? part.text : ''))
            .join(''),
    )
    .join('\n')
}

describe('re-run context block', () => {
  const screenState = makeScreenState()

  it('renders the re-run attempt number and failure summary when isRerun is true', () => {
    const ctx = makeContext({
      isRerun: true,
      rerunAttempt: 2,
      previousFailureSummary: 'step 4 timed out waiting for the confirmation toast',
    })
    const result = renderTurn(composeTurnMessages(ctx, screenState))

    expect(result).toContain('re-run attempt 2')
    expect(result).toContain('step 4 timed out waiting for the confirmation toast')
  })

  it('renders the attempt banner even without a failure summary', () => {
    const ctx = makeContext({ isRerun: true, rerunAttempt: 3 })
    const result = renderTurn(composeTurnMessages(ctx, screenState))

    expect(result).toContain('re-run attempt 3')
    expect(result).toContain('A previous attempt of this test failed')
  })

  it('produces turn content identical to a non-rerun turn when isRerun is absent (no re-run wording leaks)', () => {
    const baseline = makeContext()
    const withAbsentRerunFields = makeContext({
      isRerun: false,
      rerunAttempt: undefined,
      previousFailureSummary: undefined,
    })

    const baselinePrompt = renderTurn(composeTurnMessages(baseline, screenState))
    const absentPrompt = renderTurn(composeTurnMessages(withAbsentRerunFields, screenState))

    expect(absentPrompt).toBe(baselinePrompt)
    expect(absentPrompt).not.toContain('re-run attempt')
    expect(absentPrompt).not.toContain('RE-RUN CONTEXT')
  })
})
