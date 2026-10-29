// THE LEARNED HALF OF THE KNOWLEDGE TAB (407-09 · LERN-02, D-09..D-12, T-407-21/T-407-22).
//
// IT IS PRESENTATIONAL AND KNOWS NO RUN. It takes a view and paints it. It reads nothing, fetches
// nothing and mints no route — the page owns the one `runs.knowledge` client (D-05's "one read,
// one shape"), `lib/knowledge-view.ts` owns every sentence and every state word, and this file
// owns only where they land in the DOM.
//
// FIVE STATES, AND FOUR OF THEM ARE ABSENCES — none of which renders blank. A half that
// showed an empty list under a `failed` chip would tell a reader "curation ran and changed
// nothing", which is a different run from the one in front of them. So every arm below carries
// either rows or a sentence, and the projection is total so this component needs no fallback.
//
// THE SIXTH RENDERING is a settled state word carrying a sentence that names an UNREADABLE STORE
// (407-14/407-15): `data-learned-read="incomplete"` on the root, the counts still beside the
// heading, and no rows. It is not a sixth STATE — the chain really did settle — which is why the
// fact rides its own attribute instead of a state word the curation chip could not mirror.
//
// AND A SEVENTH: rows, or an unsettled-chain sentence, with the READ NOTE beneath, when the store
// was only partly readable (407-18 · REVIEW CR-01/WR-05). The op degrades its two Learned
// enrichments independently, so a served record and a partial read arrive together — the note is
// the person-visible half of `data-learned-read`, which is the cell-visible half. Neither half
// ever replaces the rows: a view handed records paints them and says the read was partial beside
// them.
//
// AND AN EIGHTH: rows with the CHAIN NOTE beneath them, when curation settled `failed` AFTER it
// had already committed change records (407-26 · REVIEW CR-01 · owner ruling 2026-08-31). A chain
// that fell over cannot un-commit what it wrote, so the records are painted and the chain's fate
// is stated beside them in `[data-learned-chain-note]`. The no-rows `failed` arm did not move: it
// still prints `Curation failed — nothing was learned from this run.` in the sentence slot, which
// is the one arm where nothing on screen falsifies it.
//
// ROWS WIN OVER SENTENCES, and that ordering lives in `learnedView`, not here. This file paints
// whatever the view carries: the projection never hands it both a populated list and a sentence,
// because a sentence beside rows would be a second, quieter account of the same records.
// THAT RULE IS WHY THE EIGHTH RENDERING NEEDED A NEW SLOT rather than a reworded sentence — a
// failed chain's fate travels in `chainNote`, beneath the rows, precisely so that the sentence
// contract above stays intact instead of being bent to carry a second account of the same list.
//
// NO SKELETON AND NO SPINNER, EVER. `pending` here is not "bytes are on their way"; it is a chain
// a daemon may not have picked up for hours (404's posture text exists for exactly that reason).
// A shimmer would promise an arrival nobody has scheduled.
//
// `data-learned-state`, `data-learned-count-line` and `data-record-change` (the bucket word, 427
// D-15) ARE THE CELL CONTRACT, never the visible text. 432-09: no pending-proposals line or
// review command remains; the half shows what changed. The jsdom cells here
// and the Playwright cells on the built bundle both address attributes, so a copy change moves
// `lib/knowledge-view.ts` and nothing else.
//
// NO ID, REFERENCE OR RECEIPT IS PAINTED ON A ROW. A row says what happened to a record
// in 425's five words and leads with the record's content; every id, raw event and link lives in
// Retrieval details (`retrieval-details.tsx`).
//
// ALL TEXT GOES THROUGH REACT TEXT NODES. No raw-HTML injection escape hatch appears anywhere in
// this file — a grep for React's one is an acceptance criterion. Summaries are stored producer
// strings, shown as written.

import { useId } from "react"
import { Archive, Check, CornerDownRight, Inbox, Plus, Replace, type LucideIcon } from "lucide-react"
import type { CurationBucket } from "@vostride/agent-qa-schema"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { KnowledgeRecordBody, RecordApplicability } from "./knowledge-record-body"
import {
  BUCKET_LABELS,
  BUCKET_MEANINGS,
  MEMORY_CHANGES_HEADING,
  WAS_PREFIX,
  sinceThisRunHeading,
  type LearnedRowView,
  type LearnedView,
} from "@/lib/knowledge-view"

/** A half heading: 16px/500 — explicitly `font-medium`, because the global `h4` rule is 600. */
const HEADING_CLASS = "text-base font-medium leading-snug"

const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"

// All five labels share one neutral tone; the glyph shape and the word carry the bucket (UI-SPEC).
const BUCKET_GLYPHS: Record<CurationBucket, LucideIcon> = {
  added: Plus,
  confirmed: Check,
  superseded: Replace,
  deprecated: Archive,
  proposed: Inbox,
}

/**
 * The Learned half — heading, count line, then either the rows or the state's sentence.
 *
 * THE COUNT LINE AND THE SENTENCE ARE DIFFERENT CLAIMS and both can be present. `curated 3 facts,
 * deprecated 1` says what the frozen row recorded; `Change records for this run are not available
 * yet.` says none of it reached this run's change log. Dropping either would leave a reader unable
 * to tell an unattributed change from a run that changed nothing.
 */
export function KnowledgeLearned({ view }: { view: LearnedView }) {
  const headingId = useId()
  const curationRows = view.rows.filter(row => row.section !== "since-then")
  const laterRows = view.rows.filter(row => row.section === "since-then")
  return (
    <section
      data-knowledge-section="changes"
      aria-labelledby={headingId}
      data-learned-state={view.state}
      {...(view.scanIncomplete === true ? { "data-learned-read": "incomplete" } : {})}
      data-learned-snapshot={view.curationSnapshot === undefined ? "absent" : "recorded"}
      {...(view.curationSnapshot?.sinceThenCount === undefined
        ? {}
        : { "data-learned-since-then": String(view.curationSnapshot.sinceThenCount) })}
      className="space-y-2"
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <h4 id={headingId} className={HEADING_CLASS}>{MEMORY_CHANGES_HEADING}</h4>
        {view.countLine === undefined ? null : (
          <span data-learned-count-line className="text-xs text-muted-foreground tabular-nums">
            {view.countLine}
          </span>
        )}
      </div>

      {/*
        WHAT THE COUNT LINE COULD NOT RECORD, LABELLED. A pre-423 pair is a
        coarser measurement, not a breakdown with three buckets missing, and a withheld snapshot
        is a refusal rather than a zero — so the absence gets its own paragraph beneath the
        heading row. It is a SECOND ELEMENT and not a second clause on the count line, so a reader
        scanning counts reads counts, and a cell can assert the absence rather than a substring.
      */}
      {view.countNote === undefined ? null : (
        <p data-learned-count-note className="text-xs text-muted-foreground">
          {view.countNote}
        </p>
      )}

      {/*
        THE GAP, AND THEN ITS CAUSE. Two paragraphs rather than one sentence: the
        first is arithmetic a reader can check against the rows below it, the second is an account
        of that arithmetic the read had to justify. The block sits directly under the counts it
        reconciles — a mismatch explained at the bottom of a long list is a mismatch a reader
        scrolls past — and it is ABSENT, never blank, on every run whose numbers agree.
      */}
      {view.curationSnapshot?.reconciliation === undefined ? null : (
        <div data-learned-reconciliation className="space-y-1">
          <p
            data-learned-reconciliation-count
            className="text-xs text-muted-foreground tabular-nums"
          >
            {view.curationSnapshot.reconciliation.count}
          </p>
          <p
            data-learned-reconciliation-cause
            className="text-xs text-muted-foreground tabular-nums"
          >
            {view.curationSnapshot.reconciliation.cause}
          </p>
        </div>
      )}

      {view.sentence === undefined ? null : (
        <p data-learned-sentence data-section-absence className="text-sm text-muted-foreground">
          {view.sentence}
        </p>
      )}

      {curationRows.length === 0 ? null : (
        <ul className="divide-y divide-border">
          {curationRows.map(row => (
            <BucketRow key={row.key} row={row} />
          ))}
        </ul>
      )}

      {/*
        LATER CHANGES STAND APART, OPEN. They happened after this run's curation, so
        they never enter the heading's breakdown and read under their own heading.
      */}
      {laterRows.length === 0 ? null : (
        <div data-since-this-run={String(laterRows.length)} className="space-y-1 pt-2">
          <h5 className="text-xs font-medium text-muted-foreground tabular-nums">
            {sinceThisRunHeading(laterRows.length)}
          </h5>
          <ul className="divide-y divide-border">
            {laterRows.map(row => (
              <BucketRow key={row.key} row={row} />
            ))}
          </ul>
        </div>
      )}

      {/*
        THE CHAIN'S FATE, BENEATH THE RECORDS AND NEVER INSTEAD OF THEM (407-26 · REVIEW CR-01 /
        G-407-12 · owner ruling 2026-08-31). The rows above are what a failed chain committed
        before it stopped; this paragraph says what happened to the chain that wrote them. It rides
        under the list, so a reader is never shown a sentence standing where the records should be.

        IT REPORTS THE CHAIN; THE PARAGRAPH BELOW REPORTS THE READ. That is why they are two
        elements and not one: the op degrades those two enrichments independently, so a view
        carrying both facts prints both, each addressable on its own attribute.

        CHAIN FIRST, THEN READ, because this note is about the list a reader is already looking at
        and the one below is about how much of the store anyone could see at all.
      */}
      {view.chainNote === undefined ? null : (
        <p data-learned-chain-note className="text-xs text-muted-foreground">
          {view.chainNote}
        </p>
      )}

      {/*
        BENEATH the answer, never instead of it. `readNote` is present exactly where the view was
        degraded AND is not already printing the unreadable-store sentence, so this paragraph and
        `[data-learned-sentence]` never both name the store.
      */}
      {view.readNote === undefined ? null : (
        <p data-learned-read-note className="text-xs text-muted-foreground">
          {view.readNote}
        </p>
      )}
    </section>
  )
}

/**
 * One affected record: its bucket word, then what it says. A supersession leads with
 * the new version and reads the old one on a Was: line; a Proposed row says it was recorded and not applied;
 * a later change says what happened later. Where it applies and the full record are the same
 * components a used row shows.
 */
function BucketRow({ row }: { row: LearnedRowView }) {
  return (
    <li
      data-record-change={row.bucket}
      {...(row.section === undefined ? {} : { "data-learned-section": row.section })}
      className="py-2 space-y-1"
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <BucketLabel bucket={row.bucket} />
        <span data-row-primary className="text-sm wrap-anywhere">
          {row.primary}
        </span>
        {row.note === undefined ? null : (
          <span data-proposed-note className="text-xs text-muted-foreground">
            · {row.note}
          </span>
        )}
      </div>
      {row.was === undefined ? null : (
        <p data-superseded-was className="flex items-baseline gap-1 text-xs text-muted-foreground wrap-anywhere">
          <CornerDownRight className="size-3 shrink-0" aria-hidden />
          <span>
            {WAS_PREFIX} {row.was.primary}
          </span>
        </p>
      )}
      {row.applicability === undefined ? null : <RecordApplicability view={row.applicability} />}
      {row.sinceDetail === undefined ? null : (
        <p data-since-detail className="text-xs text-muted-foreground">{row.sinceDetail}</p>
      )}
      {row.content === undefined ? null : <KnowledgeRecordBody content={row.content} />}
    </li>
  )
}

/**
 * A bucket word a reader can focus to learn what it means (427 D-16, the 425 D-10 trigger idiom).
 * The visible word is `BUCKET_LABELS[bucket]` and names the button; the meaning is the tooltip and
 * the button's description, so it is announced without hover.
 */
function BucketLabel({ bucket }: { bucket: CurationBucket }) {
  const Glyph = BUCKET_GLYPHS[bucket]
  const meaningId = useId()
  return (
    <Tooltip>
      {/* The trigger's own described-by replaces Radix's open-time one, so the meaning is announced once, open or closed. */}
      <TooltipTrigger asChild>
        <button
          type="button"
          data-bucket-label={bucket}
          aria-describedby={meaningId}
          className={`inline-flex items-center gap-1 cursor-help rounded-sm text-xs font-medium uppercase tracking-wider text-muted-foreground underline decoration-dotted underline-offset-4 ${FOCUS_RING}`}
        >
          <Glyph className="size-3" aria-hidden />
          {BUCKET_LABELS[bucket]}
        </button>
      </TooltipTrigger>
      <span id={meaningId} hidden>{BUCKET_MEANINGS[bucket]}</span>
      <TooltipContent side="bottom" align="start" sideOffset={4} className="max-w-[320px] text-left">
        {BUCKET_MEANINGS[bucket]}
      </TooltipContent>
    </Tooltip>
  )
}
