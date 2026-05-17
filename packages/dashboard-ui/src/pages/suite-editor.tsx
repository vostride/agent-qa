import { useState, useEffect, useMemo, useCallback, useRef } from "react"
import { useParams, useNavigate, useSearchParams } from "react-router"
import { routes } from "@/lib/routes"
import { toast } from "sonner"
import { FolderOpen, Info } from "lucide-react"
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { EditorSkeleton } from "@/components/page-skeleton"
import { EmptyState } from "@/components/empty-state"
import { MonacoEditor } from "@/components/monaco-editor"
import { SuiteVisualBuilder } from "@/components/suite-visual-builder"
import { SuiteNavbar } from "@/components/suite-navbar"
import { TestSettingsPanel } from "@/components/test-settings-panel"
import { RunResultsPanel } from "@/components/run-results-panel"
import { LiveSessionPane, type LiveDevtoolsTab } from "@/components/live-session-pane"
import { useLiveEditor, type LiveEditorExternalTest } from "@/hooks/use-live-editor"
import { useIsMobile } from "@/hooks/use-mobile"
import { useTargetDetails } from "@/hooks/use-target-details"
import { buildLiveSessionConfig, readDraftAuthStateName } from "@/lib/live-session-config"
import { logLiveDebug } from "@/lib/live-debug"
import type { Selection } from "@/lib/selection"
import { useVariableSuggestions } from "@/hooks/use-variable-suggestions"
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts"
import { usePageTitle } from "@/hooks/use-page-title"
import { useRunConfig } from "@/hooks/use-run-config"
import {
  fetchSuiteFile,
  createSuiteFile,
  updateSuiteFile,
  validateSuiteContent,
  triggerRun,
  fetchConfig,
  createLiveEditorSession,
  ApiError,
  fetchAuthStates,
  saveLiveAuthState,
  type AuthStateMetadata,
} from "@/lib/api"
import { getSuiteFilenameError } from "@/lib/suite-filename-validation"
import { generateSuiteId } from "@/lib/generate-suite-id"
import { suiteYamlToFormState, updateSuiteField } from "@/lib/suite-yaml-serializer"

const DEFAULT_TEMPLATE = `name: My Suite
target: ""
tests: []
`

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError")
    || (error instanceof Error && error.name === "AbortError")
  )
}

type LiveTerminalReason = "ended" | "disconnected"

function InfoTip({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Info className="h-3 w-3 text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors cursor-help" />
      </TooltipTrigger>
      <TooltipContent className="max-w-[250px] text-[13px]">{text}</TooltipContent>
    </Tooltip>
  )
}

export default function SuiteEditorPage() {
  const params = useParams<{ "suite-id": string }>()
  const routeSuiteId = params["suite-id"] ?? ""
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const isMobile = useIsMobile()
  const { defaultRunMode } = useRunConfig()
  const { targets, globalUse, isLoading: isLoadingTargets } = useTargetDetails()
  const isCreateMode = !routeSuiteId
  const shouldAutoLaunchLive = searchParams.get("live") === "1"

  const liveLaunchControllerRef = useRef<AbortController | null>(null)
  const liveSessionIdRef = useRef<string | null>(null)
  const terminateLiveSessionRef = useRef<() => void>(() => {})
  const autoLaunchLiveRef = useRef(false)
  const lastAutoRunningTestRef = useRef<string | null>(null)
  const lastAutoFailedTestRef = useRef<string | null>(null)

  const [content, setContent] = useState(isCreateMode ? DEFAULT_TEMPLATE : "")
  const [savedContent, setSavedContent] = useState("")
  const [filename, setFilename] = useState("")
  const [isLoading, setIsLoading] = useState(!isCreateMode)
  const [notFound, setNotFound] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isValidating, setIsValidating] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [runId, setRunId] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [suiteMatchPatterns, setSuiteMatchPatterns] = useState<string[]>([])

  const [liveSessionId, setLiveSessionId] = useState<string | null>(null)
  const [liveSessionNumber, setLiveSessionNumber] = useState<number | null>(null)
  const [liveModeOpen, setLiveModeOpen] = useState(false)
  const [isLaunchingLive, setIsLaunchingLive] = useState(false)
  const [liveTerminalReason, setLiveTerminalReason] = useState<LiveTerminalReason | null>(null)
  const [liveDevtoolsTab, setLiveDevtoolsTab] = useState<LiveDevtoolsTab>("reasoning")
  const [liveSelection, setLiveSelection] = useState<Selection | null>(null)
  const [liveHookConfig, setLiveHookConfig] = useState<{ setup: string[]; teardown: string[] }>({ setup: [], teardown: [] })
  const [authStateMetadata, setAuthStateMetadata] = useState<AuthStateMetadata[]>([])
  const [isSavingAuthState, setIsSavingAuthState] = useState(false)

  const [filePath, setFilePath] = useState<string>("")
  const unsaved = !isCreateMode && content !== savedContent
  const filenameError = isCreateMode && filename
    ? getSuiteFilenameError(filename.trim(), suiteMatchPatterns)
    : null
  const hasInvalidFilename = isCreateMode && !!filename && !!filenameError

  const { suggestions: rawSuggestions } = useVariableSuggestions(null)
  const suggestions = useMemo(
    () => rawSuggestions.filter((s) => s.namespace !== 'capture'),
    [rawSuggestions],
  )

  const displayFormState = useMemo(() => suiteYamlToFormState(content), [content])
  const suiteId = displayFormState?.suiteId ?? ''
  const suiteName = displayFormState?.name || (isCreateMode ? 'New Suite' : filePath)

  // Derive the tests feeding into useLiveEditor. Per D-12, the server re-reads
  // each test's YAML fresh from disk on each execute-test message, so the client
  // only needs to identify tests by path + testId. Empty arrays for steps/setup/
  // teardown are intentional — the hook forwards the signature through to the
  // server which authoritatively re-reads.
  const liveTests = useMemo<LiveEditorExternalTest[]>(() => {
    if (!displayFormState) return []
    return displayFormState.tests.map((entry) => ({
      draftId: entry.id,
      testId: entry.id,
      path: entry.test,
      name: entry.test.split('/').pop() ?? entry.test,
      steps: [],
      setup: [],
      teardown: [],
    }))
  }, [displayFormState])

  const liveEditor = useLiveEditor(liveSessionId, {
    tests: liveTests,
    setupHooks: liveHookConfig.setup,
    teardownHooks: liveHookConfig.teardown,
    allowReconnect: false,
  })
  const terminateLiveSession = liveEditor.terminateSession
  liveSessionIdRef.current = liveSessionId
  terminateLiveSessionRef.current = terminateLiveSession

  const selectedTargetName = displayFormState?.target?.trim() ?? ""
  const liveConnectionState = isLaunchingLive ? "connecting" : liveEditor.connectionState
  const hasLiveSession = liveSessionId !== null
  const activeAuthStateTargetName = hasLiveSession && liveEditor.platform === "web" && selectedTargetName
    ? selectedTargetName
    : null
  const draftAuthStateName = useMemo(() => readDraftAuthStateName(content), [content])

  // CRITICAL per D-13: stale check is ONLY over setup + teardown arrays.
  // Test-list edits must flow through silently — no stale banner, no restart prompt.
  const setupHooksStale = hasLiveSession
    && displayFormState !== null
    && (
      !arraysEqual(displayFormState.setup ?? [], liveHookConfig.setup)
      || !arraysEqual(displayFormState.teardown ?? [], liveHookConfig.teardown)
    )

  const canRunAllLiveTests = hasLiveSession
    && liveConnectionState === "connected"
    && displayFormState !== null
    && displayFormState.tests.length > 0

  const runDisabled = isLaunchingLive || hasLiveSession // D-16
  const liveConnectDisabled = (
    isLaunchingLive
    || hasLiveSession
    || isRunning
    || runId !== null
    || isCreateMode                                  // D-19
    || displayFormState === null                     // D-20 YAML invalid
    || !displayFormState?.target.trim()              // D-18 target required
    || isLoadingTargets
  )

  const pageTitle = useMemo(() => {
    if (hasLiveSession && liveSessionNumber !== null) {
      const name = displayFormState?.name?.trim() || suiteName || "Suite"
      return `Live #${liveSessionNumber} — ${name}`
    }
    return isCreateMode ? "New Suite" : "Edit Suite"
  }, [hasLiveSession, liveSessionNumber, displayFormState?.name, suiteName, isCreateMode])
  usePageTitle(pageTitle)

  const liveDraft = useMemo(() => {
    if (!displayFormState) return undefined
    return {
      suiteName: displayFormState.name,
      suiteContext: displayFormState.context || undefined,
    }
  }, [displayFormState])

  const liveTerminalState = useMemo(() => {
    if (liveTerminalReason === "ended") {
      return {
        reason: "ended" as const,
        title: "Live session ended",
        description: "The current draft is unchanged. Close live mode or start a fresh disposable session from this target.",
      }
    }
    if (liveTerminalReason === "disconnected") {
      return {
        reason: "disconnected" as const,
        title: "Live session disconnected",
        description: "The connection dropped and the disposable session was terminated. Start a fresh session to reconnect.",
      }
    }
    return null
  }, [liveTerminalReason])

  // Fetch suite file (edit mode)
  useEffect(() => {
    if (isCreateMode) return
    let cancelled = false
    fetchSuiteFile(routeSuiteId)
      .then((d) => {
        if (cancelled) return
        setContent(d.content)
        setSavedContent(d.content)
        setFilePath(d.path)
        setIsLoading(false)
      })
      .catch(() => {
        if (!cancelled) {
          setNotFound(true)
          setIsLoading(false)
        }
      })
    return () => { cancelled = true }
  }, [routeSuiteId, isCreateMode])

  // Fetch workspace.suiteMatch for filename validation
  useEffect(() => {
    let cancelled = false
    fetchConfig()
      .then((r) => {
        if (cancelled) return
        const workspace = (r.config as { workspace?: { suiteMatch?: unknown } })?.workspace
        const patterns = workspace?.suiteMatch
        if (Array.isArray(patterns)) setSuiteMatchPatterns(patterns as string[])
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  // Create mode: auto-generate suite-id on mount
  useEffect(() => {
    if (!isCreateMode) return
    setContent((c) => updateSuiteField(c, ['suite-id'], generateSuiteId()))
  }, [isCreateMode])

  // Edit mode: backfill suite-id if missing after initial content fetch (D-02)
  useEffect(() => {
    if (isCreateMode || isLoading) return
    const state = suiteYamlToFormState(content)
    if (state && !state.suiteId) {
      setContent((c) => updateSuiteField(c, ['suite-id'], generateSuiteId()))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCreateMode, isLoading, savedContent])

  const handleSave = useCallback(async () => {
    setIsSaving(true)
    try {
      if (isCreateMode) {
        const fnameError = getSuiteFilenameError(filename.trim(), suiteMatchPatterns)
        if (fnameError) { toast.error(fnameError); return }
        await createSuiteFile(filename.trim(), content)
        toast.success('Suite file created')
        const newSuiteId = displayFormState?.suiteId ?? ''
        if (!newSuiteId) {
          toast.error('Created suite is missing suite-id; please reload')
          return
        }
        navigate(routes.suiteEdit(newSuiteId))
      } else {
        await updateSuiteFile(routeSuiteId, content)
        setSavedContent(content)
        toast.success('Saved')
      }
    } catch (err) {
      if (err instanceof ApiError && err.missingTests && err.missingTests.length > 0) {
        toast.error(`Cannot save — referenced tests not found: ${err.missingTests.map((m) => m.test).join(', ')}`)
      } else {
        toast.error(`Failed to save: ${err instanceof Error ? err.message : String(err)}`)
      }
    } finally {
      setIsSaving(false)
    }
  }, [isCreateMode, filename, suiteMatchPatterns, content, routeSuiteId, displayFormState?.suiteId, navigate])

  const handleValidate = useCallback(async () => {
    setIsValidating(true)
    try {
      const result = await validateSuiteContent(content)
      if (result.valid) toast.success('Valid suite')
      else toast.error(result.errors.map((e) => e.message).join('\n'))
    } catch (err) {
      toast.error(`Validation failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setIsValidating(false)
    }
  }, [content])

  const handleRun = useCallback(async (local: boolean) => {
    if (isCreateMode) return
    setIsRunning(true)
    try {
      const r = await triggerRun({ file: filePath, local })
      setRunId(r.runId)
      toast.success("Suite run started")
    } catch (err) {
      toast.error(`Failed to start run: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setIsRunning(false)
    }
  }, [isCreateMode, filePath])

  const handleRunClose = useCallback(() => setRunId(null), [])

  const closeLiveMode = useCallback(() => {
    logLiveDebug("page", "closing live mode", {
      liveSessionId: liveSessionId ?? undefined,
      terminalReason: liveTerminalReason ?? undefined,
    })
    liveLaunchControllerRef.current?.abort()
    liveLaunchControllerRef.current = null
    if (liveSessionId) {
      terminateLiveSession()
    }
    setIsLaunchingLive(false)
    setLiveSessionId(null)
    setLiveSessionNumber(null)
    setLiveTerminalReason(null)
    setLiveSelection(null)
    lastAutoRunningTestRef.current = null
    lastAutoFailedTestRef.current = null
    setLiveHookConfig({ setup: [], teardown: [] })
    setLiveModeOpen(false)
  }, [liveSessionId, liveTerminalReason, terminateLiveSession])

  const handleEndLiveSession = useCallback(() => {
    logLiveDebug("page", "ending live session from UI", {
      liveSessionId: liveSessionId ?? undefined,
    })
    liveLaunchControllerRef.current?.abort()
    liveLaunchControllerRef.current = null
    if (liveSessionId) {
      terminateLiveSession()
    }
    setIsLaunchingLive(false)
    setLiveSessionId(null)
    setLiveSessionNumber(null)
    setLiveTerminalReason("ended")
    setLiveSelection(null)
    lastAutoRunningTestRef.current = null
    lastAutoFailedTestRef.current = null
    setLiveHookConfig({ setup: [], teardown: [] })
    setLiveModeOpen(false)
  }, [liveSessionId, terminateLiveSession])

  const launchLiveSession = useCallback(async (
    nextFormState: NonNullable<typeof displayFormState>,
    options?: { replaceCurrentSession?: boolean },
  ) => {
    const targetName = nextFormState.target.trim()
    if (!targetName) {
      toast.error("Select a target before starting live mode")
      return
    }

    const controller = new AbortController()
    liveLaunchControllerRef.current?.abort()
    liveLaunchControllerRef.current = controller
    setLiveModeOpen(true)
    setLiveTerminalReason(null)
    setLiveDevtoolsTab("reasoning")
    setLiveSelection(null)
    lastAutoRunningTestRef.current = null
    lastAutoFailedTestRef.current = null
    setIsLaunchingLive(true)

    try {
      if (options?.replaceCurrentSession && liveSessionIdRef.current) {
        terminateLiveSession()
        setLiveSessionId(null)
        setLiveSessionNumber(null)
      }

      const sessionConfig = buildLiveSessionConfig({
        content,
        targetName,
        targets,
        globalUse,
      })
      logLiveDebug("page", "requesting live session", {
        targetName,
        platform: sessionConfig.platform,
        headless: sessionConfig.headless ?? undefined,
        replacingSession: options?.replaceCurrentSession ?? false,
      })
      const nextSetupHooks = [...(nextFormState.setup ?? [])]
      const nextTeardownHooks = [...(nextFormState.teardown ?? [])]
      const entity: { type: "suite"; id: string } | undefined = nextFormState.suiteId
        ? { type: "suite", id: nextFormState.suiteId }
        : undefined
      const { sessionId, sessionNumber } = await createLiveEditorSession({
        ...sessionConfig,
        setupHooks: nextSetupHooks,
        teardownHooks: nextTeardownHooks,
        entity,
      }, controller.signal)
      if (controller.signal.aborted) return
      setLiveHookConfig({
        setup: nextSetupHooks,
        teardown: nextTeardownHooks,
      })
      setLiveSessionId(sessionId)
      setLiveSessionNumber(sessionNumber)
      logLiveDebug("page", "live session created", {
        sessionId,
        targetName,
      })
    } catch (err) {
      if (!isAbortError(err)) {
        logLiveDebug("page", "failed to create live session", {
          error: err instanceof Error ? err.message : String(err),
          targetName,
        })
        toast.error(
          err instanceof Error
            ? err.message
            : "Failed to start live session",
        )
      }
      if (!options?.replaceCurrentSession) {
        setLiveModeOpen(false)
      }
    } finally {
      if (liveLaunchControllerRef.current === controller) {
        liveLaunchControllerRef.current = null
      }
      setIsLaunchingLive(false)
    }
  }, [content, globalUse, targets, terminateLiveSession])

  const handleConnectLiveSession = useCallback(async () => {
    if (liveConnectDisabled) return
    if (!displayFormState) {
      toast.error("Fix YAML errors before starting live mode")
      return
    }
    await launchLiveSession(displayFormState)
  }, [displayFormState, launchLiveSession, liveConnectDisabled])

  const handleRestartLiveSession = useCallback(async () => {
    if (!hasLiveSession) return
    if (!displayFormState) {
      toast.error("Fix YAML errors before restarting live mode")
      return
    }
    await launchLiveSession(displayFormState, { replaceCurrentSession: true })
  }, [displayFormState, hasLiveSession, launchLiveSession])

  const refreshAuthStates = useCallback(async () => {
    if (!activeAuthStateTargetName) {
      setAuthStateMetadata([])
      return
    }
    try {
      const response = await fetchAuthStates({ target: activeAuthStateTargetName })
      setAuthStateMetadata(response.authStates)
    } catch {
      setAuthStateMetadata([])
    }
  }, [activeAuthStateTargetName])

  useEffect(() => {
    void refreshAuthStates()
  }, [refreshAuthStates])

  const handleSaveLiveAuthState = useCallback(async (input: { name: string; replace: boolean }) => {
    if (!liveSessionId || !activeAuthStateTargetName) {
      throw new Error(`Could not save auth state "${input.name}" for target "${activeAuthStateTargetName ?? "selected target"}".`)
    }

    const failureMessage = `Could not save auth state "${input.name}" for target "${activeAuthStateTargetName}".`
    setIsSavingAuthState(true)
    try {
      await saveLiveAuthState(liveSessionId, { name: input.name, replace: input.replace })
      toast.success(`Saved auth state "${input.name}" for target "${activeAuthStateTargetName}".`)
      await refreshAuthStates()
    } catch {
      throw new Error(failureMessage)
    } finally {
      setIsSavingAuthState(false)
    }
  }, [activeAuthStateTargetName, liveSessionId, refreshAuthStates])

  const handleLiveModeOpenChange = useCallback((open: boolean) => {
    if (open) {
      setLiveModeOpen(true)
      return
    }
    closeLiveMode()
  }, [closeLiveMode])

  // D-23: suite allows manual setup re-run during an active session (divergence
  // from test-editor). Stale banner clears only on explicit Restart.
  const handleRunLiveHook = useCallback((phase: 'setup' | 'teardown', hookId: string) => {
    if (!hasLiveSession) {
      toast.error('Start a live session first.')
      return
    }
    const allHooks = phase === 'setup' ? liveEditor.setupHooks : liveEditor.teardownHooks
    const hook = allHooks.find((entry) => entry.id === hookId)
    if (hook) {
      setLiveSelection({ type: "suite-hook", phase, hookId: hook.id })
    }
    setLiveDevtoolsTab("reasoning")
    void liveEditor.executeHookById(phase, hookId)
  }, [hasLiveSession, liveEditor])

  const handleRunLiveTest = useCallback((index: number) => {
    setLiveSelection({ type: "test", testIndex: index })
    setLiveDevtoolsTab("reasoning")
    void liveEditor.executeTestByIndex(index, liveDraft)
  }, [liveDraft, liveEditor])

  // Cleanup on unmount — dispose session when tab closes
  useEffect(() => {
    return () => {
      liveLaunchControllerRef.current?.abort()
      if (liveSessionIdRef.current) {
        terminateLiveSessionRef.current()
      }
    }
  }, [])

  // Terminal transition: reflect server-driven disconnect
  useEffect(() => {
    if (!liveSessionId) return
    if (liveConnectionState !== "disconnected") return
    logLiveDebug("page", "live session moved to terminal state", {
      liveSessionId,
      liveConnectionState,
    })
    setLiveSessionId(null)
    setLiveSessionNumber(null)
    setIsLaunchingLive(false)
    setLiveTerminalReason("disconnected")
    setLiveSelection(null)
    lastAutoRunningTestRef.current = null
    lastAutoFailedTestRef.current = null
    setLiveHookConfig({ setup: [], teardown: [] })
    setLiveModeOpen(true)
  }, [liveConnectionState, liveSessionId])

  useEffect(() => {
    if (!liveModeOpen) return
    if (liveEditor.runningTestIndex === null) return
    const runningTest = liveEditor.tests[liveEditor.runningTestIndex]
    const autoKey = `${runningTest?.testExecutionId ?? "pending"}:${liveEditor.runningTestIndex}`
    if (lastAutoRunningTestRef.current === autoKey) return
    lastAutoRunningTestRef.current = autoKey
    setLiveSelection({ type: "test", testIndex: liveEditor.runningTestIndex })
    setLiveDevtoolsTab("reasoning")
  }, [liveEditor.runningTestIndex, liveEditor.tests, liveModeOpen])

  useEffect(() => {
    if (!liveModeOpen) return
    if (liveEditor.runningTestIndex !== null) return
    const failedCandidates = liveEditor.tests
      .map((test, index) => ({ index, test }))
      .filter(({ test }) => test.status === "failed")
      .sort((left, right) => (right.test.lastRunAt ?? "").localeCompare(left.test.lastRunAt ?? ""))
    const latestFailed = failedCandidates[0]
    if (!latestFailed) return
    const autoKey = latestFailed.test.testExecutionId ?? latestFailed.test.lastRunAt ?? `failed:${latestFailed.index}`
    if (lastAutoFailedTestRef.current === autoKey) return
    lastAutoFailedTestRef.current = autoKey
    setLiveSelection({ type: "test", testIndex: latestFailed.index })
    setLiveDevtoolsTab("reasoning")
  }, [liveEditor.runningTestIndex, liveEditor.tests, liveModeOpen])

  // Auto-launch from ?live=1 (D-17)
  useEffect(() => {
    if (!shouldAutoLaunchLive || autoLaunchLiveRef.current) return
    if (isCreateMode || isLoading || notFound || isLaunchingLive || liveModeOpen || hasLiveSession) return
    if (!displayFormState || !displayFormState.target.trim()) return

    autoLaunchLiveRef.current = true
    navigate(routes.suiteEdit(routeSuiteId), { replace: true })
    void handleConnectLiveSession()
  }, [
    displayFormState,
    handleConnectLiveSession,
    hasLiveSession,
    isCreateMode,
    isLaunchingLive,
    isLoading,
    liveModeOpen,
    navigate,
    notFound,
    routeSuiteId,
    shouldAutoLaunchLive,
  ])

  // Keyboard shortcuts
  const shortcuts = useMemo(
    () => ({
      r: () => { if (!isCreateMode) handleRun(defaultRunMode === 'local') },
      escape: () => { if (runId) handleRunClose() },
    }),
    [isCreateMode, runId, handleRun, handleRunClose, defaultRunMode],
  )
  useKeyboardShortcuts(shortcuts)

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        handleSave()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleSave])

  if (isLoading) return <EditorSkeleton />
  if (notFound) {
    return (
      <EmptyState
        icon={FolderOpen}
        title="Suite not found"
        description="This suite doesn't exist"
        actionLabel="View All Suites"
        onAction={() => navigate(routes.suites)}
      />
    )
  }

  const editorTabs = (
    <Tabs defaultValue="builder" className="flex-1 flex min-h-0 flex-col">
      <TabsList variant="line" className="px-4">
        <TabsTrigger value="builder">Builder</TabsTrigger>
        <TabsTrigger value="yaml">YAML</TabsTrigger>
      </TabsList>
      <TabsContent value="builder" className="mt-2 flex-1 overflow-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb:hover]:bg-muted-foreground/50 [&::-webkit-scrollbar-track]:bg-transparent [scrollbar-width:thin]">
        <SuiteVisualBuilder
          content={content}
          onChange={setContent}
          suggestions={suggestions}
          isCreateMode={isCreateMode}
          liveMode={liveModeOpen}
          liveTests={liveEditor.tests}
          liveSetupHooks={liveEditor.setupHooks}
          liveTeardownHooks={liveEditor.teardownHooks}
          runningTestIndex={liveEditor.runningTestIndex}
          canRunTest={hasLiveSession && liveEditor.connectionState === 'connected'}
          canRunAll={canRunAllLiveTests}
          isRunningAll={liveEditor.isRunningAllTests}
          isStoppingRunAll={liveEditor.isStoppingRunAllTests}
          onRunTest={handleRunLiveTest}
          onCancelTest={(i) => {
            if (liveEditor.runningTestIndex === i) {
              liveEditor.cancelStep()
            }
          }}
          onRunAll={() => void liveEditor.runAllTests(liveDraft)}
          onStopAll={liveEditor.cancelRunAllTests}
          setupHooksStale={setupHooksStale}
          onRestartSession={setupHooksStale ? () => void handleRestartLiveSession() : undefined}
          selection={liveSelection}
          onSelect={setLiveSelection}
          onRunLiveHook={handleRunLiveHook}
        />
      </TabsContent>
      <TabsContent value="yaml" className="flex-1 min-h-0 mt-2">
        <MonacoEditor
          value={content}
          onChange={setContent}
          onSave={handleSave}
          className="h-full"
          filePath={filePath || undefined}
        />
      </TabsContent>
    </Tabs>
  )

  const editorSurface = (
    <div className="flex h-full min-h-0 flex-col">
      {isCreateMode && (
        <div className="px-4 pt-3">
          <div className="rounded-md border bg-muted/15 px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <Label className="flex items-center gap-1 text-xs font-medium">
                File Path <InfoTip text="Path is relative to your workspace root. Must match your workspace's suiteMatch pattern. Directories are created automatically on save." />
              </Label>
              <span className="text-[11px] text-muted-foreground">Created only when you save</span>
            </div>
            <Input
              placeholder="my-suite.suite.yaml"
              value={filename}
              onChange={(e) => setFilename(e.target.value)}
              className={`mt-2 max-w-md h-8 text-sm font-mono ${hasInvalidFilename ? 'border-red-500 focus-visible:ring-red-500' : ''}`}
            />
            {hasInvalidFilename && (
              <p className="mt-1 text-xs text-red-500">{filenameError}</p>
            )}
          </div>
        </div>
      )}
      {editorTabs}
    </div>
  )

  const livePane = (
    <LiveSessionPane
      connectionState={liveEditor.connectionState}
      isLaunching={isLaunchingLive}
      targetName={selectedTargetName || "Selected Target"}
      targetLabel={liveEditor.currentUrl || "Configured start URL"}
      liveSessionNumber={liveSessionNumber}
      platform={liveEditor.platform}
      screenshot={liveEditor.screenshot}
      currentUrl={liveEditor.currentUrl}
      pendingNavigation={liveEditor.pendingNavigation}
      steps={liveEditor.steps}
      setupHooks={liveEditor.setupHooks}
      teardownHooks={liveEditor.teardownHooks}
      tests={liveEditor.tests}
      selection={liveSelection}
      runningStepId={liveEditor.runningStepId}
      terminalState={liveTerminalState}
      draftState={displayFormState === null ? "invalid" : (unsaved || isCreateMode ? "unsaved" : "saved")}
      ariaTree={liveEditor.ariaTree}
      errorMessage={liveEditor.error}
      devtoolsTab={liveDevtoolsTab}
      canRunAll={canRunAllLiveTests}
      isRunningAll={liveEditor.isRunningAllTests}
      isStoppingRunAll={liveEditor.isStoppingRunAllTests}
      setupHooksStale={setupHooksStale}
      executionUnit="test"
      runAllLabel="Run All Tests"
      stopAllLabel="Stop Run All"
      unitRowsSlot={null}
      onDevtoolsTabChange={setLiveDevtoolsTab}
      onRunAll={() => void liveEditor.runAllTests(liveDraft)}
      onStopAll={liveEditor.cancelRunAllTests}
      onEndSession={handleEndLiveSession}
      onRestartSession={setupHooksStale ? () => void handleRestartLiveSession() : undefined}
      showEndSessionAction={isMobile}
      onCloseLiveMode={closeLiveMode}
      onStartFreshSession={() => void handleConnectLiveSession()}
      onBack={liveEditor.goBack}
      onForward={liveEditor.goForward}
      onRefresh={liveEditor.refreshPage}
      onNavigate={liveEditor.navigate}
      onRequestAriaTree={liveEditor.requestAriaTree}
      authStateCapture={activeAuthStateTargetName && liveSessionId ? {
        sessionId: liveSessionId,
        targetName: activeAuthStateTargetName,
        initialName: draftAuthStateName,
        authStates: authStateMetadata,
        isSaving: isSavingAuthState,
        onSave: handleSaveLiveAuthState,
      } : null}
    />
  )

  return (
    <div className="flex h-screen flex-col">
      <SuiteNavbar
        suiteName={suiteName}
        suiteId={suiteId}
        unsaved={unsaved}
        isCreateMode={isCreateMode}
        mode="edit"
        suiteHref={isCreateMode ? undefined : routes.suiteView(routeSuiteId)}
        isSaving={isSaving}
        isValidating={isValidating}
        isRunning={isRunning}
        runDisabled={runDisabled}
        hasInvalidFilename={hasInvalidFilename}
        shortcutsOpen={shortcutsOpen}
        hasLiveSession={hasLiveSession}
        liveConnectionState={liveConnectionState}
        isLiveActionDisabled={liveConnectDisabled}
        liveSessionNumber={liveSessionNumber}
        onBack={() => navigate(routes.suites)}
        onSave={handleSave}
        onValidate={handleValidate}
        onRun={handleRun}
        onLiveConnect={!liveModeOpen ? handleConnectLiveSession : undefined}
        onLiveEnd={hasLiveSession ? handleEndLiveSession : undefined}
        onSettingsOpen={() => setSettingsOpen(true)}
        onToggleShortcuts={() => setShortcutsOpen((v) => !v)}
      />

      {runId ? (
        <ResizablePanelGroup orientation="horizontal" className="flex-1 rounded-md border border-border">
          <ResizablePanel defaultSize={60} minSize={30}>
            <MonacoEditor value={content} onChange={setContent} onSave={handleSave} className="h-full" />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={40} minSize={25}>
            <RunResultsPanel runId={runId} onClose={handleRunClose} />
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : liveModeOpen && !isMobile ? (
        <ResizablePanelGroup orientation="horizontal" className="flex-1 rounded-md border border-border">
          <ResizablePanel defaultSize={45} minSize={30}>
            {editorSurface}
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={55} minSize={40}>
            {livePane}
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        editorSurface
      )}

      <Sheet open={settingsOpen} onOpenChange={setSettingsOpen}>
        <SheetContent side="right" className="sm:max-w-[400px] overflow-y-auto p-0">
          <SheetHeader className="px-4 pt-4 pb-2">
            <SheetTitle>Suite Settings</SheetTitle>
            <SheetDescription>Advanced configuration for this suite</SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-4">
            <TestSettingsPanel
              content={content}
              onChange={setContent}
              selectedTarget={displayFormState?.target}
              showMeta={false}
            />
          </div>
        </SheetContent>
      </Sheet>

      {isMobile && (
        <Sheet open={liveModeOpen} onOpenChange={handleLiveModeOpenChange}>
          <SheetContent
            side="bottom"
            showCloseButton={false}
            className="h-[100dvh] max-h-[100dvh] rounded-none p-0"
          >
            <SheetHeader className="sr-only">
              <SheetTitle>Live Session</SheetTitle>
              <SheetDescription>Live execution workspace for the current suite draft.</SheetDescription>
            </SheetHeader>
            {livePane}
          </SheetContent>
        </Sheet>
      )}
    </div>
  )
}
