// The op-result render both chat surfaces print (Phase 399.1 plan 01, D-04 · RC-1).
//
// ONE RENDER, TWO SURFACES, on `receipt-line.ts`'s charter and for its reason (D-01: the one-shot
// and the REPL are the same turn, so a person's scripted run and their conversation must not
// disagree about what happened). `chat.ts` and `ask.ts` import this module; a source pin fails if
// either surface grows a local copy, so the sharing is structural rather than promised.
//
// WHAT THIS CLOSES. Chat executed ops and printed `<op> completed` — for forty of the forty-three,
// the result reached nobody at all. The turn contract had no member that could carry a payload
// until 399.1's `results[]`, so the render had nothing to print even in principle; this is the
// other half of that repair.
//
// THE DEFAULT IS THE COMPLETE PAYLOAD, PRETTY-PRINTED, AND THAT IS THE DECISION. It mirrors
// `fn.ts`'s `emitHuman(JSON.stringify(result, null, 2))` — the door the UAT called honest — and it
// is chosen for a property no curated render has: it is STRUCTURALLY INCAPABLE of withholding a
// field. A hand-picked join of the fields somebody thought mattered is a drop site with a list
// attached, and RC-2 is that exact shape caught dropping `crossBoundary` above a confirm prompt.
// Phase 424 narrows this for new runs.detail recording metadata only: human output names the
// dashboard player and announces the omitted metadata; the machine payload remains complete.
// The forty-third op is covered here by construction rather than by somebody remembering it.
//
// PER-OP FOLDS ADD AND NEVER SUPPRESS. A registry-declared `renderResult` composes a human sentence
// on top of this; it does not filter, replace or elide it. That is a law rather than a convention
// any future elision must be ANNOUNCED — "N bytes elided, `agent-qa fn <op>` for the
// full result" — and never silent. There is no size cap in this phase and no knob for one; 386
// D-15's pinned-constants law says no knob ships before evidence says what to set it to.
//
// NO PRINT SITE LIVES HERE, and no masking either. This returns strings; each surface's emit masks
// them with the declared secrets (`ask`'s `emitHuman`, chat's own masked write). A render that
// printed for itself would print outside that mask.

import { RunDetailProjectionSchema } from '@vostride/agent-qa-schema'
import type { ClauseResult, RunDetailProjection } from '@vostride/agent-qa-schema'
import pc from 'picocolors'

export const RECORDING_SAVED_LINE = 'Recording saved: {size} MB{duration}. Open this run in the dashboard to play it.'
export const RECORDING_FAILED_LINE = 'Recording could not be saved.'

/**
 * Every executed clause's payload, as the lines a surface prints.
 *
 * EMPTY IN, EMPTY OUT. A turn where nothing ran renders nothing — not `[]`, not a header over
 * nothing. The receipts already say what happened, and an empty payload block would be noise on
 * every refused turn and every turn answered in prose.
 *
 * THE OP IS NAMED WHENEVER THE TURN FILED MORE THAN ONE RECEIPT — the RECEIPT count, not the result
 * count. Both surfaces print ALL of a turn's receipts and THEN all of its payloads, so what drives a
 * reader's ambiguity is how many receipt lines stand above the payload block, and nothing else. A
 * single-receipt turn already has the op's name on the receipt line directly above; repeating it
 * would put the same word twice on two consecutive lines, which is why the one-receipt shape stays
 * bare. Beyond one, a payload is a document the reader has to attribute.
 *
 * KEYING THIS ON `results.length` WAS GAP 2, and the difference is only visible in a turn with MIXED
 * outcomes. When some clause fails, the payload count is SMALLER than the receipt count: one
 * surviving payload, no label, printed directly beneath a DIFFERENT op's failure receipt. The
 * verifier measured it on the shipped binary — `proposals.list`'s `{ "entries": [] }` sitting under
 * `failed  runs.digest`, readable as `runs.digest`'s answer. Two ordinary clauses, no credential:
 * one op's output read as another op's, which is the legibility class this phase exists to close.
 *
 * `receiptCount` is therefore a required argument rather than something inferred here: this module
 * is handed the results, and the number of lines a surface printed above them is a fact only the
 * surface has. Both surfaces pass `result.receipts.length`, and a source pin holds them to it.
 */
export function renderClauseResults(
  results: readonly ClauseResult[],
  receiptCount: number,
): string[] {
  if (results.length === 0) return []
  const lines: string[] = []
  for (const result of results) {
    if (receiptCount > 1) lines.push(pc.dim(result.functionId))
    const detail = result.functionId === 'runs.detail'
      ? RunDetailProjectionSchema.safeParse(result.payload) : undefined
    if (detail?.success) lines.push(...renderRunDetail(detail.data))
    else lines.push(renderPayload(result.payload))
  }
  return lines
}

function renderRunDetail(detail: RunDetailProjection): string[] {
  const recordingLines: string[] = []
  let omitted = false
  const members = detail.members.map(({ recording, ...member }) => {
    if (recording === undefined) return member
    omitted = true
    const prefix = `Test ${member.testIndex + 1}: `
    if (recording.state === 'present') {
      const seconds = recording.durationMs === undefined ? undefined : Math.floor(recording.durationMs / 1000)
      const duration = seconds === undefined ? ''
        : `, ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
      recordingLines.push(prefix + RECORDING_SAVED_LINE
        .replace('{size}', (recording.byteLength / 1_000_000).toFixed(1))
        .replace('{duration}', duration))
    } else if (recording.reason === 'failed') {
      recordingLines.push(prefix + RECORDING_FAILED_LINE)
    }
    return member
  })
  return [renderPayload({ ...detail, members }), ...recordingLines,
    ...(omitted ? ['Member capture metadata omitted; use agent-qa fn runs.detail --json for the full result.'] : []),
  ]
}

/**
 * One payload, whole.
 *
 * `JSON.stringify` CAN ANSWER `undefined` — for an undefined value, and for a function or symbol —
 * and a render that pushed that would print the word `undefined` where a result belongs. An op that
 * returned nothing is a real, ordinary thing (`resultKind: 'unary'` with a void-ish contract), and
 * what a person needs to read then is that there was nothing rather than a JavaScript keyword.
 */
function renderPayload(payload: unknown): string {
  const rendered = JSON.stringify(payload, null, 2)
  return rendered === undefined ? pc.dim('(no result)') : rendered
}
