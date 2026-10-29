// ONE MEMBER OF A RUN, AND EVERYTHING RECORDED BENEATH IT.
//
// PRESENTATIONAL, AND DELIBERATELY SO. This component takes a group the page already folded out of
// `runs.detail` and paints it. It fetches nothing, holds no run id, and derives no fact — the
// grouping, the filter and every sentence it renders come from `lib/run-detail-view.ts`, which is
// pure and separately pinned.
//
// A MEMBER THAT NEVER RAN IS NOT AN EMPTY BOX. Its stream began with a terminal event, so
// the projection wrote the member row and no steps. Rendering that as blank space under a header
// reads as "it passed everything"; rendering it with the did-not-run note, its persisted outcome
// and the producer's own `failureSummary` says what actually happened.
//
// THE OUTCOME BADGE IS ON EVERY MEMBER THAT HAS AN OUTCOME, PASSED ONES INCLUDED.
// 405-08 put it only on a member that did not run, because 405 D-16 was explicit that per-member
// verdicts beside the aggregate were 406's DETL-04 and were not to be pre-claimed here. 406 D-07 is
// that decision arriving, and it supersedes the paragraph this one replaces. The badge is painted
// through `statusBadgeLook` — the RUN verdict badge's own palette, lifted into `lib/status.ts` so
// there is exactly one definition — so a header reading "one aggregate + N members" reads one
// vocabulary rather than two that happen to agree today. The attribute carries the RAW word and the
// text carries the label, for the same reason the navbar's badge does.
//
// THREE SENTENCES, THREE SPEAKERS. The did-not-run note is this product's; `failureSummary` is the
// runner's; the verdict block under a failed member is the ANALYSIS's, rendered in its
// own component below the header and above the steps. They are rendered side by side rather than
// concatenated, because a reader is entitled to know which claim came from where (405-06's
// `memberNote` decision, restated in markup, now with a third voice on the page). The analysis
// never merges with the runner's line: two producers, two blocks.
//
// `failureSummary` is a PRODUCER string and is rendered as the stored text, so a declared value
// shows as the `[secret:<name>]` the producer recorded. React escapes it into a text node.

import { useState, type ReactNode } from "react"
import { ChevronRight } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { VerdictBlock } from "@/components/run-detail/verdict-block"
import { MarkGlyph } from "@/components/run-detail/feedback-entry"
import { feedbackAddress } from "@/lib/feedback-view"
import type { MemberVerdictView } from "@/lib/analysis-view"
import { statusBadgeLook } from "@/lib/status"
import { cn } from "@/lib/utils"
import {
  memberDisplayName,
  memberHandleLabel,
  memberNote,
  reranLabel,
  type RunDetailGroup,
} from "@/lib/run-detail-view"

interface MemberGroupProps {
  group: RunDetailGroup
  /** Whether this run has more than one member — a single-member run gets no grouping chrome. */
  showChrome: boolean
  /**
   * This member's verdict, when `analysis.get` had one for it.
   *
   * ABSENT IS THE COMMON CASE AND IT RENDERS NOTHING. A passed member has no verdict at all —
   * `resolveRunVerdicts` filters `passed | skipped | cancelled` — and a run whose analysis has not
   * been read yet has none for anybody. Neither is an empty block; both are no block.
   */
  verdict?: MemberVerdictView
  /**
   * What a cited step, a cluster sibling and a cited artifact DO.
   *
   * OPTIONAL, AND THE DEFAULT IS A NO-OP, matching `verdict` above and `analysisView` on the tree.
   * A member group mounted without them — every cell in this file that is about grouping rather
   * than about the failure view — renders the same markup and clicks nowhere. The page supplies
   * both; nothing here resolves a step id or writes a search param.
   */
  onCitedStep?: (testIndex: number, stepIndex: number) => void
  onSelectMember?: (testIndex: number) => void
  onCitedArtifact?: (sha: string) => void
  children?: ReactNode
}

/** The default for every handle above, spelled once so the call sites cannot drift. */
const NO_OP = () => {}

/** The did-not-run body: this product's note, the persisted outcome, and the runner's own line. */
function ThinMemberBody({ group }: { group: RunDetailGroup }) {
  const note = memberNote(group.member, group)
  const { failureSummary } = group.member

  return (
    <div className="mx-2 mb-1.5 rounded-[2px] border border-border/60 bg-muted/10 px-3 py-2 text-xs text-muted-foreground">
      <span data-member-note>{note}</span>
      {failureSummary ? (
        <span data-member-failure-summary className="ml-2 select-text text-foreground/70">
          {failureSummary}
        </span>
      ) : null}
    </div>
  )
}

export function MemberGroup({
  group,
  showChrome,
  verdict,
  onCitedStep = NO_OP,
  onSelectMember = NO_OP,
  onCitedArtifact = NO_OP,
  children,
}: MemberGroupProps) {
  const [open, setOpen] = useState(true)
  const { member } = group
  const isThin = group.steps.length === 0
  const rerun = reranLabel(member.attempts)
  // ONE PALETTE FOR THE AGGREGATE AND EVERY MEMBER. `undefined` where the projection
  // recorded no outcome at all — an absent word is not a word to paint, and defaulting it would put
  // a confident badge on a member nobody graded.
  const outcomeLook = member.outcome === undefined ? undefined : statusBadgeLook(member.outcome)
  // the whole-test trace. The header door carries it on a single-test run, which has no
  // member header.
  const testMark = member.marks?.find((entry) => entry.stepIndex === undefined)

  const body = isThin ? <ThinMemberBody group={group} /> : <ul role="group">{children}</ul>

  // THE WHY, DIRECTLY UNDER THE HEADER AND ABOVE THE STEPS. The sentence sits beside the
  // steps it cites rather than in a panel of its own, so the member filter narrows both at once.
  const verdictBlock = verdict === undefined ? null : (
    <VerdictBlock
      view={verdict}
      onCitedStep={onCitedStep}
      onSelectMember={onSelectMember}
      onCitedArtifact={onCitedArtifact}
    />
  )

  // No chrome, and the member ran: the steps stand on their own directly under the tree. A
  // single-member failed run still gets its sentence — the block is what the reader came for, and
  // withholding it because there is one member would make the view conditional on suite shape.
  if (!showChrome) {
    if (isThin) return <li role="none">{verdictBlock}{body}</li>
    // Wrapped in its own `role="none"` row: the parent is a `role="tree"` list, and a bare `div`
    // between its items would be a child the tree role does not admit.
    return <>{verdictBlock === null ? null : <li role="none">{verdictBlock}</li>}{children}</>
  }

  return (
    <li role="none" data-member={String(member.testIndex)}>
      <div className="mt-3 mb-1 flex items-center gap-2 bg-muted/30 px-3 py-1.5 text-xs font-medium text-muted-foreground first:mt-0">
        <button
          type="button"
          data-member-toggle
          {...(verdict === undefined ? {} : { "data-member-has-verdict": "" })}
          aria-expanded={open}
          aria-label={memberDisplayName(member)}
          onClick={() => setOpen((prev) => !prev)}
          className="shrink-0 rounded-sm p-0.5 transition-colors hover:bg-muted/60"
        >
          <ChevronRight className={cn("h-3 w-3 transition-transform", open && "rotate-90")} />
        </button>
        <span className="min-w-0 truncate">{memberDisplayName(member)}</span>
        <span data-member-handle className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
          {memberHandleLabel(member.testIndex)}
        </span>
        {testMark === undefined ? null : (
          <MarkGlyph scope="test" target={feedbackAddress({ testIndex: member.testIndex })} kind={testMark.kind} />
        )}
        {rerun ? (
          <span data-member-rerun className="shrink-0 text-[10px] text-amber-500">
            {rerun}
          </span>
        ) : null}
        {outcomeLook === undefined ? null : (
          <Badge
            data-member-outcome={member.outcome}
            variant={outcomeLook.variant}
            className={cn(
              "ml-auto shrink-0 text-[10px] uppercase tracking-wide",
              outcomeLook.className,
            )}
          >
            {outcomeLook.label}
          </Badge>
        )}
      </div>
      {open ? verdictBlock : null}
      {open ? body : null}
    </li>
  )
}
