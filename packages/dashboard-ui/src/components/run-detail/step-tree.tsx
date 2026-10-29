// THE RUN-DETAIL STEP TREE, GROUPED BY MEMBER.
//
// WHAT THIS REPLACED. Until 405-08 the tree took a flat `DisplayStep[]` plus a second prop holding
// the suite's child RUN ROWS — fetched by walking the parent's child list and re-reading each child
// run — and grouped by `step.runId`. 405-07 deleted that walk and the v1 step table it read, and
// 402 D-10 replaced child runs with per-member HANDLES on one run. So the tree now takes the
// durable projection's own grouping: one group per member, in handle order, and no second read.
//
// ONE FLATTENING, TWO SURFACES. The page needs the same numbered `DisplayStep[]` this tree draws —
// for selection, hotkeys, deep links and the panels — so both call `displayStepsForGroups`. Two
// independent flattenings that agreed today would be two that can disagree tomorrow, and the
// disagreement would show as a deep link selecting a row the tree is not highlighting.
//
// INLINE LOGS ARE ATTACHED ONLY WHEN THERE IS ONE MEMBER, and that is a refusal to guess rather
// than a limitation. `ExecutionLogEntry` carries a `stepId` that is a step ORDINAL and a `runId`
// that is now the one run — it carries no member handle. On a multi-member run an ordinal names one
// step per member, so attaching by ordinal would show the same log under every member's step of
// that index. A log shown in no place is an absence; a log shown in three wrong places is a lie.

import { useMemo } from "react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { CheckCircle2, Circle, XCircle, Webhook } from "lucide-react"
import { cn, formatDuration } from "@/lib/utils"
import { MemberGroup } from "./member-group"
import { StepTreeItem } from "./step-tree-item"
import type { ExecutionLogEntry } from "@/lib/api"
import { displayStepsForGroups, type DisplayStep } from "@/lib/display-step"
import type { RunDetailGroup } from "@/lib/run-detail-view"
import type { MemberVerdictView } from "@/lib/analysis-view"
import { hasStepId, type Selection } from "@/lib/selection"
import { feedbackAddress } from "@/lib/feedback-view"
import type { Playhead } from '@/lib/playhead'

/** The step door's wiring: the page's composer, which address it is open on, and how to open it. */
export interface StepTreeFeedback {
  composerId: string
  expandedAddress?: string
  onOpenStep: (testIndex: number, stepIndex: number, opener: HTMLElement) => void
}

interface StepTreeProps {
  feedback?: StepTreeFeedback
  /** The member-grouped projection, already narrowed by the page's member filter. */
  groups: readonly RunDetailGroup[]
  /** Whether the RUN has more than one member — not whether the filter left more than one. */
  showMemberChrome?: boolean
  /**
   * The failure view, keyed by member handle.
   *
   * PASSED THROUGH, NEVER READ HERE. This tree owns no analysis fact: the page projects the map
   * from `analysis.get`'s bytes and this component hands each member its own entry, exactly as it
   * hands each member its group. An empty map is the honest state of a green run and of a page
   * whose first read has not landed.
   */
  analysisView?: ReadonlyMap<number, MemberVerdictView>
  /**
   * What a cited step, a cluster sibling and a cited artifact DO, handed straight down
   *
   * PASSED THROUGH, NEVER CALLED HERE, and optional for the same reason `analysisView` is: this
   * tree owns no analysis fact and no page state. Resolving a step ordinal to a selected row and
   * writing the member filter both belong to the page, which is the only thing that holds
   * `displaySteps` and the search params.
   */
  onCitedStep?: (testIndex: number, stepIndex: number) => void
  onSelectMember?: (testIndex: number) => void
  onCitedArtifact?: (sha: string) => void
  selection: Selection | null
  playhead?: Playhead | null
  onSelect: (sel: Selection | null) => void
  setupHooks?: ExecutionLogEntry[]
  teardownHooks?: ExecutionLogEntry[]
  inlineLogs?: ExecutionLogEntry[]
}

function HookTreeItem({ log, isSelected, onSelect }: {
  log: ExecutionLogEntry
  isSelected: boolean
  onSelect: () => void
}) {
  return (
    <li role="treeitem" aria-level={1} aria-selected={isSelected}>
      <button
        className={cn(
          "flex w-full items-center gap-2 py-1.5 px-3 text-left rounded-[2px] text-sm",
          "hover:bg-muted/50 transition-colors",
          isSelected && "bg-primary/10 ring-1 ring-primary/30"
        )}
        onClick={onSelect}
      >
        {log.status === 'passed' ? (
          <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />
        ) : log.status === 'running' ? (
          <Circle className="h-3 w-3 text-blue-500 shrink-0" />
        ) : (
          <XCircle className="h-3 w-3 text-red-500 shrink-0" />
        )}
        <Webhook className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className="flex-1 min-w-0 text-xs truncate">{log.name}</span>
        <span className="text-[10px] text-muted-foreground shrink-0">{formatDuration(log.duration)}</span>
      </button>
    </li>
  )
}

function SectionHeading({ title }: { title: string }) {
  return (
    <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
      {title}
    </div>
  )
}

function HookSection({ title, hooks, selection, onSelect }: {
  title: string
  hooks: ExecutionLogEntry[]
  selection: Selection | null
  onSelect: (sel: Selection | null) => void
}) {
  if (hooks.length === 0) return null

  return (
    <div>
      <SectionHeading title={title} />
      <div className="mx-2 mb-1.5 rounded-[2px] border border-border/70 bg-muted/15">
        <ul role="group">
          {hooks.map(hook => (
            <HookTreeItem
              key={hook.id}
              log={hook}
              isSelected={selection?.type === 'hook' && selection.hookId === hook.id}
              onSelect={() => onSelect({ type: 'hook', hookId: hook.id })}
            />
          ))}
        </ul>
      </div>
    </div>
  )
}

/** The groups paired with the numbered display steps the page and the tree both read. */
interface DisplayGroup {
  group: RunDetailGroup
  steps: DisplayStep[]
}

export function StepTree({
  groups,
  showMemberChrome = false,
  analysisView,
  onCitedStep,
  onSelectMember,
  onCitedArtifact,
  selection,
  playhead,
  onSelect,
  setupHooks = [],
  teardownHooks = [],
  inlineLogs = [],
  feedback,
}: StepTreeProps) {
  const displayGroups = useMemo<DisplayGroup[]>(() => {
    const flat = displayStepsForGroups(groups)
    let cursor = 0
    return groups.map((group) => {
      const steps = flat.slice(cursor, cursor + group.steps.length)
      cursor += group.steps.length
      return { group, steps }
    })
  }, [groups])

  const logsByStep = useMemo(() => {
    const map = new Map<string, ExecutionLogEntry[]>()
    if (groups.length !== 1) return map
    const [only] = displayGroups
    if (!only) return map
    for (const log of inlineLogs) {
      if (!log.stepId) continue
      const stepOrder = Number(log.stepId)
      const stepAtIndex = only.steps.find((step) => step.rawStepOrder === stepOrder)
      const key = stepAtIndex?.id ?? log.stepId
      const existing = map.get(key) ?? []
      existing.push(log)
      map.set(key, existing)
    }
    return map
  }, [inlineLogs, displayGroups, groups.length])

  const hasAnyStep = displayGroups.some((entry) => entry.steps.length > 0)

  if (groups.length === 0 && !hasAnyStep) {
    if (setupHooks.length > 0 || teardownHooks.length > 0) {
      return (
        <ScrollArea className="flex-1">
          <div>
            <HookSection title="Setup" hooks={setupHooks} selection={selection} onSelect={onSelect} />
            <HookSection title="Teardown" hooks={teardownHooks} selection={selection} onSelect={onSelect} />
          </div>
        </ScrollArea>
      )
    }

    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        No steps were executed.
      </div>
    )
  }

  return (
    <ScrollArea className="flex-1">
      <div>
        <HookSection title="Setup" hooks={setupHooks} selection={selection} onSelect={onSelect} />

        <SectionHeading title="Steps" />
        <ul role="tree" aria-label="Test steps" className="py-1">
          {displayGroups.map(({ group, steps }) => (
            <MemberGroup
              key={group.member.testIndex}
              group={group}
              showChrome={showMemberChrome}
              verdict={analysisView?.get(group.member.testIndex)}
              onCitedStep={onCitedStep}
              onSelectMember={onSelectMember}
              onCitedArtifact={onCitedArtifact}
            >
              {steps.map((step) => {
                const { testIndex, stepIndex } = step
                const addressed = feedback !== undefined && testIndex !== undefined && stepIndex !== undefined
                return (
                <StepTreeItem
                  key={step.id}
                  step={step}
                  onOpenFeedback={addressed ? (opener) => feedback.onOpenStep(testIndex, stepIndex, opener) : undefined}
                  feedbackExpanded={addressed && feedback.expandedAddress === feedbackAddress({ testIndex, stepIndex })}
                  composerId={feedback?.composerId}
                  marks={group.member.marks}
                  isSelected={hasStepId(selection) && selection.stepId === step.id}
                  isExpanded={true}
                  selection={selection}
                  playhead={playhead}
                  onSelect={onSelect}
                  inlineLogs={logsByStep.get(step.id) ?? []}
                />
                )
              })}
            </MemberGroup>
          ))}
        </ul>

        <HookSection title="Teardown" hooks={teardownHooks} selection={selection} onSelect={onSelect} />
      </div>
    </ScrollArea>
  )
}
