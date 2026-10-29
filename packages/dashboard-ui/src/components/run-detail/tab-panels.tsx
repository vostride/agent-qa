import { useRef, useEffect } from "react"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { TabOverview } from "./tab-overview"
import type { OverviewPlayerProps } from "./tab-overview"
import { TabEnv } from "./tab-env"
import { TabNetwork } from "./tab-network"
import { TabConsole } from "./tab-console"
import { TabAriaTree } from "./tab-aria-tree"
import { TabA11y } from "./tab-a11y"
import { TabKnowledge } from "./tab-knowledge"
import type { ExecutionLogEntry } from "@/lib/api"
import type { KnowledgeView, StepRefContext } from "@/lib/knowledge-view"
import type { DisplayStep } from "@/lib/display-step"
import type { ReasoningPipelineHandle } from "@/components/reasoning-pipeline"
import type { RunDetailSubAction } from "@vostride/agent-qa-schema"
import { resolveEvidenceView } from '@/lib/evidence-state-view'
import { Accessibility, CircleX, Globe } from 'lucide-react'
import type { EvidenceKind } from '@vostride/agent-qa-schema'
import { absentTriggerName, countedTriggerName, PROBLEM_COUNT_TONES, tabCounts } from '@/lib/evidence-counts'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { EvidenceScopeLine, type EvidenceScope } from './evidence-scope-line'

interface TabPanelsProps extends OverviewPlayerProps {
  activeTab: string
  onTabChange: (tab: string) => void
  step: DisplayStep | null
  subAction: RunDetailSubAction | null
  runId: string | null
  allSteps: DisplayStep[]
  executionLogs?: ExecutionLogEntry[]
  platform?: string
  pipelineRef?: React.RefObject<ReasoningPipelineHandle | null>
  // `undefined` is the read not yet landed; the page owns the one `runs.knowledge` client.
  knowledge?: KnowledgeView | undefined
  // The page's step-reference callback and resolver; the tab only calls back.
  knowledgeStepRefs?: StepRefContext
  onSelectStep?: (stepId: string) => void
}

export function TabPanels({
  activeTab,
  onTabChange,
  step,
  subAction,
  runId,
  allSteps,
  executionLogs = [],
  platform,
  model, playhead, recording, frame, playerSource, onPlayerSourceChange, onPlayheadChange, seekFraction, isTimelineKeyIgnored,
  pipelineRef, timeline, clock, seekRevision, onProgress, onPlayheadObserved, onRecordingEnded, autoPlay,
  knowledge,
  knowledgeStepRefs,
  onSelectStep,
}: TabPanelsProps) {
  const hasExecutionLogs = executionLogs.length > 0
  const consoleScrollRef = useRef<HTMLDivElement>(null)
  const networkScrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (activeTab !== 'console' && activeTab !== 'network') return
    const ref = activeTab === 'console' ? consoleScrollRef : networkScrollRef
    const scrollToEnd = () => {
      const viewport = ref.current?.querySelector('[data-slot="scroll-area-viewport"]')
      if (viewport) viewport.scrollTop = viewport.scrollHeight
    }
    const frame = requestAnimationFrame(scrollToEnd)
    const observer = new MutationObserver(scrollToEnd)
    if (ref.current) observer.observe(ref.current, { childList: true, subtree: true })
    return () => { cancelAnimationFrame(frame); observer.disconnect() }
  }, [activeTab, step?.id])

  const selection: Parameters<typeof resolveEvidenceView>[0]['selection'] = hasExecutionLogs
    ? executionLogs.some(log => log.type === 'hook') ? 'hook' : 'execution-log'
    : !step ? 'none' : subAction ? 'sub-action' : 'step'

  const counts = tabCounts(step?.evidence, subAction?.ariaEvidence, selection)
  const durableStep = !hasExecutionLogs && step?.testIndex !== undefined && step.stepIndex !== undefined
    ? step : null
  const scopeLine = (scope: EvidenceScope) => durableStep && (
    <EvidenceScopeLine
      scope={scope}
      step={durableStep.displayStepOrder}
      total={scope === 'step' ? durableStep.displayStepTotal ?? allSteps.length : durableStep.subActions?.length ?? 0}
      subAction={subAction ? subAction.subActionIndex + 1 : undefined}
    />
  )
  const evidenceTrigger = (kind: EvidenceKind, value: string, label: string) => {
    const count = kind === 'console' && hasExecutionLogs ? undefined : counts[kind]
    const name = count?.kind === 'absent' ? absentTriggerName(kind, count.title)
      : count ? countedTriggerName(kind, count) : undefined
    const Icon = kind === 'console' ? CircleX : kind === 'network' ? Globe : Accessibility
    const trigger = (
      <TabsTrigger
        value={value}
        aria-label={name || undefined}
        className={`text-xs rounded-none flex-initial${count?.kind === 'absent' ? ' opacity-60 data-[state=active]:opacity-100' : ''}`}
      >
        {label}
        {count && count.kind !== 'absent' && (
          <span
            data-tab-count={count.count}
            data-tab-count-kind={count.kind}
            aria-hidden="true"
            className={`inline-flex items-center gap-1 tabular-nums ${count.kind === 'total' ? 'text-muted-foreground' : PROBLEM_COUNT_TONES[count.severity]}`}
          >
            {count.kind === 'problem' && <Icon className="h-3.5 w-3.5 size-3.5" />}
            {count.count}
          </span>
        )}
      </TabsTrigger>
    )
    return count?.kind === 'absent' ? (
      <Tooltip>
        <TooltipTrigger asChild>{trigger}</TooltipTrigger>
        <TooltipContent>{name}</TooltipContent>
      </Tooltip>
    ) : trigger
  }

  return (
    <TooltipProvider>
    <Tabs
      value={activeTab}
      onValueChange={onTabChange}
      className="flex h-full min-h-0 flex-col overflow-hidden gap-0"
    >
      <TabsList variant="line" className="w-full justify-start overflow-x-auto border-b px-3 h-9 shrink-0 rounded-none [&_[role=tab]]:shrink-0">
        <TabsTrigger value="overview" className="text-xs rounded-none flex-initial">Overview</TabsTrigger>
        {evidenceTrigger('variables', 'env', 'Variables')}
        {evidenceTrigger('network', 'network', 'Network')}
        {evidenceTrigger('console', 'console', hasExecutionLogs ? 'stdout' : 'Console')}
        {evidenceTrigger('aria', 'aria', 'ARIA Tree')}
        {evidenceTrigger('a11y', 'a11y', 'A11y')}
        {/*
          THE TRIGGER IS STATIC TAB METADATA (UI-SPEC, Knowledge tab trigger). It renders with its
          six siblings whatever the `runs.knowledge` read is doing: the loading state and the error
          state both live INSIDE the content, so the tab is always selectable and never lies about
          whether there is something behind it.
        */}
        <TabsTrigger value="knowledge" className="text-xs rounded-none flex-initial">Knowledge</TabsTrigger>
      </TabsList>

      <TabsContent value="overview" className="flex-1 min-h-0">
        <ScrollArea className="h-full">
          {(step || model) && <TabOverview
            timeline={timeline}
            step={step}
            subAction={subAction}
            runId={runId}
            model={model} playhead={playhead} recording={recording} frame={frame}
            playerSource={playerSource} onPlayerSourceChange={onPlayerSourceChange}
            onPlayheadChange={onPlayheadChange} seekFraction={seekFraction} seekRevision={seekRevision}
            clock={clock} onProgress={onProgress} onPlayheadObserved={onPlayheadObserved} onRecordingEnded={onRecordingEnded} autoPlay={autoPlay}
            isTimelineKeyIgnored={isTimelineKeyIgnored}
            pipelineRef={pipelineRef}
          />}
        </ScrollArea>
      </TabsContent>

      <TabsContent value="env" className="flex-1 min-h-0">
        <ScrollArea className="h-full">
          {scopeLine('step')}
          {/* Isolate evidence panes from ScrollArea's direct-child display:block rule. */}
          <div><TabEnv step={step} executionLogs={executionLogs} runId={runId} selection={selection} allSteps={allSteps} onSelectStep={onSelectStep} /></div>
        </ScrollArea>
      </TabsContent>

      <TabsContent value="network" className="flex-1 min-h-0">
        <div ref={networkScrollRef} className="h-full">
          <ScrollArea className="h-full">
            {scopeLine('step')}
            <div><TabNetwork step={step} allSteps={allSteps} platform={platform} runId={runId} selection={selection} evidenceSteps={allSteps} onSelectStep={onSelectStep} /></div>
          </ScrollArea>
        </div>
      </TabsContent>

      <TabsContent value="console" className="flex-1 min-h-0">
        <div ref={consoleScrollRef} className="h-full">
          <ScrollArea className="h-full">
            {scopeLine('step')}
            <div><TabConsole step={step} allSteps={allSteps} executionLogs={executionLogs} isHookStep={hasExecutionLogs} runId={runId} selection={selection} evidenceSteps={allSteps} onSelectStep={onSelectStep} /></div>
          </ScrollArea>
        </div>
      </TabsContent>

      <TabsContent value="aria" className="flex flex-col flex-1 min-h-0 overflow-hidden">
        {scopeLine('sub-action')}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <TabAriaTree step={step} subAction={subAction} runId={runId} selection={selection} />
        </div>
      </TabsContent>

      <TabsContent value="a11y" className="flex-1 min-h-0">
        <ScrollArea className="h-full">
          {scopeLine('step')}
          <div><TabA11y step={step} runId={runId} selection={selection} allSteps={allSteps} onSelectStep={onSelectStep} /></div>
        </ScrollArea>
      </TabsContent>

      <TabsContent value="knowledge" className="flex-1 min-h-0">
        <ScrollArea className="h-full">
          <TabKnowledge view={knowledge} stepRefs={knowledgeStepRefs} />
        </ScrollArea>
      </TabsContent>
    </Tabs>
    </TooltipProvider>
  )
}
