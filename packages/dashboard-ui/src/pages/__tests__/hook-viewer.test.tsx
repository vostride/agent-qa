// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import HookViewerPage from '@/pages/hook-viewer'
import { useKeyboardShortcuts } from '@/hooks/use-keyboard-shortcuts'

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

let latestMonacoProps: Record<string, unknown> | null = null

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {
    status: number
    payload: Record<string, unknown> | null

    constructor(status: number, message: string, payload: Record<string, unknown> | null = null) {
      super(message)
      this.status = status
      this.payload = payload
    }
  },
  fetchHookDetail: fetchHookDetailMock,
  fetchVariables: fetchVariablesMock,
  runHook: runHookMock,
  deleteHook: deleteHookMock,
}))

vi.mock('@/hooks/use-page-title', () => ({ usePageTitle: () => {} }))
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }))
vi.mock('@/hooks/use-keyboard-shortcuts', () => ({ useKeyboardShortcuts: vi.fn() }))
vi.mock('@/components/page-skeleton', () => ({ EditorSkeleton: () => <div data-testid="skeleton" /> }))
vi.mock('@/components/empty-state', () => ({
  EmptyState: ({ title, description }: { title: string; description: string }) => (
    <div>
      <div>{title}</div>
      <div>{description}</div>
    </div>
  ),
}))
vi.mock('@/components/monaco-editor', () => ({
  MonacoEditor: (props: Record<string, unknown>) => {
    latestMonacoProps = props
    return <div data-testid="monaco-editor">{String(props.language)}</div>
  },
}))
vi.mock('@/components/hook-delete-dialog', () => ({
  HookDeleteDialog: ({
    open,
    blockedReferences,
    deleteError,
    onDelete,
    onForceDelete,
  }: {
    open: boolean
    blockedReferences: Array<{ label: string; path: string }>
    deleteError: string | null
    onDelete: () => void
    onForceDelete: () => void
  }) => (
    open ? (
      <div data-testid="hook-delete-dialog">
        <div>{blockedReferences.length > 0 ? 'Hook is still in use' : 'Delete hook?'}</div>
        {deleteError ? <div>{deleteError}</div> : null}
        {blockedReferences.map((reference) => (
          <div key={reference.path}>{reference.label} {reference.path}</div>
        ))}
        <button type="button" onClick={blockedReferences.length > 0 ? onForceDelete : onDelete}>
          {blockedReferences.length > 0 ? 'Force Delete' : 'Delete Hook'}
        </button>
      </div>
    ) : null
  ),
}))
vi.mock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => <div data-testid="resizable-group">{children}</div>,
  ResizablePanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => <div data-testid="resizable-handle" />,
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

describe('HookViewerPage', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    latestMonacoProps = null
    vi.mocked(useKeyboardShortcuts).mockReset()
    fetchHookDetailMock.mockReset()
    fetchVariablesMock.mockReset()
    runHookMock.mockReset()
    deleteHookMock.mockReset()

    fetchHookDetailMock.mockResolvedValue({
      hook: {
        id: 'h_alpha',
        name: 'Login Hook',
        runtime: 'bun',
        file: './hooks/login.ts',
        timeout: 45000,
        network: false,
        fileMissing: false,
      },
      source: 'export default async function hook() {}\n',
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
      variables: { TOKEN: 'abc' },
      sandbox: {
        runtime: 'bun',
        image: 'vostride/agent-qa-hook-runner-bun',
        networkMode: 'disabled',
      },
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
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
      root.render(
        <MemoryRouter initialEntries={[url]}>
          <LocationProbe />
          <Routes>
            <Route path="/hook/:id" element={<HookViewerPage />} />
            <Route path="/hook/:id/edit" element={<div data-testid="hook-edit-route">edit route</div>} />
          </Routes>
        </MemoryRouter>,
      )
    })

    await flushRender()
  }

  function latestShortcuts() {
    return vi.mocked(useKeyboardShortcuts).mock.calls.at(-1)?.[0] as Record<string, (event?: KeyboardEvent) => void>
  }

  function currentLocation() {
    return container.querySelector('[data-testid="location"]')
  }

  it('renders the compact workstation layout, a single run action, and the shared delete control', async () => {
    fetchHookDetailMock.mockResolvedValueOnce({
      hook: {
        id: 'h_alpha',
        name: 'Login Hook',
        runtime: 'bun',
        file: './hooks/login.ts',
        timeout: 45000,
        network: false,
        fileMissing: true,
      },
      source: 'export default async function hook() {}\n',
      fieldErrors: [
        {
          field: 'file',
          code: 'file_missing',
          message: 'Hook file missing',
        },
      ],
    })

    await renderAt('/hook/h_alpha')

    expect(currentLocation()?.getAttribute('data-search')).toBe('')
    expect(container.textContent).toContain('Source')
    expect(container.textContent).toContain('Input')
    expect(container.textContent).toContain('Run logs')
    expect(container.textContent).toContain('Hook file missing')
    expect(container.textContent).toContain('Hook ID')
    expect(container.textContent).toContain('Health')
    expect(container.textContent).toContain('File')
    expect(container.textContent).toContain('Runtime')
    expect(container.textContent).toContain('Timeout')
    expect(container.textContent).toContain('Network')
    expect(container.textContent).toContain('./hooks/login.ts')
    expect(container.textContent).toContain('Bun')
    expect(container.textContent).not.toContain('TypeScript')
    expect(container.textContent).toContain('Edit')
    expect(container.textContent).toContain('Delete')
    expect(Array.from(container.querySelectorAll('button')).filter((button) => button.textContent?.includes('Run Hook'))).toHaveLength(1)
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent?.includes('h_alpha'))).toBe(false)
    expect(container.querySelector('button[aria-label="Shortcuts"]')).not.toBeNull()
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent === 'Overview')).toBe(false)
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent === 'Source')).toBe(false)
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent === 'Run')).toBe(false)
    expect(container.textContent).not.toContain('Authoring Notes')
  })

  it('renders Bun source with TypeScript Monaco mode and registers workstation shortcuts without obsolete tab bindings', async () => {
    await renderAt('/hook/h_alpha')

    const shortcuts = latestShortcuts()
    expect(shortcuts).toMatchObject({
      e: expect.any(Function),
      r: expect.any(Function),
      'shift+?': expect.any(Function),
    })
    expect(shortcuts['1']).toBeUndefined()
    expect(shortcuts['2']).toBeUndefined()
    expect(shortcuts['3']).toBeUndefined()
    expect(currentLocation()?.getAttribute('data-search')).toBe('')
    expect(container.querySelector('[data-testid="monaco-editor"]')).not.toBeNull()
    expect(latestMonacoProps?.language).toBe('typescript')
    expect(latestMonacoProps?.readOnly).toBe(true)
  })

  it('routes the shared Run shortcut into the unified workstation and submits the same workbench flow', async () => {
    await renderAt('/hook/h_alpha')

    act(() => {
      latestShortcuts().r(new KeyboardEvent('keydown', { key: 'r' }))
    })
    await flushRender()

    expect(currentLocation()?.getAttribute('data-pathname')).toBe('/hook/h_alpha')
    expect(currentLocation()?.getAttribute('data-search')).toBe('')
    expect(runHookMock).toHaveBeenCalledWith('h_alpha', { overrides: [] })
    expect(container.textContent).toContain('Run logs')
  })

  it('uses the edit shortcut to navigate to /hook/:id/edit', async () => {
    await renderAt('/hook/h_alpha')

    act(() => {
      latestShortcuts().e(new KeyboardEvent('keydown', { key: 'e' }))
    })
    await flushRender()

    expect(currentLocation()?.getAttribute('data-pathname')).toBe('/hook/h_alpha/edit')
    expect(container.querySelector('[data-testid="hook-edit-route"]')).not.toBeNull()
  })

  it('opens the navbar delete flow on the view page and deletes through the shared modal', async () => {
    deleteHookMock.mockResolvedValueOnce({ deleted: true, references: [] })

    await renderAt('/hook/h_alpha')

    await act(async () => {
      Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Delete')?.click()
      await Promise.resolve()
    })

    expect(container.querySelector('[data-testid="hook-delete-dialog"]')).not.toBeNull()

    await act(async () => {
      Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Delete Hook')?.click()
      await Promise.resolve()
    })

    expect(deleteHookMock).toHaveBeenCalledWith('h_alpha', { force: false })
    expect(currentLocation()?.getAttribute('data-pathname')).toBe('/hooks')
  })
})
