// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SuiteNavbar } from '@/components/suite-navbar'
import SuiteViewerPage from '@/pages/suite-viewer'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const suiteFiles = {
  s_alpha: {
    path: 'suites/alpha.suite.yaml',
    content: 'suite-id: s_alpha\nname: Alpha Suite\ntarget: web\ntests:\n  - test: tests/web/alpha.yaml\n',
  },
  s_beta: {
    path: 'suites/beta.suite.yaml',
    content: 'suite-id: s_beta\nname: Beta Suite\ntarget: web\ntests:\n  - test: tests/web/beta.yaml\n',
  },
  s_quoted: {
    path: 'suites/quoted.suite.yaml',
    content: 'suite-id: s_quoted\nname: "Quoted Suite"\ntarget: web\ntests:\n  - test: tests/web/quoted.yaml\n',
  },
} as const

const suiteAnalytics = {
  s_alpha: {
    suiteId: 's_alpha',
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
  },
  s_beta: {
    suiteId: 's_beta',
    total: 2,
    flakyScore: 0.5,
    isFlaky: true,
    runs: [
      {
        id: 'run_suite_1',
        status: 'passed',
        duration: 1200,
        createdAt: '2026-04-18T00:00:00.000Z',
        source: 'suite',
      },
      {
        id: 'run_suite_2',
        status: 'failed',
        duration: 2400,
        createdAt: '2026-04-17T00:00:00.000Z',
        source: 'suite',
      },
    ],
    trends: {
      passRate: 0.5,
      avgDuration: 1800,
      totalRuns: 2,
      daily: [
        {
          date: '2026-04-18',
          passed: 1,
          failed: 1,
          total: 2,
          avgDuration: 1800,
        },
      ],
    },
  },
  s_quoted: {
    suiteId: 's_quoted',
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
  },
} as const

vi.mock('@/lib/api', () => ({
  fetchSuiteFile: vi.fn(async (suiteId: keyof typeof suiteFiles) => suiteFiles[suiteId]),
  fetchSuiteAnalytics: vi.fn(async (suiteId: keyof typeof suiteAnalytics) => suiteAnalytics[suiteId]),
  fetchTestAnalytics: vi.fn().mockResolvedValue({
    total: 999,
    flakyScore: 1,
    isFlaky: true,
    runs: [],
    trends: {
      passRate: 1,
      avgDuration: 1,
      totalRuns: 999,
      daily: [],
    },
  }),
  triggerRun: vi.fn().mockResolvedValue({ runId: 'run_12345678' }),
  purgeCache: vi.fn(),
}))

vi.mock('@/hooks/use-run-config', () => ({ useRunConfig: () => ({ defaultRunMode: 'local' }) }))
vi.mock('@/hooks/use-page-title', () => ({ usePageTitle: () => {} }))
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

type ViewerShortcuts = Record<string, (() => void) | undefined>
let currentShortcuts: ViewerShortcuts | null = null

vi.mock('@/hooks/use-keyboard-shortcuts', () => ({
  useKeyboardShortcuts: (shortcuts: ViewerShortcuts) => {
    currentShortcuts = shortcuts
  },
}))

let latestNavbarProps: Parameters<typeof SuiteNavbar>[0] | null = null

vi.mock('@/components/suite-navbar', () => ({
  SuiteNavbar: (props: Parameters<typeof SuiteNavbar>[0]) => {
    latestNavbarProps = props
    return <div data-testid="suite-navbar">suite navbar</div>
  },
}))

vi.mock('@/components/suite-visual-builder', () => ({
  SuiteVisualBuilder: ({ content }: { content: string }) => (
    <div data-testid="builder-panel">Builder Panel: {content}</div>
  ),
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

vi.mock('@/components/pass-rate-chart', () => ({
  PassRateChart: ({ data }: { data: Array<unknown> }) => (
    <div data-testid="pass-rate-chart">Pass Rate Chart: {data.length}</div>
  ),
}))

vi.mock('@/components/duration-chart', () => ({
  DurationChart: ({ data }: { data: Array<unknown> }) => (
    <div data-testid="duration-chart">Duration Chart: {data.length}</div>
  ),
}))

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

vi.mock('@/components/ui/badge', () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}))

vi.mock('@/components/ui/card', () => ({
  Card: ({ children }: { children: ReactNode }) => <div data-slot="card">{children}</div>,
  CardHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardContent: ({ children }: { children: ReactNode }) => <div data-slot="card-content">{children}</div>,
}))

vi.mock('@/components/ui/table', () => ({
  Table: ({ children }: { children: ReactNode }) => <table>{children}</table>,
  TableBody: ({ children }: { children: ReactNode }) => <tbody>{children}</tbody>,
  TableCell: ({ children }: { children: ReactNode }) => <td>{children}</td>,
  TableHead: ({ children }: { children: ReactNode }) => <th>{children}</th>,
  TableHeader: ({ children }: { children: ReactNode }) => <thead>{children}</thead>,
  TableRow: ({ children }: { children: ReactNode }) => <tr>{children}</tr>,
}))

vi.mock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => <div data-testid="resizable-group">{children}</div>,
  ResizablePanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => <div />,
}))

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
    children,
  }: {
    value: string
    children: ReactNode
  }) {
    const ctx = React.useContext(TabsContext)
    return ctx?.value === value ? <div data-testid={`tab-content-${value}`}>{children}</div> : null
  }

  return { Tabs, TabsList, TabsTrigger, TabsContent }
})

function LocationProbe() {
  const location = useLocation()

  return (
    <div
      data-testid="location"
      data-pathname={location.pathname}
      data-search={location.search}
    />
  )
}

function ViewerRouteHarness() {
  const navigate = useNavigate()

  return (
    <>
      <button type="button" data-testid="goto-beta" onClick={() => navigate('/suite/s_beta')}>
        Go Beta
      </button>
      <SuiteViewerPage />
    </>
  )
}

let container: HTMLDivElement | null = null
let root: Root | null = null

async function flushRender() {
  await act(async () => {
    await Promise.resolve()
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
        <LocationProbe />
        <Routes>
          <Route path="/suite/:suite-id" element={<ViewerRouteHarness />} />
          <Route path="/suite/:suite-id/edit" element={<div data-testid="suite-edit-page">suite edit page</div>} />
        </Routes>
      </MemoryRouter>,
    )
  })

  await flushRender()
  return container
}

afterEach(() => {
  if (root) {
    act(() => {
      root!.unmount()
    })
  }
  root = null
  if (container) {
    container.remove()
  }
  container = null
  currentShortcuts = null
  latestNavbarProps = null
  vi.clearAllMocks()
})

describe('SuiteViewerPage parity contract', () => {
  it('rewrites a plain viewer URL to explicit overview + builder defaults and keeps Overview visible on empty analytics', async () => {
    const view = await renderAt('/suite/s_alpha')
    const location = view.querySelector('[data-testid="location"]')

    expect(location?.getAttribute('data-pathname')).toBe('/suite/s_alpha')
    expect(location?.getAttribute('data-search')).toBe('?tab=overview&view=builder')
    expect(view.textContent).toContain('Builder Panel:')
    expect(view.textContent).toContain('Pass Rate')
    expect(view.textContent).toContain('Avg Duration')
    expect(view.textContent).toContain('Total Runs')
    expect(view.textContent).toContain('Flaky Score')
    expect(view.textContent).toContain('No runs yet')
    expect(view.textContent).toContain('Memory')

    const sidebar = view.querySelector('[data-testid="suite-detail-analytics-sidebar"]')
    expect(sidebar).not.toBeNull()
    expect(sidebar?.className).not.toContain('p-4')

    const sidebarLineGrids = Array.from(sidebar?.querySelectorAll('[data-insights-line-grid]') ?? [])
    expect(sidebarLineGrids.length).toBeGreaterThanOrEqual(2)
    expect(sidebarLineGrids[0]?.className).toContain('border-x-0')
  })

  it('canonicalizes invalid suite viewer tabs while preserving a valid memory subview', async () => {
    const view = await renderAt('/suite/s_alpha?tab=bogus&view=memory&sub=yaml')

    expect(view.querySelector('[data-testid="location"]')?.getAttribute('data-search')).toBe('?tab=overview&view=memory')
    expect(view.textContent).toContain('Shared Memory Reader: suite:s_alpha')
    expect(view.textContent).toContain('Memory')
  })

  it('respects ?tab=overview&view=memory and renders shared suite memory content', async () => {
    const view = await renderAt('/suite/s_alpha?tab=overview&view=memory')

    expect(view.textContent).toContain('Shared Memory Reader: suite:s_alpha')
    expect(view.textContent).not.toContain('YAML Panel:')
    expect(view.querySelector('[data-testid="location"]')?.getAttribute('data-search')).toBe('?tab=overview&view=memory')
  })

  it('uses suite-keyed analytics and renders suite-only insights', async () => {
    const { fetchSuiteAnalytics, fetchTestAnalytics } = await import('@/lib/api')
    const view = await renderAt('/suite/s_beta?tab=insights&view=yaml')

    expect(vi.mocked(fetchSuiteAnalytics)).toHaveBeenCalledWith('s_beta', { limit: 50 })
    expect(vi.mocked(fetchTestAnalytics)).not.toHaveBeenCalled()
    expect(view.textContent).toContain('Flaky (score: 0.50)')
    expect(view.textContent).toContain('All Runs (2)')
    expect(view.textContent).toContain('Pass Rate Chart: 1')
    expect(view.textContent).toContain('Duration Chart: 1')

    const insightsPanel = view.querySelector('[data-testid="suite-detail-insights"]')
    expect(insightsPanel).not.toBeNull()
    expect(insightsPanel?.querySelector('[data-slot="card"]')).toBeNull()

    const lineGrids = Array.from(insightsPanel?.querySelectorAll('[data-insights-line-grid]') ?? [])
    expect(lineGrids.length).toBeGreaterThanOrEqual(3)
    expect(lineGrids.some((grid) => grid.className.includes('rounded-none'))).toBe(true)
    expect(lineGrids.some((grid) => grid.className.includes('bg-transparent'))).toBe(true)
    expect(latestNavbarProps?.mode).toBe('view')
    expect(latestNavbarProps?.suiteHref).toBe('/suite/s_beta/edit')
    expect(latestNavbarProps?.showSuiteId).toBe(false)
  })

  it('switches suite insight metrics between scoped and all runs locally', async () => {
    const { fetchSuiteAnalytics } = await import('@/lib/api')
    vi.mocked(fetchSuiteAnalytics).mockResolvedValueOnce({
      suiteId: 's_beta',
      total: 2,
      flakyScore: 0.7,
      isFlaky: true,
      runs: [
        { id: 'all-suite-1', status: 'passed', duration: 1200, createdAt: '2026-04-18T00:00:00.000Z' },
        { id: 'all-suite-2', status: 'failed', duration: 2400, createdAt: '2026-04-17T00:00:00.000Z' },
      ],
      trends: {
        passRate: 0.75,
        avgDuration: 1800,
        totalRuns: 2,
        daily: [{ date: '2026-04-18', passed: 1, failed: 1, total: 2, avgDuration: 1800 }],
      },
      scope: {
        configured: true,
        predicates: [{ key: 'git.branch', value: 'main', mode: 'exact' }],
        scopedCount: 1,
        totalCount: 2,
      },
      scopedRuns: [
        { id: 'scoped-suite-1', status: 'passed', duration: 1200, createdAt: '2026-04-18T00:00:00.000Z' },
      ],
      scopedFlakyScore: 0.2,
      scopedTrends: {
        passRate: 0.25,
        avgDuration: 1200,
        totalRuns: 1,
        daily: [{ date: '2026-04-18', passed: 1, failed: 0, total: 1, avgDuration: 1200 }],
      },
    } as any)

    const view = await renderAt('/suite/s_beta?tab=insights&view=yaml')

    expect(view.textContent).toContain('Scoped')
    expect(view.textContent).toContain('All runs')
    expect(view.textContent).toContain('1 scoped / 2 total runs')
    expect(view.textContent).toContain('25%')
    expect(view.textContent).toContain('Scoped Runs (1)')

    const allRunsButton = Array.from(view.querySelectorAll('button')).find((button) =>
      button.textContent?.trim() === 'All runs',
    ) as HTMLButtonElement | undefined
    expect(allRunsButton).toBeTruthy()

    await act(async () => {
      allRunsButton!.click()
    })
    await flushRender()

    expect(view.textContent).toContain('75%')
    expect(view.textContent).toContain('All Runs (2)')
  })

  it('strips matching quotes from the parsed suite name before passing it to the navbar', async () => {
    await renderAt('/suite/s_quoted')

    expect(latestNavbarProps?.suiteName).toBe('Quoted Suite')
  })

  it('refreshes run and live shortcuts to the current suite route context', async () => {
    const { triggerRun } = await import('@/lib/api')
    const view = await renderAt('/suite/s_alpha')

    vi.mocked(triggerRun).mockClear()

    await act(async () => {
      ;(view.querySelector('[data-testid="goto-beta"]') as HTMLButtonElement).click()
    })
    await flushRender()

    expect(view.querySelector('[data-testid="location"]')?.getAttribute('data-pathname')).toBe('/suite/s_beta')
    expect(view.querySelector('[data-testid="location"]')?.getAttribute('data-search')).toBe('?tab=overview&view=builder')

    await act(async () => {
      currentShortcuts?.r?.()
      await Promise.resolve()
    })

    expect(vi.mocked(triggerRun)).toHaveBeenCalledWith({
      file: 'suites/beta.suite.yaml',
      local: true,
    })
    expect(vi.mocked(triggerRun)).not.toHaveBeenCalledWith({
      file: 'suites/alpha.suite.yaml',
      local: true,
    })

    await act(async () => {
      currentShortcuts?.l?.()
    })

    const location = view.querySelector('[data-testid="location"]')
    expect(location?.getAttribute('data-pathname')).toBe('/suite/s_beta/edit')
    expect(location?.getAttribute('data-search')).toBe('?live=1')
  })
})
