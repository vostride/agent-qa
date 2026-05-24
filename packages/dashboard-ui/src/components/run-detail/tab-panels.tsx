import { useRef, useEffect } from "react"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { TabOverview } from "./tab-overview"
import type { ScreenshotEmptyState, ScreenshotSide } from "./tab-overview"
import { TabEnv } from "./tab-env"
import { TabNetwork } from "./tab-network"
import { TabConsole } from "./tab-console"
import { TabAriaTree } from "./tab-aria-tree"
import { TabA11y } from "./tab-a11y"
import type { AccessibilitySummary, StepRow, SubActionData, ExecutionLogEntry } from "@/lib/api"
import type { DisplayStep } from "@/lib/display-step"
import type { ReasoningPipelineHandle } from "@/components/reasoning-pipeline"

interface TabPanelsProps {
  activeTab: string
  onTabChange: (tab: string) => void
  step: DisplayStep | null
  subAction: SubActionData | null
  runId: string | null
  allSteps: DisplayStep[]
  executionLogs?: ExecutionLogEntry[]
  accessibilitySummary?: AccessibilitySummary | null
  platform?: string
  screenshotSide?: ScreenshotSide
  onScreenshotSideChange?: (side: ScreenshotSide) => void
  screenshotEmptyState?: ScreenshotEmptyState
  pipelineRef?: React.RefObject<ReasoningPipelineHandle | null>
}

export function TabPanels({
  activeTab,
  onTabChange,
  step,
  subAction,
  runId,
  allSteps,
  executionLogs = [],
  accessibilitySummary,
  platform,
  screenshotSide,
  onScreenshotSideChange,
  screenshotEmptyState = "absent",
  pipelineRef,
}: TabPanelsProps) {
  const hasExecutionLogs = executionLogs.length > 0
  const consoleScrollRef = useRef<HTMLDivElement>(null)
  const networkScrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (activeTab !== 'console' && activeTab !== 'network') return
    const ref = activeTab === 'console' ? consoleScrollRef : networkScrollRef
    requestAnimationFrame(() => {
      const viewport = ref.current?.querySelector('[data-slot="scroll-area-viewport"]')
      if (viewport) viewport.scrollTop = viewport.scrollHeight
    })
  }, [activeTab, step?.id])

  if (!step) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        Select a step to view details
      </div>
    )
  }

  return (
    <Tabs
      value={activeTab}
      onValueChange={onTabChange}
      className="flex h-full min-h-0 flex-col overflow-hidden gap-0"
    >
      <TabsList variant="line" className="w-full justify-start border-b px-3 h-9 shrink-0 rounded-none">
        <TabsTrigger value="overview" className="text-xs rounded-none flex-initial">Overview</TabsTrigger>
        <TabsTrigger value="env" className="text-xs rounded-none flex-initial">Variables</TabsTrigger>
        <TabsTrigger value="network" className="text-xs rounded-none flex-initial">Network</TabsTrigger>
        <TabsTrigger value="console" className="text-xs rounded-none flex-initial">
          {hasExecutionLogs ? 'stdout' : 'Console'}
        </TabsTrigger>
        <TabsTrigger value="aria" className="text-xs rounded-none flex-initial">ARIA Tree</TabsTrigger>
        <TabsTrigger value="a11y" className="text-xs rounded-none flex-initial">A11y</TabsTrigger>
      </TabsList>

      <TabsContent value="overview" className="flex-1 min-h-0">
        <ScrollArea className="h-full">
          <TabOverview
            step={step}
            subAction={subAction}
            runId={runId}
            screenshotSide={screenshotSide}
            onScreenshotSideChange={onScreenshotSideChange}
            screenshotEmptyState={screenshotEmptyState}
            pipelineRef={pipelineRef}
          />
        </ScrollArea>
      </TabsContent>

      <TabsContent value="env" className="flex-1 min-h-0">
        <ScrollArea className="h-full">
          <TabEnv step={step as unknown as StepRow} executionLogs={executionLogs} />
        </ScrollArea>
      </TabsContent>

      <TabsContent value="network" className="flex-1 min-h-0">
        <div ref={networkScrollRef} className="h-full">
          <ScrollArea className="h-full">
            <TabNetwork step={step} allSteps={allSteps} platform={platform} />
          </ScrollArea>
        </div>
      </TabsContent>

      <TabsContent value="console" className="flex-1 min-h-0">
        <div ref={consoleScrollRef} className="h-full">
          <ScrollArea className="h-full">
            <TabConsole step={step} allSteps={allSteps} executionLogs={executionLogs} isHookStep={hasExecutionLogs} />
          </ScrollArea>
        </div>
      </TabsContent>

      <TabsContent value="aria" className="flex flex-1 min-h-0 overflow-hidden">
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <TabAriaTree step={step} subAction={subAction} runId={runId ?? ''} />
        </div>
      </TabsContent>

      <TabsContent value="a11y" className="flex-1 min-h-0">
        <ScrollArea className="h-full">
          <TabA11y step={step as unknown as StepRow} summary={accessibilitySummary} />
        </ScrollArea>
      </TabsContent>
    </Tabs>
  )
}
