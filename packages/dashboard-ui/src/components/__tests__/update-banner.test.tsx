// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  UPDATE_BANNER_DISMISS_COOKIE,
  UpdateBanner,
  isUpdateBannerDismissed,
} from '@/components/update-banner'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const apiMock = vi.hoisted(() => ({
  fetchAppMetadata: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  fetchAppMetadata: apiMock.fetchAppMetadata,
}))

vi.mock('@/lib/analytics', () => ({
  trackDashboardOpenedOnce: vi.fn(),
}))

vi.mock('@/pages/runs', () => ({ default: () => <div data-testid="runs-page">Runs Page</div> }))
vi.mock('@/pages/run-detail', () => ({
  default: () => <div data-testid="run-detail-page">Run Detail Page</div>,
}))
vi.mock('@/pages/live-run', () => ({
  default: () => <div data-testid="live-run-page">Live Run Page</div>,
}))
vi.mock('@/pages/tests', () => ({ default: () => <div data-testid="tests-page">Tests Page</div> }))
vi.mock('@/pages/hooks', () => ({ default: () => <div data-testid="hooks-page">Hooks Page</div> }))
vi.mock('@/pages/hook-editor', () => ({
  default: () => <div data-testid="hook-editor-page">Hook Editor Page</div>,
}))
vi.mock('@/pages/hook-viewer', () => ({
  default: () => <div data-testid="hook-viewer-page">Hook Viewer Page</div>,
}))
vi.mock('@/pages/test-editor', () => ({
  default: () => <div data-testid="test-editor-page">Test Editor Page</div>,
}))
vi.mock('@/pages/test-viewer', () => ({
  default: () => <div data-testid="test-viewer-page">Test Viewer Page</div>,
}))
vi.mock('@/pages/insights', () => ({
  default: () => <div data-testid="insights-page">Insights Page</div>,
}))
vi.mock('@/pages/config', () => ({ default: () => <div data-testid="config-page">Config Page</div> }))
vi.mock('@/pages/suites', () => ({
  default: () => <div data-testid="suites-page">Suites Page</div>,
}))
vi.mock('@/pages/suite-editor', () => ({
  default: () => <div data-testid="suite-editor-page">Suite Editor Page</div>,
}))
vi.mock('@/pages/suite-viewer', () => ({
  default: () => <div data-testid="suite-viewer-page">Suite Viewer Page</div>,
}))
vi.mock('@/pages/memory', () => ({
  default: () => <div data-testid="memory-page">Memory Page</div>,
}))
vi.mock('@/pages/memory-product', () => ({
  default: () => <div data-testid="memory-product-page">Memory Product Page</div>,
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
  AppSidebar: () => <div data-testid="app-sidebar" />,
}))
vi.mock('@/components/ui/sonner', () => ({
  Toaster: () => <div data-testid="toaster" />,
}))
vi.mock('@/components/command-palette', () => ({
  CommandPalette: () => <div data-testid="command-palette" />,
}))
vi.mock('@/components/product-tour', () => ({
  ProductTourProvider: ({
    children,
    pathname,
    hideHeader,
  }: {
    children: ReactNode
    pathname: string
    hideHeader: boolean
  }) => (
    <section
      data-testid="product-tour-provider"
      data-pathname={pathname}
      data-hide-header={String(hideHeader)}
    >
      {children}
    </section>
  ),
  ProductTourOverlay: () => <div data-testid="product-tour-overlay" />,
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

const updateMetadata = {
  version: '0.1.18',
  update: { latestVersion: '0.1.19' },
}

const eligibleRoutes = [
  ['/runs', 'runs-page'],
  ['/tests', 'tests-page'],
  ['/hooks', 'hooks-page'],
  ['/suites', 'suites-page'],
  ['/memory', 'memory-page'],
  ['/config', 'config-page'],
] as const

const excludedRoutes = [
  '/insights',
  '/tests/new',
  '/test/abc',
  '/test/abc/edit',
  '/runs/r_1',
  '/runs/r_1/live',
  '/hooks/new',
  '/hook/h_1',
  '/hook/h_1/edit',
  '/suites/new',
  '/suite/s_1',
  '/suite/s_1/edit',
  '/memory/product-1',
] as const

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  vi.resetModules()
  apiMock.fetchAppMetadata.mockReset()
  clearUpdateCookie()
})

afterEach(() => {
  cleanupRoot()
  clearUpdateCookie()
})

function clearUpdateCookie() {
  document.cookie = `${UPDATE_BANNER_DISMISS_COOKIE}=; path=/; max-age=0`
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

async function flushAsyncWork() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function renderNode(node: ReactNode) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)

  await act(async () => {
    root?.render(node)
  })
}

async function renderAppAt(path: string) {
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

function queryText(text: string): Element | null {
  return Array.from(container?.querySelectorAll('*') ?? []).find(
    (node) => node.textContent?.trim() === text,
  ) ?? null
}

function getReleasesLink(): HTMLAnchorElement {
  const link = Array.from(container?.querySelectorAll('a') ?? []).find(
    (anchor) => anchor.textContent?.trim() === 'View releases',
  )
  expect(link).toBeDefined()
  return link as HTMLAnchorElement
}

describe('UpdateBanner', () => {
  it('renders exact update copy, releases link, and dismiss control', async () => {
    const onDismiss = vi.fn()

    await renderNode(
      <UpdateBanner installedVersion="0.1.18" latestVersion="0.1.19" onDismiss={onDismiss} />,
    )

    expect(queryText('Update available')).not.toBeNull()
    expect(
      queryText('agent-qa v0.1.19 is available. You are using v0.1.18.'),
    ).not.toBeNull()

    const link = getReleasesLink()
    expect(link.getAttribute('href')).toBe('https://github.com/vostride/agent-qa/releases')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')

    const dismiss = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Dismiss update notice"]',
    )
    expect(dismiss).not.toBeNull()
  })

  it('contains no install guidance, npm link, product misbranding, or local debug copy', async () => {
    await renderNode(
      <UpdateBanner installedVersion="0.1.18" latestVersion="0.1.19" onDismiss={() => {}} />,
    )

    const link = getReleasesLink()
    const rendered = `${container?.textContent ?? ''} ${link.getAttribute('href') ?? ''}`
    const forbiddenCopy = [
      'npmjs.com',
      'npm install',
      'pnpm add',
      'yarn add',
      'bun add',
      'global',
      'local config',
      'test content',
      'memory',
      'logs',
      'credentials',
      'workspace path',
      'AgentQA',
    ]

    for (const forbidden of forbiddenCopy) {
      expect(rendered).not.toContain(forbidden)
    }
  })

  it('invokes onDismiss once when the dismiss button is clicked', async () => {
    const onDismiss = vi.fn()
    await renderNode(
      <UpdateBanner installedVersion="0.1.18" latestVersion="0.1.19" onDismiss={onDismiss} />,
    )

    container
      ?.querySelector<HTMLButtonElement>('button[aria-label="Dismiss update notice"]')
      ?.click()

    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})

describe('isUpdateBannerDismissed', () => {
  const now = Date.parse('2026-05-24T10:00:00.000Z')

  it('returns true only for the same latestVersion dismissed less than 24 hours ago', () => {
    expect(
      isUpdateBannerDismissed(
        {
          latestVersion: '0.1.19',
          dismissedAt: new Date(now - 60 * 60 * 1000).toISOString(),
        },
        '0.1.19',
        now,
      ),
    ).toBe(true)

    expect(
      isUpdateBannerDismissed(
        {
          latestVersion: '0.1.19',
          dismissedAt: new Date(now - 25 * 60 * 60 * 1000).toISOString(),
        },
        '0.1.19',
        now,
      ),
    ).toBe(false)

    expect(
      isUpdateBannerDismissed(
        { latestVersion: '0.1.19', dismissedAt: 'not-a-date' },
        '0.1.19',
        now,
      ),
    ).toBe(false)

    expect(isUpdateBannerDismissed(null, '0.1.19', now)).toBe(false)

    expect(
      isUpdateBannerDismissed(
        {
          latestVersion: '0.1.19',
          dismissedAt: new Date(now - 60 * 60 * 1000).toISOString(),
        },
        '0.1.20',
        now,
      ),
    ).toBe(false)
  })
})

describe('app shell update banner route gate', () => {
  it('mounts the product tour provider around shell content and passes route state', async () => {
    apiMock.fetchAppMetadata.mockResolvedValue(updateMetadata)

    await renderAppAt('/runs')

    const provider = container?.querySelector('[data-testid="product-tour-provider"]')
    expect(provider).not.toBeNull()
    expect(provider?.getAttribute('data-pathname')).toBe('/runs')
    expect(provider?.getAttribute('data-hide-header')).toBe('false')
    expect(
      Array.from(provider?.children ?? []).map((element) =>
        element.getAttribute('data-testid'),
      ),
    ).toEqual(['app-sidebar', 'sidebar-inset', 'product-tour-overlay', 'command-palette'])

    cleanupRoot()
    vi.resetModules()
    apiMock.fetchAppMetadata.mockResolvedValue(updateMetadata)

    await renderAppAt('/tests/new')

    const editorProvider = container?.querySelector('[data-testid="product-tour-provider"]')
    expect(editorProvider?.getAttribute('data-pathname')).toBe('/tests/new')
    expect(editorProvider?.getAttribute('data-hide-header')).toBe('true')
  })

  it.each(eligibleRoutes)('renders the update banner on %s', async (path, pageTestId) => {
    apiMock.fetchAppMetadata.mockResolvedValue(updateMetadata)

    await renderAppAt(path)

    expect(container?.querySelector(`[data-testid="${pageTestId}"]`)).not.toBeNull()
    expect(queryText('Update available')).not.toBeNull()
    expect(getReleasesLink().getAttribute('href')).toBe(
      'https://github.com/vostride/agent-qa/releases',
    )
  })

  it.each(excludedRoutes)('renders no update banner on %s', async (path) => {
    apiMock.fetchAppMetadata.mockResolvedValue(updateMetadata)

    await renderAppAt(path)

    expect(queryText('Update available')).toBeNull()
  })

  it('renders route content immediately before app metadata resolves', async () => {
    apiMock.fetchAppMetadata.mockReturnValue(new Promise(() => {}))

    await renderAppAt('/runs')

    expect(container?.querySelector('[data-testid="runs-page"]')).not.toBeNull()
    expect(queryText('Update available')).toBeNull()
  })

  it('renders no banner when app metadata rejects or has no update details', async () => {
    apiMock.fetchAppMetadata.mockRejectedValueOnce(new Error('metadata unavailable'))

    await renderAppAt('/runs')

    expect(container?.querySelector('[data-testid="runs-page"]')).not.toBeNull()
    expect(queryText('Update available')).toBeNull()

    cleanupRoot()
    vi.resetModules()
    apiMock.fetchAppMetadata.mockResolvedValueOnce({ version: '0.1.18' })

    await renderAppAt('/tests')

    expect(container?.querySelector('[data-testid="tests-page"]')).not.toBeNull()
    expect(queryText('Update available')).toBeNull()
  })
})
