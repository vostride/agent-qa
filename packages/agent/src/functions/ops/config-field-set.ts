// `config.field.set` — the first of the closed typed action class.
//
// ONE REGISTERED OP PER ACTION. The closed action class is legible in the registry itself,
// the planner picks actions by tool name, and 396's MCP projection and 397's parity walk pick this
// up with no harness change. A union op carrying a mode string would have projected as one tool
// whose real vocabulary lives inside a string field nothing validates.
//
// IT WRITES IN THE CALL AND COMMITS NOTHING. The change is
// constructed, scanned and validated exactly as before, and then published through the direct
// writer rather than filed as a proposal: the answer names the files and fields it changed. A
// blocked change is answered with its report and nothing is kept. No git runs; the change is a
// plain edit a person sees in `git diff` and reverts with `git restore`.
//
// NO SCOPE. This op once declared `config-write`, so 396's safe-mode
// filter could hide it and a caller holding only `read` could not reach it. Every door can call
// every operation now; what guards a config write is the construction, scan and whole-config
// validation below, not who asked.
//
// ANY SCHEMA-ADDRESSABLE PATH. There is no settable-field whitelist, and the absence is the
// decision: a rule that can only refuse what it can NAME cannot be driven to zero by naming more
// things. The guards are whole-input by construction — post-mutation validation of the ENTIRE
// config in the pipeline, and D-02's per-value classifier when 395-04 lands it.

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
  /**
   * This op's own union, folded into a clause verdict.
   *
   * THE MAPPING MOVED TO `config-propose-verdict.ts` IN 399.1-03, unchanged, when the other six ops
   * answering with this same union got classifiers of their own. It was written here first because
   * this op was the tracer; leaving a private copy behind would have made a guardrail refusal report
   * `refused` on this door and `executed` on the next one the first time somebody edited one copy.
   * The arms, and the reasoning for which of them is `refused`, are documented at the fold.
   */
  classify: classifyConfigChangeOutput,
  async invoke(input, deps): Promise<ConfigChangeOutput> {
    // THREE DEPS, ONE `boundThrough`: the files, the validator and the direct writer. The
    // declared name is the writer; all three are checked here, by name, so an in-layer caller
    // holding the spec gets the same refusal a pipeline caller would. No scan.
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
