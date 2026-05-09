import { useState, useEffect } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { fetchStepReasoning } from "@/lib/api"
import type { SubActionData } from "@/lib/api"
import type { DisplayStep } from "@/lib/display-step"

const SEGMENT_TOGGLE_SHELL = "rounded-sm border border-border/60 bg-muted/20 p-1"
const SEGMENT_TOGGLE_BASE = "rounded-sm px-3 py-1 text-xs font-medium transition-colors"
const SEGMENT_TOGGLE_ACTIVE = "bg-primary/10 text-foreground ring-1 ring-primary/30"
const SEGMENT_TOGGLE_IDLE = "text-muted-foreground hover:bg-muted hover:text-foreground"

interface TabAriaTreeProps {
  step: DisplayStep
  subAction: SubActionData | null
  runId: string
}

export function TabAriaTree({ step, subAction, runId }: TabAriaTreeProps) {
  const [tab, setTab] = useState<'before' | 'after'>('before')

  if (subAction) {
    const before = subAction.screenStateBefore
    const after = subAction.screenStateAfter
    if (!before && !after) {
      return <EmptyAriaTree />
    }
    return <AriaTreeView before={before ?? null} after={after ?? null} tab={tab} setTab={setTab} />
  }

  return <StepAriaTree step={step} runId={runId} tab={tab} setTab={setTab} />
}

function StepAriaTree({ step, runId, tab, setTab }: {
  step: DisplayStep; runId: string; tab: 'before' | 'after'; setTab: (t: 'before' | 'after') => void
}) {
  const [before, setBefore] = useState<string | null>(null)
  const [after, setAfter] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetchStepReasoning(runId, step.rawStepOrder)
      .then((res) => {
        if (cancelled) return
        setBefore(res.trace.screenStateBefore)
        setAfter(res.trace.screenStateAfter)
        setLoading(false)
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [runId, step.rawStepOrder])

  if (loading) {
    return (
      <div className="p-3 space-y-2">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    )
  }

  if (!before && !after) return <EmptyAriaTree />

  return <AriaTreeView before={before} after={after} tab={tab} setTab={setTab} />
}

function AriaTreeView({ before, after, tab, setTab }: {
  before: string | null; after: string | null; tab: 'before' | 'after'; setTab: (t: 'before' | 'after') => void
}) {
  const hasBefore = !!before
  const hasAfter = !!after

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-hidden p-3">
      {hasBefore && hasAfter && (
        <div className={`flex gap-1 ${SEGMENT_TOGGLE_SHELL}`}>
          <button
            onClick={() => setTab('before')}
            className={`${SEGMENT_TOGGLE_BASE} ${tab === 'before' ? SEGMENT_TOGGLE_ACTIVE : SEGMENT_TOGGLE_IDLE}`}
          >
            Before
          </button>
          <button
            onClick={() => setTab('after')}
            className={`${SEGMENT_TOGGLE_BASE} ${tab === 'after' ? SEGMENT_TOGGLE_ACTIVE : SEGMENT_TOGGLE_IDLE}`}
          >
            After
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-hidden rounded-sm border border-border/60 bg-muted/20">
        <div className="h-full overflow-auto overscroll-contain">
          <pre className="min-w-full p-3 text-xs font-mono whitespace-pre">
            {tab === 'before' && hasBefore ? before : hasAfter ? after : before}
          </pre>
        </div>
      </div>
    </div>
  )
}

function EmptyAriaTree() {
  return (
    <div className="flex items-center justify-center h-full text-muted-foreground text-sm py-12">
      No ARIA tree snapshot available for this step
    </div>
  )
}
