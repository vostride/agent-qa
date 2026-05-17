// @vitest-environment jsdom

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import TestEditorPage from '@/pages/test-editor'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const {
  capturedVisualBuilderProps,
  fetchTestFileMock,
  navigateMock,
  updateTestFileMock,
} = vi.hoisted(() => ({
  capturedVisualBuilderProps: [] as Array<{
    content: string
    draftStepIds?: string[]
    onChange: (yaml: string) => void
  }>,
  fetchTestFileMock: vi.fn(),
  navigateMock: vi.fn(),
  updateTestFileMock: vi.fn(),
}))

const BASE_YAML = `name: Step Reorder
test-id: step-reorder
target: demo-target
steps:
  - First step
  - Second step
`

const REORDERED_YAML = `name: Step Reorder
test-id: step-reorder
target: demo-target
steps:
  - Second step
  - First step
`

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

vi.mock('react-router', () => ({
  useParams: () => ({ t_id: 'step-reorder' }),
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

vi.mock('@/components/live-session-pane', () => ({
  LiveSessionPane: () => <div data-testid="live-session-pane" />,
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
  TestNavbar: ({ unsaved }: { unsaved: boolean }) => (
    <div data-testid="test-navbar">{unsaved ? 'Unsaved' : 'Saved'}</div>
  ),
}))

vi.mock('@/components/visual-builder', () => ({
  VisualBuilder: (props: {
    content: string
    draftStepIds?: string[]
    onChange: (yaml: string) => void
  }) => {
    capturedVisualBuilderProps.push(props)
    return (
      <div data-testid="visual-builder">
        <button type="button" onClick={() => props.onChange(REORDERED_YAML)}>Reorder Steps</button>
      </div>
    )
  },
}))

vi.mock('@/hooks/use-live-editor', () => ({
  useLiveEditor: vi.fn(() => ({
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
    platform: 'web' as const,
    ariaTree: null,
    requestAriaTree: vi.fn(),
    isRunningAll: false,
    isStoppingRunAll: false,
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
    fetchTestFile: fetchTestFileMock,
    updateTestFile: updateTestFileMock,
    createLiveEditorSession: vi.fn(),
    createTestFile: vi.fn(),
    validateTestContent: vi.fn(),
    triggerRun: vi.fn(),
  }
})

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  capturedVisualBuilderProps.length = 0
  fetchTestFileMock.mockReset()
  navigateMock.mockReset()
  updateTestFileMock.mockReset()
  fetchTestFileMock.mockResolvedValue({
    path: 'tests/step-reorder.yaml',
    content: BASE_YAML,
  })
  updateTestFileMock.mockResolvedValue({ ok: true })

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

describe('TestEditorPage step reorder identity wiring', () => {
  it('passes stable draft step IDs to VisualBuilder and marks reorder as unsaved without saving', async () => {
    const rootElement = await render(<TestEditorPage />)

    const initialProps = capturedVisualBuilderProps.at(-1)
    expect(initialProps?.draftStepIds).toHaveLength(2)
    expect(initialProps?.draftStepIds).not.toEqual(['step-0', 'step-1'])
    expect(initialProps?.draftStepIds).not.toEqual(['draft-step-0', 'draft-step-1'])
    const initialIds = [...(initialProps?.draftStepIds ?? [])]

    await click(getButtonByText(rootElement, 'Reorder Steps'))

    const reorderedProps = capturedVisualBuilderProps.at(-1)
    expect(reorderedProps?.draftStepIds).toEqual([initialIds[1], initialIds[0]])
    expect(rootElement.textContent).toContain('Unsaved')
    expect(updateTestFileMock).not.toHaveBeenCalled()
  })
})
