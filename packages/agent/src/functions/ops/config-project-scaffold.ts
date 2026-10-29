// The model fills only `domain`; a token that is not a hostname is refused, never guessed.

import { ConfigChangeOutputSchema, ConfigProjectScaffoldInputSchema } from '@vostride/agent-qa-schema'
import type { ConfigChangeOutput, ConfigProjectScaffoldInput } from '@vostride/agent-qa-schema'

import { classifyConfigChangeOutput } from './config-propose-verdict.js'
import { scaffoldConfigProject } from '../../config-mutation/construct.js'
import { FunctionNotBoundError } from '../spec.js'
import type { FunctionSpec } from '../spec.js'

export const CONFIG_PROJECT_SCAFFOLD_FUNCTION_ID = 'config.project.scaffold'

export const configProjectScaffoldSpec: FunctionSpec<
  ConfigProjectScaffoldInput,
  ConfigChangeOutput
> = {
  id: CONFIG_PROJECT_SCAFFOLD_FUNCTION_ID,
  summary:
    'Configure this project for a site from zero — config, hooks and gitignore, written in this '
    + 'call.',
  resultKind: 'unary',
  input: ConfigProjectScaffoldInputSchema,
  output: ConfigChangeOutputSchema,
  boundThrough: 'scaffoldContent',
  risk: {
    name: `fn:${CONFIG_PROJECT_SCAFFOLD_FUNCTION_ID}`,
    recognized: true,
    readOnly: false,
  },
  // Shared, so every door reports a guardrail refusal alike; see `config-propose-verdict.ts`.
  classify: classifyConfigChangeOutput,
  async invoke(input, deps): Promise<ConfigChangeOutput> {
    // `scaffoldContent` is the dep that makes this op, specifically, unavailable on a host.
    const { configFiles, configValidate, configWrite, scaffoldContent } = deps
    if (
      configFiles === undefined
      || configValidate === undefined
      || configWrite === undefined
      || scaffoldContent === undefined
    ) {
      throw new FunctionNotBoundError(CONFIG_PROJECT_SCAFFOLD_FUNCTION_ID)
    }
    return await scaffoldConfigProject(
      { action: CONFIG_PROJECT_SCAFFOLD_FUNCTION_ID, domain: input.domain },
      { configFiles, configValidate, configWrite, scaffoldContent },
    )
  },
}
