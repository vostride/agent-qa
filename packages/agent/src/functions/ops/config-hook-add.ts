// Every hook addition is cross-boundary, and the input names a script file, never a body.

import { ConfigChangeOutputSchema, ConfigHookAddInputSchema } from '@vostride/agent-qa-schema'
import type { ConfigChangeOutput, ConfigHookAddInput } from '@vostride/agent-qa-schema'

import { classifyConfigChangeOutput } from './config-propose-verdict.js'
import { addConfigHook } from '../../config-mutation/construct.js'
import { FunctionNotBoundError } from '../spec.js'
import type { FunctionSpec } from '../spec.js'

export const CONFIG_HOOK_ADD_FUNCTION_ID = 'config.hook.add'

export const configHookAddSpec: FunctionSpec<ConfigHookAddInput, ConfigChangeOutput> = {
  id: CONFIG_HOOK_ADD_FUNCTION_ID,
  summary: 'Declare a hook in the hooks file, written in this call.',
  resultKind: 'unary',
  input: ConfigHookAddInputSchema,
  output: ConfigChangeOutputSchema,
  boundThrough: 'configWrite',
  risk: {
    name: `fn:${CONFIG_HOOK_ADD_FUNCTION_ID}`,
    recognized: true,
    readOnly: false,
  },
  // Shared, so every door reports a guardrail refusal alike; see `config-propose-verdict.ts`.
  classify: classifyConfigChangeOutput,
  async invoke(input, deps): Promise<ConfigChangeOutput> {
    // The same three-way guard its siblings carry: the files, the validator and the direct writer.
    const { configFiles, configValidate, configWrite } = deps
    if (
      configFiles === undefined
      || configValidate === undefined
      || configWrite === undefined
    ) {
      throw new FunctionNotBoundError(CONFIG_HOOK_ADD_FUNCTION_ID)
    }
    return await addConfigHook(
      { action: CONFIG_HOOK_ADD_FUNCTION_ID, ...input },
      { configFiles, configValidate, configWrite },
    )
  },
}
