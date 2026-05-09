// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import SuiteEditorPage from '@/pages/suite-editor'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/lib/api', () => ({
  fetchSuiteFile: vi.fn().mockResolvedValue({
    path: 'my.suite.yaml',
    content: 'name: Legacy Suite\ntarget: web\ntests:\n  - test: a.yaml\n    id: t_a',
  }),
  createSuiteFile: vi.fn(),
  updateSuiteFile: vi.fn(),
  validateSuiteContent: vi.fn(),
  triggerRun: vi.fn(),
  fetchConfig: vi.fn().mockResolvedValue({
    config: { workspace: { suiteMatch: ['**/*.suite.yaml'] } },
  }),
}))
vi.mock('@/hooks/use-run-config', () => ({ useRunConfig: () => ({ defaultRunMode: 'local' }) }))
vi.mock('@/hooks/use-page-title', () => ({ usePageTitle: () => {} }))
vi.mock('@/hooks/use-keyboard-shortcuts', () => ({ useKeyboardShortcuts: () => {} }))
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }))
vi.mock('@/hooks/use-target-details', () => ({
  useTargetDetails: () => ({ targets: {}, globalUse: [], isLoading: false }),
}))
vi.mock('@/hooks/use-live-editor', () => ({
  useLiveEditor: () => ({
    connectionState: 'idle',
    steps: [],
    tests: [],
    setupHooks: [],
    teardownHooks: [],
    screenshot: null,
    currentUrl: null,
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
    executeTestByIndex: vi.fn(),
    runAllTests: vi.fn(),
    cancelRunAllTests: vi.fn(),
    runningTestIndex: null,
    isRunningAllTests: false,
    isStoppingRunAllTests: false,
  }),
}))
vi.mock('@/components/live-session-pane', () => ({ LiveSessionPane: () => <div /> }))
vi.mock('@/hooks/use-variable-suggestions', () => ({
  useVariableSuggestions: () => ({ suggestions: [], isLoading: false }),
}))
vi.mock('@/components/suite-navbar', () => ({
  SuiteNavbar: ({ suiteId, unsaved }: { suiteId: string; unsaved: boolean }) => (
    <div data-testid="navbar" data-suite-id={suiteId} data-unsaved={String(unsaved)} />
  ),
}))
vi.mock('@/components/suite-visual-builder', () => ({ SuiteVisualBuilder: () => <div /> }))
vi.mock('@/components/monaco-editor', () => ({ MonacoEditor: () => <div /> }))
vi.mock('@/components/test-settings-panel', () => ({ TestSettingsPanel: () => <div /> }))
vi.mock('@/components/run-results-panel', () => ({ RunResultsPanel: () => <div /> }))
vi.mock('@/components/page-skeleton', () => ({ EditorSkeleton: () => <div data-testid="skeleton" /> }))
vi.mock('@/components/empty-state', () => ({ EmptyState: () => <div /> }))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

let container: HTMLDivElement
let root: Root

function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(
      <MemoryRouter initialEntries={['/suite/s_legacy/edit']}>
        <Routes><Route path="/suite/:suite-id/edit" element={<SuiteEditorPage />} /></Routes>
      </MemoryRouter>
    )
  })
}

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  vi.clearAllMocks()
})

describe('SuiteEditorPage suite-id backfill (D-02)', () => {
  it('auto-generates suite-id when loading a legacy suite missing the field and marks state as unsaved', async () => {
    mount()
    // Wait for fetchSuiteFile + fetchConfig + the backfill useEffect
    await act(async () => { await new Promise((r) => setTimeout(r, 50)) })
    const navbar = container.querySelector('[data-testid="navbar"]')!
    const suiteId = navbar.getAttribute('data-suite-id')
    expect(suiteId).toMatch(/^s_[a-z]+(-[a-z]+){9}$/)
    expect(navbar.getAttribute('data-unsaved')).toBe('true')
  })
})
