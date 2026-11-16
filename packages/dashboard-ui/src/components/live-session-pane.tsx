import { useEffect, useMemo, useState, type ReactNode } from "react"
import {
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileSearch,
  Globe,
  Loader2,
  PlayCircle,
  RefreshCw,
  Square,
  Terminal,
  Webhook,
  AlertTriangle,
} from "lucide-react"
import { EditorAriaPanel } from "@/components/editor/aria-panel"
import { EditorStepDetail } from "@/components/editor/editor-step-detail"
import { EmptyState } from "@/components/empty-state"
import { LivePreview } from "@/components/live-preview/live-preview"
import { LiveModeAuthStateControl, type LiveModeAuthStateCaptureConfig } from "@/components/live-mode-auth-state-control"
import { TabConsole } from "@/components/run-detail/tab-console"
import { TabEnv } from "@/components/run-detail/tab-env"
import { TabNetwork } from "@/components/run-detail/tab-network"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { TFunction } from "i18next"
import type { ConnectionState, EditorStep, EditorTest, LiveHookExecution, PendingNavigationState } from "@/hooks/use-live-editor"
import { useTranslation } from "@/i18n"
import { fromEditorStep, type DisplayStep } from "@/lib/display-step"
import { formatUnit } from "@/lib/format"
import { statusNameText } from "@/lib/live-step-row"
import type { Selection } from "@/lib/selection"
import { cn } from "@/lib/utils"

export type LiveDevtoolsTab = "reasoning" | "env" | "console" | "network" | "aria"
export interface LiveSessionTerminalState {
  reason: "ended" | "disconnected"
  title: string
  description: string
}

interface LiveSessionPaneProps {
  connectionState: ConnectionState
  isLaunching: boolean
  targetName: string | null
  targetLabel: string | null
  platform: "web" | "android" | "ios"
  /** The live editor session the preview mints its view for; null before one exists. */
  liveSessionId: string | null
  // The server has dropped this session.
  sessionGone?: boolean
  currentUrl: string | null
  pendingNavigation: PendingNavigationState | null
  steps: EditorStep[]
  setupHooks: LiveHookExecution[]
  teardownHooks: LiveHookExecution[]
  tests?: EditorTest[]
  selection: Selection | null
  runningStepId: string | null
  terminalState?: LiveSessionTerminalState | null
  draftState: "invalid" | "unsaved" | "saved"
  ariaTree: string | null
  errorMessage?: string | null
  devtoolsTab: LiveDevtoolsTab
  canRunAll: boolean
  isRunningAll: boolean
  isStoppingRunAll: boolean
  setupHooksStale?: boolean
  onDevtoolsTabChange: (value: LiveDevtoolsTab) => void
  onRunAll: () => void
  onStopAll: () => void
  onEndSession: () => void
  onRestartSession?: () => void
  showEndSessionAction?: boolean
  onCloseLiveMode?: () => void
  onStartFreshSession?: () => void
  onBack: () => void
  onForward: () => void
  onRefresh: () => void
  onNavigate: (url: string) => void
  onRequestAriaTree: () => void
  executionUnit?: "step" | "test"
  runAllLabel?: string
  stopAllLabel?: string
  // Kept for the page callers; the pane does not render it.
  liveSessionNumber?: number | null
  unitRowsSlot?: ReactNode
  authStateCapture?: LiveModeAuthStateCaptureConfig | null
  // The auth state a web session named but could not load, so it started signed out.
  signedOutAuthState?: { name: string; targetName: string } | null
}

function PaneNotice({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mt-3 flex flex-wrap items-start justify-between gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
      <div className="flex min-w-0 flex-1 items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <span>{children}</span>
      </div>
      {action}
    </div>
  )
}

function draftBadgeMeta(
  t: TFunction,
  draftState: LiveSessionPaneProps["draftState"],
): { label: string; className: string } {
  switch (draftState) {
    case "invalid":
      return {
        label: t("live.pane.draft.invalid"),
        className: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
      }
    case "saved":
      return {
        label: t("live.pane.draft.saved"),
        className: "border-border/70 bg-background text-muted-foreground",
      }
    default:
      return {
        label: t("live.pane.draft.unsaved"),
        className: "border-primary/25 bg-primary/10 text-primary",
      }
  }
}

function normalizeAddressInput(value: string, currentUrl: string | null): string {
  const trimmed = value.trim()
  if (!trimmed) return ""

  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(trimmed)) {
    return trimmed
  }

  if (trimmed.startsWith("/")) {
    try {
      return new URL(trimmed, currentUrl ?? "https://example.com").toString()
    } catch {
      return trimmed
    }
  }

  if (/^[\w.-]+(?::\d+)?(?:[/?#]|$)/.test(trimmed)) {
    return `https://${trimmed}`
  }

  return trimmed
}

function formatLiveDuration(ms: number): string {
  if (ms < 1000) return formatUnit(ms, "millisecond")
  return formatUnit(Number((ms / 1000).toFixed(1)), "second", { minimumFractionDigits: 1 })
}

function HookStatusBadge({ hook }: { hook: LiveHookExecution }) {
  const { t } = useTranslation()
  if (hook.status === "passed") {
    return (
      <Badge className="border-emerald-500/20 bg-emerald-500/15 text-emerald-500">
        <CheckCircle2 className="size-3" />
        {t("status.passed")}
      </Badge>
    )
  }

  if (hook.status === "failed") {
    return (
      <Badge variant="destructive">
        <AlertTriangle className="size-3" />
        {t("status.failed")}
      </Badge>
    )
  }

  if (hook.status === "running") {
    return (
      <Badge className="border-primary/20 bg-primary/15 text-primary">
        <Loader2 className="size-3 animate-spin" />
        {t("status.running")}
      </Badge>
    )
  }

  return <Badge variant="outline">{t("status.pending")}</Badge>
}

function HookVariables({ hook }: { hook: LiveHookExecution }) {
  const { t } = useTranslation()
  if (!hook.variables || Object.keys(hook.variables).length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t("live.pane.hook.noVariables")}
      </div>
    )
  }

  return (
    <div className="space-y-2 p-4">
      {Object.entries(hook.variables).map(([key, value]) => (
        <div key={key} className="rounded-md border bg-background/80 px-3 py-2">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{key}</div>
          <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-xs">{value}</pre>
        </div>
      ))}
    </div>
  )
}

function HookDetailPanel({ hook }: { hook: LiveHookExecution }) {
  const { t } = useTranslation()
  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2">
          <Webhook className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium">{hook.name}</span>
        </div>
        <Badge variant="outline" className="font-mono text-[10px]">
          {hook.id}
        </Badge>
        <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
          {hook.phase}
        </Badge>
        <HookStatusBadge hook={hook} />
        {hook.duration != null && (
          <span className="text-xs text-muted-foreground">{formatLiveDuration(hook.duration)}</span>
        )}
      </div>

      {hook.error && (
        <div className="min-w-0 max-w-full rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive [overflow-wrap:anywhere]">
          {hook.error}
        </div>
      )}

      {hook.stdout && (
        <div className="space-y-1">
          <div className="text-xs font-medium text-muted-foreground">stdout</div>
          <pre className="rounded-md border bg-background/80 p-3 text-xs whitespace-pre-wrap break-all">{hook.stdout}</pre>
        </div>
      )}

      {hook.stderr && (
        <div className="space-y-1">
          <div className="text-xs font-medium text-muted-foreground">stderr</div>
          <pre className="rounded-md border border-destructive/20 bg-destructive/5 p-3 text-xs whitespace-pre-wrap break-all text-destructive">{hook.stderr}</pre>
        </div>
      )}

      {hook.variables && Object.keys(hook.variables).length > 0 && (
        <div className="space-y-1">
          <div className="text-xs font-medium text-muted-foreground">{t("live.pane.hook.emittedVariables")}</div>
          <HookVariables hook={hook} />
        </div>
      )}

      {!hook.stdout && !hook.stderr && (!hook.variables || Object.keys(hook.variables).length === 0) && !hook.error && (
        <EmptyState
          icon={Webhook}
          title={t("live.pane.hook.noOutputTitle")}
          description={t("live.pane.hook.noOutputDescription")}
        />
      )}
    </div>
  )
}

function findRelevantStep<T extends EditorStep>(steps: T[]): T | null {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index]
    if (
      step.status !== "idle"
      || step.phases.length > 0
      || step.executionHistory.length > 0
      || step.consoleLogs.length > 0
      || step.networkLogs.length > 0
    ) {
      return step
    }
  }

  return null
}

function statusTone(status: EditorTest["status"]): string {
  switch (status) {
    case "running":
      return "border-primary/20 bg-primary/10 text-primary"
    case "passed":
      return "border-emerald-500/20 bg-emerald-500/10 text-emerald-500"
    case "failed":
      return "border-destructive/20 bg-destructive/10 text-destructive"
    case "cancelled":
      return "border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-400"
    default:
      return "border-border/70 bg-background text-muted-foreground"
  }
}

function stepStatusTone(status: DisplayStep["status"]): string {
  switch (status) {
    case "running":
      return "border-primary/20 bg-primary/10 text-primary"
    case "passed":
    case "healed":
    case "flaky":
      return "border-emerald-500/20 bg-emerald-500/10 text-emerald-500"
    case "failed":
    case "cancelled":
    case "skipped":
      return "border-destructive/20 bg-destructive/10 text-destructive"
    default:
      return "border-border/70 bg-background text-muted-foreground"
  }
}

function SelectedTestSummary({
  test,
  selectedStep,
  subAction,
}: {
  test: EditorTest
  selectedStep: DisplayStep | null
  subAction: NonNullable<DisplayStep["liveSubActions"]>[number] | null
}) {
  const { t } = useTranslation()
  const displaySteps = test.liveSteps.map((stepDetail) => fromEditorStep(stepDetail, stepDetail.stepIndex))
  const hookList = (hooks: LiveHookExecution[]) =>
    hooks
      .map((hook) => t("live.pane.hook.withStatus", { name: hook.name, status: statusNameText(hook.status) }))
      .join(", ")

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium">{test.name}</div>
          <div className="text-xs text-muted-foreground">{test.path}</div>
        </div>
        <Badge variant="outline" className={cn("text-[10px] uppercase tracking-wide", statusTone(test.status))}>
          {statusNameText(test.status)}
        </Badge>
        {typeof test.duration === "number" && (
          <span className="text-xs text-muted-foreground">
            {formatLiveDuration(test.duration)}
          </span>
        )}
      </div>

      {test.error && (
        <div className="min-w-0 max-w-full rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive [overflow-wrap:anywhere]">
          {test.error}
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-md border bg-background/80 px-3 py-2">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t("live.pane.test.setupHooks")}</div>
          <div className="mt-2 text-sm">
            {test.perTestSetupHooks.length > 0
              ? hookList(test.perTestSetupHooks)
              : t("live.pane.test.noSetupHooks")}
          </div>
        </div>
        <div className="rounded-md border bg-background/80 px-3 py-2">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t("live.pane.test.teardownHooks")}</div>
          <div className="mt-2 text-sm">
            {test.perTestTeardownHooks.length > 0
              ? hookList(test.perTestTeardownHooks)
              : t("live.pane.test.noTeardownHooks")}
          </div>
        </div>
      </div>

      {displaySteps.length > 0 ? (
        <div className="space-y-2">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t("live.pane.test.steps")}
          </div>
          <div className="space-y-3">
            {displaySteps.map((step) => {
              const isSelectedStep = selectedStep?.id === step.id
              const subActions = step.liveSubActions ?? []
              return (
                <div
                  key={step.id}
                  className={cn(
                    "overflow-hidden rounded-md border bg-background/80",
                    isSelectedStep && "border-primary/30 ring-1 ring-primary/20",
                  )}
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-2 border-b px-3 py-2">
                    <span className="shrink-0 text-sm font-medium">
                      {t("live.pane.test.stepNumber", { number: step.stepOrder + 1 })}
                    </span>
                    <Badge variant="outline" className={cn("text-[10px] uppercase tracking-wide", stepStatusTone(step.status))}>
                      {statusNameText(step.status)}
                    </Badge>
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                      {step.name}
                    </span>
                    {step.duration > 0 && (
                      <span className="text-xs text-muted-foreground">
                        {formatLiveDuration(step.duration)}
                      </span>
                    )}
                  </div>

                  {subActions.length > 0 ? (
                    <div className="divide-y divide-border/60">
                      {subActions.map((candidate) => (
                        <div
                          key={`${step.id}-sub-${candidate.index}`}
                          className={cn(
                            isSelectedStep && subAction?.index === candidate.index && "bg-primary/5",
                          )}
                        >
                          <EditorStepDetail step={step} subAction={candidate} />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <EditorStepDetail step={step} subAction={isSelectedStep ? subAction : null} />
                  )}
                </div>
              )
            })}
          </div>
        </div>
      ) : (
        <div className="rounded-md border border-dashed px-4 py-6 text-sm text-muted-foreground">
          {t("live.pane.test.noStepDetail")}
        </div>
      )}
    </div>
  )
}

export function LiveSessionPane({
  connectionState,
  isLaunching,
  targetName,
  targetLabel,
  platform,
  liveSessionId,
  sessionGone = false,
  currentUrl,
  pendingNavigation,
  steps,
  setupHooks,
  teardownHooks,
  tests = [],
  selection,
  runningStepId,
  terminalState,
  draftState,
  ariaTree,
  errorMessage,
  devtoolsTab,
  canRunAll,
  isRunningAll,
  isStoppingRunAll,
  setupHooksStale = false,
  onDevtoolsTabChange,
  onRunAll,
  onStopAll,
  onEndSession,
  onRestartSession,
  showEndSessionAction = false,
  onCloseLiveMode,
  onStartFreshSession,
  onBack,
  onForward,
  onRefresh,
  onNavigate,
  onRequestAriaTree,
  executionUnit = "step",
  runAllLabel,
  stopAllLabel,
  unitRowsSlot,
  authStateCapture = null,
  signedOutAuthState = null,
}: LiveSessionPaneProps) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const [addressValue, setAddressValue] = useState("")
  const [isEditingAddress, setIsEditingAddress] = useState(false)

  const effectiveState: ConnectionState = isLaunching ? "connecting" : connectionState

  const displaySteps = useMemo(
    () => steps.map((step, index) => fromEditorStep(step, index)),
    [steps],
  )
  const suiteMode = executionUnit === "test"
  const showRunAllToolbar = !suiteMode
  const stepModeHooks = useMemo(
    () => [...setupHooks, ...teardownHooks],
    [setupHooks, teardownHooks],
  )

  const fallbackStepId = useMemo(() => {
    if (runningStepId) return runningStepId

    return findRelevantStep(steps)?.id ?? null
  }, [runningStepId, steps])

  const selectedStepId = selection && "stepId" in selection
    ? selection.stepId
    : fallbackStepId

  const selectedLegacyStep = useMemo(
    () => displaySteps.find((step) => step.id === selectedStepId) ?? null,
    [displaySteps, selectedStepId],
  )

  const selectedLegacySubAction = useMemo(() => {
    if (selection?.type !== "subaction" || !selectedLegacyStep) return null
    return selectedLegacyStep.liveSubActions?.[selection.subIndex] ?? null
  }, [selection, selectedLegacyStep])

  const selectedLegacyEditorStep = useMemo(
    () => steps.find((step) => step.id === selectedLegacyStep?.id) ?? null,
    [selectedLegacyStep, steps],
  )
  const selectedLegacyHook = useMemo(() => {
    if (selection?.type !== "hook") return null
    return stepModeHooks.find((hook) => hook.id === selection.hookId) ?? null
  }, [selection, stepModeHooks])

  const selectedTest = useMemo(() => {
    if (!suiteMode || !selection) return null
    if (selection.type === "test" || selection.type === "test-hook") {
      return tests[selection.testIndex] ?? null
    }
    if ("stepId" in selection) {
      return tests.find((test) => test.liveSteps.some((step) => step.id === selection.stepId)) ?? null
    }
    return null
  }, [selection, suiteMode, tests])

  const selectedSuiteHook = useMemo(() => {
    if (!suiteMode || selection?.type !== "suite-hook") return null
    const hooks = selection.phase === "setup" ? setupHooks : teardownHooks
    return hooks.find((hook) => hook.id === selection.hookId) ?? null
  }, [selection, setupHooks, suiteMode, teardownHooks])

  const selectedTestHook = useMemo(() => {
    if (!suiteMode || selection?.type !== "test-hook") return null
    const test = tests[selection.testIndex]
    if (!test) return null
    const hooks = selection.phase === "setup" ? test.perTestSetupHooks : test.perTestTeardownHooks
    return hooks.find((hook) => hook.id === selection.hookId) ?? null
  }, [selection, suiteMode, tests])

  const selectedSuiteEditorStep = useMemo(() => {
    if (!suiteMode || !selectedTest) return null
    if (selection && "stepId" in selection) {
      const explicit = selectedTest.liveSteps.find((step) => step.id === selection.stepId)
      if (explicit) return explicit
    }
    if (selectedTest.runningStepIndex !== null) {
      const runningStep = selectedTest.liveSteps.find((step) => step.stepIndex === selectedTest.runningStepIndex)
      if (runningStep) return runningStep
    }
    return findRelevantStep(selectedTest.liveSteps)
  }, [selection, selectedTest, suiteMode])

  const selectedSuiteStep = useMemo(
    () => selectedSuiteEditorStep ? fromEditorStep(selectedSuiteEditorStep, selectedSuiteEditorStep.stepIndex) : null,
    [selectedSuiteEditorStep],
  )

  const selectedSuiteSubAction = useMemo(() => {
    if (selection?.type !== "subaction" || !selectedSuiteStep) return null
    return selectedSuiteStep.liveSubActions?.[selection.subIndex] ?? null
  }, [selection, selectedSuiteStep])

  const selectedTestDisplaySteps = useMemo(
    () => selectedTest?.liveSteps.map((step) => fromEditorStep(step, step.stepIndex)) ?? [],
    [selectedTest],
  )

  const selectedSuiteExecutionLogs = selectedSuiteEditorStep?.executionLogs ?? []
  const selectedExecutionLogs = selectedLegacyEditorStep?.executionLogs ?? []
  const draftMeta = draftBadgeMeta(t, draftState)

  const browserLabel = platform === "web"
    ? (currentUrl || targetLabel || t("live.pane.address.startUrl"))
    : (targetLabel || t(platform === "android" ? "live.pane.address.androidDevice" : "live.pane.address.iosDevice"))
  const showAuthStateCapture = Boolean(
    platform === "web"
    && authStateCapture
    && targetName
    && (effectiveState === "connected" || effectiveState === "executing")
    && !terminalState,
  )

  useEffect(() => {
    if (!isEditingAddress) {
      setAddressValue(browserLabel)
    }
  }, [browserLabel, isEditingAddress])

  const handleCopyUrl = async () => {
    if (!browserLabel) return
    await navigator.clipboard.writeText(browserLabel)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  const handleNavigate = () => {
    const nextUrl = normalizeAddressInput(addressValue, currentUrl)
    if (!nextUrl) {
      setAddressValue(browserLabel)
      return
    }
    setAddressValue(nextUrl)
    setIsEditingAddress(false)
    onNavigate(nextUrl)
  }

  // A mobile session has no editor controls, so it passes nothing and no empty row renders.
  const previewChrome = platform === "web" ? (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onBack}
          disabled={effectiveState === "executing" || effectiveState === "idle"}
          aria-label={t("live.pane.address.back")}
        >
          <ChevronLeft className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onForward}
          disabled={effectiveState === "executing" || effectiveState === "idle"}
          aria-label={t("live.pane.address.forward")}
        >
          <ChevronRight className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onRefresh}
          disabled={effectiveState === "executing" || effectiveState === "idle"}
          aria-label={t("live.pane.address.refresh")}
        >
          <RefreshCw className="size-3.5" />
        </Button>
      </div>

      <div className="flex min-w-0 flex-1 items-center gap-2 rounded-full border bg-background px-3 py-1">
        {pendingNavigation ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <Globe className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <input
          value={addressValue}
          title={browserLabel}
          onFocus={() => setIsEditingAddress(true)}
          onBlur={() => {
            setIsEditingAddress(false)
            setAddressValue(browserLabel)
          }}
          onChange={(event) => setAddressValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              handleNavigate()
            }
            if (event.key === "Escape") {
              event.preventDefault()
              setIsEditingAddress(false)
              setAddressValue(browserLabel)
            }
          }}
          disabled={effectiveState === "executing" || effectiveState === "idle"}
          className={cn(
            "min-w-0 flex-1 bg-transparent text-sm outline-none",
            isEditingAddress ? "text-left" : "text-center",
          )}
        />
      </div>

      <div className="flex shrink-0 items-center justify-end gap-1">
        {showAuthStateCapture && authStateCapture && (
          <LiveModeAuthStateControl
            capture={authStateCapture}
            disabled={effectiveState === "executing"}
          />
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={handleCopyUrl}
          disabled={!browserLabel}
          aria-label={copied ? t("live.pane.address.copied") : t("live.pane.address.copy")}
          title={copied ? t("live.pane.address.copied") : t("live.pane.address.copy")}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </Button>
      </div>
    </div>
  ) : null

  const showSelectionEmptyState = !suiteMode && Boolean(
    selection
    && selection.type !== "hook"
    && !selectedLegacyStep,
  )

  return (
    <div className="flex h-full min-h-0 flex-col bg-card/30">
      {/* The live header: target, draft badge and actions; health is the preview dot's alone. */}
      <div data-live-header className="border-b px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <span className="text-sm font-medium">
              {targetName || t("live.pane.fallbackTitle")}
            </span>
            {errorMessage && !terminalState && (
              <div className="min-w-0 max-w-2xl text-xs text-destructive [overflow-wrap:anywhere]">
                {errorMessage}
              </div>
            )}
          </div>

          {!terminalState && (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Badge variant="outline" className={cn("text-[10px]", draftMeta.className)}>
                {draftMeta.label}
              </Badge>
              {showRunAllToolbar && (
                isRunningAll ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={onStopAll}
                    disabled={isStoppingRunAll}
                  >
                    {isStoppingRunAll ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Square className="size-3.5" />
                    )}
                    {isStoppingRunAll ? t("live.pane.stopping") : (stopAllLabel ?? t("live.pane.stopAll"))}
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={onRunAll}
                    disabled={!canRunAll}
                  >
                    <PlayCircle className="size-3.5" />
                    {runAllLabel ?? t("live.pane.runAll")}
                  </Button>
                )
              )}
              {showEndSessionAction && (
                <Button variant="destructive" size="sm" onClick={onEndSession}>
                  <Square className="size-3.5" />
                  {t("live.pane.endSession")}
                </Button>
              )}
            </div>
          )}
        </div>

        {setupHooksStale && !terminalState && (
          <PaneNotice
            action={onRestartSession && (
              <Button type="button" size="sm" className="shrink-0" onClick={onRestartSession}>
                {t("live.pane.restartSession")}
              </Button>
            )}
          >
            {t("live.pane.hooksStale")}
          </PaneNotice>
        )}
        {signedOutAuthState && !terminalState && (
          <PaneNotice>
            {t("live.pane.signedOut", {
              name: signedOutAuthState.name,
              target: signedOutAuthState.targetName,
            })}
          </PaneNotice>
        )}

      </div>

      {executionUnit === "test" && unitRowsSlot}

      <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
        <ResizablePanel defaultSize={62} minSize={32}>
          {terminalState ? (
            <div className="flex h-full items-center justify-center px-6 py-8">
              <div className="flex max-w-lg flex-col items-center gap-4 rounded-lg border bg-background/80 px-6 py-8 text-center">
                <div className="rounded-full bg-muted p-3">
                  <Terminal className="size-6 text-muted-foreground" />
                </div>
                <div className="space-y-2">
                  <h3 className="text-base font-semibold">{terminalState.title}</h3>
                  <p className="text-sm text-muted-foreground">
                    {terminalState.description}
                  </p>
                </div>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  {onCloseLiveMode && (
                    <Button variant="outline" size="sm" onClick={onCloseLiveMode}>
                      {t("live.pane.closeLiveMode")}
                    </Button>
                  )}
                  {onStartFreshSession && (
                    <Button size="sm" onClick={onStartFreshSession}>
                      {t("live.pane.startFreshSession")}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          ) : effectiveState === "idle" ? (
            <div className="flex h-full items-center justify-center px-6 py-8">
              <div className="flex max-w-md flex-col items-center gap-4 rounded-lg border bg-background/70 px-6 py-8 text-center">
                <div className="rounded-full bg-muted p-3">
                  <Terminal className="size-6 text-muted-foreground" />
                </div>
                <div className="space-y-2">
                  <h3 className="text-base font-semibold">{t("live.pane.idleTitle")}</h3>
                  <p className="text-sm text-muted-foreground">{t("live.pane.idleDescription")}</p>
                </div>
              </div>
            </div>
          ) : liveSessionId ? (
            <LivePreview
              subject={{
                kind: "editor",
                sessionId: liveSessionId,
                sessionGone,
                onStartFresh: onStartFreshSession ?? onEndSession,
              }}
              chrome={previewChrome}
            />
          ) : (
            <div className="flex h-full items-center justify-center gap-3 text-sm text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
              {t("live.pane.connecting")}
            </div>
          )}
        </ResizablePanel>

        <ResizableHandle withHandle />

        <ResizablePanel defaultSize={38} minSize={20}>
          <Tabs
            value={devtoolsTab}
            onValueChange={(value) => onDevtoolsTabChange(value as LiveDevtoolsTab)}
            className="flex h-full min-h-0 flex-col"
          >
            <TabsList variant="line" className="h-9 justify-start rounded-none border-b px-3">
              <TabsTrigger value="reasoning" className="rounded-none text-xs">
                {t("live.pane.tab.reasoning")}
              </TabsTrigger>
              <TabsTrigger value="env" className="rounded-none text-xs">
                {t("live.pane.tab.env")}
              </TabsTrigger>
              <TabsTrigger value="network" className="rounded-none text-xs">
                {t("live.pane.tab.network")}
              </TabsTrigger>
              <TabsTrigger value="console" className="rounded-none text-xs">
                {t("live.pane.tab.console")}
              </TabsTrigger>
              <TabsTrigger value="aria" className="rounded-none text-xs">
                {t("live.pane.tab.aria")}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="reasoning" className="m-0 flex-1 overflow-hidden">
              <ScrollArea className="h-full">
                {suiteMode ? (
                  selectedSuiteHook ? (
                    <HookDetailPanel hook={selectedSuiteHook} />
                  ) : selectedTestHook ? (
                    <HookDetailPanel hook={selectedTestHook} />
                  ) : selectedTest ? (
                    <SelectedTestSummary
                      test={selectedTest}
                      selectedStep={selectedSuiteStep}
                      subAction={selectedSuiteSubAction}
                    />
                  ) : (
                    <EmptyState
                      icon={FileSearch}
                      title={t("live.pane.selectTest")}
                      description={t("live.pane.reasoning.selectTestDescription")}
                    />
                  )
                ) : selectedLegacyHook ? (
                  <HookDetailPanel hook={selectedLegacyHook} />
                ) : selectedLegacyStep ? (
                  <EditorStepDetail step={selectedLegacyStep} subAction={selectedLegacySubAction} />
                ) : showSelectionEmptyState ? (
                  <EmptyState
                    icon={FileSearch}
                    title={t("live.pane.reasoning.selectionGone")}
                    description={t("live.pane.reasoning.selectionGoneDescription")}
                  />
                ) : (
                  <EmptyState
                    icon={FileSearch}
                    title={t("live.pane.reasoning.empty")}
                    description={t("live.pane.reasoning.emptyDescription")}
                  />
                )}
              </ScrollArea>
            </TabsContent>

            <TabsContent value="env" className="m-0 flex-1 overflow-hidden">
              {suiteMode ? (
                selectedSuiteHook ? (
                  <ScrollArea className="h-full">
                    <HookVariables hook={selectedSuiteHook} />
                  </ScrollArea>
                ) : selectedTestHook ? (
                  <ScrollArea className="h-full">
                    <HookVariables hook={selectedTestHook} />
                  </ScrollArea>
                ) : selectedSuiteEditorStep ? (
                  <ScrollArea className="h-full">
                    <TabEnv step={selectedSuiteEditorStep} executionLogs={selectedSuiteExecutionLogs} />
                  </ScrollArea>
                ) : selectedTest ? (
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                    {t("live.pane.env.selectTestHook")}
                  </div>
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                    {t("live.pane.selectTest")}
                  </div>
                )
              ) : selectedLegacyHook ? (
                <ScrollArea className="h-full">
                  <HookVariables hook={selectedLegacyHook} />
                </ScrollArea>
              ) : selectedLegacyEditorStep ? (
                <ScrollArea className="h-full">
                  <TabEnv step={selectedLegacyEditorStep} executionLogs={selectedExecutionLogs} />
                </ScrollArea>
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  {t("live.pane.env.selectStep")}
                </div>
              )}
            </TabsContent>

            <TabsContent value="network" className="m-0 flex-1 overflow-hidden">
              {suiteMode ? (
                selectedSuiteHook || selectedTestHook ? (
                  <div className="flex h-full items-center justify-center px-6 text-sm text-muted-foreground">
                    {t("live.pane.network.hookInTest")}
                  </div>
                ) : selectedSuiteEditorStep ? (
                  <ScrollArea className="h-full">
                    <TabNetwork step={selectedSuiteStep!} allSteps={selectedTestDisplaySteps} platform={platform} />
                  </ScrollArea>
                ) : selectedTest ? (
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                    {t("live.pane.network.runTest")}
                  </div>
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                    {t("live.pane.selectTest")}
                  </div>
                )
              ) : selectedLegacyHook ? (
                <div className="flex h-full items-center justify-center px-6 text-sm text-muted-foreground">
                  {t("live.pane.network.hook")}
                </div>
              ) : selectedLegacyStep ? (
                <ScrollArea className="h-full">
                  <TabNetwork step={selectedLegacyStep} allSteps={displaySteps} platform={platform} />
                </ScrollArea>
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  {t("live.pane.network.selectStep")}
                </div>
              )}
            </TabsContent>

            <TabsContent value="console" className="m-0 flex-1 overflow-hidden">
              {suiteMode ? (
                selectedSuiteHook ? (
                  <ScrollArea className="h-full">
                    <HookDetailPanel hook={selectedSuiteHook} />
                  </ScrollArea>
                ) : selectedTestHook ? (
                  <ScrollArea className="h-full">
                    <HookDetailPanel hook={selectedTestHook} />
                  </ScrollArea>
                ) : selectedSuiteEditorStep ? (
                  <ScrollArea className="h-full">
                    <TabConsole
                      step={selectedSuiteStep!}
                      allSteps={selectedTestDisplaySteps}
                      executionLogs={selectedSuiteExecutionLogs}
                      isHookStep={selectedSuiteExecutionLogs.length > 0}
                    />
                  </ScrollArea>
                ) : selectedTest ? (
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                    {t("live.pane.console.runTest")}
                  </div>
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                    {t("live.pane.selectTest")}
                  </div>
                )
              ) : selectedLegacyHook ? (
                <ScrollArea className="h-full">
                  <HookDetailPanel hook={selectedLegacyHook} />
                </ScrollArea>
              ) : selectedLegacyStep ? (
                <ScrollArea className="h-full">
                  <TabConsole
                    step={selectedLegacyStep}
                    allSteps={displaySteps}
                    executionLogs={selectedExecutionLogs}
                    isHookStep={selectedExecutionLogs.length > 0}
                  />
                </ScrollArea>
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  {t("live.pane.console.selectStep")}
                </div>
              )}
            </TabsContent>

            <TabsContent value="aria" className="m-0 flex-1 overflow-hidden">
              <EditorAriaPanel
                ariaTree={ariaTree}
                onRefresh={onRequestAriaTree}
                isExecuting={effectiveState === "executing"}
              />
            </TabsContent>
          </Tabs>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}
