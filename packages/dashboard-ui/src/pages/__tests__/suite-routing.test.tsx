// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import SuiteViewerPage from '@/pages/suite-viewer'
import SuiteEditorPage from '@/pages/suite-editor'
import { fetchSuiteFile } from '@/lib/api'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/lib/api', () => ({
  fetchSuiteFile: vi.fn().mockResolvedValue({
    path: 'a.suite.yaml',
    content: 'suite-id: s_abc-def\nname: Seed Suite\ntarget: web\ntests:\n  - test: t.yaml\n    id: t_x\n',
  }),
  fetchSuiteAnalytics: vi.fn().mockResolvedValue({
    suiteId: 's_abc-def',
    total: 0,
    flakyScore: 0,
    isFlaky: false,
    runs: [],
    trends: {
      passRate: 0,
      avgDuration: 0,
      totalRuns: 0,
      daily: [],
    },
  }),
  createSuiteFile: vi.fn(),
  updateSuiteFile: vi.fn(),
  validateSuiteContent: vi.fn(),
  triggerRun: vi.fn(),
  purgeCache: vi.fn(),
  fetchTestAnalytics: vi.fn().mockRejectedValue(new Error('no analytics in test')),
  fetchMemoryScope: vi.fn().mockResolvedValue({
    scope: 'suite',
    scopeId: 's_abc-def',
    observations: [],
    invalidFiles: [],
  }),
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
    steps: [], tests: [], setupHooks: [], teardownHooks: [],
    screenshot: null, currentUrl: null, pendingNavigation: null, error: null,
    executeStep: vi.fn(), executeStepByIndex: vi.fn(), executeHookById: vi.fn(),
    cancelStep: vi.fn(), requestScreenshot: vi.fn(), refreshPage: vi.fn(),
    goBack: vi.fn(), goForward: vi.fn(), navigate: vi.fn(),
    runAll: vi.fn(), cancelRunAll: vi.fn(), terminateSession: vi.fn(),
    addStep: vi.fn(), removeStep: vi.fn(), updateStepInstruction: vi.fn(), reorderSteps: vi.fn(),
    runningStepIndex: null, runningStepId: null, sessionId: null, isTerminated: false,
    deviceLogs: [], platform: 'web', ariaTree: null, requestAriaTree: vi.fn(),
    isRunningAll: false, isStoppingRunAll: false,
    executeTestByIndex: vi.fn(), runAllTests: vi.fn(), cancelRunAllTests: vi.fn(),
    runningTestIndex: null, isRunningAllTests: false, isStoppingRunAllTests: false,
  }),
}))
vi.mock('@/components/live-session-pane', () => ({ LiveSessionPane: () => <div /> }))
vi.mock('@/hooks/use-variable-suggestions', () => ({
  useVariableSuggestions: () => ({ suggestions: [], isLoading: false }),
}))
vi.mock('@/components/suite-navbar', () => ({ SuiteNavbar: () => <div data-testid="navbar" /> }))
vi.mock('@/components/suite-visual-builder', () => ({ SuiteVisualBuilder: () => <div /> }))
vi.mock('@/components/monaco-editor', () => ({ MonacoEditor: () => <div /> }))
vi.mock('@/components/test-settings-panel', () => ({ TestSettingsPanel: () => <div /> }))
vi.mock('@/components/run-results-panel', () => ({ RunResultsPanel: () => <div /> }))
vi.mock('@/components/page-skeleton', () => ({
  EditorSkeleton: () => <div data-testid="skeleton" />,
  TableSkeleton: () => <div />,
  DetailSkeleton: () => <div />,
  ChartSkeleton: () => <div />,
  FormSkeleton: () => <div />,
}))
vi.mock('@/components/split-button', () => ({ SplitButton: () => <div /> }))
vi.mock('@/components/stat-card', () => ({ StatCard: () => <div /> }))
vi.mock('@/components/pass-rate-chart', () => ({ PassRateChart: () => <div /> }))
vi.mock('@/components/duration-chart', () => ({ DurationChart: () => <div /> }))
vi.mock('@/components/shortcut-hints', () => ({ ShortcutKey: () => <span /> }))

vi.mock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => <div data-testid="rpg">{children}</div>,
  ResizablePanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => <div />,
}))
vi.mock('@/components/ui/tabs', () => ({
  Tabs: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock('@/components/ui/card', () => ({
  Card: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock('@/components/ui/table', () => ({
  Table: ({ children }: { children: ReactNode }) => <table>{children}</table>,
  TableBody: ({ children }: { children: ReactNode }) => <tbody>{children}</tbody>,
  TableCell: ({ children }: { children: ReactNode }) => <td>{children}</td>,
  TableHead: ({ children }: { children: ReactNode }) => <th>{children}</th>,
  TableHeader: ({ children }: { children: ReactNode }) => <thead>{children}</thead>,
  TableRow: ({ children }: { children: ReactNode }) => <tr>{children}</tr>,
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

describe('suite routing — /suite/:suite-id', () => {
  let container: HTMLDivElement
  let root: Root

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.clearAllMocks()
  })

  function renderAt(url: string) {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root.render(
        <MemoryRouter initialEntries={[url]}>
          <Routes>
            <Route path="/suite/:suite-id" element={<SuiteViewerPage />} />
            <Route path="/suite/:suite-id/edit" element={<SuiteEditorPage />} />
            <Route path="*" element={<div data-testid="fallback">Fallback</div>} />
          </Routes>
        </MemoryRouter>,
      )
    })
  }

  it('mounts SuiteViewerPage and fetches by suite-id', async () => {
    renderAt('/suite/s_abc-def')
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(vi.mocked(fetchSuiteFile).mock.calls[0]?.[0]).toBe('s_abc-def')
  })

  it('mounts SuiteEditorPage on /edit path', async () => {
    renderAt('/suite/s_abc-def/edit')
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(container.querySelector('[data-testid="navbar"]')).not.toBeNull()
    expect(vi.mocked(fetchSuiteFile).mock.calls[0]?.[0]).toBe('s_abc-def')
  })

  it('shows "Suite not found" EmptyState when fetch rejects', async () => {
    vi.mocked(fetchSuiteFile).mockRejectedValueOnce(new Error('404'))
    renderAt('/suite/s_missing')
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    expect(container.textContent).toContain('Suite not found')
    expect(container.textContent).toContain("This suite doesn't exist")
    expect(container.textContent).toContain('View All Suites')
  })

  it('legacy /suites/:path falls through to wildcard fallback', async () => {
    renderAt('/suites/my.suite.yaml')
    await act(async () => { await Promise.resolve() })
    expect(container.querySelector('[data-testid="fallback"]')).toBeTruthy()
    expect(vi.mocked(fetchSuiteFile)).not.toHaveBeenCalled()
  })
})
