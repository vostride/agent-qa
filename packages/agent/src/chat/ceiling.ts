// The ceiling is a rational compared by cross-multiplication, so `20.1%` never rounds to `20%`.

import type { ChatSessionEvent } from '@vostride/agent-qa-schema'

export const MARK_UNHANDLED_CEILING = { num: 1, den: 5 } as const

/**
 * The measurement: two counts, and deliberately NOT their quotient.
 *
 * A stored rate would be a third number that could disagree with the two it came from, and the
 * comparison below never needs it — cross-multiplication reads the counts directly.
 */
export interface MarkUnhandledCounts {
  readonly unhandledCount: number
  readonly denominator: number
}

// The denominator is the frozen manifest's count, passed in; this module never discovers scenarios.
export function computeMarkUnhandledRate(
  events: readonly ChatSessionEvent[],
  denominator: number,
): MarkUnhandledCounts {
  let unhandledCount = 0
  for (const event of events) {
    if (event.kind === 'mark_unhandled') unhandledCount += 1
  }
  return { unhandledCount, denominator }
}

/**
 * Has the corpus exceeded the pinned ceiling?
 *
 * STRICT GREATER-THAN over cross-multiplied integers: a count sitting exactly ON the pin passes,
 * and one more fails. Both sides of that boundary are unit-tested, because a gate whose passing
 * side was never checked is a gate nobody can satisfy, and a gate whose failing side was never
 * checked is not a gate at all.
 *
 * An empty denominator with any refusal in it EXCEEDS, by the same arithmetic and for the right
 * reason: refusals counted against a corpus with nothing in it is not a rate, and reporting it as
 * within the ceiling would be exactly the vacuous pass this measurement exists to refuse.
 */
export function ceilingExceeded(counts: MarkUnhandledCounts): boolean {
  return (
    counts.unhandledCount * MARK_UNHANDLED_CEILING.den
    > counts.denominator * MARK_UNHANDLED_CEILING.num
  )
}
