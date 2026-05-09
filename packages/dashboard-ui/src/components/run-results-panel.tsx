import { useState, useEffect, useRef } from "react"
import { X, CheckCircle2, XCircle, CircleDashed, Clock, RefreshCw, Square } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { subscribeToExecutionEvents } from "@/lib/api"
import { finalStepStatusForRun, getRunStatusDescriptor, normalizeStepStatus } from "@/lib/status"
import { formatDuration } from "@/lib/utils"
import { cn } from "@/lib/utils"

interface StepInfo {
  name: string
  status: string
  duration?: number
  error?: string
}

interface RunResultsPanelProps {
  runId: string | null
  onClose: () => void
}

export function RunResultsPanel({ runId, onClose }: RunResultsPanelProps) {
  const [steps, setSteps] = useState<StepInfo[]>([])
  const [runStatus, setRunStatus] = useState<
    "connecting" | "running" | "complete" | "error"
  >("connecting")
  const [finalStatus, setFinalStatus] = useState<string | undefined>()
  const [elapsed, setElapsed] = useState(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (!runId) return

    let cancelled = false
    setSteps([])
    setRunStatus("connecting")
    setFinalStatus(undefined)
    setElapsed(0)

    // Start elapsed timer
    const startTime = Date.now()
    timerRef.current = setInterval(() => {
      if (!cancelled) setElapsed(Date.now() - startTime)
    }, 200)

    const source = subscribeToExecutionEvents(runId, {
      onRunStart: () => {
        if (!cancelled) setRunStatus("running")
      },
      onStepStart: (data) => {
        if (cancelled) return
        setRunStatus("running")
        setSteps((prev) => [
          ...prev,
          { name: data.stepName, status: "running" },
        ])
      },
      onStepComplete: (data) => {
        if (cancelled) return
        setSteps((prev) => {
          let completed = false
          return prev.map((s) => {
            if (completed || s.name !== data.stepName || s.status !== "running") return s
            completed = true
            return {
              ...s,
              status: normalizeStepStatus(data.status),
              duration: data.duration,
              error: data.error ?? undefined,
            }
          })
        })
      },
      onRunComplete: (data) => {
        if (cancelled) return
        const descriptor = getRunStatusDescriptor(data.status)
        setFinalStatus(descriptor.normalized)
        setRunStatus(descriptor.normalized === "passed" ? "complete" : "error")
        setSteps((prev) =>
          prev.map((step) =>
            step.status === "running"
              ? { ...step, status: finalStepStatusForRun(data.status) }
              : step,
          ),
        )
        if (timerRef.current) clearInterval(timerRef.current)
      },
      onRunError: (data) => {
        if (cancelled) return
        setRunStatus("error")
        setSteps((prev) => [
          ...prev,
          { name: "Run Error", status: "failed", error: data.error },
        ])
        if (timerRef.current) clearInterval(timerRef.current)
      },
    })

    return () => {
      cancelled = true
      if (timerRef.current) clearInterval(timerRef.current)
      source.close()
    }
  }, [runId])

  if (!runId) return null

  const terminalDescriptor = finalStatus ? getRunStatusDescriptor(finalStatus) : null
  const headerLabel = runStatus === "connecting"
    ? "Connecting..."
    : runStatus === "running"
    ? "Running"
    : terminalDescriptor?.label ?? (runStatus === "complete" ? "Passed" : "Failed")

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          {runStatus === "running" || runStatus === "connecting" ? (
            <CircleDashed className="size-4 text-primary" />
          ) : terminalDescriptor?.normalized === "passed" || runStatus === "complete" ? (
            <CheckCircle2 className="size-4 text-emerald-500" />
          ) : terminalDescriptor?.normalized === "cancelled" ? (
            <Square className="size-4 text-muted-foreground" />
          ) : terminalDescriptor?.normalized === "flaky" || terminalDescriptor?.normalized === "healed" ? (
            <RefreshCw className="size-4 text-amber-500" />
          ) : (
            <XCircle className="size-4 text-red-500" />
          )}
          <span className="text-sm font-medium">{headerLabel}</span>
          {(runStatus === "running" || runStatus === "connecting") && (
            <Badge variant="outline" className="text-xs gap-1">
              <Clock className="size-3" />
              {formatDuration(elapsed)}
            </Badge>
          )}
        </div>
        <Button variant="ghost" size="icon-xs" onClick={onClose}>
          <X className="size-3.5" />
        </Button>
      </div>

      {/* Steps list */}
      <ScrollArea className="flex-1 [&>[data-slot=scroll-area-viewport]>div]:!block">
        <div className="p-3 space-y-1.5">
          {steps.map((step, i) => (
            <div
              key={`${step.name}-${i}`}
              className={cn(
                "relative overflow-hidden flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
                step.status === "running" && "live-running-surface border-border/60 bg-primary/5",
                step.status === "passed" && "border-emerald-500/20 bg-emerald-500/5",
                step.status === "failed" && "border-destructive/20 bg-destructive/5",
                step.status === "cancelled" && "border-border/60 bg-muted/30",
                step.status === "flaky" && "border-amber-500/20 bg-amber-500/5",
                step.status !== "running"
                  && step.status !== "passed"
                  && step.status !== "failed"
                  && step.status !== "cancelled"
                  && step.status !== "flaky"
                  && "border-border/60 bg-card/40",
              )}
            >
              {step.status === "running" ? (
                <CircleDashed className="size-3.5 mt-0.5 shrink-0 text-primary" />
              ) : step.status === "passed" || step.status === "completed" ? (
                <CheckCircle2 className="size-3.5 mt-0.5 text-emerald-500 shrink-0" />
              ) : step.status === "cancelled" ? (
                <Square className="size-3.5 mt-0.5 text-muted-foreground shrink-0" />
              ) : step.status === "flaky" ? (
                <RefreshCw className="size-3.5 mt-0.5 text-amber-500 shrink-0" />
              ) : (
                <XCircle className="size-3.5 mt-0.5 text-red-500 shrink-0" />
              )}
              <span className="flex-1 min-w-0 break-words">{step.name}</span>
              {step.duration !== undefined && (
                <span className="text-xs text-muted-foreground shrink-0">
                  {formatDuration(step.duration)}
                </span>
              )}
            </div>
          ))}
          {steps.length === 0 && runStatus === "connecting" && (
            <div className="text-sm text-muted-foreground text-center py-8">
              Waiting for events...
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
