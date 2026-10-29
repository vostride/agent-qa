// ONE SERVED BRIEF LINE, WITH THE REASON IT WAS SERVED.
//
// IT IS PRESENTATIONAL AND KNOWS NO RUN. It takes a line view and paints it. It computes no rank,
// no score and no outcome word — every one of those is decided in `lib/knowledge-view.ts` from the
// serve-time trace and the projection's own attribution join, and a component that could compute a
// rank would be a component that could answer "why this line?" about the index as it stands NOW
// rather than about the moment the brief was assembled. That is the exact dishonesty KREV-02
// exists to prevent, and the reason `why` arrives as data rather than as a query.
//
// EVERY ABSENCE IS A VISIBLE STATE. `data-trace-state` is one of four words and never
// missing: `answered` prints what the trace recorded; `artifact-missing` renders the SHIPPED
// evidence-incomplete component rather than a fifth wording for "the bytes are gone";
// `pre-trace-run` and `step-not-found` each print their own sentence. Nothing silently drops, and
// nothing renders an expander that would open onto nothing.
//
// THE CANARY MARKER IS UNCONDITIONAL. A line served as a canary says so whatever curation
// did or did not decide, and the attribution word beside it is one of seven — never blank. A blank
// slot beside a canary marker reads as "this did not matter", which is a claim nobody made. The
// seventh word, `unknown`, is the one a partial store read earns: `not attributed` asserts the
// store was consulted and said no, and a scan that could not finish never made that claim.
//
// this line lives inside Retrieval details, which is already a disclosure, so the trace
// reads inline, the marker and the store's word are plain 12px text, and the id carries a copy
// button. The id stays the line's first `<p>`, which the shipped-binary harvest reads.
//
// ALL TEXT GOES THROUGH REACT TEXT NODES. No raw-HTML injection escape hatch appears anywhere in
// this file — a grep for React's one is an acceptance criterion. The summary is a stored producer
// string, shown as written.

import { EvidenceIncomplete } from "./evidence-incomplete"
import { RecordIdCopy } from "./record-id-copy"
import {
  ATTRIBUTION_PENDING_TEXT,
  ATTRIBUTION_SKIPPED_TEXT,
  ATTRIBUTION_UNKNOWN_TEXT,
  LEDGER_ON_TRIAL_TEXT,
  NOT_ATTRIBUTED_TEXT,
  PRE_TRACE_TEXT,
  STEP_NOT_FOUND_TEXT,
  attributionWordText,
  traceLineText,
  trustMetaLine,
  type BriefLineView,
  type CanaryOutcomeWord,
} from "@/lib/knowledge-view"

/** The nested-disclosure trigger idiom `artifact-config-tab.tsx` established. */
export const NESTED_TRIGGER_CLASS =
  "group flex items-center gap-1.5 text-left text-xs font-medium text-muted-foreground hover:text-foreground"

/** A record id, a leg, a rank, a score: mono, and `tabular-nums` so a column does not jitter. */
const MONO_CLASS = "font-mono text-xs text-muted-foreground tabular-nums"

/** Muted 12px text, the look of every non-sentence word in the ledger. */
const LEDGER_WORD_CLASS = "text-xs text-muted-foreground"

/**
 * The eight outcome words, as plain text.
 *
 * NO `default` ARM. The switch is exhaustive over `CanaryOutcomeWord` and its return type is not
 * optional, so a ninth word is a COMPILE ERROR here rather than a slot that silently renders
 * `undefined`. `unknown` and `not attributed` look the same; `data-canary-outcome` tells them apart.
 */
function outcomeText(word: CanaryOutcomeWord): string {
  switch (word) {
    case "confirmed":
    case "helpful":
    case "contradicted":
    case "harmful":
      return attributionWordText(word)
    case "pending":
      return ATTRIBUTION_PENDING_TEXT
    case "not-attributed":
      return NOT_ATTRIBUTED_TEXT
    case "unknown":
      return ATTRIBUTION_UNKNOWN_TEXT
    case "skipped":
      return ATTRIBUTION_SKIPPED_TEXT
  }
}

export function KnowledgeBriefLine({ line }: { line: BriefLineView }) {
  return (
    <li
      data-served-channel="1"
      data-served-as-canary={line.servedAsCanary ? "true" : "false"}
      // ABSENT, not empty, on a line that was not served as a canary: an empty attribute is
      // indistinguishable from an outcome the component forgot to stamp.
      {...(line.canaryOutcome === undefined ? {} : { "data-canary-outcome": line.canaryOutcome })}
      data-trace-state={line.why.kind === "answered" ? "answered" : line.why.reason}
      className="space-y-1"
    >
      {/*
        `wrap-anywhere` (`overflow-wrap: anywhere`), NOT `break-words`. A summary is regularly ONE
        UNBROKEN TOKEN — a URL, a selector literal, a content-derived record id — and
        `overflow-wrap: break-word` only offers such a token a break opportunity once the box has
        ALREADY been sized: it leaves min-content width at the full unbroken token. A flex item
        sized from its own content therefore never shrinks and never reaches the break, which is
        how this span was measured grown to 895px inside a 639px parent WITH `break-word` applied.
        `anywhere` is the spelling that participates in intrinsic sizing, so the row can shrink it.
      */}
      <span className="block text-xs wrap-anywhere">{line.summary}</span>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {/* The same intrinsic break at the USE SITE: a record id is content-derived and unbroken. */}
        <div className="flex min-w-0 items-center gap-1">
          <p className={`${MONO_CLASS} min-w-0 wrap-anywhere`}>{line.id}</p>
          <RecordIdCopy id={line.id} />
        </div>
        {line.servedAsCanary ? <span className={LEDGER_WORD_CLASS}>{LEDGER_ON_TRIAL_TEXT}</span> : null}
      </div>
      <p className={MONO_CLASS}>{trustMetaLine(line.trust, line.tier, line.status)}</p>
      <LineWhyRow line={line} />
      {line.canaryOutcome === undefined ? null : (
        <p className={LEDGER_WORD_CLASS}>{outcomeText(line.canaryOutcome)}</p>
      )}
    </li>
  )
}

/**
 * The why answer, or the named absence of one — inline, because Retrieval details is already the
 * disclosure a reader opened to see it.
 */
function LineWhyRow({ line }: { line: BriefLineView }) {
  if (line.why.kind === "answered") {
    return <p className={MONO_CLASS}>{traceLineText(line.why.leg, line.why.rank, line.why.score)}</p>
  }

  if (line.why.reason === "artifact-missing") {
    // The one component and the one word for "the bytes are gone" — not a fifth
    // wording invented here for a row.
    return <EvidenceIncomplete variant="inline" />
  }

  return (
    <p className={LEDGER_WORD_CLASS}>
      {line.why.reason === "pre-trace-run" ? PRE_TRACE_TEXT : STEP_NOT_FOUND_TEXT}
    </p>
  )
}
