// `invokeFunction` — the single dispatch path every surface crosses.
//
// THERE IS NO OP GATE. The surface-capability `evaluate()`
// call that used to sit here — the ask ladder, its confirm port, the standing-approval reader and the
// chat session's deny overlay — is gone, and so is its `EVALUATE_PIN` entry. An op a caller may
// invoke runs once, in every execution context, and no execution-audit row is written for it.
//
// What stays is everything that is not an approval: the unknown-id refusal, input validation, the
// binding check, dispatch, and output validation for unary results.
//
// THERE ARE NO PERMISSIONS EITHER. The scope subset check, the
// human-origin check and their two refusal classes are deleted, and so is the registry's safe-mode
// listing filter: every door can call every operation. The caller record is not read here at all.
// Its `surface` and `origin` survive only for the receipts and presentation that already consume
// them; a branch on either in this path would re-create the per-door powers this layer abolished.

import type { FunctionCaller } from '@vostride/agent-qa-schema'

import { registryInternals, resolveBindingStatus } from './registry.js'
import type { FunctionRegistry } from './registry.js'
import { FunctionNotBoundError } from './spec.js'

// Declared next to `FunctionBindingStatus` (see spec.ts) and surfaced here so every
// caller-facing refusal this pipeline can raise is importable as one set.
export { FunctionNotBoundError }

/** No capability with this id is registered. Thrown before any dependency is touched. */
export class UnknownFunctionError extends Error {
  constructor(readonly functionId: string) {
    super(`Unknown function: ${functionId}`)
    this.name = 'UnknownFunctionError'
  }
}

/** The supplied input failed the op's declared input contract. */
export class FunctionInputError extends Error {
  constructor(
    readonly functionId: string,
    readonly issues: string,
  ) {
    super(`Invalid input for ${functionId}: ${issues}`)
    this.name = 'FunctionInputError'
  }
}

// `FunctionScopeError` and `FunctionOriginError` are deleted with the
// scope and human-origin checks that raised them. Nothing refuses a caller for who it is.

// `FunctionDeniedError` is deleted. It was the execution gate's
// refusal, carrying the gate's reason and remedies; no gate raises it since 432-13, and the doors
// that reconstructed or rendered it no longer look for it.

function issueSummary(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.map(String).join('.')
      return path.length === 0 ? issue.message : `${path}: ${issue.message}`
    })
    .join('; ')
}

/**
 * Run one registered capability on behalf of one caller.
 *
 * Order is load-bearing and asserted by tests:
 *   1. resolve the spec        — unknown id fails before any dependency is touched
 *   2. validate the input      — malformed input never reaches an implementation
 *   3. binding check           — a declared-but-unbound op refuses by name
 *   4. dispatch                — the only place a spec implementation ever runs
 *   5. validate the output     — unary results honour their declared contract
 *
 * Stream ops run through the SAME steps. Nothing between the refusals and dispatch asks
 * anybody anything, and nothing reads who is calling: `caller` is accepted so
 * every door keeps one call shape, and the record it carries is presentation data only.
 */
export async function invokeFunction(
  registry: FunctionRegistry,
  functionId: string,
  input: unknown,
  _caller: FunctionCaller,
): Promise<unknown> {
  const internals = registryInternals(registry)
  const spec = internals?.specs.get(functionId)
  if (internals === undefined || spec === undefined) {
    throw new UnknownFunctionError(functionId)
  }

  const parsed = spec.input.safeParse(input)
  if (!parsed.success) {
    throw new FunctionInputError(functionId, issueSummary(parsed.error.issues))
  }

  // The DECLARATION is authoritative — an op this composition reports as `unbound` never
  // dispatches, whatever its implementation happens to do — and it is the SAME
  // `resolveBindingStatus` a listing renders, so what a caller was shown and what dispatch
  // enforces cannot disagree.
  if (resolveBindingStatus(spec, internals.deps) === 'unbound') {
    throw new FunctionNotBoundError(functionId)
  }

  const result = await spec.invoke(parsed.data, internals.deps)

  // A stream result IS the declared async iterable and passes through untouched: the
  // spec's `output` describes one ELEMENT, so parsing the iterable against it would be a
  // category error. Elements carry their own resume token.
  return spec.resultKind === 'unary' ? spec.output.parse(result) : result
}
