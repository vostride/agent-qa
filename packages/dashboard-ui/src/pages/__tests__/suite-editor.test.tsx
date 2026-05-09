// @vitest-environment jsdom

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import SuiteEditorPage from '@/pages/suite-editor'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    fetchSuiteFile: vi.fn(),
    createSuiteFile: vi.fn(),
    updateSuiteFile: vi.fn(),
    validateSuiteContent: vi.fn(),
    triggerRun: vi.fn(),
    fetchConfig: vi.fn().mockResolvedValue({
      config: { workspace: { suiteMatch: ['**/*.suite.yaml'] } },
    }),
  }
})

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
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

vi.mock('@/components/suite-navbar', () => ({
  SuiteNavbar: () => (
    <div data-testid="suite-navbar-root" className="flex h-14 shrink-0 items-center justify-between border-b px-4 min-w-0">
      <span data-testid="suite-navbar" />
    </div>
  ),
}))
vi.mock('@/components/suite-visual-builder', () => ({
  SuiteVisualBuilder: () => <div data-testid="suite-visual-builder" />,
}))
vi.mock('@/components/monaco-editor', () => ({ MonacoEditor: () => <div data-testid="monaco" /> }))
vi.mock('@/components/test-settings-panel', () => ({
  TestSettingsPanel: ({ showMeta }: { showMeta?: boolean }) => (
    <div data-testid="test-settings-panel" data-show-meta={String(showMeta)} />
  ),
}))
vi.mock('@/components/run-results-panel', () => ({ RunResultsPanel: () => <div data-testid="results" /> }))
vi.mock('@/components/page-skeleton', () => ({ EditorSkeleton: () => <div data-testid="skeleton" /> }))
vi.mock('@/components/empty-state', () => ({ EmptyState: () => <div data-testid="empty-state" /> }))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactElement }) => children,
  TooltipTrigger: ({ children }: { children: ReactElement }) => children,
  TooltipContent: ({ children }: { children: ReactElement }) => children,
  TooltipProvider: ({ children }: { children: ReactElement }) => children,
}))

let container: HTMLDivElement
let root: Root

function mount(initialEntries: string[]) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(
      <MemoryRouter initialEntries={initialEntries}>
        <Routes>
          <Route path="/suites/new" element={<SuiteEditorPage />} />
          <Route path="/suites/:path/edit" element={<SuiteEditorPage />} />
        </Routes>
      </MemoryRouter>
    )
  })
}

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  vi.clearAllMocks()
})

describe('SuiteEditorPage', () => {
  it('renders SuiteNavbar + Tabs + SuiteVisualBuilder in create mode (no ResizablePanel split by default)', async () => {
    mount(['/suites/new'])
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.querySelector('[data-testid="suite-navbar"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="suite-visual-builder"]')).not.toBeNull()
    // Builder is default tab
    expect(container.textContent).toContain('Builder')
    expect(container.textContent).toContain('YAML')
  })

  it('shows File Path input in create mode', async () => {
    mount(['/suites/new'])
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.textContent).toContain('File Path')
    expect(container.querySelector('input[placeholder="my-suite.suite.yaml"]')).not.toBeNull()
  })

  it('does NOT render Memory tab', async () => {
    mount(['/suites/new'])
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.textContent).not.toContain('Memory')
  })

  it('renders SuiteNavbar without p-6 page padding ancestor (Gap 1: edge-to-edge chrome)', async () => {
    // The SuiteNavbar must be rendered at the root of the page flex container
    // (h-screen flex-col), not wrapped by any p-6 page-padding container.
    // In the full app, /suites routes set handle.hideHeader=true so AppLayout's
    // <main> drops the p-6 class. This test verifies the page-level structure —
    // no p-6 wrapper appears between the SuiteNavbar root and the test container.
    mount(['/suites/new'])
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const navRoot = container.querySelector('[data-testid="suite-navbar-root"]')
    expect(navRoot).not.toBeNull()
    let el: Element | null = navRoot
    while (el && el !== container) {
      const cls = typeof el.className === 'string' ? el.className : ''
      expect(cls).not.toMatch(/\bp-6\b/)
      el = el.parentElement
    }
  })

  // Gap 4 regression — ApiError.missingTests surfaces rich toast, not generic "API error 400"
  it('shows rich missing-tests toast when save throws ApiError with missingTests (Gap 4)', async () => {
    const api = await import('@/lib/api')
    const { toast } = await import('sonner')
    // Force createSuiteFile to reject with a realistic ApiError payload from the server.
    vi.mocked(api.createSuiteFile).mockRejectedValueOnce(
      new api.ApiError(400, 'Bad Request', {
        error: 'Invalid suite content',
        missingTests: [{ index: 0, test: 'tests/web/gone.yaml', id: 't_gone' }],
      }),
    )

    mount(['/suites/new'])
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    // Type a valid filename so handleSave doesn't short-circuit on getSuiteFilenameError
    const fileInput = container.querySelector(
      'input[placeholder="my-suite.suite.yaml"]',
    ) as HTMLInputElement | null
    expect(fileInput).not.toBeNull()
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )!.set!
      setter.call(fileInput!, 'my-suite.suite.yaml')
      fileInput!.dispatchEvent(new Event('input', { bubbles: true }))
    })

    // Trigger Cmd+S save (handleSave bound on document)
    await act(async () => {
      const ev = new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true })
      document.dispatchEvent(ev)
      await new Promise((r) => setTimeout(r, 10))
    })

    expect(vi.mocked(toast.error)).toHaveBeenCalled()
    const calls = vi.mocked(toast.error).mock.calls.map((c) => String(c[0]))
    const richToast = calls.find((msg) => msg.includes('tests/web/gone.yaml'))
    expect(richToast).toBeDefined()
    expect(richToast).toMatch(/Cannot save — referenced tests not found/)
    // And NOT the generic message
    const genericToast = calls.find((msg) => msg === 'Failed to save: API error 400: Bad Request')
    expect(genericToast).toBeUndefined()
  })
})
