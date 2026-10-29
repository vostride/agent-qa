// THE mark_unhandled CEILING.
//
// `mark_unhandled` is the FAIL-CLOSED PATH, not an error path. It is supposed to fire: a build that
// cannot author a test must refuse to author a test, by name, rather than reaching for the nearest
// op it does have. So the thing worth measuring is not whether it fires — it is whether it starts
// firing on requests this build CAN serve, because that is how a fail-closed path decays. It goes
// noisy, a person learns to distrust it, and the pressure lands on disabling it rather than on
// fixing the routing underneath. The ceiling is what turns that decay into a red build.
//
// TWO PROPERTIES, AND BOTH ARE STRUCTURAL RATHER THAN CAREFUL:
//
//   1. THE DENOMINATOR IS THE FROZEN MANIFEST. `SCENARIO_CORPUS`, never a directory listing and
//      never a glob. A scoring set that grows as scenarios are written lets the ratio drift without
//      anyone deciding it should, which is this project's most expensive recorded failure mode
//      (D-15, RESEARCH Pitfall 2). Nothing in this module can discover a scenario; a caller must
//      hand it a count, and the only honest source of that count is the manifest.
//
//   2. THE COMPARISON IS EXACT INTEGER ARITHMETIC. The ceiling is a rational `{ num, den }`
//      compared by cross-multiplication, never a percentage compared after rounding. A rate
//      rounded to whole percent reports 20.1% as 20% and passes a breached ceiling — a threshold
//      that rounds in the implementer's favour is not a threshold.
//
// ONE FUNCTION SERVES BOTH READINGS. The harness measures the rate over the corpus; a live
// deployment's FIELD rate is a projection over `mark_unhandled` rows in session logs. Both are
// `computeMarkUnhandledRate` over a list of events. There is no metric store, no field gate, and no
// second counter that could disagree with this one about what a refusal is.

import type { ChatSessionEvent } from '@vostride/agent-qa-schema'

/**
 * The pinned ceiling: at most one refusal per five `should_execute` scenarios.
 *
 * A PINNED CONSTANT WITH A RETUNE COMMENT, NEVER CONFIG. A configurable ceiling is a
 * ceiling that gets raised the first time it is inconvenient, at which point it measures the
 * patience of whoever raised it.
 *
 * OWNER: the chat orchestration subsystem.
 *
 * RETUNE WHEN, and only when:
 *   - the corpus GROWS through a deliberate `SCENARIO_CORPUS` bump, and the new members change what
 *     a representative request looks like. At the corpus size this pin ships against, 1/5 leaves no
 *     slack at all on the live lane — three `should_execute` live scenarios means the first refusal
 *     exceeds it. That is deliberate for a young corpus: with three cells, one miss IS a routing
 *     regression, and a tolerance that hid it would be a tolerance for nothing observable.
 *   - a MEASURED live rate sits consistently far from the pin in either direction across several
 *     gate runs. Consistently far below means the pin has stopped being a gate; consistently just
 *     above on requests that genuinely cannot be served means the corpus admitted cells the build
 *     was never going to route, and the fix is the corpus, not the number.
 *
 * A retune moves this constant AND `SCENARIO_CORPUS_VERSION`, so a rate recorded in any SUMMARY
 * stays attributable to the pair it was measured against.
 */
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

/**
 * Count the refusals in a session-event stream against a caller-supplied denominator.
 *
 * The denominator is a PARAMETER rather than something this module derives, and that is the D-15
 * discipline expressed as a signature: a function that could count scenarios for itself would be
 * one refactor away from counting files on a disk.
 */
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
