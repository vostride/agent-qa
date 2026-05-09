// @vitest-environment jsdom

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import TestEditorPage from '@/pages/test-editor'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const {
  createTestFileMock,
  navigateMock,
} = vi.hoisted(() => ({
  createTestFileMock: vi.fn(),
  navigateMock: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

vi.mock('react-router', () => ({
  useParams: () => ({}),
  useNavigate: () => navigateMock,
  useSearchParams: () => [new URLSearchParams(''), vi.fn()],
}))

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }))
vi.mock('@/hooks/use-page-title', () => ({ usePageTitle: () => {} }))
vi.mock('@/hooks/use-run-config', () => ({ useRunConfig: () => ({ defaultRunMode: 'local' }) }))
vi.mock('@/hooks/use-keyboard-shortcuts', () => ({ useKeyboardShortcuts: () => {} }))
vi.mock('@/hooks/use-variable-suggestions', () => ({
  useVariableSuggestions: () => ({ suggestions: [], isLoading: false }),
}))
vi.mock('@/hooks/use-target-details', () => ({
  useTargetDetails: () => ({
    targets: {},
    globalUse: [],
    isLoading: false,
  }),
}))
vi.mock('@/hooks/use-live-editor', () => ({
  useLiveEditor: () => ({
    connectionState: 'idle',
    steps: [],
    setupHooks: [],
    teardownHooks: [],
    screenshot: null,
    currentUrl: null,
    pendingNavigation: null,
    error: null,
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
    terminateSession: vi.fn(),
    addStep: vi.fn(),
    removeStep: vi.fn(),
    updateStepInstruction: vi.fn(),
    reorderSteps: vi.fn(),
    runningStepIndex: null,
    runningStepId: null,
    sessionId: null,
    isTerminated: false,
    deviceLogs: [],
    platform: 'web',
    ariaTree: null,
    requestAriaTree: vi.fn(),
    isRunningAll: false,
    isStoppingRunAll: false,
  }),
}))

vi.mock('@/components/test-navbar', () => ({
  TestNavbar: ({ onSave }: { onSave: () => void }) => (
    <button type="button" onClick={onSave}>Save</button>
  ),
}))
vi.mock('@/components/visual-builder', () => ({ VisualBuilder: () => <div data-testid="visual-builder" /> }))
vi.mock('@/components/monaco-editor', () => ({ MonacoEditor: () => <div data-testid="monaco-editor" /> }))
vi.mock('@/components/test-settings-panel', () => ({ TestSettingsPanel: () => <div /> }))
vi.mock('@/components/run-results-panel', () => ({ RunResultsPanel: () => <div /> }))
vi.mock('@/components/live-session-pane', () => ({ LiveSessionPane: () => <div /> }))
vi.mock('@/components/page-skeleton', () => ({ EditorSkeleton: () => <div /> }))
vi.mock('@/components/empty-state', () => ({ EmptyState: () => <div /> }))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactElement }) => children,
  TooltipTrigger: ({ children }: { children: ReactElement }) => children,
  TooltipContent: ({ children }: { children: ReactElement }) => children,
}))
vi.mock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children }: { children: ReactElement | ReactElement[] }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: ReactElement | ReactElement[] }) => <div>{children}</div>,
  ResizableHandle: () => <div />,
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

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    fetchConfig: vi.fn().mockResolvedValue({
      config: { workspace: { testMatch: ['specs/web/**/*.yaml'] } },
    }),
    fetchTestFile: vi.fn(),
    createTestFile: createTestFileMock,
    createLiveEditorSession: vi.fn(),
    updateTestFile: vi.fn(),
    validateTestContent: vi.fn(),
    triggerRun: vi.fn(),
  }
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  createTestFileMock.mockReset()
  navigateMock.mockReset()
  createTestFileMock.mockResolvedValue({ ok: true })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

async function renderPage(): Promise<void> {
  await act(async () => {
    root.render(<TestEditorPage />)
  })
  await flush()
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

async function saveWithFilename(filename: string): Promise<void> {
  const input = container.querySelector('input[placeholder="my-test.yaml"]') as HTMLInputElement | null
  expect(input).not.toBeNull()
  await act(async () => {
    setInputValue(input!, filename)
  })
  await act(async () => {
    ;(container.querySelector('button') as HTMLButtonElement).click()
  })
  await flush()
}

describe('TestEditorPage create path validation', () => {
  it('rejects test files outside workspace.testMatch', async () => {
    const { toast } = await import('sonner')
    await renderPage()

    await saveWithFilename('tests/login.yaml')

    expect(createTestFileMock).not.toHaveBeenCalled()
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      "File path must match one of your workspace's testMatch patterns (specs/web/**/*.yaml)",
    )
  })

  it('creates test files matching workspace.testMatch', async () => {
    await renderPage()

    await saveWithFilename('specs/web/login.yaml')

    expect(createTestFileMock).toHaveBeenCalledWith('specs/web/login.yaml', expect.any(String))
  })
})
