// Declaration-order runtime walls complement result.test-d.ts's type coverage bars.
// Relative imports read source directly for the Plan 12 mutation measurement.
import { describe, expect, it } from 'vitest'
import { BRIEF_SOURCES, TURN_MATCHES } from '../brief-tiers'
import { REPLAY_REFUSAL_REASONS } from '../result'

describe('415 D-07 — replay closed sets', () => {
  it('declares exactly the seven replay refusal reasons, in declaration order', () => {
    // prettier-ignore
    expect([...REPLAY_REFUSAL_REASONS]).toEqual(['guard-failed', 'completeness', 'missing-blob', 'action-tool-collision', 'unsupported-brief', 'unrenderable-brief', 'parse-failed'])
  })

  it('declares exactly the three brief sources, in declaration order', () => {
    expect([...BRIEF_SOURCES]).toEqual(['proof', 'rendered', 'empty'])
  })

  it('declares exactly the two turn matches, in declaration order', () => {
    expect([...TURN_MATCHES]).toEqual(['exact', 'uniform'])
  })
})
