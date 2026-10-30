// Amber, never red, and never a probe: the banner states the recorded rung and points at `doctor`.

import { retrievalClassFor, rungBannerText } from "@/lib/knowledge-view"
import { cn } from "@/lib/utils"
import type { RetrievalRung, RetrievalRungReason } from "@vostride/agent-qa-schema"

import { RETRIEVAL_CLASS_GLYPHS, doctorSentenceNodes } from "./retrieval-statement"

export interface RetrievalRungBannerProps {
  /** The recorded rung word. Absent means "not known yet" — see the header note. */
  rung?: RetrievalRung
  // The recorded cause; absent on `memidex` and optional on a lower rung.
  reason?: RetrievalRungReason
  /**
   * Which header is asking.
   *
   * `navbar` is a full-width 28px strip row under run-detail's `h-14` navbar; `live` is a `<p>`
   * that joins live-run's existing meta strip beside `data-gap-marker` and `data-run-notice`.
   * Two chromes because the two headers ARE different — but one sentence, which is the part that
   * has to agree.
   */
  variant?: "navbar" | "live"
}

export function RetrievalRungBanner({ rung, reason, variant = "navbar" }: RetrievalRungBannerProps) {
  const recorded = rung === undefined ? undefined : {
    rung,
    ...(reason === undefined ? {} : { reason }),
  }
  const sentence = rungBannerText(recorded)
  const retrievalClass = recorded === undefined ? undefined : retrievalClassFor(recorded)
  // `rungBannerText` answers only for warning classes, so info classes paint nothing here.
  if (rung === undefined || sentence === undefined || retrievalClass === undefined) return null

  // The attributes are spelled at both render sites; `data-rung-reason` is absent, never empty.

  if (variant === "live") {
    // No icon: the strip's existing siblings carry none, and a lone glyph in a wrapping flex row
    // reads as a bullet rather than as a warning.
    return (
      <p
        data-rung-banner
        data-rung={rung}
        data-rung-reason={reason}
        data-retrieval-class={retrievalClass}
        role="status"
        title={sentence}
        className="text-amber-500"
      >
        {doctorSentenceNodes(sentence)}
      </p>
    )
  }

  const Glyph = RETRIEVAL_CLASS_GLYPHS[retrievalClass]

  return (
    <div
      data-rung-banner
      data-rung={rung}
      data-rung-reason={reason}
      data-retrieval-class={retrievalClass}
      role="status"
      title={sentence}
      className={cn(
        "flex items-center gap-2 border-b border-amber-500/20 bg-amber-500/5",
        // 6 + 16 + 6 = 28px. The one non-scale vertical value in this header, and it exists so the
        // block never grows past the 56px navbar plus this row.
        "px-4 py-1.5 text-xs text-foreground/80",
      )}
    >
      <Glyph className="h-4 w-4 text-amber-500 shrink-0" aria-hidden="true" />
      {/* The sentence truncates; the whole of it stays reachable in the wrapper's `title`. */}
      <span className="truncate">{doctorSentenceNodes(sentence)}</span>
    </div>
  )
}
