// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/pages/runs', () => ({ default: () => <div data-testid="runs-page">runs</div> }))
vi.mock('@/pages/run-detail', () => ({ default: () => <div data-testid="run-detail-page">run detail</div> }))
vi.mock('@/pages/live-run', () => ({ default: () => <div data-testid="live-run-page">live run</div> }))
vi.mock('@/pages/tests', () => ({ default: () => <div data-testid="tests-page">tests</div> }))
vi.mock('@/pages/hooks', () => ({ default: () => <div data-testid="hooks-page">hooks</div> }))
vi.mock('@/pages/hook-viewer', () => ({ default: () => <div data-testid="hook-viewer-page">hook viewer</div> }))
vi.mock('@/pages/hook-editor', () => ({ default: () => <div data-testid="hook-editor-page">hook editor</div> }))
vi.mock('@/pages/test-editor', () => ({ default: () => <div data-testid="test-editor-page">test editor</div> }))
vi.mock('@/pages/test-viewer', () => ({ default: () => <div data-testid="test-viewer-page">test viewer</div> }))
vi.mock('@/pages/insights', () => ({ default: () => <div data-testid="insights-page">insights</div> }))
vi.mock('@/pages/config', () => ({ default: () => <div data-testid="config-page">config</div> }))
vi.mock('@/pages/suites', () => ({ default: () => <div data-testid="suites-page">suites</div> }))
vi.mock('@/pages/suite-editor', () => ({ default: () => <div data-testid="suite-editor-page">suite editor</div> }))
vi.mock('@/pages/suite-viewer', () => ({ default: () => <div data-testid="suite-viewer-page">suite viewer</div> }))

vi.mock('@/components/theme-provider', () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock('@/components/ui/sidebar', () => ({
  SidebarProvider: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarInset: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock('@/components/app-sidebar', () => ({ AppSidebar: () => <div data-testid="app-sidebar" /> }))
vi.mock('@/components/ui/sonner', () => ({ Toaster: () => <div data-testid="toaster" /> }))
vi.mock('@/components/command-palette', () => ({ CommandPalette: () => <div data-testid="command-palette" /> }))
vi.mock('@/components/error-boundary', () => ({ RouteErrorBoundary: () => <div data-testid="route-error-boundary" /> }))
vi.mock('@/components/page-skeleton', () => ({
  TableSkeleton: () => <div data-testid="table-skeleton" />,
  DetailSkeleton: () => <div data-testid="detail-skeleton" />,
  ChartSkeleton: () => <div data-testid="chart-skeleton" />,
  FormSkeleton: () => <div data-testid="form-skeleton" />,
  EditorSkeleton: () => <div data-testid="editor-skeleton" />,
}))

describe('hook routing through app.tsx', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  async function renderAt(url: string) {
    window.history.pushState({}, '', url)
    const { default: App } = await import('@/app')

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => {
      root.render(<App />)
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it('mounts HookViewerPage on /hook/:id', async () => {
    await renderAt('/hook/h_alpha')
    expect(container.querySelector('[data-testid="hook-viewer-page"]')).not.toBeNull()
  })

  it('mounts HookEditorPage on /hooks/new', async () => {
    await renderAt('/hooks/new')
    expect(container.querySelector('[data-testid="hook-editor-page"]')).not.toBeNull()
  })

  it('mounts HookEditorPage on /hook/:id/edit', async () => {
    await renderAt('/hook/h_alpha/edit')
    expect(container.querySelector('[data-testid="hook-editor-page"]')).not.toBeNull()
  })
})
