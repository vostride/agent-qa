// Text nodes, never markup; the clipboard carries exactly what is rendered.

import { useState } from "react"
import { AlertCircle, Check, ChevronRight, Copy } from "lucide-react"

import { truncateText } from "@/lib/display-text"
import { cn } from "@/lib/utils"

// Fixtures derive their word ordinals from this; fix a drifting fixture, never widen the number.
export const FAILURE_BANNER_PREVIEW_WORDS = 20

/** What the last copy attempt did — `idle` until one is made, and back to `idle` after a moment. */
type CopyStatus = "idle" | "copied" | "failed"

/**
 * What the live region says, per outcome.
 *
 * A CHECK MARK IS NOT AN ANNOUNCEMENT. The tick is the only confirmation this button has ever
 * given, and it is invisible to a screen reader: the button carried a `title` and no accessible
 * name, and the outcome was a swapped icon inside a `polite`-less subtree. Sighted feedback and
 * announced feedback are the same fact in two media, so they are derived from the same state.
 */
const COPY_ANNOUNCEMENT: Record<CopyStatus, string> = {
  idle: "",
  copied: "Failure summary copied to the clipboard",
  failed: "Could not copy the failure summary to the clipboard",
}

export function FailureBanner({ summary }: { summary: string }) {
  const [open, setOpen] = useState(false)
  const [copyStatus, setCopyStatus] = useState<CopyStatus>("idle")
  const preview = truncateText(summary, FAILURE_BANNER_PREVIEW_WORDS)

  // WHAT IS RENDERED, NOT WHAT WAS PRESSED. `data-failure-banner-state` is the attribute every DOM
  // cell reads to say which of the two claims it is making, so it has to describe the TEXT on the
  // page. Derived from `open` alone it was a constant on mount — `truncated` for every input,
  // including a summary that was never over the budget and a summary whose truncation had stopped
  // running entirely — and a cell that asserted `truncated` there was asserting `useState(false)`.
  // A banner showing all of its summary is `full` whether the reader got there by pressing the
  // chevron or by the sentence being short enough not to need one.
  const showingFull = open || !preview.isTruncated

  const announce = (outcome: Exclude<CopyStatus, "idle">) => {
    setCopyStatus(outcome)
    setTimeout(() => setCopyStatus("idle"), 2000)
  }

  // THE SAME EXPRESSION AS THE RENDER, SPELLED OUT RATHER THAN HOISTED, so the clipboard carries
  // exactly what the page renders and a change to one site that the other does not mirror shows in
  // review.
  //
  // The tick means the write resolved; `writeText` may reject, or be absent in an insecure context.
  const handleCopy = () => {
    const written = navigator.clipboard?.writeText(open ? summary : preview.text)
    if (written === undefined) {
      announce("failed")
      return
    }
    void written.then(() => { announce("copied") }, () => { announce("failed") })
  }

  return (
    <div
      data-failure-banner
      data-failure-banner-state={showingFull ? 'full' : 'truncated'}
      className="mx-2 mt-2 rounded-[2px] border border-red-500/20 bg-red-500/5 px-3 py-2 shrink-0"
    >
      <div className="flex items-start gap-2">
        <AlertCircle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" aria-hidden="true" />
        <span
          data-failure-banner-text
          className="flex-1 text-sm text-foreground/80 select-text"
        >
          {open ? summary : preview.text}
        </span>
        <button
          data-failure-banner-copy
          data-copy-status={copyStatus}
          onClick={handleCopy}
          className="shrink-0 mt-0.5 p-0.5 rounded-sm hover:bg-red-500/10 transition-colors"
          aria-label="Copy failure summary"
          title="Copy failure summary"
        >
          {copyStatus === "copied"
            ? <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
            : <Copy
                className={cn(
                  "h-3.5 w-3.5",
                  copyStatus === "failed" ? "text-red-400" : "text-muted-foreground",
                )}
                aria-hidden="true"
              />
          }
        </button>
        {/*
          THE OUTCOME, SAID OUT LOUD. `role="status"` is an implicit `aria-live="polite"`; both are
          written because the pair is what assistive technology has historically needed, and an
          empty node that is present from first paint is what makes the announcement fire — a region
          inserted at the same moment its text appears is frequently not announced at all.

          OUTSIDE `[data-failure-banner-text]` DELIBERATELY. That element's `textContent` is the
          sentence the clipboard is measured against by the conformance cell (3g); a confirmation
          message inside it would make the page's own text disagree with the copy of it.
        */}
        <span
          data-failure-banner-copy-status
          role="status"
          aria-live="polite"
          className="sr-only"
        >
          {COPY_ANNOUNCEMENT[copyStatus]}
        </span>
        {preview.isTruncated && (
          <button
            data-failure-banner-toggle
            aria-label={open ? "Show less" : "Show full failure summary"}
            onClick={() => setOpen(o => !o)}
            className="shrink-0 mt-0.5 p-0.5 rounded-sm hover:bg-red-500/10 transition-colors"
          >
            <ChevronRight
              aria-hidden="true"
              className={cn(
                "h-3.5 w-3.5 text-muted-foreground transition-transform",
                open && "rotate-90"
              )}
            />
          </button>
        )}
      </div>
    </div>
  )
}
