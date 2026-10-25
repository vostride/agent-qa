// The chip decision is a declaration over the shipped job-kind vocabulary, not a fall-through.
//
// A kind this build declares chip-less (`chat`, `consolidate`) and a kind it cannot classify at
// all (a row a later build wrote) both emit nothing, but they are different facts, and the
// decision keeps them observable as different answers. The decision is TOTAL over `JobKind`, so
// the day a kind is declared it has to choose here rather than inherit.

import { describe, expect, it } from 'vitest'

import type { JobKind } from '@vostride/agent-qa-schema'

import { postRunChipDecision } from '../post-run-chip-emitter.js'

/** The shipped vocabulary, restated HERE so a kind added to the union reds this file by name. */
const SHIPPED_JOB_KINDS: readonly JobKind[] = [
  'chat',
  'analyze-run',
  'curate-memory',
  'consolidate',
]

describe('the chip decision is total over the shipped job kinds', () => {
  it('declares chat and consolidate chip-less rather than letting them fall through', () => {
    expect(postRunChipDecision('chat')).toEqual({ kind: 'declared-chip-less' })
    expect(postRunChipDecision('consolidate')).toEqual({ kind: 'declared-chip-less' })
    // The two chain stages speak through chips.
    expect(postRunChipDecision('analyze-run')).toEqual({
      kind: 'chips',
      chips: { started: 'analysisStarted', completed: 'analysisCompleted', failed: 'analysisFailed' },
    })
    expect(postRunChipDecision('curate-memory')).toEqual({
      kind: 'chips',
      chips: { started: 'curationStarted', completed: 'curationCompleted', failed: 'curationFailed' },
    })
  })

  it('answers every shipped kind, so a new kind must choose here rather than inherit', () => {
    for (const kind of SHIPPED_JOB_KINDS) {
      expect(postRunChipDecision(kind).kind).not.toBe('unknown-kind')
    }
  })

  it('keeps a kind this build does not know DISTINCT from one it declares chip-less', () => {
    expect(postRunChipDecision('a-kind-from-a-later-build')).toEqual({ kind: 'unknown-kind' })
    expect(postRunChipDecision('consolidate')).not.toEqual({ kind: 'unknown-kind' })
  })
})
