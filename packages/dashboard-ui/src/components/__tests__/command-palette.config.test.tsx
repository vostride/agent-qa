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
import { CONFIG_SECTION_LABELS, CONFIG_TAB_LABELS, configCommandLabel } from '@/lib/config-copy'
import { CONFIG_SECTIONS, CONFIG_TABS, LEGACY_CONFIG_LINKS, LEGACY_CONFIG_PAIRS } from '@/lib/config-tabs'
import { routes } from '@/lib/routes'

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

function reopenPalette() {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
  })
}

function configItems(): HTMLButtonElement[] {
  return Array.from(
    container.querySelectorAll('[data-cmd-group="Config"] [data-testid="cmd-item"]'),
  ) as HTMLButtonElement[]
}

function configItemLabelled(label: string): HTMLButtonElement | undefined {
  return configItems().find((item) => item.textContent === label)
}

const STORAGE_WORDS = /\b(workspace|knowledge\.|services|registry|use\.|analytics)\b|[a-z]\.[a-z]/i
const ALL_CONFIG_LABELS = new Set(
  CONFIG_TABS.flatMap((tab) => CONFIG_SECTIONS[tab].map((section) => configCommandLabel(tab, section))),
)
const LABEL_SHAPE = new RegExp(
  `^Config: (${Object.values(CONFIG_TAB_LABELS).join('|')}) / .+$`,
)

describe('command palette config navigation', () => {
  it('shows the Targets section and navigates to its tab and section', async () => {
    await renderPalette()
    await typeSearch('targets')
    const configItem = configItemLabelled('Config: Targets / Targets')
    expect(configItem).toBeDefined()

    act(() => {
      configItem!.click()
    })

    expect(navigateSpy).toHaveBeenCalledWith('/config/targets?section=targets')
  })

  it('matches obvious aliases like env file and log capture', async () => {
    await renderPalette()
    await typeSearch('env file')
    expect(container.textContent).toContain('Config: Project / Hooks, env and secrets files')
    const envItem = configItemLabelled('Config: Project / Hooks, env and secrets files')
    expect(envItem?.getAttribute('data-value')).toContain('Config: Project / Hooks, env and secrets files')
    expect(envItem?.getAttribute('data-value')?.toLowerCase()).toContain('env file')
    expect(envItem?.getAttribute('data-value')).not.toContain('workspace.envFile')

    await typeSearch('log capture')
    expect(container.textContent).toContain('Config: Execution / Log capture')

    await typeSearch('pass rate')
    expect(container.textContent).toContain('Config: Project / Pass-rate scope')
  })

  it('matches runtime storage and knowledge by section words, never by dotted path', async () => {
    await renderPalette()
    await typeSearch('knowledge dir')
    let configItem = configItemLabelled('Config: Project / Knowledge store')
    expect(configItem).toBeDefined()
    expect(configItem?.getAttribute('data-value')).not.toContain('knowledge.dir')

    await typeSearch('artifacts dir')
    configItem = configItemLabelled('Config: Project / Dashboard')
    expect(configItem).toBeDefined()
    expect(configItem?.getAttribute('data-value')).not.toContain('services.dashboard.artifactsDir')

    await typeSearch('cache dir')
    configItem = configItemLabelled('Config: Execution / Cache')
    expect(configItem).toBeDefined()
    expect(configItem?.getAttribute('data-value')).not.toContain('services.cache.dir')

    for (const dotted of ['knowledge.dir', 'services.dashboard.artifactsDir', 'services.cache.dir']) {
      await typeSearch(dotted)
      expect(configItems()).toEqual([])
    }
  })

  it('opens the pass-rate scope config destination on the Project tab', async () => {
    await renderPalette()
    await typeSearch('pass-rate scope')
    const configItem = configItemLabelled('Config: Project / Pass-rate scope')
    expect(configItem).toBeDefined()

    act(() => {
      configItem!.click()
    })

    expect(navigateSpy).toHaveBeenCalledWith('/config/project?section=pass-rate-scope')
  })

  it(
    'PALETTE-CONFIG-ENTRIES: each entry is labelled Config: {Tab} / {Section} and opens where its legacy link lands',
    async () => {
      await renderPalette()
      await typeSearch('timeouts')
      const timeouts = configItemLabelled('Config: Execution / Timeouts')
      expect(timeouts).toBeDefined()
      act(() => {
        timeouts!.click()
      })
      expect(navigateSpy).toHaveBeenLastCalledWith('/config/execution?section=timeouts')

      for (const pair of LEGACY_CONFIG_PAIRS) {
        const { tab, section } = LEGACY_CONFIG_LINKS[pair]
        const [bucket, item] = pair.split(':') as [string, string]
        reopenPalette()
        await typeSearch(CONFIG_SECTION_LABELS[section])
        const entry = configItemLabelled(configCommandLabel(tab, section))
        expect(entry, pair).toBeDefined()
        act(() => {
          entry!.click()
        })
        expect(navigateSpy).toHaveBeenLastCalledWith(routes.configItem(bucket, item))
        expect(navigateSpy).toHaveBeenLastCalledWith(routes.configTab(tab, section))
      }
    },
    30_000,
  )

  it('PALETTE-SEARCH-NO-STORAGE-VOCAB: bucket names and dotted paths find nothing, and every label is task-shaped', async () => {
    await renderPalette()
    for (const query of ['registry', 'use.timeout', 'workspace', 'services', 'analytics', 'use.llm']) {
      await typeSearch(query)
      const hits = configItems().filter((item) =>
        item.textContent?.toLowerCase().includes(query.toLowerCase()),
      )
      expect(hits, query).toEqual([])
      expect(configItems(), query).toEqual([])
    }

    for (const query of ['in', 'se', 'time', 'model']) {
      await typeSearch(query)
      const items = configItems()
      expect(items.length, query).toBeGreaterThan(0)
      for (const item of items) {
        const label = item.textContent ?? ''
        expect(label).toMatch(LABEL_SHAPE)
        expect(ALL_CONFIG_LABELS.has(label), label).toBe(true)
        expect(label).not.toMatch(STORAGE_WORDS)
        expect(item.getAttribute('data-value') ?? '').not.toMatch(STORAGE_WORDS)
      }
    }
  })
})
