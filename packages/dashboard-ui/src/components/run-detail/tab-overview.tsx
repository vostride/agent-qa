import { useEffect, useState } from "react"
import { Camera, Eye, Brain, Play, ShieldCheck, ArrowUpRight, Copy, Check } from "lucide-react"
import { ScreenshotViewer } from "@/components/screenshot-viewer"
import { ReasoningPipeline } from "@/components/reasoning-pipeline"
import type { SectionDef, ReasoningPipelineHandle } from "@/components/reasoning-pipeline"
import { HealingChain } from "@/components/healing-chain"
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover"
import type { SubActionData, ReasoningTrace } from "@/lib/api"
import type { DisplayStep } from "@/lib/display-step"

const SCREENSHOT_SEGMENT_SHELL = "rounded-sm border border-border/60 bg-muted/20 p-1"
const SCREENSHOT_SEGMENT_BASE = "rounded-sm px-3 py-1 text-xs font-medium transition-colors"
const SCREENSHOT_SEGMENT_ACTIVE = "bg-primary/10 text-foreground ring-1 ring-primary/30"
const SCREENSHOT_SEGMENT_IDLE = "text-muted-foreground hover:bg-muted hover:text-foreground"

export type ScreenshotSide = "before" | "after"
export type ScreenshotEmptyState = "pending" | "absent"

interface TabOverviewProps {
  step: DisplayStep
  subAction: SubActionData | null
  runId: string | null
  screenshotSide?: ScreenshotSide
  onScreenshotSideChange?: (side: ScreenshotSide) => void
  screenshotEmptyState?: ScreenshotEmptyState
  pipelineRef?: React.RefObject<ReasoningPipelineHandle | null>
}

function formatAction(action: unknown): { type: string; target: string } | null {
  if (!action) return null
  try {
    const parsed = typeof action === "string" ? JSON.parse(action) : action
    if (parsed && typeof parsed === "object") {
      return {
        type: (parsed as Record<string, string>).type || (parsed as Record<string, string>).action || "unknown",
        target: (parsed as Record<string, string>).target || (parsed as Record<string, string>).selector || "",
      }
    }
  } catch {
    return { type: String(action), target: "" }
  }
  return null
}

function buildSubActionSections(sub: SubActionData): SectionDef[] {
  const sections: SectionDef[] = []

  if (sub.observation) {
    sections.push({
      key: 'observation',
      label: 'Observation',
      icon: Eye,
      content: sub.observation,
      duration: sub.phaseDurations?.observe ?? null,
    })
  }

  if (sub.reasoning) {
    sections.push({
      key: 'reasoning',
      label: 'Reasoning',
      icon: Brain,
      content: sub.reasoning,
      duration: sub.phaseDurations?.plan ?? null,
    })
  }

  if (sub.plannedAction != null) {
    sections.push({
      key: 'plannedAction',
      label: 'Planned Action',
      icon: Play,
      content: null,
      duration: sub.phaseDurations?.execute ?? null,
      children: (
        <pre className="max-w-full min-w-0 text-[10px] font-mono bg-muted/30 rounded-sm p-2 overflow-x-auto whitespace-pre-wrap break-words">
          {typeof sub.plannedAction === "string"
            ? sub.plannedAction
            : JSON.stringify(sub.plannedAction, null, 2)}
        </pre>
      ),
    })
  }

  if (sub.verifierReasoning) {
    sections.push({
      key: 'verifier',
      label: 'Verifier',
      icon: ShieldCheck,
      content: sub.verifierReasoning,
      duration: sub.phaseDurations?.verify ?? null,
    })
  }

  return sections
}

function buildStepSections(step: DisplayStep): SectionDef[] {
  const sections: SectionDef[] = []

  if (step.observation) {
    sections.push({ key: 'observation', label: 'Observation', icon: Eye, content: step.observation, duration: null })
  }
  if (step.reasoning) {
    sections.push({ key: 'reasoning', label: 'Reasoning', icon: Brain, content: step.reasoning, duration: null })
  }
  if (step.plannedAction != null) {
    sections.push({
      key: 'plannedAction', label: 'Planned Action', icon: Play, content: null, duration: null,
      children: (
        <pre className="max-w-full min-w-0 text-[10px] font-mono bg-muted/30 rounded-sm p-2 overflow-x-auto whitespace-pre-wrap break-words">
          {typeof step.plannedAction === "string" ? step.plannedAction : JSON.stringify(step.plannedAction, null, 2)}
        </pre>
      ),
    })
  }

  return sections
}

export function TabOverview({
  step,
  subAction,
  runId,
  screenshotSide,
  onScreenshotSideChange,
  screenshotEmptyState = "absent",
  pipelineRef,
}: TabOverviewProps) {
  const hasMultiSub = (step.subActionsData?.length ?? 0) > 1

  if (subAction) {
    const beforePath = subAction.screenshotBeforePath
    const afterPath = subAction.screenshotAfterPath
    return (
      <>
        <ScreenshotPair
          beforePath={beforePath ?? null}
          afterPath={afterPath ?? null}
          annotation={subAction.annotation}
          refLabel={subAction.plannedAction && typeof subAction.plannedAction === 'object' && subAction.plannedAction !== null && 'ref' in subAction.plannedAction ? (subAction.plannedAction as Record<string, unknown>).ref as string : undefined}
          screenContextBefore={subAction.screenContextBefore}
          screenContextAfter={subAction.screenContextAfter}
          screenshotSide={screenshotSide}
          onScreenshotSideChange={onScreenshotSideChange}
          emptyState={screenshotEmptyState}
        />
        <div className="border-t">
          <div className="p-3 space-y-3 min-w-0">
            <div className="flex items-center gap-2 text-sm">
              <span className="font-medium">Sub-action #{subAction.index + 1}</span>
              <span className={`text-xs font-medium ${subAction.result === 'success' ? 'text-emerald-500' : 'text-red-500'}`}>
                {subAction.result}
              </span>
              {subAction.confidence != null && (
                <span className={`text-xs ${subAction.confidence >= 0.8 ? 'text-emerald-500' : subAction.confidence >= 0.5 ? 'text-amber-500' : 'text-red-500'}`}>
                  {Math.round(subAction.confidence * 100)}%
                </span>
              )}
            </div>

            <ReasoningPipeline ref={pipelineRef} mode="static" sections={buildSubActionSections(subAction)} />

            {subAction.error && (
              <div>
                <p className="text-xs text-muted-foreground font-medium mb-0.5">Error</p>
                <div className="bg-destructive/10 text-destructive rounded-sm p-2 text-xs break-words [overflow-wrap:anywhere]">{subAction.error}</div>
              </div>
            )}
          </div>
        </div>
      </>
    )
  }

  const beforePath = step.screenshotBeforePath
  const afterPath = step.screenshotPath
  const annotation = hasMultiSub ? null : step.annotationData
  const refLabel = hasMultiSub ? undefined : (step.action && typeof step.action === 'object' && step.action !== null && 'ref' in step.action ? (step.action as Record<string, unknown>).ref as string : undefined)
  const actionInfo = formatAction(step.action)

  return (
    <>
      <ScreenshotPair
        beforePath={beforePath}
        afterPath={afterPath}
        annotation={annotation}
        refLabel={refLabel}
        screenContextBefore={step.screenContextBefore}
        screenContextAfter={step.screenContextAfter}
        screenshotSide={screenshotSide}
        onScreenshotSideChange={onScreenshotSideChange}
        emptyState={screenshotEmptyState}
      />
      <div className="border-t">
        <div className="p-3 space-y-3 min-w-0">
          {runId ? (
            <ReasoningPipeline
              ref={pipelineRef}
              runId={runId}
              stepOrder={step.rawStepOrder}
              stepData={step}
            />
          ) : (
            <ReasoningPipeline ref={pipelineRef} mode="static" sections={buildStepSections(step)} />
          )}

          {actionInfo && (
            <div>
              <p className="text-xs text-muted-foreground font-medium mb-0.5">Action</p>
              <p className="text-sm">
                {actionInfo.type}
                {actionInfo.target && <span className="text-muted-foreground ml-1">{actionInfo.target}</span>}
              </p>
            </div>
          )}

          {step.plannedAction != null && (
            <div>
              <p className="text-xs text-muted-foreground font-medium mb-0.5">Planned Action</p>
              <pre className="max-w-full min-w-0 text-[10px] font-mono bg-muted/30 rounded-sm p-2 overflow-x-auto whitespace-pre-wrap break-words" style={{ maxHeight: '12rem' }}>
                {typeof step.plannedAction === "string"
                  ? step.plannedAction
                  : JSON.stringify(step.plannedAction, null, 2)}
              </pre>
            </div>
          )}

          {step.error && (
            <div>
              <p className="text-xs text-muted-foreground font-medium mb-0.5">Error</p>
              <div className="bg-destructive/10 text-destructive rounded-sm p-2 text-sm break-words [overflow-wrap:anywhere]">{step.error}</div>
            </div>
          )}

          {step.healingAttempts && step.healingAttempts.length > 0 && (
            <HealingChain attempts={step.healingAttempts as ReasoningTrace["healAttempts"]} />
          )}
        </div>
      </div>
    </>
  )
}

function UrlBar({ url }: { url: string | null | undefined }) {
  const [copied, setCopied] = useState(false)
  if (!url) return null

  const handleCopy = () => {
    navigator.clipboard.writeText(url).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="w-0 flex-1 flex items-center gap-1">
      <div className="flex-1 min-w-0 overflow-hidden bg-muted/50 rounded-sm px-2 py-0.5 text-xs font-mono truncate text-muted-foreground">
        {url}
      </div>
      <Popover>
        <PopoverTrigger asChild>
          <button className="shrink-0 p-1 rounded-sm hover:bg-muted transition-colors">
            <ArrowUpRight className="h-3 w-3 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-auto max-w-md p-3">
          <div className="space-y-2">
            <p className="text-xs font-mono break-all select-text">{url}</p>
            <button onClick={handleCopy} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {copied ? 'Copied' : 'Copy URL'}
            </button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}

function ScreenshotPair({ beforePath, afterPath, annotation, refLabel, screenContextBefore, screenContextAfter, screenshotSide, onScreenshotSideChange, emptyState }: {
  beforePath: string | null
  afterPath: string | null
  annotation?: unknown
  refLabel?: string
  screenContextBefore?: string | null
  screenContextAfter?: string | null
  screenshotSide?: ScreenshotSide
  onScreenshotSideChange?: (side: ScreenshotSide) => void
  emptyState: ScreenshotEmptyState
}) {
  const hasBefore = !!beforePath
  const hasAfter = !!afterPath
  const defaultScreenshotSide: ScreenshotSide = hasBefore ? 'before' : 'after'
  const [localScreenshotSide, setLocalScreenshotSide] = useState<ScreenshotSide>(defaultScreenshotSide)

  useEffect(() => {
    setLocalScreenshotSide(defaultScreenshotSide)
  }, [beforePath, afterPath, defaultScreenshotSide])

  const requestedScreenshotSide = screenshotSide ?? localScreenshotSide
  const activeScreenshotSide: ScreenshotSide =
    requestedScreenshotSide === 'before' && hasBefore
      ? 'before'
      : requestedScreenshotSide === 'after' && hasAfter
        ? 'after'
        : defaultScreenshotSide

  const handleScreenshotSideChange = (side: ScreenshotSide) => {
    if (side === 'before' && !hasBefore) return
    if (side === 'after' && !hasAfter) return
    if (onScreenshotSideChange) {
      onScreenshotSideChange(side)
      return
    }
    setLocalScreenshotSide(side)
  }

  if (!hasBefore && !hasAfter) {
    const isPending = emptyState === "pending"
    return (
      <div className="h-full w-full py-12">
        <div className="flex min-h-[16rem] w-full flex-col items-center justify-center gap-2 text-center text-muted-foreground">
          <Camera className="h-8 w-8" />
          <span className="text-sm font-medium text-foreground">
            {isPending ? "Waiting for screenshot" : "No screenshot captured"}
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="p-3 space-y-2 min-w-0">
      {hasBefore && hasAfter && (
        <div className="flex items-center gap-2 min-w-0">
          <div className={`flex gap-1 shrink-0 ${SCREENSHOT_SEGMENT_SHELL}`}>
            <button
              onClick={() => handleScreenshotSideChange('before')}
              className={`${SCREENSHOT_SEGMENT_BASE} ${
                activeScreenshotSide === 'before'
                  ? SCREENSHOT_SEGMENT_ACTIVE
                  : SCREENSHOT_SEGMENT_IDLE
              }`}
            >Before</button>
            <button
              onClick={() => handleScreenshotSideChange('after')}
              className={`${SCREENSHOT_SEGMENT_BASE} ${
                activeScreenshotSide === 'after'
                  ? SCREENSHOT_SEGMENT_ACTIVE
                  : SCREENSHOT_SEGMENT_IDLE
              }`}
            >After</button>
          </div>
          {(screenContextBefore || screenContextAfter) && (
            <UrlBar url={activeScreenshotSide === 'before' ? screenContextBefore : screenContextAfter} />
          )}
        </div>
      )}
      {activeScreenshotSide === 'before' && hasBefore && (
        <ScreenshotViewer screenshotPath={beforePath!} annotation={annotation as import("@/lib/api").StepAnnotation | null | undefined} refLabel={refLabel} className="w-full rounded-sm overflow-hidden" />
      )}
      {activeScreenshotSide === 'after' && hasAfter && (
        <ScreenshotViewer screenshotPath={afterPath!} annotation={!hasBefore ? annotation as import("@/lib/api").StepAnnotation | null | undefined : null} refLabel={!hasBefore ? refLabel : undefined} className="w-full rounded-sm overflow-hidden" />
      )}
    </div>
  )
}
