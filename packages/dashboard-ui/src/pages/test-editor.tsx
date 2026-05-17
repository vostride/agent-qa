import { useState, useEffect, useMemo, useCallback, useRef } from "react"
import { useParams, useNavigate, useSearchParams } from "react-router"
import { routes } from "@/lib/routes"
import { toast } from "sonner"
import { LiveSessionPane, type LiveDevtoolsTab } from "@/components/live-session-pane"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
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
import { EditorSkeleton } from "@/components/page-skeleton"
import { EmptyState } from "@/components/empty-state"
import { MonacoEditor } from "@/components/monaco-editor"
import { VisualBuilder } from "@/components/visual-builder"
import { useVariableSuggestions } from '@/hooks/use-variable-suggestions'
import { TestSettingsPanel } from "@/components/test-settings-panel"
import { TestNavbar } from "@/components/test-navbar"
import { RunResultsPanel } from "@/components/run-results-panel"
import { MemoryObservationsPanel } from "@/components/memory-observations-panel"
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts"
import { useLiveEditor } from "@/hooks/use-live-editor"
import { useIsMobile } from "@/hooks/use-mobile"
import { usePageTitle } from "@/hooks/use-page-title"
import { useRunConfig } from "@/hooks/use-run-config"
import { useTargetDetails, type TargetDetail } from "@/hooks/use-target-details"
import {
  fetchTestFile,
  createTestFile,
  createLiveEditorSession,
  fetchAuthStates,
  fetchConfig,
  saveLiveAuthState,
  updateTestFile,
  validateTestContent,
  triggerRun,
  type AuthStateMetadata,
} from "@/lib/api"
import { buildLiveSessionConfig, readDraftAuthStateName } from "@/lib/live-session-config"
import { logLiveDebug } from "@/lib/live-debug"
import type { Selection } from "@/lib/selection"
import { FileCode, Info } from "lucide-react"
import { getWorkspaceFilenameError } from "@/lib/filename-validation"
import { generateTestId } from "@/lib/generate-test-id"
import { updateYamlField, yamlToFormState } from "@/lib/test-yaml-serializer"

const DEFAULT_TEMPLATE = `name: My Test
test-id: ""
target: ""
context: ""
steps:
  - Navigate to the homepage
  - Verify the page loads
`

function InfoTip({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Info className="h-3 w-3 text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors cursor-help" />
      </TooltipTrigger>
      <TooltipContent className="max-w-[250px] text-[13px]">
        {text}
      </TooltipContent>
    </Tooltip>
  )
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError")
    || (error instanceof Error && error.name === "AbortError")
  )
}

function getLiveTargetLabel(
  target: TargetDetail | undefined,
  platform: "web" | "android" | "ios",
  currentUrl: string | null,
): string {
  if (platform === "web") {
    return currentUrl || target?.url || "Configured start URL"
  }

  const device = target?.device
  const deviceName = typeof device?.deviceName === "string"
    ? device.deviceName
    : typeof device?.name === "string"
      ? device.name
      : null

  return (
    deviceName
    || target?.product
    || target?.bundleId
    || target?.appPackage
    || (platform === "android" ? "Android device" : "iOS device")
  )
}

interface StableDraftStep {
  id: string
  instruction: string
  signature: string
}

function buildDraftStepSignature(step: { text: string; overrides: unknown }): string {
  return JSON.stringify({
    text: step.text,
    overrides: step.overrides ?? null,
  })
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function useStableDraftSteps(steps: Array<{ text: string; overrides: unknown }>): StableDraftStep[] {
  const prevRef = useRef<Array<{ id: string; signature: string }>>([])

  return useMemo(() => {
    const prev = prevRef.current
    const usedIds = new Set<string>()

    const resolved = steps.map((step, index) => {
      const signature = buildDraftStepSignature(step)
      const sameIndex = prev[index]

      if (sameIndex && sameIndex.signature === signature) {
        usedIds.add(sameIndex.id)
        return {
          id: sameIndex.id,
          instruction: step.text,
          signature,
        }
      }

      const exactMatch = prev.find((candidate) =>
        candidate.signature === signature && !usedIds.has(candidate.id),
      )
      if (exactMatch) {
        usedIds.add(exactMatch.id)
        return {
          id: exactMatch.id,
          instruction: step.text,
          signature,
        }
      }

      if (sameIndex && !usedIds.has(sameIndex.id)) {
        usedIds.add(sameIndex.id)
        return {
          id: sameIndex.id,
          instruction: step.text,
          signature,
        }
      }

      return {
        id: crypto.randomUUID(),
        instruction: step.text,
        signature,
      }
    })

    prevRef.current = resolved.map(({ id, signature }) => ({ id, signature }))
    return resolved
  }, [steps])
}

type LiveTerminalReason = "ended" | "disconnected"

export default function TestEditorPage() {
  const { t_id } = useParams<{ t_id: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const isMobile = useIsMobile()
  const { defaultRunMode } = useRunConfig()
  const { targets, globalUse, isLoading: isLoadingTargets } = useTargetDetails()
  const testId = t_id ?? ''
  const { suggestions: variableSuggestions } = useVariableSuggestions(testId || null)
  const isCreateMode = !t_id
  const shouldAutoLaunchLive = searchParams.get("live") === "1"

  const lastValidFormStateRef = useRef<ReturnType<typeof yamlToFormState>>(null)
  const liveLaunchControllerRef = useRef<AbortController | null>(null)
  const liveSessionIdRef = useRef<string | null>(null)
  const terminateLiveSessionRef = useRef<() => void>(() => {})
  const autoLaunchLiveRef = useRef(false)

  const [content, setContent] = useState(isCreateMode ? DEFAULT_TEMPLATE : "")
  const [savedContent, setSavedContent] = useState("")
  const [filename, setFilename] = useState("")
  const [isLoading, setIsLoading] = useState(!isCreateMode)
  const [notFound, setNotFound] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isValidating, setIsValidating] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [runId, setRunId] = useState<string | null>(null)
  const [liveSessionId, setLiveSessionId] = useState<string | null>(null)
  const [liveSessionNumber, setLiveSessionNumber] = useState<number | null>(null)
  const [liveModeOpen, setLiveModeOpen] = useState(false)
  const [isLaunchingLive, setIsLaunchingLive] = useState(false)
  const [liveTerminalReason, setLiveTerminalReason] = useState<LiveTerminalReason | null>(null)
  const [liveDevtoolsTab, setLiveDevtoolsTab] = useState<LiveDevtoolsTab>("reasoning")
  const [liveSelection, setLiveSelection] = useState<Selection | null>(null)
  const [liveHookConfig, setLiveHookConfig] = useState<{ setup: string[]; teardown: string[] }>({ setup: [], teardown: [] })
  const [builderStepSettingsId, setBuilderStepSettingsId] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [testMatchPatterns, setTestMatchPatterns] = useState<string[] | undefined>(undefined)
  const [authStateMetadata, setAuthStateMetadata] = useState<AuthStateMetadata[]>([])
  const [isSavingAuthState, setIsSavingAuthState] = useState(false)

  const [filePath, setFilePath] = useState('')
  const unsaved = !isCreateMode && content !== savedContent
  const filenameError = isCreateMode && filename
    ? getWorkspaceFilenameError(filename.trim(), testMatchPatterns, 'testMatch')
    : null
  const hasInvalidFilename = isCreateMode && !!filename && !!filenameError

  // Load file content
  useEffect(() => {
    if (isCreateMode) return

    let cancelled = false
    setIsLoading(true)

    fetchTestFile(testId)
      .then((data) => {
        if (cancelled) return
        setContent(data.content)
        setSavedContent(data.content)
        setFilePath(data.path)
      })
      .catch(() => {
        if (cancelled) return
        setNotFound(true)
        toast.error("Failed to load test file")
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [testId, isCreateMode])

  useEffect(() => {
    if (!isCreateMode) return
    let cancelled = false
    fetchConfig()
      .then((response) => {
        if (cancelled) return
        const workspace = (response.config as { workspace?: { testMatch?: unknown } }).workspace
        const patterns = workspace?.testMatch
        setTestMatchPatterns(Array.isArray(patterns) ? patterns as string[] : [])
      })
      .catch(() => {
        if (!cancelled) setTestMatchPatterns([])
      })
    return () => { cancelled = true }
  }, [isCreateMode])

  useEffect(() => {
    if (!isCreateMode) return
    const id = generateTestId()
    setContent((prev) => updateYamlField(prev, ['test-id'], id))
  }, [isCreateMode])

  const formState = useMemo(() => yamlToFormState(content), [content])
  if (formState) {
    lastValidFormStateRef.current = formState
  }
  const displayFormState = formState ?? lastValidFormStateRef.current
  const stableLiveSteps = useStableDraftSteps(displayFormState?.steps ?? [])

  const liveSteps = useMemo(
    () => stableLiveSteps.map((step) => ({
      draftId: step.id,
      instruction: step.instruction,
    })),
    [stableLiveSteps],
  )
  const currentLiveDraft = useMemo(() => {
    if (!formState) return null
    return {
      testName: formState.name.trim() || 'Untitled Live Draft',
      testContext: formState.context.trim() || undefined,
    }
  }, [formState])

  const liveEditor = useLiveEditor(liveSessionId, {
    steps: liveSteps,
    setupHooks: liveHookConfig.setup,
    teardownHooks: liveHookConfig.teardown,
    allowReconnect: false,
  })
  const terminateLiveSession = liveEditor.terminateSession
  liveSessionIdRef.current = liveSessionId
  terminateLiveSessionRef.current = terminateLiveSession

  const selectedTargetName = displayFormState?.target?.trim() ?? ""
  const selectedTarget = selectedTargetName ? targets[selectedTargetName] : undefined
  const livePlatform = liveSessionId
    ? liveEditor.platform
    : selectedTarget?.platform ?? "web"
  const liveTargetLabel = useMemo(
    () => getLiveTargetLabel(selectedTarget, livePlatform, liveEditor.currentUrl),
    [selectedTarget, livePlatform, liveEditor.currentUrl],
  )
  const liveDraftState = formState === null
    ? "invalid"
    : (unsaved || isCreateMode ? "unsaved" : "saved")
  const builderStepIds = useMemo(
    () => stableLiveSteps.map((step) => step.id),
    [stableLiveSteps],
  )

  const liveConnectionState = isLaunchingLive ? "connecting" : liveEditor.connectionState
  const hasLiveSession = liveSessionId !== null
  const activeAuthStateTargetName = hasLiveSession && livePlatform === "web" && selectedTargetName
    ? selectedTargetName
    : null
  const draftAuthStateName = useMemo(() => readDraftAuthStateName(content), [content])
  const setupHooksStale = hasLiveSession && formState !== null && !arraysEqual(formState.setup, liveHookConfig.setup)

  const pageTitle = useMemo(() => {
    if (hasLiveSession && liveSessionNumber !== null) {
      const name = displayFormState?.name?.trim() || testId || "Test"
      return `Live #${liveSessionNumber} — ${name}`
    }
    return isCreateMode ? "New Test" : "Edit Test"
  }, [hasLiveSession, liveSessionNumber, displayFormState?.name, testId, isCreateMode])
  usePageTitle(pageTitle)
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
  const canRunAllLiveSteps = hasLiveSession
    && liveConnectionState === "connected"
    && formState !== null
    && formState.steps.some((step) => step.text.trim())
  const runDisabled = isLaunchingLive || hasLiveSession
  const liveConnectDisabled = (
    isLaunchingLive
    || hasLiveSession
    || isRunning
    || runId !== null
    || formState === null
    || !formState?.target.trim()
    || isLoadingTargets
  )

  const handleSave = useCallback(async () => {
    setIsSaving(true)
    try {
      if (isCreateMode) {
        const fnameError = getWorkspaceFilenameError(filename.trim(), testMatchPatterns, 'testMatch')
        if (fnameError) {
          toast.error(fnameError)
          return
        }
        await createTestFile(filename.trim(), content)
        toast.success("Test file created")
        navigate(routes.testView(formState?.testId ?? ''))
      } else {
        await updateTestFile(testId, content)
        setSavedContent(content)
        toast.success("Saved")
      }
    } catch (err) {
      toast.error(
        `Failed to save: ${err instanceof Error ? err.message : String(err)}`
      )
    } finally {
      setIsSaving(false)
    }
  }, [isCreateMode, filename, testMatchPatterns, content, testId, navigate, formState])

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
    setLiveHookConfig({ setup: [], teardown: [] })
    setLiveModeOpen(true)
  }, [liveSessionId, terminateLiveSession])

  const launchLiveSession = useCallback(async (
    nextFormState: NonNullable<typeof formState>,
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
    setIsLaunchingLive(true)

    try {
      if (options?.replaceCurrentSession && liveSessionId) {
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
      const nextSetupHooks = [...nextFormState.setup]
      const nextTeardownHooks = [...nextFormState.teardown]
      const entityTestId = nextFormState.testId?.trim() || null
      const entity: { type: "test"; id: string } | undefined = entityTestId
        ? { type: "test", id: entityTestId }
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
  }, [content, globalUse, liveSessionId, targets, terminateLiveSession])

  const handleConnectLiveSession = useCallback(async () => {
    if (liveConnectDisabled) return
    if (!formState) {
      toast.error("Fix YAML errors before starting live mode")
      return
    }
    await launchLiveSession(formState)
  }, [formState, launchLiveSession, liveConnectDisabled])

  const handleRestartLiveSession = useCallback(async () => {
    if (!hasLiveSession) return
    if (!formState) {
      toast.error("Fix YAML errors before restarting live mode")
      return
    }

    await launchLiveSession(formState, { replaceCurrentSession: true })
  }, [formState, hasLiveSession, launchLiveSession])

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

  const handleValidate = async () => {
    setIsValidating(true)
    try {
      const result = await validateTestContent(content, filePath || filename.trim())
      if (result.valid) {
        toast.success("Valid YAML")
      } else {
        const msgs = result.errors
          .map((e) => (e.line ? `Line ${e.line}: ${e.message}` : e.message))
          .join("\n")
        toast.error(msgs)
      }
    } catch (err) {
      toast.error(
        `Validation error: ${err instanceof Error ? err.message : String(err)}`
      )
    } finally {
      setIsValidating(false)
    }
  }

  const handleRun = useCallback(async (local: boolean) => {
    if (isRunning) return

    // Auto-save first
    try {
      if (isCreateMode) {
        const fnameError = getWorkspaceFilenameError(filename.trim(), testMatchPatterns, 'testMatch')
        if (fnameError) {
          toast.error(fnameError)
          return
        }
        await createTestFile(filename.trim(), content)
        navigate(routes.testView(formState?.testId ?? ''))
        return
      }
      if (unsaved) {
        await updateTestFile(testId, content)
        setSavedContent(content)
      }
    } catch (err) {
      toast.error(
        `Failed to save before run: ${err instanceof Error ? err.message : String(err)}`
      )
      return
    }

    setIsRunning(true)
    try {
      const result = await triggerRun({ file: filePath, local })
      setRunId(result.runId)
      toast.success("Run started")
    } catch (err) {
      toast.error(
        `Failed to start run: ${err instanceof Error ? err.message : String(err)}`
      )
      setIsRunning(false)
    }
  }, [isRunning, isCreateMode, filename, testMatchPatterns, content, unsaved, testId, filePath, navigate, formState])

  const handleRunClose = useCallback(() => {
    setRunId(null)
    setIsRunning(false)
  }, [])

  const handleRunLiveStep = useCallback((index: number) => {
    if (!hasLiveSession) return
    if (!currentLiveDraft) {
      toast.error("Fix YAML errors before running live steps. Live mode uses the current valid draft, not the last valid snapshot.")
      return
    }
    const stepId = liveEditor.steps[index]?.id
    if (stepId) {
      setLiveSelection({ type: "step", stepId })
    }
    setLiveDevtoolsTab("reasoning")
    void liveEditor.executeStepByIndex(index, currentLiveDraft)
  }, [currentLiveDraft, hasLiveSession, liveEditor])

  const handleCancelLiveStep = useCallback((index: number) => {
    if (liveEditor.runningStepIndex !== index) return
    setLiveDevtoolsTab("reasoning")
    liveEditor.cancelStep()
  }, [liveEditor])

  const handleRunLiveHook = useCallback((phase: 'setup' | 'teardown', hookId: string) => {
    if (!hasLiveSession) return
    if (phase === 'setup') {
      toast.error("Setup hooks only run when a live session starts")
      return
    }
    const allHooks = liveEditor.teardownHooks
    const hook = allHooks.find((entry) => entry.id === hookId)
    if (hook) {
      setLiveSelection({ type: "hook", hookId: hook.id })
    }
    setLiveDevtoolsTab("reasoning")
    void liveEditor.executeHookById(phase, hookId)
  }, [hasLiveSession, liveEditor])

  useEffect(() => {
    return () => {
      liveLaunchControllerRef.current?.abort()
      if (liveSessionIdRef.current) {
        terminateLiveSessionRef.current()
      }
    }
  }, [])

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
    setLiveHookConfig({ setup: [], teardown: [] })
    setLiveModeOpen(true)
  }, [liveConnectionState, liveSessionId])

  useEffect(() => {
    if (!shouldAutoLaunchLive || autoLaunchLiveRef.current) return
    if (isCreateMode || isLoading || notFound || isLaunchingLive || liveModeOpen || hasLiveSession) return
    if (!formState || !formState.target.trim()) return

    autoLaunchLiveRef.current = true
    navigate(routes.testEdit(testId), { replace: true })
    void handleConnectLiveSession()
  }, [
    formState,
    handleConnectLiveSession,
    hasLiveSession,
    isCreateMode,
    isLaunchingLive,
    isLoading,
    liveModeOpen,
    navigate,
    notFound,
    shouldAutoLaunchLive,
    testId,
  ])

  useEffect(() => {
    if (builderStepSettingsId && !builderStepIds.includes(builderStepSettingsId)) {
      setBuilderStepSettingsId(null)
    }
  }, [builderStepIds, builderStepSettingsId])

  useEffect(() => {
    if (!liveModeOpen) {
      setLiveSelection(null)
      return
    }
    const allHookRows = [...liveEditor.setupHooks, ...liveEditor.teardownHooks]
    if (liveEditor.steps.length === 0 && allHookRows.length === 0) {
      setLiveSelection(null)
      return
    }
    setLiveSelection((prev) => {
      if (prev?.type === "hook" && allHookRows.some((hook) => hook.id === prev.hookId)) {
        return prev
      }
      if (prev && "stepId" in prev && liveEditor.steps.some((step) => step.id === prev.stepId)) {
        return prev
      }
      if (allHookRows.length > 0) {
        return { type: "hook", hookId: allHookRows[0].id }
      }
      return { type: "step", stepId: liveEditor.steps[0].id }
    })
  }, [liveEditor.setupHooks, liveEditor.steps, liveEditor.teardownHooks, liveModeOpen])

  const shortcuts = useMemo(
    () => ({
      r: () => {
        if (!isCreateMode) handleRun(defaultRunMode === 'local')
      },
      escape: () => {
        if (runId) handleRunClose()
      },
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
        icon={FileCode}
        title="Test not found"
        description="This test file doesn't exist"
        actionLabel="View All Tests"
        onAction={() => navigate(routes.tests)}
      />
    )
  }

  const builderPanel = (
    <VisualBuilder
      content={content}
      onChange={setContent}
      isCreateMode={isCreateMode}
      showLiveStepActions={hasLiveSession}
      canRunLiveStep={liveConnectionState === "connected" && formState !== null}
      canRunLiveHook={liveConnectionState === "connected" && formState !== null}
      liveEditorSteps={liveEditor.steps}
      draftStepIds={builderStepIds}
      liveSetupHooks={liveEditor.setupHooks}
      liveTeardownHooks={liveEditor.teardownHooks}
      onRunLiveStep={handleRunLiveStep}
      onCancelLiveStep={handleCancelLiveStep}
      onRunLiveHook={handleRunLiveHook}
      openStepSettingsId={builderStepSettingsId}
      onOpenStepSettingsChange={setBuilderStepSettingsId}
      selection={liveSelection}
      onSelect={setLiveSelection}
      variableSuggestions={variableSuggestions}
    />
  )

  const monacoPanel = (
    <MonacoEditor
      value={content}
      onChange={setContent}
      onSave={handleSave}
      showErrors
      className="h-full"
    />
  )

  const editorTabs = (
    <Tabs defaultValue="builder" className="flex-1 flex min-h-0 flex-col">
      <TabsList variant="line" className="px-4">
        <TabsTrigger value="builder">Builder</TabsTrigger>
        <TabsTrigger value="yaml">YAML</TabsTrigger>
        {!isCreateMode && <TabsTrigger value="memory">Memory</TabsTrigger>}
      </TabsList>
      <TabsContent value="builder" className="mt-2 flex-1 overflow-auto">
        {builderPanel}
      </TabsContent>
      <TabsContent value="yaml" className="flex-1 min-h-0 mt-2">
        {monacoPanel}
      </TabsContent>
      {!isCreateMode && (
        <TabsContent value="memory" className="mt-2 flex-1 overflow-auto">
          <MemoryObservationsPanel testId={testId} />
        </TabsContent>
      )}
    </Tabs>
  )

  const editorSurface = (
    <div className="flex h-full min-h-0 flex-col">
      {isCreateMode && (
        <div className="px-4 pt-3">
          <div className="rounded-md border bg-muted/15 px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <Label className="flex items-center gap-1 text-xs font-medium">
                File Path <InfoTip text="Path is relative to your workspace root. Must match your workspace's testMatch pattern. Directories are created automatically on save." />
              </Label>
              <span className="text-[11px] text-muted-foreground">
                Created only when you save
              </span>
            </div>
            <Input
              placeholder="my-test.yaml"
              value={filename}
              onChange={(e) => setFilename(e.target.value)}
              className={`mt-2 max-w-md ${hasInvalidFilename ? "border-red-500 focus-visible:ring-red-500" : ""}`}
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
      targetLabel={liveTargetLabel}
      liveSessionNumber={liveSessionNumber}
      platform={livePlatform}
      screenshot={liveEditor.screenshot}
      currentUrl={liveEditor.currentUrl}
      pendingNavigation={liveEditor.pendingNavigation}
      steps={liveEditor.steps}
      setupHooks={liveEditor.setupHooks}
      teardownHooks={liveEditor.teardownHooks}
      selection={liveSelection}
      runningStepId={liveEditor.runningStepId}
      terminalState={liveTerminalState}
      draftState={liveDraftState}
      ariaTree={liveEditor.ariaTree}
      errorMessage={liveEditor.error}
      devtoolsTab={liveDevtoolsTab}
      canRunAll={canRunAllLiveSteps}
      isRunningAll={liveEditor.isRunningAll}
      isStoppingRunAll={liveEditor.isStoppingRunAll}
      setupHooksStale={setupHooksStale}
      onDevtoolsTabChange={setLiveDevtoolsTab}
      onRunAll={() => {
        if (!currentLiveDraft) {
          toast.error("Fix YAML errors before running live steps. Live mode uses the current valid draft, not the last valid snapshot.")
          return
        }
        void liveEditor.runAll(currentLiveDraft)
      }}
      onStopAll={liveEditor.cancelRunAll}
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
    <div className="flex flex-col h-screen">
      <TestNavbar
        testName={isCreateMode ? "New Test" : displayFormState?.name ?? testId}
        testId={displayFormState?.testId ?? ''}
        unsaved={unsaved}
        isCreateMode={isCreateMode}
        mode={isCreateMode ? "view" : "edit"}
        testHref={!isCreateMode ? routes.testView(testId) : undefined}
        isSaving={isSaving}
        isValidating={isValidating}
        isRunning={isRunning}
        runDisabled={runDisabled}
        hasInvalidFilename={hasInvalidFilename}
        showTestId={false}
        hasLiveSession={hasLiveSession}
        liveConnectionState={liveConnectionState}
        isLiveActionDisabled={liveConnectDisabled}
        liveSessionNumber={liveSessionNumber}
        onBack={() => isCreateMode ? navigate(routes.tests) : navigate(routes.testView(testId))}
        onSave={handleSave}
        onValidate={handleValidate}
        onRun={handleRun}
        onLiveConnect={!liveModeOpen ? handleConnectLiveSession : undefined}
        onLiveEnd={hasLiveSession ? handleEndLiveSession : undefined}
        onSettingsOpen={() => setSettingsOpen(true)}
        shortcutsOpen={shortcutsOpen}
        onToggleShortcuts={() => setShortcutsOpen(prev => !prev)}
      />

      {/* Editor area */}
      {runId ? (
        <ResizablePanelGroup
          orientation="horizontal"
          className="flex-1 rounded-md border border-border"
        >
          <ResizablePanel defaultSize={60} minSize={30}>
            <MonacoEditor
              value={content}
              onChange={setContent}
              onSave={handleSave}
              className="h-full"
            />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={40} minSize={25}>
            <RunResultsPanel runId={runId} onClose={handleRunClose} />
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : liveModeOpen && !isMobile ? (
        <ResizablePanelGroup
          orientation="horizontal"
          className="flex-1 rounded-md border border-border"
        >
          <ResizablePanel defaultSize={42} minSize={34}>
            {editorSurface}
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={58} minSize={38}>
            {livePane}
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        editorSurface
      )}

      <Sheet open={settingsOpen} onOpenChange={setSettingsOpen}>
        <SheetContent side="right" className="sm:max-w-[400px] overflow-y-auto p-0">
          <SheetHeader className="px-4 pt-4 pb-2">
            <SheetTitle>Test Settings</SheetTitle>
            <SheetDescription>Advanced configuration for this test</SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-4">
            <TestSettingsPanel content={content} onChange={setContent} selectedTarget={displayFormState?.target} />
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
              <SheetDescription>Live execution workspace for the current draft.</SheetDescription>
            </SheetHeader>
            {livePane}
          </SheetContent>
        </Sheet>
      )}
    </div>
  )
}
