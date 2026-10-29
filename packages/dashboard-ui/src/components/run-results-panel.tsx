import { useState, useEffect, useMemo } from "react"
import { X } from "lucide-react"
import type { RunStatus } from "@vostride/agent-qa-schema"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { LiveStepRowView } from "@/components/live-step-row"
import { liveRowShown } from "@/lib/live-step-row"
import { openRunStream } from "@/lib/api"
import {
  createInitialRunStreamState,
  reduceRunStream,
  type LiveStepRow,
  type RunStreamState,
  type StepStatus,
} from "@/lib/run-stream-reducer"
import { getRunStatusDescriptor } from "@/lib/status"

// THE ONE LIVE WIRE. This panel was the last UI client of the legacy
// execution-event projection retired by 405; that feed has no client left. It now folds the
// SAME frozen envelopes `pages/live-run.tsx` folds, through the SAME pure reducer, so the editor's
// panel and the live page cannot drift into two accounts of one run.
//
// A PANEL OPENED AFTER THE RUN ENDED IS SERVED BY REPLAY, not by a second durable read. The local
// run-stream door replays the log from the beginning and then closes at `runFinished`, so the
// reducer reaches the same terminal state either way — which is why there is no `fetchRunDetail`
// fallback here for a finished run.
//
// THE ONE ROW. Every row renders through the live page's `LiveStepRowView`:
// a named glyph and the label. There is no clock anywhere in the panel, no duration on a row and
// no elapsed badge; durations live in run detail. The label is a text node, shown as written.
//
// ONLY ROWS WITH TEXT ARE DRAWN (owner decision 2026-09-26 (2), G-428-2). A row the runner sent no
// text for is left out before the list and before the empty-state decision, so an old producer's
// text-less pending rows leave the panel saying it is waiting rather than blank.

// A row still running when the run answered takes the run's ending, so a stream that stopped
// mid-step never leaves a running glyph claiming work is still happening.
const SETTLED_STEP_STATUS: Record<RunStatus, StepStatus> = {
  passed: "passed",
  failed: "failed",
  healed: "healed",
  timeout: "failed",
  cancelled: "cancelled",
}

interface RunResultsPanelProps {
  runId: string | null
  onClose: () => void
}

export function RunResultsPanel({ runId, onClose }: RunResultsPanelProps) {
  const [state, setState] = useState<RunStreamState>(createInitialRunStreamState)
  const [runStatus, setRunStatus] = useState<
    "connecting" | "running" | "complete" | "error"
  >("connecting")
  const [streamError, setStreamError] = useState(false)

  useEffect(() => {
    if (!runId) return

    let cancelled = false
    setState(createInitialRunStreamState())
    setRunStatus("connecting")
    setStreamError(false)

    const source = openRunStream(runId, {
      onEvent: (envelope) => {
        if (cancelled) return
        setStreamError(false)
        setRunStatus("running")
        setState((previous) => reduceRunStream(previous, envelope, Date.now()))
      },
      onError: () => {
        if (cancelled) return
        setStreamError(true)
      },
    })

    return () => {
      cancelled = true
      source.close()
    }
  }, [runId])

  // The run's own word for how it ended, as the reducer recorded it. `verdict` is first-verdict-wins
  // there, so this cannot flip once the run has answered.
  const finalStatus = state.verdict
  const terminalDescriptor = finalStatus ? getRunStatusDescriptor(finalStatus) : null

  // The reducer keeps rows in bus seq order — the run's own total order, never arrival order.
  const rows = useMemo<LiveStepRow[]>(
    () =>
      state.steps.filter(liveRowShown).map((row) =>
        row.status === "running" && finalStatus !== undefined
          ? { ...row, status: SETTLED_STEP_STATUS[finalStatus] }
          : row,
      ),
    [state.steps, finalStatus],
  )

  if (!runId) return null

  const posture: "connecting" | "running" | "complete" | "error" = terminalDescriptor
    ? (terminalDescriptor.normalized === "passed" ? "complete" : "error")
    : streamError
    ? "error"
    : runStatus

  const headerLabel = posture === "connecting"
    ? "Connecting..."
    : posture === "running"
    ? "Running"
    : terminalDescriptor?.label ?? (posture === "complete" ? "Passed" : "Failed")

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <span className="text-sm font-medium">{headerLabel}</span>
        <Button variant="ghost" size="icon-xs" onClick={onClose}>
          <X className="size-3.5" />
        </Button>
      </div>

      {/* Steps list */}
      <ScrollArea className="flex-1 [&>[data-slot=scroll-area-viewport]>div]:!block">
        {rows.length > 0 && (
          <ul className="flex flex-col py-1">
            {rows.map((row) => (
              <LiveStepRowView key={`${String(row.testIndex)}:${String(row.stepIndex)}`} row={row} />
            ))}
          </ul>
        )}
        {rows.length === 0 && (posture === "connecting" || posture === "running") && (
          <div className="text-sm text-muted-foreground text-center py-8">
            Waiting for events...
          </div>
        )}
      </ScrollArea>
    </div>
  )
}
