// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import SuiteEditorPage from '@/pages/suite-editor'
import { createSuiteFile, fetchSuiteFile, updateSuiteFile } from '@/lib/api'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const navigateSpy = vi.fn()

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router')
  return {
    ...actual,
    useNavigate: () => navigateSpy,
  }
})

vi.mock('@/lib/generate-suite-id', () => ({ generateSuiteId: () => 's_expected-one' }))

vi.mock('@/lib/api', () => ({
  fetchSuiteFile: vi.fn().mockResolvedValue({
    path: 'existing.suite.yaml',
    content: 'suite-id: s_existing\nname: Ex\ntarget: web\ntests:\n  - test: t.yaml\n    id: t_x\n',
  }),
  createSuiteFile: vi.fn(),
  updateSuiteFile: vi.fn().mockResolvedValue({ path: 'existing.suite.yaml', updated: true }),
  validateSuiteContent: vi.fn(),
  triggerRun: vi.fn(),
  fetchConfig: vi.fn().mockResolvedValue({
    config: { workspace: { suiteMatch: ['**/*.suite.yaml'] } },
  }),
  ApiError: class ApiError extends Error {
    status: number
    missingTests?: Array<{ index: number; test: string; id: string }>
    constructor(status: number, message: string, body?: { missingTests?: Array<{ index: number; test: string; id: string }> }) {
      super(message)
      this.status = status
      this.missingTests = body?.missingTests
    }
  },
}))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
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
vi.mock('@/components/empty-state', () => ({ EmptyState: () => <div data-testid="empty" /> }))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

describe('suite-editor routing', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    navigateSpy.mockReset()
  })

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
            <Route path="/suites/new" element={<SuiteEditorPage />} />
            <Route path="/suite/:suite-id/edit" element={<SuiteEditorPage />} />
          </Routes>
        </MemoryRouter>,
      )
    })
  }

  it('create-mode save redirects to /suite/:new-suite-id/edit', async () => {
    vi.mocked(createSuiteFile).mockResolvedValueOnce({ path: 'my.suite.yaml', created: true })
    renderAt('/suites/new')
    // Let effects flush (suite-id gets auto-generated)
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })

    // Type a valid filename
    const fileInput = container.querySelector(
      'input[placeholder="my-suite.suite.yaml"]',
    ) as HTMLInputElement | null
    expect(fileInput).not.toBeNull()
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )!.set!
      setter.call(fileInput!, 'my.suite.yaml')
      fileInput!.dispatchEvent(new Event('input', { bubbles: true }))
    })

    // Trigger Cmd+S save
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true }))
      await new Promise((r) => setTimeout(r, 20))
    })

    expect(navigateSpy).toHaveBeenCalledWith('/suite/s_expected-one/edit')
  })

  it('edit-mode save calls updateSuiteFile(suiteId, content)', async () => {
    vi.mocked(fetchSuiteFile).mockResolvedValueOnce({
      path: 'existing.suite.yaml',
      suiteId: 's_existing',
      content: 'suite-id: s_existing\nname: Ex\ntarget: web\ntests:\n  - test: t.yaml\n    id: t_x\n',
    })
    renderAt('/suite/s_existing/edit')
    // Wait for fetch + effects
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })

    // Trigger Cmd+S save
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true }))
      await new Promise((r) => setTimeout(r, 20))
    })

    expect(vi.mocked(updateSuiteFile).mock.calls[0]?.[0]).toBe('s_existing')
  })
})
