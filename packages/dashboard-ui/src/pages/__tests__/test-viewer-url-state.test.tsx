// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'

import { triggerRun } from '@/lib/api'
import TestViewerPage from '@/pages/test-viewer'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const testViewerHarness = vi.hoisted(() => ({
  fetchTestFile: vi.fn(),
  fetchTestAnalytics: vi.fn(),
  triggerRun: vi.fn(),
  purgeCache: vi.fn(),
  advanceAfterRunStarted: vi.fn(),
  productTourEnabled: false,
}))

vi.mock('@/lib/api', () => ({
  fetchTestFile: testViewerHarness.fetchTestFile,
  fetchTestAnalytics: testViewerHarness.fetchTestAnalytics,
  triggerRun: testViewerHarness.triggerRun,
  purgeCache: testViewerHarness.purgeCache,
}))

vi.mock('@/hooks/use-run-config', () => ({ useRunConfig: () => ({ defaultRunMode: 'local' }) }))
vi.mock('@/hooks/use-page-title', () => ({ usePageTitle: () => {} }))
vi.mock('@/hooks/use-keyboard-shortcuts', () => ({ useKeyboardShortcuts: () => {} }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/components/product-tour', () => ({
  useOptionalProductTour: () =>
    testViewerHarness.productTourEnabled
      ? { advanceAfterRunStarted: testViewerHarness.advanceAfterRunStarted }
      : null,
}))

vi.mock('@/components/test-navbar', () => ({
  TestNavbar: ({
    onRun,
    runButtonTourId,
    isRunning,
  }: {
    onRun: (local: boolean) => void
    runButtonTourId?: string
    isRunning?: boolean
  }) => (
    <button
      type="button"
      data-testid="navbar-run"
      data-tour-id={runButtonTourId}
      disabled={isRunning}
      onClick={() => onRun(true)}
    >
      Run
    </button>
  ),
}))
vi.mock('@/components/visual-builder', () => ({
  VisualBuilder: () => <div data-testid="builder-panel">Builder Panel</div>,
}))
vi.mock('@/components/monaco-editor', () => ({
  MonacoEditor: ({ value }: { value: string }) => (
    <div data-testid="yaml-panel">YAML Panel: {value}</div>
  ),
}))
vi.mock('@/components/memory-reader/shared-scope-memory-reader', () => ({
  SharedScopeMemoryReader: ({ scope, scopeId }: { scope: string; scopeId: string }) => (
    <div data-testid="memory-panel">Shared Memory Reader: {scope}:{scopeId}</div>
  ),
}))
vi.mock('@/components/pass-rate-chart', () => ({ PassRateChart: () => <div /> }))
vi.mock('@/components/duration-chart', () => ({ DurationChart: () => <div /> }))
vi.mock('@/components/page-skeleton', () => ({ EditorSkeleton: () => <div>Loading...</div> }))
vi.mock('@/components/empty-state', () => ({
  EmptyState: ({ title }: { title: string }) => <div>{title}</div>,
}))
vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

let currentTabValue = 'overview'
let currentViewValue = 'builder'

vi.mock('@/components/ui/tabs', async () => {
  const React = await import('react')

  const TabsContext = React.createContext<{ value: string; onValueChange?: (value: string) => void } | null>(null)

  function Tabs({
    value,
    onValueChange,
    children,
  }: {
    value: string
    onValueChange?: (value: string) => void
    children: ReactNode
  }) {
    return (
      <TabsContext.Provider value={{ value, onValueChange }}>
        <div data-tabs-value={value}>{children}</div>
      </TabsContext.Provider>
    )
  }

  function TabsList({ children }: { children: ReactNode }) {
    return <div>{children}</div>
  }

  function TabsTrigger({
    value,
    children,
  }: {
    value: string
    children: ReactNode
  }) {
    const ctx = React.useContext(TabsContext)
    return (
      <button
        type="button"
        data-state={ctx?.value === value ? 'active' : 'inactive'}
        onClick={() => ctx?.onValueChange?.(value)}
      >
        {children}
      </button>
    )
  }

  function TabsContent({
    value,
    className,
    children,
  }: {
    value: string
    className?: string
    children: ReactNode
  }) {
    const ctx = React.useContext(TabsContext)
    return ctx?.value === value ? <div data-testid={`tab-content-${value}`} className={className}>{children}</div> : null
  }

  return { Tabs, TabsList, TabsTrigger, TabsContent }
})

vi.mock('@/components/ui/card', () => ({
  Card: ({ children, className }: { children: ReactNode; className?: string }) => <div data-slot="card" className={className}>{children}</div>,
  CardContent: ({ children, className }: { children: ReactNode; className?: string }) => <div data-slot="card-content" className={className}>{children}</div>,
}))

vi.mock('@/components/ui/table', () => ({
  Table: ({ children }: { children: ReactNode }) => <table>{children}</table>,
  TableBody: ({ children }: { children: ReactNode }) => <tbody>{children}</tbody>,
  TableCell: ({ children }: { children: ReactNode }) => <td>{children}</td>,
  TableHead: ({ children }: { children: ReactNode }) => <th>{children}</th>,
  TableHeader: ({ children }: { children: ReactNode }) => <thead>{children}</thead>,
  TableRow: ({ children }: { children: ReactNode }) => <tr>{children}</tr>,
}))

vi.mock('@/components/ui/badge', () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}))

function LocationProbe() {
  const location = useLocation()
  currentTabValue = new URLSearchParams(location.search).get('tab') ?? ''
  currentViewValue = new URLSearchParams(location.search).get('view') ?? ''

  return (
    <div
      data-testid="location"
      data-pathname={location.pathname}
      data-search={location.search}
    />
  )
}

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  testViewerHarness.fetchTestFile.mockReset()
  testViewerHarness.fetchTestFile.mockResolvedValue({
    path: 'tests/web/alpha.yaml',
    content: 'name: Alpha Test\ntest-id: t_alpha\nsteps:\n  - open https://example.com\n',
  })
  testViewerHarness.fetchTestAnalytics.mockReset()
  testViewerHarness.fetchTestAnalytics.mockResolvedValue({
    total: 6,
    flakyScore: 0.12,
    isFlaky: false,
    runs: [
      {
        id: 'r_alpha_passed',
        status: 'passed',
        source: 'dashboard',
        duration: 42100,
        createdAt: '2026-04-23T10:00:00.000Z',
      },
      {
        id: 'r_alpha_failed',
        status: 'failed',
        source: 'cli',
        duration: 58900,
        createdAt: '2026-04-23T11:00:00.000Z',
      },
    ],
    trends: {
      passRate: 0.83,
      avgDuration: 50500,
      daily: [
        { date: '2026-04-22', total: 3, passed: 2, failed: 1, avgDuration: 48000 },
        { date: '2026-04-23', total: 3, passed: 3, failed: 0, avgDuration: 53000 },
      ],
    },
  })
  testViewerHarness.triggerRun.mockReset()
  testViewerHarness.purgeCache.mockReset()
  testViewerHarness.advanceAfterRunStarted.mockReset()
  testViewerHarness.productTourEnabled = false
})

async function flushRender() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function renderAt(url: string) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)

  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route
            path="/test/:t_id"
            element={
              <>
                <LocationProbe />
                <TestViewerPage />
              </>
            }
          />
          <Route path="/runs/:runId/live" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    )
  })

  await flushRender()
  return container
}

async function clickNavbarRun() {
  const runButton = container?.querySelector<HTMLButtonElement>('[data-testid="navbar-run"]')
  expect(runButton).not.toBeNull()

  await act(async () => {
    runButton?.click()
  })
  await flushRender()
}

afterEach(() => {
  if (root) {
    act(() => root!.unmount())
  }
  root = null
  if (container) {
    container.remove()
  }
  container = null
  currentTabValue = 'overview'
  currentViewValue = 'builder'
  vi.clearAllMocks()
})

describe('TestViewerPage URL state contract', () => {
  it('rewrites a plain viewer URL to explicit overview + builder defaults', async () => {
    const view = await renderAt('/test/t_alpha')
    const location = view.querySelector('[data-testid="location"]')

    expect(location?.getAttribute('data-pathname')).toBe('/test/t_alpha')
    expect(location?.getAttribute('data-search')).toBe('?tab=overview&view=builder')
    expect(currentTabValue).toBe('overview')
    expect(currentViewValue).toBe('builder')
    expect(view.textContent).toContain('Builder Panel')

    const overviewPanel = view.querySelector('[data-testid="tab-content-overview"]')
    expect(overviewPanel?.className).toContain('minmax(260px,320px)')

    const sidebar = view.querySelector('[data-testid="test-detail-analytics-sidebar"]')
    expect(sidebar).not.toBeNull()
    expect(sidebar?.className).not.toContain('p-3')

    const sidebarLineGrids = Array.from(sidebar?.querySelectorAll('[data-insights-line-grid]') ?? [])
    expect(sidebarLineGrids.length).toBeGreaterThanOrEqual(2)
    expect(sidebarLineGrids[0]?.className).toContain('border-x-0')
  })

  it('respects ?tab=overview&view=yaml and renders YAML content', async () => {
    const view = await renderAt('/test/t_alpha?tab=overview&view=yaml')

    expect(view.textContent).toContain('YAML Panel:')
    expect(view.textContent).not.toContain('Memory Panel:')
    expect(view.querySelector('[data-testid="location"]')?.getAttribute('data-search')).toBe('?tab=overview&view=yaml')
  })

  it('respects ?tab=overview&view=memory and renders memory content', async () => {
    const view = await renderAt('/test/t_alpha?tab=overview&view=memory')

    expect(view.textContent).toContain('Shared Memory Reader: test:t_alpha')
    expect(view.textContent).not.toContain('YAML Panel:')
    expect(view.querySelector('[data-testid="location"]')?.getAttribute('data-search')).toBe('?tab=overview&view=memory')
  })

  it('canonicalizes invalid and legacy params back to the default viewer state', async () => {
    const invalid = await renderAt('/test/t_alpha?tab=bogus&view=bogus')
    expect(invalid.querySelector('[data-testid="location"]')?.getAttribute('data-search')).toBe('?tab=overview&view=builder')
    expect(invalid.textContent).toContain('Builder Panel')

    act(() => root!.unmount())
    container!.remove()
    root = null
    container = null

    const legacy = await renderAt('/test/t_alpha?sub=yaml')
    expect(legacy.querySelector('[data-testid="location"]')?.getAttribute('data-search')).toBe('?tab=overview&view=builder')
    expect(legacy.textContent).toContain('Builder Panel')
    expect(legacy.querySelector('[data-testid="location"]')?.getAttribute('data-search')).not.toContain('sub=')
  })

  it('renders the insights URL state as a connected no-card line-grid surface', async () => {
    const view = await renderAt('/test/t_alpha?tab=insights&view=builder')

    expect(view.querySelector('[data-testid="location"]')?.getAttribute('data-search')).toBe('?tab=insights&view=builder')
    expect(currentTabValue).toBe('insights')
    expect(currentViewValue).toBe('builder')

    const insightsPanel = view.querySelector('[data-testid="test-detail-insights"]')
    expect(insightsPanel).not.toBeNull()

    const lineGrids = Array.from(insightsPanel?.querySelectorAll('[data-insights-line-grid]') ?? [])
    expect(lineGrids.length).toBeGreaterThanOrEqual(3)
    expect(lineGrids.some((grid) => grid.className.includes('border'))).toBe(true)
    expect(lineGrids.some((grid) => grid.className.includes('border-border'))).toBe(true)
    expect(lineGrids.some((grid) => grid.className.includes('rounded-none'))).toBe(true)
    expect(lineGrids.some((grid) => grid.className.includes('bg-transparent'))).toBe(true)
    expect(insightsPanel?.querySelector('[data-slot="card"]')).toBeNull()

    expect(view.textContent).toContain('All Runs (2)')
    expect(view.textContent).toContain('No analytics scope configured')
  })

  it('switches test insight metrics between scoped and all runs locally', async () => {
    const { fetchTestAnalytics } = await import('@/lib/api')
    vi.mocked(fetchTestAnalytics).mockResolvedValueOnce({
      name: 'Alpha Test',
      total: 2,
      flakyScore: 0.8,
      isFlaky: true,
      runs: [
        { id: 'all-1', status: 'passed', duration: 1000, createdAt: '2026-04-23T10:00:00.000Z' },
        { id: 'all-2', status: 'failed', duration: 2000, createdAt: '2026-04-23T11:00:00.000Z' },
      ],
      trends: {
        passRate: 0.8,
        avgDuration: 1500,
        totalRuns: 2,
        daily: [{ date: '2026-04-23', total: 2, passed: 1, failed: 1, avgDuration: 1500 }],
      },
      scope: {
        configured: true,
        predicates: [{ key: 'git.branch', value: '^(master|main)$', mode: 'regex' }],
        scopedCount: 1,
        totalCount: 2,
      },
      scopedRuns: [
        { id: 'scoped-1', status: 'passed', duration: 1000, createdAt: '2026-04-23T10:00:00.000Z' },
      ],
      scopedFlakyScore: 0.1,
      scopedTrends: {
        passRate: 0.4,
        avgDuration: 1000,
        totalRuns: 1,
        daily: [{ date: '2026-04-23', total: 1, passed: 1, failed: 0, avgDuration: 1000 }],
      },
    } as any)

    const view = await renderAt('/test/t_alpha?tab=insights&view=builder')

    expect(view.textContent).toContain('Scoped')
    expect(view.textContent).toContain('All runs')
    expect(view.textContent).toContain('1 scoped / 2 total runs')
    expect(view.textContent).toContain('40%')
    expect(view.textContent).toContain('Scoped Runs (1)')

    const allRunsButton = Array.from(view.querySelectorAll('button')).find((button) =>
      button.textContent?.trim() === 'All runs',
    ) as HTMLButtonElement | undefined
    expect(allRunsButton).toBeTruthy()

    await act(async () => {
      allRunsButton!.click()
    })
    await flushRender()

    expect(view.textContent).toContain('80%')
    expect(view.textContent).toContain('All Runs (2)')
  })
})

describe('TestViewerPage product tour run bridge', () => {
  it('passes a stable tour anchor to the primary Run action', async () => {
    const view = await renderAt('/test/t_alpha')

    expect(view.querySelector('[data-testid="navbar-run"]')?.getAttribute('data-tour-id')).toBe(
      'tour-test-run-action',
    )
  })

  it('keeps normal Run behavior when no product tour is active', async () => {
    testViewerHarness.triggerRun.mockResolvedValue({ runId: 'run_123', status: 'queued' })

    const view = await renderAt('/test/t_alpha')
    await clickNavbarRun()

    expect(triggerRun).toHaveBeenCalledWith({ file: 'tests/web/alpha.yaml', local: true })
    expect(testViewerHarness.advanceAfterRunStarted).not.toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledWith('Run started')
    expect(view.querySelector('[data-testid="location"]')?.getAttribute('data-pathname')).toBe(
      '/runs/run_123/live',
    )
  })

  it('records the run id for an active product tour after a successful user Run', async () => {
    testViewerHarness.productTourEnabled = true
    testViewerHarness.triggerRun.mockResolvedValue({ runId: 'run_456', status: 'running' })

    await renderAt('/test/t_alpha')
    await clickNavbarRun()

    expect(triggerRun).toHaveBeenCalledWith({ file: 'tests/web/alpha.yaml', local: true })
    expect(testViewerHarness.advanceAfterRunStarted).toHaveBeenCalledWith('run_456', 'running')
  })

  it('keeps Run failure behavior and does not advance the product tour', async () => {
    testViewerHarness.productTourEnabled = true
    testViewerHarness.triggerRun.mockRejectedValue(new Error('LLM missing'))

    const view = await renderAt('/test/t_alpha')
    await clickNavbarRun()

    expect(testViewerHarness.advanceAfterRunStarted).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('Failed to start run: LLM missing')
    expect(view.querySelector('[data-testid="location"]')?.getAttribute('data-pathname')).toBe(
      '/test/t_alpha',
    )
  })
})
