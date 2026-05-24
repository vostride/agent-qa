// @vitest-environment jsdom

import { act, type ReactNode, useEffect, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ProductTourOverlay,
  ProductTourProvider,
  useProductTour,
} from '@/components/product-tour'
import {
  PRODUCT_TOUR_COOKIE,
  PRODUCT_TOUR_SCHEMA_VERSION,
  PRODUCT_TOUR_VERSION,
  readProductTourStateCookie,
  writeProductTourStateCookie,
  type ProductTourState,
} from '@/lib/product-tour-state'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const fixedNow = new Date('2026-05-24T16:00:00.000Z')

const appHarness = vi.hoisted(() => ({
  fetchAppMetadata: vi.fn(),
  fetchTestFiles: vi.fn(),
  includeRunsAnchor: true,
}))

vi.mock('@/lib/api', () => ({
  fetchAppMetadata: appHarness.fetchAppMetadata,
  fetchTestFiles: appHarness.fetchTestFiles,
}))

vi.mock('@/lib/analytics', () => ({
  trackDashboardOpenedOnce: vi.fn(),
}))

vi.mock('@/pages/runs', () => ({
  default: () => (
    <div data-testid="runs-page">
      {appHarness.includeRunsAnchor ? <div data-tour-id="tour-runs-table">Runs table</div> : null}
    </div>
  ),
}))
vi.mock('@/pages/tests', () => ({
  default: () => (
    <div data-testid="tests-page">
      <div data-tour-id="tour-tests-table">Tests table</div>
    </div>
  ),
}))
vi.mock('@/pages/hooks', () => ({
  default: () => (
    <div data-testid="hooks-page">
      <div data-tour-id="tour-hooks-table">Hooks table</div>
    </div>
  ),
}))
vi.mock('@/pages/suites', () => ({
  default: () => (
    <div data-testid="suites-page">
      <div data-tour-id="tour-suites-table">Suites table</div>
    </div>
  ),
}))
vi.mock('@/pages/memory', () => ({
  default: () => (
    <div data-testid="memory-page">
      <div data-tour-id="tour-memory-table">Memory table</div>
    </div>
  ),
}))
vi.mock('@/pages/config', () => ({
  default: () => (
    <div data-testid="config-page">
      <div data-tour-id="tour-config-section">Config section</div>
    </div>
  ),
}))
vi.mock('@/pages/run-detail', () => ({
  default: () => <div data-testid="run-detail-page">Run Detail Page</div>,
}))
vi.mock('@/pages/live-run', () => ({
  default: () => <div data-testid="live-run-page">Live Run Page</div>,
}))
vi.mock('@/pages/test-editor', () => ({
  default: () => <div data-testid="test-editor-page">Test Editor Page</div>,
}))
vi.mock('@/pages/test-viewer', () => ({
  default: () => <div data-testid="test-viewer-page">Test Viewer Page</div>,
}))
vi.mock('@/pages/hook-editor', () => ({
  default: () => <div data-testid="hook-editor-page">Hook Editor Page</div>,
}))
vi.mock('@/pages/hook-viewer', () => ({
  default: () => <div data-testid="hook-viewer-page">Hook Viewer Page</div>,
}))
vi.mock('@/pages/suite-editor', () => ({
  default: () => <div data-testid="suite-editor-page">Suite Editor Page</div>,
}))
vi.mock('@/pages/suite-viewer', () => ({
  default: () => <div data-testid="suite-viewer-page">Suite Viewer Page</div>,
}))
vi.mock('@/pages/memory-product', () => ({
  default: () => <div data-testid="memory-product-page">Memory Product Page</div>,
}))
vi.mock('@/pages/insights', () => ({
  default: () => <div data-testid="insights-page">Insights Page</div>,
}))

vi.mock('@/components/theme-provider', () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock('@/components/ui/sidebar', () => ({
  SidebarProvider: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarInset: ({ children, className }: { children: ReactNode; className?: string }) => (
    <section data-testid="sidebar-inset" className={className}>
      {children}
    </section>
  ),
}))
vi.mock('@/components/app-sidebar', () => ({
  AppSidebar: () => (
    <aside data-testid="app-sidebar">
      <button type="button" data-tour-id="tour-help-menu">
        Help and feedback
      </button>
      <button type="button" data-testid="sidebar-tour-launch" data-tour-id="tour-help-product-tour">
        Take product tour
      </button>
      <a href="mailto:support@vostride.com?subject=agent-qa%20feedback">Send feedback</a>
    </aside>
  ),
}))
vi.mock('@/components/command-palette', () => ({
  CommandPalette: () => (
    <button type="button" data-testid="command-tour-launch" data-tour-id="tour-command-product-tour">
      Take product tour
    </button>
  ),
}))
vi.mock('@/components/ui/sonner', () => ({
  Toaster: () => <div data-testid="toaster" />,
}))
vi.mock('@/components/error-boundary', () => ({
  RouteErrorBoundary: () => <div data-testid="route-error-boundary" />,
}))
vi.mock('@/components/page-skeleton', () => ({
  TableSkeleton: () => <div data-testid="table-skeleton" />,
  DetailSkeleton: () => <div data-testid="detail-skeleton" />,
  ChartSkeleton: () => <div data-testid="chart-skeleton" />,
  FormSkeleton: () => <div data-testid="form-skeleton" />,
  EditorSkeleton: () => <div data-testid="editor-skeleton" />,
}))

const allowedRoutes = ['/runs', '/tests', '/hooks', '/suites', '/memory', '/config'] as const
const excludedRoutes = [
  '/runs/r_123',
  '/runs/r_123/live',
  '/test/t_123/edit',
  '/insights',
  '/tests/new',
] as const

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(fixedNow)
  appHarness.includeRunsAnchor = true
  appHarness.fetchAppMetadata.mockReset()
  appHarness.fetchAppMetadata.mockResolvedValue({ version: '0.1.18' })
  appHarness.fetchTestFiles.mockReset()
  appHarness.fetchTestFiles.mockResolvedValue({ files: [] })
  clearTourCookie()
})

afterEach(() => {
  cleanupRoot()
  clearTourCookie()
  vi.useRealTimers()
})

function clearTourCookie() {
  document.cookie = `${PRODUCT_TOUR_COOKIE}=; path=/; max-age=0`
}

function validState(overrides: Partial<ProductTourState> = {}): ProductTourState {
  return {
    schemaVersion: PRODUCT_TOUR_SCHEMA_VERSION,
    tourVersion: PRODUCT_TOUR_VERSION,
    ...overrides,
  }
}

function cleanupRoot() {
  if (root) {
    act(() => {
      root?.unmount()
    })
  }
  root = null
  container?.remove()
  container = null
}

function RouteAwareTour({
  children,
  hideHeader,
}: {
  children?: ReactNode
  hideHeader: boolean
}) {
  const location = useLocation()

  return (
    <ProductTourProvider pathname={location.pathname} hideHeader={hideHeader}>
      <span data-testid="location">{location.pathname}</span>
      {children}
      <ProductTourOverlay />
      <TourControls />
    </ProductTourProvider>
  )
}

function TourControls() {
  const tour = useProductTour()

  return (
    <div>
      <button type="button" data-testid="restart-tour" onClick={tour.restartTour}>
        restart
      </button>
      <button type="button" data-testid="sidebar-tour-launch" onClick={tour.restartTour}>
        Take product tour
      </button>
      <a href="mailto:support@vostride.com?subject=agent-qa%20feedback">Send feedback</a>
      <button type="button" data-testid="command-tour-launch" onClick={tour.restartTour}>
        Take product tour
      </button>
      <button type="button" data-testid="complete-tour" onClick={tour.completeTour}>
        complete
      </button>
      <button
        type="button"
        data-testid="advance-run-started"
        onClick={() => tour.advanceAfterRunStarted('run-generated-pass', 'running')}
      >
        advance run
      </button>
      <button
        type="button"
        data-testid="advance-run-started-without-id"
        onClick={() => tour.advanceAfterRunStarted(null, null)}
      >
        advance run without id
      </button>
      <button
        type="button"
        data-testid="record-run-detail-passed"
        onClick={() => tour.recordRunDetailStatus('passed')}
      >
        record passed run detail
      </button>
      <button
        type="button"
        data-testid="record-run-detail-healed"
        onClick={() => tour.recordRunDetailStatus('healed')}
      >
        record healed run detail
      </button>
      <button
        type="button"
        data-testid="record-run-detail-failed"
        onClick={() => tour.recordRunDetailStatus('failed')}
      >
        record failed run detail
      </button>
      <button
        type="button"
        data-testid="record-run-detail-cancelled"
        onClick={() => tour.recordRunDetailStatus('cancelled')}
      >
        record cancelled run detail
      </button>
      <button
        type="button"
        data-testid="record-run-detail-flaky"
        onClick={() => tour.recordRunDetailStatus('flaky')}
      >
        record flaky run detail
      </button>
      <button
        type="button"
        data-testid="record-run-detail-unknown"
        onClick={() => tour.recordRunDetailStatus('unknown')}
      >
        record unknown run detail
      </button>
      <span data-testid="active-step">{tour.activeStepId ?? ''}</span>
      <span data-testid="tour-active">{String(tour.isActive)}</span>
    </div>
  )
}

function RunDetailStatusRecorder({ status }: { status: string }) {
  const tour = useProductTour()
  const renderCount = useRef(0)
  renderCount.current += 1

  useEffect(() => {
    tour.recordRunDetailStatus(status)
  }, [tour, status])

  return <span data-testid="run-detail-status-render-count">{renderCount.current}</span>
}

function DeferredRunsAnchor() {
  const [isVisible, setIsVisible] = useState(false)

  return (
    <div>
      <button type="button" data-testid="show-runs-anchor" onClick={() => setIsVisible(true)}>
        show runs anchor
      </button>
      {isVisible ? (
        <div ref={makeMeasurableAnchor} data-tour-id="tour-runs-table">
          Runs table
        </div>
      ) : null}
    </div>
  )
}

async function renderTour({
  path = '/runs',
  hideHeader = false,
  children,
}: {
  path?: string
  hideHeader?: boolean
  children?: ReactNode
} = {}) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)

  await act(async () => {
    root?.render(
      <MemoryRouter initialEntries={[path]}>
        <RouteAwareTour hideHeader={hideHeader}>{children}</RouteAwareTour>
      </MemoryRouter>,
    )
  })
  await flushAsyncWork()
}

async function renderAppAt(path: string) {
  vi.resetModules()
  window.history.pushState({}, '', path)
  const { default: App } = await import('@/app')

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)

  await act(async () => {
    root?.render(<App />)
  })
  await flushAsyncWork()
}

async function flushAsyncWork() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function clickButton(name: string | RegExp) {
  const button = findButton(name)
  expect(button).not.toBeNull()

  await act(async () => {
    button?.click()
  })
  await flushAsyncWork()
}

async function clickElement(selector: string) {
  const element = container?.querySelector<HTMLElement>(selector)
  expect(element).not.toBeNull()

  await act(async () => {
    element?.click()
  })
  await flushAsyncWork()
}

function findButton(name: string | RegExp): HTMLButtonElement | null {
  const matcher =
    typeof name === 'string'
      ? (text: string) => text === name
      : (text: string) => name.test(text)

  return (
    Array.from(container?.querySelectorAll('button') ?? []).find((button) =>
      matcher(button.textContent?.trim() ?? ''),
    ) ?? null
  )
}

function textContent() {
  return container?.textContent ?? ''
}

function makeMeasurableAnchor(node: HTMLDivElement | null) {
  if (!node) return

  node.scrollIntoView = vi.fn()
  node.getBoundingClientRect = () =>
    ({
      x: 80,
      y: 60,
      top: 60,
      left: 80,
      right: 240,
      bottom: 104,
      width: 160,
      height: 44,
      toJSON: () => ({}),
    }) as DOMRect
}

function dialog() {
  return container?.querySelector('[role="dialog"]')
}

function productTourHighlight() {
  return container?.querySelector('[data-testid="product-tour-highlight"]') as HTMLDivElement | null
}

function githubNudgeLink() {
  return Array.from(container?.querySelectorAll<HTMLAnchorElement>('a') ?? []).find(
    (link) => link.textContent?.trim() === 'View on GitHub',
  )
}

function expectDialogBottomRight() {
  const tourDialog = dialog() as HTMLElement | null

  expect(tourDialog).not.toBeNull()
  expect(tourDialog?.style.right).toBe('16px')
  expect(tourDialog?.style.bottom).toBe('16px')
  expect(tourDialog?.style.left).toBe('')
  expect(tourDialog?.style.top).toBe('')
  expect(tourDialog?.style.transform).toBe('')
}

function expectNoDialog() {
  expect(dialog()).toBeNull()
  expect(container?.querySelector('[aria-modal="true"]')).toBeNull()
}

function expectNoPrivateTourCopy(rendered: string) {
  const forbiddenCopy = [
    'agent-qa.config.yaml',
    'file://',
    'http://localhost',
    'local logs',
    'logs',
    'memory content',
    'test content',
    'credential',
    'credentials',
    'token',
    'secret',
  ]

  for (const forbidden of forbiddenCopy) {
    expect(rendered.toLowerCase()).not.toContain(forbidden.toLowerCase())
  }
}

async function advanceTourUntil(buttonName: string, maxClicks = 16) {
  for (let index = 0; index < maxClicks; index += 1) {
    if (findButton(buttonName)) return

    const nextButton = findButton('Start tour') ?? findButton('Next')
    expect(nextButton).not.toBeNull()

    await act(async () => {
      nextButton?.click()
    })
    await flushAsyncWork()
  }

  throw new Error(`Tour did not reach ${buttonName}`)
}

async function advanceTourUntilStep(stepId: string, maxClicks = 16) {
  for (let index = 0; index < maxClicks; index += 1) {
    if (container?.querySelector('[data-testid="active-step"]')?.textContent === stepId) return

    const nextButton = findButton('Start tour') ?? findButton('Next')
    expect(nextButton).not.toBeNull()

    await act(async () => {
      nextButton?.click()
    })
    await flushAsyncWork()
  }

  throw new Error(`Tour did not reach ${stepId}`)
}

async function advanceTourToRunDetail() {
  await advanceTourUntilStep('run-action')
  await clickElement('[data-testid="advance-run-started"]')
  await clickButton('Next')
}

describe('AppLayout product tour integration', () => {
  it('auto-starts the intro card on /runs with no cookie', async () => {
    await renderAppAt('/runs')

    expect(PRODUCT_TOUR_COOKIE).toBe('agent_qa_product_tour_state')
    expect(container?.querySelector('[data-testid="runs-page"]')).not.toBeNull()
    expect(dialog()).not.toBeNull()
    expect(dialog()?.getAttribute('aria-modal')).toBe('false')
    expectDialogBottomRight()
    expect(textContent()).toContain('Welcome to agent-qa')
    expect(readProductTourStateCookie()).toMatchObject({
      lastStartedAt: fixedNow.toISOString(),
      activeStepId: 'intro',
    })
    expectNoPrivateTourCopy(textContent())
  })

  it('navigates from /tests to the Config step and persists activeRoute', async () => {
    await renderAppAt('/tests')

    await clickButton('Start tour')

    expect(window.location.pathname).toBe('/config')
    expect(window.location.search).toBe('?bucket=registry&item=llms')
    expect(container?.querySelector('[data-testid="config-page"]')).not.toBeNull()
    expect(readProductTourStateCookie()).toMatchObject({
      activeStepId: 'llm-setup',
      activeRoute: '/config?bucket=registry&item=llms',
    })
  })

  it('renders bottom-right step controls when a routed anchor target is missing', async () => {
    appHarness.includeRunsAnchor = false

    await renderAppAt('/runs')
    await clickButton('Start tour')

    expect(dialog()).not.toBeNull()
    expect(dialog()?.getAttribute('aria-modal')).toBe('false')
    expectDialogBottomRight()
    expect(textContent()).toContain('Configure your LLM first')
    expect(textContent()).not.toContain('This area is not available yet')
    expect(findButton('Next')).not.toBeNull()
    expect(findButton('Skip')).not.toBeNull()
    expectNoPrivateTourCopy(textContent())
  })

  it('does not auto-start on hideHeader routes such as live run details', async () => {
    await renderAppAt('/runs/r_123/live')

    expect(container?.querySelector('[data-testid="live-run-page"]')).not.toBeNull()
    expectNoDialog()
  })
})

describe('ProductTourProvider auto-start behavior', () => {
  it.each(allowedRoutes)('auto-starts the intro step on %s', async (path) => {
    await renderTour({ path })

    expect(dialog()).not.toBeNull()
    expect(dialog()?.getAttribute('aria-modal')).toBe('false')
    expect(textContent()).toContain('Welcome to agent-qa')
    expect(container?.querySelector('[data-testid="active-step"]')?.textContent).toBe('intro')
  })

  it.each(excludedRoutes)('does not auto-start on %s', async (path) => {
    await renderTour({ path })

    expectNoDialog()
  })

  it('does not auto-start when hideHeader is true', async () => {
    await renderTour({ path: '/runs', hideHeader: true })

    expectNoDialog()
  })
})

describe('ProductTourProvider persisted controls', () => {
  it('keeps skipped sessions closed until sidebar or command palette restart actions run', async () => {
    writeProductTourStateCookie(validState({ skippedAt: fixedNow.toISOString() }))

    await renderTour({ path: '/runs' })

    expectNoDialog()
    expect(textContent()).toContain('Take product tour')
    expect(textContent()).toContain('Send feedback')

    await clickElement('[data-testid="sidebar-tour-launch"]')

    expect(textContent()).toContain('Welcome to agent-qa')
    expect(readProductTourStateCookie()).toMatchObject({
      lastStartedAt: fixedNow.toISOString(),
      activeStepId: 'intro',
    })

    cleanupRoot()
    clearTourCookie()
    writeProductTourStateCookie(validState({ skippedAt: fixedNow.toISOString() }))

    await renderTour({ path: '/runs' })

    expectNoDialog()

    await clickElement('[data-testid="command-tour-launch"]')

    expect(textContent()).toContain('Welcome to agent-qa')
    expect(readProductTourStateCookie()).toMatchObject({
      lastStartedAt: fixedNow.toISOString(),
      activeStepId: 'intro',
    })
  })

  it('does not persist dynamic route identifiers when restarted manually', async () => {
    await renderTour({ path: '/test/t_123/edit' })

    expectNoDialog()

    await clickElement('[data-testid="restart-tour"]')

    const state = readProductTourStateCookie()
    expect(textContent()).toContain('Welcome to agent-qa')
    expect(state).toMatchObject({
      lastStartedAt: fixedNow.toISOString(),
      activeStepId: 'intro',
    })
    expect(state?.activeRoute).toBeUndefined()
    expect(document.cookie).not.toContain('/test/t_123/edit')
    expect(document.cookie).not.toContain('t_123')
  })

  it('renders the approved visible launch and tour control labels across the flow', async () => {
    await renderTour({ path: '/runs' })

    expect(textContent()).toContain('Take product tour')
    expect(textContent()).toContain('Send feedback')
    expect(findButton('Skip')).not.toBeNull()
    expect(findButton('Back')).not.toBeNull()
    expect(findButton('Restart')).not.toBeNull()

    await clickButton('Start tour')

    expect(findButton('Next')).not.toBeNull()

    await advanceTourUntil('Done')

    expect(findButton('Done')).not.toBeNull()
    expectNoPrivateTourCopy(textContent())
  })

  it('persists Skip, closes the card, and maps Escape to the same close behavior', async () => {
    await renderTour({ path: '/runs' })

    await clickButton('Skip')

    expectNoDialog()
    expect(readProductTourStateCookie()?.skippedAt).toBe(fixedNow.toISOString())

    clearTourCookie()
    cleanupRoot()
    await renderTour({ path: '/tests' })

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    await flushAsyncWork()

    expectNoDialog()
    expect(readProductTourStateCookie()?.skippedAt).toBe(fixedNow.toISOString())
  })

  it('persists Done and closes the card', async () => {
    await renderTour({ path: '/runs' })

    await advanceTourUntil('Done')

    expect(findButton('Done')).not.toBeNull()

    await clickButton('Done')

    expectNoDialog()
    expect(readProductTourStateCookie()?.completedAt).toBe(fixedNow.toISOString())
  })

  it('clears skipped or completed state on Restart and immediately activates intro', async () => {
    writeProductTourStateCookie(validState({ completedAt: fixedNow.toISOString() }))

    await renderTour({ path: '/runs' })

    expectNoDialog()

    await act(async () => {
      container?.querySelector<HTMLButtonElement>('[data-testid="restart-tour"]')?.click()
    })
    await flushAsyncWork()

    expect(textContent()).toContain('Welcome to agent-qa')
    expect(readProductTourStateCookie()).toMatchObject({
      lastStartedAt: fixedNow.toISOString(),
      activeStepId: 'intro',
    })
  })
})

describe('ProductTourProvider route-aware navigation and fallback rendering', () => {
  it('updates active state, navigates cross-route steps, and supports Back', async () => {
    await renderTour({ path: '/tests' })

    await clickButton('Start tour')

    expect(container?.querySelector('[data-testid="location"]')?.textContent).toBe('/config')
    expect(readProductTourStateCookie()).toMatchObject({
      activeStepId: 'llm-setup',
      activeRoute: '/config?bucket=registry&item=llms',
    })

    await clickButton('Next')

    expect(container?.querySelector('[data-testid="location"]')?.textContent).toBe('/runs')
    expect(readProductTourStateCookie()).toMatchObject({
      activeStepId: 'runs',
      activeRoute: '/runs',
    })

    await clickButton('Back')

    expect(readProductTourStateCookie()).toMatchObject({
      activeStepId: 'llm-setup',
      activeRoute: '/config?bucket=registry&item=llms',
    })
  })

  it('renders bottom-right step copy for missing anchors', async () => {
    await renderTour({ path: '/runs' })

    await clickButton('Start tour')

    expect(dialog()).not.toBeNull()
    expect(dialog()?.getAttribute('aria-modal')).toBe('false')
    expectDialogBottomRight()
    expect(textContent()).toContain('Configure your LLM first')
    expect(textContent()).not.toContain('This area is not available yet')
  })

  it('re-measures when a routed anchor appears after loading', async () => {
    await renderTour({ path: '/runs', children: <DeferredRunsAnchor /> })

    await clickButton('Start tour')
    await clickButton('Next')

    expect(textContent()).toContain('Runs show outcomes')
    expect(textContent()).not.toContain('This area is not available yet')

    await clickElement('[data-testid="show-runs-anchor"]')
    await flushAsyncWork()
    await act(async () => {
      vi.runOnlyPendingTimers()
      vi.advanceTimersByTime(32)
    })
    await flushAsyncWork()

    expect(textContent()).toContain('Runs show outcomes')
    expect(textContent()).not.toContain('This area is not available yet')
    expectDialogBottomRight()

    const highlight = productTourHighlight()

    expect(highlight).not.toBeNull()
    expect(highlight?.className).toContain('rounded-[2px]')
    expect(highlight?.className).toContain('animate-product-tour-highlight-pulse')
    expect(highlight?.className).toContain('border-primary/80')
    expect(highlight?.style.top).toBe('60px')
    expect(highlight?.style.left).toBe('80px')
    expect(highlight?.style.width).toBe('160px')
    expect(highlight?.style.height).toBe('44px')
  })

  it('keeps step copy for zero-size and hidden anchors', async () => {
    await renderTour({
      path: '/runs',
      children: <div data-tour-id="tour-runs-table" style={{ display: 'none' }} />,
    })

    await clickButton('Start tour')
    await clickButton('Next')

    expect(textContent()).toContain('Runs show outcomes')
    expect(textContent()).not.toContain('This area is not available yet')
    expect(productTourHighlight()).toBeNull()

    cleanupRoot()
    clearTourCookie()

    await renderTour({
      path: '/runs',
      children: <div data-tour-id="tour-runs-table" />,
    })

    await clickButton('Start tour')
    await clickButton('Next')

    expect(textContent()).toContain('Runs show outcomes')
    expect(textContent()).not.toContain('This area is not available yet')
    expect(productTourHighlight()).toBeNull()
  })

  it('never renders cookie route or step values as visible card copy', async () => {
    writeProductTourStateCookie(
      validState({
        lastStartedAt: fixedNow.toISOString(),
        activeStepId: 'runs',
        activeRoute: '/cookie-secret-route',
      }),
    )

    await renderTour({
      path: '/runs',
      children: (
        <div ref={makeMeasurableAnchor} data-tour-id="tour-test-detail-overview">
          Test detail
        </div>
      ),
    })

    expect(textContent()).not.toContain('/cookie-secret-route')
    expect(textContent()).not.toContain('activeStepId')
  })

  it('resolves the generated example test and navigates to its detail route', async () => {
    appHarness.fetchTestFiles.mockResolvedValue({
      files: [
        {
          path: 'tests/example-pass.yaml',
          name: 'Example passing test',
          testId: 'example-generated-id',
          targetName: null,
          platform: 'web',
          modified: '2026-05-24T16:00:00.000Z',
        },
      ],
    })

    await renderTour({
      path: '/runs',
      children: (
        <div>
          <div ref={makeMeasurableAnchor} data-tour-id="tour-tests-table">
            Tests table
          </div>
          <div ref={makeMeasurableAnchor} data-tour-id="tour-test-detail-overview">
            Test detail
          </div>
        </div>
      ),
    })
    await clickButton('Start tour')
    await clickButton('Next')
    await clickButton('Next')
    await clickButton('Next')
    await clickButton('Next')
    await clickButton('Next')
    await clickButton('Next')
    await clickButton('Next')
    await act(async () => {
      vi.runOnlyPendingTimers()
    })
    await flushAsyncWork()

    expect(container?.querySelector('[data-testid="location"]')?.textContent).toBe(
      '/test/example-generated-id',
    )
    expect(container?.querySelector('[data-testid="active-step"]')?.textContent).toBe(
      'example-test',
    )
    expect(dialog()?.textContent ?? '').toContain('safest first run')
    expect(dialog()?.textContent ?? '').not.toContain('example-generated-id')
    expect(document.cookie).not.toContain('example-generated-id')
  })

  it('highlights the example detail and primary Run action anchors', async () => {
    appHarness.fetchTestFiles.mockResolvedValue({
      files: [
        {
          path: 'tests/example-pass.yaml',
          name: 'Example passing test',
          testId: 'example-generated-id',
          targetName: null,
          platform: 'web',
          modified: '2026-05-24T16:00:00.000Z',
        },
      ],
    })

    await renderTour({
      path: '/runs',
      children: (
        <div>
          <div ref={makeMeasurableAnchor} data-tour-id="tour-test-detail-overview">
            Example test detail
          </div>
          <div ref={makeMeasurableAnchor} data-tour-id="tour-test-run-action">
            Run control
          </div>
        </div>
      ),
    })

    await advanceTourUntilStep('example-test')
    await act(async () => {
      vi.runOnlyPendingTimers()
    })
    await flushAsyncWork()

    expect(container?.querySelector('[data-testid="location"]')?.textContent).toBe(
      '/test/example-generated-id',
    )
    expect(dialog()?.textContent ?? '').toContain('safest first run')
    expect(productTourHighlight()).not.toBeNull()

    await clickButton('Next')
    await act(async () => {
      vi.runOnlyPendingTimers()
    })
    await flushAsyncWork()

    expect(container?.querySelector('[data-testid="active-step"]')?.textContent).toBe('run-action')
    expect(dialog()?.textContent ?? '').toContain('Click Run when you are ready')
    expect(productTourHighlight()).not.toBeNull()
    expect(document.cookie).not.toContain('example-generated-id')
  })

  it('advances from a user-started run to live mode without persisting the dynamic run id', async () => {
    appHarness.fetchTestFiles.mockResolvedValue({
      files: [
        {
          path: 'tests/example-pass.yaml',
          name: 'Example passing test',
          testId: 'example-generated-id',
          targetName: null,
          platform: 'web',
          modified: '2026-05-24T16:00:00.000Z',
        },
      ],
    })

    await renderTour({
      path: '/runs',
      children: (
        <div>
          <div ref={makeMeasurableAnchor} data-tour-id="tour-test-run-action">
            Run control
          </div>
          <div ref={makeMeasurableAnchor} data-tour-id="tour-live-run-status">
            Live run status
          </div>
        </div>
      ),
    })

    await advanceTourUntilStep('run-action')

    await clickElement('[data-testid="advance-run-started"]')
    await act(async () => {
      vi.runOnlyPendingTimers()
    })
    await flushAsyncWork()

    expect(container?.querySelector('[data-testid="location"]')?.textContent).toBe(
      '/runs/run-generated-pass/live',
    )
    expect(container?.querySelector('[data-testid="active-step"]')?.textContent).toBe('live-run')
    expect(dialog()?.textContent ?? '').toContain('Watch the run live')
    expect(productTourHighlight()).not.toBeNull()
    expect(document.cookie).not.toContain('run-generated-pass')
  })

  it('continues from live mode to the run detail route using the returned run id', async () => {
    appHarness.fetchTestFiles.mockResolvedValue({
      files: [
        {
          path: 'tests/example-pass.yaml',
          name: 'Example passing test',
          testId: 'example-generated-id',
          targetName: null,
          platform: 'web',
          modified: '2026-05-24T16:00:00.000Z',
        },
      ],
    })

    await renderTour({
      path: '/runs',
      children: (
        <div>
          <div ref={makeMeasurableAnchor} data-tour-id="tour-test-run-action">
            Run control
          </div>
          <div ref={makeMeasurableAnchor} data-tour-id="tour-live-run-status">
            Live run status
          </div>
          <div ref={makeMeasurableAnchor} data-tour-id="tour-run-detail-reasoning">
            Run detail reasoning
          </div>
        </div>
      ),
    })

    await advanceTourUntilStep('run-action')
    await clickElement('[data-testid="advance-run-started"]')
    await clickButton('Next')

    expect(container?.querySelector('[data-testid="location"]')?.textContent).toBe(
      '/runs/run-generated-pass',
    )
    expect(container?.querySelector('[data-testid="active-step"]')?.textContent).toBe(
      'run-detail',
    )
    expect(dialog()?.textContent ?? '').toContain('observed, planned, executed, and verified')
    expect(productTourHighlight()).not.toBeNull()
    expect(document.cookie).not.toContain('run-generated-pass')
  })

  it('keeps the GitHub nudge hidden before run detail records a successful value moment', async () => {
    appHarness.fetchTestFiles.mockResolvedValue({
      files: [
        {
          path: 'tests/example-pass.yaml',
          name: 'Example passing test',
          testId: 'example-generated-id',
          targetName: null,
          platform: 'web',
          modified: '2026-05-24T16:00:00.000Z',
        },
      ],
    })

    await renderTour({
      path: '/runs',
      children: (
        <div>
          <div ref={makeMeasurableAnchor} data-tour-id="tour-test-run-action">
            Run control
          </div>
          <div ref={makeMeasurableAnchor} data-tour-id="tour-live-run-status">
            Live run status
          </div>
          <div ref={makeMeasurableAnchor} data-tour-id="tour-run-detail-reasoning">
            Run detail reasoning
          </div>
        </div>
      ),
    })

    await advanceTourToRunDetail()

    expect(textContent()).not.toContain('If agent-qa helped')
    expect(githubNudgeLink()).toBeUndefined()

    await clickButton('Done')

    expectNoDialog()
    expect(readProductTourStateCookie()?.completedAt).toBe(fixedNow.toISOString())
  })

  it('keeps run detail status recording idempotent for context-object consumers', async () => {
    await renderTour({
      path: '/runs/r_loop?step=0',
      children: <RunDetailStatusRecorder status="passed" />,
    })

    await flushAsyncWork()

    const renderCount = Number(
      container
        ?.querySelector('[data-testid="run-detail-status-render-count"]')
        ?.textContent ?? '0',
    )

    expect(renderCount).toBeGreaterThan(0)
    expect(renderCount).toBeLessThanOrEqual(3)
  })

  it.each([
    ['passed', 'record-run-detail-passed'],
    ['healed', 'record-run-detail-healed'],
  ])('shows the modest GitHub nudge after a %s run detail value moment', async (_status, buttonId) => {
    appHarness.fetchTestFiles.mockResolvedValue({
      files: [
        {
          path: 'tests/example-pass.yaml',
          name: 'Example passing test',
          testId: 'example-generated-id',
          targetName: null,
          platform: 'web',
          modified: '2026-05-24T16:00:00.000Z',
        },
      ],
    })

    await renderTour({
      path: '/runs',
      children: (
        <div>
          <div ref={makeMeasurableAnchor} data-tour-id="tour-test-run-action">
            Run control
          </div>
          <div ref={makeMeasurableAnchor} data-tour-id="tour-live-run-status">
            Live run status
          </div>
          <div ref={makeMeasurableAnchor} data-tour-id="tour-run-detail-reasoning">
            Run detail reasoning
          </div>
        </div>
      ),
    })

    await advanceTourToRunDetail()
    await clickElement(`[data-testid="${buttonId}"]`)
    await clickButton('Next')

    const link = githubNudgeLink()

    expect(container?.querySelector('[data-testid="active-step"]')?.textContent).toBe(
      'github-nudge',
    )
    expect(dialog()?.getAttribute('aria-modal')).toBe('false')
    expectDialogBottomRight()
    expect(dialog()?.textContent ?? '').toContain('If agent-qa helped')
    expect(dialog()?.textContent ?? '').toContain(
      'If agent-qa helped, consider starring it on GitHub.',
    )
    expect(link?.getAttribute('href')).toBe('https://github.com/vostride/agent-qa')
    expect(link?.getAttribute('href')).not.toContain('?')
    expect(document.cookie).not.toContain('run-generated-pass')
    expectNoPrivateTourCopy(textContent())
  })

  it.each([
    ['failed', 'record-run-detail-failed'],
    ['cancelled', 'record-run-detail-cancelled'],
    ['flaky', 'record-run-detail-flaky'],
    ['unknown', 'record-run-detail-unknown'],
  ])('skips the GitHub nudge after a %s run detail status', async (_status, buttonId) => {
    appHarness.fetchTestFiles.mockResolvedValue({
      files: [
        {
          path: 'tests/example-pass.yaml',
          name: 'Example passing test',
          testId: 'example-generated-id',
          targetName: null,
          platform: 'web',
          modified: '2026-05-24T16:00:00.000Z',
        },
      ],
    })

    await renderTour({
      path: '/runs',
      children: (
        <div>
          <div ref={makeMeasurableAnchor} data-tour-id="tour-test-run-action">
            Run control
          </div>
          <div ref={makeMeasurableAnchor} data-tour-id="tour-live-run-status">
            Live run status
          </div>
          <div ref={makeMeasurableAnchor} data-tour-id="tour-run-detail-reasoning">
            Run detail reasoning
          </div>
        </div>
      ),
    })

    await advanceTourToRunDetail()
    await clickElement(`[data-testid="${buttonId}"]`)
    await clickButton('Done')

    expectNoDialog()
    expect(readProductTourStateCookie()?.completedAt).toBe(fixedNow.toISOString())
    expect(githubNudgeLink()).toBeUndefined()
  })

  it('falls back to Runs guidance when a started run id is unavailable', async () => {
    appHarness.fetchTestFiles.mockResolvedValue({
      files: [
        {
          path: 'tests/example-pass.yaml',
          name: 'Example passing test',
          testId: 'example-generated-id',
          targetName: null,
          platform: 'web',
          modified: '2026-05-24T16:00:00.000Z',
        },
      ],
    })

    await renderTour({
      path: '/runs',
      children: (
        <div>
          <div ref={makeMeasurableAnchor} data-tour-id="tour-test-run-action">
            Run control
          </div>
          <div ref={makeMeasurableAnchor} data-tour-id="tour-runs-table">
            Runs table
          </div>
        </div>
      ),
    })

    await advanceTourUntilStep('run-action')
    await clickElement('[data-testid="advance-run-started-without-id"]')

    expect(container?.querySelector('[data-testid="location"]')?.textContent).toBe('/runs')
    expect(container?.querySelector('[data-testid="active-step"]')?.textContent).toBe(
      'runs-fallback',
    )
    expect(dialog()?.textContent ?? '').toContain('open the latest execution')
  })

  it('falls back to Tests guidance when the generated example cannot be found', async () => {
    appHarness.fetchTestFiles.mockResolvedValue({ files: [] })

    await renderTour({
      path: '/runs',
      children: (
        <div ref={makeMeasurableAnchor} data-tour-id="tour-tests-table">
          Tests table
        </div>
      ),
    })
    await clickButton('Start tour')
    await clickButton('Next')
    await clickButton('Next')
    await clickButton('Next')
    await clickButton('Next')
    await clickButton('Next')
    await clickButton('Next')
    await clickButton('Next')
    await act(async () => {
      vi.runOnlyPendingTimers()
    })
    await flushAsyncWork()

    expect(container?.querySelector('[data-testid="location"]')?.textContent).toBe('/tests')
    expect(container?.querySelector('[data-testid="active-step"]')?.textContent).toBe(
      'example-missing',
    )
    expect(dialog()?.textContent ?? '').toContain(
      'agent-qa init normally creates Example passing test',
    )
  })

  it('fetches tests only for active tours and handles lookup failure silently', async () => {
    appHarness.fetchTestFiles.mockRejectedValue(new Error('lookup failed'))

    await renderTour({ path: '/runs' })

    expect(appHarness.fetchTestFiles).toHaveBeenCalledTimes(1)
    expect(textContent()).toContain('Welcome to agent-qa')

    cleanupRoot()
    clearTourCookie()
    appHarness.fetchTestFiles.mockClear()

    await renderTour({ path: '/runs/r_123/live' })

    expect(appHarness.fetchTestFiles).not.toHaveBeenCalled()
    expectNoDialog()
  })
})
