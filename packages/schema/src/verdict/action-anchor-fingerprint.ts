// A sibling of the frozen failure fingerprint, never an extension: the two recipes move apart.

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

// Bumping it re-keys every accumulated fingerprint, so accrued coverage comparison resets.
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

// Goes through the public `normalizeAnchor` so route normalization stays single-sourced.
function normalizedRoute(route: string): string {
  const normalized = normalizeAnchor({ t: 'page', route })
  return normalized.t === 'page' ? normalized.route : route
}

// Pure, total and byte-stable across processes.
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

// Order and repeats are preserved: deduplication belongs to the consumer.
export function actionAnchorSequence(
  inputs: readonly ActionAnchorElementInput[],
): string[] {
  return inputs.map((input) => actionAnchorElement(input))
}

// `extractAI` reads state without asserting anything, so it covers surface like an action.
export const ASSERT_ACTION_TYPES: ReadonlySet<string> = new Set(['assertAI', 'assertValue'])

// Falls back to the page anchor, so an assertion with no element target still adds coverage.
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

// One function for draft and suite alike, so the comparison measures two tests, not two recipes.
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
