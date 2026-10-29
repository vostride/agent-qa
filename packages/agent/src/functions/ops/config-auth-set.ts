// A literal credential in the input is refused before any byte is mutated; only references pass.

import { ConfigChangeOutputSchema, ConfigAuthSetInputSchema } from '@vostride/agent-qa-schema'
import type { ConfigChangeOutput, ConfigAuthSetInput } from '@vostride/agent-qa-schema'

import { classifyConfigChangeOutput } from './config-propose-verdict.js'
import { setConfigAuth } from '../../config-mutation/construct.js'
import { FunctionNotBoundError } from '../spec.js'
import type { FunctionSpec } from '../spec.js'

export const CONFIG_AUTH_SET_FUNCTION_ID = 'config.auth.set'

export const configAuthSetSpec: FunctionSpec<ConfigAuthSetInput, ConfigChangeOutput> = {
  id: CONFIG_AUTH_SET_FUNCTION_ID,
  summary: 'Declare an auth plugin for a configured target by package NAME, written in this call.',
  resultKind: 'unary',
  input: ConfigAuthSetInputSchema,
  output: ConfigChangeOutputSchema,
  boundThrough: 'configWrite',
  risk: {
    name: `fn:${CONFIG_AUTH_SET_FUNCTION_ID}`,
    recognized: true,
    readOnly: false,
  },
  // Shared, so every door reports a guardrail refusal alike; see `config-propose-verdict.ts`.
  classify: classifyConfigChangeOutput,
  async invoke(input, deps): Promise<ConfigChangeOutput> {
    // The same files, validator and writer guard as its siblings; the reference rule needs no port.
    const { configFiles, configValidate, configWrite } = deps
    if (
      configFiles === undefined
      || configValidate === undefined
      || configWrite === undefined
    ) {
      throw new FunctionNotBoundError(CONFIG_AUTH_SET_FUNCTION_ID)
    }
    return await setConfigAuth(
      { action: CONFIG_AUTH_SET_FUNCTION_ID, ...input },
      { configFiles, configValidate, configWrite },
    )
  },
}
