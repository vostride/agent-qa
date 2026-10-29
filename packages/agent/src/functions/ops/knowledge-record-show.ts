// `knowledge.record.show` — one record with the provenance that justifies it (Phase 387,
// KREV-01).
//
// WIRING over the reader entry's `showRecord`. The op validates its input, dispatches, and
// renders the closed union it is handed. It has no list to sort: the answer is one record or a
// named absence, so the 384 total-order convention has nothing to order here — and inventing a
// sort for a single value would have been ceremony rather than determinism.
//
// ABSENCE IS A RESULT, not a refusal this op throws. `runs.get` turns its port's `undefined`
// into a typed error because a run id that names nothing is a caller mistake; a record id that
// names nothing is not, because records are TOMBSTONED and forgotten by design (§7.7) and
// asking about one that has gone is the ordinary thing a reviewer does. So the miss is an arm
// of the answer, and a store that could not be read at all still throws — the two stay
// distinguishable, which is the whole reason the union exists.

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
  /**
   * "Absence is a RESULT rather than a refusal" — the contract's own words.
   */
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
    // The id crosses verbatim, including one shaped like a path. That is safe for a structural
    // reason and not a hopeful one: the reader resolves an id against the records it
    // ENUMERATES and never by joining a caller's string onto a path, which is the same
    // T-384-08 discipline `runs.get` carries. Sanitising here would add a second, weaker
    // spelling of a guarantee the read side already makes.
    return deps.knowledge.showRecord(input)
  },
}
