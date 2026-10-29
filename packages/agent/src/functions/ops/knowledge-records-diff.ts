// Projects, echoes the baseline and sorts; the change vocabulary lives behind the port.

import { KnowledgeRecordsDiffInputSchema, KnowledgeRecordsDiffOutputSchema } from '@vostride/agent-qa-schema'
import type {
  KnowledgeRecordsDiffInput,
  KnowledgeRecordsDiffOutput,
  RecordChange,
} from '@vostride/agent-qa-schema'

import type { ClauseVerdict, FunctionSpec } from '../spec.js'

export const KNOWLEDGE_RECORDS_DIFF_FUNCTION_ID = 'knowledge.records.diff'

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

// Total down to the evidence token, so two identical questions never reshuffle the diff.
function byChangeIdentity(left: RecordChange, right: RecordChange): number {
  return compareText(left.recordId, right.recordId)
    || left.atOrdinal - right.atOrdinal
    || compareText(left.change, right.change)
    || compareText(left.evidenceToken ?? '', right.evidenceToken ?? '')
    || compareText(left.byRecordId ?? '', right.byRecordId ?? '')
}

export const knowledgeRecordsDiffSpec: FunctionSpec<
  KnowledgeRecordsDiffInput,
  KnowledgeRecordsDiffOutput
> = {
  id: KNOWLEDGE_RECORDS_DIFF_FUNCTION_ID,
  summary: 'List every committed knowledge record change since a build ordinal.',
  resultKind: 'unary',
  input: KnowledgeRecordsDiffInputSchema,
  output: KnowledgeRecordsDiffOutputSchema,
  risk: { name: `fn:${KNOWLEDGE_RECORDS_DIFF_FUNCTION_ID}`, recognized: true, readOnly: true },
  // The ordinal rides the outcome, because a change list without its baseline loses its meaning.
  classify(output): ClauseVerdict {
    return {
      status: 'executed',
      outcome: `${output.changes.length} change(s) since ordinal ${output.sinceOrdinal}`,
    }
  },
  async invoke(input, deps) {
    const changes = await deps.knowledge.diffSince(input)
    return {
      schemaVersion: 2,
      // Echoed, not remembered: a change list with no baseline means nothing to a reader who
      // has the answer and not the question, and these answers get pasted into issues and CI
      // logs where the question is gone.
      sinceOrdinal: input.sinceOrdinal,
      changes: [...changes].sort(byChangeIdentity),
    }
  },
}
