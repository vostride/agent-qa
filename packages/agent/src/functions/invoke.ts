// No gate and no permission check: the caller record is presentation data only.

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

export class FunctionInputError extends Error {
  constructor(
    readonly functionId: string,
    readonly issues: string,
  ) {
    super(`Invalid input for ${functionId}: ${issues}`)
    this.name = 'FunctionInputError'
  }
}

function issueSummary(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.map(String).join('.')
      return path.length === 0 ? issue.message : `${path}: ${issue.message}`
    })
    .join('; ')
}

// Order is asserted by tests: resolve, validate input, check binding, dispatch, validate output.
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

  // Dispatch refuses on the same `resolveBindingStatus` a listing renders, so they cannot disagree.
  if (resolveBindingStatus(spec, internals.deps) === 'unbound') {
    throw new FunctionNotBoundError(functionId)
  }

  const result = await spec.invoke(parsed.data, internals.deps)

  // A stream result IS the declared async iterable and passes through untouched: the
  // spec's `output` describes one ELEMENT, so parsing the iterable against it would be a
  // category error. Elements carry their own resume token.
  return spec.resultKind === 'unary' ? spec.output.parse(result) : result
}
