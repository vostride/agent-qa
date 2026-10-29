// THE CEILING'S ARITHMETIC (Phase 392 plan 09, CHAT-03 / D-15).
//
// A GATE THAT CANNOT FAIL IS WORSE THAN NO GATE, so the two things this file proves are that the
// comparison FAILS when it should and PASSES at the boundary — in that order of importance. Every
// case below is a pair: the count that must pass and the next count up, which must not.
//
// THE PRECISION CASES ARE NOT PEDANTRY. The failure this codebase has actually shipped is a
// threshold that rounds in the implementer's favour: a rate expressed as a percentage and compared
// after rounding turns 20.1% into 20% and reports a breached ceiling as met. `1000 / 201` below is
// exactly that case, and it is the reason the ceiling is a `{ num, den }` rational compared by
// cross-multiplication over integers rather than a float.

import { describe, expect, it } from 'vitest'
import type { ChatSessionEvent } from '@vostride/agent-qa-schema'

import { MARK_UNHANDLED_CEILING, ceilingExceeded, computeMarkUnhandledRate } from '../ceiling.js'

/** A session log's worth of events, produced rather than spelled as a literal where it matters. */
function events(kinds: readonly ChatSessionEvent['kind'][]): ChatSessionEvent[] {
  return kinds.map((kind, index) => {
    const base = { turnId: `turn-${index}`, at: '2026-08-09T00:00:00.000Z' }
    switch (kind) {
      case 'mark_unhandled':
        return { ...base, kind, clause: `clause ${index}`, reason: 'nothing can do that' }
      case 'user_message':
        return { ...base, kind, text: `utterance ${index}` }
      case 'turn_complete':
        return { ...base, kind, status: 'completed' }
      default:
        throw new Error(`this fixture does not mint ${kind}`)
    }
  }) as ChatSessionEvent[]
}

describe('the ceiling is a pinned rational, not a float', () => {
  it('pins integer numerator and denominator', () => {
    // A float here would be the first half of the rounding bug the boundary cases below exist to
    // catch: `0.2` is not exactly representable, and a comparison against it is a comparison
    // against whatever the nearest double happens to be.
    expect(Number.isInteger(MARK_UNHANDLED_CEILING.num)).toBe(true)
    expect(Number.isInteger(MARK_UNHANDLED_CEILING.den)).toBe(true)
    expect(MARK_UNHANDLED_CEILING.den).toBeGreaterThan(0)
    expect(MARK_UNHANDLED_CEILING.num).toBeGreaterThanOrEqual(0)
  })

  it('is the 1/5 the retune comment names', () => {
    // The pin is quoted in SUMMARY files and in the retune comment; a silent change to it would
    // make every previously recorded rate incomparable without saying so.
    expect(MARK_UNHANDLED_CEILING).toEqual({ num: 1, den: 5 })
  })
})

describe('computeMarkUnhandledRate projects counts, never a division', () => {
  it('counts only mark_unhandled events, over the denominator it was handed', () => {
    const counts = computeMarkUnhandledRate(
      events(['user_message', 'mark_unhandled', 'turn_complete', 'mark_unhandled']),
      10,
    )
    expect(counts).toEqual({ unhandledCount: 2, denominator: 10 })
  })

  it('answers zero over an event list with no refusals in it', () => {
    expect(computeMarkUnhandledRate(events(['user_message', 'turn_complete']), 4)).toEqual({
      unhandledCount: 0,
      denominator: 4,
    })
  })

  it('stores no quotient — the pair of counts IS the answer', () => {
    // The field rate is a projection over session logs using this same function, and a stored
    // quotient would be a second number that could disagree with the counts it came from.
    const counts = computeMarkUnhandledRate(events(['mark_unhandled']), 3)
    expect(Object.keys(counts).sort()).toEqual(['denominator', 'unhandledCount'])
  })
})

describe('ceilingExceeded is strict greater-than on cross-multiplied integers', () => {
  it('PASSES a count exactly at the ceiling (boundary, the low side)', () => {
    // 2/10 is exactly 1/5. The gate must not fail a corpus that sits on its own pin, or the pin
    // would be a number nobody could ever satisfy.
    expect(ceilingExceeded({ unhandledCount: 2, denominator: 10 })).toBe(false)
  })

  it('FAILS one more than the ceiling (boundary, the high side)', () => {
    expect(ceilingExceeded({ unhandledCount: 3, denominator: 10 })).toBe(true)
  })

  it('PASSES zero refusals over any denominator', () => {
    expect(ceilingExceeded({ unhandledCount: 0, denominator: 3 })).toBe(false)
    expect(ceilingExceeded({ unhandledCount: 0, denominator: 1 })).toBe(false)
  })

  it('FAILS 20.1% — the case a rounded percentage would report as met (precision)', () => {
    // The whole reason the comparison is exact. An implementation computing `rate * 100` and
    // rounding to whole percent reads 20 here and passes; the cross-multiplied integers read
    // 201 * 5 = 1005 > 1000 * 1 = 1000 and fail.
    expect(ceilingExceeded({ unhandledCount: 201, denominator: 1000 })).toBe(true)
    expect(ceilingExceeded({ unhandledCount: 200, denominator: 1000 })).toBe(false)
  })

  it('FAILS any refusal against an EMPTY denominator', () => {
    // A refusal counted against a corpus with nothing in it is not a rate at all, and reporting
    // it as within the ceiling would be the vacuous pass this gate exists to refuse.
    expect(ceilingExceeded({ unhandledCount: 1, denominator: 0 })).toBe(true)
    expect(ceilingExceeded({ unhandledCount: 0, denominator: 0 })).toBe(false)
  })

  it('agrees with exact rational arithmetic across every denominator up to 200', () => {
    // The property behind the hand-picked cases: no denominator exists at which the shipped
    // comparison and exact arithmetic disagree.
    for (let denominator = 0; denominator <= 200; denominator += 1) {
      for (let unhandledCount = 0; unhandledCount <= denominator + 1; unhandledCount += 1) {
        const exact =
          BigInt(unhandledCount) * BigInt(MARK_UNHANDLED_CEILING.den)
          > BigInt(denominator) * BigInt(MARK_UNHANDLED_CEILING.num)
        expect(ceilingExceeded({ unhandledCount, denominator })).toBe(exact)
      }
    }
  })
})
