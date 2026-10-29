// Binds through optional `knowledgeReview`, never the write-free reader port.

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
  // The fold every knowledge change op shares.
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
