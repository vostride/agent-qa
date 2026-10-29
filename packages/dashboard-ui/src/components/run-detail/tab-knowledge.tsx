// Presentational and total: every state renders a sentence or skeleton; every string is imported.

import { Skeleton } from "@/components/ui/skeleton"
import { EvidenceIncomplete } from "./evidence-incomplete"
import { KnowledgeEffect } from "./knowledge-effect"
import { KnowledgeLearned } from "./knowledge-learned"
import { KnowledgeUsed } from "./knowledge-used"
import { RetrievalDetails } from "./retrieval-details"
import { type KnowledgeView, type StepRefContext } from "@/lib/knowledge-view"

/** The tab body's own padding and rhythm, inside `TabsContent` and `ScrollArea`. */
const CONTENT_CLASS = "px-3 py-4 space-y-4"

/** A half heading: 16px/500 — explicitly `font-medium`, because the global `h4` rule is 600. */
const HEADING_CLASS = "text-base font-medium leading-snug"

/** A page-level body sentence. `break-words` so a long masked error wraps inside the pane. */
const BODY_CLASS = "text-sm text-muted-foreground break-words"

export function TabKnowledge({ view, stepRefs }: { view: KnowledgeView | undefined; stepRefs?: StepRefContext }) {
  // THE READ HAS NOT LANDED. Three bars and no words — the chips' `…` posture, which says nobody
  // has answered yet rather than guessing at what the answer will be.
  if (view === undefined) {
    return (
      <div data-knowledge-state="loading" className={CONTENT_CLASS}>
        <div className="space-y-2">
          <Skeleton className="h-4" />
          <Skeleton className="h-4" />
          <Skeleton className="h-4" />
        </div>
      </div>
    )
  }

  if (view.state === "error") {
    return (
      <div data-knowledge-state="error" className={CONTENT_CLASS}>
        <h4 className={HEADING_CLASS}>{view.heading}</h4>
        <p className={BODY_CLASS}>{view.body}</p>
      </div>
    )
  }

  // The shared component owns the missing-bytes words and its `py-12`, so add horizontal padding.
  if (view.state === "evidence-incomplete") {
    return (
      <div data-knowledge-state="evidence-incomplete" className="px-3">
        <EvidenceIncomplete variant="pane" />
      </div>
    )
  }

  if (view.state === "empty-no-store") {
    return (
      <div data-knowledge-state="empty-no-store" className={CONTENT_CLASS}>
        <h4 className={HEADING_CLASS}>{view.heading}</h4>
        <p className={BODY_CLASS}>{view.body}</p>
      </div>
    )
  }

  // Sections in `KNOWLEDGE_SECTIONS` order, the ledger collapsed last; Memory changes always shows.
  return (
    <div data-knowledge-state="ready" className="px-3 py-4 space-y-6">
      <KnowledgeUsed view={view.used} stepRefs={stepRefs} />
      <KnowledgeEffect view={view.effect} stepRefs={stepRefs} testNames={stepRefs?.testNames} />
      <KnowledgeLearned view={view.learned} />
      <RetrievalDetails ledger={view.ledger} />
    </div>
  )
}
