import { describe, expect, it } from 'vitest'

import { asRef } from '@vostride/agent-qa-schema'
import type { Action, VerifierVerdict } from '@vostride/agent-qa-schema'
import { makeScreenState } from '../../testing/screen-fixtures.js'

import { EvidenceRecorder } from '../evidence.js'

const clickAction: Action = { type: 'click', ref: asRef('e2') }
const passVerdict: VerifierVerdict = { pass: true, reasoning: 'goal met' }

function recorderWithCachedSubAction(): EvidenceRecorder {
  const recorder = new EvidenceRecorder()
  recorder.recordSubAction({
    plan: 'read the API key',
    plannedAction: clickAction,
    stateBefore: makeScreenState(),
    result: { success: true },
    // A cached flag would ordinarily fold to 'hit' — the bypass signal must override it.
    cached: true,
  })
  return recorder
}

describe('EvidenceRecorder.finalize bypass signal', () => {
  it('emits cacheStatus=bypass when the step is flagged non-cacheable', () => {
    const recorder = recorderWithCachedSubAction()

    const step = recorder.finalize(passVerdict, 0, 'read API_KEY', { nonCacheable: true })

    expect(step.cacheStatus).toBe('bypass')
  })

  it('bypass is a threaded signal, orthogonal to the boolean hit/miss fold', () => {
    // Same recorder state, no signal → the boolean fold still yields hit (not bypass).
    const control = recorderWithCachedSubAction()
    expect(control.finalize(passVerdict, 0, 'read API_KEY').cacheStatus).toBe('hit')
  })
})
