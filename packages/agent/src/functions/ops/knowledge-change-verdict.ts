// One fold for every knowledge change op, so no door reports a refusal differently.

import type { KnowledgeChangeOutput } from '@vostride/agent-qa-schema'

import type { ClauseVerdict } from '../spec.js'

// `target-not-found` is an answer; a policy text the writer refused is a refusal.
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
