// `agent.explain` — what this product can do, answered from the catalog (Phase 398 plan 07 —
// XPLN-02, D-09 / D-10 / D-11 / D-12).
//
// THE FIRST OP ADDED SINCE THE PARITY SUITE CLOSED, and registering it is the decision.
// "What can you do" could have been a private power of whatever surface answered it — a REPL
// branch, an MCP handler, a paragraph in a prompt. Every one of those is a capability the
// catalogue does not list, which is the private-power pattern §3's L10 law abolishes and which the
// 397 census exists to make impossible. So it is a registered op: golden row, scenario row, catalog
// row, MCP partition entry, all added through their own machinery.
//
// THE OP OWNS ORDER AND NOTHING ELSE. Everything load-bearing was proven in plan 04 and is called
// here, not re-implemented: the renderer quotes every character a person reads out of a catalog row
// the scorer picks the abstention's closest capabilities deterministically, and the
// contract's two arms are the whole vocabulary. What this file adds is the SEQUENCE — load, cite,
// resolve, and on the abstention arm record BEFORE rendering — plus the refusal by name when no
// host bound the port.
//
// WHY `recordAbstained` RUNS BEFORE THE RENDER (398-04's note 2). The abstention text NAMES the
// docs-gap path, and `docsGap.logged` is an input to the renderer rather than a flag mutated after
// it: a line claiming a record that was never written is the same class of untrue statement this
// whole feature is built to prevent. Rendering first and patching the boolean afterwards would
// leave the TEXT stale while the field read correctly, which is the worst of both.
//
// THIS FILE READS NO ENVIRONMENT, OPENS NO FILE, AND COMPOSES NO INVOCATION STRING. `packages/agent`
// is storageNeutral, so the catalog arrives as data and the coverage append happens behind the port
// (see `explain/port.ts` for why each of the four methods is a port). And no slash form is spelled
// here: `invocationForRow` in the renderer is the one place a row's reachable form is composed
// so a second spelling in an op could not drift out of step with it — there is none.

import { ExplainInputSchema, ExplainOutputSchema } from '@vostride/agent-qa-schema'
import type { CatalogRow, ExplainInput, ExplainOutput } from '@vostride/agent-qa-schema'

import { closestCapabilities, renderExplainOutput } from '../../explain/index.js'
import type { CapabilityCatalogPort } from '../../explain/index.js'
import { FunctionNotBoundError } from '../spec.js'
import type { ClauseVerdict, FunctionDeps, FunctionSpec } from '../spec.js'

/**
 * Lowercase dot taxonomy: the `agent` domain, already a pinned member of the conformance
 * suite's `domain-list.ts` because `agent.ask` lives there. No taxonomy widening — an explain is a
 * thing the AGENT does about itself, which is exactly what that domain's charter covers.
 *
 * The literal appears here once; the scenario rows, the composition and every later surface name
 * this constant.
 */
export const EXPLAIN_FUNCTION_ID = 'agent.explain'

/**
 * The abstention arm, with the coverage record appended first.
 *
 * `closestCapabilities` is called HERE as well as inside the renderer, and the duplication is
 * deliberate rather than an oversight: the record must carry the same closest set the person is
 * shown, and the scorer is a total deterministic function of (query, rows) — proven in plan 04
 * against run order, row order and locale — so the two computations cannot disagree. The
 * alternative, threading the set through the renderer's return value, would have made the render a
 * two-phase call for the sake of avoiding one pure function evaluation.
 *
 * AN APPEND FAILURE IS NOT AN ANSWER FAILURE. The coverage log is SURF-FUT-02's demand signal, not
 * part of what the person asked for, so a host whose log cannot be written still gets its honest
 * abstention — and says so, because `docsGapLogged` stays false and the renderer's frozen template
 * set has the sentence for it. Letting the throw out would turn a disk problem into "explain is
 * broken", which is a worse answer than the one it would be replacing.
 */
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
  // One line, and it is the line the catalog RENDERS for this row — descriptions live on the spec
  // so one source feeds chat, MCP and the catalogue.
  summary:
    'Answer a question about what this product can do by citing the capability catalog, or say '
    + 'plainly that the catalog does not ground an answer.',
  // no scope. This op once declared `read` alone so that it stayed
  // listable in safe mode; safe mode and scopes are deleted, and every caller lists and calls it.
  resultKind: 'unary',
  // the catalog reaches this op through a port bound at `composeLocalAgent()`. A
  // composition without one lists the capability `unbound` BY NAME rather than degrading to a
  // model-only answer — an explain that silently lost its catalog is precisely an explain that
  // answers from model memory, which is the one behaviour XPLN-02 exists to forbid.
  boundThrough: 'capabilityCatalog',
  input: ExplainInputSchema,
  output: ExplainOutputSchema,
  // Read-only and recognized: it starts nothing, writes nothing a caller can address, and the one
  // byte it appends is a local coverage line about a question it was asked.
  risk: { name: `fn:${EXPLAIN_FUNCTION_ID}`, recognized: true, readOnly: true },
  /**
   * The answer lines this op composed, on their way to the turn's `answer` field.
   *
   * MIGRATED FROM `turn-engine.ts` BY 399.1-03, ARGUMENT INTACT. It lived there as
   * `explainAnswerLines`, an explicit comparison of the running clause's `functionId` against this
   * op's id — a render rule in the engine, which by construction could only ever render what
   * somebody had thought to name there. D-04's promote decision moved it here: this op knows what
   * its own result deserves to have said about it, and the engine no longer knows this op exists.
   *
   * THE RECEIPT CHARTER IS UNTOUCHED, and that is still the whole reason these lines take THIS
   * channel rather than the receipt's. The receipt stays the MAP — the plain `agent.explain
   * completed` line — and the territory travels on the field `renderTurn` already prints and `ask`
   * already shares. A second carrier on the receipt would put the answer inside the map.
   *
   * PARSED, NEVER CAST, and a parse failure renders NOTHING extra: the fold fails OPEN by contract
   * (`foldFunctionResult`), so an unreadable result costs a person legibility and never the record.
   * Every character of `renderedLines` was quoted out of a committed catalog row by the renderer
   * so nothing a model wrote can ride this channel — which is why the parse is here and not
   * a cast: a doctored result must not become a door for prose.
   *
   * BOTH ARMS RENDER. An abstention's lines are the honest "the catalog does not ground an answer",
   * and XPLN-02's whole claim is that saying so plainly is an ANSWER a person is owed, not a silence.
   */
  renderResult(output): readonly string[] {
    const parsed = ExplainOutputSchema.safeParse(output)
    return parsed.success ? parsed.data.renderedLines : []
  },
  /**
   * AN ABSTENTION IS AN HONEST ANSWER, NOT A CONTROL DECLINING (399.1 D-01/D-02, plan 03's razor).
   *
   * XPLN-02's whole claim is that "the catalog does not ground an answer" is a result this op is
   * PROUD of. Folding it to `refused` would tell a person a guardrail stopped their question when
   * what happened is that the question was answered truthfully.
   *
   * COUNTS AND NO TERRITORY, and here that is load-bearing rather than stylistic. The answer text
   * is this op's `renderResult` output and reaches the turn's `answer` field; a receipt outcome
   * carrying a cited row's description would put the territory back inside the map, which is the
   * one thing `explain.test.ts`'s receipt-charter cell exists to red on.
   */
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

    // SC-2, at the seam where it is decidable: a catalog with no rows has nothing to ground an
    // answer in, so the model is never asked. Short-circuiting rather than prompting an empty
    // grounding set is what makes "an empty catalog abstains rather than inventing" a property of
    // the control flow instead of a hope about what a model does with no data.
    if (rows.length === 0) {
      return abstainAndRecord(port, input.query, rows)
    }

    // the model's WHOLE output contract is `ExplainCitation`, which has no field a command
    // fits in, and the implementation is obliged to pass `rows` as the grounding data. Anything it
    // cites that no row answers to is a ghost, and the renderer answers ghosts by abstaining.
    const citation = await port.citeCapabilities(input.query, rows)
    const output = renderExplainOutput(citation, rows, { query: input.query })

    if (output.kind === 'answer') {
      // a COUNTER and no payload. The query is the one free-text value in this feature and it
      // travels to the local coverage log or nowhere.
      port.recordAnswered()
      return output
    }

    // The renderer already decided this is an abstention; it is re-rendered rather than mutated so
    // the docs-gap sentence and the `docsGap.logged` field are composed together, once, from the
    // same fact.
    return abstainAndRecord(port, input.query, rows)
  },
}
