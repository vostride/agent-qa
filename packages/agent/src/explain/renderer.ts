// Cite-and-resolve: the deterministic half of `explain` (Phase 398 plan 04 — XPLN-02, D-10 / D-11
// / D-12; threats T-398-09, T-398-10).
//
// THE CANONICAL ROW-ID SCHEME, spelled once and here:
//
//     op:<registry op id>      e.g.  op:runs.start
//     alias:<chat alias>       e.g.  alias:run
//     skill:<skill name>       e.g.  skill:agent-qa-authoring
//
// Kind-prefixed because the three kinds share a namespace of words a person types: `run` is a chat
// alias AND part of two op ids, and an unprefixed id would make "which row did you mean" a
// question with two answers. The within-kind half is `catalogRowKey` from the schema package, so
// this file adds the prefix and invents no second notion of a row's identity. Plan 07's catalog
// feed cites rows by exactly these ids.
//
// WHY THIS FILE IS THE MECHANISM AND NOT A PRECAUTION. D-10's claim is that `explain` can never
// answer from model memory. The way that claim usually fails is the 392 failure class: a
// structural hole closed by rewriting a prompt. Here the model's whole output contract is
// `ExplainCitation`, which has no field a command fits in, and this renderer builds every
// character a person reads out of catalog rows. So the property is not "the model was told not to
// invent" — it is that there is no path from model text to rendered command. Two total properties
// carry it, and both are cells in `__tests__/renderer.test.ts`:
//
//   1. EVERY quoted form in an answer resolves to a cited row. Stated over the whole output, not
//      as a scan for forbidden shapes — a guard that can only refuse what it can NAME is a guard
//      you close by naming more things, forever.
//   2. Model prose is INERT: the output is a total function of (resolved rows, cited order), so
//      the guarantee is quantified over ARBITRARY prose rather than over the prose we thought of.
//
// ALL-OR-NOTHING, DELIBERATELY. One unresolvable id abstains the WHOLE output rather than
// answering over the ids that did resolve. A partial answer is the shape that reads as grounded
// while carrying an unexplained absence, and a person cannot tell which half they are holding —
// the chat resolver table refuses partial matches for the same reason ("it is not a resolution
// and it must not be a partial one").

import { catalogRowKey } from '@vostride/agent-qa-schema'
import type {
  CatalogRow,
  ExplainCitation,
  ExplainCitedCapability,
  ExplainOutput,
} from '@vostride/agent-qa-schema'

import { DEFAULT_CLOSEST_COUNT, closestCapabilities } from './scorer.js'

/**
 * Every fixed string an abstention can show a person, frozen and in one place (prohibition P2).
 *
 * A CLOSED SET is what makes the no-blame requirement checkable at all. "Does the output shame the
 * user" is not decidable over strings composed ad hoc at three call sites; over a frozen set of
 * five it is a review of five sentences, and the P2 cell scans the complete set rather than a
 * sample of it. Nothing here blames the asker, hedges into false confidence, upsells, or offers a
 * partial answer to soften the refusal.
 */
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
  /**
   * The person's question — used ONLY to rank the abstention's closest capabilities.
   *
   * The renderer is pure: it does not log this, and `packages/agent` could not if it wanted to.
   * The coverage-log append is `recordAbstained` on the host port.
   */
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
    // A ghost id is not a bad answer to repair — there is nothing to quote, so the whole output
    // abstains. Returning here rather than collecting is what makes "no partial answer"
    // a property of the control flow instead of a later filter someone can relax.
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
