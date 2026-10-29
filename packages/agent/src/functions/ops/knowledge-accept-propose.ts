// `knowledge.accept` — promote a candidate the caller stands behind.
//
// the change APPLIES IN THE CALL. The op validates its input,
// hands the review port one direct change and answers what the explicit writer changed: the
// records it read back, and the commit receipt when a promotion gate was crossed. Nothing is
// proposed and nothing waits for a second call; the retired `knowledge.accept.propose` id has no
// alias. This file keeps its name until the later rename audit, so its consumers move first.
//
// `readOnly: false`, at the recognized-mutating floor: an explicit change to this machine's
// knowledge runs in every execution context, and the writer behind the port keeps the
// lease, delta validation, bundle egress and every promotion gate. 2026-10-01: it
// declares no `knowledge-write` scope any more; every door can call it. It binds through the
// OPTIONAL `knowledgeReview` dep and never `deps.knowledge`: the reader port is physically
// write-free, and a host that supplies no review port lists this verb `unbound` BY NAME.

import {
  KnowledgeAcceptChangeInputSchema,
  KnowledgeChangeOutputSchema,
} from '@vostride/agent-qa-schema'
import type {
  KnowledgeAcceptChangeInput,
  KnowledgeChangeOutput,
} from '@vostride/agent-qa-schema'

import type { FunctionSpec } from '../spec.js'
import { classifyKnowledgeChangeOutput } from './knowledge-change-verdict.js'
import { KNOWLEDGE_ACCEPT_FUNCTION_ID } from './knowledge-review-ids.js'

export { KNOWLEDGE_ACCEPT_FUNCTION_ID } from './knowledge-review-ids.js'

export const knowledgeAcceptSpec: FunctionSpec<KnowledgeAcceptChangeInput, KnowledgeChangeOutput> = {
  id: KNOWLEDGE_ACCEPT_FUNCTION_ID,
  summary: 'Accept a knowledge candidate, applying the change in the call.',
  resultKind: 'unary',
  input: KnowledgeAcceptChangeInputSchema,
  output: KnowledgeChangeOutputSchema,
  boundThrough: 'knowledgeReview',
  risk: { name: `fn:${KNOWLEDGE_ACCEPT_FUNCTION_ID}`, recognized: true, readOnly: false },
  // The fold the three knowledge changes share (2026-10-03, quick 261003-cpv, 432 review IN-04).
  classify: classifyKnowledgeChangeOutput,
  invoke({ operationId, ...input }, deps) {
    // Non-null: `boundThrough` makes an absent review port an `unbound` listing and a binding
    // refusal in `invokeFunction`, so dispatch is only reached in a composition that supplied one. The identity is
    // lifted off the input because it names the change, not the verb: the verb input below is
    // exactly what the explicit writer validates.
    return deps.knowledgeReview!.change({
      verb: 'accept',
      input,
      ...(operationId === undefined ? {} : { operationId }),
    })
  },
}
