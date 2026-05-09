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
vi.mock('@/hooks/use-keyboard-shortcuts', () => ({ useKeyboardShortcuts: vi.fn() }))
vi.mock('@/components/page-skeleton', () => ({ EditorSkeleton: () => <div data-testid="skeleton" /> }))
vi.mock('@/components/empty-state', () => ({
  EmptyState: ({ title }: { title: string }) => <div>{title}</div>,
}))
vi.mock('@/components/monaco-editor', () => ({
  MonacoEditor: () => <div data-testid="monaco-editor" />,
}))
vi.mock('@/components/hook-delete-dialog', () => ({
  HookDeleteDialog: () => null,
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

describe('HookViewerPage Run tab', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
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
        timeout: 30000,
        network: true,
        fileMissing: false,
      },
      source: 'export default async function hook() {}\n',
      fieldErrors: [],
    })
    fetchVariablesMock.mockResolvedValue({
      variables: [
        { key: 'BASE_URL', value: 'https://example.com' },
        { key: 'AUTH_TOKEN', value: 'secret' },
      ],
      filePath: '.env',
    })
    runHookMock.mockResolvedValue({
      success: true,
      status: 'passed',
      executedAt: '2026-04-22T20:30:00.000Z',
      duration: 3210,
      output: 'hook complete',
      stdout: 'hook complete',
      stderr: 'warning output',
      error: null,
      variables: { TOKEN: 'abc' },
      sandbox: {
        runtime: 'bun',
        image: 'vostride/agent-qa-hook-runner-bun',
        networkMode: 'enabled',
        dockerVersion: null,
        networkLogsAvailable: false,
        networkLogs: [],
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

  function buttonsByText(label: string) {
    return Array.from(container.querySelectorAll('button')).filter((button) => button.textContent?.includes(label))
  }

  async function setInputValue(input: HTMLInputElement | undefined, value: string) {
    await act(async () => {
      if (!input) return
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      valueSetter?.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
    })
  }

  it('loads the workspace env baseline summary and supports runtime-variable rows with conflict treatment', async () => {
    await renderAt('/hook/h_alpha')

    expect(container.textContent).toContain('2 variables available from .env')
    expect(container.textContent).toContain('Workspace env')
    expect(container.textContent).toContain('Runtime variables')
    expect(container.textContent).toContain('Input')
    expect(container.textContent).toContain('Run logs')
    expect(container.textContent).toContain(
      'Variables added for this run only. They override inherited workspace values and can model env handoff between hooks.',
    )

    await act(async () => {
      buttonsByText('Add variable')[0]?.click()
      await Promise.resolve()
    })
    await flushRender()

    const inputs = Array.from(container.querySelectorAll('input'))
    await setInputValue(inputs[0] as HTMLInputElement | undefined, 'BASE_URL')
    await setInputValue(inputs[1] as HTMLInputElement | undefined, 'https://override.example.com')
    await flushRender()

    expect(container.textContent).toContain('Overrides .env')

    await act(async () => {
      container.querySelector('button[aria-label="Remove variable"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(container.textContent).not.toContain('Overrides .env')
  })

  it('submits runtime variables through runHook, keeps results browser-local, and exposes capability-aware diagnostics', async () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
    await renderAt('/hook/h_alpha')

    await act(async () => {
      buttonsByText('Add variable')[0]?.click()
      await Promise.resolve()
    })
    await flushRender()

    const inputs = Array.from(container.querySelectorAll('input'))
    await setInputValue(inputs[0] as HTMLInputElement | undefined, 'BASE_URL')
    await setInputValue(inputs[1] as HTMLInputElement | undefined, 'https://override.example.com')
    await flushRender()

    await act(async () => {
      buttonsByText('Run Hook').at(-1)?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(runHookMock).toHaveBeenCalledWith('h_alpha', {
      overrides: [{ key: 'BASE_URL', value: 'https://override.example.com' }],
    })
    expect(currentLocation()?.getAttribute('data-pathname')).toBe('/hook/h_alpha')
    expect(currentLocation()?.getAttribute('data-search')).toBe('')
    expect(setItemSpy).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Latest hook result')

    await act(async () => {
      buttonsByText('Run logs')[0]?.click()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Local runs')
    expect(container.textContent).toContain('Recent hook runs stay in this browser and are not added to dashboard history.')

    await act(async () => {
      buttonsByText('Output')[0]?.click()
      await Promise.resolve()
    })
    expect(container.textContent).toContain('hook complete')
    expect(container.textContent).toContain('warning output')

    await act(async () => {
      buttonsByText('Env')[0]?.click()
      await Promise.resolve()
    })
    expect(container.textContent).toContain('TOKEN')
    expect(container.textContent).toContain('BASE_URL')

    await act(async () => {
      buttonsByText('Sandbox')[0]?.click()
      await Promise.resolve()
    })
    expect(container.textContent).toContain('Bun')
    expect(container.textContent).toContain('vostride/agent-qa-hook-runner-bun')
    expect(container.textContent).toContain('enabled')
    expect(container.textContent).toContain("Network logs aren't available for this runtime yet.")
    expect(buttonsByText('Network')).toHaveLength(0)

    setItemSpy.mockRestore()
  })

  it('renders a Network tab when the hook response includes network telemetry', async () => {
    runHookMock.mockResolvedValueOnce({
      success: true,
      status: 'passed',
      executedAt: '2026-04-22T20:35:00.000Z',
      duration: 4500,
      output: 'hook complete',
      stdout: 'hook complete',
      stderr: '',
      error: null,
      variables: { TOKEN: 'abc' },
      sandbox: {
        runtime: 'bun',
        image: 'vostride/agent-qa-hook-runner-bun',
        networkMode: 'enabled',
        dockerVersion: '28.0.4',
        networkLogsAvailable: true,
        networkLogs: [
          {
            id: 'network-1',
            method: 'POST',
            url: 'https://example.com/api/login',
            statusCode: 201,
            durationMs: 45,
            error: null,
          },
        ],
      },
    })

    await renderAt('/hook/h_alpha')

    await act(async () => {
      buttonsByText('Run Hook').at(-1)?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(buttonsByText('Network')).toHaveLength(1)

    await act(async () => {
      buttonsByText('Network')[0]?.click()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('https://example.com/api/login')
    expect(container.textContent).toContain('POST')
    expect(container.textContent).toContain('201')
  })

  it('uses the header Run Hook action and the R shortcut for the same submit path', async () => {
    await renderAt('/hook/h_alpha')

    expect(buttonsByText('Run Hook')).toHaveLength(1)

    await act(async () => {
      buttonsByText('Add variable')[0]?.click()
      await Promise.resolve()
    })
    await flushRender()

    const inputs = Array.from(container.querySelectorAll('input'))
    await setInputValue(inputs[0] as HTMLInputElement | undefined, 'CUSTOM_KEY')
    await setInputValue(inputs[1] as HTMLInputElement | undefined, 'custom-value')
    await flushRender()

    await act(async () => {
      buttonsByText('Run Hook')[0]?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(runHookMock).toHaveBeenNthCalledWith(1, 'h_alpha', {
      overrides: [{ key: 'CUSTOM_KEY', value: 'custom-value' }],
    })

    await act(async () => {
      latestShortcuts().r(new KeyboardEvent('keydown', { key: 'r' }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(runHookMock).toHaveBeenNthCalledWith(2, 'h_alpha', {
      overrides: [{ key: 'CUSTOM_KEY', value: 'custom-value' }],
    })
  })

  it('removes the redundant failed-run summary header above the bottom tabs', async () => {
    runHookMock.mockResolvedValueOnce({
      success: false,
      status: 'failed',
      executedAt: '2026-04-22T20:36:00.000Z',
      duration: 1800,
      output: '',
      stdout: '',
      stderr: 'boom',
      error: 'Execution failed',
      variables: {},
      sandbox: {
        runtime: 'bun',
        image: 'vostride/agent-qa-hook-runner-bun',
        networkMode: 'enabled',
        dockerVersion: '28.0.4',
        networkLogsAvailable: false,
        networkLogs: [],
      },
    })

    await renderAt('/hook/h_alpha')

    await act(async () => {
      buttonsByText('Run Hook')[0]?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.textContent).not.toContain('Latest hook result')
    expect(container.textContent).toContain('Failure summary')
    expect(container.textContent).toContain('Execution failed')
  })
})
