// The abstention record is written before the render, because the text names it.

import { ExplainInputSchema, ExplainOutputSchema } from '@vostride/agent-qa-schema'
import type { CatalogRow, ExplainInput, ExplainOutput } from '@vostride/agent-qa-schema'

import { closestCapabilities, renderExplainOutput } from '../../explain/index.js'
import type { CapabilityCatalogPort } from '../../explain/index.js'
import { FunctionNotBoundError } from '../spec.js'
import type { ClauseVerdict, FunctionDeps, FunctionSpec } from '../spec.js'

// The literal appears once; surfaces name this constant.
export const EXPLAIN_FUNCTION_ID = 'agent.explain'

// An append failure still answers, with `docsGapLogged` false.
function abstainAndRecord(
  port: CapabilityCatalogPort,
  query: string,
  rows: readonly CatalogRow[],
): ExplainOutput {
  const closestRowIds = closestCapabilities(query, rows)

  let docsGapLogged = false
  try {
    port.recordAbstained({ query, closestRowIds })
    docsGapLogged = true
  } catch {
    // Deliberately swallowed — see the note above. The renderer reports the absence in the text.
  }

  // An EMPTY citation is the honest input for every path that reaches here: the empty-catalog arm
  // has nothing to cite, and the ghost-id arm's citation was refused wholesale rather than filtered
  // (the renderer's all-or-nothing control flow). Re-rendering with `citedRowIds: []` therefore
  // states what is true — nothing resolved — instead of carrying a rejected citation forward.
  return renderExplainOutput({ citedRowIds: [] }, rows, { query, docsGapLogged })
}

export const explainSpec: FunctionSpec<ExplainInput, ExplainOutput> = {
  id: EXPLAIN_FUNCTION_ID,
  // The line the catalog renders for this row.
  summary:
    'Answer a question about what this product can do by citing the capability catalog, or say '
    + 'plainly that the catalog does not ground an answer.',
  resultKind: 'unary',
  // Unbound without a catalog, so an explain never answers from model memory.
  boundThrough: 'capabilityCatalog',
  input: ExplainInputSchema,
  output: ExplainOutputSchema,
  // Read-only and recognized: it starts nothing, writes nothing a caller can address, and the one
  // byte it appends is a local coverage line about a question it was asked.
  risk: { name: `fn:${EXPLAIN_FUNCTION_ID}`, recognized: true, readOnly: true },
  // Parsed, never cast, so a doctored result cannot carry prose; a parse failure adds nothing.
  renderResult(output): readonly string[] {
    const parsed = ExplainOutputSchema.safeParse(output)
    return parsed.success ? parsed.data.renderedLines : []
  },
  // An abstention is an answer, never `refused`; the receipt carries counts only.
  classify(output): ClauseVerdict {
    switch (output.kind) {
      case 'answer':
        return {
          status: 'executed',
          outcome: `answered — ${output.citations.length} capability citation(s)`,
        }
      case 'abstention':
        return {
          status: 'executed',
          outcome: `abstention — not grounded; `
            + `${output.closestRowIds.length} closest row(s) offered`,
        }
      default:
        return output satisfies never
    }
  },
  async invoke(input, deps: FunctionDeps) {
    const port = deps.capabilityCatalog
    if (port === undefined) {
      throw new FunctionNotBoundError(EXPLAIN_FUNCTION_ID)
    }

    const rows = await port.loadCatalog()

    // An empty catalog has nothing to ground an answer, so the model is never asked.
    if (rows.length === 0) {
      return abstainAndRecord(port, input.query, rows)
    }

    // Citations matching no row are ghosts, and the renderer abstains on them.
    const citation = await port.citeCapabilities(input.query, rows)
    const output = renderExplainOutput(citation, rows, { query: input.query })

    if (output.kind === 'answer') {
      // A counter and no payload.
      port.recordAnswered()
      return output
    }

    // The renderer already decided this is an abstention; it is re-rendered rather than mutated so
    // the docs-gap sentence and the `docsGap.logged` field are composed together, once, from the
    // same fact.
    return abstainAndRecord(port, input.query, rows)
  },
}
