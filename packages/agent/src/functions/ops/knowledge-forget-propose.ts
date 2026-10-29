// Tombstoned, never destroyed; binds through optional `knowledgeReview`.

import {
  KnowledgeForgetChangeInputSchema,
  KnowledgeChangeOutputSchema,
} from '@vostride/agent-qa-schema'
import type {
  KnowledgeForgetChangeInput,
  KnowledgeChangeOutput,
} from '@vostride/agent-qa-schema'

import type { FunctionSpec } from '../spec.js'
import { classifyKnowledgeChangeOutput } from './knowledge-change-verdict.js'
import { KNOWLEDGE_FORGET_FUNCTION_ID } from './knowledge-review-ids.js'

export { KNOWLEDGE_FORGET_FUNCTION_ID } from './knowledge-review-ids.js'

export const knowledgeForgetSpec: FunctionSpec<KnowledgeForgetChangeInput, KnowledgeChangeOutput> = {
  id: KNOWLEDGE_FORGET_FUNCTION_ID,
  summary: 'Forget a knowledge record or bundle, tombstoning it in the call.',
  resultKind: 'unary',
  input: KnowledgeForgetChangeInputSchema,
  output: KnowledgeChangeOutputSchema,
  boundThrough: 'knowledgeReview',
  risk: { name: `fn:${KNOWLEDGE_FORGET_FUNCTION_ID}`, recognized: true, readOnly: false },
  // The fold every knowledge change op shares.
  classify: classifyKnowledgeChangeOutput,
  invoke({ operationId, ...input }, deps) {
    // Non-null: `boundThrough` makes an absent review port an `unbound` listing and a refusal at
    // `invokeFunction`'s binding check, so dispatch is only reached in a composition that supplied
    // one. The identity is
    // lifted off the input because it names the change, not the verb: the verb input below is
    // exactly what the explicit writer validates.
    return deps.knowledgeReview!.change({
      verb: 'forget',
      input,
      ...(operationId === undefined ? {} : { operationId }),
    })
  },
}
