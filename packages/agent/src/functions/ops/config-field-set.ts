// One op per action and no field whitelist; whole-config validation guards every write.

import { ConfigChangeOutputSchema, ConfigFieldSetInputSchema } from '@vostride/agent-qa-schema'
import type { ConfigChangeOutput, ConfigFieldSetInput } from '@vostride/agent-qa-schema'

import { classifyConfigChangeOutput } from './config-propose-verdict.js'
import { changeConfigField } from '../../config-mutation/construct.js'
import { FunctionNotBoundError } from '../spec.js'
import type { FunctionSpec } from '../spec.js'

export const CONFIG_FIELD_SET_FUNCTION_ID = 'config.field.set'

export const configFieldSetSpec: FunctionSpec<ConfigFieldSetInput, ConfigChangeOutput> = {
  id: CONFIG_FIELD_SET_FUNCTION_ID,
  summary: 'Set one configuration field, written in this call.',
  resultKind: 'unary',
  input: ConfigFieldSetInputSchema,
  output: ConfigChangeOutputSchema,
  boundThrough: 'configWrite',
  risk: {
    name: `fn:${CONFIG_FIELD_SET_FUNCTION_ID}`,
    recognized: true,
    readOnly: false,
  },
  // Shared, so every door reports a guardrail refusal alike; see `config-propose-verdict.ts`.
  classify: classifyConfigChangeOutput,
  async invoke(input, deps): Promise<ConfigChangeOutput> {
    // Every dep is checked by name, so an in-layer caller gets the pipeline's refusal.
    const { configFiles, configValidate, configWrite } = deps
    if (
      configFiles === undefined
      || configValidate === undefined
      || configWrite === undefined
    ) {
      throw new FunctionNotBoundError(CONFIG_FIELD_SET_FUNCTION_ID)
    }
    return await changeConfigField(
      { action: CONFIG_FIELD_SET_FUNCTION_ID, path: input.path, value: input.value },
      { configFiles, configValidate, configWrite },
    )
  },
}
