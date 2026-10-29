import type { ProcedureSourceBinding } from './procedure-binding-coercion'
import type { ProcedureBodyPayload, ProcedureParameterSpec } from './procedure-steps'

// Values never cross this contract; secrets carry names only.
export interface ProcedureBindingAvailability {
  variables: readonly ProcedureSourceBinding[]
  memory: readonly ProcedureSourceBinding[]
  secrets: readonly string[]
}

/** Empty availability for screenless and absent-caller paths. */
export const EMPTY_PROCEDURE_BINDING_AVAILABILITY = {
  variables: [],
  memory: [],
  secrets: [],
} as const satisfies ProcedureBindingAvailability

function bindingsByName(
  entries: readonly ProcedureSourceBinding[],
): ReadonlyMap<string, ProcedureSourceBinding> {
  const byName = new Map<string, ProcedureSourceBinding>()
  for (const entry of entries) {
    if (!byName.has(entry.name)) byName.set(entry.name, entry)
  }
  return byName
}

function isParameterAvailable(
  parameter: ProcedureParameterSpec,
  sources: {
    variables: ReadonlyMap<string, ProcedureSourceBinding>
    memory: ReadonlyMap<string, ProcedureSourceBinding>
    secrets: ReadonlySet<string>
  },
): boolean {
  if (parameter.type === 'secret') return sources.secrets.has(parameter.name)

  // Bits come from `coerceProcedureBindingValue`; change the binder there, never here alone.
  const variable = sources.variables.get(parameter.name)
  const memory = sources.memory.get(parameter.name)
  if (parameter.type === 'string') {
    return variable !== undefined || memory !== undefined || sources.secrets.has(parameter.name)
  }
  if (parameter.type === 'number') {
    return variable?.canBindNumber === true || memory?.canBindNumber === true
  }
  return variable?.canBindBoolean === true || memory?.canBindBoolean === true
}

/**
 * The ONE fillability contract consumed by both procedure matching and the replay binder.
 *
 * Only referenced `{ param }` slots participate. A reference without a unique committed
 * declaration fails closed. `required` does not alter this verdict: once a slot references a
 * parameter it needs a binding because schema version 1 has no typed default. A future typed
 * `default` field on ProcedureParameterSpec would exempt that parameter here.
 */
export function procedureParameterFillability(
  payload: ProcedureBodyPayload,
  availability: ProcedureBindingAvailability,
): { fillable: boolean; unfillable: readonly string[] } {
  const declarations = new Map(payload.parameters.map((parameter) => [parameter.name, parameter]))
  const referenced = new Set<string>()

  for (const step of payload.steps) {
    for (const slot of Object.values(step.action.values)) {
      if (typeof slot === 'object' && slot !== null && 'param' in slot) {
        referenced.add(slot.param)
      }
    }
  }

  const sources = {
    variables: bindingsByName(availability.variables),
    memory: bindingsByName(availability.memory),
    secrets: new Set(availability.secrets),
  }
  const unfillable = [...referenced]
    .filter((name) => {
      const declaration = declarations.get(name)
      return declaration === undefined || !isParameterAvailable(declaration, sources)
    })
    .sort()

  return { fillable: unfillable.length === 0, unfillable }
}
