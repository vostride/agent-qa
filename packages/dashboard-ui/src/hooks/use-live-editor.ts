import { useState, useEffect, useRef, useCallback } from 'react'
import type { LiveExecutionLogEntry, SubActionData } from '@/lib/api'
import type { LivePhase } from '@/hooks/use-execution-events'
import { logLiveDebug } from '@/lib/live-debug'

export interface StepExecution {
  phases: LivePhase[]
  status: 'passed' | 'failed' | 'cancelled'
  duration?: number
  error?: string
  timestamp: string
}

export interface EditorStep {
  id: string
  draftId: string | null
  instruction: string
  status: 'idle' | 'running' | 'cancelling' | 'passed' | 'failed' | 'cancelled'
  duration?: number
  error?: string
  phases: LivePhase[]
  executionHistory: StepExecution[]
  capturedVariables?: Record<string, string>
  consoleLogs: Array<{
    level: string
    text: string
    location?: { url: string; lineNumber: number; columnNumber: number }
    timestamp: number
  }>
  networkLogs: Array<{
    url: string
    method: string
    status: number
    requestHeaders: Record<string, string>
    responseHeaders: Record<string, string>
    body?: string
    requestBody?: string
    startTime: number
    endTime: number
    timing?: Record<string, number>
  }>
  variableSnapshot: Record<string, { value: string; source: string }> | null
  originalStepName: string | null
  subActionsData: SubActionData[] | null
  executionLogs: LiveExecutionLogEntry[]
  executionGeneration: number
}

export interface LiveEditorExternalStep {
  draftId?: string
  instruction: string
}

export interface LiveEditorExternalTest {
  draftId?: string
  testId: string
  path: string
  name: string
  context?: string
  steps: string[]
  setup: string[]
  teardown: string[]
}

export interface TestStepDetail extends EditorStep {
  stepIndex: number
}

export interface EditorTest {
  id: string
  draftId: string | null
  testId: string
  path: string
  name: string
  status: 'idle' | 'running' | 'cancelling' | 'passed' | 'failed' | 'cancelled'
  duration?: number
  error?: string
  testExecutionId: string | null
  liveSteps: TestStepDetail[]
  runningStepIndex: number | null
  perTestSetupHooks: LiveHookExecution[]
  perTestTeardownHooks: LiveHookExecution[]
  lastRunAt?: string
}

export interface LiveSuiteDraft {
  suiteName: string
  suiteContext?: string
}

export interface LiveDraftMetadata {
  testName: string
  testContext?: string
}

export interface LiveHookExecution {
  id: string
  executionId?: string | null
  name: string
  phase: 'setup' | 'teardown'
  status: 'pending' | 'running' | 'passed' | 'failed'
  duration?: number
  stdout: string | null
  stderr: string | null
  variables: Record<string, string> | null
  error?: string
  createdAt?: string
}

interface LiveSuiteHookOwner {
  scope: 'suite'
}

interface LiveTestOwner {
  scope: 'test'
  testExecutionId: string
  testIndex: number
  testId: string
  testName: string
}

type LiveHookOwner = LiveSuiteHookOwner | LiveTestOwner

interface LiveTestExecutionMeta {
  testExecutionId: string
  testIndex: number
  testId: string
  testName: string
}

interface LiveTestStepMeta extends LiveTestExecutionMeta {
  stepIndex: number
  stepInstruction: string
}

export interface PendingNavigationState {
  action: 'navigate' | 'back' | 'forward' | 'refresh'
  targetUrl?: string
}

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'executing' | 'disconnected' | 'error'

export interface UseLiveEditorReturn {
  connectionState: ConnectionState
  steps: EditorStep[]
  setupHooks: LiveHookExecution[]
  teardownHooks: LiveHookExecution[]
  screenshot: string | null
  currentUrl: string | null
  pendingNavigation: PendingNavigationState | null
  error: string | null
  executeStep: (instruction: string) => void
  executeStepByIndex: (index: number, draft?: LiveDraftMetadata) => Promise<void>
  executeHookById: (phase: 'setup' | 'teardown', hookId: string) => Promise<void>
  cancelStep: () => void
  requestScreenshot: () => void
  refreshPage: () => void
  goBack: () => void
  goForward: () => void
  navigate: (url: string) => void
  runAll: (draft?: LiveDraftMetadata) => Promise<void>
  cancelRunAll: () => void
  terminateSession: () => void
  addStep: () => void
  removeStep: (index: number) => void
  updateStepInstruction: (index: number, instruction: string) => void
  reorderSteps: (oldIndex: number, newIndex: number) => void
  runningStepIndex: number | null
  runningStepId: string | null
  sessionId: string | null
  isTerminated: boolean
  deviceLogs: Array<{ level: string; message: string; timestamp: number }>
  platform: 'web' | 'android' | 'ios'
  ariaTree: string | null
  requestAriaTree: () => void
  isRunningAll: boolean
  isStoppingRunAll: boolean
  tests: EditorTest[]
  executeTestByIndex: (index: number, draft?: LiveSuiteDraft) => Promise<void>
  runAllTests: (draft?: LiveSuiteDraft) => Promise<void>
  cancelRunAllTests: () => void
  runningTestIndex: number | null
  isRunningAllTests: boolean
  isStoppingRunAllTests: boolean
}

export interface UseLiveEditorOptions {
  steps?: LiveEditorExternalStep[]
  tests?: LiveEditorExternalTest[]
  setupHooks?: string[]
  teardownHooks?: string[]
  allowReconnect?: boolean
}

function createEditorStep(
  stepInput: { draftId?: string | null; instruction: string } | string,
  prev?: EditorStep,
): EditorStep {
  const step = typeof stepInput === 'string'
    ? { instruction: stepInput }
    : stepInput

  return {
    id: prev?.id ?? step.draftId ?? crypto.randomUUID(),
    draftId: step.draftId ?? prev?.draftId ?? null,
    instruction: step.instruction,
    status: prev?.status ?? 'idle',
    duration: prev?.duration,
    error: prev?.error,
    phases: prev?.phases ?? [],
    executionHistory: prev?.executionHistory ?? [],
    capturedVariables: prev?.capturedVariables,
    consoleLogs: prev?.consoleLogs ?? [],
    networkLogs: prev?.networkLogs ?? [],
    variableSnapshot: prev?.variableSnapshot ?? null,
    originalStepName: prev?.originalStepName ?? null,
    subActionsData: prev?.subActionsData ?? null,
    executionLogs: prev?.executionLogs ?? [],
    executionGeneration: prev?.executionGeneration ?? 0,
  }
}

function createHookExecution(
  hookInput: { hookId: string; phase: 'setup' | 'teardown'; name?: string },
  prev?: LiveHookExecution,
): LiveHookExecution {
  return {
    id: hookInput.hookId,
    executionId: prev?.executionId ?? null,
    name: hookInput.name ?? prev?.name ?? hookInput.hookId,
    phase: hookInput.phase,
    status: prev?.status ?? 'pending',
    duration: prev?.duration,
    stdout: prev?.stdout ?? null,
    stderr: prev?.stderr ?? null,
    variables: prev?.variables ?? null,
    error: prev?.error,
    createdAt: prev?.createdAt,
  }
}

function createTestStepDetail(
  stepInput: { stepIndex: number; instruction: string },
  prev?: TestStepDetail,
): TestStepDetail {
  return {
    ...createEditorStep({ draftId: prev?.draftId, instruction: stepInput.instruction }, prev),
    id: prev?.id ?? crypto.randomUUID(),
    stepIndex: stepInput.stepIndex,
  }
}

function upsertHookExecution(
  hooks: LiveHookExecution[],
  hook: LiveHookExecution,
): LiveHookExecution[] {
  const existingIndex = hooks.findIndex((entry) => entry.id === hook.id)
  if (existingIndex === -1) {
    return [...hooks, hook]
  }

  return hooks.map((entry, index) => index === existingIndex ? { ...entry, ...hook } : entry)
}

function upsertTestStep(
  steps: TestStepDetail[],
  stepInput: { stepIndex: number; instruction: string },
  updates: Partial<TestStepDetail>,
): TestStepDetail[] {
  const existing = steps.find((step) => step.stepIndex === stepInput.stepIndex)
  const nextStep = {
    ...createTestStepDetail(stepInput, existing),
    ...updates,
  }

  const nextSteps = existing
    ? steps.map((step) => step.stepIndex === stepInput.stepIndex ? nextStep : step)
    : [...steps, nextStep]

  return [...nextSteps].sort((left, right) => left.stepIndex - right.stepIndex)
}

export function syncExternalSteps(
  prevSteps: EditorStep[],
  nextSteps: LiveEditorExternalStep[],
): EditorStep[] {
  const normalized = nextSteps.map((step) => ({
    draftId: step.draftId,
    instruction: step.instruction,
  }))
  const unchanged =
    prevSteps.length === normalized.length
    && prevSteps.every((step, index) =>
      step.instruction === normalized[index].instruction
      && step.draftId === normalized[index].draftId,
    )

  if (unchanged) return prevSteps

  const prevByDraftId = new Map(
    prevSteps
      .filter((step): step is EditorStep & { draftId: string } => Boolean(step.draftId))
      .map((step) => [step.draftId, step]),
  )

  return normalized.map((step, index) => {
    const matchedPrev = step.draftId
      ? prevByDraftId.get(step.draftId)
      : prevSteps[index]

    return createEditorStep(step, matchedPrev)
  })
}

export function syncExternalHooks(
  prevHooks: LiveHookExecution[],
  nextHooks: string[],
  phase: 'setup' | 'teardown',
): LiveHookExecution[] {
  const unchanged =
    prevHooks.length === nextHooks.length
    && prevHooks.every((hook, index) => hook.id === nextHooks[index] && hook.phase === phase)

  if (unchanged) return prevHooks

  const prevById = new Map(prevHooks.map((hook) => [hook.id, hook]))
  return nextHooks.map((hookId) => createHookExecution({ hookId, phase }, prevById.get(hookId)))
}

function createEditorTest(
  test: LiveEditorExternalTest,
  index: number,
  prev?: EditorTest,
): EditorTest {
  return {
    id: prev?.id ?? `${test.testId}:${test.path}:${index}`,
    draftId: test.draftId ?? prev?.draftId ?? null,
    testId: test.testId,
    path: test.path,
    name: test.name,
    status: prev?.status ?? 'idle',
    duration: prev?.duration,
    error: prev?.error,
    testExecutionId: prev?.testExecutionId ?? null,
    liveSteps: prev?.liveSteps ?? [],
    runningStepIndex: prev?.runningStepIndex ?? null,
    perTestSetupHooks: prev?.perTestSetupHooks ?? [],
    perTestTeardownHooks: prev?.perTestTeardownHooks ?? [],
    lastRunAt: prev?.lastRunAt,
  }
}

function findTestIndexByMeta(
  tests: EditorTest[],
  meta: LiveTestExecutionMeta,
): number {
  const byExecution = tests.findIndex((test) => test.testExecutionId === meta.testExecutionId)
  if (byExecution !== -1) return byExecution

  const byIdAndName = tests.findIndex((test) => test.testId === meta.testId && test.name === meta.testName)
  if (byIdAndName !== -1) return byIdAndName

  return meta.testIndex >= 0 && meta.testIndex < tests.length
    ? meta.testIndex
    : -1
}

function updateTestByMeta(
  tests: EditorTest[],
  meta: LiveTestExecutionMeta,
  updater: (test: EditorTest) => EditorTest,
): EditorTest[] {
  const matchIndex = findTestIndexByMeta(tests, meta)
  if (matchIndex === -1) return tests
  return tests.map((test, index) => index === matchIndex ? updater(test) : test)
}

function isLiveTestOwner(owner: LiveHookOwner): owner is LiveTestOwner {
  return owner.scope === 'test'
}

export function useLiveEditor(
  sessionId: string | null,
  options: UseLiveEditorOptions = {},
): UseLiveEditorReturn {
  const externalSteps = options.steps
  const externalTests = options.tests
  const externalSetupHooks = options.setupHooks ?? []
  const externalTeardownHooks = options.teardownHooks ?? []
  const allowReconnect = options.allowReconnect ?? (externalSteps ? false : true)
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle')
  const [steps, setSteps] = useState<EditorStep[]>([])
  const [setupHooks, setSetupHooks] = useState<LiveHookExecution[]>(() => syncExternalHooks([], externalSetupHooks, 'setup'))
  const [teardownHooks, setTeardownHooks] = useState<LiveHookExecution[]>(() => syncExternalHooks([], externalTeardownHooks, 'teardown'))
  const [screenshot, setScreenshot] = useState<string | null>(null)
  const [currentUrl, setCurrentUrl] = useState<string | null>(null)
  const [pendingNavigation, setPendingNavigation] = useState<PendingNavigationState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [runningStepIndex, setRunningStepIndex] = useState<number | null>(null)
  const [deviceLogs, setDeviceLogs] = useState<Array<{ level: string; message: string; timestamp: number }>>([])
  const [platform, setPlatform] = useState<'web' | 'android' | 'ios'>('web')
  const [ariaTree, setAriaTree] = useState<string | null>(null)
  const [isRunningAll, setIsRunningAll] = useState(false)
  const [isStoppingRunAll, setIsStoppingRunAll] = useState(false)
  const [tests, setTests] = useState<EditorTest[]>([])
  const [runningTestIndex, setRunningTestIndex] = useState<number | null>(null)
  const [isRunningAllTests, setIsRunningAllTests] = useState(false)
  const [isStoppingRunAllTests, setIsStoppingRunAllTests] = useState(false)

  const wsRef = useRef<WebSocket | null>(null)
  const reconnectCountRef = useRef(0)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const connectionStateRef = useRef<ConnectionState>('idle')
  const stepsRef = useRef<EditorStep[]>([])
  const runningStepIndexRef = useRef<number | null>(null)
  const terminatedRef = useRef(false)
  const stepCompleteResolverRef = useRef<((result: { status: string }) => void) | null>(null)
  const cancelResolverRef = useRef<(() => void) | null>(null)
  const runAllAbortedRef = useRef(false)
  const generationRef = useRef(0)
  const platformRef = useRef<'web' | 'android' | 'ios'>('web')
  const pendingExternalStepsRef = useRef<LiveEditorExternalStep[] | null>(null)
  const isExternalModeRef = useRef(Boolean(externalSteps))
  const activeHookRunRef = useRef<{
    phase: 'setup' | 'teardown'
    hookId: string
    executionId?: string | null
  } | null>(null)
  const testsRef = useRef<EditorTest[]>([])
  const runningTestIndexRef = useRef<number | null>(null)
  const runAllTestsAbortedRef = useRef(false)
  const testCompleteResolverRef = useRef<((result: { status: string }) => void) | null>(null)

  connectionStateRef.current = connectionState
  stepsRef.current = steps
  runningStepIndexRef.current = runningStepIndex
  platformRef.current = platform
  isExternalModeRef.current = Boolean(externalSteps)
  testsRef.current = tests
  runningTestIndexRef.current = runningTestIndex

  const clearPollInterval = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current)
      pollIntervalRef.current = null
    }
  }, [])

  const sendMessage = useCallback((msg: Record<string, unknown>) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }, [])

  const startScreenshotPolling = useCallback((interval: number) => {
    clearPollInterval()
    pollIntervalRef.current = setInterval(() => {
      if (document.hidden) return
      sendMessage({ type: 'get-screenshot' })
    }, interval)
  }, [clearPollInterval, sendMessage])

  const waitForCancel = useCallback((): Promise<void> => {
    return new Promise((resolve) => {
      cancelResolverRef.current = resolve
      setTimeout(() => {
        if (cancelResolverRef.current === resolve) {
          cancelResolverRef.current = null
          resolve()
        }
      }, 5000)
    })
  }, [])

  const applyPendingExternalSteps = useCallback(() => {
    const pendingExternalSteps = pendingExternalStepsRef.current
    if (!pendingExternalSteps) return
    pendingExternalStepsRef.current = null
    setSteps((prev) => syncExternalSteps(prev, pendingExternalSteps))
  }, [])

  const connect = useCallback((sid: string) => {
    if (wsRef.current) {
      logLiveDebug('hook', 'closing previous websocket before reconnect', { sessionId: sid })
      wsRef.current.close()
      wsRef.current = null
    }

    setConnectionState('connecting')
    terminatedRef.current = false
    logLiveDebug('hook', 'connecting websocket', { sessionId: sid })

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${proto}//${location.host}/api/live-editor/ws?sessionId=${sid}`
    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => {
      reconnectCountRef.current = 0
      logLiveDebug('hook', 'websocket opened', { sessionId: sid })
    }

    ws.onmessage = (event) => {
      let msg: any
      try {
        msg = JSON.parse(event.data)
      } catch {
        return
      }

      switch (msg.type) {
        case 'session-ready': {
          const sessionPlatform = (msg.platform ?? 'web') as 'web' | 'android' | 'ios'
          setPlatform(sessionPlatform)
          platformRef.current = sessionPlatform
          const interactive = msg.interactive !== false
          setConnectionState(interactive ? 'connected' : 'error')
          setError(msg.error ?? null)
          logLiveDebug('hook', 'session ready', {
            sessionId: sid,
            platform: sessionPlatform,
            interactive,
          })
          if (interactive) {
            startScreenshotPolling(sessionPlatform === 'web' ? 1000 : 2000)
          }
          break
        }

        case 'hook-start': {
          const hook = msg.hook as {
            executionId: string
            hookId: string
            hookName: string
            phase: 'setup' | 'teardown'
            owner: LiveHookOwner
            createdAt: string
          }
          const nextHook: LiveHookExecution = {
            id: hook.hookId,
            executionId: hook.executionId,
            name: hook.hookName,
            phase: hook.phase,
            status: 'running',
            duration: undefined,
            stdout: null,
            stderr: null,
            variables: null,
            error: undefined,
            createdAt: hook.createdAt,
          }
          if (hook.owner.scope === 'suite') {
            const updateHooks = hook.phase === 'setup' ? setSetupHooks : setTeardownHooks
            updateHooks((prev) => upsertHookExecution(prev, nextHook))
            if (
              activeHookRunRef.current
              && activeHookRunRef.current.phase === hook.phase
              && activeHookRunRef.current.hookId === hook.hookId
            ) {
              activeHookRunRef.current = { ...activeHookRunRef.current, executionId: hook.executionId }
            }
          } else if (isLiveTestOwner(hook.owner)) {
            const owner = hook.owner
            setTests((prev) => updateTestByMeta(prev, owner, (test) => ({
              ...test,
              perTestSetupHooks: hook.phase === 'setup'
                ? upsertHookExecution(test.perTestSetupHooks, nextHook)
                : test.perTestSetupHooks,
              perTestTeardownHooks: hook.phase === 'teardown'
                ? upsertHookExecution(test.perTestTeardownHooks, nextHook)
                : test.perTestTeardownHooks,
            })))
          }
          break
        }

        case 'hook-complete': {
          const hookPayload = msg.hook as {
            executionId: string
            hookId: string
            hookName: string
            phase: 'setup' | 'teardown'
            owner: LiveHookOwner
            status: 'passed' | 'failed'
            duration?: number
            stdout?: string | null
            stderr?: string | null
            variables?: Record<string, string> | null
            error?: string
            createdAt: string
          }
          const hook: LiveHookExecution = {
            id: hookPayload.hookId,
            executionId: hookPayload.executionId,
            name: hookPayload.hookName,
            phase: hookPayload.phase,
            status: hookPayload.status,
            duration: hookPayload.duration,
            stdout: hookPayload.stdout ?? null,
            stderr: hookPayload.stderr ?? null,
            variables: hookPayload.variables ?? null,
            error: hookPayload.error,
            createdAt: hookPayload.createdAt,
          }
          if (hookPayload.owner.scope === 'suite') {
            const updateHooks = hook.phase === 'setup' ? setSetupHooks : setTeardownHooks
            updateHooks((prev) => upsertHookExecution(prev, hook))
            if (
              activeHookRunRef.current
              && activeHookRunRef.current.phase === hook.phase
              && activeHookRunRef.current.hookId === hook.id
              && (!activeHookRunRef.current.executionId || activeHookRunRef.current.executionId === hook.executionId)
            ) {
              activeHookRunRef.current = null
              setConnectionState('connected')
              startScreenshotPolling(platformRef.current === 'web' ? 1000 : 2000)
              applyPendingExternalSteps()
            }
          } else if (isLiveTestOwner(hookPayload.owner)) {
            const owner = hookPayload.owner
            setTests((prev) => updateTestByMeta(prev, owner, (test) => ({
              ...test,
              perTestSetupHooks: hook.phase === 'setup'
                ? upsertHookExecution(test.perTestSetupHooks, hook)
                : test.perTestSetupHooks,
              perTestTeardownHooks: hook.phase === 'teardown'
                ? upsertHookExecution(test.perTestTeardownHooks, hook)
                : test.perTestTeardownHooks,
            })))
          }
          break
        }

        case 'step-phase':
          setSteps(prev => prev.map((s, i) =>
            i === runningStepIndexRef.current && s.status === 'running' && s.executionGeneration === generationRef.current
              ? {
                  ...s,
                  phases: [...s.phases, {
                    phase: msg.phase,
                    text: msg.data?.text,
                    confidence: msg.data?.confidence,
                    action: msg.data?.action,
                    success: msg.data?.success,
                    duration: msg.data?.duration,
                    timestamp: new Date().toISOString(),
                  }],
                }
              : s,
          ))
          break

        case 'step-complete': {
          const result = msg.result as any
          const idx = runningStepIndexRef.current
          const resolvedStatus = result?.status === 'passed' ? 'passed' : 'failed'
          setSteps(prev => prev.map((s, i) =>
            i === idx && s.status === 'running'
              ? {
                  ...s,
                  status: resolvedStatus as 'passed' | 'failed',
                  duration: result?.duration,
                  error: result?.error,
                  capturedVariables: result?.capturedVariables,
                  consoleLogs: result?.consoleLogs ?? [],
                  networkLogs: result?.networkLogs ?? [],
                  variableSnapshot: result?.variableSnapshot ?? null,
                  originalStepName: result?.originalStepName ?? null,
                  subActionsData: result?.subActionsData ?? null,
                  executionLogs: result?.executionLogs ?? [],
                }
              : s,
          ))
          setRunningStepIndex(null)
          setConnectionState('connected')
          logLiveDebug('hook', 'step completed', {
            sessionId: sid,
            stepIndex: idx ?? undefined,
            status: resolvedStatus,
          })
          startScreenshotPolling(platformRef.current === 'web' ? 1000 : 2000)
          stepCompleteResolverRef.current?.({ status: resolvedStatus })
          stepCompleteResolverRef.current = null
          cancelResolverRef.current?.()
          cancelResolverRef.current = null
          applyPendingExternalSteps()
          break
        }

        case 'test-start': {
          const test = msg.test as LiveTestExecutionMeta
          runningTestIndexRef.current = test.testIndex
          setRunningTestIndex(test.testIndex)
          setTests((prev) => updateTestByMeta(prev, test, (entry) => ({
            ...entry,
            status: 'running',
            duration: undefined,
            error: undefined,
            testExecutionId: test.testExecutionId,
            runningStepIndex: null,
            liveSteps: [],
            perTestSetupHooks: [],
            perTestTeardownHooks: [],
          })))
          break
        }

        case 'test-step-start': {
          const step = msg.step as LiveTestStepMeta
          setTests((prev) => updateTestByMeta(prev, step, (test) => ({
            ...test,
            status: 'running',
            testExecutionId: step.testExecutionId,
            runningStepIndex: step.stepIndex,
            liveSteps: upsertTestStep(
              test.liveSteps,
              { stepIndex: step.stepIndex, instruction: step.stepInstruction },
              {
                status: 'running',
                duration: undefined,
                error: undefined,
                phases: [],
                consoleLogs: [],
                networkLogs: [],
                variableSnapshot: null,
                originalStepName: null,
                subActionsData: null,
                executionLogs: [],
              },
            ),
          })))
          break
        }

        case 'test-step-phase': {
          const step = msg.step as LiveTestStepMeta
          setTests((prev) => updateTestByMeta(prev, step, (test) => ({
            ...test,
            liveSteps: upsertTestStep(
              test.liveSteps,
              { stepIndex: step.stepIndex, instruction: step.stepInstruction },
              {
                status: 'running',
                phases: [
                  ...(test.liveSteps.find((entry) => entry.stepIndex === step.stepIndex)?.phases ?? []),
                  {
                    phase: msg.phase,
                    text: msg.data?.text,
                    confidence: msg.data?.confidence,
                    action: msg.data?.action,
                    success: msg.data?.success,
                    duration: msg.data?.duration,
                    timestamp: new Date().toISOString(),
                  },
                ],
              },
            ),
          })))
          break
        }

        case 'test-step-complete': {
          const step = msg.step as LiveTestStepMeta
          const result = msg.result as any
          setTests((prev) => updateTestByMeta(prev, step, (test) => ({
            ...test,
            runningStepIndex: test.runningStepIndex === step.stepIndex ? null : test.runningStepIndex,
            liveSteps: upsertTestStep(
              test.liveSteps,
              { stepIndex: step.stepIndex, instruction: step.stepInstruction },
              {
                status: result?.status ?? 'failed',
                duration: result?.duration,
                error: result?.error,
                capturedVariables: result?.capturedVariables,
                consoleLogs: result?.consoleLogs ?? [],
                networkLogs: result?.networkLogs ?? [],
                variableSnapshot: result?.variableSnapshot ?? null,
                originalStepName: result?.originalStepName ?? null,
                subActionsData: result?.subActionsData ?? null,
                executionLogs: result?.executionLogs ?? [],
              },
            ),
          })))
          break
        }

        case 'test-step-cancelled': {
          const step = msg.step as LiveTestStepMeta
          setTests((prev) => updateTestByMeta(prev, step, (test) => ({
            ...test,
            runningStepIndex: test.runningStepIndex === step.stepIndex ? null : test.runningStepIndex,
            liveSteps: upsertTestStep(
              test.liveSteps,
              { stepIndex: step.stepIndex, instruction: step.stepInstruction },
              { status: 'cancelled' },
            ),
          })))
          break
        }

        case 'test-step-error': {
          const step = msg.step as LiveTestStepMeta
          setTests((prev) => updateTestByMeta(prev, step, (test) => ({
            ...test,
            runningStepIndex: test.runningStepIndex === step.stepIndex ? null : test.runningStepIndex,
            liveSteps: upsertTestStep(
              test.liveSteps,
              { stepIndex: step.stepIndex, instruction: step.stepInstruction },
              { status: 'failed', error: msg.error },
            ),
          })))
          break
        }

        case 'test-complete': {
          const test = msg.test as LiveTestExecutionMeta
          const result = msg.result as any
          const resolvedStatus = (result?.status ?? 'failed') as EditorTest['status']
          // Fallback: if server didn't populate top-level error but status is failed,
          // pull the first failed step's error out of stepResults so the UI has
          // something to render.
          let resolvedError: string | undefined = result?.error
          if (!resolvedError && resolvedStatus === 'failed' && Array.isArray(result?.stepResults)) {
            const failedStep = result.stepResults.find((s: any) => s?.status === 'failed')
            if (failedStep?.error) {
              const stepIdx = result.stepResults.indexOf(failedStep)
              resolvedError = `Step ${stepIdx + 1} failed: ${failedStep.error}`
            }
          }
          setTests((prev) => updateTestByMeta(prev, test, (entry) => ({
            ...entry,
            status: resolvedStatus,
            duration: result?.duration,
            error: resolvedError,
            testExecutionId: test.testExecutionId,
            runningStepIndex: null,
            lastRunAt: new Date().toISOString(),
            liveSteps: Array.isArray(result?.stepResults)
              ? result.stepResults.reduce((stepsAcc: TestStepDetail[], stepResult: any, stepIndex: number) => {
                  const existing = entry.liveSteps.find((stepEntry) => stepEntry.stepIndex === stepIndex)
                  if (!existing) return stepsAcc
                  return upsertTestStep(
                    stepsAcc,
                    { stepIndex, instruction: existing.instruction },
                    {
                      status: stepResult?.status ?? existing.status,
                      duration: stepResult?.duration,
                      error: stepResult?.error,
                      capturedVariables: stepResult?.capturedVariables,
                      consoleLogs: stepResult?.consoleLogs ?? existing.consoleLogs,
                      networkLogs: stepResult?.networkLogs ?? existing.networkLogs,
                      variableSnapshot: stepResult?.variableSnapshot ?? existing.variableSnapshot,
                      originalStepName: stepResult?.originalStepName ?? existing.originalStepName,
                      subActionsData: stepResult?.subActionsData ?? existing.subActionsData,
                      executionLogs: stepResult?.executionLogs ?? existing.executionLogs,
                    },
                  )
                }, entry.liveSteps)
              : entry.liveSteps,
            perTestSetupHooks: Array.isArray(result?.setupHookExecutions)
              ? result.setupHookExecutions.map((hook: any) => ({
                  id: hook.hookId,
                  executionId: hook.executionId ?? null,
                  name: hook.hookName,
                  phase: hook.phase,
                  status: hook.status,
                  duration: hook.duration,
                  stdout: hook.stdout ?? null,
                  stderr: hook.stderr ?? null,
                  variables: hook.variables ?? null,
                  error: hook.error,
                  createdAt: hook.createdAt,
                }))
              : entry.perTestSetupHooks,
            perTestTeardownHooks: Array.isArray(result?.teardownHookExecutions)
              ? result.teardownHookExecutions.map((hook: any) => ({
                  id: hook.hookId,
                  executionId: hook.executionId ?? null,
                  name: hook.hookName,
                  phase: hook.phase,
                  status: hook.status,
                  duration: hook.duration,
                  stdout: hook.stdout ?? null,
                  stderr: hook.stderr ?? null,
                  variables: hook.variables ?? null,
                  error: hook.error,
                  createdAt: hook.createdAt,
                }))
              : entry.perTestTeardownHooks,
          })))
          runningTestIndexRef.current = null
          setRunningTestIndex(null)
          setConnectionState('connected')
          startScreenshotPolling(platformRef.current === 'web' ? 1000 : 2000)
          const resolver = testCompleteResolverRef.current
          testCompleteResolverRef.current = null
          resolver?.({ status: resolvedStatus })
          break
        }

        case 'test-error': {
          const test = msg.test as LiveTestExecutionMeta
          setTests((prev) => updateTestByMeta(prev, test, (entry) => ({
            ...entry,
            status: 'failed',
            error: msg.error,
            testExecutionId: test.testExecutionId,
            runningStepIndex: null,
            lastRunAt: new Date().toISOString(),
          })))
          runningTestIndexRef.current = null
          setRunningTestIndex(null)
          setConnectionState('connected')
          startScreenshotPolling(platformRef.current === 'web' ? 1000 : 2000)
          const resolver = testCompleteResolverRef.current
          testCompleteResolverRef.current = null
          resolver?.({ status: 'failed' })
          break
        }

        case 'step-error':
          logLiveDebug('hook', 'step failed', {
            sessionId: sid,
            stepIndex: runningStepIndexRef.current ?? undefined,
            error: msg.error,
          })
          setSteps(prev => prev.map((s, i) => {
            if (i !== runningStepIndexRef.current) return s
            if (s.status === 'cancelling') return { ...s, status: 'cancelled' as const }
            if (s.status === 'running') return { ...s, status: 'failed' as const, error: msg.error }
            return s
          }))
          setRunningStepIndex(null)
          setConnectionState('connected')
          startScreenshotPolling(platformRef.current === 'web' ? 1000 : 2000)
          stepCompleteResolverRef.current?.({ status: 'failed' })
          stepCompleteResolverRef.current = null
          cancelResolverRef.current?.()
          cancelResolverRef.current = null
          applyPendingExternalSteps()
          break

        case 'step-cancelled':
          setSteps(prev => prev.map((s, i) =>
            i === runningStepIndexRef.current && (s.status === 'running' || s.status === 'cancelling')
              ? { ...s, status: 'cancelled' as const }
              : s,
          ))
          setRunningStepIndex(null)
          setConnectionState('connected')
          logLiveDebug('hook', 'step cancelled', {
            sessionId: sid,
            stepIndex: runningStepIndexRef.current ?? undefined,
          })
          startScreenshotPolling(platformRef.current === 'web' ? 1000 : 2000)
          stepCompleteResolverRef.current?.({ status: 'cancelled' })
          stepCompleteResolverRef.current = null
          cancelResolverRef.current?.()
          cancelResolverRef.current = null
          applyPendingExternalSteps()
          break

        case 'step-busy':
          setPendingNavigation(null)
          if (activeHookRunRef.current) {
            activeHookRunRef.current = null
            setConnectionState('connected')
            startScreenshotPolling(platformRef.current === 'web' ? 1000 : 2000)
          }
          setError(`Step already in progress: ${msg.currentStep}`)
          break

        case 'screenshot':
          setScreenshot(`data:image/jpeg;base64,${msg.data}`)
          break

        case 'navigate-complete':
          setCurrentUrl(msg.url ?? null)
          setPendingNavigation(null)
          break

        case 'session-state':
          if (msg.state && 'currentUrl' in msg.state) {
            setCurrentUrl(msg.state.currentUrl ?? null)
          }
          if (msg.state?.interactive === false) {
            setConnectionState('error')
            setError(msg.state.terminalError ?? 'Live session is not ready')
          }
          break

        case 'device-logs':
          setDeviceLogs(prev => [...prev, ...msg.entries])
          break

        case 'aria-tree':
          setAriaTree(msg.tree)
          break

        case 'session-terminated':
          setConnectionState('disconnected')
          setPendingNavigation(null)
          activeHookRunRef.current = null
          clearPollInterval()
          applyPendingExternalSteps()
          logLiveDebug('hook', 'session terminated by server', { sessionId: sid })
          break

        case 'error':
          setPendingNavigation(null)
          if (activeHookRunRef.current) {
            activeHookRunRef.current = null
            setConnectionState('connected')
            startScreenshotPolling(platformRef.current === 'web' ? 1000 : 2000)
            applyPendingExternalSteps()
          }
          setError(msg.message)
          logLiveDebug('hook', 'server reported error', {
            sessionId: sid,
            message: msg.message,
          })
          break
      }
    }

    ws.onclose = () => {
      wsRef.current = null
      clearPollInterval()

      if (terminatedRef.current) {
        logLiveDebug('hook', 'websocket closed after local termination', { sessionId: sid })
        return
      }

      logLiveDebug('hook', 'websocket closed unexpectedly', {
        sessionId: sid,
        allowReconnect,
        reconnectCount: reconnectCountRef.current,
      })

      setConnectionState('disconnected')
      setPendingNavigation(null)
      activeHookRunRef.current = null
      setSteps(prev => prev.map(s =>
        s.status === 'running' || s.status === 'cancelling'
          ? { ...s, status: 'cancelled' as const }
          : s
      ))
      runningStepIndexRef.current = null
      setRunningStepIndex(null)
      stepCompleteResolverRef.current?.({ status: 'cancelled' })
      stepCompleteResolverRef.current = null
      cancelResolverRef.current?.()
      cancelResolverRef.current = null
      applyPendingExternalSteps()

      if (allowReconnect && reconnectCountRef.current < 3) {
        const delay = Math.pow(2, reconnectCountRef.current) * 1000
        reconnectCountRef.current++
        logLiveDebug('hook', 'scheduling reconnect', {
          sessionId: sid,
          delay,
          reconnectCount: reconnectCountRef.current,
        })
        reconnectTimerRef.current = setTimeout(() => connect(sid), delay)
      }
    }

    ws.onerror = () => {
      // onclose will fire after onerror, reconnect handled there
      logLiveDebug('hook', 'websocket error event', { sessionId: sid })
    }
  }, [allowReconnect, applyPendingExternalSteps, clearPollInterval, startScreenshotPolling])

  useEffect(() => {
    if (!externalSteps) return

    if (connectionStateRef.current === 'executing') {
      pendingExternalStepsRef.current = externalSteps
      logLiveDebug('hook', 'queued external step sync while executing', {
        stepCount: externalSteps.length,
      })
      return
    }

    pendingExternalStepsRef.current = null
    logLiveDebug('hook', 'syncing external steps', {
      stepCount: externalSteps.length,
    })
    setSteps((prev) => syncExternalSteps(prev, externalSteps))
  }, [externalSteps])

  useEffect(() => {
    setSetupHooks((prev) => syncExternalHooks(prev, externalSetupHooks, 'setup'))
  }, [externalSetupHooks])

  useEffect(() => {
    setTeardownHooks((prev) => syncExternalHooks(prev, externalTeardownHooks, 'teardown'))
  }, [externalTeardownHooks])

  useEffect(() => {
    if (!externalTests) return
    setTests((prev) => {
      const byKey = new Map(prev.map((t) => [`${t.testId}::${t.path}`, t] as const))
      return externalTests.map((t, i) => createEditorTest(t, i, byKey.get(`${t.testId}::${t.path}`)))
    })
  }, [externalTests])

  useEffect(() => {
    if (!sessionId) {
      setConnectionState('idle')
      setSteps(externalSteps ? syncExternalSteps([], externalSteps) : [])
      setSetupHooks(syncExternalHooks([], externalSetupHooks, 'setup'))
      setTeardownHooks(syncExternalHooks([], externalTeardownHooks, 'teardown'))
      setScreenshot(null)
      setCurrentUrl(null)
      setPendingNavigation(null)
      setError(null)
      activeHookRunRef.current = null
      setDeviceLogs([])
      setPlatform('web')
      setAriaTree(null)
      setIsRunningAll(false)
      setIsStoppingRunAll(false)
      setTests(externalTests?.map((test, index) => createEditorTest(test, index)) ?? [])
      setRunningTestIndex(null)
      setIsRunningAllTests(false)
      setIsStoppingRunAllTests(false)
      return
    }

    connect(sessionId)

    return () => {
      clearPollInterval()
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      if (wsRef.current) {
        logLiveDebug('hook', 'cleaning up websocket for session effect', { sessionId })
        wsRef.current.close()
        wsRef.current = null
      }
    }
  }, [clearPollInterval, connect, sessionId])

  useEffect(() => {
    if (connectionState === 'executing') {
      startScreenshotPolling(platform === 'web' ? 500 : 1000)
    } else if (connectionState === 'connected') {
      startScreenshotPolling(platform === 'web' ? 1000 : 2000)
    } else {
      clearPollInterval()
    }
  }, [connectionState, platform, startScreenshotPolling, clearPollInterval])

  useEffect(() => {
    const handler = () => {
      if (document.hidden) {
        clearPollInterval()
      } else {
        const state = connectionStateRef.current
        const plat = platformRef.current
        if (state === 'executing') startScreenshotPolling(plat === 'web' ? 500 : 1000)
        else if (state === 'connected') startScreenshotPolling(plat === 'web' ? 1000 : 2000)
      }
    }
    document.addEventListener('visibilitychange', handler)
    return () => document.removeEventListener('visibilitychange', handler)
  }, [clearPollInterval, startScreenshotPolling])

  const executeStep = useCallback((instruction: string) => {
    if (isExternalModeRef.current) return
    const stepIndex = stepsRef.current.length
    setSteps(prev => [...prev, {
      id: crypto.randomUUID(),
      draftId: null,
      instruction,
      status: 'running',
      phases: [],
      executionHistory: [],
      consoleLogs: [],
      networkLogs: [],
      variableSnapshot: null,
      originalStepName: null,
      subActionsData: null,
      executionLogs: [],
      executionGeneration: 0,
    }])
    setRunningStepIndex(stepIndex)
    setConnectionState('executing')
    setError(null)
    sendMessage({ type: 'execute-step', stepInstruction: instruction, stepIndex })
  }, [sendMessage])

  const executeStepByIndex = useCallback(async (index: number, draft?: LiveDraftMetadata) => {
    const step = stepsRef.current[index]
    if (!step || !step.instruction.trim()) return

    if (runningStepIndexRef.current !== null) {
      const runningIdx = runningStepIndexRef.current
      runAllAbortedRef.current = true
      setSteps(prev => prev.map((s, i) =>
        i === runningIdx && s.status === 'running'
          ? { ...s, status: 'cancelling' as const }
          : s
      ))
      sendMessage({ type: 'cancel-step' })
      await waitForCancel()
    }

    generationRef.current++
    const currentGen = generationRef.current
    runningStepIndexRef.current = index
    setRunningStepIndex(index)
    setSteps(prev => prev.map((s, i) =>
      i === index
        ? {
            ...s,
            status: 'running' as const,
            phases: [],
            executionHistory: s.phases.length > 0
              ? [...s.executionHistory, {
                  phases: s.phases,
                  status: s.status as StepExecution['status'],
                  duration: s.duration,
                  error: s.error,
                  timestamp: new Date().toISOString(),
                }]
              : s.executionHistory,
            error: undefined,
            duration: undefined,
            consoleLogs: [],
            networkLogs: [],
            variableSnapshot: null,
            originalStepName: null,
            subActionsData: null,
            executionLogs: [],
            executionGeneration: currentGen,
          }
        : s
    ))
    setConnectionState('executing')
    setError(null)
    logLiveDebug('hook', 'executing step', {
      sessionId,
      stepIndex: index,
      instruction: step.instruction,
      testName: draft?.testName,
    })
    sendMessage({ type: 'execute-step', stepInstruction: step.instruction, stepIndex: index, draft })
  }, [sendMessage, sessionId, waitForCancel])

  const executeHookById = useCallback(async (phase: 'setup' | 'teardown', hookId: string) => {
    if (connectionStateRef.current !== 'connected') {
      setError('Live session is busy or not ready')
      return
    }

    activeHookRunRef.current = { phase, hookId }
    const updateHooks = phase === 'setup' ? setSetupHooks : setTeardownHooks
    updateHooks((prev) => prev.map((hook) =>
      hook.id === hookId
        ? {
            ...hook,
            status: 'running',
            duration: undefined,
            stdout: null,
            stderr: null,
            variables: null,
            error: undefined,
          }
        : hook,
    ))
    setConnectionState('executing')
    setError(null)
    logLiveDebug('hook', 'executing hook', {
      sessionId,
      phase,
      hookId,
    })
    sendMessage({ type: 'execute-hook', phase, hookId })
  }, [sendMessage, sessionId])

  const addStep = useCallback(() => {
    if (isExternalModeRef.current) return
    setSteps(prev => [...prev, createEditorStep('')])
  }, [])

  const removeStep = useCallback((index: number) => {
    if (isExternalModeRef.current) return
    setSteps(prev => prev.filter((_, i) => i !== index))
  }, [])

  const updateStepInstruction = useCallback((index: number, instruction: string) => {
    if (isExternalModeRef.current) return
    setSteps(prev => prev.map((s, i) => i === index ? { ...s, instruction } : s))
  }, [])

  const reorderSteps = useCallback((oldIndex: number, newIndex: number) => {
    if (isExternalModeRef.current) return
    setSteps(prev => {
      const updated = [...prev]
      const [removed] = updated.splice(oldIndex, 1)
      updated.splice(newIndex, 0, removed)
      return updated
    })
    const ri = runningStepIndexRef.current
    if (ri !== null) {
      let adjusted = ri
      if (ri === oldIndex) {
        adjusted = newIndex
      } else if (oldIndex < ri && newIndex >= ri) {
        adjusted = ri - 1
      } else if (oldIndex > ri && newIndex <= ri) {
        adjusted = ri + 1
      }
      if (adjusted !== ri) {
        runningStepIndexRef.current = adjusted
        setRunningStepIndex(adjusted)
      }
    }
  }, [])

  const cancelStep = useCallback(() => {
    if (isRunningAll) {
      runAllAbortedRef.current = true
      setIsStoppingRunAll(true)
    }
    setSteps(prev => prev.map((step, index) =>
      index === runningStepIndexRef.current && step.status === 'running'
        ? { ...step, status: 'cancelling' as const }
        : step,
    ))
    logLiveDebug('hook', 'cancelling active step', { sessionId })
    sendMessage({ type: 'cancel-step' })
  }, [isRunningAll, sendMessage, sessionId])

  const requestScreenshot = useCallback(() => {
    sendMessage({ type: 'get-screenshot' })
  }, [sendMessage])

  const refreshPage = useCallback(() => {
    setPendingNavigation({ action: 'refresh' })
    sendMessage({ type: 'refresh-page' })
  }, [sendMessage])

  const goBack = useCallback(() => {
    setPendingNavigation({ action: 'back' })
    sendMessage({ type: 'go-back' })
  }, [sendMessage])

  const goForward = useCallback(() => {
    setPendingNavigation({ action: 'forward' })
    sendMessage({ type: 'go-forward' })
  }, [sendMessage])

  const requestAriaTree = useCallback(() => {
    sendMessage({ type: 'get-aria-tree' })
  }, [sendMessage])

  const navigate = useCallback((url: string) => {
    setPendingNavigation({ action: 'navigate', targetUrl: url })
    sendMessage({ type: 'navigate', url })
  }, [sendMessage])

  const executeStepAndWait = useCallback((index: number, draft?: LiveDraftMetadata): Promise<{ status: string }> => {
    return new Promise((resolve) => {
      stepCompleteResolverRef.current = resolve
      const step = stepsRef.current[index]
      if (!step || !step.instruction.trim()) {
        stepCompleteResolverRef.current = null
        resolve({ status: 'skipped' })
        return
      }
      generationRef.current++
      const currentGen = generationRef.current
      runningStepIndexRef.current = index
      setRunningStepIndex(index)
      setSteps(prev => prev.map((s, i) =>
        i === index
          ? {
              ...s,
              status: 'running' as const,
              phases: [],
              executionHistory: s.phases.length > 0
                ? [...s.executionHistory, {
                    phases: s.phases,
                    status: s.status as StepExecution['status'],
                    duration: s.duration,
                    error: s.error,
                    timestamp: new Date().toISOString(),
                  }]
                : s.executionHistory,
              error: undefined,
              duration: undefined,
              consoleLogs: [],
              networkLogs: [],
              variableSnapshot: null,
              originalStepName: null,
              subActionsData: null,
              executionLogs: [],
              executionGeneration: currentGen,
            }
          : s
      ))
      setConnectionState('executing')
      setError(null)
      sendMessage({ type: 'execute-step', stepInstruction: step.instruction, stepIndex: index, draft })
    })
  }, [sendMessage])

  const runAll = useCallback(async (draft?: LiveDraftMetadata) => {
    if (isRunningAll) return
    runAllAbortedRef.current = false
    const stepCount = stepsRef.current.length
    setIsRunningAll(true)
    setIsStoppingRunAll(false)
    logLiveDebug('hook', 'running all steps', { sessionId, stepCount })
    try {
      for (let i = 0; i < stepCount; i++) {
        if (runAllAbortedRef.current) break
        const step = stepsRef.current[i]
        if (!step.instruction.trim()) continue
        const result = await executeStepAndWait(i, draft)
        if (result.status === 'failed' || result.status === 'cancelled') break
      }
    } finally {
      runAllAbortedRef.current = false
      setIsRunningAll(false)
      setIsStoppingRunAll(false)
    }
  }, [executeStepAndWait, isRunningAll, sessionId])

  const cancelRunAll = useCallback(() => {
    if (!isRunningAll) return
    runAllAbortedRef.current = true
    setIsStoppingRunAll(true)
    setSteps(prev => prev.map((step, index) =>
      index === runningStepIndexRef.current && step.status === 'running'
        ? { ...step, status: 'cancelling' as const }
        : step,
    ))
    if (runningStepIndexRef.current !== null) {
      sendMessage({ type: 'cancel-step' })
    }
  }, [isRunningAll, sendMessage])

  const executeTestAndWait = useCallback(
    (index: number, draft?: LiveSuiteDraft): Promise<{ status: string }> => {
      return new Promise((resolve) => {
        testCompleteResolverRef.current = resolve
        const test = testsRef.current[index]
        if (!test) {
          testCompleteResolverRef.current = null
          resolve({ status: 'skipped' })
          return
        }
        const testExecutionId = crypto.randomUUID()
        runningTestIndexRef.current = index
        setRunningTestIndex(index)
        setTests(prev => prev.map((t, i) =>
          i === index
            ? {
                ...t,
                status: 'running' as const,
                duration: undefined,
                error: undefined,
                testExecutionId,
                runningStepIndex: null,
                liveSteps: [],
                perTestSetupHooks: [],
                perTestTeardownHooks: [],
              }
            : t,
        ))
        setConnectionState('executing')
        setError(null)
        sendMessage({
          type: 'execute-test',
          testExecutionId,
          testId: test.testId,
          path: test.path,
          testIndex: index,
          draft,
        })
      })
    },
    [sendMessage],
  )

  const executeTestByIndex = useCallback(async (index: number, draft?: LiveSuiteDraft) => {
    const test = testsRef.current[index]
    if (!test) return
    await executeTestAndWait(index, draft)
  }, [executeTestAndWait])

  const runAllTests = useCallback(async (draft?: LiveSuiteDraft) => {
    if (isRunningAllTests) return
    runAllTestsAbortedRef.current = false
    const testCount = testsRef.current.length
    setIsRunningAllTests(true)
    setIsStoppingRunAllTests(false)
    try {
      for (let i = 0; i < testCount; i++) {
        if (runAllTestsAbortedRef.current) break
        const result = await executeTestAndWait(i, draft)
        if (result.status === 'failed' || result.status === 'cancelled') break
      }
    } finally {
      runAllTestsAbortedRef.current = false
      setIsRunningAllTests(false)
      setIsStoppingRunAllTests(false)
    }
  }, [executeTestAndWait, isRunningAllTests])

  const cancelRunAllTests = useCallback(() => {
    if (!isRunningAllTests) return
    runAllTestsAbortedRef.current = true
    setIsStoppingRunAllTests(true)
    if (runningTestIndexRef.current !== null) {
      sendMessage({ type: 'cancel-step' })
    }
  }, [isRunningAllTests, sendMessage])

  const terminateSession = useCallback(() => {
    runAllAbortedRef.current = true
    setIsRunningAll(false)
    setIsStoppingRunAll(false)
    terminatedRef.current = true
    logLiveDebug('hook', 'terminating session', { sessionId })
    sendMessage({ type: 'terminate-session' })
  }, [sendMessage, sessionId])

  const runningStepId = runningStepIndex !== null ? steps[runningStepIndex]?.id ?? null : null

  return {
    connectionState,
    steps,
    setupHooks,
    teardownHooks,
    screenshot,
    currentUrl,
    pendingNavigation,
    error,
    executeStep,
    executeStepByIndex,
    executeHookById,
    cancelStep,
    requestScreenshot,
    refreshPage,
    goBack,
    goForward,
    navigate,
    runAll,
    cancelRunAll,
    terminateSession,
    addStep,
    removeStep,
    updateStepInstruction,
    reorderSteps,
    runningStepIndex,
    runningStepId,
    sessionId,
    isTerminated: terminatedRef.current,
    deviceLogs,
    platform,
    ariaTree,
    requestAriaTree,
    isRunningAll,
    isStoppingRunAll,
    tests,
    executeTestByIndex,
    runAllTests,
    cancelRunAllTests,
    runningTestIndex,
    isRunningAllTests,
    isStoppingRunAllTests,
  }
}
