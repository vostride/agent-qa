// `config.auth.set` — refs only, ratified as law.
//
// THIS OP WRITES IN THE CALL. It is constructed, scanned and validated
// as described below and then published through the direct writer; the answer names the files and
// fields it changed, a blocked change is answered with its report and nothing is kept, and no git
// runs. Where the paragraphs below say "proposal", read the change this call writes.
//
// `config-field-set.ts`'s header carries the arguments for the tier and the one-op-per-action
// shape; they are not restated. What is different about this one is the law it enforces and where
// it enforces it. 2026-10-01: this op once declared `config-write`, and that header
// once argued for the scope. It declares no scope now, because no caller is checked for one; the
// reference law below, the scan and whole-config validation guard the write, and nothing about the
// masking or the refusal of a literal credential changed with the scope.
//
// A LITERAL CREDENTIAL ARRIVING IN THE INPUT IS ITSELF THE FAILURE. D-11 ratified this action as
// writing REFERENCES — the name of a plugin package, the name of an environment variable — and
// never a value. 2026-10-02: it also named an auth state, written to
// `use.authState`; the committed configuration has no such key, so that field is deleted (see
// `setConfigAuth`). 395-02 enforced the first half in the SHAPE of
// `ConfigAuthSetInputSchema`: there is no field a credential could be assigned to, which is a
// property of the type rather than a rule anybody remembers. This op enforces the second half, on
// the INPUT and before a single byte is mutated, because a law about what the configuration may hold
// is enforced too late if it is only enforced on the rendered artifact — by then the credential has
// been through a serialiser, a differ and a digest, and the honest disposition for the proposal that
// carries one is a refusal rather than a filed record somebody has to go and delete.
//
// THE REFUSAL IS ANSWERED, NOT FILED, AND THAT IS THIS OP'S EDGE OVER ITS FOUR SIBLINGS. A secret in
// a `config.field.set` value is a BLOCKED RECORD: any config path may legitimately hold any value,
// so the fact worth persisting is "somebody tried to write a secret into your configuration". A
// secret in an auth REFERENCE is a different fact — the caller filled a field with the wrong KIND of
// thing — and there is no candidate configuration to file because none was ever built. The store
// delta across a refused call is zero, and a cell measures it.
//
// TWO GATES, AND ONLY ONE OF THEM NAMES ANYTHING. The detector engine recognises credential families
// it knows and values the masker has been seeded with; `isLegalConfigReference` states positively
// what an auth-state name, a package name and an environment variable name ARE and refuses the
// complement. The second is the structural one — a rule that names nothing it refuses cannot be
// walked past by inventing a credential family nobody listed — and the residue where both miss is
// recorded as a KNOWN BOUND cell rather than described as closed.

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
    // The D-11 input check is the reference shape rule, which needs no port.
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
