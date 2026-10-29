// Presentational: rank, score and outcome word arrive as data, so the line describes serve time.

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

// No `default` arm, so a new outcome word fails to compile; `data-canary-outcome` tells them apart.
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

// Inline, because Retrieval details is already the disclosure the reader opened.
function LineWhyRow({ line }: { line: BriefLineView }) {
  if (line.why.kind === "answered") {
    return <p className={MONO_CLASS}>{traceLineText(line.why.leg, line.why.rank, line.why.score)}</p>
  }

  if (line.why.reason === "artifact-missing") {
    // The shared component and word for missing bytes, not a new wording for this row.
    return <EvidenceIncomplete variant="inline" />
  }

  return (
    <p className={LEDGER_WORD_CLASS}>
      {line.why.reason === "pre-trace-run" ? PRE_TRACE_TEXT : STEP_NOT_FOUND_TEXT}
    </p>
  )
}
