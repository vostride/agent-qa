import { useCallback, useState, useEffect, useRef } from "react"
import { subscribeToExecutionEvents } from "@/lib/api"
import type { ExecutionLogEntry, RunRow } from "@/lib/api"
import type { DisplayStep } from "@/lib/display-step"
import {
  createLiveTimelineState,
  deriveLiveProgressSummary,
  mergeFinalArtifacts as mergeLiveFinalArtifacts,
  reduceLiveTimeline,
  type FinalArtifactInput,
  type LiveProgressSummary,
  type LiveTimelineState,
} from "@/lib/live-timeline"
import { getRunStatusDescriptor } from "@/lib/status"

export interface LivePhase {
  phase: 'observe' | 'plan' | 'execute' | 'verify' | 'heal'
  subActionIndex?: number
  phaseOrdinal?: number
  text?: string
  confidence?: number
  action?: unknown
  success?: boolean
  duration?: number
  timestamp: string
}

export interface LiveStep {
  id: string
  kind: 'step' | 'hook'
  hookPhase?: 'setup' | 'teardown' | 'inline'
  hookExecutionId?: string
  name: string
  status: "pending" | "running" | "passed" | "failed" | "healed" | "skipped" | "flaky" | "cancelled"
  duration?: number
  error?: string
  screenshot?: string
  reasoning?: string
  observation?: string
  result?: string
  plannedAction?: unknown
  annotation?: unknown
  phases?: LivePhase[]
}

export interface LiveTestInfo {
  name: string
  filePath: string
  totalSteps: number
}

export interface UseExecutionEventsReturn {
  steps: LiveStep[]
  displaySteps: DisplayStep[]
  setupHooks: ExecutionLogEntry[]
  teardownHooks: ExecutionLogEntry[]
  inlineLogs: ExecutionLogEntry[]
  suiteTests: RunRow[]
  testInfo: LiveTestInfo | null
  runStatus: "idle" | "connecting" | "running" | "complete" | "error"
  finalStatus?: string
  elapsed: number
  error?: string
  completedSteps: number
  passedSteps: number
  failedSteps: number
  totalSteps: number
  progress: LiveProgressSummary
  mergeFinalArtifacts: (input: FinalArtifactInput) => void
}

export function useExecutionEvents(
  runId: string | null,
  startedAt?: string | null,
): UseExecutionEventsReturn {
  const [timeline, setTimeline] = useState<LiveTimelineState>(() => createLiveTimelineState(runId))
  const [runStatus, setRunStatus] = useState<
    "idle" | "connecting" | "running" | "complete" | "error"
  >("idle")
  const [finalStatus, setFinalStatus] = useState<string | undefined>()
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState<string | undefined>()
  const sourceRef = useRef<EventSource | null>(null)
  const mergeFinalArtifacts = useCallback((input: FinalArtifactInput) => {
    setTimeline((prev) => mergeLiveFinalArtifacts(prev, input))
  }, [])

  useEffect(() => {
    if (!runId) {
      setRunStatus("idle")
      return
    }

    let cancelled = false

    // Reset state for new run
    setTimeline(createLiveTimelineState(runId))
    setFinalStatus(undefined)
    setError(undefined)
    setElapsed(0)
    setRunStatus("connecting")

    // Start elapsed timer — compute from startedAt so it survives page refresh
    const timerStart = startedAt ? new Date(startedAt).getTime() : Date.now()
    setElapsed(Math.max(0, Math.floor((Date.now() - timerStart) / 1000)))
    const timerId = setInterval(() => {
      if (!cancelled) {
        setElapsed(Math.max(0, Math.floor((Date.now() - timerStart) / 1000)))
      }
    }, 1000)

    const source = subscribeToExecutionEvents(runId, {
      onRunStart: (data) => {
        if (!cancelled) {
          setRunStatus("running")
          setTimeline((prev) => reduceLiveTimeline(prev, { type: "run-start", runId: data.runId, status: data.status, eventId: data.eventId }))
        }
      },

      onTestStart: (data) => {
        if (!cancelled) {
          setTimeline((prev) => reduceLiveTimeline(prev, data))
        }
      },

      onHookStart: (data) => {
        if (!cancelled) {
          setTimeline((prev) => reduceLiveTimeline(prev, data))
        }
      },

      onHookEnd: (data) => {
        if (!cancelled) {
          setTimeline((prev) => reduceLiveTimeline(prev, data))
        }
      },

      onStepStart: (data) => {
        if (!cancelled) {
          setTimeline((prev) => reduceLiveTimeline(prev, data))
        }
      },

      onStepComplete: (data) => {
        if (!cancelled) {
          setTimeline((prev) => reduceLiveTimeline(prev, data))
        }
      },

      onStepPhase: (data) => {
        if (!cancelled) {
          setTimeline((prev) => reduceLiveTimeline(prev, data))
        }
      },

      onTestComplete: (data) => {
        if (!cancelled) {
          setTimeline((prev) => reduceLiveTimeline(prev, data))
        }
      },

      onRunComplete: (data) => {
        if (!cancelled) {
          const descriptor = getRunStatusDescriptor(data.status)
          setRunStatus("complete")
          setFinalStatus(descriptor.normalized)
          clearInterval(timerId)
          setTimeline((prev) => reduceLiveTimeline(prev, data))
        }
      },

      onRunError: (data) => {
        if (!cancelled) {
          setRunStatus("error")
          setError(data.error)
          clearInterval(timerId)
          setTimeline((prev) => reduceLiveTimeline(prev, { type: "run-error", ...data }))
        }
      },
    })

    sourceRef.current = source

    return () => {
      cancelled = true
      clearInterval(timerId)
      // Safe to call even if subscribeToExecutionEvents already closed it
      // on run-complete/run-error (EventSource.close() is idempotent)
      source.close()
      sourceRef.current = null
    }
  }, [runId, startedAt])

  return {
    steps: timeline.steps,
    displaySteps: timeline.displaySteps,
    setupHooks: timeline.setupHooks,
    teardownHooks: timeline.teardownHooks,
    inlineLogs: timeline.inlineLogs,
    suiteTests: timeline.suiteTests,
    testInfo: timeline.testInfo,
    runStatus,
    finalStatus,
    elapsed,
    error,
    completedSteps: timeline.completedSteps,
    passedSteps: timeline.passedSteps,
    failedSteps: timeline.failedSteps,
    totalSteps: timeline.totalSteps,
    progress: deriveLiveProgressSummary(timeline),
    mergeFinalArtifacts,
  }
}
