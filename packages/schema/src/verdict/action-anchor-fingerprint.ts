// The action-anchor fingerprint: gate 3's v1 coverage recipe.
//
// A SIBLING of `failure-fingerprint.ts`, never an extension of it. That file is FROZEN
// because 390's recurrence windows key off its bytes; this one answers a different
// question — what surface does a test EXERCISE, rather than how did it FAIL — and the two must
// be free to move independently. What they share is their building blocks: `normalizeAnchor`
// and `canonicalJson`, imported here rather than re-derived, so "near-same anchors are the
// same anchor" has exactly one definition in the codebase.
//
// THE RECIPE (contract, not implementation detail):
//   1. An element is `{ kind, type, anchor }`, plus `route` only when the step carries one.
//      `kind` separates the two vocabularies: an action contributes its action type, an
//      assertion contributes its assert-kind. Asserting a value on a field and typing into it
//      are different coverage facts about the same anchor, so they must key apart.
//   2. The anchor passes through `normalizeAnchor` — the shape-locked contract that casefolds
//      roles, runs names through `normalizeAccessibleName`, and collapses route hashes and
//      trailing slashes. A route context is normalized through the SAME contract's page arm,
//      so `/Form.html/#thanks` and `/form.html` are one route here exactly as they are there.
//   3. The element is `canonicalJson` of that object — keys sorted, so a caller building the
//      input in a different order cannot mint a second key for the same fact. Readable rather
//      than hashed, matching the frozen sibling: a receipt NAMES the uncovered element,
//      and a reader owed an explanation should be able to see what the key says.
//
// SET SEMANTICS LIVE AT THE CONSUMER. Gate 3's value test is "at least one element absent from
// the union of the suite's elements" (D-14, spec §6.3 verbatim) — no similarity threshold, no
// magic constant. This module mints elements and preserves order; it deliberately does NOT
// deduplicate, because the sequence is what a later §4.1 enrichment builds on.

import { canonicalJson } from '../determinism/canonical-json'
import type { StepEvidence } from '../handoff/step-evidence'
import type { SubActionEvidence } from '../handoff/sub-action-evidence'
import type { Anchor } from '../identity/anchor'
import {
  classifySubActionRoute,
  elementAnchor,
  resolvedElementEvidence,
} from '../identity/exercised-anchors'
import { normalizeAnchor } from '../identity/normalize-anchor'
import { actionDidNotFail } from '../result/no-input'

/**
 * The recipe version. Bumping it RE-KEYS every accumulated fingerprint: the derived suite
 * table has to refold, and receipts already citing uncovered elements no longer line up with
 * what the table holds, so accrued coverage comparison resets. That is the costly-reversibility
 * note in D-13, and it is the reason the goldens in `__tests__` exist.
 */
export const ACTION_ANCHOR_FINGERPRINT_VERSION = 1

/** One exercised step, reduced to what coverage cares about. */
export interface ActionAnchorElementInput {
  /** Which vocabulary `type` is drawn from: an action type, or an assert-kind. */
  readonly kind: 'action' | 'assert'
  /** The action type (`click`, `fill`, …) or the assert-kind (`assertValue`, `assertAI`, …). */
  readonly type: string
  /** The step's target, in the frozen anchor union `normalizeAnchor` accepts. */
  readonly anchor: Anchor
  /** Route the step carried, where it carried one. Absent means no route context. */
  readonly route?: string
}

/**
 * Normalize a route through the frozen anchor contract's page arm.
 *
 * `normalizeRoute` is private to `normalize-anchor.ts` and stays that way — reaching it through
 * the public `normalizeAnchor` reuses the contract instead of copying its body, which is what
 * keeps route normalization single-sourced when 377-era extensions move it.
 */
function normalizedRoute(route: string): string {
  const normalized = normalizeAnchor({ t: 'page', route })
  return normalized.t === 'page' ? normalized.route : route
}

/**
 * One fingerprint element. Pure, total, and byte-stable across processes: every step of
 * the recipe is a pure function of its arguments.
 */
export function actionAnchorElement(input: ActionAnchorElementInput): string {
  const base = {
    kind: input.kind,
    type: input.type,
    anchor: normalizeAnchor(input.anchor),
  }
  return canonicalJson(
    input.route === undefined ? base : { ...base, route: normalizedRoute(input.route) },
  )
}

/**
 * The ordered element sequence for one test.
 *
 * Order and repeats are preserved deliberately — see the SET SEMANTICS note above.
 */
export function actionAnchorSequence(
  inputs: readonly ActionAnchorElementInput[],
): string[] {
  return inputs.map((input) => actionAnchorElement(input))
}

/**
 * Which action types contribute an ASSERT element rather than an ACTION element.
 *
 * `kind` is the recipe's vocabulary discriminator: asserting a value on a field and typing into
 * it are different coverage facts about the same anchor, so they must key apart. The members are
 * the assert arms of `CommonAction` — the only action shapes whose purpose is a claim about the
 * app rather than a change to it. `extractAI` is deliberately absent: an extraction reads state
 * without asserting anything about it, so it covers surface the way an action does.
 *
 * Hoisted here from `knowledge-local`'s fold in 393-06, on the trigger its own doc comment named:
 * "a second reader is the trigger to hoist it beside `actionAnchorElement`, not before." Gate 3's
 * draft side is that second reader.
 */
export const ASSERT_ACTION_TYPES: ReadonlySet<string> = new Set(['assertAI', 'assertValue'])

/**
 * The anchor one sub-action exercised, or `undefined` when it exercised nothing nameable.
 *
 * Both arms route through the shipped exercised-anchors walk rather than re-deriving element
 * resolution: `resolvedElementEvidence` is the ONE implementation of "which element did this ref
 * resolve to on the pre-action screen" (389 D-13's promotion), reached here by handing it a step
 * narrowed to a single sub-action — the same reach-the-contract-through-its-public-door idiom
 * `normalizedRoute` above uses for routes.
 *
 * Falling back to the page anchor is what lets an assertion with no element target — `assertValue`
 * over the URL, the canonical case — still contribute coverage. A sub-action with neither an
 * element nor a route contributes nothing, which is the evidence-less case D-16's text lane
 * catches at the consumer.
 */
function subActionAnchor(step: StepEvidence, subAction: SubActionEvidence): Anchor | undefined {
  const [resolved] = resolvedElementEvidence({ ...step, subActions: [subAction] })
  if (resolved !== undefined) return elementAnchor(resolved)
  const { route } = classifySubActionRoute(subAction)
  return route === undefined ? undefined : { t: 'page', route }
}

/**
 * The evidence `testFingerprintElements` reads, and nothing more.
 *
 * A `PerTestOutcome` is assignable unchanged — the suite side passes one straight out of the
 * fold. Declared as its own structural shape rather than as `PerTestOutcome` because the DRAFT
 * side passes the draft's own member out of a gate-run document and the identity fields play no
 * part in the recipe: naming only `steps` says which facts the elements are a function of, so a
 * reader cannot suspect the file path or the test name of leaking into the bytes.
 */
export interface FingerprintEvidenceLike {
  readonly steps?: readonly StepEvidence[]
}

/**
 * The ordered elements one test exercised, or `[]` when its evidence yields none.
 *
 * ONE FUNCTION, BOTH SIDES OF GATE 3. The suite union is folded from these bytes
 * (`knowledge-local`'s `suite_fingerprints`), and the draft's own elements are computed by this
 * same function from the draft's member outcome inside its gate-run document. That is what makes
 * the comparison a comparison: an asymmetric derivation — a draft measured one way against a
 * suite measured another — would compare two recipes rather than two tests, and would answer
 * "does this draft add value" with an artifact of the derivation. Living in `schema` is what lets
 * both readers reach it; `agent` names neither `core` nor `knowledge-local` and never will.
 *
 * ONLY SUB-ACTIONS THAT DID NOT FAIL COUNT (`actionDidNotFail`). A failed sub-action did not run
 * to an accepted result, and a surface an action failed to reach is not surface the test covers.
 * A skipped tap did not fail: it found its target already in the desired state and sent no input
 * so its anchor counts, as it did before 437 recorded the skip `success: false`.
 * Retuning that rule is a measurement, not a preference, and it must move on both sides at once —
 * which is now structurally guaranteed rather than merely intended.
 *
 * A route is attached as CONTEXT only to element anchors. A page anchor already IS its route, so
 * repeating it would mint two spellings of one fact.
 */
export function testFingerprintElements(test: FingerprintEvidenceLike): string[] {
  const elements: string[] = []
  for (const step of test.steps ?? []) {
    for (const subAction of step.subActions ?? []) {
      if (!actionDidNotFail(subAction.result)) continue
      const anchor = subActionAnchor(step, subAction)
      if (anchor === undefined) continue
      const type = subAction.plannedAction.type
      const { route } = classifySubActionRoute(subAction)
      elements.push(actionAnchorElement({
        kind: ASSERT_ACTION_TYPES.has(type) ? 'assert' : 'action',
        type,
        anchor,
        ...(anchor.t === 'el' && route !== undefined ? { route } : {}),
      }))
    }
  }
  return elements
}
