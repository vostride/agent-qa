// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const navigateSpy = vi.fn()

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router')
  return { ...actual, useNavigate: () => navigateSpy }
})

vi.mock('@/lib/api', () => ({
  fetchSuiteFiles: vi.fn().mockResolvedValue({
    files: [
      { path: 'a.suite.yaml', suiteId: 's_alpha-one', name: 'Alpha', testCount: 1, modified: '2026-04-17T00:00:00Z', platform: 'web' },
      { path: 'b.suite.yaml', suiteId: null, name: 'Beta (no id)', testCount: 1, modified: '2026-04-17T00:00:00Z', platform: 'web' },
    ],
  }),
  fetchRuns: vi.fn().mockResolvedValue({ runs: [] }),
  deleteSuiteFile: vi.fn(),
  triggerRun: vi.fn(),
}))

vi.mock('@/hooks/use-run-config', () => ({ useRunConfig: () => ({ defaultRunMode: 'local', hasFarm: false }) }))
vi.mock('@/hooks/use-page-title', () => ({ usePageTitle: () => {} }))
vi.mock('@/hooks/use-keyboard-shortcuts', () => ({ useKeyboardShortcuts: vi.fn() }))
vi.mock('@/hooks/use-suites-search-params', () => ({
  useSuitesSearchParams: () => ({
    status: '',
    platform: '',
    sorting: [],
    onSortingChange: vi.fn(),
    setStatus: vi.fn(),
    setPlatform: vi.fn(),
  }),
}))

// Flatten Radix primitives so dropdown items render inline and can be queried directly.
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick, disabled }: { children: ReactNode; onClick?: () => void; disabled?: boolean }) => (
    <button type="button" data-testid="dropdown-item" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <hr />,
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock('@/components/page-skeleton', () => ({ TableSkeleton: () => <div data-testid="skeleton" /> }))
vi.mock('@/components/empty-state', () => ({ EmptyState: () => <div data-testid="empty" /> }))
vi.mock('@/components/batch-action-bar', () => ({ BatchActionBar: () => <div /> }))
vi.mock('@/components/shortcut-hints', () => ({ ShortcutLegend: () => <div /> }))

import SuitesPage from '@/pages/suites'
import { useKeyboardShortcuts } from '@/hooks/use-keyboard-shortcuts'

let container: HTMLDivElement
let root: Root

async function renderList() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(
      <MemoryRouter initialEntries={['/suites']}>
        <SuitesPage />
      </MemoryRouter>,
    )
  })
  // Flush microtasks so mocked fetchSuiteFiles/fetchRuns resolve and the page commits the rows.
  await new Promise((r) => setTimeout(r, 20))
  await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  navigateSpy.mockReset()
  vi.mocked(useKeyboardShortcuts).mockClear()
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

describe('suites list navigation (SC-4)', () => {
  it('uses row interaction instead of the removed overlay link', async () => {
    await renderList()
    expect(container.querySelector('a[href="/suite/s_alpha-one"]')).toBeNull()
  })

  it('never renders suite detail anchors for rows in the list body', async () => {
    await renderList()
    expect(container.querySelector('a[href="/suite/null"]')).toBeNull()
    expect(container.querySelector('a[href="/suite/undefined"]')).toBeNull()
    const suiteLinks = container.querySelectorAll('a[href^="/suite/"]')
    expect(suiteLinks.length).toBe(0)
  })

  it('Enter shortcut navigates to /suite/:suite-id', async () => {
    await renderList()
    // advance selectedIndex to the first visible row (Alpha)
    const latest = () => vi.mocked(useKeyboardShortcuts).mock.calls.at(-1)![0] as Record<string, (e?: KeyboardEvent) => void>
    act(() => { latest().j() })
    // Re-fetch the latest shortcuts closure (useMemo re-ran with updated selectedIndex)
    act(() => { latest().enter(new KeyboardEvent('keydown', { key: 'Enter' })) })
    expect(navigateSpy).toHaveBeenCalledWith('/suite/s_alpha-one')
  })

  it('Cmd+Enter opens /suite/:suite-id in new tab', async () => {
    await renderList()
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    const latest = () => vi.mocked(useKeyboardShortcuts).mock.calls.at(-1)![0] as Record<string, (e?: KeyboardEvent) => void>
    act(() => { latest().j() })
    act(() => { latest().enter(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true })) })
    expect(openSpy).toHaveBeenCalledWith('/suite/s_alpha-one', '_blank')
    openSpy.mockRestore()
  })

  it('does not render the removed row dropdown action menu', async () => {
    await renderList()
    expect(container.querySelector('[data-testid="dropdown-item"]')).toBeNull()
  })
})
