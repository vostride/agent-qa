// @vitest-environment jsdom

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import TestEditorPage from '@/pages/test-editor'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const {
  createLiveEditorSessionMock,
  executeHookByIdMock,
  fetchTestFileMock,
  navigateMock,
  terminateSessionMock,
  toastErrorMock,
} = vi.hoisted(() => ({
  createLiveEditorSessionMock: vi.fn(),
  executeHookByIdMock: vi.fn(),
  fetchTestFileMock: vi.fn(),
  navigateMock: vi.fn(),
  terminateSessionMock: vi.fn(),
  toastErrorMock: vi.fn(),
}))

const SETUP_ALPHA_ID = 'h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle'
const SETUP_BETA_ID = 'h_aster-bloom-cloud-drift-ember-field-glade-hollow-ivory-jasper'
const TEARDOWN_ALPHA_ID = 'h_canyon-dawn-elm-fjord-grove-harbor-ivory-jungle-kestrel-lantern'

const BASE_YAML = `name: Live Hook Test
test-id: test-1
target: demo-target
context: Hook editing
setup:
  - ${SETUP_ALPHA_ID}
steps:
  - Open the builder
teardown:
  - ${TEARDOWN_ALPHA_ID}
`

const REORDERED_SETUP_YAML = `name: Live Hook Test
test-id: test-1
target: demo-target
context: Hook editing
setup:
  - ${SETUP_BETA_ID}
  - ${SETUP_ALPHA_ID}
steps:
  - Open the builder
teardown:
  - ${TEARDOWN_ALPHA_ID}
`

vi.mock('sonner', () => ({
  toast: {
    error: toastErrorMock,
    success: vi.fn(),
  },
}))

vi.mock('react-router', () => ({
  useParams: () => ({ t_id: 'test-1' }),
  useNavigate: () => navigateMock,
  useSearchParams: () => [new URLSearchParams(''), vi.fn()],
}))

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}))

vi.mock('@/hooks/use-page-title', () => ({
  usePageTitle: () => {},
}))

vi.mock('@/hooks/use-run-config', () => ({
  useRunConfig: () => ({ defaultRunMode: 'cloud' }),
}))

vi.mock('@/hooks/use-keyboard-shortcuts', () => ({
  useKeyboardShortcuts: () => {},
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

vi.mock('@/components/test-navbar', () => ({
  TestNavbar: ({
    onLiveConnect,
    onLiveEnd,
  }: {
    onLiveConnect?: () => void
    onLiveEnd?: () => void
  }) => (
    <div>
      <button type="button" onClick={onLiveConnect}>Connect Live Session</button>
      <button type="button" onClick={onLiveEnd}>End Live Session</button>
    </div>
  ),
}))

vi.mock('@/components/visual-builder', () => ({
  VisualBuilder: ({
    onChange,
    onRunLiveHook,
  }: {
    onChange: (yaml: string) => void
    onRunLiveHook?: (phase: 'setup' | 'teardown', hookId: string) => void
  }) => (
    <div>
      <button type="button" onClick={() => onChange(REORDERED_SETUP_YAML)}>Change Setup Hooks</button>
      <button type="button" onClick={() => onChange(BASE_YAML)}>Restore Setup Hooks</button>
      <button type="button" onClick={() => onRunLiveHook?.('setup', SETUP_ALPHA_ID)}>Run Setup Hook</button>
      <button type="button" onClick={() => onRunLiveHook?.('teardown', TEARDOWN_ALPHA_ID)}>Run Teardown Hook</button>
    </div>
  ),
}))

vi.mock('@/components/live-session-pane', () => ({
  LiveSessionPane: ({
    setupHooksStale = false,
    onRestartSession,
  }: {
    setupHooksStale?: boolean
    onRestartSession?: () => void
  }) => (
    <div data-testid="live-session-pane">
      {setupHooksStale ? (
        <div>
          <span>Restart required</span>
          <button type="button" onClick={onRestartSession}>Restart Live Session</button>
        </div>
      ) : (
        <span>Live session current</span>
      )}
    </div>
  ),
}))

vi.mock('@/hooks/use-live-editor', () => ({
  useLiveEditor: vi.fn((sessionId: string | null, options: { setupHooks?: string[]; teardownHooks?: string[] }) => ({
    connectionState: sessionId ? 'connected' : 'idle',
    steps: [],
    setupHooks: (options.setupHooks ?? []).map((hookId, index) => ({
      id: hookId,
      name: index === 0 && hookId === SETUP_ALPHA_ID ? 'setup.alpha' : hookId === SETUP_BETA_ID ? 'setup.beta' : hookId,
      phase: 'setup' as const,
      status: 'pending' as const,
      stdout: null,
      stderr: null,
      variables: null,
    })),
    teardownHooks: (options.teardownHooks ?? []).map((hookId) => ({
      id: hookId,
      name: hookId === TEARDOWN_ALPHA_ID ? 'teardown.alpha' : hookId,
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
  })),
}))

vi.mock('@/lib/live-session-config', () => ({
  buildLiveSessionConfig: () => ({
    platform: 'web',
    target: 'demo-target',
  }),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')

  return {
    ...actual,
    fetchTestFile: fetchTestFileMock,
    createLiveEditorSession: createLiveEditorSessionMock,
    createTestFile: vi.fn(),
    updateTestFile: vi.fn(),
    validateTestContent: vi.fn(),
    triggerRun: vi.fn(),
  }
})

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  fetchTestFileMock.mockReset()
  createLiveEditorSessionMock.mockReset()
  executeHookByIdMock.mockReset()
  navigateMock.mockReset()
  terminateSessionMock.mockReset()
  toastErrorMock.mockReset()

  fetchTestFileMock.mockResolvedValue({
    path: 'tests/live-hook-test.yaml',
    content: BASE_YAML,
  })
  createLiveEditorSessionMock
    .mockResolvedValueOnce({ sessionId: 'session-1' })
    .mockResolvedValueOnce({ sessionId: 'session-2' })

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

describe('TestEditorPage live hook safeguards', () => {
  it('keeps the session open, shows restart required, and clears the warning when setup hooks match again', async () => {
    const rootElement = await render(<TestEditorPage />)

    await click(getButtonByText(rootElement, 'Connect Live Session'))

    expect(createLiveEditorSessionMock).toHaveBeenCalledTimes(1)
    expect(terminateSessionMock).not.toHaveBeenCalled()
    expect(rootElement.textContent).toContain('Live session current')

    await click(getButtonByText(rootElement, 'Change Setup Hooks'))

    expect(terminateSessionMock).not.toHaveBeenCalled()
    expect(rootElement.textContent).toContain('Restart required')
    expect(rootElement.textContent).toContain('Restart Live Session')

    await click(getButtonByText(rootElement, 'Restore Setup Hooks'))

    expect(rootElement.textContent).not.toContain('Restart required')
  })

  it('restarts from the current draft hook arrays instead of the original snapshot', async () => {
    const rootElement = await render(<TestEditorPage />)

    await click(getButtonByText(rootElement, 'Connect Live Session'))
    await click(getButtonByText(rootElement, 'Change Setup Hooks'))
    await click(getButtonByText(rootElement, 'Restart Live Session'))

    expect(terminateSessionMock).toHaveBeenCalledTimes(1)
    expect(createLiveEditorSessionMock).toHaveBeenCalledTimes(2)
    expect(createLiveEditorSessionMock.mock.calls[1]?.[0]).toMatchObject({
      setupHooks: [SETUP_BETA_ID, SETUP_ALPHA_ID],
      teardownHooks: [TEARDOWN_ALPHA_ID],
    })
  })

  it('blocks setup hook reruns at the page boundary while allowing teardown reruns', async () => {
    const rootElement = await render(<TestEditorPage />)

    await click(getButtonByText(rootElement, 'Connect Live Session'))
    await click(getButtonByText(rootElement, 'Run Setup Hook'))

    expect(toastErrorMock).toHaveBeenCalledWith('Setup hooks only run when a live session starts')
    expect(executeHookByIdMock).not.toHaveBeenCalled()

    await click(getButtonByText(rootElement, 'Run Teardown Hook'))

    expect(executeHookByIdMock).toHaveBeenCalledWith('teardown', TEARDOWN_ALPHA_ID)
  })
})
