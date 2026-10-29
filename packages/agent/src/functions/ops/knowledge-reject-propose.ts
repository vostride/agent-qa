// `knowledge.reject` — deprecate a candidate the caller does not stand behind.
//
// the change APPLIES IN THE CALL. The op validates its input,
// hands the review port one direct change and answers what the explicit writer changed. Nothing is
// proposed and nothing waits for a second call; the retired `knowledge.reject.propose` id has no
// alias. This file keeps its name until the later rename audit, so its consumers move first.
//
// `readOnly: false`, at the recognized-mutating floor: an explicit change to this machine's
// knowledge runs in every execution context. 2026-10-01: it declares
// no `knowledge-write` scope any more; every door can call it. It binds through the OPTIONAL
// `knowledgeReview` dep, so a host with no review port lists it `unbound` BY NAME.
//
// The reason is REQUIRED by the input contract because the `Deprecate` delta this becomes
// requires one: a verb that admitted an empty reason would be inventing a justification for a
// decision somebody made.

import {
  KnowledgeRejectChangeInputSchema,
  KnowledgeChangeOutputSchema,
} from '@vostride/agent-qa-schema'
import type {
  KnowledgeRejectChangeInput,
  KnowledgeChangeOutput,
} from '@vostride/agent-qa-schema'

import type { FunctionSpec } from '../spec.js'
import { classifyKnowledgeChangeOutput } from './knowledge-change-verdict.js'
import { KNOWLEDGE_REJECT_FUNCTION_ID } from './knowledge-review-ids.js'

export { KNOWLEDGE_REJECT_FUNCTION_ID } from './knowledge-review-ids.js'

export const knowledgeRejectSpec: FunctionSpec<KnowledgeRejectChangeInput, KnowledgeChangeOutput> = {
  id: KNOWLEDGE_REJECT_FUNCTION_ID,
  summary: 'Reject a knowledge candidate with a reason, applying the change in the call.',
  resultKind: 'unary',
  input: KnowledgeRejectChangeInputSchema,
  output: KnowledgeChangeOutputSchema,
  boundThrough: 'knowledgeReview',
  risk: { name: `fn:${KNOWLEDGE_REJECT_FUNCTION_ID}`, recognized: true, readOnly: false },
  // The fold the three knowledge changes share (2026-10-03, quick 261003-cpv, 432 review IN-04).
  classify: classifyKnowledgeChangeOutput,
  invoke({ operationId, ...input }, deps) {
    // Non-null: `boundThrough` makes an absent review port an `unbound` listing and a binding
    // refusal in `invokeFunction`, so dispatch is only reached in a composition that supplied one. The identity is
    // lifted off the input because it names the change, not the verb: the verb input below is
    // exactly what the explicit writer validates.
    return deps.knowledgeReview!.change({
      verb: 'reject',
      input,
      ...(operationId === undefined ? {} : { operationId }),
    })
  },
}
