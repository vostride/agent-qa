// Paints whatever `learnedView` carries: rows or a sentence, with chain and read notes below.

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

// All labels share one neutral tone; the glyph shape and the word carry the bucket.
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

      {/* A separate paragraph, not a count-line clause, so a cell can assert the absence. */}
      {view.countNote === undefined ? null : (
        <p data-learned-count-note className="text-xs text-muted-foreground">
          {view.countNote}
        </p>
      )}

      {/* The gap, then its cause, under the counts; absent, never blank, when numbers agree. */}
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

      {/* Later changes come after this run's curation, so they sit under their own heading. */}
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

      {/* The chain's fate under the records it committed; the read note is its own element. */}
      {view.chainNote === undefined ? null : (
        <p data-learned-chain-note className="text-xs text-muted-foreground">
          {view.chainNote}
        </p>
      )}

      {/* Beneath the answer, never instead of it, nor beside the unreadable-store sentence. */}
      {view.readNote === undefined ? null : (
        <p data-learned-read-note className="text-xs text-muted-foreground">
          {view.readNote}
        </p>
      )}
    </section>
  )
}

// A supersession leads with the new version and shows the old on a Was: line.
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

// The meaning is the tooltip and the button's description, so it is announced without hover.
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
