// Presentational: the note, `failureSummary` and the verdict block sit side by side, unmerged.

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
  // Absent is the common case and renders no block.
  verdict?: MemberVerdictView
  // Optional with a no-op default, so a group mounted without them clicks nowhere.
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
  // `undefined` when no outcome is recorded, so no badge grades a member nobody graded.
  const outcomeLook = member.outcome === undefined ? undefined : statusBadgeLook(member.outcome)
  // The whole-test trace; on a single-test run the header door carries it.
  const testMark = member.marks?.find((entry) => entry.stepIndex === undefined)

  const body = isThin ? <ThinMemberBody group={group} /> : <ul role="group">{children}</ul>

  // The verdict sits above the steps it cites, so the member filter narrows both at once.
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
