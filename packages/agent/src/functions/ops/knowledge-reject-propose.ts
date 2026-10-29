// The reason is required, because the `Deprecate` delta it becomes requires one.

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
  // The fold every knowledge change op shares.
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
