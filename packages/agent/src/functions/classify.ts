// The result folds, run at the ONE seam that can reach a spec.
//
// WHY THIS FILE IS HERE AND NOT IN `chat/`. The knowledge of which arm of an op's output union is a
// refusal lives on that op's {@link FunctionSpec}, and a spec never leaves this directory (BL-01 /
// 384 FUNC-03) — `ChatInvokeBinding` is deliberately a closure over `invokeFunction` rather than a
// registry handle, so the chat subtree cannot run a fold even if it wanted to. What CAN reach both
// is the composition root, which holds the registry and mints that closure; this module is what it
// calls on the return path, so the fold runs in one place instead of once per composition.
//
// FAIL-CLOSED, AND ONLY FOR THE VERDICT. A classifier that throws, or answers something that
// is not a verdict, yields `failed` with a named outcome and NEVER `executed`. The asymmetry is the
// whole decision: an unreadable result might be a refusal, so success is the one claim a receipt
// must not default to — which is exactly what RC-1b's throw-versus-return derivation got backwards.
// `summariseOutcome`'s safeParse-with-silent-fallback is the right posture for a DISCLOSURE and the
// wrong one here, because the field being folded is the verdict itself.
//
// THE RENDER FOLD FAILS OPEN, AND THAT IS NOT AN INCONSISTENCY. A fold that throws costs the person
// a sentence of extra legibility; the complete payload is rendered from `results[]` either way
// so nothing is withheld and there is nothing to fail closed ABOUT. Failing the turn over a
// decorative line would be the disclosure destroying the record, which is the trade 392's receipt
// charter already refused.

import { registryInternals } from './registry.js'
import type { FunctionRegistry } from './registry.js'
import type { ClauseVerdict } from './spec.js'

/**
 * The verdict a result nobody could read reports.
 *
 * NAMED, so the receipt says which of the two failures happened. A thrown op error already reaches
 * the engine's own `failed` mapping carrying the function layer's refusal name; this outcome means
 * the op RETURNED and its own declared fold could not say what the return meant — a different fact,
 * and one that points at the op's classifier rather than at the op.
 */
const UNCLASSIFIABLE: ClauseVerdict = Object.freeze({
  status: 'failed',
  outcome: 'unclassifiable-result',
})

/** What a fold produced for one result: the verdict, and any extra human lines. */
export interface FunctionResultFold {
  readonly verdict: ClauseVerdict
  readonly foldLines: readonly string[]
}

/**
 * Whether a value is the verdict a classifier is contracted to return.
 *
 * CHECKED RATHER THAN CAST, because a classifier is ordinary op-authored code and a cast here would
 * put an arbitrary object on the receipt — including one whose `status` is a word no surface knows
 * how to render, which would land in a persisted session log and in the goldens. The status set is
 * spelled from the two members a classifier may return; `not-run` is deliberately unreachable from
 * here (see {@link ClauseVerdict}).
 */
function isClauseVerdict(value: unknown): value is ClauseVerdict {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { status?: unknown; outcome?: unknown }
  if (typeof candidate.outcome !== 'string') return false
  return candidate.status === 'executed' || candidate.status === 'refused'
    || candidate.status === 'failed'
}

/** Whether a value is the line list a render fold is contracted to return. */
function isLineList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((line) => typeof line === 'string')
}

/**
 * Fold one op's result into the verdict and the extra lines its spec declares.
 *
 * PURE FROM THE CALLER'S SIDE and side-effect-free by contract: both folds are declared pure on the
 * spec, this runs them and nothing else, and it is reached only AFTER the gate has run, the op has
 * run and the audit row is written. It reports; it decides nothing.
 *
 * THE REGISTRY IS AN ARGUMENT rather than a captured handle, so the composition root passes the
 * same registry it dispatched through and the two can never be different objects.
 */
export function foldFunctionResult(
  registry: FunctionRegistry,
  functionId: string,
  payload: unknown,
): FunctionResultFold {
  const spec = registryInternals(registry)?.specs.get(functionId)
  if (spec === undefined) {
    // The op dispatched a moment ago through this same registry, so this is unreachable in a
    // composed host — and it is answered fail-closed rather than optimistically anyway, because the
    // one thing this function must never do is report a success it cannot substantiate.
    return { verdict: UNCLASSIFIABLE, foldLines: [] }
  }
  return { verdict: verdictOf(spec, payload), foldLines: linesOf(spec, payload) }
}

function verdictOf(
  spec: { classify?: (output: never) => unknown },
  payload: unknown,
): ClauseVerdict {
  // AN ABSENT CLASSIFIER IS FAIL-CLOSED AS OF 399.1-04, AND THE FLIP IS THE WHOLE POINT OF THE
  // PLAN THAT MADE IT. This answered the legacy `{ status: 'executed', outcome: '' }` for one plan,
  // while `FunctionSpec.classify` was optional and an op with no fold was an ordinary, expected,
  // COUNTABLE thing. The member is required now, so an absent one no longer means "this op has not
  // got round to it" — it means a cast got past `tsc` AND past the conformance census, and the one
  // claim a receipt must never default to is success.
  //
  // THE PARAMETER STAYS OPTIONAL ON PURPOSE. Narrowing it to a required member would delete this
  // branch and make the guard unwritable, which is the type system certifying its own coverage:
  // `foldFunctionResult` is exported, the registry stores specs behind an internals seam, and
  // `registry.ts` itself registers a stream spec through an `as`-cast. The branch is reachable in
  // exactly the situation it exists for, and `refusal-classifiers.test.ts` drives it.
  if (typeof spec.classify !== 'function') return UNCLASSIFIABLE
  try {
    const answered: unknown = spec.classify(payload as never)
    return isClauseVerdict(answered) ? answered : UNCLASSIFIABLE
  } catch {
    return UNCLASSIFIABLE
  }
}

function linesOf(
  spec: { renderResult?: (output: never) => unknown },
  payload: unknown,
): readonly string[] {
  if (spec.renderResult === undefined) return []
  try {
    const rendered: unknown = spec.renderResult(payload as never)
    return isLineList(rendered) ? [...rendered] : []
  } catch {
    return []
  }
}
