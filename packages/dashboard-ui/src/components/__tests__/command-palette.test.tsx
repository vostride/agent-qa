// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const navigateSpy = vi.fn()
const apiMocks = vi.hoisted(() => ({
  fetchRuns: vi.fn(),
  fetchTestFiles: vi.fn(),
  fetchSuiteFiles: vi.fn(),
  fetchHookCatalog: vi.fn(),
  fetchMemoryCatalog: vi.fn(),
  restartTour: vi.fn(),
}))
const commandState = vi.hoisted(() => ({
  query: '',
}))

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router')
  return { ...actual, useNavigate: () => navigateSpy }
})

vi.mock('@/lib/api', () => ({
  fetchRuns: apiMocks.fetchRuns,
  fetchTestFiles: apiMocks.fetchTestFiles,
  fetchSuiteFiles: apiMocks.fetchSuiteFiles,
  fetchHookCatalog: apiMocks.fetchHookCatalog,
  fetchMemoryCatalog: apiMocks.fetchMemoryCatalog,
}))

vi.mock('@/components/product-tour', () => ({
  useProductTour: () => ({
    restartTour: apiMocks.restartTour,
  }),
}))

// Flatten Command/CommandDialog primitives so items render inline and are queryable.
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
  CommandInput: ({ value, onValueChange }: { value: string; onValueChange: (v: string) => void; placeholder?: string }) => {
    commandState.query = value

    return (
      <input
        data-testid="cmd-input"
        value={value}
        onChange={(e) => {
          commandState.query = e.target.value
          onValueChange(e.target.value)
        }}
      />
    )
  },
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
  CommandItem: ({
    value,
    children,
    onSelect,
    ...props
  }: {
    value?: string
    children: ReactNode
    onSelect?: () => void
  } & React.HTMLAttributes<HTMLButtonElement>) => {
    const normalizedQuery = commandState.query.trim().toLowerCase()
    const commandValue = value ?? ''
    if (normalizedQuery.length >= 2 && !commandValue.toLowerCase().includes(normalizedQuery)) {
      return null
    }
    return (
      <button
        type="button"
        data-testid="cmd-item"
        data-value={value}
        onClick={() => onSelect?.()}
        {...props}
      >
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
      <MemoryRouter initialEntries={['/runs']}>
        <CommandPalette />
      </MemoryRouter>,
    )
  })
  // Open the dialog via Cmd+K so the mocked CommandDialog renders.
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
  })
  await new Promise((r) => setTimeout(r, 0))
}

async function typeSearch(query: string) {
  const input = container.querySelector('[data-testid="cmd-input"]') as HTMLInputElement
  act(() => {
    // set native value, then dispatch input event for React change detection
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    nativeSetter.call(input, query)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  // Wait past the 200ms debounce in command-palette.tsx plus microtasks for fetch mocks.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 260))
    await new Promise((r) => setTimeout(r, 0))
  })
}

function expectNoPrivateCommandCopy(surface: string) {
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
    expect(surface.toLowerCase()).not.toContain(forbidden.toLowerCase())
  }
}

beforeEach(() => {
  commandState.query = ''
  navigateSpy.mockReset()
  apiMocks.fetchRuns.mockResolvedValue({ runs: [] })
  apiMocks.fetchTestFiles.mockResolvedValue({ files: [] })
  apiMocks.fetchSuiteFiles.mockResolvedValue({
    files: [
      { path: 'p.suite.yaml', suiteId: 's_palette-match', name: 'Palette Match', testCount: 1, modified: '', platform: null },
      { path: 'n.suite.yaml', suiteId: null, name: 'Palette No ID', testCount: 1, modified: '', platform: null },
    ],
  })
  apiMocks.fetchHookCatalog.mockResolvedValue({
    hooks: [
      {
        id: 'h_palette-match',
        name: 'Palette Hook',
        runtime: 'node',
        file: './hooks/palette.js',
        timeout: 30000,
        network: true,
        fileMissing: false,
      },
    ],
    filePath: './hooks.yaml',
    errors: [],
    missing: false,
  })
  apiMocks.fetchMemoryCatalog.mockResolvedValue({
    products: [
      {
        productKey: 'stripe-checkout',
        observationCount: 7,
        scopeCounts: { product: 2, suite: 3, test: 2 },
        targetReferences: ['staging', 'production', 'checkout-preview', 'webhook-sandbox'],
        sourceCounts: { suite: 2, test: 4 },
        freshness: '2026-04-23T12:00:00.000Z',
        sourceCoverage: 0.75,
      },
      {
        productKey: 'github-search',
        observationCount: 3,
        scopeCounts: { product: 1, suite: 1, test: 1 },
        targetReferences: ['github-web'],
        sourceCounts: { suite: 1, test: 1 },
        freshness: '2026-04-23T12:00:00.000Z',
        sourceCoverage: 1,
      },
    ],
  })
  apiMocks.restartTour.mockReset()
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

describe('command palette suite navigation (SC-4)', () => {
  it('includes Hooks in the Pages group', async () => {
    await renderPalette()

    const items = Array.from(container.querySelectorAll('[data-testid="cmd-item"]')) as HTMLButtonElement[]
    const hooksPage = items.find((el) => el.getAttribute('data-value') === 'page-Hooks')
    expect(hooksPage).toBeTruthy()

    act(() => { hooksPage?.click() })
    expect(navigateSpy).toHaveBeenCalledWith('/hooks')
  })

  it('includes creation actions for new tests, suites, and hooks', async () => {
    await renderPalette()

    let items = Array.from(container.querySelectorAll('[data-testid="cmd-item"]')) as HTMLButtonElement[]
    const newTest = items.find((el) => el.getAttribute('data-value') === 'create add new test tests yaml')
    const newSuite = items.find((el) => el.getAttribute('data-value') === 'create add new suite suites yaml')
    const newHook = items.find((el) => el.getAttribute('data-value') === 'create add new hook hooks setup teardown inline')

    expect(newTest?.textContent).toContain('New Test')
    expect(newSuite?.textContent).toContain('New Suite')
    expect(newHook?.textContent).toContain('Create Hook')

    act(() => { newTest?.click() })
    expect(navigateSpy).toHaveBeenCalledWith('/tests/new')

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
    })
    await new Promise((r) => setTimeout(r, 0))
    items = Array.from(container.querySelectorAll('[data-testid="cmd-item"]')) as HTMLButtonElement[]
    act(() => {
      items.find((el) => el.getAttribute('data-value') === 'create add new suite suites yaml')?.click()
    })
    expect(navigateSpy).toHaveBeenCalledWith('/suites/new')

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
    })
    await new Promise((r) => setTimeout(r, 0))
    items = Array.from(container.querySelectorAll('[data-testid="cmd-item"]')) as HTMLButtonElement[]
    act(() => {
      items.find((el) => el.getAttribute('data-value') === 'create add new hook hooks setup teardown inline')?.click()
    })
    expect(navigateSpy).toHaveBeenCalledWith('/hooks/new')
  })

  it('pins the dialog shell and reserves list-pane height while results change', async () => {
    await renderPalette()

    expect(container.querySelector('[data-testid="cmd-dialog"]')?.getAttribute('data-class-name')).toContain('top-[18vh]')
    expect(container.querySelector('[data-testid="cmd-dialog"]')?.getAttribute('data-class-name')).toContain('translate-y-0')
    expect(container.querySelector('[data-testid="cmd-list"]')?.getAttribute('data-class-name')).toContain('min-h-[320px]')
  })

  it('starts the product tour from the command palette without navigation', async () => {
    apiMocks.fetchRuns.mockResolvedValueOnce({
      runs: [{ id: 'r_tour', name: 'Tour readiness run', status: 'passed' }],
    })

    await renderPalette()
    await typeSearch('tour')

    expect(container.textContent).toContain('Tour readiness run')

    const tourCommand = container.querySelector<HTMLButtonElement>(
      '[data-tour-id="tour-command-product-tour"]',
    )
    expect(tourCommand).not.toBeNull()
    expect(tourCommand?.textContent).toContain('Take product tour')

    act(() => {
      tourCommand?.click()
    })

    expect(apiMocks.restartTour).toHaveBeenCalledTimes(1)
    expect(navigateSpy).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="cmd-dialog"]')).toBeNull()

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
    })
    await new Promise((r) => setTimeout(r, 0))

    expect((container.querySelector('[data-testid="cmd-input"]') as HTMLInputElement).value).toBe('')
    expect(container.textContent).not.toContain('Tour readiness run')
  })

  it('keeps the product tour command free of local/private details', async () => {
    await renderPalette()

    const tourCommand = container.querySelector<HTMLButtonElement>(
      '[data-tour-id="tour-command-product-tour"]',
    )
    expect(tourCommand).not.toBeNull()

    const commandSurface = [
      tourCommand?.textContent ?? '',
      tourCommand?.getAttribute('data-value') ?? '',
    ].join(' ')

    expect(commandSurface).toContain('Take product tour')
    expectNoPrivateCommandCopy(commandSurface)
  })

  it('clicking a Suite command item navigates to /suite/:suite-id', async () => {
    await renderPalette()
    await typeSearch('Palette')
    const items = Array.from(container.querySelectorAll('[data-testid="cmd-item"]')) as HTMLButtonElement[]
    const suiteItems = items.filter((el) => el.getAttribute('data-value')?.startsWith('suite '))
    expect(suiteItems.length).toBeGreaterThan(0)
    act(() => { suiteItems[0]!.click() })
    expect(navigateSpy).toHaveBeenCalledWith('/suite/s_palette-match')
  })

  it('finds tests by test name and shows the name before the file path', async () => {
    apiMocks.fetchTestFiles.mockResolvedValueOnce({
      files: [
        {
          path: 'tests/web/01.yaml',
          name: 'Checkout smoke flow',
          testId: 't_checkout_smoke',
          targetName: 'checkout-web',
          platform: 'web',
          modified: '',
        },
      ],
    })

    await renderPalette()
    await typeSearch('Checkout')

    const items = Array.from(container.querySelectorAll('[data-testid="cmd-item"]')) as HTMLButtonElement[]
    const testItems = items.filter((el) => el.getAttribute('data-value')?.startsWith('test '))
    expect(testItems).toHaveLength(1)
    expect(testItems[0]!.textContent).toContain('Checkout smoke flow')
    expect(testItems[0]!.textContent).toContain('tests/web/01.yaml')
    expect(testItems[0]!.getAttribute('data-value')).toContain('t_checkout_smoke')
    expect(testItems[0]!.getAttribute('data-value')).toContain('checkout-web')

    act(() => { testItems[0]!.click() })
    expect(navigateSpy).toHaveBeenCalledWith('/test/t_checkout_smoke')
  })

  it('falls back to the test path when a search result has no test ID', async () => {
    apiMocks.fetchTestFiles.mockResolvedValueOnce({
      files: [
        {
          path: 'tests/web/legacy.yaml',
          name: 'Legacy no-id flow',
          testId: null,
          targetName: 'legacy-web',
          platform: 'web',
          modified: '',
        },
      ],
    })

    await renderPalette()
    await typeSearch('Legacy')

    const items = Array.from(container.querySelectorAll('[data-testid="cmd-item"]')) as HTMLButtonElement[]
    const testItems = items.filter((el) => el.getAttribute('data-value')?.startsWith('test '))
    expect(testItems).toHaveLength(1)

    act(() => { testItems[0]!.click() })
    expect(navigateSpy).toHaveBeenCalledWith('/test/tests/web/legacy.yaml')
  })

  it('keeps suites visible when the query matches only the suite file path', async () => {
    apiMocks.fetchSuiteFiles.mockResolvedValueOnce({
      files: [
        {
          path: 'suites/release-web-mdn.suite.yaml',
          suiteId: 's_release_web_mdn',
          name: 'Release validation',
          testCount: 3,
          modified: '',
          platform: 'web',
        },
      ],
    })

    await renderPalette()
    await typeSearch('release-web-mdn')

    const items = Array.from(container.querySelectorAll('[data-testid="cmd-item"]')) as HTMLButtonElement[]
    const suiteItems = items.filter((el) => el.getAttribute('data-value')?.startsWith('suite '))
    expect(suiteItems).toHaveLength(1)
    expect(suiteItems[0]!.textContent).toContain('Release validation')
    expect(suiteItems[0]!.textContent).toContain('suites/release-web-mdn.suite.yaml')
    expect(suiteItems[0]!.getAttribute('data-value')).toContain('suites/release-web-mdn.suite.yaml')
  })

  it('suites with null suiteId are not rendered in the Suites group', async () => {
    await renderPalette()
    await typeSearch('Palette')
    const items = Array.from(container.querySelectorAll('[data-testid="cmd-item"]')) as HTMLButtonElement[]
    const suiteItems = items.filter((el) => el.getAttribute('data-value')?.startsWith('suite '))
    expect(suiteItems.length).toBe(1)
    expect(suiteItems[0]!.textContent).toContain('Palette Match')
    for (const el of suiteItems) {
      const value = el.getAttribute('data-value') ?? ''
      expect(value).not.toContain('n.suite.yaml')
    }
  })

  it('clicking a Hook command item navigates to /hook/:id', async () => {
    await renderPalette()
    await typeSearch('Palette')

    const items = Array.from(container.querySelectorAll('[data-testid="cmd-item"]')) as HTMLButtonElement[]
    const hookItems = items.filter((el) => el.getAttribute('data-value')?.startsWith('hook '))
    expect(hookItems.length).toBeGreaterThan(0)

    act(() => { hookItems[0]!.click() })
    expect(navigateSpy).toHaveBeenCalledWith('/hook/h_palette-match')
  })

  it('keeps hooks visible when the query matches only the hook file path', async () => {
    apiMocks.fetchHookCatalog.mockResolvedValueOnce({
      hooks: [
        {
          id: 'h_hn_top_story',
          name: 'Fetch HN top story',
          runtime: 'python',
          file: 'fetch-hn-top-story-python.py',
          timeout: 30000,
          network: true,
          fileMissing: false,
        },
      ],
      filePath: './hooks.yaml',
      errors: [],
      missing: false,
    })

    await renderPalette()
    await typeSearch('fetch-hn-top-story')

    const items = Array.from(container.querySelectorAll('[data-testid="cmd-item"]')) as HTMLButtonElement[]
    const hookItems = items.filter((el) => el.getAttribute('data-value')?.startsWith('hook '))
    expect(hookItems).toHaveLength(1)
    expect(hookItems[0]!.textContent).toContain('Fetch HN top story')
    expect(hookItems[0]!.textContent).toContain('fetch-hn-top-story-python.py')
    expect(hookItems[0]!.getAttribute('data-value')).toContain('fetch-hn-top-story-python.py')
  })

  it('includes Memory in the Pages group and opens /memory', async () => {
    await renderPalette()

    const items = Array.from(container.querySelectorAll('[data-testid="cmd-item"]')) as HTMLButtonElement[]
    const memoryPage = items.find((el) => el.getAttribute('data-value') === 'page-Memory')
    expect(memoryPage).toBeTruthy()

    act(() => { memoryPage?.click() })
    expect(navigateSpy).toHaveBeenCalledWith('/memory')
  })

  it('finds memory products by product key and opens the product route', async () => {
    await renderPalette()
    await typeSearch('stripe')

    expect(apiMocks.fetchMemoryCatalog).toHaveBeenCalled()

    const items = Array.from(container.querySelectorAll('[data-testid="cmd-item"]')) as HTMLButtonElement[]
    const memoryItems = items.filter((el) => el.getAttribute('data-value')?.startsWith('memory-'))
    expect(memoryItems).toHaveLength(1)
    expect(memoryItems[0]!.getAttribute('data-value')).toContain('stripe-checkout')
    expect(memoryItems[0]!.textContent).toContain('stripe-checkout')
    expect(memoryItems[0]!.textContent).toContain('staging, production, checkout-preview, +1 more')

    act(() => { memoryItems[0]!.click() })
    expect(navigateSpy).toHaveBeenCalledWith('/memory/stripe-checkout')
  })

  it('finds memory products by target reference but still opens the owning product', async () => {
    await renderPalette()
    await typeSearch('staging')

    const items = Array.from(container.querySelectorAll('[data-testid="cmd-item"]')) as HTMLButtonElement[]
    const memoryItems = items.filter((el) => el.getAttribute('data-value')?.startsWith('memory-'))
    expect(memoryItems).toHaveLength(1)
    expect(memoryItems[0]!.textContent).toContain('stripe-checkout')
    expect(memoryItems[0]!.textContent).toContain('staging, production, checkout-preview, +1 more')

    act(() => { memoryItems[0]!.click() })
    expect(navigateSpy).toHaveBeenCalledWith('/memory/stripe-checkout')
  })

  it('keeps static Memory and other dynamic groups when memory catalog loading fails', async () => {
    apiMocks.fetchMemoryCatalog.mockRejectedValueOnce(new Error('catalog unavailable'))

    await renderPalette()
    expect(
      Array.from(container.querySelectorAll('[data-testid="cmd-item"]'))
        .some((el) => el.getAttribute('data-value') === 'page-Memory'),
    ).toBe(true)

    await typeSearch('Palette')

    const items = Array.from(container.querySelectorAll('[data-testid="cmd-item"]')) as HTMLButtonElement[]
    expect(items.some((el) => el.getAttribute('data-value')?.startsWith('suite '))).toBe(true)
    expect(items.some((el) => el.getAttribute('data-value')?.startsWith('hook '))).toBe(true)
    expect(items.some((el) => el.getAttribute('data-value')?.startsWith('memory-'))).toBe(false)
  })

  it('ignores stale dynamic results when a slower search resolves after a newer query', async () => {
    let resolveSlowSearch!: (value: { runs: Array<{ id: string; name: string; status: string }> }) => void
    const slowSearch = new Promise<{ runs: Array<{ id: string; name: string; status: string }> }>((resolve) => {
      resolveSlowSearch = resolve
    })
    apiMocks.fetchRuns.mockImplementation(({ name }: { name?: string }) => {
      if (name === 'slow') return slowSearch
      if (name === 'fast') {
        return Promise.resolve({ runs: [{ id: 'r_fast', name: 'Fast run', status: 'passed' }] })
      }
      return Promise.resolve({ runs: [] })
    })

    await renderPalette()
    await typeSearch('slow')
    await typeSearch('fast')

    expect(container.textContent).toContain('Fast run')

    await act(async () => {
      resolveSlowSearch({ runs: [{ id: 'r_slow', name: 'Slow run', status: 'failed' }] })
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Fast run')
    expect(container.textContent).not.toContain('Slow run')
  })
})
