// A pass-through: masking happens at resolution, so no unmasked config exists in the layer.

import { ConfigGetInputSchema, MaskedResolvedConfigSchema } from '@vostride/agent-qa-schema'
import type { ConfigGetInput, MaskedResolvedConfig } from '@vostride/agent-qa-schema'

import type { ClauseVerdict, FunctionSpec } from '../spec.js'

export const CONFIG_GET_FUNCTION_ID = 'config.get'

export const configGetSpec: FunctionSpec<ConfigGetInput, MaskedResolvedConfig> = {
  id: CONFIG_GET_FUNCTION_ID,
  summary: 'Read the resolved project configuration with secret-bearing values masked.',
  resultKind: 'unary',
  input: ConfigGetInputSchema,
  output: MaskedResolvedConfigSchema,
  risk: { name: `fn:${CONFIG_GET_FUNCTION_ID}`, recognized: true, readOnly: true },
  // Counts only, never an entry's value; the masked payload travels on `results[]`.
  classify(output): ClauseVerdict {
    const count = output.entries.length
    return {
      status: 'executed',
      outcome: `resolved config — ${count} entr${count === 1 ? 'y' : 'ies'}`,
    }
  },
  invoke(_input, deps) {
    return deps.config.getMasked()
  },
}
