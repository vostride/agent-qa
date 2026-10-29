// A create is never an upsert: `setIn` replaces, so a name collision is refused by name.

import { ConfigChangeOutputSchema, ConfigTargetCreateInputSchema } from '@vostride/agent-qa-schema'
import type { ConfigChangeOutput, ConfigTargetCreateInput } from '@vostride/agent-qa-schema'

import { classifyConfigChangeOutput } from './config-propose-verdict.js'
import { createConfigTarget } from '../../config-mutation/construct.js'
import { FunctionNotBoundError } from '../spec.js'
import type { FunctionSpec } from '../spec.js'

export const CONFIG_TARGET_CREATE_FUNCTION_ID = 'config.target.create'

export const configTargetCreateSpec: FunctionSpec<ConfigTargetCreateInput, ConfigChangeOutput> = {
  id: CONFIG_TARGET_CREATE_FUNCTION_ID,
  summary: 'Add a web target to the registry, written in this call.',
  resultKind: 'unary',
  input: ConfigTargetCreateInputSchema,
  output: ConfigChangeOutputSchema,
  boundThrough: 'configWrite',
  risk: {
    name: `fn:${CONFIG_TARGET_CREATE_FUNCTION_ID}`,
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
      throw new FunctionNotBoundError(CONFIG_TARGET_CREATE_FUNCTION_ID)
    }
    return await createConfigTarget(
      { action: CONFIG_TARGET_CREATE_FUNCTION_ID, ...input },
      { configFiles, configValidate, configWrite },
    )
  },
}
