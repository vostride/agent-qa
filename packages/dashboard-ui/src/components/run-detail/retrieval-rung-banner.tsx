// THE RUNG A RUN WAS SERVED ON, ON THE SURFACE A PERSON LOOKS AT (407-10 · TRST-01, D-13..D-16).
//
// ONE COMPONENT, TWO FEEDS. Run-detail paints it from `runs.knowledge`'s durable projection —
// the rung the runner recorded into step evidence at serve time — and the live page paints it
// from the first `stepFinalized` frame that carries the same value. Two feeds and two placements,
// but the SAME sentence: a person who watches a run and then opens its detail page must not read
// two different accounts of one machine, and the surest way to guarantee that is for there to be
// only one place the sentence is built.
//
// IT IS PRESENTATIONAL AND IT NEVER PROBES. Nothing here asks the host anything. The value
// arrives as a prop from evidence, so a run served on the static floor stays labelled that way
// forever — fixing the machine tomorrow must not rewrite what yesterday's run says about itself.
// That is why the banner points at `agent-qa doctor` instead of trying to be it: the banner is
// about the RUN, `doctor` is about the HOST, and they are different questions.
//
// AMBER, NEVER RED (D-19's rationale, applied to the header). A degraded rung is a rung reached by
// design: the static floor is the no-budget escape hatch and `lexical-only` means the floor was
// switched off on purpose. `fail` is a doctor-only state for a subsystem that ERRORED, and this
// banner never sees one — a run that got served got a rung. A red strip would teach operators to
// ignore it on every deliberately-degraded install, which is precisely how a warning stops working.
//
// TWO ABSENCES RENDER NOTHING. `memidex` is the top rung, so there is nothing to warn about; an
// undefined rung is "nobody has said yet" — the live header before its first evidence-carrying
// frame, a pre-407 run, or a project with no reader bound. Rendering an empty strip for the
// first would put amber across every healthy run; rendering "unknown" for the second would claim a
// fact the page does not have. The absence of the element IS the statement.
//
// ONLY WARNINGS REACH THE HEADER. A fresh index, an unrecorded cause and a configured
// level are information: the Knowledge tab states them and this strip stays silent. A locked or
// corrupt index and unavailable semantic search paint it, with the class glyph and the doctor pointer.

import { retrievalClassFor, rungBannerText } from "@/lib/knowledge-view"
import { cn } from "@/lib/utils"
import type { RetrievalRung, RetrievalRungReason } from "@vostride/agent-qa-schema"

import { RETRIEVAL_CLASS_GLYPHS, doctorSentenceNodes } from "./retrieval-statement"

export interface RetrievalRungBannerProps {
  /** The recorded rung word. Absent means "not known yet" — see the header note. */
  rung?: RetrievalRung
  /** The recorded cause. Absent on `memidex`, and (historically) reachable absent on a lower rung. */
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
  // rungBannerText answers only for the two warning classes, so a fresh index, an
  // unrecorded cause and a configured level paint nothing here and are stated in the tab instead.
  if (rung === undefined || sentence === undefined || retrievalClass === undefined) return null

  // THE DOM CONTRACT IS SPELLED OUT AT BOTH RENDER SITES, not hoisted into a shared spread. The
  // five attributes below are what 407-11's parity cell and the Playwright DOM cells address, and
  // a hoisted object would leave a mutation that drops one of them matching nothing to grep for.
  // `data-rung-reason={reason}` is absent-when-undefined by React's own rule — an EMPTY attribute
  // would read as a cause somebody measured to be nothing.

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
