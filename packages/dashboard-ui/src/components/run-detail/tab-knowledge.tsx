// THE KNOWLEDGE TAB SHELL.
//
// IT IS PRESENTATIONAL AND KNOWS NO RUN. It takes a view and paints it. It reads nothing, fetches
// nothing and mints no route — the page owns the one `runs.knowledge` client (D-05's "one read,
// one shape"), and a tab that could fetch for itself would open a client per mount of a component
// the tab strip remounts, and would be a second answer to "what does this page know about this
// run's brief".
//
// FIVE STATES, AND FOUR OF THEM ARE ABSENCES. `undefined` is the read that has not landed; the
// other four come from the projection. Every one renders a sentence or a skeleton, and none of
// them renders blank: a blank pane behind a tab someone pressed `7` to reach cannot be told apart
// from a broken op, which is the whole reason D-06 made the pruned-handoff case a RESULT.
//
// `data-knowledge-state` IS THE CELL CONTRACT, never the visible text. The jsdom cells here and
// the later plans' Playwright cells on the built bundle both address attributes, so a copy change
// moves `lib/knowledge-view.ts` and nothing else.
//
// EVERY STRING IS IMPORTED. Not one sentence is typed in this file. The `data-*` raw
// words (`none` / `procedure-replay` / `procedure-hint`) are not sentences — they are the
// projection's own vocabulary, forwarded unchanged so a cell can read the fact rather than a
// rendering of it.
//
// ALL TEXT GOES THROUGH REACT TEXT NODES. No raw-HTML injection escape hatch appears anywhere in
// this file — a grep for React's one is an acceptance criterion. Step text and masked errors are
// producer strings crossing the display seam, and the hostile-text cells assert that an
// `<img onerror=…>` in either one creates no element.

import { Skeleton } from "@/components/ui/skeleton"
import { EvidenceIncomplete } from "./evidence-incomplete"
import { KnowledgeEffect } from "./knowledge-effect"
import { KnowledgeLearned } from "./knowledge-learned"
import { KnowledgeUsed } from "./knowledge-used"
import { RetrievalDetails } from "./retrieval-details"
import { type KnowledgeView, type StepRefContext } from "@/lib/knowledge-view"

/** The tab body's own padding and rhythm (UI-SPEC: `TabsContent` → `ScrollArea` → this div). */
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

  // The shipped component owns the words for "the bytes are gone", and it supplies its
  // own `py-12` — so this arm adds horizontal padding only (UI-SPEC Spacing: do not add more).
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

  // four sections in KNOWLEDGE_SECTIONS order; the per-step ledger sits collapsed
  // at the foot, and Memory changes renders on every ready run so each heading always states itself.
  return (
    <div data-knowledge-state="ready" className="px-3 py-4 space-y-6">
      <KnowledgeUsed view={view.used} stepRefs={stepRefs} />
      <KnowledgeEffect view={view.effect} stepRefs={stepRefs} testNames={stepRefs?.testNames} />
      <KnowledgeLearned view={view.learned} />
      <RetrievalDetails ledger={view.ledger} />
    </div>
  )
}
