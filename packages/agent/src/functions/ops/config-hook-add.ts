// `config.hook.add` — the closed typed action class's fifth member (Phase 395-05, D-01/D-02 ·
// CFGM-01).
//
// THIS OP WRITES IN THE CALL. It is constructed, scanned and validated
// as described below and then published through the direct writer; the answer names the files and
// fields it changed, a blocked change is answered with its report and nothing is kept, and no git
// runs. Where the paragraphs below say "proposal", read the change this call writes.
//
// `config-field-set.ts`'s header carries the arguments for the tier and the one-op-per-action
// shape; they are not restated. Two things are different about this one.
//
// NO SCOPE. This op once declared `config-write`. Every door can call
// every operation now; what guards the write is the construction, scan and whole-set validation
// below, not who asked.
//
// IT IS THE ONLY ACTION THAT WRITES A FILE OTHER THAN THE CONFIG YAML. The hooks file is the second
// member of the pinned config set, and it has its own schema — `core`'s `HooksFileSchema`, with the
// canonical-id rule and the duplicate-id and duplicate-name refinements. That is why 395-05 widened
// whole-config validation to the whole candidate SET: a validator that only ever read the config
// yaml would have declared this proposal valid without looking at the one artifact it wrote, which
// is D-03's whole-input law satisfied on paper and violated in fact.
//
// EVERY HOOK ADDITION IS CROSS-BOUNDARY, UNCONDITIONALLY. A hook is code this project will
// EXECUTE, and that is a different kind of change from a setting. The fact is STATED by the
// construction rather than inferred from the path it wrote, because inferring "a hook was added"
// from a path is the per-op map D-02 refused. (2026-10-01, 432-25, D-12: the standing-approval and
// grant machinery that once refused on this flag is deleted; the flag stays on the change report.)
//
// THE INPUT NAMES A FILE AND NEVER CARRIES A BODY. The script is a thing a person writes and reviews
// in their editor; a proposal that carried executable text would be asking for approval of two
// artifacts in one decision. The hook's ID is minted host-side through the same machinery
// `isCanonicalHookId` accepts, because a hand-formatted id would parse as a string, reach a person's
// repository, and be refused at the next run rather than at the proposal.

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
  /**
   * This op's own union, folded into a clause verdict.
   *
   * THE FOLD IS SHARED BECAUSE THE UNION IS. Six ops answer with `ConfigChangeOutput`, and a
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
      throw new FunctionNotBoundError(CONFIG_HOOK_ADD_FUNCTION_ID)
    }
    return await addConfigHook(
      { action: CONFIG_HOOK_ADD_FUNCTION_ID, ...input },
      { configFiles, configValidate, configWrite },
    )
  },
}
