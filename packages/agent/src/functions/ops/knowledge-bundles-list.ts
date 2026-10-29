// `knowledge.bundles.list` — the committed-bundle catalogue.
//
// The seed of the knowledge review surface: 387's five review verbs extend this listing
// rather than replacing it. Every trust-shaped field on a row is DERIVED by the v51 trust
// fold behind the port — this op renders what it is handed and never recomputes trust.

import { KnowledgeBundlesListInputSchema, KnowledgeBundlesListOutputSchema } from '@vostride/agent-qa-schema'
import type { KnowledgeBundleSummary, KnowledgeBundlesListInput } from '@vostride/agent-qa-schema'

import type { ClauseVerdict, FunctionSpec } from '../spec.js'

export const KNOWLEDGE_BUNDLES_LIST_FUNCTION_ID = 'knowledge.bundles.list'

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export const knowledgeBundlesListSpec: FunctionSpec<
  KnowledgeBundlesListInput,
  KnowledgeBundleSummary[]
> = {
  id: KNOWLEDGE_BUNDLES_LIST_FUNCTION_ID,
  summary: 'List the committed knowledge bundles with their derived trust state.',
  resultKind: 'unary',
  input: KnowledgeBundlesListInputSchema,
  output: KnowledgeBundlesListOutputSchema,
  risk: { name: `fn:${KNOWLEDGE_BUNDLES_LIST_FUNCTION_ID}`, recognized: true, readOnly: true },
  /**
   * A listing that answered — the count, and nothing out of a bundle.
   */
  classify(output): ClauseVerdict {
    return { status: 'executed', outcome: `${output.length} knowledge bundle(s)` }
  },
  async invoke(_input, deps) {
    const rows = await deps.knowledge.listBundles()
    // The op owns its own total order rather than inheriting whatever a composition's
    // directory walk happened to produce: bundle ids are unique only per product, so the
    // pair is the sort key.
    return [...rows].sort((left, right) => (
      compareText(left.product, right.product)
      || compareText(left.bundleId, right.bundleId)
    ))
  },
}
