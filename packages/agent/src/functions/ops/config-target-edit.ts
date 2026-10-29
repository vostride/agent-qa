// An absent target is refused with the configured names, so a typo never creates a target.

import { ConfigChangeOutputSchema, ConfigTargetEditInputSchema } from '@vostride/agent-qa-schema'
import type { ConfigChangeOutput, ConfigTargetEditInput } from '@vostride/agent-qa-schema'

import { classifyConfigChangeOutput } from './config-propose-verdict.js'
import { editConfigTarget } from '../../config-mutation/construct.js'
import { FunctionNotBoundError } from '../spec.js'
import type { FunctionSpec } from '../spec.js'

export const CONFIG_TARGET_EDIT_FUNCTION_ID = 'config.target.edit'

export const configTargetEditSpec: FunctionSpec<ConfigTargetEditInput, ConfigChangeOutput> = {
  id: CONFIG_TARGET_EDIT_FUNCTION_ID,
  summary: 'Change a configured target\'s URL, written in this call.',
  resultKind: 'unary',
  input: ConfigTargetEditInputSchema,
  output: ConfigChangeOutputSchema,
  boundThrough: 'configWrite',
  risk: {
    name: `fn:${CONFIG_TARGET_EDIT_FUNCTION_ID}`,
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
      throw new FunctionNotBoundError(CONFIG_TARGET_EDIT_FUNCTION_ID)
    }
    return await editConfigTarget(
      { action: CONFIG_TARGET_EDIT_FUNCTION_ID, ...input },
      { configFiles, configValidate, configWrite },
    )
  },
}
