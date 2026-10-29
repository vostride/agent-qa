// `knowledge.records.diff` — what changed since a build ordinal.
//
// WIRING over the reader entry's `diffSince`. The change vocabulary, the surviving-event fold
// and the purge-receipt read all live behind the port; this file projects, echoes the baseline,
// and sorts. KREV-01's "four verbs need no new memidex code" is a claim about exactly this.

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

/**
 * The op's own total order, and it is total all the way down (the 384 convention).
 *
 * One record can change several times at one ordinal — a confirmation and a supersession land
 * in the same build — so the id and the ordinal do not order the list on their own. The trailing
 * legs are what turn "deterministic enough in practice" into deterministic: two rows equal on
 * every earlier key still have an order, and it is the same order twice running on any host.
 * A diff that reshuffled between two identical questions would make every pasted answer
 * unverifiable.
 */
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
  /**
   * A diff that answered, WITH ITS BASELINE.
   *
   * The ordinal rides the outcome for the contract's own reason: "a change list with no baseline is
   * a list whose meaning depends on remembering the question", and a receipt line is exactly the
   * artifact that gets pasted somewhere the question is gone.
   */
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
