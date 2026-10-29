// A spec never leaves this directory, so folds run here on the composition root's return path.

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
  // An `as`-cast spec can lack `classify`; an absent fold fails closed, never claims success.
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
