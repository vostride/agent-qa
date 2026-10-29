// A missing record is an answer arm; only a store that cannot be read throws.

import { KnowledgeRecordShowInputSchema, KnowledgeRecordShowResultSchema } from '@vostride/agent-qa-schema'
import type {
  KnowledgeRecordShowInput,
  KnowledgeRecordShowResult,
} from '@vostride/agent-qa-schema'

import type { ClauseVerdict, FunctionSpec } from '../spec.js'

export const KNOWLEDGE_RECORD_SHOW_FUNCTION_ID = 'knowledge.record.show'

export const knowledgeRecordShowSpec: FunctionSpec<
  KnowledgeRecordShowInput,
  KnowledgeRecordShowResult
> = {
  id: KNOWLEDGE_RECORD_SHOW_FUNCTION_ID,
  summary: 'Show one committed knowledge record with its provenance.',
  resultKind: 'unary',
  input: KnowledgeRecordShowInputSchema,
  output: KnowledgeRecordShowResultSchema,
  risk: { name: `fn:${KNOWLEDGE_RECORD_SHOW_FUNCTION_ID}`, recognized: true, readOnly: true },
  // Absence is a result, not a refusal.
  classify(output): ClauseVerdict {
    switch (output.kind) {
      case 'found':
        return { status: 'executed', outcome: 'found — the record with its provenance' }
      case 'not-found':
        return { status: 'executed', outcome: `not-found: ${output.recordId}` }
      default:
        return output satisfies never
    }
  },
  invoke(input, deps) {
    // The id crosses verbatim: the reader matches enumerated records, never joins a path.
    return deps.knowledge.showRecord(input)
  },
}
