// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import HookViewerPage from '@/pages/hook-viewer'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const {
  fetchHookDetailMock,
  fetchVariablesMock,
  runHookMock,
  deleteHookMock,
} = vi.hoisted(() => ({
  fetchHookDetailMock: vi.fn(),
  fetchVariablesMock: vi.fn(),
  runHookMock: vi.fn(),
  deleteHookMock: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {
    status: number

    constructor(status: number, message: string) {
      super(message)
      this.status = status
    }
  },
  fetchHookDetail: fetchHookDetailMock,
  fetchVariables: fetchVariablesMock,
  runHook: runHookMock,
  deleteHook: deleteHookMock,
}))

vi.mock('@/hooks/use-page-title', () => ({ usePageTitle: () => {} }))
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }))
vi.mock('@/hooks/use-keyboard-shortcuts', () => ({ useKeyboardShortcuts: () => {} }))
vi.mock('@/components/page-skeleton', () => ({ EditorSkeleton: () => <div>Loading...</div> }))
vi.mock('@/components/empty-state', () => ({
  EmptyState: ({ title }: { title: string }) => <div>{title}</div>,
}))
vi.mock('@/components/monaco-editor', () => ({
  MonacoEditor: ({ value }: { value: string }) => <div data-testid="monaco-editor">{value}</div>,
}))
vi.mock('@/components/hook-delete-dialog', () => ({
  HookDeleteDialog: () => null,
}))
vi.mock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => <div />,
}))
vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ScrollBar: () => null,
}))
vi.mock('@/components/ui/tabs', async () => {
  const React = await import('react')

  const TabsContext = React.createContext<{ value: string; onValueChange?: (value: string) => void } | null>(null)

  function Tabs({
    value,
    defaultValue,
    onValueChange,
    children,
  }: {
    value?: string
    defaultValue?: string
    onValueChange?: (value: string) => void
    children: ReactNode
  }) {
    const [internalValue, setInternalValue] = React.useState(defaultValue ?? '')
    const resolvedValue = value ?? internalValue

    return (
      <TabsContext.Provider
        value={{
          value: resolvedValue,
          onValueChange: onValueChange ?? setInternalValue,
        }}
      >
        <div data-tabs-value={resolvedValue}>{children}</div>
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
      <button type="button" onClick={() => ctx?.onValueChange?.(value)}>
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

describe('HookViewerPage URL state contract', () => {
  let container: HTMLDivElement | null = null
  let root: Root | null = null

  beforeEach(() => {
    fetchHookDetailMock.mockReset()
    fetchVariablesMock.mockReset()
    runHookMock.mockReset()
    deleteHookMock.mockReset()

    fetchHookDetailMock.mockResolvedValue({
      hook: {
        id: 'h_alpha',
        name: 'Login Hook',
        runtime: 'node',
        file: './hooks/login.js',
        timeout: 30000,
        network: true,
        fileMissing: false,
      },
      source: 'module.exports = async function hook() {}\n',
      fieldErrors: [],
    })
    fetchVariablesMock.mockResolvedValue({
      variables: [{ key: 'BASE_URL', value: 'https://example.com' }],
      filePath: '.env',
    })
    runHookMock.mockResolvedValue({
      success: true,
      status: 'passed',
      executedAt: '2026-04-22T20:30:00.000Z',
      duration: 3210,
      output: 'done',
      stdout: 'done',
      stderr: '',
      error: null,
      variables: {},
      sandbox: {
        runtime: 'node',
        image: 'vostride/agent-qa-hook-runner-node',
        networkMode: 'enabled',
      },
    })
  })

  afterEach(() => {
    if (root) {
      act(() => root!.unmount())
    }
    root = null
    if (container) {
      container.remove()
    }
    container = null
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

    act(() => {
      root!.render(
        <MemoryRouter initialEntries={[url]}>
          <LocationProbe />
          <Routes>
            <Route path="/hook/:id" element={<HookViewerPage />} />
          </Routes>
        </MemoryRouter>,
      )
    })

    await flushRender()
    return container
  }

  it('keeps a plain viewer URL canonical without a legacy tab param', async () => {
    const view = await renderAt('/hook/h_alpha')

    expect(view.querySelector('[data-testid="location"]')?.getAttribute('data-pathname')).toBe('/hook/h_alpha')
    expect(view.querySelector('[data-testid="location"]')?.getAttribute('data-search')).toBe('')
  })

  it('normalizes a legacy source tab URL back to the canonical viewer route', async () => {
    const view = await renderAt('/hook/h_alpha?tab=source')

    expect(view.querySelector('[data-testid="location"]')?.getAttribute('data-pathname')).toBe('/hook/h_alpha')
    expect(view.querySelector('[data-testid="location"]')?.getAttribute('data-search')).toBe('')
    expect(view.querySelector('[data-testid="monaco-editor"]')).not.toBeNull()
  })

  it('normalizes a legacy run tab URL back to the canonical viewer route', async () => {
    const view = await renderAt('/hook/h_alpha?tab=run')

    expect(view.querySelector('[data-testid="location"]')?.getAttribute('data-pathname')).toBe('/hook/h_alpha')
    expect(view.querySelector('[data-testid="location"]')?.getAttribute('data-search')).toBe('')
    expect(view.textContent).toContain('Run logs')
  })

  it('normalizes a legacy overview tab URL back to the canonical viewer route', async () => {
    const view = await renderAt('/hook/h_alpha?tab=overview')

    expect(view.querySelector('[data-testid="location"]')?.getAttribute('data-pathname')).toBe('/hook/h_alpha')
    expect(view.querySelector('[data-testid="location"]')?.getAttribute('data-search')).toBe('')
    expect(view.textContent).toContain('Login Hook')
  })

  it('canonicalizes invalid top-level tab params back to the unified viewer route', async () => {
    const view = await renderAt('/hook/h_alpha?tab=bogus')

    expect(view.querySelector('[data-testid="location"]')?.getAttribute('data-search')).toBe('')
    expect(view.textContent).toContain('Login Hook')
  })
})
