// `knowledge.records.inspect` — the record-level maintenance view.
//
// WIRING over an existing reader export, which is KREV-01's own claim about this verb: the
// whole of the query lives behind the port, in `inspectRecords`, and this file adds a filter
// pass-through, a projection and a sort. There is no memidex code here and there must never be
// — the moment a verb starts deciding which records match, the read-only reader entry stops
// being the one place that decision is made and the two answers begin to drift.
//
// Every trust-shaped field on a row is DERIVED by the v51 trust fold behind the port; this op
// renders what it is handed and never recomputes trust, exactly as `knowledge.bundles.list`
// does. The DTO carries the reader's OWN view schema rather than a paraphrase of it, so
// "wiring" stays literally true at the type level too.

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

/**
 * The op's own total order (the 384 convention).
 *
 * Stated here rather than inherited from whatever the port answered in, and the pair is the
 * key because a record id is unique only within a product — one id in two products is two
 * different records, and a sort on the id alone would leave their relative order to whichever
 * directory walk the composition happened to perform.
 */
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
  /**
   * An inspection that answered — the count, and no record content.
   */
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
