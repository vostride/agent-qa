// All or nothing: one unresolvable id abstains the whole output rather than answering in part.

import { catalogRowKey } from '@vostride/agent-qa-schema'
import type {
  CatalogRow,
  ExplainCitation,
  ExplainCitedCapability,
  ExplainOutput,
} from '@vostride/agent-qa-schema'

import { DEFAULT_CLOSEST_COUNT, closestCapabilities } from './scorer.js'

// Every fixed abstention string in one frozen set, so the no-blame cell can read all of them.
export const EXPLAIN_ABSTENTION_TEMPLATES = Object.freeze({
  uncertain:
    'I am not certain: I could not ground an answer to that in the capability catalog, so I am not going to guess one.',
  emptyCatalog:
    'No capability catalog is loaded here, so there is nothing to ground an answer in.',
  closestPrefix: 'The closest capability the catalog carries is',
  noClose: 'Nothing in the catalog reads close to that.',
  gapLogged:
    'Recorded as a documentation gap in the local coverage log under `.agent-qa/` — the question stays on this machine.',
  gapNotLogged:
    'No coverage log is bound here, so this gap was not recorded.',
})

/** The canonical row id — the scheme documented in this file's header. */
export function catalogRowId(row: CatalogRow): string {
  return `${row.kind}:${catalogRowKey(row)}`
}

/**
 * How this row is reached, in the row's OWN form.
 *
 * - op rows get the `/fn <id>` passthrough, which the chat resolver table's one generic branch
 *   makes true for every registry op — so this is the form with no per-op maintenance and no
 *   chance of naming a door that is not there.
 * - alias rows get `/<alias>`, and the alias comes from the ROW, whose value the catalog producer
 *   derived by running the shipped resolver table. Writing an alias literal here would be the
 *   second capability vocabulary that table's header forbids.
 * - skill rows get the skill's name: a skill is not invoked with a slash, and inventing a syntax
 *   for it would be exactly the fabrication this file exists to prevent.
 */
export function invocationForRow(row: CatalogRow): string {
  switch (row.kind) {
    case 'op':
      return `/fn ${row.id}`
    case 'alias':
      return `/${row.alias}`
    case 'skill':
      return row.name
  }
}

/** The op row's declared required inputs, verbatim. Never guessed, never a synthesised example. */
function requiredParamsOf(row: CatalogRow): readonly string[] {
  if (row.kind !== 'op') return []
  const declared = (row.params as Record<string, unknown>)['required']
  if (!Array.isArray(declared)) return []
  return declared.filter((name): name is string => typeof name === 'string' && name.length > 0)
}

function citedCapabilityOf(row: CatalogRow): ExplainCitedCapability {
  return {
    rowId: catalogRowId(row),
    rowKind: row.kind,
    invocation: invocationForRow(row),
    description: row.description,
    requiredParams: [...requiredParamsOf(row)],
    docPath: row.kind === 'skill' ? row.docPath : row.docPath,
  }
}

/** One answer line, assembled from a resolved citation and nothing else. */
function answerLineOf(cited: ExplainCitedCapability): string {
  const head = cited.rowKind === 'skill' ? 'skill ' : ''
  const required =
    cited.requiredParams.length > 0
      ? ` (required input: ${cited.requiredParams.join(', ')})`
      : ''
  const docs = cited.docPath === null ? '' : ` (docs: ${cited.docPath})`
  return `${head}\`${cited.invocation}\` — ${cited.description}${required}${docs}`
}

function abstain(
  query: string,
  rows: readonly CatalogRow[],
  closestCount: number,
  docsGapLogged: boolean,
): ExplainOutput {
  const closestRowIds = closestCapabilities(query, rows, closestCount)
  const byRowId = new Map(rows.map((row) => [catalogRowId(row), row]))

  const lines: string[] = [
    rows.length === 0
      ? EXPLAIN_ABSTENTION_TEMPLATES.emptyCatalog
      : EXPLAIN_ABSTENTION_TEMPLATES.uncertain,
  ]
  if (rows.length === 0) lines.unshift(EXPLAIN_ABSTENTION_TEMPLATES.uncertain)

  if (closestRowIds.length === 0) {
    if (rows.length > 0) lines.push(EXPLAIN_ABSTENTION_TEMPLATES.noClose)
  } else {
    for (const rowId of closestRowIds) {
      const row = byRowId.get(rowId)
      if (row === undefined) continue
      const cited = citedCapabilityOf(row)
      lines.push(
        `${EXPLAIN_ABSTENTION_TEMPLATES.closestPrefix} \`${cited.invocation}\` — ${cited.description}`,
      )
    }
  }

  lines.push(
    docsGapLogged
      ? EXPLAIN_ABSTENTION_TEMPLATES.gapLogged
      : EXPLAIN_ABSTENTION_TEMPLATES.gapNotLogged,
  )

  return {
    kind: 'abstention',
    is_uncertain: true,
    closestRowIds: [...closestRowIds],
    renderedLines: lines,
    docsGap: { logged: docsGapLogged },
  }
}

/** What the renderer needs beyond the model's citation and the catalog itself. */
export interface ExplainRenderContext {
  // Used only to rank the abstention's closest capabilities; the renderer logs nothing.
  readonly query: string
  readonly closestCount?: number
  /**
   * Whether the HOST already appended the coverage record — a report, not a request.
   *
   * It is an input because the abstention text names the docs-gap path, and a line claiming a
   * record that was never written is the same class of untrue statement this whole file is built
   * to prevent. A composition with no coverage log says so.
   */
  readonly docsGapLogged?: boolean
}

/**
 * Resolve a model's citation against the catalog, or abstain.
 *
 * Answers the `answer` arm only when the citation names at least one row and EVERY id it names
 * resolves. Duplicate ids collapse, first mention wins the position — a row cited twice is one
 * capability, and rendering it twice would be the renderer letting citation COUNT say something
 * the catalog did not.
 */
export function renderExplainOutput(
  citation: ExplainCitation,
  rows: readonly CatalogRow[],
  context: ExplainRenderContext,
): ExplainOutput {
  const closestCount = context.closestCount ?? DEFAULT_CLOSEST_COUNT
  const docsGapLogged = context.docsGapLogged ?? false

  if (rows.length === 0) return abstain(context.query, rows, closestCount, docsGapLogged)

  const byRowId = new Map(rows.map((row) => [catalogRowId(row), row]))
  const seen = new Set<string>()
  const citations: ExplainCitedCapability[] = []

  for (const citedRowId of citation.citedRowIds) {
    const row = byRowId.get(citedRowId)
    // Returning here, not collecting, keeps a partial answer out of the control flow.
    if (row === undefined) return abstain(context.query, rows, closestCount, docsGapLogged)
    if (seen.has(citedRowId)) continue
    seen.add(citedRowId)
    citations.push(citedCapabilityOf(row))
  }

  if (citations.length === 0) return abstain(context.query, rows, closestCount, docsGapLogged)

  return {
    kind: 'answer',
    citations,
    renderedLines: citations.map((cited) => answerLineOf(cited)),
  }
}
