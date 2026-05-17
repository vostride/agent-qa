// @vitest-environment jsdom

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import SuiteEditorPage from '@/pages/suite-editor'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const {
  createLiveEditorSessionMock,
  fetchSuiteFileMock,
  fetchAuthStatesMock,
  navigateMock,
  saveLiveAuthStateMock,
  terminateSessionMock,
  toastSuccessMock,
  updateSuiteFileMock,
  useParamsMock,
  useSearchParamsMock,
} = vi.hoisted(() => ({
  createLiveEditorSessionMock: vi.fn(),
  fetchSuiteFileMock: vi.fn(),
  fetchAuthStatesMock: vi.fn(),
  navigateMock: vi.fn(),
  saveLiveAuthStateMock: vi.fn(),
  terminateSessionMock: vi.fn(),
  toastSuccessMock: vi.fn(),
  updateSuiteFileMock: vi.fn(),
  useParamsMock: vi.fn(),
  useSearchParamsMock: vi.fn(),
}))

let liveSessionPaneProps: Record<string, unknown> | null = null
let suiteVisualBuilderProps: Record<string, unknown> | null = null

let liveEditorState: any

function resetLiveEditorState() {
  liveEditorState = {
    connectionState: 'connected',
    steps: [],
    tests: [
      {
        id: 'test-1',
        draftId: 'test-1',
        testId: 't_login',
        path: 'tests/web/login.yaml',
        name: 'Login flow',
        status: 'idle',
        testExecutionId: null,
        liveSteps: [],
        runningStepIndex: null,
        perTestSetupHooks: [],
        perTestTeardownHooks: [],
      },
      {
        id: 'test-2',
        draftId: 'test-2',
        testId: 't_checkout',
        path: 'tests/web/checkout.yaml',
        name: 'Checkout flow',
        status: 'idle',
        testExecutionId: null,
        liveSteps: [],
        runningStepIndex: null,
        perTestSetupHooks: [],
        perTestTeardownHooks: [],
      },
    ],
    setupHooks: [],
    teardownHooks: [],
    screenshot: null,
    currentUrl: 'https://example.com',
    pendingNavigation: null,
    error: null,
    executeStep: vi.fn(),
    executeStepByIndex: vi.fn(),
    executeHookById: vi.fn(),
    cancelStep: vi.fn(),
    requestScreenshot: vi.fn(),
    refreshPage: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    navigate: vi.fn(),
    runAll: vi.fn(),
    cancelRunAll: vi.fn(),
    terminateSession: terminateSessionMock,
    addStep: vi.fn(),
    removeStep: vi.fn(),
    updateStepInstruction: vi.fn(),
    reorderSteps: vi.fn(),
    runningStepIndex: null,
    runningStepId: null,
    sessionId: 'session-1',
    isTerminated: false,
    deviceLogs: [],
    platform: 'web',
    ariaTree: null,
    requestAriaTree: vi.fn(),
    isRunningAll: false,
    isStoppingRunAll: false,
    executeTestByIndex: vi.fn(),
    runAllTests: vi.fn(),
    cancelRunAllTests: vi.fn(),
    runningTestIndex: null,
    isRunningAllTests: false,
    isStoppingRunAllTests: false,
  }
}

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router')
  return {
    ...actual,
    useParams: (...args: unknown[]) => useParamsMock(...args),
    useNavigate: () => navigateMock,
    useSearchParams: (...args: unknown[]) => useSearchParamsMock(...args),
  }
})

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: toastSuccessMock,
  },
}))

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }))
vi.mock('@/hooks/use-page-title', () => ({
  usePageTitle: (title: string) => {
    document.title = title
  },
}))
vi.mock('@/hooks/use-run-config', () => ({ useRunConfig: () => ({ defaultRunMode: 'cloud' }) }))
vi.mock('@/hooks/use-keyboard-shortcuts', () => ({ useKeyboardShortcuts: () => {} }))
vi.mock('@/hooks/use-variable-suggestions', () => ({ useVariableSuggestions: () => ({ suggestions: [], isLoading: false }) }))
vi.mock('@/hooks/use-target-details', () => ({
  useTargetDetails: () => ({
    targets: {
      'demo-target': {
        name: 'demo-target',
        platform: 'web',
        url: 'https://example.com',
      },
    },
    globalUse: [],
    isLoading: false,
  }),
}))

vi.mock('@/components/page-skeleton', () => ({ EditorSkeleton: () => <div data-testid="editor-skeleton" /> }))
vi.mock('@/components/empty-state', () => ({
  EmptyState: ({ title }: { title: string }) => <div data-testid="empty-state">{title}</div>,
}))
vi.mock('@/components/monaco-editor', () => ({ MonacoEditor: () => <div data-testid="monaco-editor" /> }))
vi.mock('@/components/test-settings-panel', () => ({ TestSettingsPanel: () => <div data-testid="test-settings-panel" /> }))
vi.mock('@/components/run-results-panel', () => ({ RunResultsPanel: () => <div data-testid="run-results-panel" /> }))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactElement }) => children,
  TooltipTrigger: ({ children }: { children: ReactElement }) => children,
  TooltipContent: ({ children }: { children: ReactElement }) => children,
}))

vi.mock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children }: { children: ReactElement | ReactElement[] }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: ReactElement | ReactElement[] }) => <div>{children}</div>,
  ResizableHandle: () => <div data-testid="resizable-handle" />,
}))

vi.mock('@/components/ui/tabs', () => ({
  Tabs: ({ children }: { children: ReactElement | ReactElement[] }) => <div>{children}</div>,
  TabsList: ({ children }: { children: ReactElement | ReactElement[] }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { children: ReactElement | ReactElement[] }) => <button type="button">{children}</button>,
  TabsContent: ({ children }: { children: ReactElement | ReactElement[] }) => <div>{children}</div>,
}))

vi.mock('@/components/ui/sheet', () => ({
  Sheet: ({ children }: { children: ReactElement | ReactElement[] }) => <div>{children}</div>,
  SheetContent: ({ children }: { children: ReactElement | ReactElement[] }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: ReactElement | ReactElement[] }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: ReactElement | ReactElement[] }) => <div>{children}</div>,
  SheetDescription: ({ children }: { children: ReactElement | ReactElement[] }) => <div>{children}</div>,
}))

vi.mock('@/components/suite-navbar', () => ({
  SuiteNavbar: ({
    onLiveConnect,
    onLiveEnd,
    hasLiveSession,
  }: {
    onLiveConnect?: () => void
    onLiveEnd?: () => void
    hasLiveSession?: boolean
  }) => (
    <div data-testid="suite-navbar">
      {!hasLiveSession && onLiveConnect && (
        <button type="button" onClick={onLiveConnect}>
          Connect Live Session
        </button>
      )}
      {hasLiveSession && onLiveEnd && (
        <button type="button" onClick={onLiveEnd}>
          End Live Session
        </button>
      )}
    </div>
  ),
}))

vi.mock('@/components/suite-visual-builder', () => ({
  SuiteVisualBuilder: (props: Record<string, unknown>) => {
    suiteVisualBuilderProps = props
    return (
      <div data-testid="suite-visual-builder">
        <button type="button" onClick={() => (props.onRunTest as ((index: number) => void) | undefined)?.(1)}>
          Run Test 2
        </button>
      </div>
    )
  },
}))

vi.mock('@/components/live-session-pane', () => ({
  LiveSessionPane: (props: Record<string, unknown>) => {
    liveSessionPaneProps = props
    return (
      <div data-testid="live-session-pane">
        {props.terminalState ? `terminal:${(props.terminalState as { reason: string }).reason}` : 'pane'}
      </div>
    )
  },
}))

vi.mock('@/hooks/use-live-editor', () => ({
  useLiveEditor: (sessionId: string | null) => ({
    ...liveEditorState,
    connectionState: sessionId ? liveEditorState.connectionState : 'idle',
    error: sessionId ? liveEditorState.error : null,
    sessionId,
  }),
}))

vi.mock('@/lib/live-session-config', async () => {
  const actual = await vi.importActual<typeof import('@/lib/live-session-config')>('@/lib/live-session-config')
  return {
    ...actual,
    buildLiveSessionConfig: () => ({ platform: 'web', targetName: 'demo-target', url: 'https://example.com' }),
  }
})

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    fetchSuiteFile: fetchSuiteFileMock,
    createLiveEditorSession: createLiveEditorSessionMock,
    createSuiteFile: vi.fn(),
    updateSuiteFile: updateSuiteFileMock,
    validateSuiteContent: vi.fn(),
    triggerRun: vi.fn(),
    fetchAuthStates: fetchAuthStatesMock,
    saveLiveAuthState: saveLiveAuthStateMock,
    fetchConfig: vi.fn().mockResolvedValue({
      config: { workspace: { suiteMatch: ['**/*.suite.yaml'] } },
    }),
  }
})

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  liveSessionPaneProps = null
  suiteVisualBuilderProps = null
  resetLiveEditorState()
  fetchSuiteFileMock.mockReset()
  fetchAuthStatesMock.mockReset()
  saveLiveAuthStateMock.mockReset()
  createLiveEditorSessionMock.mockReset()
  navigateMock.mockReset()
  terminateSessionMock.mockReset()
  toastSuccessMock.mockReset()
  updateSuiteFileMock.mockReset()
  useParamsMock.mockReset()
  useSearchParamsMock.mockReset()

  useParamsMock.mockReturnValue({ 'suite-id': 's_live' })
  useSearchParamsMock.mockReturnValue([new URLSearchParams(''), vi.fn()])
  fetchSuiteFileMock.mockResolvedValue({
    path: 'suites/live.suite.yaml',
    content: `name: Live Suite\nsuite-id: s_live\ntarget: demo-target\nuse:\n  authState: suite-admin\ntests:\n  - test: tests/web/login.yaml\n    id: t_login\n  - test: tests/web/checkout.yaml\n    id: t_checkout\n`,
  })
  createLiveEditorSessionMock.mockResolvedValue({ sessionId: 'session-1', sessionNumber: 1 })
  fetchAuthStatesMock.mockResolvedValue({ authStates: [] })
  saveLiveAuthStateMock.mockResolvedValue({
    authState: {
      version: 1,
      kind: 'web',
      target: 'demo-target',
      name: 'suite-admin',
      capturedAt: '2026-05-17T10:00:00.000Z',
    },
  })

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
  document.title = ''
})

async function render(ui: ReactElement): Promise<HTMLElement> {
  const currentRoot = root
  const currentContainer = container
  if (!currentRoot || !currentContainer) throw new Error('Test root not initialized')
  await act(async () => {
    currentRoot.render(ui)
  })
  await flush()
  return currentContainer
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
  })
  await act(async () => {
    await Promise.resolve()
  })
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()
}

function getButtonByText(scope: ParentNode, text: string): HTMLButtonElement {
  const button = Array.from(scope.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.trim() === text,
  )
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Unable to find button "${text}"`)
  }
  return button
}

describe('SuiteEditorPage live mode orchestration', () => {
  it('passes structured suite-live state into LiveSessionPane without flattened perTestHooks', async () => {
    const rootElement = await render(<SuiteEditorPage />)

    await click(getButtonByText(rootElement, 'Connect Live Session'))

    expect(liveSessionPaneProps?.tests).toHaveLength(2)
    expect('perTestHooks' in (liveSessionPaneProps ?? {})).toBe(false)
  })

  it('auto-selects the running test and preserves failed-test selection', async () => {
    const rootElement = await render(<SuiteEditorPage />)
    await click(getButtonByText(rootElement, 'Connect Live Session'))

    liveEditorState.runningTestIndex = 1
    liveEditorState.tests[1] = {
      ...liveEditorState.tests[1],
      status: 'running',
      testExecutionId: 'exec-2',
    }
    await render(<SuiteEditorPage />)

    expect(liveSessionPaneProps?.selection).toEqual({ type: 'test', testIndex: 1 })

    liveEditorState.runningTestIndex = null
    liveEditorState.tests[1] = {
      ...liveEditorState.tests[1],
      status: 'failed',
      error: 'Checkout failed',
      lastRunAt: '2026-04-18T00:00:00.000Z',
    }
    await render(<SuiteEditorPage />)

    expect(liveSessionPaneProps?.selection).toEqual({ type: 'test', testIndex: 1 })
  })

  it('passes strict run-all labels and queue props through the page', async () => {
    const rootElement = await render(<SuiteEditorPage />)
    await click(getButtonByText(rootElement, 'Connect Live Session'))

    liveEditorState.isRunningAllTests = true
    await render(<SuiteEditorPage />)

    expect(liveSessionPaneProps?.runAllLabel).toBe('Run All Tests')
    expect(liveSessionPaneProps?.stopAllLabel).toBe('Stop Run All')
    expect(suiteVisualBuilderProps?.isRunningAll).toBe(true)
  })

  it('keeps disconnect handling generic and runtime-only', async () => {
    const rootElement = await render(<SuiteEditorPage />)
    await click(getButtonByText(rootElement, 'Connect Live Session'))

    liveEditorState.connectionState = 'disconnected'
    liveEditorState.error = 'browser crashed'
    await render(<SuiteEditorPage />)
    await render(<SuiteEditorPage />)

    expect(liveSessionPaneProps?.terminalState).toMatchObject({ reason: 'disconnected' })
    expect(liveSessionPaneProps?.errorMessage).toBeNull()
  })

  it('passes suite auth-state prefill, saves via auth-state API, and leaves YAML unchanged', async () => {
    fetchAuthStatesMock.mockResolvedValue({
      authStates: [{
        version: 1,
        kind: 'web',
        target: 'demo-target',
        name: 'suite-admin',
        capturedAt: '2026-05-17T10:00:00.000Z',
      }],
    })
    const rootElement = await render(<SuiteEditorPage />)

    await click(getButtonByText(rootElement, 'Connect Live Session'))

    expect(createLiveEditorSessionMock.mock.calls[0]?.[0]).toMatchObject({ targetName: 'demo-target' })
    expect(fetchAuthStatesMock).toHaveBeenCalledWith({ target: 'demo-target' })
    const authStateCapture = liveSessionPaneProps?.authStateCapture as {
      initialName: string | null
      targetName: string
      authStates: unknown[]
      onSave: (input: { name: string; replace: boolean }) => Promise<void>
    }
    expect(authStateCapture).toMatchObject({
      initialName: 'suite-admin',
      targetName: 'demo-target',
    })
    expect(authStateCapture.authStates).toHaveLength(1)

    await act(async () => {
      await authStateCapture.onSave({ name: 'suite-admin', replace: true })
    })
    await flush()

    expect(saveLiveAuthStateMock).toHaveBeenCalledWith('session-1', { name: 'suite-admin', replace: true })
    expect(fetchAuthStatesMock).toHaveBeenCalledTimes(2)
    expect(toastSuccessMock).toHaveBeenCalledWith('Saved auth state "suite-admin" for target "demo-target".')
    expect(updateSuiteFileMock).not.toHaveBeenCalled()
  })

  it('suppresses invalid suite auth-state prefill and returns safe save failures', async () => {
    fetchSuiteFileMock.mockResolvedValue({
      path: 'suites/live.suite.yaml',
      content: `name: Live Suite\nsuite-id: s_live\ntarget: demo-target\nuse:\n  authState: ../suite-admin.json\ntests:\n  - test: tests/web/login.yaml\n    id: t_login\n`,
    })
    saveLiveAuthStateMock.mockRejectedValue(new Error('EACCES .agent-qa/auth-states/demo-target/suite-admin.json secret-cookie'))
    const rootElement = await render(<SuiteEditorPage />)

    await click(getButtonByText(rootElement, 'Connect Live Session'))

    const authStateCapture = liveSessionPaneProps?.authStateCapture as {
      initialName: string | null
      onSave: (input: { name: string; replace: boolean }) => Promise<void>
    }
    expect(authStateCapture.initialName).toBeNull()
    await expect(authStateCapture.onSave({ name: 'suite-admin', replace: false }))
      .rejects.toThrow('Could not save auth state "suite-admin" for target "demo-target".')
    expect(JSON.stringify(liveSessionPaneProps)).not.toContain('../suite-admin.json')
    expect(updateSuiteFileMock).not.toHaveBeenCalled()
  })
})
