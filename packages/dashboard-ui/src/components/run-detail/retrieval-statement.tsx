// The class comes from the recorded rung, so nothing probes; `role="note"`, as nothing is live.

import {
  CircleQuestionMark,
  PackageOpen,
  SearchX,
  SlidersHorizontal,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react"

import type { RetrievalClass, RetrievalStatementView } from "@/lib/knowledge-view"

/** The literal command the pointer names, kept as a constant so the mono split cannot mistype it. */
const DOCTOR_COMMAND = "agent-qa doctor"

/**
 * The sentence, with its command in `font-mono` and its bytes unchanged.
 *
 * SPLIT BY INDEX, NOT BY TEMPLATE. The DOM cells read `textContent`, so the split has to be a
 * partition of the very string the view returned: with no backticks in the constant, the element's
 * text equals it byte for byte.
 */
export function doctorSentenceNodes(sentence: string) {
  const at = sentence.indexOf(DOCTOR_COMMAND)
  if (at < 0) return sentence
  return (
    <>
      {sentence.slice(0, at)}
      <code className="font-mono">{DOCTOR_COMMAND}</code>
      {sentence.slice(at + DOCTOR_COMMAND.length)}
    </>
  )
}

export const RETRIEVAL_CLASS_GLYPHS: Record<RetrievalClass, LucideIcon> = {
  "fresh-index": PackageOpen,
  "cause-not-recorded": CircleQuestionMark,
  "index-problem": TriangleAlert,
  "semantic-search-unavailable": SearchX,
  "by-configuration": SlidersHorizontal,
}

export function RetrievalStatement({ view }: { view: RetrievalStatementView }) {
  const Glyph = RETRIEVAL_CLASS_GLYPHS[view.retrievalClass]

  if (view.tone === "info") {
    return (
      <p
        data-retrieval-statement
        data-retrieval-class={view.retrievalClass}
        data-retrieval-tone="info"
        data-rung={view.rung}
        data-rung-reason={view.reason}
        className="flex items-start gap-1 text-xs text-muted-foreground"
      >
        {/* mt-0.5: the declared 2px optical offset that seats a 14px glyph on the first line. */}
        <Glyph className="size-3.5 mt-0.5 shrink-0" aria-hidden="true" />
        <span>{view.sentence}</span>
      </p>
    )
  }

  return (
    <div
      data-retrieval-statement
      data-retrieval-class={view.retrievalClass}
      data-retrieval-tone="warning"
      data-rung={view.rung}
      data-rung-reason={view.reason}
      role="note"
      className="flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2"
    >
      <Glyph className="size-3.5 mt-0.5 shrink-0 text-amber-500" aria-hidden="true" />
      <div className="space-y-1">
        <p className="text-sm">{view.sentence}</p>
        {view.pointer === undefined ? null : (
          <p data-doctor-pointer className="text-xs text-muted-foreground">
            {doctorSentenceNodes(view.pointer)}
          </p>
        )}
      </div>
    </div>
  )
}
