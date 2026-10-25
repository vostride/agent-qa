// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation, useNavigate, type NavigateFunction } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  RunDetailMember,
  RunDetailMemberMark,
  RunDetailProjection,
  RunDetailStep,
  RunsMarkPreviewResult,
} from '@vostride/agent-qa-schema'
import { MARKS, MARK_PREVIEW_REFUSALS, RunsMarkPreviewResultSchema, RunsMarksHistoryResultSchema } from '@vostride/agent-qa-schema'
import { generateRunId, generateTestId } from '@vostride/agent-qa-ids'

import RunDetailPage from '@/pages/run-detail'
import {
  type FeedbackReadFailure,
  type MarkPreviewRead,
  type MarksHistoryRead,
} from '@/lib/api'
import {
  CHOICE_LABELS,
  CHOICE_MEANINGS,
  CLOSE_FEEDBACK_LABEL,
  DRAFT_KEPT_STATUS,
  FEEDBACK_CHOICE_ORDER,
  NOTE_COUNTER_FROM,
  NOTE_LABEL,
  NOTE_MAX_LENGTH,
  NO_UNIQUE_ADDRESS_TEXT,
  PREVIEW_DEBOUNCE_MS,
  PREVIEW_UPDATING_TEXT,
  PREVIEW_READ_FAILED_TEXT,
  PREVIEW_RETRY_ACCESSIBLE_NAME,
  SENDING_STATUS,
  SUBMIT_REASON_ALREADY_MARKED,
  SUBMIT_REASON_CHECKING,
  SUBMIT_REASON_NO_CHOICE,
  SUBMIT_REASON_NO_UNIQUE_ADDRESS,
  SUBMIT_REASON_PREVIEW_FAILED,
  SUBMIT_REASON_REFUSED,
  SUBMIT_REASON_SENDING,
  alreadyMarkedText,
  feedbackReadFailureReason,
  noteCounterText,
  previewRefusalText,
  quarantinedText,
  TEST_SWITCHER_LABEL,
  feedbackEntryLabel,
  feedbackRecordedText,
  markGlyphLabel,
  pinnedTargetText,
  previewFixText,
  resolvedStepText,
  showStepLabel,
  switchTargetLabel,
  unsentDraftLabel,
  TECHNICAL_DETAILS_LABEL,
  formatMarkTime,
  replacesLine,
  feedbackDefaultLayout,
} from '@/lib/feedback-view'
import { memberDisplayName, memberHandleLabel } from '@/lib/run-detail-view'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const RUN_ID = generateRunId()
const TEST_ID = generateTestId()
const SUITE_TEST_IDS = [generateTestId(), generateTestId()] as const

const {
  markRunMock,
  fetchRunAnalysisMock,
  fetchRunMock,
  fetchRunDetailMock,
  fetchRunArtifactMock,
  fetchExecutionLogsMock,
  fetchMarkPreviewMock,
  fetchMarksHistoryMock,
  triggerRunMock,
} = vi.hoisted(() => ({
  markRunMock: vi.fn(),
  fetchRunAnalysisMock: vi.fn(),
  fetchRunMock: vi.fn(),
  fetchRunDetailMock: vi.fn(),
  fetchRunArtifactMock: vi.fn(),
  fetchExecutionLogsMock: vi.fn(),
  fetchMarkPreviewMock: vi.fn(),
  fetchMarksHistoryMock: vi.fn(),
  triggerRunMock: vi.fn(),
}))

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  markRun: markRunMock,
  fetchRun: fetchRunMock,
  fetchRunDetail: fetchRunDetailMock,
  fetchRunAnalysis: fetchRunAnalysisMock,
  fetchRunKnowledge: () => Promise.resolve({ kind: 'evidence-incomplete', runId: '' }),
  fetchRunArtifact: fetchRunArtifactMock,
  fetchExecutionLogs: fetchExecutionLogsMock,
  fetchRunEvidence: () => Promise.resolve({ kind: 'failed', error: 'not configured' }),
  fetchMarkPreview: fetchMarkPreviewMock,
  fetchMarksHistory: fetchMarksHistoryMock,
  triggerRun: triggerRunMock,
  watchPostProcessing: () => () => {},
}))

vi.mock('@/hooks/use-page-title', () => ({ usePageTitle: () => {} }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/components/page-skeleton', () => ({ DetailSkeleton: () => <div>Loading...</div> }))
vi.mock('@/components/empty-state', () => ({
  EmptyState: ({ title }: { title: string }) => <div>{title}</div>,
}))
// Module-level mount counters: a layout change that remounts the tree or the evidence resets what
// the person was inspecting (426-11 NO-REMOUNT-ON-LAYOUT-CHANGE).
const mounts = vi.hoisted(() => ({ tabPanels: 0, stepTree: 0 }))
// The tab double renders the evidence strip's active tab, the composer's last focus fallback (D-07).
vi.mock('@/components/run-detail/tab-panels', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return {
    TabPanels: ({ step, activeTab }: { step: { id: string } | null; activeTab?: string }) => {
      React.useEffect(() => { mounts.tabPanels += 1 }, [])
      return (
        <div data-testid="tab-panels" data-step-id={step?.id ?? ''}>
          <button type="button" role="tab" aria-selected="true" data-active-tab={activeTab}>{activeTab}</button>
        </div>
      )
    },
  }
})
vi.mock('@/components/run-detail/step-tree', async (importOriginal) => {
  const React = await vi.importActual<typeof import('react')>('react')
  const actual = await importOriginal<typeof import('@/components/run-detail/step-tree')>()
  return {
    ...actual,
    StepTree: (props: Parameters<typeof actual.StepTree>[0]) => {
      React.useEffect(() => { mounts.stepTree += 1 }, [])
      return <actual.StepTree {...props} />
    },
  }
})
vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
// The select double keeps the root's value and onValueChange reachable: each item is a button that
// calls the enclosing root's handler, so a cell can pick an option without Radix's pointer model.
vi.mock('@/components/ui/select', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  const Root = React.createContext<((value: string) => void) | undefined>(undefined)
  return {
    Select: ({ children, value, onValueChange }: { children: ReactNode; value?: string; onValueChange?: (value: string) => void }) => (
      <Root.Provider value={onValueChange}>
        <div data-select-value={value}>{children}</div>
      </Root.Provider>
    ),
    SelectTrigger: ({ children, className: _className, ...rest }: { children: ReactNode; className?: string }) => <div {...rest}>{children}</div>,
    SelectValue: () => <span>member filter</span>,
    SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    SelectItem: ({ children, value }: { children: ReactNode; value: string }) => {
      const onValueChange = React.useContext(Root)
      return <button type="button" data-select-item={value} onClick={() => onValueChange?.(value)}>{children}</button>
    },
  }
})
// Pitfall 7: the panel double renders the props the layout cells read, JSON-encoded so a numeric
// size and a string size stay distinguishable.
vi.mock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children, defaultLayout, orientation }: {
    children: ReactNode
    defaultLayout?: unknown
    orientation?: string
  }) => (
    <div
      data-resizable-group
      data-orientation={orientation}
      data-default-layout={defaultLayout === undefined ? undefined : JSON.stringify(defaultLayout)}
    >
      {children}
    </div>
  ),
  ResizablePanel: ({ children, id, defaultSize, minSize, maxSize }: {
    children: ReactNode
    id?: string
    defaultSize?: unknown
    minSize?: unknown
    maxSize?: unknown
  }) => (
    <div
      data-resizable-panel
      data-panel-id={id}
      data-default-size={JSON.stringify(defaultSize)}
      data-min-size={JSON.stringify(minSize)}
      data-max-size={JSON.stringify(maxSize)}
    >
      {children}
    </div>
  ),
  ResizableHandle: () => <div data-resizable-handle />,
}))
vi.mock('@/components/ui/collapsible', () => ({
  Collapsible: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CollapsibleTrigger: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
  CollapsibleContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock('@/components/ui/badge', () => ({
  Badge: ({ children, ...rest }: { children: ReactNode }) => <span {...rest}>{children}</span>,
}))
// Pitfall 7: every prop but the variant styling passes through, so data-*, aria-* and onClick reach
// the DOM the cells read.
vi.mock('@/components/ui/button', () => ({
  Button: ({ children, variant: _variant, size: _size, asChild: _asChild, ...rest }: {
    children: ReactNode
    variant?: string
    size?: string
    asChild?: boolean
  }) => <button type="button" {...rest}>{children}</button>,
}))

function member(testIndex: number, extra: Partial<RunDetailMember> = {}): RunDetailMember {
  return { testIndex, attempts: 1, ...extra }
}

function step(testIndex: number, stepIndex: number, stepText: string): RunDetailStep {
  return {
    testIndex,
    stepIndex,
    stepText,
    cacheStatus: 'miss',
    verifierVerdict: { pass: false, reasoning: 'cart total differs' },
    selfHealOccurred: false,
    briefDigest: `d${String(testIndex)}${String(stepIndex)}`,
    status: 'failed',
    durationMs: 1000,
  }
}

function projection(over: Partial<RunDetailProjection> = {}): RunDetailProjection {
  return {
    runId: RUN_ID,
    members: [],
    steps: [],
    subActions: [],
    tokens: { measuredSteps: 0, unmeasuredSteps: 0 },
    ...over,
  }
}

function runRow(id: string) {
  return {
    id,
    name: 'Checkout test',
    filePath: 'tests/checkout.yaml',
    status: 'failed',
    duration: 10000,
    attributes: {},
    environment: null,
    metadata: null,
    startedAt: '2026-09-23T00:00:00.000Z',
    endedAt: '2026-09-23T00:00:10.000Z',
    failureSummary: null,
    errorLog: null,
    memoryLog: null,
    testId: null,
    suiteId: null,
    platform: 'web',
    testFileContent: null,
    modelName: null,
    llmProvider: null,
    parentRunId: null,
    attemptNumber: 1,
    retryCount: 0,
    maxRetries: 0,
    createdAt: '2026-09-23T00:00:00.000Z',
  }
}

const initial = projection({
  members: [member(0, { testId: TEST_ID, outcome: 'failed', marks: [] })],
  steps: [step(0, 0, 'Open cart')],
})
// 432-09 (D-04): a mark's receipt names the knowledge it changed; history joins that record.
const receipt: RunDetailMemberMark = {
  markId: 'mark_0123456789ab',
  kind: 'false-fail',
  ordinal: 1,
  disposition: { kind: 'applied', fix: 'fact', change: { kind: 'knowledge', changeId: 'prop_0123456789ab', recordIds: ['mem_page_1'] } },
}
const CHANGED = [{ recordId: 'mem_page_1', contentAbsence: { reason: 'not-bound' as const } }]
const refreshed = projection({
  ...initial,
  members: [{ ...initial.members[0]!, marks: [receipt] }],
})
const CONSEQUENCES = RunsMarkPreviewResultSchema.parse({
  kind: 'consequences',
  runId: RUN_ID,
  prospective: true,
  markKind: 'false-fail',
  member: { testIndex: 0, testId: TEST_ID },
  resolvedStep: { stepIndex: 0, reason: 'failing-step' },
  latest: { kind: 'first' },
  basis: { ledgerOrdinal: 0 },
  markedDecisionCount: 1,
  groundTruth: [],
  labels: [],
  knowledge: { servedRecordIds: [], appendsEvidence: false, records: [], evidence: { confirmed: 0, overturned: 0 } },
  draft: { kind: 'no-draftable-fix', checked: { servedRecords: 0, procedureReads: 0, assertionDrift: false } },
})

let container: HTMLDivElement | null = null
let root: Root | null = null

async function flushRender() {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve()
  })
}

let navigateTo: NavigateFunction | undefined

function LocationProbe() {
  const location = useLocation()
  navigateTo = useNavigate()
  return <output data-location={`${location.pathname}${location.search}`} />
}

async function renderAt(url: string) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[url]}>
        <LocationProbe />
        <Routes>
          <Route path="/runs/:id" element={<RunDetailPage />} />
        </Routes>
      </MemoryRouter>,
    )
  })
  await flushRender()
  return container
}

function q<T extends Element = HTMLElement>(selector: string): T | null {
  return container!.querySelector<T>(selector)
}

async function click(selector: string) {
  await act(async () => { q<HTMLElement>(selector)!.click() })
  await flushRender()
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}

async function pickFirstChoiceAndLandPreview(read: Promise<MarkPreviewRead>) {
  fetchMarkPreviewMock.mockReturnValue(read)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  await click('[data-feedback-choice] [role="radio"]')
  expect(fetchMarkPreviewMock).not.toHaveBeenCalled()
  await act(async () => { vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS) })
  vi.useRealTimers()
  await flushRender()
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  fetchExecutionLogsMock.mockResolvedValue({ logs: [] })
  fetchRunArtifactMock.mockResolvedValue({ run: { id: RUN_ID }, artifact: null, missingSections: ['artifact'] })
  fetchRunAnalysisMock.mockResolvedValue({ runId: RUN_ID, verdicts: [], sentences: [], clusters: [] })
  fetchRunMock.mockImplementation(async (id: string) => ({ run: runRow(id) }))
  fetchRunDetailMock.mockResolvedValue(initial)
  fetchMarksHistoryMock.mockResolvedValue({ kind: 'failed', reason: 'network' })
})

afterEach(() => {
  vi.useRealTimers()
  if (root) act(() => root!.unmount())
  root = null
  if (container) container.remove()
  container = null
  vi.unstubAllGlobals()
  vi.resetAllMocks()
})

describe('426-01 contextual feedback tracer', () => {
  it('TRACER-HEADER-ENTRY-TO-RECORDED: header entry → current preview → Send feedback → announced receipt', async () => {
    fetchRunDetailMock.mockImplementation(async () => markRunMock.mock.calls.length > 0 ? refreshed : initial)
    markRunMock.mockResolvedValue({ kind: 'marked', receipt })
    await renderAt(`/runs/${RUN_ID}`)

    const entries = container!.querySelectorAll('[data-feedback-entry="test"]')
    expect(entries).toHaveLength(1)
    expect(q('[data-verdict-badge]')!.nextElementSibling).toBe(entries[0])

    await click('[data-feedback-entry="test"]')
    const composer = q('[data-feedback-composer]')
    expect(composer).not.toBeNull()
    expect(composer!.getAttribute('data-feedback-scope')).toBe('test')
    expect(composer!.getAttribute('data-feedback-target')).toBe('0:run')
    const rows = [...container!.querySelectorAll('[data-feedback-choice]')]
    expect(rows.map(row => row.getAttribute('data-feedback-choice'))).toEqual([...FEEDBACK_CHOICE_ORDER.failed])
    expect(rows.map(row => row.textContent)).toEqual(FEEDBACK_CHOICE_ORDER.failed.map(kind => CHOICE_LABELS[kind] + CHOICE_MEANINGS.failed[kind]))

    const preview = deferred<MarkPreviewRead>()
    await pickFirstChoiceAndLandPreview(preview.promise)
    expect(fetchMarkPreviewMock).toHaveBeenCalledTimes(1)
    const submit = q<HTMLButtonElement>('[data-feedback-submit]')!
    expect(submit.getAttribute('aria-disabled')).toBe('true')
    expect(submit.hasAttribute('disabled')).toBe(false)
    await click('[data-feedback-submit]')
    expect(markRunMock).not.toHaveBeenCalled()

    await act(async () => preview.resolve({ kind: 'read', result: CONSEQUENCES }))
    await flushRender()
    expect(q('[data-feedback-preview]')!.getAttribute('data-preview-state')).toBe('consequences')
    expect(q('[data-feedback-preview]')!.getAttribute('data-preview-current')).toBe('true')
    expect(q('[data-feedback-submit]')!.getAttribute('aria-disabled')).toBe('false')

    await click('[data-feedback-submit]')
    await flushRender()
    expect(markRunMock).toHaveBeenCalledTimes(1)
    const status = q('[data-feedback-status]')!
    expect(status.getAttribute('role')).toBe('status')
    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(status.getAttribute('aria-atomic')).toBe('true')
    expect(status.textContent).toBe(feedbackRecordedText(receipt.disposition))
  })

  it('PREVIEW-INPUT-EQUALS-MARK-INPUT: the preview body is the mark body with runId added and note and confirmScope removed', async () => {
    const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
    markRunMock.mockImplementation(actual.markRun)
    fetchMarkPreviewMock.mockImplementation(actual.fetchMarkPreview)
    fetchRunDetailMock.mockImplementation(async () => markRunMock.mock.calls.length > 0 ? refreshed : initial)
    const bodies = new Map<string, Record<string, unknown>>()
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>
      bodies.set(url, body)
      return new Response(JSON.stringify(url.endsWith('/mark-preview') ? CONSEQUENCES : { kind: 'marked', receipt }))
    }))
    await renderAt(`/runs/${RUN_ID}`)
    await click('[data-feedback-entry="test"]')

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await click('[data-feedback-choice] [role="radio"]')
    await act(async () => { vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS) })
    vi.useRealTimers()
    await flushRender()
    await click('[data-feedback-submit]')
    await flushRender()

    const previewBody = bodies.get(`/api/runs/${encodeURIComponent(RUN_ID)}/mark-preview`)
    const markBody = bodies.get(`/api/runs/${encodeURIComponent(RUN_ID)}/mark`)
    expect(previewBody).toBeDefined()
    expect(markBody).toBeDefined()
    expect(previewBody!.runId).toBe(RUN_ID)
    // 432-14 (D-14): the page holds no confirm scope, so the mark body carries none to remove.
    expect(markBody).not.toHaveProperty('confirm' + 'Scope')
    const { runId: _runId, ...previewRest } = previewBody!
    const { note: _note, ...markRest } = markBody!
    expect(previewRest).toEqual(markRest)
    expect(previewRest).toEqual({ kind: FEEDBACK_CHOICE_ORDER.failed[0], testId: TEST_ID })
  })

  it('COMPOSER-IS-A-REGION: the composer is a named section and nothing on its path is a dialog', async () => {
    await renderAt(`/runs/${RUN_ID}`)
    await click('[data-feedback-entry="test"]')
    const composer = q('[data-feedback-composer]')!
    expect(composer.tagName).toBe('SECTION')
    const headingId = composer.getAttribute('aria-labelledby')!
    const heading = document.getElementById(headingId)
    expect(heading?.tagName).toBe('H2')
    expect(composer.contains(heading)).toBe(true)
    expect(document.querySelectorAll('[role="dialog"],[aria-modal]')).toHaveLength(0)
  })

  it('CLOSED-LAYOUT-TWO-PANELS: closed renders the shipped two panels; opening adds a third with a three-key percent layout', async () => {
    await renderAt(`/runs/${RUN_ID}`)
    const group = () => q('[data-resizable-group]')!
    const panels = () => [...container!.querySelectorAll('[data-resizable-panel]')]
    expect(panels().map(panel => [panel.getAttribute('data-default-size'), panel.getAttribute('data-min-size')]))
      .toEqual([['35', '20'], ['65', '30']])
    expect(group().hasAttribute('data-default-layout')).toBe(false)
    expect(container!.querySelectorAll('[data-resizable-handle]')).toHaveLength(1)

    await click('[data-feedback-entry="test"]')
    expect(panels().map(panel => panel.getAttribute('data-panel-id'))).toEqual(['run-tree', 'run-evidence', 'run-feedback'])
    expect(panels().slice(0, 2).map(panel => [panel.getAttribute('data-default-size'), panel.getAttribute('data-min-size')]))
      .toEqual([['35', '20'], ['65', '30']])
    expect(container!.querySelectorAll('[data-resizable-handle]')).toHaveLength(2)
    const layout = JSON.parse(group().getAttribute('data-default-layout')!) as Record<string, number>
    expect(Object.keys(layout).sort()).toEqual(['run-evidence', 'run-feedback', 'run-tree'])
    expect(Object.values(layout).reduce((sum, value) => sum + value, 0)).toBeCloseTo(100)
    expect(q('[data-panel-id="run-feedback"] [data-feedback-composer]')).not.toBeNull()
  })

  it('NO-FEEDBACK-READ-ON-MOUNT: no feedback read fires until the composer opens', async () => {
    await renderAt(`/runs/${RUN_ID}`)
    await flushRender()
    expect(q('[data-verdict-badge]')).not.toBeNull()
    expect(fetchMarkPreviewMock).not.toHaveBeenCalled()
    expect(fetchMarksHistoryMock).not.toHaveBeenCalled()
  })
})

function suiteDetail(member0: Partial<RunDetailMember> = {}): RunDetailProjection {
  return projection({
    members: [
      member(0, { name: 'Browse catalog', testId: SUITE_TEST_IDS[0], outcome: 'passed', marks: [], ...member0 }),
      member(1, { name: 'Pay for order', testId: SUITE_TEST_IDS[1], outcome: 'failed', marks: [] }),
    ],
    steps: [
      { ...step(0, 0, 'Open catalog'), status: 'passed', verifierVerdict: { pass: true, reasoning: '' } },
      step(1, 0, 'Submit payment'),
    ],
  })
}

describe('426-03 the header entry in a suite', () => {
  it('SUITE-HEADER-TARGET-ON-LOAD: the auto-selected first step makes member 0 the target though member 1 failed', async () => {
    fetchRunDetailMock.mockResolvedValue(suiteDetail())
    await renderAt(`/runs/${RUN_ID}`)
    const entries = container!.querySelectorAll('[data-feedback-entry="test"]')
    expect(entries).toHaveLength(1)
    const entry = entries[0]!
    expect(entry.getAttribute('data-feedback-target')).toBe('0:run')
    expect(entry.getAttribute('data-feedback-marked')).toBe('false')
    expect(entry.getAttribute('aria-label')).toBe(
      feedbackEntryLabel({ scope: 'test', memberName: 'Browse catalog', handle: memberHandleLabel(0) }),
    )

    await click('[data-feedback-entry="test"]')
    const composer = q('[data-feedback-composer]')!
    expect(composer.getAttribute('data-feedback-target')).toBe('0:run')
    const heading = document.getElementById(composer.getAttribute('aria-labelledby')!)!
    expect(heading.textContent).toBe(`Feedback on ${memberDisplayName({ testIndex: 0, name: 'Browse catalog' })} ${memberHandleLabel(0)}`)
  })

  it('SUITE-HEADER-TARGET-ON-LOAD: a whole-test mark on the target member fills the entry', async () => {
    fetchRunDetailMock.mockResolvedValue(suiteDetail({ marks: [receipt] }))
    await renderAt(`/runs/${RUN_ID}`)
    const entry = q('[data-feedback-entry="test"]')!
    expect(entry.getAttribute('data-feedback-target')).toBe('0:run')
    expect(entry.getAttribute('data-feedback-marked')).toBe('true')
    expect(entry.getAttribute('aria-label')).toBe(
      feedbackEntryLabel({ scope: 'test', memberName: 'Browse catalog', handle: memberHandleLabel(0), markedChoice: receipt.kind }),
    )
  })

  it('ENTRY-ABSENT-WITHOUT-MARKS: a failed detail read or a target member without marks renders no entry', async () => {
    fetchRunDetailMock.mockRejectedValue(new Error('offline'))
    await renderAt(`/runs/${RUN_ID}`)
    expect(q('[data-verdict-badge]')).not.toBeNull()
    expect(container!.querySelectorAll('[data-feedback-entry]')).toHaveLength(0)
    act(() => root!.unmount())
    container!.remove()

    fetchRunDetailMock.mockReset()
    fetchRunDetailMock.mockResolvedValue(suiteDetail({ marks: undefined }))
    await renderAt(`/runs/${RUN_ID}`)
    expect(q('[data-verdict-badge]')).not.toBeNull()
    expect(container!.querySelectorAll('[data-feedback-entry]')).toHaveLength(0)
  })
})

describe('426-03 the composer names, switches and refuses its test', () => {
  it('SWITCHER-RETARGETS: choosing another test re-targets the composer and leaves the filter and selection alone', async () => {
    fetchRunDetailMock.mockResolvedValue(suiteDetail())
    await renderAt(`/runs/${RUN_ID}?member=0`)
    const location = () => q('[data-location]')!.getAttribute('data-location')
    const selectedRow = () => container!.querySelector('[role="treeitem"][aria-selected="true"]')?.textContent ?? null
    const locationBefore = location()
    const selectedBefore = selectedRow()
    expect(selectedBefore).not.toBeNull()

    await click('[data-feedback-entry="test"]')
    const composer = () => q('[data-feedback-composer]')!
    const switcher = composer().querySelector<HTMLElement>('[data-feedback-test-switcher]')!
    expect(switcher).not.toBeNull()
    const label = composer().querySelector(`label[for="${switcher.id}"]`)
    expect(label?.textContent).toBe(TEST_SWITCHER_LABEL)
    expect([...composer().querySelectorAll('[data-select-item]')].map(item => item.textContent)).toEqual([
      `${memberDisplayName({ testIndex: 0, name: 'Browse catalog' })} ${memberHandleLabel(0)}`,
      `${memberDisplayName({ testIndex: 1, name: 'Pay for order' })} ${memberHandleLabel(1)}`,
    ])

    await act(async () => { composer().querySelector<HTMLElement>('[data-select-item="1"]')!.click() })
    await flushRender()
    expect(composer().getAttribute('data-feedback-target')).toBe('1:run')
    const heading = document.getElementById(composer().getAttribute('aria-labelledby')!)!
    expect(heading.textContent).toBe(`Feedback on Pay for order ${memberHandleLabel(1)}`)
    expect(location()).toBe(locationBefore)
    expect(selectedRow()).toBe(selectedBefore)
  })

  it('SWITCHER-RETARGETS: a single-test run renders no switcher', async () => {
    await renderAt(`/runs/${RUN_ID}`)
    await click('[data-feedback-entry="test"]')
    expect(q('[data-feedback-composer]')).not.toBeNull()
    expect(q('[data-feedback-test-switcher]')).toBeNull()
  })

  it('NO-UNIQUE-ADDRESS-REFUSAL: a member sharing its testId is refused in the composer without a request', async () => {
    const shared = suiteDetail()
    fetchRunDetailMock.mockResolvedValue({
      ...shared,
      members: shared.members.map(entry => ({ ...entry, testId: SUITE_TEST_IDS[0] })),
    })
    await renderAt(`/runs/${RUN_ID}`)
    await click('[data-feedback-entry="test"]')
    const refusal = q('[data-feedback-no-address]')
    expect(refusal, 'no refusal block at the top of the composer body').not.toBeNull()
    expect(refusal!.textContent).toContain(NO_UNIQUE_ADDRESS_TEXT)
    expect(container!.querySelectorAll('[data-feedback-choice]')).toHaveLength(3)

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await click('[data-feedback-choice] [role="radio"]')
    await act(async () => { vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS) })
    vi.useRealTimers()
    await flushRender()
    expect(fetchMarkPreviewMock).not.toHaveBeenCalled()
    expect(q('[data-feedback-submit-reason]')!.textContent).toBe(SUBMIT_REASON_NO_UNIQUE_ADDRESS)
    expect(q('[data-feedback-submit]')!.getAttribute('aria-disabled')).toBe('true')
  })
})

// THE STEP DOOR AND THE PAGE'S DOOR COUNT (426-04 · SC1, D-04, D-06). The page auto-selects the first
// step, so on load there is the header door and the selected row's door; clearing the selection or
// selecting a hook leaves the header door alone. The pills are gone (426-15), so these are the only doors.
const SETUP_HOOK = {
  id: 'hook-setup-1', runId: RUN_ID, stepId: null, type: 'hook', name: 'Seed catalog', hookId: 'seed',
  phase: 'setup', status: 'passed', duration: 120, stdout: null, stderr: null, returnData: null,
  variables: null, createdAt: '2026-09-23T00:00:00.000Z',
}
const doors = () => container!.querySelectorAll('[data-feedback-entry]')

describe('426-04 the step door on the page', () => {
  it('TRIGGER-COUNT: two doors with a step selected, one with no selection, one with a hook selected', async () => {
    fetchExecutionLogsMock.mockResolvedValue({ logs: [SETUP_HOOK] })
    await renderAt(`/runs/${RUN_ID}`)
    expect(container!.querySelectorAll('[data-mark-kind]')).toHaveLength(0)
    expect(doors()).toHaveLength(2)
    expect([...doors()].map(door => door.getAttribute('data-feedback-entry')).sort()).toEqual(['step', 'test'])
    expect(q('[data-feedback-entry="test"]')!.getAttribute('data-feedback-target')).toBe('0:run')
    expect(q('[data-feedback-entry="step"]')!.getAttribute('data-feedback-target')).toBe('0:0')

    await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    await flushRender()
    expect(container!.querySelector('[role="treeitem"][aria-selected="true"]')).toBeNull()
    expect(doors()).toHaveLength(1)
    expect(q('[data-feedback-entry="test"]')).not.toBeNull()

    const hook = [...container!.querySelectorAll<HTMLButtonElement>('li[role="treeitem"] > button')]
      .find(button => button.textContent?.includes(SETUP_HOOK.name))
    expect(hook, 'no setup hook row').toBeDefined()
    await act(async () => { hook!.click() })
    await flushRender()
    expect(hook!.closest('li')!.getAttribute('aria-selected')).toBe('true')
    expect(doors()).toHaveLength(1)
    expect(q('[data-feedback-entry="test"]')).not.toBeNull()
  })

  it('STEP-TRIGGER-OPENS-STEP-TARGET: the step door opens the composer on its own step and reports itself expanded', async () => {
    await renderAt(`/runs/${RUN_ID}`)
    const stepDoor = () => q('[data-feedback-entry="step"]')!
    expect(stepDoor().getAttribute('aria-expanded')).toBe('false')
    await click('[data-feedback-entry="step"]')
    const composer = q('[data-feedback-composer]')!
    expect(composer.getAttribute('data-feedback-scope')).toBe('step')
    expect(composer.getAttribute('data-feedback-target')).toBe('0:0')
    expect(stepDoor().getAttribute('data-feedback-target')).toBe('0:0')
    expect(stepDoor().getAttribute('aria-controls')).toBe(composer.id)
    expect(stepDoor().getAttribute('aria-expanded')).toBe('true')
    expect(q('[data-feedback-entry="test"]')!.getAttribute('aria-expanded')).toBe('false')
  })

  it('REOPEN-DRAFT-REPREVIEWS: reopening onto an address whose draft holds a choice asks for its preview again', async () => {
    fetchMarkPreviewMock.mockResolvedValue({ kind: 'read', result: CONSEQUENCES })
    await renderAt(`/runs/${RUN_ID}`)
    const land = async (open: string) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      await click(open)
      await click('[data-feedback-choice] [role="radio"]')
      await act(async () => { vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS) })
      vi.useRealTimers()
      await flushRender()
    }
    await land('[data-feedback-entry="step"]')
    expect(q('[data-feedback-submit]')!.getAttribute('aria-disabled')).toBe('false')
    await land('[data-feedback-entry="test"]')
    expect(q('[data-feedback-composer]')!.getAttribute('data-feedback-target')).toBe('0:run')
    expect(fetchMarkPreviewMock).toHaveBeenCalledTimes(2)

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await click('[data-feedback-entry="step"]')
    await act(async () => { vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS) })
    vi.useRealTimers()
    await flushRender()
    expect(q('[data-feedback-composer]')!.getAttribute('data-feedback-target')).toBe('0:0')
    expect(fetchMarkPreviewMock).toHaveBeenCalledTimes(3)
    expect(q('[data-feedback-preview]')!.getAttribute('data-preview-current')).toBe('true')
    expect(q('[data-feedback-submit]')!.getAttribute('aria-disabled')).toBe('false')
  })
})

describe('426-04 the passive trace on a member header', () => {
  it('MEMBER-GLYPH: a whole-test mark puts one named glyph after the member handle and before its outcome badge', async () => {
    fetchRunDetailMock.mockResolvedValue(suiteDetail({ marks: [receipt] }))
    await renderAt(`/runs/${RUN_ID}`)
    const glyphs = container!.querySelectorAll<HTMLElement>('[data-feedback-mark-glyph="test"]')
    expect(glyphs).toHaveLength(1)
    const glyph = glyphs[0]!
    expect(glyph.closest('[data-member]')!.getAttribute('data-member')).toBe('0')
    expect(glyph.getAttribute('role')).toBe('img')
    expect(glyph.getAttribute('aria-label')).toBe(markGlyphLabel(receipt.kind))
    expect(glyph.getAttribute('data-feedback-target')).toBe('0:run')
    expect(glyph.previousElementSibling?.hasAttribute('data-member-handle')).toBe(true)
    expect(glyph.nextElementSibling?.getAttribute('data-member-outcome')).toBe('passed')
  })

  it('MEMBER-GLYPH: a single-test run has no member header, so no member glyph', async () => {
    fetchRunDetailMock.mockResolvedValue(refreshed)
    await renderAt(`/runs/${RUN_ID}`)
    expect(q('[data-feedback-entry="test"]')!.getAttribute('data-feedback-marked')).toBe('true')
    expect(container!.querySelectorAll('[data-feedback-mark-glyph="test"]')).toHaveLength(0)
  })
})

// THE COMPOSER IS A DOCKED COMPANION (426-05 · D-08, D-09). The target is pinned to what the person
// opened it for; the selection moves freely, and only an explicit act re-addresses the draft. Every
// address keeps its own draft for the page session, in page state only.
const fourSteps = projection({
  members: [member(0, { testId: TEST_ID, outcome: 'failed', marks: [] })],
  steps: [step(0, 0, 'Open cart'), step(0, 1, 'Apply coupon'), step(0, 2, 'Pay'), step(0, 3, 'See receipt')],
})
const composerTarget = () => q('[data-feedback-composer]')?.getAttribute('data-feedback-target') ?? null
const noteField = () => q<HTMLTextAreaElement>('[data-feedback-note]')

async function selectStep(address: string) {
  await click(`[data-step-id="${address}"] > button`)
}

async function typeNote(value: string) {
  const field = noteField()
  expect(field, 'no note field in the composer').not.toBeNull()
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(field, value)
    field!.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flushRender()
}

async function openStep(address: string) {
  await selectStep(address)
  await click('[data-feedback-entry="step"]')
  expect(composerTarget()).toBe(address)
}

describe('426-05 the pinned target and per-address drafts', () => {
  beforeEach(() => {
    fetchRunDetailMock.mockResolvedValue(fourSteps)
    fetchMarkPreviewMock.mockResolvedValue({ kind: 'read', result: CONSEQUENCES })
  })

  it('TARGET-PINNED: selecting another step pins the target and names both; only the switch moves it', async () => {
    fetchExecutionLogsMock.mockResolvedValue({ logs: [SETUP_HOOK] })
    await renderAt(`/runs/${RUN_ID}`)
    await openStep('0:1')
    expect(q('[data-feedback-pinned]')).toBeNull()

    await selectStep('0:3')
    expect(composerTarget()).toBe('0:1')
    const pinned = q('[data-feedback-pinned]')
    expect(pinned, 'no pinned line after selecting another step').not.toBeNull()
    expect(pinned!.getAttribute('role')).toBe('note')
    expect(pinned!.textContent).toContain(pinnedTargetText({ stepIndex: 3 }, { stepIndex: 1 }))
    const switcher = pinned!.querySelector('[data-feedback-switch]')
    expect(switcher?.textContent).toBe(switchTargetLabel({ stepIndex: 3 }))

    await click('[data-feedback-switch]')
    expect(composerTarget()).toBe('0:3')
    expect(q('[data-feedback-pinned]')).toBeNull()

    const hook = [...container!.querySelectorAll<HTMLButtonElement>('li[role="treeitem"] > button')]
      .find(button => button.textContent?.includes(SETUP_HOOK.name))
    await act(async () => { hook!.click() })
    await flushRender()
    expect(hook!.closest('li')!.getAttribute('aria-selected')).toBe('true')
    expect(composerTarget()).toBe('0:3')
    expect(q('[data-feedback-pinned]')).toBeNull()
  })

  it('DRAFT-PER-ADDRESS-ROUNDTRIP: each address keeps its own choice and note', async () => {
    await renderAt(`/runs/${RUN_ID}`)
    await openStep('0:1')
    await click('[data-feedback-choice="confirmed-bug"] [role="radio"]')
    await typeNote('the coupon field vanished')

    await selectStep('0:3')
    await click('[data-feedback-switch]')
    expect(composerTarget()).toBe('0:3')
    expect(container!.querySelectorAll('[data-feedback-choice] [role="radio"][aria-checked="true"]')).toHaveLength(0)
    expect(noteField()!.value).toBe('')
    await typeNote('receipt is fine')

    await selectStep('0:1')
    await click('[data-feedback-switch]')
    expect(composerTarget()).toBe('0:1')
    expect(q('[data-feedback-choice="confirmed-bug"] [role="radio"]')!.getAttribute('aria-checked')).toBe('true')
    expect(noteField()!.value).toBe('the coupon field vanished')
  })

  it('UNSENT-DRAFT-LINK: a waiting draft elsewhere is one link away; an empty draft has none', async () => {
    await renderAt(`/runs/${RUN_ID}`)
    await openStep('0:1')
    await typeNote('coupon rejected')
    await selectStep('0:3')
    await click('[data-feedback-switch]')

    const links = container!.querySelectorAll('[data-feedback-unsent-draft]')
    expect(links).toHaveLength(1)
    expect(links[0]!.getAttribute('data-feedback-unsent-draft')).toBe('0:1')
    expect(links[0]!.textContent).toBe(unsentDraftLabel({ stepIndex: 1 }))

    await click('[data-feedback-unsent-draft="0:1"]')
    expect(composerTarget()).toBe('0:1')
    expect(noteField()!.value).toBe('coupon rejected')
    expect(container!.querySelectorAll('[data-feedback-unsent-draft]')).toHaveLength(0)
  })

  it('DRAFTS-NOT-PERSISTED: a typed draft reaches neither storage nor the URL', async () => {
    localStorage.clear()
    sessionStorage.clear()
    await renderAt(`/runs/${RUN_ID}`)
    const location = () => q('[data-location]')!.getAttribute('data-location')!
    await openStep('0:1')
    const before = location()
    const searchBefore = window.location.search
    await typeNote('draft text only in memory')

    const stored = (storage: Storage) =>
      Array.from({ length: storage.length }, (_, index) => storage.key(index)!)
        .filter(key => key.includes('draft text only in memory') || (storage.getItem(key) ?? '').includes('draft text only in memory'))
    expect(stored(localStorage)).toEqual([])
    expect(stored(sessionStorage)).toEqual([])
    expect(location()).toBe(before)
    // The run id is random words and can itself contain "draft".
    expect(location().replace(RUN_ID, '')).not.toContain('draft')
    expect(window.location.search).toBe(searchBefore)
    expect(noteField()!.value).toBe('draft text only in memory')
  })
})

// FOCUS, KEYS AND THE RETAINED DRAFT (426-05 · D-07, D-09, 419-15). The composer takes focus when it
// opens and gives it back when it closes; it never lets a key reach the page's shortcut map; and a
// retained outcome keeps the draft with its status and denial on its own address only.
const heading = () => {
  const composer = q('[data-feedback-composer]')
  return composer === null ? null : document.getElementById(composer.getAttribute('aria-labelledby')!)
}
const headerEntry = () => q<HTMLButtonElement>('[data-feedback-entry="test"]')
const activeTab = () => q('[role="tab"][aria-selected="true"]')

async function key(target: Element, init: KeyboardEventInit) {
  await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })) })
  await flushRender()
}

function suiteHalfMarked(): RunDetailProjection {
  const suite = suiteDetail()
  return { ...suite, members: [suite.members[0]!, { ...suite.members[1]!, marks: undefined }] }
}

describe('426-05 focus in and out, and the page keys', () => {
  beforeEach(() => {
    fetchRunDetailMock.mockResolvedValue(fourSteps)
    fetchMarkPreviewMock.mockResolvedValue({ kind: 'read', result: CONSEQUENCES })
    triggerRunMock.mockReturnValue(new Promise(() => {}))
  })

  it('ESC-CLOSES-RETURNS-FOCUS: opening focuses the heading; Esc in the note closes and returns focus to the header entry', async () => {
    await renderAt(`/runs/${RUN_ID}`)
    await click('[data-feedback-entry="test"]')
    expect(heading()).not.toBeNull()
    expect(document.activeElement).toBe(heading())

    const note = noteField()!
    act(() => note.focus())
    await key(note, { key: 'Escape' })
    expect(q('[data-feedback-composer]')).toBeNull()
    expect(document.activeElement).toBe(headerEntry())
  })

  it('ESC-CLOSES-RETURNS-FOCUS: ✕ after the opening step door unmounts returns focus to the header entry', async () => {
    await renderAt(`/runs/${RUN_ID}`)
    await openStep('0:1')
    const door = q('[data-feedback-entry="step"]')!
    await selectStep('0:3')
    expect(door.isConnected).toBe(false)
    const close = q('[data-feedback-close]')!
    expect(close.getAttribute('aria-label')).toBe(CLOSE_FEEDBACK_LABEL)
    await click('[data-feedback-close]')
    expect(q('[data-feedback-composer]')).toBeNull()
    expect(document.activeElement).toBe(headerEntry())
  })

  it('ESC-CLOSES-RETURNS-FOCUS: with no header entry left, focus goes to the active evidence tab', async () => {
    fetchRunDetailMock.mockResolvedValue(suiteHalfMarked())
    await renderAt(`/runs/${RUN_ID}`)
    await click('[data-feedback-entry="test"]')
    expect(composerTarget()).toBe('0:run')
    await selectStep('1:0')
    expect(headerEntry()).toBeNull()
    await click('[data-feedback-close]')
    expect(q('[data-feedback-composer]')).toBeNull()
    expect(activeTab()).not.toBeNull()
    expect(document.activeElement).toBe(activeTab())
  })

  it('CLOSE-KEEPS-DRAFTS: closing keeps the typed draft; re-activating the open entry keeps it open and refocuses the heading', async () => {
    await renderAt(`/runs/${RUN_ID}`)
    await click('[data-feedback-entry="test"]')
    await typeNote('still here after closing')
    await click('[data-feedback-close]')
    expect(q('[data-feedback-composer]')).toBeNull()
    await click('[data-feedback-entry="test"]')
    expect(noteField()!.value).toBe('still here after closing')

    act(() => noteField()!.focus())
    await click('[data-feedback-entry="test"]')
    expect(q('[data-feedback-composer]')).not.toBeNull()
    expect(headerEntry()!.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(heading())
  })

  it('DETAIL-REREAD-ON-OPEN: opening re-reads runs.detail once, so a mark written elsewhere shows on the entry', async () => {
    const markedElsewhere = projection({ ...fourSteps, members: [{ ...fourSteps.members[0]!, marks: [receipt] }] })
    fetchRunDetailMock.mockResolvedValueOnce(fourSteps).mockResolvedValue(markedElsewhere)
    await renderAt(`/runs/${RUN_ID}`)
    await flushRender()
    expect(fetchRunDetailMock).toHaveBeenCalledTimes(1)
    expect(headerEntry()!.getAttribute('data-feedback-marked')).toBe('false')

    await click('[data-feedback-entry="test"]')
    expect(fetchRunDetailMock).toHaveBeenCalledTimes(2)
    expect(headerEntry()!.getAttribute('data-feedback-marked')).toBe('true')
    expect(q('[data-feedback-composer]')).not.toBeNull()
  })

  it('SHORTCUTS-ISOLATED: r, ArrowDown and 3 on a composer radio reach no page shortcut; an Esc a Radix layer consumed does not close', async () => {
    await renderAt(`/runs/${RUN_ID}`)
    await selectStep('0:1')
    await click('[data-feedback-entry="test"]')
    const selectedRow = () => q('[role="treeitem"][aria-selected="true"]')?.getAttribute('data-step-id') ?? null
    expect(selectedRow()).toBe('0:1')
    const tabBefore = activeTab()!.getAttribute('data-active-tab')

    const radio = q('[data-feedback-choice] [role="radio"]')!
    act(() => radio.focus())
    await key(radio, { key: 'r' })
    expect(triggerRunMock).not.toHaveBeenCalled()
    await key(document.activeElement!, { key: 'ArrowDown' })
    expect(selectedRow()).toBe('0:1')
    await key(document.activeElement!, { key: '3' })
    expect(activeTab()!.getAttribute('data-active-tab')).toBe(tabBefore)

    const consume = (event: KeyboardEvent) => { if (event.key === 'Escape') event.preventDefault() }
    document.addEventListener('keydown', consume, { capture: true })
    try {
      await key(document.activeElement!, { key: 'Escape' })
    } finally {
      document.removeEventListener('keydown', consume, { capture: true })
    }
    expect(q('[data-feedback-composer]')).not.toBeNull()
    expect(selectedRow()).toBe('0:1')
    await key(q('[data-feedback-choice] [role="radio"]')!, { key: 'Escape' })
    expect(q('[data-feedback-composer]')).toBeNull()
    expect(selectedRow()).toBe('0:1')
  })

  it('RUN-CHANGE-DISCARDS-DRAFTS: another run id closes the composer and every draft is gone on return', async () => {
    const RUN_B = generateRunId()
    fetchRunDetailMock.mockImplementation(async (id: string) => ({ ...fourSteps, runId: id }))
    await renderAt(`/runs/${RUN_ID}`)
    await click('[data-feedback-entry="test"]')
    await click('[data-feedback-choice="confirmed-bug"] [role="radio"]')
    await typeNote('a draft on run A')

    await act(async () => { navigateTo!(`/runs/${RUN_B}`) })
    await flushRender()
    expect(q('[data-location]')!.getAttribute('data-location')!.split('?')[0]).toBe(`/runs/${RUN_B}`)
    expect(q('[data-feedback-composer]')).toBeNull()
    await act(async () => { navigateTo!(`/runs/${RUN_ID}`) })
    await flushRender()
    expect(q('[data-feedback-composer]')).toBeNull()

    await click('[data-feedback-entry="test"]')
    expect(noteField()!.value).toBe('')
    expect(container!.querySelectorAll('[data-feedback-choice] [role="radio"][aria-checked="true"]')).toHaveLength(0)
    expect(container!.querySelectorAll('[data-feedback-unsent-draft]')).toHaveLength(0)
  })
})

/** The page's own sentence for a mark that failed (2026-10-02, 432-42: no typed denial is left). */
const MARK_FAILED_TEXT = 'Could not complete the mark or refresh its receipt.'

describe('426-05 the retained draft, per address', () => {
  beforeEach(() => {
    fetchRunDetailMock.mockResolvedValue(fourSteps)
  })

  async function retainOnHeader(reason: string) {
    await click('[data-feedback-entry="test"]')
    await pickFirstChoiceAndLandPreview(Promise.resolve({ kind: 'read', result: CONSEQUENCES }))
    await typeNote('keep this note')
    // 2026-10-02 (432-42, D-15): no typed denial exists; a refused mark is a failed request, and the
    // page answers it in its own words (MARK_FAILED_TEXT), so `reason` is only the error's message.
    markRunMock.mockRejectedValue(new Error(reason))
    await click('[data-feedback-submit]')
    await flushRender()
    expect(markRunMock).toHaveBeenCalledTimes(1)
  }

  it('RETAINED-KEEPS-DRAFT: a refused mark keeps the draft, announces it and shows the denial as an alert', async () => {
    await renderAt(`/runs/${RUN_ID}`)
    await retainOnHeader('Confirmation was denied')
    expect(q('[data-feedback-composer]')!.getAttribute('data-feedback-state')).toBe('retained')
    expect(q('[data-feedback-status]')!.textContent).toBe(DRAFT_KEPT_STATUS)
    const denied = q('[data-feedback-denied]')
    expect(denied, 'no denial in the composer').not.toBeNull()
    expect(denied!.getAttribute('role')).toBe('alert')
    expect(denied!.textContent).toContain(MARK_FAILED_TEXT)
    expect(noteField()!.value).toBe('keep this note')
    expect(q(`[data-feedback-choice="${FEEDBACK_CHOICE_ORDER.failed[0]}"] [role="radio"]`)!.getAttribute('aria-checked')).toBe('true')
  })

  it('STATUS-PER-ADDRESS: another address shows its own empty status and no denial; returning shows the retained one again', async () => {
    fetchMarkPreviewMock.mockResolvedValue({ kind: 'read', result: CONSEQUENCES })
    await renderAt(`/runs/${RUN_ID}`)
    await retainOnHeader('Denied on the whole test')
    expect(q('[data-feedback-status]')!.textContent).toBe(DRAFT_KEPT_STATUS)

    await openStep('0:1')
    expect(q('[data-feedback-composer]')!.getAttribute('data-feedback-state')).toBe('composing')
    expect(q('[data-feedback-status]')!.textContent).toBe('')
    expect(q('[data-feedback-denied]')).toBeNull()

    await click('[data-feedback-entry="test"]')
    expect(composerTarget()).toBe('0:run')
    expect(q('[data-feedback-composer]')!.getAttribute('data-feedback-state')).toBe('retained')
    expect(q('[data-feedback-status]')!.textContent).toBe(DRAFT_KEPT_STATUS)
    expect(q('[data-feedback-denied]')!.textContent).toContain(MARK_FAILED_TEXT)
  })
})

// WHERE A TEST-LEVEL MARK LANDS, AND WHICH PREVIEW MAY AUTHORISE IT (426-06 · D-14, D-16, D-19). The
// resolved step is the read's own answer — its reason keys the sentence and nothing on the page scans
// the steps. The preview on screen is exact: a note never re-fetches, an older answer never overwrites
// a newer one, and Send feedback waits for the read computed for the form as it is now, while the last
// read stays on screen, dimmed, instead of blanking.
function previewOf(over: Record<string, unknown>): RunsMarkPreviewResult {
  return RunsMarkPreviewResultSchema.parse({
    kind: 'consequences',
    runId: RUN_ID,
    prospective: true,
    markKind: 'false-fail',
    member: { testIndex: 0, testId: TEST_ID },
    resolvedStep: { stepIndex: 2, reason: 'failing-step' },
    latest: { kind: 'first' },
    basis: { ledgerOrdinal: 0 },
    markedDecisionCount: 1,
    groundTruth: [],
    labels: [],
    knowledge: { servedRecordIds: [], appendsEvidence: false, records: [], evidence: { confirmed: 0, overturned: 0 } },
    draft: { kind: 'no-draftable-fix', checked: { servedRecords: 0, procedureReads: 0, assertionDrift: false } },
    ...over,
  })
}

const CONSEQUENCES_STEP_3 = previewOf({})
const QUARANTINED_STEP_3 = RunsMarkPreviewResultSchema.parse({
  kind: 'quarantined', runId: RUN_ID, prospective: true, markKind: 'false-fail', member: { testIndex: 0, testId: TEST_ID },
  resolvedStep: { stepIndex: 2, reason: 'failing-step' }, latest: { kind: 'first' }, basis: { ledgerOrdinal: 0 }, class: 'timeout',
})
const ALREADY_MARKED = RunsMarkPreviewResultSchema.parse({
  kind: 'already-marked', runId: RUN_ID,
  prior: { ...receipt, testIndex: 0, testId: TEST_ID }, basis: { ledgerOrdinal: 1, priorMarkOrdinal: 1 },
})
const RUN_NOT_FOUND = RunsMarkPreviewResultSchema.parse({ kind: 'run-not-found', runId: RUN_ID })
const CONFIRMED_BUG = previewOf({ markKind: 'confirmed-bug', draft: { kind: 'confirmed-bug' } })

const resolvedLine = () => q('[data-feedback-resolved-step]')
const previewSection = () => q('[data-feedback-preview]')!
const selectedRowId = () => q('[role="treeitem"][aria-selected="true"]')?.getAttribute('data-step-id') ?? null

async function pickAndAdvance(kind: string) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  await click(`[data-feedback-choice="${kind}"] [role="radio"]`)
  await act(async () => { vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS) })
  vi.useRealTimers()
  await flushRender()
}

describe('426-06 the resolved step and Show step', () => {
  beforeEach(() => {
    fetchRunDetailMock.mockResolvedValue(fourSteps)
  })

  it('RESOLVED-STEP-LINE-ARMS: a current consequences or quarantined read names the resolved step; other arms and step targets do not', async () => {
    const kind = FEEDBACK_CHOICE_ORDER.failed[0]
    const expected = resolvedStepText('failing-step', kind, 3, 4)!
    for (const [read, shown] of [[CONSEQUENCES_STEP_3, true], [QUARANTINED_STEP_3, true], [ALREADY_MARKED, false], [RUN_NOT_FOUND, false]] as const) {
      await renderAt(`/runs/${RUN_ID}`)
      await click('[data-feedback-entry="test"]')
      const answer = deferred<MarkPreviewRead>()
      await pickFirstChoiceAndLandPreview(answer.promise)
      expect(resolvedLine()).toBeNull()
      const pending = q('[data-feedback-resolved-step-pending]')
      expect(pending, 'no skeleton holds the resolved-step slot while the first preview loads').not.toBeNull()
      expect(pending!.className).toContain('h-4')
      expect(pending!.className).toContain('w-3/4')
      expect(pending!.className).toContain('motion-reduce:animate-none')

      await act(async () => answer.resolve({ kind: 'read', result: read }))
      await flushRender()
      expect(previewSection().getAttribute('data-preview-current')).toBe('true')
      expect(q('[data-feedback-resolved-step-pending]')).toBeNull()
      if (shown) {
        const line = resolvedLine()
        expect(line, `no resolved-step line for ${read.kind}`).not.toBeNull()
        expect(line!.getAttribute('data-resolved-reason')).toBe('failing-step')
        expect(line!.textContent).toContain(expected)
        expect(line!.querySelector('[data-feedback-show-step]')?.textContent).toBe(showStepLabel(3))
        const choices = q('[data-feedback-choices]')!.closest('fieldset')!
        expect(choices.nextElementSibling).toBe(line)
      } else {
        expect(resolvedLine(), `a resolved-step line for ${read.kind}`).toBeNull()
      }
      act(() => root!.unmount())
      container!.remove()
      root = null
      container = null
      fetchMarkPreviewMock.mockReset()
    }

    fetchMarkPreviewMock.mockResolvedValue({ kind: 'read', result: CONSEQUENCES_STEP_3 })
    await renderAt(`/runs/${RUN_ID}`)
    await openStep('0:1')
    await pickAndAdvance(kind)
    expect(previewSection().getAttribute('data-preview-current')).toBe('true')
    expect(resolvedLine()).toBeNull()
    expect(q('[data-feedback-resolved-step-pending]')).toBeNull()
  })

  it('SHOW-STEP-SELECTS-WITHOUT-RETARGET: Show step selects that step and the composer keeps its test target with no pinned line', async () => {
    fetchMarkPreviewMock.mockResolvedValue({ kind: 'read', result: CONSEQUENCES_STEP_3 })
    await renderAt(`/runs/${RUN_ID}`)
    await click('[data-feedback-entry="test"]')
    await pickAndAdvance(FEEDBACK_CHOICE_ORDER.failed[0])
    expect(selectedRowId()).toBe('0:0')
    const show = q('[data-feedback-show-step]')
    expect(show, 'no Show step button').not.toBeNull()

    await click('[data-feedback-show-step]')
    expect(selectedRowId()).toBe('0:2')
    expect(composerTarget()).toBe('0:run')
    expect(q('[data-feedback-pinned]')).toBeNull()
    expect(fetchMarkPreviewMock).toHaveBeenCalledTimes(1)
  })
})

describe('426-06 the preview on screen is exact', () => {
  beforeEach(() => {
    fetchRunDetailMock.mockResolvedValue(fourSteps)
  })

  it('NOTE-DOES-NOT-REFETCH: typing a note fetches nothing, and the landed preview stays current and undimmed', async () => {
    fetchMarkPreviewMock.mockResolvedValue({ kind: 'read', result: CONSEQUENCES_STEP_3 })
    await renderAt(`/runs/${RUN_ID}`)
    await click('[data-feedback-entry="test"]')
    await pickAndAdvance(FEEDBACK_CHOICE_ORDER.failed[0])
    expect(fetchMarkPreviewMock).toHaveBeenCalledTimes(1)
    expect(previewSection().querySelector('dl'), 'the landed preview shows no lines').not.toBeNull()

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await typeNote('the coupon field vanished')
    await act(async () => { vi.advanceTimersByTime(2 * PREVIEW_DEBOUNCE_MS) })
    vi.useRealTimers()
    await flushRender()
    expect(fetchMarkPreviewMock).toHaveBeenCalledTimes(1)
    expect(previewSection().getAttribute('data-preview-current')).toBe('true')
    expect(previewSection().getAttribute('aria-busy')).toBe('false')
    expect(previewSection().textContent).not.toContain(PREVIEW_UPDATING_TEXT)
    expect(q('[data-feedback-submit]')!.getAttribute('aria-disabled')).toBe('false')
  })

  it('PREVIEW-STALE-DROPPED: an older answer landing after a newer one never replaces it', async () => {
    const first = deferred<MarkPreviewRead>()
    const second = deferred<MarkPreviewRead>()
    fetchMarkPreviewMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    await renderAt(`/runs/${RUN_ID}`)
    await click('[data-feedback-entry="test"]')
    const [a, b] = FEEDBACK_CHOICE_ORDER.failed
    await pickAndAdvance(a)
    await pickAndAdvance(b)
    expect(fetchMarkPreviewMock).toHaveBeenCalledTimes(2)
    expect((fetchMarkPreviewMock.mock.calls[1]![1] as { kind: string }).kind).toBe(b)

    await act(async () => second.resolve({ kind: 'read', result: CONFIRMED_BUG }))
    await flushRender()
    await act(async () => first.resolve({ kind: 'read', result: CONSEQUENCES_STEP_3 }))
    await flushRender()
    expect(previewSection().getAttribute('data-preview-state')).toBe('consequences')
    expect(previewSection().getAttribute('data-preview-current')).toBe('true')
    const change = q('[data-preview-line="change"]')
    expect(change, 'the preview lines are not on the page').not.toBeNull()
    expect(change!.textContent).toBe(previewFixText({ kind: 'confirmed-bug' }))
    expect(q('[data-feedback-submit]')!.getAttribute('aria-disabled')).toBe('false')
  })

  it('SUBMIT-NEEDS-CURRENT-PREVIEW: a new pick keeps the old read on screen, dimmed, and locks Send feedback until its own read lands', async () => {
    const later = deferred<MarkPreviewRead>()
    fetchMarkPreviewMock.mockResolvedValueOnce({ kind: 'read', result: CONSEQUENCES_STEP_3 }).mockReturnValueOnce(later.promise)
    await renderAt(`/runs/${RUN_ID}`)
    await click('[data-feedback-entry="test"]')
    const [a, b] = FEEDBACK_CHOICE_ORDER.failed
    await pickAndAdvance(a)
    expect(previewSection().getAttribute('data-preview-current')).toBe('true')
    expect(q('[data-feedback-submit]')!.getAttribute('aria-disabled')).toBe('false')

    await pickAndAdvance(b)
    expect(previewSection().getAttribute('data-preview-current')).toBe('false')
    expect(q('[data-feedback-submit]')!.getAttribute('aria-disabled')).toBe('true')
    expect(q('[data-feedback-submit-reason]')!.textContent).toBe(SUBMIT_REASON_CHECKING)
    expect(previewSection().querySelector('dl'), 'the old read blanked while the new one loads').not.toBeNull()
    expect(previewSection().querySelector('.opacity-60')).not.toBeNull()
    expect(previewSection().textContent).toContain(PREVIEW_UPDATING_TEXT)
    expect(previewSection().getAttribute('aria-busy')).toBe('true')
    await click('[data-feedback-submit]')
    expect(markRunMock).not.toHaveBeenCalled()

    await act(async () => later.resolve({ kind: 'read', result: CONFIRMED_BUG }))
    await flushRender()
    expect(previewSection().getAttribute('data-preview-current')).toBe('true')
    expect(q('[data-feedback-submit]')!.getAttribute('aria-disabled')).toBe('false')
    expect(previewSection().querySelector('.opacity-60')).toBeNull()
  })
})

// NO BLIND SUBMIT (426-07 · D-18, D-19). A quarantined mark still records; an identical repeat, a
// refusal and a failed read leave Send feedback aria-disabled with its reason on the page, so the
// button stays reachable and says why. Recording happens only on an explicit Send feedback — never
// when a preview lands, on Enter in the note, or on Retry.
const PAGE_REFUSALS: Record<(typeof MARK_PREVIEW_REFUSALS)[number], RunsMarkPreviewResult> = {
  'run-not-found': RUN_NOT_FOUND,
  'member-not-found': RunsMarkPreviewResultSchema.parse({ kind: 'member-not-found', runId: RUN_ID, testId: TEST_ID }),
  'step-not-found': RunsMarkPreviewResultSchema.parse({ kind: 'step-not-found', runId: RUN_ID, testIndex: 0, stepIndex: 4, stepCount: 4 }),
  'ambiguous-address': RunsMarkPreviewResultSchema.parse({
    kind: 'ambiguous-address', runId: RUN_ID, candidates: [{ testIndex: 0, testId: TEST_ID }, { testIndex: 1, testId: TEST_ID }],
  }),
}
const PAGE_READ_FAILURES = ['network', 'ledger-corrupt', 'ledger-unavailable', 'refused', 'shape'] as const satisfies readonly FeedbackReadFailure[]

const submitButton = () => q<HTMLButtonElement>('[data-feedback-submit]')!
const submitReason = () => q('[data-feedback-submit-reason]')!.textContent

function unmountPage() {
  act(() => root!.unmount())
  container!.remove()
  root = null
  container = null
}

async function openAndLand(read: MarkPreviewRead) {
  fetchMarkPreviewMock.mockResolvedValue(read)
  await renderAt(`/runs/${RUN_ID}`)
  await click('[data-feedback-entry="test"]')
  await pickAndAdvance(FEEDBACK_CHOICE_ORDER.failed[0])
  expect(previewSection().getAttribute('data-preview-current')).toBe('true')
}

async function pressEnter(element: HTMLElement) {
  await act(async () => {
    element.focus()
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true }))
  })
  await flushRender()
}

/** A native button turns Enter into a click; jsdom does not, so the activation is dispatched too. */
async function activateWithEnter(button: HTMLButtonElement) {
  await pressEnter(button)
  await act(async () => { button.click() })
  await flushRender()
}

describe('426-07 each preview arm decides Send feedback on the page', () => {
  beforeEach(() => {
    fetchRunDetailMock.mockResolvedValue(fourSteps)
  })

  it('QUARANTINED-SUBMITS: a quarantined read still records, but only on an explicit Send feedback', async () => {
    markRunMock.mockResolvedValue({ kind: 'marked', receipt })
    await openAndLand({ kind: 'read', result: QUARANTINED_STEP_3 })
    expect(previewSection().getAttribute('data-preview-state')).toBe('quarantined')
    const block = q('[data-preview-line="quarantined"]')
    expect(block, 'no quarantined block on the page').not.toBeNull()
    expect(block!.textContent).toBe(quarantinedText('timeout'))
    expect(submitButton().getAttribute('aria-disabled')).toBe('false')
    expect(submitReason()).toBe('')
    expect(markRunMock).not.toHaveBeenCalled()

    await pressEnter(q<HTMLTextAreaElement>('[data-feedback-note]')!)
    expect(markRunMock).not.toHaveBeenCalled()

    await click('[data-feedback-submit]')
    expect(markRunMock).toHaveBeenCalledTimes(1)
    expect(markRunMock.mock.calls[0]![1]).toMatchObject({ kind: FEEDBACK_CHOICE_ORDER.failed[0], testId: TEST_ID })
  })

  it('ALREADY-MARKED-BLOCKS: an identical repeat says so and leaves Send feedback blocked with its reason', async () => {
    await openAndLand({ kind: 'read', result: ALREADY_MARKED })
    expect(previewSection().getAttribute('data-preview-state')).toBe('already-marked')
    expect(q('[data-preview-line="already-marked"]')?.textContent).toBe(alreadyMarkedText())
    expect(resolvedLine()).toBeNull()
    expect(submitButton().getAttribute('aria-disabled')).toBe('true')
    expect(submitReason()).toBe(SUBMIT_REASON_ALREADY_MARKED)
    await click('[data-feedback-submit]')
    expect(markRunMock).not.toHaveBeenCalled()
  })

  it('REFUSAL-BLOCKS: each refusal arm reads its sentence, keeps the three choices, and leaves Send feedback blocked', async () => {
    for (const kind of MARK_PREVIEW_REFUSALS) {
      const read = PAGE_REFUSALS[kind]
      await openAndLand({ kind: 'read', result: read })
      expect(previewSection().getAttribute('data-preview-state'), kind).toBe('refused')
      const refusal = q(`[data-preview-refusal="${kind}"]`)
      expect(refusal, `no ${kind} refusal on the page`).not.toBeNull()
      expect(refusal!.textContent).toBe(previewRefusalText(read as never))
      expect(resolvedLine()).toBeNull()
      expect(container!.querySelectorAll('[data-feedback-choice] [role="radio"]')).toHaveLength(3)
      expect(submitButton().getAttribute('aria-disabled'), kind).toBe('true')
      expect(submitReason(), kind).toBe(SUBMIT_REASON_REFUSED)
      await click('[data-feedback-submit]')
      expect(markRunMock, kind).not.toHaveBeenCalled()
      unmountPage()
      fetchMarkPreviewMock.mockReset()
    }
  })

  it('FAILED-READ-BLOCKS: each failed read names its reason with Retry and the CLI line, and leaves Send feedback blocked', async () => {
    for (const failure of PAGE_READ_FAILURES) {
      await openAndLand({ kind: 'failed', reason: failure })
      expect(previewSection().getAttribute('data-preview-state'), failure).toBe('failed')
      const denial = previewSection().querySelector('[data-entry="denial"]')
      expect(denial, `no ${failure} failure block on the page`).not.toBeNull()
      expect(denial!.textContent).toBe(PREVIEW_READ_FAILED_TEXT(feedbackReadFailureReason(failure)))
      expect(q('[data-feedback-preview-retry]')?.getAttribute('aria-label')).toBe(PREVIEW_RETRY_ACCESSIBLE_NAME)
      expect(resolvedLine()).toBeNull()
      expect(container!.querySelectorAll('[data-feedback-choice] [role="radio"]')).toHaveLength(3)
      expect(submitButton().getAttribute('aria-disabled'), failure).toBe('true')
      expect(submitReason(), failure).toBe(SUBMIT_REASON_PREVIEW_FAILED)
      await click('[data-feedback-submit]')
      expect(markRunMock, failure).not.toHaveBeenCalled()
      unmountPage()
      fetchMarkPreviewMock.mockReset()
    }
  })

  it('PREVIEW-FAILED-RETRY: Retry asks again with the identical body, records nothing, and a consequences answer enables Send feedback', async () => {
    const again = deferred<MarkPreviewRead>()
    fetchMarkPreviewMock.mockResolvedValueOnce({ kind: 'failed', reason: 'network' }).mockReturnValueOnce(again.promise)
    await renderAt(`/runs/${RUN_ID}`)
    await click('[data-feedback-entry="test"]')
    await pickAndAdvance(FEEDBACK_CHOICE_ORDER.failed[0])
    expect(fetchMarkPreviewMock).toHaveBeenCalledTimes(1)
    const retry = q<HTMLButtonElement>('[data-feedback-preview-retry]')
    expect(retry, 'no Retry on the page').not.toBeNull()

    await click('[data-feedback-preview-retry]')
    expect(fetchMarkPreviewMock).toHaveBeenCalledTimes(2)
    expect(fetchMarkPreviewMock.mock.calls[1]).toEqual(fetchMarkPreviewMock.mock.calls[0])
    expect(previewSection().getAttribute('aria-busy')).toBe('true')
    expect(submitButton().getAttribute('aria-disabled')).toBe('true')

    await act(async () => again.resolve({ kind: 'read', result: CONSEQUENCES_STEP_3 }))
    await flushRender()
    expect(previewSection().getAttribute('data-preview-state')).toBe('consequences')
    expect(previewSection().getAttribute('data-preview-current')).toBe('true')
    expect(previewSection().getAttribute('aria-busy')).toBe('false')
    expect(submitButton().getAttribute('aria-disabled')).toBe('false')
    expect(markRunMock).not.toHaveBeenCalled()
  })

  it('SUBMIT-ARIA-DISABLED-FOCUSABLE: the blocked button is never disabled, takes focus, names its reason, and Enter records nothing', async () => {
    await renderAt(`/runs/${RUN_ID}`)
    await click('[data-feedback-entry="test"]')
    const submit = submitButton()
    expect(submit.hasAttribute('disabled')).toBe(false)
    expect(submit.getAttribute('aria-disabled')).toBe('true')
    expect(submit.className).toContain('aria-disabled:opacity-50')
    expect(submit.className).toContain('aria-disabled:cursor-not-allowed')
    expect(submitReason()).toBe(SUBMIT_REASON_NO_CHOICE)
    const describedBy = submit.getAttribute('aria-describedby')
    expect(describedBy).not.toBeNull()
    expect(document.getElementById(describedBy!)).toBe(q('[data-feedback-submit-reason]'))

    act(() => submit.focus())
    expect(document.activeElement).toBe(submit)
    await activateWithEnter(submit)
    expect(markRunMock).not.toHaveBeenCalled()

    fetchMarkPreviewMock.mockResolvedValue({ kind: 'read', result: ALREADY_MARKED })
    await pickAndAdvance(FEEDBACK_CHOICE_ORDER.failed[0])
    const blocked = submitButton()
    expect(blocked.hasAttribute('disabled')).toBe(false)
    expect(submitReason()).toBe(SUBMIT_REASON_ALREADY_MARKED)
    await activateWithEnter(blocked)
    expect(document.activeElement).toBe(blocked)
    expect(markRunMock).not.toHaveBeenCalled()
  })

  it('SUBMIT-SENDING-BLOCKS: while a mark is in flight the status says so and Send feedback is blocked as Sending…', async () => {
    const sent = deferred<unknown>()
    markRunMock.mockReturnValue(sent.promise)
    await openAndLand({ kind: 'read', result: CONSEQUENCES_STEP_3 })
    await click('[data-feedback-submit]')
    expect(markRunMock).toHaveBeenCalledTimes(1)
    expect(q('[data-feedback-status]')!.textContent).toBe(SENDING_STATUS)
    expect(submitButton().getAttribute('aria-disabled')).toBe('true')
    expect(submitReason()).toBe(SUBMIT_REASON_SENDING)
    await click('[data-feedback-submit]')
    expect(markRunMock).toHaveBeenCalledTimes(1)
    await act(async () => sent.resolve({ kind: 'marked', receipt }))
    await flushRender()
  })

  it('NO-STEPS-REFUSAL: a test that recorded no steps keeps its entry, and the preview refuses in plain words with Send feedback blocked', async () => {
    fetchRunDetailMock.mockResolvedValue(projection({
      members: [member(0, { testId: TEST_ID, outcome: 'failed', marks: [] })],
      steps: [],
    }))
    const noSteps = RunsMarkPreviewResultSchema.parse({ kind: 'step-not-found', runId: RUN_ID, testIndex: 0, stepIndex: 0, stepCount: 0 })
    fetchMarkPreviewMock.mockResolvedValue({ kind: 'read', result: noSteps })
    await renderAt(`/runs/${RUN_ID}`)
    expect(container!.querySelectorAll('[data-feedback-entry="test"]')).toHaveLength(1)
    await click('[data-feedback-entry="test"]')
    await pickAndAdvance(FEEDBACK_CHOICE_ORDER.failed[0])
    const refusal = q('[data-preview-refusal="step-not-found"]')
    expect(refusal, 'no step-not-found refusal on the page').not.toBeNull()
    expect(refusal!.textContent).toBe('This test recorded no steps, so there is nothing to mark.')
    expect(submitButton().getAttribute('aria-disabled')).toBe('true')
    expect(submitReason()).toBe(SUBMIT_REASON_REFUSED)
    await click('[data-feedback-submit]')
    expect(markRunMock).not.toHaveBeenCalled()
  })
})

// The note is named by its visible label and capped at 2000 characters.
const noteCounter = () =>
  [...q('[data-feedback-composer]')!.querySelectorAll('p')].find(entry => / \/ 2000$/.test(entry.textContent ?? ''))

describe('the note in the composer', () => {
  beforeEach(() => {
    fetchRunDetailMock.mockResolvedValue(fourSteps)
  })

  it('NOTE-VISIBLY-LABELLED: Note (optional) is a visible label for the note, which has no aria-label and holds at most 2000 characters', async () => {
    await renderAt(`/runs/${RUN_ID}`)
    await click('[data-feedback-entry="test"]')
    const note = noteField()!
    expect(note.id).not.toBe('')
    const label = [...q('[data-feedback-composer]')!.querySelectorAll('label')].find(entry => entry.htmlFor === note.id)
    expect(label?.textContent).toBe(NOTE_LABEL)
    expect(NOTE_LABEL).toBe('Note (optional)')
    expect(note.hasAttribute('aria-label')).toBe(false)
    expect(NOTE_MAX_LENGTH).toBe(2000)
    expect(note.maxLength).toBe(NOTE_MAX_LENGTH)
    expect(note.className).toContain('max-h-40')
    expect(note.className).toContain('overflow-y-auto')
  })

  it('NOTE-COUNTER: no counter below 1,800 characters; from 1,800 the count shows under the note and is not announced', async () => {
    await renderAt(`/runs/${RUN_ID}`)
    await click('[data-feedback-entry="test"]')
    expect(NOTE_COUNTER_FROM).toBe(1800)
    await typeNote('x'.repeat(NOTE_COUNTER_FROM - 1))
    expect(noteCounter()).toBeUndefined()
    await typeNote('x'.repeat(NOTE_COUNTER_FROM))
    const counter = noteCounter()
    expect(counter, 'no counter at 1,800 characters').not.toBeUndefined()
    expect(noteCounterText(1800)).toBe('1800 / 2000')
    expect(counter!.textContent).toBe(noteCounterText(1800))
    expect(counter!.getAttribute('aria-live')).toBe('off')
    expect(counter!.className).toContain('tabular-nums')
  })
})

// AFTERWARDS (426-09 · D-21, D-22). History is read when the composer opens, on every re-target and
// after a matched receipt — never on mount — and an older read landing late is dropped. After a
// matched receipt the composer stays open with the new mark first in the target's history. The
// preview's replaced and already-said times come from that history, and nothing but the review
// command ever reaches the clipboard.
const T_MARK = Date.UTC(2026, 8, 23, 10, 41)
const historyMarkId = (n: number) => `mark_${n.toString(16).padStart(12, '0')}`

function historyOf(entries: readonly (Record<string, unknown> & { n: number })[]): MarksHistoryRead {
  return {
    kind: 'read',
    result: RunsMarksHistoryResultSchema.parse({
      kind: 'history',
      runId: RUN_ID,
      entries: entries.map(({ n, ...entry }) => ({
        markId: historyMarkId(n),
        runId: RUN_ID,
        testIndex: 0,
        kind: 'false-fail',
        origin: 'user',
        ordinal: n,
        markedAt: T_MARK + n * 60_000,
        disposition: { kind: 'no-draftable-fix', checked: { servedRecords: 0, procedureReads: 0, assertionDrift: false } },
        gold: [],
        evidence: { confirmed: 0, overturned: 0 },
        active: true,
        ...entry,
      })),
    }),
  }
}

const historyEntryIds = (selector: string) =>
  [...(q(selector)?.querySelectorAll('[data-history-entry]') ?? [])].map(entry => entry.getAttribute('data-mark-id'))

describe('426-09 the history read', () => {
  beforeEach(() => {
    fetchRunDetailMock.mockResolvedValue(fourSteps)
    fetchMarkPreviewMock.mockResolvedValue({ kind: 'read', result: CONSEQUENCES_STEP_3 })
  })

  it('HISTORY-READ-ON-OPEN: none on mount, one on open, one more on re-target, one more after a matched receipt', async () => {
    const stepReceipt: RunDetailMemberMark = { markId: historyMarkId(1), kind: FEEDBACK_CHOICE_ORDER.failed[0], ordinal: 1, stepIndex: 3,
      disposition: { kind: 'no-draftable-fix', checked: { servedRecords: 0, procedureReads: 0, assertionDrift: false } } }
    const marked = projection({ ...fourSteps, members: [{ ...fourSteps.members[0]!, marks: [stepReceipt] }] })
    fetchRunDetailMock.mockImplementation(async () => markRunMock.mock.calls.length > 0 ? marked : fourSteps)
    markRunMock.mockResolvedValue({ kind: 'marked', receipt: stepReceipt })
    fetchMarksHistoryMock.mockResolvedValue(historyOf([]))
    await renderAt(`/runs/${RUN_ID}`)
    await flushRender()
    expect(fetchMarksHistoryMock).not.toHaveBeenCalled()

    await openStep('0:1')
    expect(fetchMarksHistoryMock).toHaveBeenCalledTimes(1)
    expect(fetchMarksHistoryMock).toHaveBeenLastCalledWith(RUN_ID)

    await selectStep('0:3')
    await click('[data-feedback-switch]')
    expect(composerTarget()).toBe('0:3')
    expect(fetchMarksHistoryMock).toHaveBeenCalledTimes(2)

    await pickAndAdvance(FEEDBACK_CHOICE_ORDER.failed[0])
    expect(fetchMarksHistoryMock).toHaveBeenCalledTimes(2)
    await click('[data-feedback-submit]')
    await flushRender()
    expect(markRunMock).toHaveBeenCalledTimes(1)
    expect(q('[data-feedback-composer]')!.getAttribute('data-feedback-state')).toBe('recorded')
    expect(fetchMarksHistoryMock).toHaveBeenCalledTimes(3)
  })

  it('HISTORY-STALE-DROPPED: a read for the previous target landing after the current one is dropped', async () => {
    const first = deferred<MarksHistoryRead>()
    const second = deferred<MarksHistoryRead>()
    fetchMarksHistoryMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    await renderAt(`/runs/${RUN_ID}`)
    await openStep('0:1')
    await selectStep('0:3')
    await click('[data-feedback-switch]')
    expect(fetchMarksHistoryMock).toHaveBeenCalledTimes(2)
    expect(q('[data-feedback-history="target"]')?.getAttribute('data-history-state')).toBe('loading')

    await act(async () => second.resolve(historyOf([{ n: 1, stepIndex: 3 }])))
    await flushRender()
    await act(async () => first.resolve(historyOf([{ n: 1, stepIndex: 1 }, { n: 2, stepIndex: 1, kind: 'false-pass' }])))
    await flushRender()
    expect(historyEntryIds('[data-feedback-history="target"]')).toEqual([historyMarkId(1)])
    expect(q('[data-feedback-history="target"]')!.getAttribute('data-history-state')).toBe('history')
    expect(container!.querySelectorAll(`[data-history-entry][data-mark-id="${historyMarkId(2)}"]`)).toHaveLength(0)
  })
})

describe('426-09 the receipt shows in history', () => {
  const PRIOR = historyMarkId(1)
  const RECEIPT: RunDetailMemberMark = {
    markId: historyMarkId(2),
    kind: FEEDBACK_CHOICE_ORDER.failed[0],
    ordinal: 2,
    disposition: { kind: 'applied', fix: 'caution', change: { kind: 'knowledge', changeId: 'prop_0123456789ab', recordIds: ['mem_page_1'] } },
  }
  const before = historyOf([{ n: 1, kind: 'confirmed-bug', disposition: { kind: 'confirmed-bug', confirmedRecords: 0 } }])
  const after = historyOf([
    { n: 1, kind: 'confirmed-bug', disposition: { kind: 'confirmed-bug', confirmedRecords: 0 }, active: false, supersededBy: RECEIPT.markId },
    { n: 2, kind: RECEIPT.kind, supersedes: PRIOR, disposition: RECEIPT.disposition, changedRecords: CHANGED },
  ])

  it('RECEIPT-SHOWS-IN-HISTORY: the composer stays open, the form resets, and the new mark leads the target list, scrolled into view', async () => {
    const recorded = projection({ ...initial, members: [{ ...initial.members[0]!, marks: [RECEIPT] }] })
    fetchRunDetailMock.mockImplementation(async () => markRunMock.mock.calls.length > 0 ? recorded : initial)
    fetchMarksHistoryMock.mockImplementation(async () => markRunMock.mock.calls.length > 0 ? after : before)
    markRunMock.mockResolvedValue({ kind: 'marked', receipt: RECEIPT })
    await renderAt(`/runs/${RUN_ID}`)
    await click('[data-feedback-entry="test"]')
    expect(historyEntryIds('[data-feedback-history="target"]')).toEqual([PRIOR])
    await pickFirstChoiceAndLandPreview(Promise.resolve({ kind: 'read', result: CONSEQUENCES }))
    expect(q('[data-feedback-submit]')!.getAttribute('aria-disabled')).toBe('false')
    const scroll = vi.mocked(Element.prototype.scrollIntoView)
    scroll.mockClear()
    const focusedBefore = document.activeElement

    await click('[data-feedback-submit]')
    await flushRender()
    const composer = q('[data-feedback-composer]')
    expect(composer, 'the composer closed after a matched receipt').not.toBeNull()
    expect(composer!.getAttribute('data-feedback-state')).toBe('recorded')
    expect(container!.querySelectorAll('[data-feedback-choice] [role="radio"][aria-checked="true"]')).toHaveLength(0)
    expect(q('[data-feedback-preview]')!.getAttribute('data-preview-state')).toBe('idle')
    expect(historyEntryIds('[data-feedback-history="target"]')).toEqual([RECEIPT.markId, PRIOR])
    const fresh = container!.querySelectorAll<HTMLElement>('[data-history-new]')
    expect(fresh).toHaveLength(1)
    expect(fresh[0]!.getAttribute('data-mark-id')).toBe(RECEIPT.markId)
    expect(q('[data-feedback-history="target"] [data-history-entry]')).toBe(fresh[0])
    expect(q('[data-feedback-status]')!.textContent).toBe(feedbackRecordedText(RECEIPT.disposition))
    expect(q('[data-feedback-entry="test"]')!.getAttribute('data-feedback-marked')).toBe('true')
    expect(scroll.mock.contexts).toContain(fresh[0])
    expect(scroll.mock.calls.at(-1)?.[0]).toMatchObject({ block: 'nearest' })
    expect(document.activeElement).toBe(focusedBefore)

    await click(`[data-feedback-choice="${FEEDBACK_CHOICE_ORDER.failed[1]}"] [role="radio"]`)
    expect(q('[data-feedback-composer]')!.getAttribute('data-feedback-state')).toBe('composing')
    expect(container!.querySelectorAll('[data-history-new]')).toHaveLength(0)
  })
})

describe('426-09 the preview names its times from history', () => {
  const PRIOR = 'mark_0123456789ab'
  const SUPERSEDES = previewOf({ latest: { kind: 'supersedes', markId: PRIOR, ordinal: 1 }, basis: { ledgerOrdinal: 1, priorMarkOrdinal: 1 } })
  const loaded = historyOf([{ n: 1, markId: PRIOR, markedAt: T_MARK, disposition: receipt.disposition, changedRecords: CHANGED }])

  beforeEach(() => {
    fetchRunDetailMock.mockResolvedValue(fourSteps)
  })

  it('ARM-TIMES-FROM-HISTORY: with history loaded, the replaces and already-said lines name the earlier mark\'s time', async () => {
    fetchMarksHistoryMock.mockResolvedValue(loaded)
    await openAndLand({ kind: 'read', result: SUPERSEDES })
    expect(q('[data-preview-line="replaces"]')?.textContent).toBe(replacesLine(1, formatMarkTime(T_MARK)))
    unmountPage()

    await openAndLand({ kind: 'read', result: ALREADY_MARKED })
    expect(q('[data-preview-line="already-marked"]')?.textContent).toBe(alreadyMarkedText(formatMarkTime(T_MARK)))
  })

  it('ARM-TIMES-FROM-HISTORY: before history loads, or when the earlier mark is not in it, both lines drop the time', async () => {
    fetchMarksHistoryMock.mockReturnValue(new Promise(() => {}))
    await openAndLand({ kind: 'read', result: SUPERSEDES })
    expect(q('[data-preview-line="replaces"]')?.textContent).toBe(replacesLine(1, undefined))
    unmountPage()

    await openAndLand({ kind: 'read', result: ALREADY_MARKED })
    expect(q('[data-preview-line="already-marked"]')?.textContent).toBe(alreadyMarkedText())
    unmountPage()

    fetchMarksHistoryMock.mockResolvedValue(historyOf([{ n: 1, stepIndex: 2 }]))
    await openAndLand({ kind: 'read', result: SUPERSEDES })
    expect(q('[data-preview-line="replaces"]')?.textContent).toBe(replacesLine(1, undefined))
  })
})

// RE-SPELLED 432-09 (D-25) from '426-09 only the review command reaches the clipboard': no review
// command remains, so nothing on the page writes the clipboard, and history names what changed.
describe('432-09 no review command, and nothing reaches the clipboard', () => {
  it('C432-NO-REVIEW-CTA: history names the applied change with no review control; typing a note or opening details writes nothing', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    try {
      fetchRunDetailMock.mockResolvedValue(fourSteps)
      fetchMarksHistoryMock.mockResolvedValue(
        historyOf([{ n: 1, note: 'the coupon field vanished', disposition: receipt.disposition, changedRecords: CHANGED }]),
      )
      await renderAt(`/runs/${RUN_ID}`)
      const title = document.title
      await click('[data-feedback-entry="test"]')
      await typeNote('a private observation about the checkout')
      for (const button of [...q('[data-feedback-composer]')!.querySelectorAll<HTMLButtonElement>('button')]) {
        if (button.textContent === TECHNICAL_DETAILS_LABEL) await act(async () => { button.click() })
      }
      await flushRender()
      expect(q('[data-feedback-history="target"] [data-history-review]')).toBeNull()
      expect(q('[data-review-command]')).toBeNull()
      // RE-SPELLED 2026-10-03 (quick 261003-cpv, 432-UI-REVIEW fix 2): one line names the fix and
      // what it changed.
      expect(q('[data-feedback-history="target"] [data-history-applied="knowledge"]')?.textContent)
        .toBe('Recorded — a knowledge fact was added: mem_page_1 (content unavailable)')
      expect(writeText).not.toHaveBeenCalled()
      expect(document.title).toBe(title)
    } finally {
      delete (navigator as { clipboard?: unknown }).clipboard
    }
  })
})

// THE MARK'S APPROVAL IS ANSWERED IN THE COMPOSER (426-10 · D-20, SC4). While a mark this page started
// is in flight the page holds the confirm channel's claim, so the question lands in the composer's
// footer instead of the app shell's floating card — and it is page state, so closing the composer or
// looking at another address does not strand it.
function settleable() {
  let resolve!: (value: unknown) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

// RE-SPELLED 2026-10-01 (432-14, D-14): the mark's approval — the question in the composer, the
// claim on the page's confirm channel, the waiting link and the awaiting-approval state — is
// deleted. Each cell keeps its subject (what the page shows while one mark is in flight, across a
// close, across addresses, after a refusal and across a run change) and pins the one-request path.
describe('426-10 the mark approval is answered in the composer', () => {
  beforeEach(() => {
    fetchRunDetailMock.mockResolvedValue(fourSteps)
  })

  async function submitInFlight() {
    const sent = settleable()
    markRunMock.mockReturnValue(sent.promise)
    const before = markRunMock.mock.calls.length
    await openAndLand({ kind: 'read', result: CONSEQUENCES_STEP_3 })
    await click('[data-feedback-submit]')
    expect(markRunMock.mock.calls.length - before).toBe(1)
    await flushRender()
    return { sent }
  }

  const approvalSurface = () => q('[data-feedback-approval], [data-confirm-answer], [data-confirm-outcome], [data-feedback-approval-waiting]')
  const state = () => q('[data-feedback-composer]')!.getAttribute('data-feedback-state')

  it('APPROVAL-INLINE-END-TO-END: one submit is one mark, in flight with no question, then recorded', async () => {
    const marked = projection({ ...fourSteps, members: [{ ...fourSteps.members[0]!, marks: [receipt] }] })
    fetchRunDetailMock.mockImplementation(async () => markRunMock.mock.calls.length > 0 ? marked : fourSteps)
    const { sent } = await submitInFlight()
    expect(state()).toBe('submitting')
    expect(q('[data-feedback-submit]'), 'Send feedback left the composer while the mark was in flight').not.toBeNull()
    expect(approvalSurface()).toBeNull()
    expect(document.querySelectorAll('[role="dialog"], [aria-modal], [inert]')).toHaveLength(0)

    await act(async () => sent.resolve({ kind: 'marked', receipt }))
    await flushRender()
    expect(state()).toBe('recorded')
    expect(markRunMock).toHaveBeenCalledTimes(1)
    expect(approvalSurface()).toBeNull()
  })

  it('APPROVAL-SURVIVES-CLOSE: closing the composer mid-flight and reopening shows the same mark still in flight', async () => {
    const marked = projection({ ...fourSteps, members: [{ ...fourSteps.members[0]!, marks: [receipt] }] })
    fetchRunDetailMock.mockImplementation(async () => markRunMock.mock.calls.length > 0 ? marked : fourSteps)
    const { sent } = await submitInFlight()
    await click('[data-feedback-close]')
    expect(q('[data-feedback-composer]')).toBeNull()
    await click('[data-feedback-entry="test"]')
    expect(state()).toBe('submitting')
    expect(approvalSurface()).toBeNull()
    await act(async () => sent.resolve({ kind: 'marked', receipt }))
    await flushRender()
    expect(state()).toBe('recorded')
    expect(markRunMock).toHaveBeenCalledTimes(1)
  })

  it('APPROVAL-WAITING-LINK: another address shows no waiting link, because nothing waits', async () => {
    await submitInFlight()
    await openStep('0:1')
    expect(composerTarget()).toBe('0:1')
    expect(approvalSurface()).toBeNull()
    expect(q('[data-feedback-approval-waiting]')).toBeNull()
  })

  it('APPROVAL-DENIAL-LINE-STAYS: a refused mark keeps its denial and Send feedback, and no question line', async () => {
    const { sent } = await submitInFlight()
    await act(async () => sent.reject(new Error('The mark could not be recorded here.')))
    await flushRender()
    expect(state()).toBe('retained')
    expect(q('[data-feedback-denied]')?.textContent).toContain(MARK_FAILED_TEXT)
    expect(q('[data-confirm-outcome]')).toBeNull()
    expect(q('[data-feedback-submit]')).not.toBeNull()
  })

  it('CLAIM-RELEASED-AFTER-MARK: a mark that settles after the page moved to another run changes nothing there', async () => {
    const RUN_B = generateRunId()
    fetchRunDetailMock.mockImplementation(async (id: string) => ({ ...fourSteps, runId: id }))
    const { sent } = await submitInFlight()
    await act(async () => { navigateTo!(`/runs/${RUN_B}`) })
    await flushRender()
    await act(async () => sent.resolve({ kind: 'marked', receipt }))
    await flushRender()
    expect(q('[data-feedback-composer]'), 'the old run\'s mark opened a composer on the new run').toBeNull()
    expect(markRunMock).toHaveBeenCalledTimes(1)
  })
})

// A controllable ResizeObserver: it records what each observer watches and reports a width only when
// a cell asks, so an observer that is never called back is the unmeasured page.
class StubResizeObserver {
  static live = new Set<StubResizeObserver>()
  readonly targets = new Set<Element>()
  constructor(readonly callback: ResizeObserverCallback) { StubResizeObserver.live.add(this) }
  observe(target: Element) { this.targets.add(target) }
  unobserve(target: Element) { this.targets.delete(target) }
  disconnect() {
    this.targets.clear()
    StubResizeObserver.live.delete(this)
  }
}

function pageRoot(): Element {
  return q('[data-resizable-group]')!.parentElement!
}

function pageRootObservers(): StubResizeObserver[] {
  const root = pageRoot()
  return [...StubResizeObserver.live].filter(observer => observer.targets.has(root))
}

async function resizePage(width: number) {
  const root = pageRoot()
  const watching = pageRootObservers()
  expect(watching, 'the page root is not observed').not.toHaveLength(0)
  const entry = {
    target: root,
    contentRect: { width, height: 900 },
    contentBoxSize: [{ inlineSize: width, blockSize: 900 }],
    borderBoxSize: [{ inlineSize: width, blockSize: 900 }],
    devicePixelContentBoxSize: [],
  } as unknown as ResizeObserverEntry
  await act(async () => {
    for (const observer of watching) observer.callback([entry], observer as unknown as ResizeObserver)
  })
  await flushRender()
}

describe('426-11 the open composer stacks under the evidence below 768px', () => {
  const group = () => q('[data-resizable-group]')!
  const panels = () => [...container!.querySelectorAll('[data-resizable-panel]')]
  const panelIds = () => panels().map(panel => panel.getAttribute('data-panel-id'))
  const composer = () => q('[data-feedback-composer]')

  beforeEach(() => {
    StubResizeObserver.live.clear()
    vi.stubGlobal('ResizeObserver', StubResizeObserver)
    mounts.tabPanels = 0
    mounts.stepTree = 0
  })

  it('STACKS-BELOW-768: at 400px the open composer is a third panel under the evidence, seeded 30/30/40, min 240px', async () => {
    await renderAt(`/runs/${RUN_ID}`)
    await resizePage(400)
    await click('[data-feedback-entry="test"]')

    expect(group().getAttribute('data-orientation')).toBe('vertical')
    expect(panelIds()).toEqual(['run-tree-stacked', 'run-evidence-stacked', 'run-feedback-stacked'])
    expect(JSON.parse(group().getAttribute('data-default-layout')!)).toEqual({
      'run-tree-stacked': 30,
      'run-evidence-stacked': 30,
      'run-feedback-stacked': 40,
    })
    expect(q('[data-panel-id="run-feedback-stacked"]')!.getAttribute('data-min-size')).toBe('"240px"')
    expect(container!.querySelectorAll('[data-resizable-handle]')).toHaveLength(2)
    expect(q('[data-panel-id="run-feedback-stacked"] [data-feedback-composer]')).not.toBeNull()
    expect(composer()!.getAttribute('data-feedback-layout')).toBe('stacked')
    expect(document.querySelectorAll('[role="dialog"],[aria-modal]')).toHaveLength(0)
  })

  it('DOCKED-AT-DESKTOP: at 1280px the open composer docks beside the evidence, seeded from the measured width', async () => {
    await renderAt(`/runs/${RUN_ID}`)
    await resizePage(1280)
    await click('[data-feedback-entry="test"]')

    expect(group().getAttribute('data-orientation')).toBe('horizontal')
    expect(panelIds()).toEqual(['run-tree', 'run-evidence', 'run-feedback'])
    expect(q('[data-panel-id="run-feedback"]')!.getAttribute('data-min-size')).toBe('"320px"')
    expect(q('[data-panel-id="run-feedback"]')!.getAttribute('data-max-size')).toBe('"50%"')
    expect(composer()!.getAttribute('data-feedback-layout')).toBe('docked')

    await resizePage(1024)
    expect(JSON.parse(group().getAttribute('data-default-layout')!)).toEqual(feedbackDefaultLayout('docked', 1024))
    expect(group().getAttribute('data-orientation')).toBe('horizontal')
  })

  it('UNMEASURED-IS-DOCKED: an observed page that never reports a width keeps the open composer docked', async () => {
    await renderAt(`/runs/${RUN_ID}`)
    expect(pageRootObservers(), 'the page root is not observed').not.toHaveLength(0)
    await click('[data-feedback-entry="test"]')

    expect(group().getAttribute('data-orientation')).toBe('horizontal')
    expect(panelIds()).toEqual(['run-tree', 'run-evidence', 'run-feedback'])
    expect(JSON.parse(group().getAttribute('data-default-layout')!)).toEqual(feedbackDefaultLayout('docked', 0))
    expect(composer()!.getAttribute('data-feedback-layout')).toBe('docked')
  })

  it('CLOSED-NEVER-STACKS: at 400px the closed page keeps the shipped two horizontal panels', async () => {
    await renderAt(`/runs/${RUN_ID}`)
    await resizePage(400)

    expect(group().getAttribute('data-orientation')).toBe('horizontal')
    expect(panelIds()).toEqual(['run-tree', 'run-evidence'])
    expect(panels().map(panel => [panel.getAttribute('data-default-size'), panel.getAttribute('data-min-size')]))
      .toEqual([['35', '20'], ['65', '30']])
    expect(group().hasAttribute('data-default-layout')).toBe(false)
    expect(container!.querySelectorAll('[data-resizable-handle]')).toHaveLength(1)

    await click('[data-feedback-entry="test"]')
    await click('[data-feedback-close]')
    expect(group().getAttribute('data-orientation')).toBe('horizontal')
    expect(panelIds()).toEqual(['run-tree', 'run-evidence'])
    expect(group().hasAttribute('data-default-layout')).toBe(false)
  })

  it('NO-REMOUNT-ON-LAYOUT-CHANGE: open, stack, dock and close mount the tree and the evidence exactly once', async () => {
    await renderAt(`/runs/${RUN_ID}`)
    await resizePage(1280)
    await click('[data-feedback-entry="test"]')
    expect(group().getAttribute('data-orientation')).toBe('horizontal')

    await resizePage(400)
    expect(group().getAttribute('data-orientation')).toBe('vertical')
    expect(panelIds()).toEqual(['run-tree-stacked', 'run-evidence-stacked', 'run-feedback-stacked'])

    await resizePage(1280)
    expect(group().getAttribute('data-orientation')).toBe('horizontal')
    await click('[data-feedback-close]')
    expect(panelIds()).toEqual(['run-tree', 'run-evidence'])

    expect(mounts.tabPanels).toBe(1)
    expect(mounts.stepTree).toBe(1)
  })
})

// NO PILL ANYWHERE (426-15 · SC1, SC2, D-05). The two doors are the only way to leave feedback, and the
// internal mark names appear only under Technical details. The page tests' stand-in for collapsible
// sections always renders Technical details, so that subtree is skipped rather than opened.
describe('426-15 the always-visible pills are gone', () => {
  it('NO-PILL-ANYWHERE: a marked suite with the composer open and a preview landed renders no pill and no internal mark name', async () => {
    const stepMark: RunDetailMemberMark = { markId: 'mark_0123456789ac', kind: 'confirmed-bug', ordinal: 2, stepIndex: 0,
      disposition: { kind: 'confirmed-bug', confirmedRecords: 0 } }
    const suite = suiteDetail({ marks: [stepMark] })
    fetchRunDetailMock.mockResolvedValue({ ...suite, members: [suite.members[0]!, { ...suite.members[1]!, marks: [receipt] }] })
    fetchRunAnalysisMock.mockResolvedValue({ runId: RUN_ID, verdicts: [{ perTest: 1, producer: 'deterministic-classifier', confidence: 0 }],
      sentences: [{ perTest: 1, sentence: 'Payment was declined' }], clusters: [] })
    fetchMarksHistoryMock.mockResolvedValue(historyOf([{ n: 1, kind: 'confirmed-bug', stepIndex: 0 }]))
    await renderAt(`/runs/${RUN_ID}`)
    expect(q('[data-verdict-block]'), 'the failed member\'s verdict block renders').not.toBeNull()

    await click('[data-feedback-entry="test"]')
    await pickFirstChoiceAndLandPreview(Promise.resolve({ kind: 'read', result: previewOf({
      markKind: FEEDBACK_CHOICE_ORDER.passed[0], member: { testIndex: 0, testId: SUITE_TEST_IDS[0] },
      resolvedStep: { stepIndex: 0, reason: 'failing-step' } }) }))
    expect(q('[data-feedback-choice] [role="radio"][aria-checked="true"]'), 'a choice is picked').not.toBeNull()
    expect(q('[data-feedback-preview]')!.getAttribute('data-preview-current')).toBe('true')

    expect(document.querySelectorAll('[data-mark-kind]')).toHaveLength(0)
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    const leaked: string[] = []
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (node.parentElement?.closest('[data-feedback-technical]')) continue
      const text = node.textContent ?? ''
      if (MARKS.some(kind => text.includes(kind))) leaked.push(text)
    }
    expect(leaked).toEqual([])
  })
})
