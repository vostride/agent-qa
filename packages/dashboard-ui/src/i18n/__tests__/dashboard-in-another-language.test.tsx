// @vitest-environment jsdom

import { asRef, type RunDetailSubAction } from '@vostride/agent-qa-schema'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import i18n, { applyLanguage, useTranslation } from '@/i18n'
import de from '@/i18n/locales/de'
import en from '@/i18n/locales/en'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/theme-provider', () => ({
  useTheme: () => ({ theme: 'light', setTheme: vi.fn() }),
}))

vi.mock('@/components/product-tour', () => ({
  useProductTour: () => ({ restartTour: vi.fn() }),
}))

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchAppMetadata: vi.fn().mockResolvedValue({ version: '0.0.0' }),
}))

vi.mock('@/components/ui/sidebar', () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  return {
    Sidebar: Pass,
    SidebarHeader: Pass,
    SidebarContent: Pass,
    SidebarFooter: Pass,
    SidebarSeparator: () => <hr />,
    SidebarGroup: Pass,
    SidebarGroupLabel: Pass,
    SidebarMenu: Pass,
    SidebarMenuItem: Pass,
    SidebarMenuButton: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    SidebarRail: () => null,
    useSidebar: () => ({ state: 'expanded', toggleSidebar: vi.fn() }),
  }
})

vi.mock('@/components/ui/tooltip', () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <>{children}</>
  return {
    TooltipProvider: Pass,
    Tooltip: Pass,
    TooltipTrigger: Pass,
    TooltipContent: ({ children }: { children?: React.ReactNode }) => (
      <div data-tooltip-content="">{children}</div>
    ),
  }
})

vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  ScrollBar: () => null,
}))

vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children?: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
  SelectValue: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
  SelectContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children }: { children?: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
}))

vi.mock('@/components/elapsed-timer', () => ({
  ElapsedTimer: ({ startedAt }: { startedAt: string }) => <span>{startedAt}</span>,
}))

import { AppSidebar } from '@/components/app-sidebar'
import { ConfigTabBar } from '@/components/config-manager/config-tabs'
import { ActionSentence } from '@/components/run-detail/action-sentence'
import { RunStatusBadge } from '@/components/run-status-badge'
import { RunsTable, type SuiteRunRow } from '@/components/runs-table'
import { Tabs } from '@/components/ui/tabs'
import { ApiError } from '@/lib/api'
import { formatTokens } from '@/lib/format'

type Key = keyof typeof en & keyof typeof de

let container: HTMLDivElement | undefined
let root: Root | undefined

afterEach(async () => {
  if (root) act(() => root!.unmount())
  container?.remove()
  root = undefined
  container = undefined
  vi.restoreAllMocks()
  await act(async () => {
    await applyLanguage('en')
  })
  i18n.removeResourceBundle('de', 'translation')
})

function fill(template: string, slots: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => slots[name] ?? '')
}

function differs(key: Key) {
  expect(de[key], `${key} reads the same in German and English`).not.toBe(en[key])
}

async function mount(element: React.ReactNode) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<MemoryRouter initialEntries={['/runs']}>{element}</MemoryRouter>)
  })
  return container
}

async function toGerman() {
  await act(async () => {
    await applyLanguage('de')
  })
}

async function toEnglish() {
  await act(async () => {
    await applyLanguage('en')
  })
}

function runRow(id: string, name: string, overrides: Partial<SuiteRunRow> = {}): SuiteRunRow {
  const createdAt = new Date(Date.now() - 5 * 60_000).toISOString()
  return {
    id,
    name,
    filePath: `tests/${id}.yaml`,
    status: 'passed',
    duration: 43_400,
    attributes: {},
    environment: null,
    metadata: null,
    startedAt: createdAt,
    endedAt: createdAt,
    failureSummary: null,
    errorLog: null,
    testId: null,
    suiteId: null,
    platform: 'web',
    testFileContent: null,
    modelName: null,
    llmProvider: null,
    attemptNumber: 1,
    retryCount: 0,
    maxRetries: 0,
    createdAt,
    targetName: null,
    ...overrides,
  }
}

const RUNS = [
  runRow('run_checkout', 'Checkout flow'),
  runRow('run_login', 'Login works', { status: 'failed', duration: 2_000 }),
]

function RunsTableOnPage() {
  return (
    <RunsTable
      runs={RUNS}
      total={RUNS.length}
      isLoading={false}
      page={0}
      onPageChange={() => {}}
      onSearchChange={() => {}}
      searchValue=""
      selectedRunId={null}
      onSelectedRunIdChange={() => {}}
      expandedSuites={new Set()}
      onToggleSuite={() => {}}
      onOpenRun={() => {}}
      platformFilter=""
      onPlatformChange={() => {}}
      targetFilter=""
      targetOptions={[]}
      onTargetChange={() => {}}
      attributePredicates={[]}
      onAttributePredicatesChange={() => {}}
      selectedRunIds={new Set()}
      onToggleRunSelection={() => {}}
      onToggleVisibleSelection={() => {}}
    />
  )
}

const CLICK_SAVE: RunDetailSubAction = {
  testIndex: 0,
  stepIndex: 0,
  subActionIndex: 0,
  plan: 'Press the save button',
  plannedAction: { type: 'click', ref: asRef('e1') },
  grounding: { descriptor: { name: 'Save' }, attempts: [] },
  result: { success: true },
  screenStateHash: 'screen',
}

// A routed page calls `useTranslation()`, so the pieces it draws render again on a switch.
function RoutedPage() {
  useTranslation()
  return (
    <>
      <Tabs value="models">
        <ConfigTabBar tab="models" />
      </Tabs>
      <span data-piece="badge">
        <RunStatusBadge status="passed" />
      </span>
      <span data-piece="sentence">
        <ActionSentence sub={CLICK_SAVE} />
      </span>
    </>
  )
}

function headerText(view: HTMLElement, key: Key) {
  return Array.from(view.querySelectorAll('thead th'))
    .map((cell) => cell.textContent?.trim() ?? '')
    .find((text) => text === en[key] || text === de[key])
}

function rowOf(view: HTMLElement, id: string) {
  return view.querySelector(`[data-runs-row-surface="${id}"]`)
}

describe('the dashboard in German with the real catalog', () => {
  it('switches the navigation to German and back on the same links', async () => {
    differs('nav.config')
    differs('nav.insights')
    const view = await mount(<AppSidebar />)
    const config = view.querySelector('a[href="/config"]')
    const insights = view.querySelector('a[href="/insights"]')

    await toGerman()
    expect(view.querySelector('a[href="/config"]')).toBe(config)
    expect(config?.textContent).toBe(de['nav.config'])
    expect(insights?.textContent).toBe(de['nav.insights'])

    await toEnglish()
    expect(view.querySelector('a[href="/config"]')).toBe(config)
    expect(config?.textContent).toBe(en['nav.config'])
    expect(insights?.textContent).toBe(en['nav.insights'])
  })

  it('switches a Config tab label, a status badge and an action sentence on the same nodes', async () => {
    differs('config.tabs.models')
    differs('status.passed')
    differs('action.click.done')
    const sentence = (catalog: typeof en | typeof de) =>
      fill(catalog['action.click.done'], {
        target: fill(catalog['action.target.name'], { name: 'Save' }),
      })
    const view = await mount(<RoutedPage />)
    const tab = view.querySelector('[data-config-tab="models"]')
    const badge = view.querySelector('[data-piece="badge"]')
    const action = view.querySelector('[data-piece="sentence"]')
    expect(tab?.textContent).toBe(en['config.tabs.models'])

    await toGerman()
    expect(view.querySelector('[data-config-tab="models"]')).toBe(tab)
    expect(tab?.textContent).toBe(de['config.tabs.models'])
    expect(badge?.textContent).toBe(de['status.passed'])
    expect(action?.textContent).toBe(sentence(de))

    await toEnglish()
    expect(view.querySelector('[data-config-tab="models"]')).toBe(tab)
    expect(tab?.textContent).toBe(en['config.tabs.models'])
    expect(badge?.textContent).toBe(en['status.passed'])
    expect(action?.textContent).toBe(sentence(en))
  })

  it('switches the runs table column headers to German and back on the same table', async () => {
    differs('runs.table.testName')
    differs('runs.table.started')
    const view = await mount(<RunsTableOnPage />)
    const head = view.querySelector('thead')
    expect(headerText(view, 'runs.table.testName')).toBe(en['runs.table.testName'])

    await toGerman()
    expect(view.querySelector('thead')).toBe(head)
    expect(headerText(view, 'runs.table.testName')).toBe(de['runs.table.testName'])
    expect(headerText(view, 'runs.table.started')).toBe(de['runs.table.started'])

    await toEnglish()
    expect(view.querySelector('thead')).toBe(head)
    expect(headerText(view, 'runs.table.testName')).toBe(en['runs.table.testName'])
    expect(headerText(view, 'runs.table.started')).toBe(en['runs.table.started'])
  })

  it('shows a test name and a server message exactly as produced while in German', async () => {
    const view = await mount(<RunsTableOnPage />)
    await toGerman()

    expect(rowOf(view, 'run_checkout')?.textContent).toContain('Checkout flow')
    expect(new ApiError(507, 'Insufficient Storage', { error: 'disk is full' }).message).toBe(
      'disk is full',
    )
    expect(new ApiError(507, 'disk is full', null).message).toBe(
      fill(de['common.api.error'], { status: '507', statusText: 'disk is full' }),
    )
  })

  it('writes a duration and a relative time in German on a mounted table', async () => {
    const view = await mount(<RunsTableOnPage />)
    await toGerman()

    const row = rowOf(view, 'run_checkout')?.textContent ?? ''
    expect(row).toContain('43,4')
    expect(row).toContain('vor')
  })

  it('formats a token count by the dashboard language and not the browser region', async () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['en-IN'])
    const tokens = () => formatTokens(1_234_567).replace(/\u00a0/g, ' ')

    expect(tokens()).toBe('1.2M')
    await toGerman()
    expect(tokens()).toBe('1,2 Mio.')
  })

  it('shows the English text for a key the German catalog has no text for', async () => {
    differs('nav.insights')
    const partial = Object.fromEntries(Object.entries(de).filter(([key]) => key !== 'nav.config'))
    const view = await mount(<AppSidebar />)

    await act(async () => {
      await applyLanguage('de', async () => ({ default: partial }))
    })

    expect(view.querySelector('a[href="/config"]')?.textContent).toBe(en['nav.config'])
    expect(view.querySelector('a[href="/insights"]')?.textContent).toBe(de['nav.insights'])
  })
})
