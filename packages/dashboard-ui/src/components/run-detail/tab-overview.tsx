import { Brain, Play, ShieldCheck, Target } from "lucide-react"

import { ReasoningPipeline } from "@/components/reasoning-pipeline"
import type { SectionDef, ReasoningPipelineHandle } from "@/components/reasoning-pipeline"
import type { DisplayStep } from "@/lib/display-step"
import { readIdempotentNoopMeta, type RunDetailSubAction } from "@vostride/agent-qa-schema"
import { RESULT_WORDS, displayTargetName } from "@/lib/action-vocabulary"

import { Player, type PlayerProps } from "./player"

export interface OverviewPlayerProps {
  timeline?: React.ReactNode
  model?: PlayerProps["model"] | null
  playhead?: PlayerProps["playhead"]
  recording?: PlayerProps["recording"]
  clock?: PlayerProps["clock"]
  frame?: PlayerProps["frame"]
  playerSource?: PlayerProps["source"]
  onPlayerSourceChange?: PlayerProps["onSourceChange"]
  onPlayheadChange?: PlayerProps["onPlayheadChange"]
  seekFraction?: number
  seekRevision?: number
  onProgress?: PlayerProps["onProgress"]
  onPlayheadObserved?: PlayerProps["onPlayheadObserved"]
  onRecordingEnded?: PlayerProps["onRecordingEnded"]
  autoPlay?: boolean
  isTimelineKeyIgnored?: PlayerProps["isTimelineKeyIgnored"]
}

interface TabOverviewProps extends OverviewPlayerProps {
  step: DisplayStep | null
  subAction: RunDetailSubAction | null
  runId: string | null
  pipelineRef?: React.RefObject<ReasoningPipelineHandle | null>
}

/** The three words a recorded result can be — raw, closed, and never a sentence. */
function resultWord(sub: RunDetailSubAction): string {
  if (readIdempotentNoopMeta(sub.result)) return RESULT_WORDS["no-input"]
  return sub.result.success ? "success" : "failure"
}

function resultColour(sub: RunDetailSubAction): string {
  if (readIdempotentNoopMeta(sub.result)) return "text-muted-foreground"
  return sub.result.success ? "text-emerald-500" : "text-red-500"
}

function buildSubActionSections(sub: RunDetailSubAction): SectionDef[] {
  const sections: SectionDef[] = []

  sections.push({
    key: "reasoning",
    label: "Reasoning",
    icon: Brain,
    content: null,
    duration: null,
    children: (
      <p
        data-sub-action-plan
        className="m-0 whitespace-pre-wrap break-words text-sm text-muted-foreground [overflow-wrap:anywhere]"
      >
        {sub.plan}
      </p>
    ),
  })

  sections.push({
    key: "plannedAction",
    label: "Planned Action",
    icon: Play,
    content: null,
    duration: null,
    children: (
      <pre
        data-sub-action-planned-action
        className="max-w-full min-w-0 text-[10px] font-mono bg-muted/30 rounded-sm p-2 overflow-x-auto whitespace-pre-wrap break-words"
      >
        {JSON.stringify(sub.plannedAction, null, 2)}
      </pre>
    ),
  })

  sections.push({
    key: "result",
    label: "Result",
    icon: ShieldCheck,
    content: null,
    duration: null,
    outcome: (
      <span
        className={`text-xs font-medium ${resultColour(sub)}`}
      >
        {resultWord(sub)}
      </span>
    ),
    children:
      sub.result.error === undefined ? null : (
        <div className="bg-destructive/10 text-destructive rounded-sm p-2 text-xs break-words [overflow-wrap:anywhere]">
          {sub.result.error}
        </div>
      ),
  })

  if (sub.grounding !== undefined) {
    const { role, name } = sub.grounding.descriptor
    const descriptor = [role, name === undefined ? undefined : displayTargetName(name)].filter((part) => part !== undefined && part !== "").join(" ")
    if (descriptor !== "") {
      sections.push({
        key: "grounding",
        label: "Grounding",
        icon: Target,
        content: null,
        duration: null,
        children: (
          <p data-grounding-descriptor className="m-0 text-sm text-muted-foreground break-words">
            {descriptor}
          </p>
        ),
      })
    }
  }

  return sections
}

export function TabOverview({
  step,
  subAction,
  runId,
  model, playhead = null, recording, frame, playerSource = "frames",
  onPlayerSourceChange = () => {}, onPlayheadChange = () => {}, seekFraction, isTimelineKeyIgnored,
  pipelineRef, timeline, clock, seekRevision, onProgress, onPlayheadObserved, onRecordingEnded, autoPlay,
}: TabOverviewProps) {
  return (
    <div data-overview>
      {model && runId && <Player timeline={timeline} model={model} playhead={playhead} recording={recording} frame={frame}
        source={playerSource} runId={runId} onSourceChange={onPlayerSourceChange}
        onPlayheadChange={onPlayheadChange} seekFraction={seekFraction} seekRevision={seekRevision}
        clock={clock} onProgress={onProgress} onPlayheadObserved={onPlayheadObserved} onRecordingEnded={onRecordingEnded} autoPlay={autoPlay} isTimelineKeyIgnored={isTimelineKeyIgnored} />}
      <div className="border-t">
        <div className="p-3 space-y-3 min-w-0">
          {subAction === null ? null : (
            <ReasoningPipeline
              ref={pipelineRef}
              mode="static"
              sections={buildSubActionSections(subAction)}
            />
          )}

          {step?.error ? (
            <div>
              <p className="text-xs text-muted-foreground font-medium mb-0.5">Error</p>
              <div
                data-step-error
                className="bg-destructive/10 text-destructive rounded-sm p-2 text-sm break-words [overflow-wrap:anywhere]"
              >
                {step.error}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
