import { useMemo } from "react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { CheckCircle2, Circle, XCircle, Webhook } from "lucide-react"
import { cn, formatDuration } from "@/lib/utils"
import { StepTreeItem } from "./step-tree-item"
import type { RunRow, ExecutionLogEntry } from "@/lib/api"
import type { DisplayStep } from "@/lib/display-step"
import { hasStepId, type Selection } from "@/lib/selection"

interface StepTreeProps {
  steps: DisplayStep[]
  selection: Selection | null
  onSelect: (sel: Selection | null) => void
  suiteTests?: RunRow[]
  suiteSelectedView?: string
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

export function StepTree({ steps, selection, onSelect, suiteTests, suiteSelectedView, setupHooks = [], teardownHooks = [], inlineLogs = [] }: StepTreeProps) {
  const expandedStepId = hasStepId(selection) ? selection.stepId : null

  const logsByStep = useMemo(() => {
    const map = new Map<string, ExecutionLogEntry[]>()
    for (const log of inlineLogs) {
      if (!log.stepId) continue
      const stepOrder = Number(log.stepId)
      const stepAtIndex = steps.find((step) => {
        if (step.rawRunId && log.runId && step.rawRunId !== log.runId) return false
        return step.rawStepOrder === stepOrder
      })
      const key = stepAtIndex?.id ?? log.stepId
      const existing = map.get(key) ?? []
      existing.push(log)
      map.set(key, existing)
    }
    return map
  }, [inlineLogs, steps])

  if (steps.length === 0) {
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

  if (suiteTests && suiteTests.length > 0 && suiteSelectedView === 'all') {
    const grouped = new Map<string, DisplayStep[]>()
    for (const step of steps) {
      const key = step.runId ?? step.id
      const existing = grouped.get(key) ?? []
      existing.push(step)
      grouped.set(key, existing)
    }

    const childRunIds = new Set(suiteTests.map(t => t.id))
    const suiteSetupHooks = setupHooks.filter(h => !childRunIds.has(h.runId))
    const suiteTeardownHooks = teardownHooks.filter(h => !childRunIds.has(h.runId))

    return (
      <ScrollArea className="flex-1">
        <div>
          <HookSection title="Setup" hooks={suiteSetupHooks} selection={selection} onSelect={onSelect} />

          <SectionHeading title="Steps" />
          <ul role="tree" aria-label="Test steps" className="py-1">
            {suiteTests.map((test) => {
              const runId = test.id
              const groupSteps = grouped.get(runId) ?? []
              const testName = test.name ?? 'Unknown Test'
              const testSetupHooks = setupHooks.filter(h => h.runId === runId)
              const testTeardownHooks = teardownHooks.filter(h => h.runId === runId)
              return (
                <li key={runId} role="none">
                  <div className="mt-3 mb-1 flex items-center justify-between bg-muted/30 px-3 py-1.5 text-xs font-medium text-muted-foreground first:mt-0">
                    <span className="min-w-0 truncate">{testName}</span>
                    <span className="ml-2 shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground/70">
                      {test.status}
                    </span>
                  </div>
                  {testSetupHooks.length > 0 && (
                    <HookSection title="Setup" hooks={testSetupHooks} selection={selection} onSelect={onSelect} />
                  )}
                  {groupSteps.length > 0 ? (
                    <ul role="group">
                      {groupSteps.map((step) => (
                        <StepTreeItem
                          key={step.id}
                          step={step}
                          isSelected={hasStepId(selection) && selection.stepId === step.id}
                          isExpanded={true}
                          selection={selection}
                          onSelect={onSelect}
                        inlineLogs={logsByStep.get(step.id) ?? []}
                      />
                      ))}
                    </ul>
                  ) : (
                    <div className="mx-2 mb-1.5 rounded-[2px] border border-border/60 bg-muted/10 px-3 py-2 text-xs text-muted-foreground">
                      {test.status === 'skipped'
                        ? 'Skipped'
                        : test.status === 'cancelled'
                          ? 'Cancelled'
                          : 'Pending'}
                    </div>
                  )}
                  {testTeardownHooks.length > 0 && (
                    <HookSection title="Teardown" hooks={testTeardownHooks} selection={selection} onSelect={onSelect} />
                  )}
                </li>
              )
            })}
          </ul>

          <HookSection title="Teardown" hooks={suiteTeardownHooks} selection={selection} onSelect={onSelect} />
        </div>
      </ScrollArea>
    )
  }

  return (
    <ScrollArea className="flex-1">
      <div>
        <HookSection title="Setup" hooks={setupHooks} selection={selection} onSelect={onSelect} />

        <SectionHeading title="Steps" />
        <ul role="tree" aria-label="Test steps" className="py-1">
          {steps.map((step) => (
            <StepTreeItem
              key={step.id}
              step={step}
              isSelected={hasStepId(selection) && selection.stepId === step.id}
              isExpanded={true}
              selection={selection}
              onSelect={onSelect}
              inlineLogs={logsByStep.get(step.id) ?? []}
            />
          ))}
        </ul>

        <HookSection title="Teardown" hooks={teardownHooks} selection={selection} onSelect={onSelect} />
      </div>
    </ScrollArea>
  )
}
