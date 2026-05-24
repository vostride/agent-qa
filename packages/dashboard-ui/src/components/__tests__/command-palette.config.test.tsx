// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const navigateSpy = vi.fn()
const commandState = vi.hoisted(() => ({
  query: '',
}))

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router')
  return { ...actual, useNavigate: () => navigateSpy }
})

vi.mock('@/lib/api', () => ({
  fetchRuns: vi.fn().mockResolvedValue({ runs: [] }),
  fetchTestFiles: vi.fn().mockResolvedValue({ files: [] }),
  fetchHookCatalog: vi.fn().mockResolvedValue({
    hooks: [],
    filePath: null,
    errors: [],
    missing: false,
  }),
  fetchSuiteFiles: vi.fn().mockResolvedValue({ files: [] }),
  fetchMemoryCatalog: vi.fn().mockResolvedValue({ products: [] }),
}))

vi.mock('@/components/product-tour', () => ({
  useProductTour: () => ({
    restartTour: vi.fn(),
  }),
}))

vi.mock('@/components/ui/command', () => ({
  CommandDialog: ({
    open,
    children,
    className,
  }: {
    open: boolean
    children: ReactNode
    className?: string
  }) => (open ? <div data-testid="cmd-dialog" data-class-name={className}>{children}</div> : null),
  CommandInput: ({ value, onValueChange }: { value: string; onValueChange: (v: string) => void; placeholder?: string }) => (
    <input
      data-testid="cmd-input"
      value={value}
      onChange={(e) => {
        commandState.query = e.target.value
        onValueChange(e.target.value)
      }}
    />
  ),
  CommandList: ({
    children,
    className,
  }: {
    children: ReactNode
    className?: string
  }) => <div data-testid="cmd-list" data-class-name={className}>{children}</div>,
  CommandEmpty: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CommandGroup: ({ heading, children }: { heading?: string; children: ReactNode }) => (
    <div data-cmd-group={heading ?? ''}>{children}</div>
  ),
  CommandItem: ({ value, children, onSelect }: { value?: string; children: ReactNode; onSelect?: () => void }) => {
    const normalizedQuery = commandState.query.trim().toLowerCase()
    const commandValue = value ?? ''
    if (normalizedQuery.length >= 2 && !commandValue.toLowerCase().includes(normalizedQuery)) {
      return null
    }
    return (
      <button type="button" data-testid="cmd-item" data-value={value} onClick={() => onSelect?.()}>
        {children}
      </button>
    )
  },
  CommandSeparator: () => <hr />,
}))

import { CommandPalette } from '@/components/command-palette'

let container: HTMLDivElement
let root: Root

async function renderPalette() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(
      <MemoryRouter initialEntries={['/config']}>
        <CommandPalette />
      </MemoryRouter>,
    )
  })
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function typeSearch(query: string) {
  const input = container.querySelector('[data-testid="cmd-input"]') as HTMLInputElement
  act(() => {
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    nativeSetter.call(input, query)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await new Promise((resolve) => setTimeout(resolve, 260))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  commandState.query = ''
  navigateSpy.mockReset()
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

describe('command palette config navigation', () => {
  it('shows config item results and navigates to canonical config deep links', async () => {
    await renderPalette()
    await typeSearch('targets')
    const items = Array.from(container.querySelectorAll('[data-testid="cmd-item"]')) as HTMLButtonElement[]
    const configItem = items.find((item) => item.textContent?.includes('Config: Registry / Targets'))
    expect(configItem).toBeDefined()

    act(() => {
      configItem!.click()
    })

    expect(navigateSpy).toHaveBeenCalledWith('/config?bucket=registry&item=targets')
  })

  it('matches obvious aliases like env file and log capture', async () => {
    await renderPalette()
    await typeSearch('env file')
    expect(container.textContent).toContain('Config: Workspace / Files')
    const envItem = Array.from(container.querySelectorAll('[data-testid="cmd-item"]'))
      .find((item) => item.textContent?.includes('Config: Workspace / Files')) as HTMLButtonElement | undefined
    expect(envItem?.getAttribute('data-value')).toContain('Config: Workspace / Files')
    expect(envItem?.getAttribute('data-value')).toContain('workspace.envFile')
    expect(envItem?.getAttribute('data-value')?.toLowerCase()).toContain('env file')

    await typeSearch('log capture')
    expect(container.textContent).toContain('Config: Use / Log Capture')

    await typeSearch('pass rate')
    expect(container.textContent).toContain('Config: Analytics / Pass Rate Scope')
  })

  it('matches audited service field paths for runtime storage and memory', async () => {
    await renderPalette()
    await typeSearch('services.memory.dir')
    let items = Array.from(container.querySelectorAll('[data-testid="cmd-item"]')) as HTMLButtonElement[]
    let configItem = items.find((item) => item.textContent?.includes('Config: Services / Memory'))
    expect(configItem).toBeDefined()
    expect(configItem?.getAttribute('data-value')).toContain('services.memory.dir')

    await typeSearch('artifactsDir')
    items = Array.from(container.querySelectorAll('[data-testid="cmd-item"]')) as HTMLButtonElement[]
    configItem = items.find((item) => item.textContent?.includes('Config: Services / Dashboard'))
    expect(configItem).toBeDefined()
    expect(configItem?.getAttribute('data-value')).toContain('services.dashboard.artifactsDir')

    await typeSearch('services.cache.ttl')
    items = Array.from(container.querySelectorAll('[data-testid="cmd-item"]')) as HTMLButtonElement[]
    configItem = items.find((item) => item.textContent?.includes('Config: Services / Cache'))
    expect(configItem).toBeDefined()
    expect(configItem?.getAttribute('data-value')).toContain('services.cache.ttl')
  })

  it('opens the analytics pass rate scope config destination', async () => {
    await renderPalette()
    await typeSearch('analytics scope')
    const items = Array.from(container.querySelectorAll('[data-testid="cmd-item"]')) as HTMLButtonElement[]
    const configItem = items.find((item) => item.textContent?.includes('Config: Analytics / Pass Rate Scope'))
    expect(configItem).toBeDefined()

    act(() => {
      configItem!.click()
    })

    expect(navigateSpy).toHaveBeenCalledWith('/config?bucket=analytics&item=pass-rate-scope')
  })
})
