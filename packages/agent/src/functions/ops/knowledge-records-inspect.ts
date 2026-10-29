// Wiring only: which records match is decided behind the port, never here.

import { KnowledgeRecordsInspectInputSchema, KnowledgeRecordsInspectOutputSchema } from '@vostride/agent-qa-schema'
import type {
  InspectRecordView,
  KnowledgeRecordsInspectInput,
  KnowledgeRecordsInspectOutput,
} from '@vostride/agent-qa-schema'

import type { ClauseVerdict, FunctionSpec } from '../spec.js'

export const KNOWLEDGE_RECORDS_INSPECT_FUNCTION_ID = 'knowledge.records.inspect'

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

// A record id is unique only within a product, so the pair is the sort key.
function byRecordThenProduct(left: InspectRecordView, right: InspectRecordView): number {
  return compareText(left.recordId, right.recordId)
    || compareText(left.product, right.product)
}

export const knowledgeRecordsInspectSpec: FunctionSpec<
  KnowledgeRecordsInspectInput,
  KnowledgeRecordsInspectOutput
> = {
  id: KNOWLEDGE_RECORDS_INSPECT_FUNCTION_ID,
  summary: 'Inspect committed knowledge records through a closed structural filter.',
  resultKind: 'unary',
  input: KnowledgeRecordsInspectInputSchema,
  output: KnowledgeRecordsInspectOutputSchema,
  risk: { name: `fn:${KNOWLEDGE_RECORDS_INSPECT_FUNCTION_ID}`, recognized: true, readOnly: true },
  // The count only, no record content.
  classify(output): ClauseVerdict {
    return { status: 'executed', outcome: `${output.records.length} record(s) inspected` }
  },
  async invoke(input, deps) {
    // The filter crosses UNCHANGED. Narrowing or defaulting it here would be a second query
    // planner sitting above the one that already exists, and the two would answer differently
    // the first time either changed.
    const records = await deps.knowledge.inspectRecords(input)
    return {
      schemaVersion: 2,
      records: [...records].sort(byRecordThenProduct),
    }
  },
}
