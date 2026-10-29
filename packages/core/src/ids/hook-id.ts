import { generateHookId as generateSharedHookId } from '@vostride/agent-qa-ids'

// re-exported on `generateRunId`'s footing, one file over. The mint and the schema that
// REFUSES anything it did not produce (`HookDefinitionSchema` → `isCanonicalHookId`) then live
// behind one package boundary, so a caller that can validate a hook can also make one — and
// `packages/cli`'s ownership contract, which 394-11 deliberately emptied of the ids package with a
// recorded reason, does not have to be reopened to let a host mint an id it cannot hand-format.
export function generateHookId(): string {
  return generateSharedHookId()
}
