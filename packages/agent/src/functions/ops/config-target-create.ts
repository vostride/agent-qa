// `config.target.create` — the closed typed action class's second member (Phase 395-05, D-01/D-02 ·
// CFGM-01).
//
// 2026-09-30, 432-11 D-05/D-07: THIS OP WRITES IN THE CALL. It is constructed, scanned and validated
// as described below and then published through the direct writer; the answer names the files and
// fields it changed, a blocked change is answered with its report and nothing is kept, and no git
// runs. Where the paragraphs below say "proposal", read the change this call writes.
//
// EVERY PARAGRAPH `config-field-set.ts` OPENS WITH APPLIES HERE VERBATIM and is not restated: one
// registered op per action. Read that file for the arguments; what follows is what is different
// about this one. This op once declared `config-write` because the scope described what the
// capability is about. It declares no scope now, because no caller is checked for one; the
// construction, the scan and whole-config validation below guard the write.
//
// A CREATE IS NEVER AN UPSERT, AND THAT IS THIS OP'S WHOLE EDGE. The yaml `setIn` that backs every
// mutation in this phase REPLACES whatever is at the path it is given, so the natural implementation
// of "add a target" quietly deletes the `product`, `appPackage` and `environment` a target of that
// name already carried, and renders it as a diff a person would have to read line by line to notice.
// The pipeline refuses the collision by name and points at `config.target.edit`, which is the op
// that exists for changing one.
//
// IT DOES NOT ADDRESS THE TARGET NAME AS A SETTABLE PATH, and that is not a whitelist. D-03's
// no-whitelist law is about which config paths a person may set — `config.field.set` still answers
// any of them. This op exists because "add a web target" is a shape the model can fill correctly
// from an utterance and a raw dotted-path set is not: `platform` and `url` together are what makes a
// target valid, and a shape that carries both is what stops half a target from being proposed.

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
  /**
   * This op's own union, folded into a clause verdict (2026-08-20, Phase 399.1 D-01/D-02).
   *
   * THE FOLD IS SHARED BECAUSE THE UNION IS. Six ops answer with `ConfigChangeOutput` (432-11), and a
   * per-op copy of the mapping would be a guardrail refusal that reports `refused` on some doors
   * and `executed` on others the first time one copy is edited. See `config-propose-verdict.ts`
   * for why `blocked` and `refused` are the same status and different words.
   */
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
