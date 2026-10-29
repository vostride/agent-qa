// `config.get` — the masked resolved-configuration read.
//
// The op is a pass-through by design. Masking happens where the configuration is RESOLVED,
// inside the composition root, while each entry is constructed. If this op masked instead,
// an unmasked config would exist inside the layer and the security property would depend on
// this function never being bypassed — exactly the guarantee the layer refuses to rest on.

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
  /**
   * A read that answered — the count of what it resolved, and nothing out of it.
   *
   * NOT ONE ENTRY'S VALUE, ever. This op's result carries a person's configuration, placeholder-
   * masked; the receipt is a map and the masked payload travels on `results[]` where the surface's
   * own unmasker decides what a human may see (D-04's boundary, not this fold's).
   */
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
