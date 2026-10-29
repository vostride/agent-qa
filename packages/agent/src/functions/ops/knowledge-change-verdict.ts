// The clause verdict for a direct knowledge change — one fold for the three ops.
//
// `knowledge.accept`, `knowledge.reject` and `knowledge.forget` answer one union,
// `KnowledgeChangeOutput`, and each carried a byte-identical copy of this switch. One fold, on the
// `classifyConfigChangeOutput` precedent: a later edit that taught one door to report a refusal
// differently would be a report that depends on which door was used.

import type { KnowledgeChangeOutput } from '@vostride/agent-qa-schema'

import type { ClauseVerdict } from '../spec.js'

/**
 * Fold one `KnowledgeChangeOutput` into the verdict its own arm states.
 *
 * `target-not-found` IS ABSENCE, WHICH IS AN ANSWER (399.1 D-01, plan 03's razor): a ref that names
 * nothing is an ordinary mistake and the store is intact. A policy text the writer refused to
 * materialize is a refusal: nothing was changed.
 */
export function classifyKnowledgeChangeOutput(output: KnowledgeChangeOutput): ClauseVerdict {
  switch (output.outcome) {
    case 'applied':
      return { status: 'executed', outcome: `${output.verb} applied: ${output.recordIds.length} record(s) changed` }
    case 'target-not-found':
      return { status: 'executed', outcome: 'target-not-found: nothing was changed' }
    case 'refused':
      return { status: 'refused', outcome: `${output.reason}: nothing was changed` }
    default:
      return output satisfies never
  }
}
