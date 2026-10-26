// `config.project.scaffold` — the from-zero configuration, written as ONE change in the call
// (Phase 395-08, D-04 / D-13 / D-14 / D-15 · CFGM-05; 2026-10-02, 432-42: re-spelled from the
// proposal it used to file).
//
// 2026-09-30, 432-11 D-05/D-07: THIS OP WRITES IN THE CALL. It is constructed, scanned and validated
// as described below and then published through the direct writer; the answer names the files and
// fields it changed, a blocked change is answered with its report and nothing is kept, and no git
// runs. Where the paragraphs below say "proposal", read the change this call writes.
//
// THE EIGHTH REGISTERED CONFIG OP, ON D-01's FOOTING. One op per action: the planner picks it by
// tool name, 396's projection publishes it and 397's parity walk enumerates it, all with no harness
// change. `config.project.scaffold` — three lowercase dot segments, no underscore, so the chat
// tool-name mapping (`.` ↔ `_`) has one pre-image and `parity-coverage`'s id pattern accepts it.
//
// THE MODEL FILLS ONE FIELD AND DERIVES NOTHING (D-13). `ConfigProjectScaffoldInputSchema` is a
// strict `{ domain }`, and every field it does not have is a field a model could otherwise invent.
// The scheme, the target name, the platform, the whole file set: all of it comes from
// `parseHostnameToken` and the shared content module, which is what makes the proposal a person
// approves a deterministic function of bytes they typed.
//
// THE NEVER-GUESS BOUNDARY IS A REFUSAL, NOT A FALLBACK (D-15). A token that does not parse as a
// hostname does not become a search, a completion or a best guess — it becomes a typed `refused`
// naming both continuations. `booking.com` against `booking.de` is a coin flip review should not
// have to catch, so the product declines to flip it.
//
// A scaffold is always cross-boundary, and the change report says so.
//
// NO SCOPE (2026-10-01, 432-25, D-12). This op once declared `config-write`, and 395-07's two-sided
// grant enforcement made a scaffold unsatisfiable by any standing grant. Both are deleted: every
// door can call every operation, and what guards the write is the construction, the whole-new-file
// scan and the whole-set validation below.

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
    // FOUR DEPS, ONE `boundThrough`, on the arrangement the deleted `config.undo.propose` used
    // (432-17) — with the declared name being this op's OWN one: the files, the validator, the
    // direct writer and `scaffoldContent`, which is what a host that cannot render the shared
    // scaffold substance lacks and the fact that makes this op specifically unavailable.
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
