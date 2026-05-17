// @vitest-environment jsdom

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import SuiteEditorPage from '@/pages/suite-editor'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const {
  createLiveEditorSessionMock,
  executeHookByIdMock,
  fetchSuiteFileMock,
  navigateMock,
  terminateSessionMock,
  toastErrorMock,
  toastSuccessMock,
  useSearchParamsMock,
  useParamsMock,
} = vi.hoisted(() => ({
  createLiveEditorSessionMock: vi.fn(),
  executeHookByIdMock: vi.fn(),
  fetchSuiteFileMock: vi.fn(),
  navigateMock: vi.fn(),
  terminateSessionMock: vi.fn(),
  toastErrorMock: vi.fn(),
  toastSuccessMock: vi.fn(),
  useSearchParamsMock: vi.fn(),
  useParamsMock: vi.fn(),
}))

const SETUP_ALPHA_ID = 'h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle'
const SETUP_BETA_ID = 'h_aster-bloom-cloud-drift-ember-field-glade-hollow-ivory-jasper'
const TEARDOWN_ALPHA_ID = 'h_canyon-dawn-elm-fjord-grove-harbor-ivory-jungle-kestrel-lantern'
const TEARDOWN_BETA_ID = 'h_cedar-drift-ember-forest-glacier-harbor-island-jetty-kelp-lotus'

const BASE_YAML = `name: Live Suite
suite-id: s_live
target: demo-target
setup:
  - ${SETUP_ALPHA_ID}
teardown:
  - ${TEARDOWN_ALPHA_ID}
tests:
  - test: tests/web/login.yaml
    id: t_login
`

const REORDERED_SETUP_YAML = `name: Live Suite
suite-id: s_live
target: demo-target
setup:
  - ${SETUP_BETA_ID}
  - ${SETUP_ALPHA_ID}
teardown:
  - ${TEARDOWN_ALPHA_ID}
tests:
  - test: tests/web/login.yaml
    id: t_login
`

const CHANGED_TEARDOWN_YAML = `name: Live Suite
suite-id: s_live
target: demo-target
setup:
  - ${SETUP_ALPHA_ID}
teardown:
  - ${TEARDOWN_BETA_ID}
tests:
  - test: tests/web/login.yaml
    id: t_login
`

const ADDED_TEST_YAML = `name: Live Suite
suite-id: s_live
target: demo-target
setup:
  - ${SETUP_ALPHA_ID}
teardown:
  - ${TEARDOWN_ALPHA_ID}
tests:
  - test: tests/web/login.yaml
    id: t_login
  - test: tests/web/checkout.yaml
    id: t_checkout
`

const INVALID_YAML = `name: Live Suite
  target: demo-target
  tests: [not valid yaml structure
`

vi.mock('sonner', () => ({
  toast: {
    error: toastErrorMock,
    success: toastSuccessMock,
  },
}))

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router')
  return {
    ...actual,
    useParams: (...args: unknown[]) => useParamsMock(...args),
    useNavigate: () => navigateMock,
    useSearchParams: (...args: unknown[]) => useSearchParamsMock(...args),
  }
})

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}))

vi.mock('@/hooks/use-page-title', () => ({
  usePageTitle: (title: string) => {
    document.title = title
  },
}))

vi.mock('@/hooks/use-run-config', () => ({
  useRunConfig: () => ({ defaultRunMode: 'cloud' }),
}))

vi.mock('@/hooks/use-keyboard-shortcuts', () => ({
  useKeyboardShortcuts: () => {},
}))

vi.mock('@/hooks/use-variable-suggestions', () => ({
  useVariableSuggestions: () => ({ suggestions: [], isLoading: false }),
}))

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

vi.mock('@/components/page-skeleton', () => ({
  EditorSkeleton: () => <div data-testid="editor-skeleton" />,
}))

vi.mock('@/components/empty-state', () => ({
  EmptyState: ({ title, description }: { title: string; description: string }) => (
    <div data-testid="empty-state">
      <div>{title}</div>
      <div>{description}</div>
    </div>
  ),
}))

vi.mock('@/components/monaco-editor', () => ({
  MonacoEditor: () => <div data-testid="monaco-editor" />,
}))

vi.mock('@/components/test-settings-panel', () => ({
  TestSettingsPanel: () => <div data-testid="test-settings-panel" />,
}))

vi.mock('@/components/run-results-panel', () => ({
  RunResultsPanel: () => <div data-testid="run-results-panel" />,
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactElement }) => children,
  TooltipTrigger: ({ children }: { children: ReactElement }) => children,
  TooltipContent: ({ children }: { children: ReactElement }) => children,
  TooltipProvider: ({ children }: { children: ReactElement }) => children,
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
    isLiveActionDisabled,
    liveSessionNumber,
    runDisabled,
    onRun,
  }: {
    onLiveConnect?: () => void
    onLiveEnd?: () => void
    hasLiveSession?: boolean
    isLiveActionDisabled?: boolean
    liveSessionNumber?: number | null
    runDisabled?: boolean
    onRun?: (local: boolean) => void
  }) => (
    <div data-testid="suite-navbar">
      {onLiveConnect && !hasLiveSession && (
        <button
          type="button"
          data-testid="connect-live"
          disabled={!!isLiveActionDisabled}
          onClick={onLiveConnect}
        >
          Connect Live Session
        </button>
      )}
      {onLiveEnd && hasLiveSession && (
        <button type="button" data-testid="end-live" onClick={onLiveEnd}>
          End Live Session
        </button>
      )}
      {typeof liveSessionNumber === 'number' && (
        <span data-testid="session-number">Session #{liveSessionNumber}</span>
      )}
      <button
        type="button"
        data-testid="run-suite"
        disabled={!!runDisabled}
        onClick={() => onRun?.(false)}
      >
        Run Suite
      </button>
    </div>
  ),
}))

vi.mock('@/components/suite-visual-builder', () => ({
  SuiteVisualBuilder: ({
    onChange,
    liveMode,
    setupHooksStale,
    onRestartSession,
    onRunLiveHook,
  }: {
    onChange: (yaml: string) => void
    liveMode?: boolean
    setupHooksStale?: boolean
    onRestartSession?: () => void
    onRunLiveHook?: (phase: 'setup' | 'teardown', hookId: string) => void
  }) => (
    <div data-testid="suite-visual-builder">
      <span data-testid="live-mode">{liveMode ? 'live' : 'idle'}</span>
      <button type="button" onClick={() => onChange(REORDERED_SETUP_YAML)}>
        Change Setup Hooks
      </button>
      <button type="button" onClick={() => onChange(BASE_YAML)}>
        Restore Setup Hooks
      </button>
      <button type="button" onClick={() => onChange(CHANGED_TEARDOWN_YAML)}>
        Change Teardown Hooks
      </button>
      <button type="button" onClick={() => onChange(ADDED_TEST_YAML)}>
        Add Test
      </button>
      <button type="button" onClick={() => onChange(INVALID_YAML)}>
        Break YAML
      </button>
      <button type="button" onClick={() => onRunLiveHook?.('setup', SETUP_ALPHA_ID)}>
        Run Setup Hook
      </button>
      <button type="button" onClick={() => onRunLiveHook?.('teardown', TEARDOWN_ALPHA_ID)}>
        Run Teardown Hook
      </button>
      {setupHooksStale ? (
        <div>
          <span data-testid="stale-banner">Setup hooks changed</span>
          <button type="button" onClick={onRestartSession}>
            Restart Live Session
          </button>
        </div>
      ) : (
        <span data-testid="no-stale">Live session current</span>
      )}
    </div>
  ),
}))

vi.mock('@/components/live-session-pane', () => ({
  LiveSessionPane: ({
    liveSessionNumber,
  }: {
    liveSessionNumber?: number | null
  }) => (
    <div data-testid="live-session-pane">
      {typeof liveSessionNumber === 'number' && (
        <span data-testid="pane-session-number">Session #{liveSessionNumber}</span>
      )}
    </div>
  ),
}))

vi.mock('@/hooks/use-live-editor', () => ({
  useLiveEditor: vi.fn((sessionId: string | null, options: { setupHooks?: string[]; teardownHooks?: string[]; tests?: unknown[] }) => ({
    connectionState: sessionId ? 'connected' : 'idle',
    steps: [],
    tests: (options.tests ?? []).map((t, i) => ({
      id: `test-${i}`,
      draftId: `test-${i}`,
      testId: `t_${i}`,
      path: `tests/web/test-${i}.yaml`,
      name: `Test ${i}`,
      status: 'idle' as const,
      perTestSetupHooks: [],
      perTestTeardownHooks: [],
    })),
    setupHooks: (options.setupHooks ?? []).map((hookId) => ({
      id: hookId,
      name: hookId === SETUP_ALPHA_ID ? 'setup.alpha' : hookId === SETUP_BETA_ID ? 'setup.beta' : hookId,
      phase: 'setup' as const,
      status: 'pending' as const,
      stdout: null,
      stderr: null,
      variables: null,
    })),
    teardownHooks: (options.teardownHooks ?? []).map((hookId) => ({
      id: hookId,
      name: hookId === TEARDOWN_ALPHA_ID ? 'teardown.alpha' : hookId === TEARDOWN_BETA_ID ? 'teardown.beta' : hookId,
      phase: 'teardown' as const,
      status: 'pending' as const,
      stdout: null,
      stderr: null,
      variables: null,
    })),
    screenshot: null,
    currentUrl: 'https://example.com',
    pendingNavigation: null,
    error: null,
    executeStep: vi.fn(),
    executeStepByIndex: vi.fn(),
    executeHookById: executeHookByIdMock,
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
    sessionId,
    isTerminated: false,
    deviceLogs: [],
    platform: 'web' as const,
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
  })),
}))

vi.mock('@/lib/live-session-config', async () => {
  const actual = await vi.importActual<typeof import('@/lib/live-session-config')>('@/lib/live-session-config')
  return {
    ...actual,
    buildLiveSessionConfig: () => ({
    platform: 'web',
    targetName: 'demo-target',
  }),
  }
})

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')

  return {
    ...actual,
    fetchSuiteFile: fetchSuiteFileMock,
    createLiveEditorSession: createLiveEditorSessionMock,
    createSuiteFile: vi.fn(),
    updateSuiteFile: vi.fn(),
    validateSuiteContent: vi.fn(),
    triggerRun: vi.fn(),
    fetchConfig: vi.fn().mockResolvedValue({
      config: { workspace: { suiteMatch: ['**/*.suite.yaml'] } },
    }),
  }
})

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  fetchSuiteFileMock.mockReset()
  createLiveEditorSessionMock.mockReset()
  executeHookByIdMock.mockReset()
  navigateMock.mockReset()
  terminateSessionMock.mockReset()
  toastErrorMock.mockReset()
  toastSuccessMock.mockReset()
  useSearchParamsMock.mockReset()
  useParamsMock.mockReset()

  useParamsMock.mockReturnValue({ 'suite-id': 's_live' })
  useSearchParamsMock.mockReturnValue([new URLSearchParams(''), vi.fn()])

  fetchSuiteFileMock.mockResolvedValue({
    path: 'suites/live.suite.yaml',
    content: BASE_YAML,
  })
  createLiveEditorSessionMock
    .mockResolvedValueOnce({ sessionId: 'session-1', sessionNumber: 1 })
    .mockResolvedValueOnce({ sessionId: 'session-2', sessionNumber: 2 })

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  container?.remove()
  container = null
  root = null
  document.body.innerHTML = ''
  document.title = ''
})

async function render(ui: ReactElement): Promise<HTMLElement> {
  const currentRoot = root
  const currentContainer = container

  if (!currentRoot || !currentContainer) {
    throw new Error('Test root not initialized')
  }

  await act(async () => {
    currentRoot.render(ui)
  })
  await flush()
  return currentContainer
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
  await act(async () => {
    await Promise.resolve()
  })
}

async function click(element: HTMLElement): Promise<void> {
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

describe('SuiteEditorPage live hook safeguards (Wave 0)', () => {
  it('connects a live session from the SuiteNavbar and passes entity={type:suite, id:suiteId}', async () => {
    const rootElement = await render(<SuiteEditorPage />)

    await click(getButtonByText(rootElement, 'Connect Live Session'))

    expect(createLiveEditorSessionMock).toHaveBeenCalledTimes(1)
    expect(createLiveEditorSessionMock.mock.calls[0]?.[0]).toMatchObject({
      setupHooks: [SETUP_ALPHA_ID],
      teardownHooks: [TEARDOWN_ALPHA_ID],
      entity: { type: 'suite', id: 's_live' },
    })
  })

  it('keeps the session current when setup/teardown hooks match (no stale banner)', async () => {
    const rootElement = await render(<SuiteEditorPage />)

    await click(getButtonByText(rootElement, 'Connect Live Session'))
    expect(rootElement.textContent).toContain('Live session current')
  })

  it('shows the stale banner when setup hooks diverge from the connected snapshot (D-22)', async () => {
    const rootElement = await render(<SuiteEditorPage />)

    await click(getButtonByText(rootElement, 'Connect Live Session'))
    await click(getButtonByText(rootElement, 'Change Setup Hooks'))

    expect(rootElement.querySelector('[data-testid="stale-banner"]')).not.toBeNull()
    expect(terminateSessionMock).not.toHaveBeenCalled()
  })

  it('shows the stale banner when teardown hooks diverge (D-22)', async () => {
    const rootElement = await render(<SuiteEditorPage />)

    await click(getButtonByText(rootElement, 'Connect Live Session'))
    await click(getButtonByText(rootElement, 'Change Teardown Hooks'))

    expect(rootElement.querySelector('[data-testid="stale-banner"]')).not.toBeNull()
  })

  it('does NOT show the stale banner when the test list changes during an active session (D-13 playground)', async () => {
    const rootElement = await render(<SuiteEditorPage />)

    await click(getButtonByText(rootElement, 'Connect Live Session'))
    await click(getButtonByText(rootElement, 'Add Test'))

    expect(rootElement.querySelector('[data-testid="stale-banner"]')).toBeNull()
    expect(rootElement.textContent).toContain('Live session current')
    expect(terminateSessionMock).not.toHaveBeenCalled()
  })

  it('restarts the session using the current draft hook arrays when Restart is clicked', async () => {
    const rootElement = await render(<SuiteEditorPage />)

    await click(getButtonByText(rootElement, 'Connect Live Session'))
    await click(getButtonByText(rootElement, 'Change Setup Hooks'))
    await click(getButtonByText(rootElement, 'Restart Live Session'))

    expect(terminateSessionMock).toHaveBeenCalledTimes(1)
    expect(createLiveEditorSessionMock).toHaveBeenCalledTimes(2)
    expect(createLiveEditorSessionMock.mock.calls[1]?.[0]).toMatchObject({
      setupHooks: [SETUP_BETA_ID, SETUP_ALPHA_ID],
      teardownHooks: [TEARDOWN_ALPHA_ID],
      entity: { type: 'suite', id: 's_live' },
    })
  })

  it('allows manual setup hook re-run during an active session (D-23 divergence from test-editor)', async () => {
    const rootElement = await render(<SuiteEditorPage />)

    await click(getButtonByText(rootElement, 'Connect Live Session'))
    await click(getButtonByText(rootElement, 'Run Setup Hook'))

    // D-23: the suite-editor must NOT surface the test-editor's rejection copy
    const errorCalls = toastErrorMock.mock.calls.map((c) => String(c[0]))
    expect(
      errorCalls.some((msg) => msg.includes('Setup hooks only run when a live session starts')),
    ).toBe(false)
    expect(executeHookByIdMock).toHaveBeenCalledWith('setup', SETUP_ALPHA_ID)
  })

  it('allows manual teardown hook re-run during an active session (D-24)', async () => {
    const rootElement = await render(<SuiteEditorPage />)

    await click(getButtonByText(rootElement, 'Connect Live Session'))
    await click(getButtonByText(rootElement, 'Run Teardown Hook'))

    expect(executeHookByIdMock).toHaveBeenCalledWith('teardown', TEARDOWN_ALPHA_ID)
  })

  it('disables Run Suite while a live session is active (D-16)', async () => {
    const rootElement = await render(<SuiteEditorPage />)

    const runButton = rootElement.querySelector('[data-testid="run-suite"]') as HTMLButtonElement | null
    expect(runButton).not.toBeNull()
    expect(runButton?.disabled).toBe(false)

    await click(getButtonByText(rootElement, 'Connect Live Session'))

    const runButtonAfter = rootElement.querySelector('[data-testid="run-suite"]') as HTMLButtonElement | null
    expect(runButtonAfter?.disabled).toBe(true)
  })

  it('renders Session #N in the SuiteNavbar when connected (D-31)', async () => {
    const rootElement = await render(<SuiteEditorPage />)

    await click(getButtonByText(rootElement, 'Connect Live Session'))

    const badge = rootElement.querySelector('[data-testid="session-number"]')
    expect(badge).not.toBeNull()
    expect(badge?.textContent).toBe('Session #1')
  })

  it('renders Live #N — suiteName as the document title during a live session (D-31 Pitfall 5)', async () => {
    const rootElement = await render(<SuiteEditorPage />)

    expect(document.title).not.toMatch(/^Live #/)

    await click(getButtonByText(rootElement, 'Connect Live Session'))

    expect(document.title).toBe('Live #1 — Live Suite')
  })

  it('auto-launches a live session when the URL contains ?live=1 (D-17)', async () => {
    useSearchParamsMock.mockReturnValue([new URLSearchParams('live=1'), vi.fn()])

    await render(<SuiteEditorPage />)

    expect(createLiveEditorSessionMock).toHaveBeenCalledTimes(1)
    expect(createLiveEditorSessionMock.mock.calls[0]?.[0]).toMatchObject({
      entity: { type: 'suite', id: 's_live' },
    })
  })

  it('does NOT render the Connect button in create mode (D-19 gated at prereq layer)', async () => {
    useParamsMock.mockReturnValue({ 'suite-id': undefined })
    fetchSuiteFileMock.mockResolvedValue({ path: '', content: '' })

    const rootElement = await render(<SuiteEditorPage />)

    const connect = rootElement.querySelector('[data-testid="connect-live"]') as HTMLButtonElement | null
    if (connect) {
      // If the stub still renders the connect button, it must be disabled in create mode.
      expect(connect.disabled).toBe(true)
    } else {
      expect(connect).toBeNull()
    }
  })

  it('ends the live session, clears the session number, and restores the default title (D-25/D-31)', async () => {
    const rootElement = await render(<SuiteEditorPage />)

    await click(getButtonByText(rootElement, 'Connect Live Session'))
    expect(document.title).toBe('Live #1 — Live Suite')

    await click(getButtonByText(rootElement, 'End Live Session'))

    expect(terminateSessionMock).toHaveBeenCalledTimes(1)
    expect(rootElement.querySelector('[data-testid="session-number"]')).toBeNull()
    expect(document.title).toBe('Edit Suite')
  })
})
