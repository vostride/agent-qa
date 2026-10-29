// @vitest-environment jsdom
import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type {
  Mark,
  RunDetailMember,
  RunDetailProjection,
  RunDetailStep,
  RunDetailSubAction,
  RunsMarkPreviewResult,
} from "@vostride/agent-qa-schema"
import { RunsMarkPreviewResultSchema, RunsMarksHistoryResultSchema, asRef } from "@vostride/agent-qa-schema"

import RunDetailPage from "@/pages/run-detail"
import { type MarksHistoryRead } from "@/lib/api"
import { generateRunId, generateTestId } from "@vostride/agent-qa-ids"
const RUN_ID = generateRunId()
const TEST_ID = generateTestId()
import type { RunDetailMemberMark } from "@vostride/agent-qa-schema"
import { DID_NOT_RUN_LABEL, RUN_DETAIL_UNAVAILABLE_LABEL } from "@/lib/run-detail-view"
import {
  DRAFT_KEPT_STATUS,
  FEEDBACK_CHOICE_ORDER,
  NO_UNIQUE_ADDRESS_TEXT,
  PREVIEW_DEBOUNCE_MS,
  SENDING_STATUS,
  SUBMIT_REASON_NO_UNIQUE_ADDRESS,
  SUBMIT_REASON_SENDING,
  feedbackEntryLabel,
  feedbackRecordedText,
} from "@/lib/feedback-view"
import type { FeedbackEntryButtonProps } from "@/components/run-detail/feedback-entry"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const {
  markRunMock,
  fetchRunAnalysisMock,
  fetchRunMock,
  fetchRunDetailMock,
  fetchRunArtifactMock,
  fetchExecutionLogsMock,
  fetchMarkPreviewMock,
  fetchMarksHistoryMock,
} = vi.hoisted(() => ({
  markRunMock: vi.fn(),
  fetchRunAnalysisMock: vi.fn(),
  fetchRunMock: vi.fn(),
  fetchRunDetailMock: vi.fn(),
  fetchRunArtifactMock: vi.fn(),
  fetchExecutionLogsMock: vi.fn(),
  fetchMarkPreviewMock: vi.fn(),
  fetchMarksHistoryMock: vi.fn(),
}))

vi.mock("@/lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/api")>(),
  markRun: markRunMock,
  fetchRun: fetchRunMock,
  fetchRunDetail: fetchRunDetailMock,
  // the page's THIRD read — the failure view's. This whole-module
  // mock replaces `@/lib/api`, so an omitted export is `undefined` at the call site and every
  // cell here dies before it asserts. Its own behaviour is measured in `run-detail.analysis.test.tsx`.
  fetchRunAnalysis: fetchRunAnalysisMock,
  fetchRunKnowledge: () => Promise.resolve({ kind: 'evidence-incomplete', runId: '' }),
  fetchRunArtifact: fetchRunArtifactMock,
  fetchExecutionLogs: fetchExecutionLogsMock,
  fetchRunEvidence: () => Promise.resolve({ kind: 'failed', error: 'Evidence read not configured in this fixture' }),
  // The composer's two reads (426 Pitfall 7): without them the real helpers would fetch.
  fetchMarkPreview: fetchMarkPreviewMock,
  fetchMarksHistory: fetchMarksHistoryMock,
  triggerRun: vi.fn(),
  // This whole-module mock REPLACES `@/lib/api`, so an omitted export is `undefined` at the call
  // site and every cell here dies before it asserts. The real `watchPostProcessing` constructs an
  // `EventSource` and a 3 s interval against a `fetch` these cells do not stub; its own behaviour
  // is measured in `run-detail.post-processing.test.tsx`.
  watchPostProcessing: () => () => {},
}))

vi.mock("@/hooks/use-page-title", () => ({
  usePageTitle: (title: string) => {
    document.title = title
  },
}))
vi.mock("@/hooks/use-keyboard-shortcuts", () => ({ useKeyboardShortcuts: () => {} }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("@/components/page-skeleton", () => ({ DetailSkeleton: () => <div>Loading...</div> }))
vi.mock("@/components/empty-state", () => ({
  EmptyState: ({ title }: { title: string }) => <div>{title}</div>,
}))
// The navbar double renders the real header entry, so the test-level door is the shipped contract.
vi.mock("@/components/run-detail/run-navbar", async () => {
  const { FeedbackEntryButton } = await import("@/components/run-detail/feedback-entry")
  return {
    RunNavbar: ({ feedbackEntry }: { feedbackEntry?: Omit<FeedbackEntryButtonProps, "scope"> }) => (
      <div data-testid="run-navbar">
        navbar
        {feedbackEntry === undefined ? null : <FeedbackEntryButton scope="test" {...feedbackEntry} />}
      </div>
    ),
  }
})
vi.mock("@/components/run-detail/tab-panels", () => ({
  TabPanels: ({ step }: { step: { id: string } | null }) => (
    <div data-testid="tab-panels" data-step-id={step?.id ?? ""} />
  ),
}))
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
// The select double keeps the root's value and onValueChange reachable: each item is a button that
// calls the enclosing root's handler, so a cell can move the composer's test switcher.
vi.mock("@/components/ui/select", async () => {
  const React = await vi.importActual<typeof import("react")>("react")
  const SelectRoot = React.createContext<((value: string) => void) | undefined>(undefined)
  return {
    Select: ({ children, value, onValueChange }: { children: ReactNode; value?: string; onValueChange?: (value: string) => void }) => (
      <SelectRoot.Provider value={onValueChange}>
        <div data-testid="member-select" data-value={value}>{children}</div>
      </SelectRoot.Provider>
    ),
    SelectTrigger: ({ children, className: _className, ...rest }: { children: ReactNode; className?: string }) => <div {...rest}>{children}</div>,
    SelectValue: () => <span>member filter</span>,
    SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    SelectItem: ({ children, value }: { children: ReactNode; value: string }) => {
      const onValueChange = React.useContext(SelectRoot)
      return <button type="button" data-select-item={value} onClick={() => onValueChange?.(value)}>{children}</button>
    },
  }
})
function dataAttributes(props: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(props).filter(([key]) => key.startsWith("data-")))
}
vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children, ...rest }: { children: ReactNode }) => <div {...dataAttributes(rest)}>{children}</div>,
  ResizablePanel: ({ children, id, ...rest }: { children: ReactNode; id?: string }) => (
    <div data-panel-id={id} {...dataAttributes(rest)}>{children}</div>
  ),
  ResizableHandle: () => <div />,
}))
vi.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CollapsibleTrigger: ({ children, asChild: _asChild, ...rest }: { children: ReactNode; asChild?: boolean }) => (
    <button type="button" {...rest}>{children}</button>
  ),
  CollapsibleContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children, ...rest }: { children: ReactNode }) => <span {...rest}>{children}</span>,
}))
// Every prop but the variant styling passes through, so data-*, aria-* and onClick reach the DOM.
vi.mock("@/components/ui/button", () => ({
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
    cacheStatus: "miss",
    verifierVerdict: { pass: true, reasoning: "looks right" },
    selfHealOccurred: false,
    briefDigest: `d${String(testIndex)}${String(stepIndex)}`,
    status: "passed",
    durationMs: 1000,
  }
}

function subAction(testIndex: number, stepIndex: number, subActionIndex: number): RunDetailSubAction {
  return {
    testIndex,
    stepIndex,
    subActionIndex,
    plan: `plan ${String(testIndex)}.${String(stepIndex)}.${String(subActionIndex)}`,
    plannedAction: { type: "click", ref: asRef("e1") },
    result: { success: true },
    screenStateHash: "abcdef0123456789".repeat(4),
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

const TWO_MEMBERS = projection({
  members: [member(0, { name: "Login" }), member(1, { name: "Checkout" })],
  steps: [step(0, 0, "Open login"), step(0, 1, "Submit credentials"), step(1, 0, "Open cart")],
  subActions: [subAction(0, 0, 0)],
})

function runRow(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    name: "Suite run",
    filePath: "tests/suite.yaml",
    status: "failed",
    duration: 10000,
    attributes: {},
    environment: null,
    metadata: null,
    startedAt: "2026-04-18T00:00:00.000Z",
    endedAt: "2026-04-18T00:00:10.000Z",
    failureSummary: null,
    errorLog: null,
    testId: null,
    suiteId: "s_suite",
    platform: "web",
    testFileContent: null,
    modelName: null,
    llmProvider: null,
    attemptNumber: 1,
    retryCount: 0,
    maxRetries: 0,
    createdAt: "2026-04-18T00:00:00.000Z",
    ...over,
  }
}

function LocationProbe() {
  const location = useLocation()
  const navigate = useNavigate()
  return <div data-testid="location" data-search={location.search}>
    <button data-navigate onClick={event => navigate(event.currentTarget.dataset.to!)} />
  </div>
}

let container: HTMLDivElement | null = null
let root: Root | null = null

async function flushRender() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function renderAt(url: string) {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)

  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route
            path="/runs/:id"
            element={
              <>
                <LocationProbe />
                <RunDetailPage />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    )
  })

  await flushRender()
  return container
}

/** A consequences read covering exactly one recorded decision. */
function previewFor(input: { kind: Mark; testId?: string; stepIndex?: number }): RunsMarkPreviewResult {
  return RunsMarkPreviewResultSchema.parse({
    kind: 'consequences',
    runId: RUN_ID,
    prospective: true,
    markKind: input.kind,
    member: { testIndex: 7, ...(input.testId === undefined ? {} : { testId: input.testId }) },
    resolvedStep: { stepIndex: input.stepIndex ?? 2, reason: input.stepIndex === undefined ? 'failing-step' : 'step-mark' },
    latest: { kind: 'first' },
    basis: { ledgerOrdinal: 0 },
    knowledge: { servedRecordIds: [], appendsEvidence: false, records: [], evidence: { confirmed: 0, overturned: 0 } },
    draft: input.kind === 'confirmed-bug'
      ? { kind: 'confirmed-bug' }
      : { kind: 'no-draftable-fix', checked: { servedRecords: 0, procedureReads: 0, assertionDrift: false } },
  })
}

function historyOf(entries: readonly (Record<string, unknown> & { markId: string })[]): MarksHistoryRead {
  return {
    kind: 'read',
    result: RunsMarksHistoryResultSchema.parse({
      kind: 'history',
      runId: RUN_ID,
      entries: entries.map((entry, index) => ({
        runId: RUN_ID,
        testIndex: 7,
        kind: 'false-fail',
        origin: 'user',
        ordinal: index + 1,
        markedAt: Date.UTC(2026, 8, 23, 10, index),
        disposition: { kind: 'no-draftable-fix', checked: { servedRecords: 0, procedureReads: 0, assertionDrift: false } },
        evidence: { confirmed: 0, overturned: 0 },
        active: true,
        ...entry,
      })),
    }),
  }
}

beforeEach(() => {
  document.title = ""
  Element.prototype.scrollIntoView = vi.fn()
  markRunMock.mockReset()
  fetchRunAnalysisMock.mockReset()
  fetchRunAnalysisMock.mockResolvedValue({ runId: RUN_ID, verdicts: [{ perTest: 7, producer: 'deterministic-classifier', confidence: 0 }], sentences: [{ perTest: 7, sentence: 'Cart differs' }], clusters: [] })
  fetchRunMock.mockReset()
  fetchRunDetailMock.mockReset()
  fetchRunArtifactMock.mockReset()
  fetchExecutionLogsMock.mockReset()
  fetchMarkPreviewMock.mockReset()
  fetchMarksHistoryMock.mockReset()

  fetchExecutionLogsMock.mockResolvedValue({ logs: [] })
  fetchRunArtifactMock.mockResolvedValue({ run: { id: RUN_ID }, artifact: null, children: [], missingSections: ["artifact"] })
  fetchRunMock.mockImplementation(async (id: string) => ({ run: runRow(id) }))
  fetchRunDetailMock.mockResolvedValue(TWO_MEMBERS)
  fetchMarkPreviewMock.mockImplementation(async (_runId: string, input: { kind: Mark; testId?: string; stepIndex?: number }) => ({ kind: 'read', result: previewFor(input) }))
  fetchMarksHistoryMock.mockResolvedValue(historyOf([]))
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

// the pill forms' scopes, re-addressed to the one composer. A target is the composer address
// it opens and the explicit act that opens it there.
interface ComposerTarget {
  address: string
  open: () => Promise<void>
}
const TEST_TARGET: ComposerTarget = {
  address: '7:run',
  open: () => click('[data-feedback-entry="test"]'),
}
const STEP_TARGET: ComposerTarget = {
  address: '7:2',
  open: async () => {
    if (container!.querySelector('[data-step-id="7:2"]')?.getAttribute('aria-selected') !== 'true') await click('[data-step-id="7:2"] > button')
    await click('[data-step-id="7:2"] [data-feedback-entry="step"]')
  },
}
/** A suite member's whole test, reached through the composer's test switcher. */
function memberTarget(testIndex: number): ComposerTarget {
  return {
    address: `${String(testIndex)}:run`,
    open: async () => {
      if (composerTarget()?.endsWith(':run') !== true) await click('[data-feedback-entry="test"]')
      if (composerTarget() !== `${String(testIndex)}:run`) await click(`[data-feedback-composer] [data-select-item="${String(testIndex)}"]`)
    },
  }
}
const composer = () => container!.querySelector<HTMLElement>('[data-feedback-composer]')
const composerTarget = () => composer()?.getAttribute('data-feedback-target') ?? null
function inComposer<T extends Element = HTMLElement>(selector: string) {
  return composer()?.querySelector<T>(selector) ?? null
}
const statusText = () => inComposer('[data-feedback-status]')?.textContent
const submitButton = () => inComposer('[data-feedback-submit]')!
const submitReason = () => inComposer('[data-feedback-submit-reason]')?.textContent
const choice = (kind: Mark) => `[data-feedback-composer] [data-feedback-choice="${kind}"] [role="radio"]`
const headerEntry = () => container!.querySelector('[data-feedback-entry="test"]')
const stepEntry = () => container!.querySelector('[data-step-id="7:2"] [data-feedback-entry="step"]')
const entryOf = (target: ComposerTarget) => target === STEP_TARGET ? stepEntry() : headerEntry()
async function type(field: HTMLTextAreaElement | null, value: string) {
  expect(field, 'no field to type into').not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value)
    field!.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flushRender()
}
/** Lets a debounced preview fire and land, so the read on screen is the current one. */
async function settle() {
  await act(async () => { vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS) })
  await flushRender()
}
async function openComposer(target: ComposerTarget) {
  if (composerTarget() !== target.address) await target.open()
  await settle()
  expect(composerTarget()).toBe(target.address)
}
async function draft(target: ComposerTarget) {
  await openComposer(target)
  await click(choice('false-fail'))
  await settle()
  await type(inComposer('[data-feedback-note]'), 'Keep this note')
  await settle()
}
async function expectDraft(target: ComposerTarget) {
  await openComposer(target)
  expect(inComposer<HTMLTextAreaElement>('[data-feedback-note]')?.value).toBe('Keep this note')
}
async function submitFeedback() {
  await click('[data-feedback-composer] [data-feedback-submit]')
}
async function send(target: ComposerTarget, kind: Mark) {
  await openComposer(target)
  await click(choice(kind))
  await settle()
  await submitFeedback()
}
function refreshed(target: ComposerTarget, receipt = marked): RunDetailProjection {
  return { ...initial, members: [{ ...initial.members[0], marks: [{ ...receipt, ...(target === STEP_TARGET ? { stepIndex: 2 } : {}) }] }] }
}
/** runs.detail answers `before` until a mark has been sent, then `after` (426 re-reads it on every open). */
function detailAcrossMark(before: RunDetailProjection, after: () => RunDetailProjection | Promise<RunDetailProjection>) {
  fetchRunDetailMock.mockImplementation(async () => markRunMock.mock.calls.length > 0 ? after() : before)
}
async function navigateTo(id: string) {
  container!.querySelector<HTMLButtonElement>('[data-navigate]')!.dataset.to = `/runs/${id}`
  await click('[data-navigate]')
}

/** The page's own sentence for a failed mark (2026-10-02, 432-42: no typed denial is left). */
const MARK_FAILED_TEXT = 'Could not complete the mark or refresh its receipt.'

describe('scoped draft lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    fetchRunDetailMock.mockResolvedValue(initial)
  })
  it.each([['test', TEST_TARGET], ['step', STEP_TARGET]] as const)('retains the full %s draft through POST and authoritative refresh', async (_name, target) => {
    const post = deferred<unknown>()
    const refresh = deferred<RunDetailProjection>()
    markRunMock.mockReturnValue(post.promise)
    detailAcrossMark(initial, () => refresh.promise)
    await renderAt(`/runs/${RUN_ID}`)
    await draft(target)
    await submitFeedback()
    await expectDraft(target)
    const status = inComposer('[data-feedback-status]')!
    expect(status.textContent).toBe(SENDING_STATUS)
    expect(status.getAttribute('role')).toBe('status')
    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(status.getAttribute('aria-atomic')).toBe('true')
    expect(submitButton().getAttribute('aria-disabled')).toBe('true')
    await submitFeedback()
    expect(markRunMock).toHaveBeenCalledTimes(1)
    const historyReads = fetchMarksHistoryMock.mock.calls.length
    await act(async () => post.resolve({ kind: 'marked', receipt: marked }))
    await flushRender()
    await expectDraft(target)
    expect(container!.textContent).not.toContain(feedbackRecordedText(marked.disposition))
    await act(async () => refresh.resolve(refreshed(target)))
    await flushRender()
    expect(inComposer<HTMLTextAreaElement>('[data-feedback-note]')?.value).toBe('')
    expect(statusText()).toBe(feedbackRecordedText(marked.disposition))
    expect(entryOf(target)?.getAttribute('data-feedback-marked')).toBe('true')
    expect(fetchMarksHistoryMock.mock.calls.length).toBeGreaterThan(historyReads)
  })
  for (const [name, target] of [['test', TEST_TARGET], ['step', STEP_TARGET]] as const) {
    it.each(['denied', 'no-channel', 'run-not-found', 'transport', 'refetch', 'wrong-run', 'missing', 'wrong-member', 'wrong-step', 'wrong-id', 'wrong-ordinal', 'wrong-kind'])('retains %s on the ' + name + ' target', async failure => {
      const base = failure === 'wrong-member'
        ? { ...initial, members: [...initial.members, member(8, { testId: generateTestId(), marks: [] })] }
        : initial
      // no typed denial is left; both legacy denial shapes are failed requests.
      if (failure === 'denied' || failure === 'no-channel') markRunMock.mockRejectedValue(new Error(failure))
      else if (failure === 'transport') markRunMock.mockRejectedValue(new Error('offline'))
      else if (failure === 'run-not-found') markRunMock.mockResolvedValue({ kind: failure })
      else {
        markRunMock.mockResolvedValue({ kind: 'marked', receipt: marked })
        let next = refreshed(target)
        if (failure === 'wrong-run') next = { ...next, runId: generateRunId() }
        if (failure === 'missing') next = initial
        if (failure === 'wrong-member') next = { ...base, members: [base.members[0], { ...base.members[1], marks: next.members[0].marks }] }
        if (failure === 'wrong-step') next = { ...next, members: [{ ...next.members[0], marks: [{ ...marked, stepIndex: 3 }] }] }
        if (failure === 'wrong-id') next = refreshed(target, { ...marked, markId: 'mark_1123456789ab' })
        if (failure === 'wrong-ordinal') next = refreshed(target, { ...marked, ordinal: 3 })
        if (failure === 'wrong-kind') next = refreshed(target, { ...marked, kind: 'false-pass' })
        detailAcrossMark(base, () => failure === 'refetch' ? Promise.reject(new Error('refresh failed')) : next)
      }
      await renderAt(`/runs/${RUN_ID}`)
      await draft(target)
      await submitFeedback()
      {
        await expectDraft(target)
        expect(submitButton().getAttribute('aria-disabled')).toBe('false')
        expect(statusText()).toBe(DRAFT_KEPT_STATUS)
        expect(inComposer('[data-feedback-denied]')?.getAttribute('role')).toBe('alert')
      }
      expect(container!.textContent).not.toContain(feedbackRecordedText(marked.disposition))
    })
    it('keeps the choice, the note and its field identity across a choice change and a close on the ' + name + ' target', async () => {
      await renderAt(`/runs/${RUN_ID}`)
      await draft(target)
      const note = inComposer('[data-feedback-note]')
      await click(choice('false-pass'))
      await settle()
      await expectDraft(target)
      expect(inComposer('[data-feedback-note]')).toBe(note)
      expect(container!.querySelector(choice('false-pass'))?.getAttribute('aria-checked')).toBe('true')
      await click('[data-feedback-composer] [data-feedback-close]')
      expect(composer()).toBeNull()
      await expectDraft(target)
      expect(container!.querySelector(choice('false-pass'))?.getAttribute('aria-checked')).toBe('true')
      expect(markRunMock).not.toHaveBeenCalled()
    })
  }
  it('clears an already-marked draft only after the matching receipt refresh', async () => {
    markRunMock.mockResolvedValue({ kind: 'already-marked', receipt: marked })
    detailAcrossMark(initial, () => refreshed(TEST_TARGET))
    await renderAt(`/runs/${RUN_ID}`)
    await draft(TEST_TARGET)
    await submitFeedback()
    expect(inComposer<HTMLTextAreaElement>('[data-feedback-note]')?.value).toBe('')
    expect(statusText()).toBe(feedbackRecordedText(marked.disposition))
  })
  it('keeps a second member draft and denial isolated across subsequent submissions', async () => {
    const secondId = generateTestId()
    fetchRunDetailMock.mockResolvedValue({ ...initial, members: [...initial.members, member(8, { testId: secondId, marks: [] })], steps: [...initial.steps, step(8, 2, 'Other cart')] })
    // no typed denial is left; each failed request is told apart by the
    // address its denial renders at, not by a server-supplied reason.
    markRunMock.mockRejectedValueOnce(new Error('First member denied'))
      .mockRejectedValueOnce(new Error('Second member denied'))
    await renderAt(`/runs/${RUN_ID}`)
    const first = memberTarget(7)
    const second = memberTarget(8)
    await draft(first)
    await draft(second)
    await openComposer(first)
    await submitFeedback()
    expect(inComposer('[data-feedback-denied]')?.textContent).toContain(MARK_FAILED_TEXT)
    await openComposer(second)
    expect(inComposer('[data-feedback-denied]')).toBeNull()
    await submitFeedback()
    await expectDraft(second)
    expect(inComposer('[data-feedback-denied]')?.textContent).toContain(MARK_FAILED_TEXT)
    await expectDraft(first)
    expect(statusText()).toBe(DRAFT_KEPT_STATUS)
    expect(inComposer('[data-feedback-denied]')?.textContent).toContain(MARK_FAILED_TEXT)
    expect(inComposer('[data-feedback-denied]')?.textContent).not.toContain('Second member denied')
    expect(markRunMock.mock.calls[0][1].testId).toBe(TEST_ID)
    expect(markRunMock.mock.calls[1][1].testId).toBe(secondId)
  })
  it('refuses an ambiguous testId without a POST and retains the selected member draft', async () => {
    fetchRunDetailMock.mockResolvedValue({ ...initial, members: [...initial.members, member(8, { testId: TEST_ID, marks: [] })] })
    await renderAt(`/runs/${RUN_ID}`)
    const target = memberTarget(7)
    await draft(target)
    expect(submitButton().getAttribute('aria-disabled')).toBe('true')
    expect(submitReason()).toBe(SUBMIT_REASON_NO_UNIQUE_ADDRESS)
    await submitFeedback()
    await expectDraft(target)
    expect(markRunMock).not.toHaveBeenCalled()
    expect(fetchMarkPreviewMock).not.toHaveBeenCalled()
    expect(inComposer('[data-feedback-no-address]')?.textContent).toContain(NO_UNIQUE_ADDRESS_TEXT)
  })
  it('keeps pending and result announcements local while retaining the other draft', async () => {
    const post = deferred<unknown>()
    markRunMock.mockReturnValue(post.promise)
    await renderAt(`/runs/${RUN_ID}`)
    await draft(TEST_TARGET)
    await draft(STEP_TARGET)
    await openComposer(TEST_TARGET)
    await submitFeedback()
    expect(statusText()).toBe(SENDING_STATUS)
    await openComposer(STEP_TARGET)
    expect(statusText()).toBe('')
    await expectDraft(STEP_TARGET)
    await act(async () => post.reject(new Error('Denied here')))
    await flushRender()
    expect(inComposer('[data-feedback-denied]')).toBeNull()
    expect(statusText()).toBe('')
    await expectDraft(TEST_TARGET)
    expect(statusText()).toBe(DRAFT_KEPT_STATUS)
    expect(inComposer('[data-feedback-denied]')?.textContent).toContain(MARK_FAILED_TEXT)
    await type(inComposer('[data-feedback-note]'), 'Edited')
    expect(statusText()).toBe('')
    expect(inComposer('[data-feedback-denied]')).toBeNull()
  })
  it.each(['post', 'refresh'])('ignores stale %s after A-to-B-to-A and does not release the newer guard', async boundary => {
    const oldPost = deferred<unknown>()
    const oldRefresh = deferred<RunDetailProjection>()
    const newPost = deferred<unknown>()
    const other = generateRunId()
    markRunMock.mockReturnValueOnce(oldPost.promise).mockReturnValueOnce(newPost.promise)
    fetchRunDetailMock.mockImplementation(async (id: string) => ({ ...initial, runId: id }))
    await renderAt(`/runs/${RUN_ID}`)
    await draft(TEST_TARGET)
    if (boundary === 'refresh') fetchRunDetailMock.mockReturnValueOnce(oldRefresh.promise)
    await submitFeedback()
    if (boundary === 'refresh') await act(async () => oldPost.resolve({ kind: 'marked', receipt: marked }))
    await navigateTo(other)
    await navigateTo(RUN_ID)
    await draft(TEST_TARGET)
    await submitFeedback()
    expect(markRunMock).toHaveBeenCalledTimes(2)
    await act(async () => {
      if (boundary === 'post') oldPost.resolve({ kind: 'marked', receipt: marked })
      else oldRefresh.resolve(refreshed(TEST_TARGET))
    })
    await flushRender()
    await expectDraft(TEST_TARGET)
    expect(statusText()).toBe(SENDING_STATUS)
    expect(headerEntry()?.getAttribute('data-feedback-marked')).toBe('false')
    await submitFeedback()
    expect(markRunMock).toHaveBeenCalledTimes(2)
    await act(async () => newPost.resolve({ kind: 'run-not-found' }))
    await flushRender()
    await expectDraft(TEST_TARGET)
  })
})

afterEach(() => {
  vi.useRealTimers()
  if (root) {
    act(() => root!.unmount())
  }
  root = null
  if (container) container.remove()
  container = null
  vi.clearAllMocks()
})


const initial = projection({ members: [member(7, { testId: TEST_ID, marks: [] })], steps: [step(7, 2, 'Check cart')] })
const marked: RunDetailMemberMark = { markId: 'mark_0123456789ab', kind: 'false-fail', ordinal: 2,
  disposition: { kind: 'drafted', fix: 'fact', proposalId: 'prop_0123456789ab', proposalKind: 'knowledge' } }
async function click(selector: string) {
  await act(async () => { container!.querySelector<HTMLButtonElement>(selector)!.click() })
  await flushRender()
}
const targetHistory = () =>
  [...(composer()?.querySelectorAll('[data-feedback-history="target"] [data-history-entry]') ?? [])].map(entry => entry.getAttribute('data-mark-id'))

describe('page mark post/refetch', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    fetchRunDetailMock.mockResolvedValue(initial)
  })
  it.each(['passed', 'analysis-absent'] as const)('allows a first member false-pass with %s analysis', async state => {
    if (state === 'passed') fetchRunAnalysisMock.mockResolvedValue({ runId: RUN_ID, verdicts: [], sentences: [], clusters: [] })
    else fetchRunAnalysisMock.mockRejectedValue(new Error('analysis unavailable'))
    fetchRunDetailMock.mockResolvedValue({ ...initial, members: [{ ...initial.members[0], outcome: 'passed' }] })
    markRunMock.mockResolvedValue({ kind: 'run-not-found' })
    await renderAt(`/runs/${RUN_ID}`)
    expect(container!.querySelector('[data-verdict-sentence]')).toBeNull()
    await openComposer(TEST_TARGET)
    expect([...composer()!.querySelectorAll('[data-feedback-choice]')].map(row => row.getAttribute('data-feedback-choice')))
      .toEqual([...FEEDBACK_CHOICE_ORDER.passed])
    await send(TEST_TARGET, 'false-pass')
    expect(markRunMock).toHaveBeenCalledExactlyOnceWith(RUN_ID, { kind: 'false-pass', testId: TEST_ID })
    expect(container!.querySelector('[data-step-id="7:2"]')).not.toBeNull()
  })
  it('shows and replaces the standing passing-member mark independently of its step mark', async () => {
    fetchRunAnalysisMock.mockResolvedValue({ runId: RUN_ID, verdicts: [], sentences: [], clusters: [] })
    const standing = { ...marked, kind: 'false-pass' as const }
    const stepMark = { ...marked, markId: 'mark_1123456789ab', stepIndex: 2 }
    const replacement = { ...marked, markId: 'mark_2123456789ab', ordinal: 3, kind: 'confirmed-bug' as const }
    detailAcrossMark(
      { ...initial, members: [{ ...initial.members[0], outcome: 'passed', marks: [standing, stepMark] }] },
      () => ({ ...initial, members: [{ ...initial.members[0], outcome: 'passed', marks: [replacement, stepMark] }] }),
    )
    fetchMarksHistoryMock.mockResolvedValue(historyOf([
      { markId: standing.markId, kind: standing.kind },
      { markId: stepMark.markId, kind: stepMark.kind, stepIndex: 2 },
    ]))
    markRunMock.mockResolvedValue({ kind: 'marked', receipt: replacement })
    await renderAt(`/runs/${RUN_ID}`)
    expect(headerEntry()?.getAttribute('data-feedback-marked')).toBe('true')
    expect(headerEntry()?.getAttribute('aria-label')).toBe(feedbackEntryLabel({ scope: 'test', markedChoice: 'false-pass' }))
    expect(stepEntry()?.getAttribute('data-feedback-marked')).toBe('true')
    await openComposer(TEST_TARGET)
    expect(targetHistory()).toEqual([standing.markId])
    await openComposer(STEP_TARGET)
    expect(targetHistory()).toEqual([stepMark.markId])
    await send(TEST_TARGET, 'confirmed-bug')
    expect(markRunMock).toHaveBeenCalledExactlyOnceWith(RUN_ID, { kind: 'confirmed-bug', testId: TEST_ID })
    expect(headerEntry()?.getAttribute('aria-label')).toBe(feedbackEntryLabel({ scope: 'test', markedChoice: 'confirmed-bug' }))
    expect(statusText()).toBe(feedbackRecordedText(replacement.disposition))
    expect(stepEntry()?.getAttribute('aria-label')).toBe(feedbackEntryLabel({ scope: 'step', stepNumber: 3, markedChoice: 'false-fail' }))
    expect(container!.querySelector('[data-verdict-sentence]')).toBeNull()
  })
  it('omits unbound passing-member controls without analysis', async () => {
    fetchRunAnalysisMock.mockResolvedValue({ runId: RUN_ID, verdicts: [], sentences: [], clusters: [] })
    fetchRunDetailMock.mockResolvedValue({ ...initial, members: [member(7, { outcome: 'passed', testId: TEST_ID })] })
    await renderAt(`/runs/${RUN_ID}`)
    expect(container!.querySelector('[data-feedback-entry]')).toBeNull()
    expect(composer()).toBeNull()
  })
  it.each(['marked', 'already-marked'])('refetches %s and paints only the returned projection', async kind => {
    markRunMock.mockResolvedValue({ kind, receipt: { ...marked, ordinal: 99 } })
    detailAcrossMark(initial, () => ({ ...initial, members: [{ ...initial.members[0], marks: [marked] }] }))
    await renderAt(`/runs/${RUN_ID}`)
    await openComposer(TEST_TARGET)
    const reads = fetchRunDetailMock.mock.calls.length
    await send(TEST_TARGET, 'false-fail')
    expect(markRunMock).toHaveBeenCalledExactlyOnceWith(RUN_ID, { kind: 'false-fail', testId: TEST_ID })
    expect(fetchRunDetailMock).toHaveBeenCalledTimes(reads + 1)
    expect(headerEntry()?.getAttribute('data-feedback-marked')).toBe('true')
    expect(headerEntry()?.getAttribute('aria-label')).toBe(feedbackEntryLabel({ scope: 'test', markedChoice: marked.kind }))
    expect(container!.querySelector(choice('false-fail'))?.getAttribute('aria-checked')).toBe('true')
    expect(statusText()).toBe(DRAFT_KEPT_STATUS)
    expect(container!.textContent).not.toContain(feedbackRecordedText(marked.disposition))
  })
  // RE-TITLED 2026-10-02 from 'renders a typed denial as its reason only, without a
  // refetch or invented mark': no typed denial is left, so a failed mark renders the page's sentence.
  it('renders a failed mark as the page\'s one sentence, without a refetch or invented mark', async () => {
    markRunMock.mockRejectedValue(new Error('The safety gate denied this mark.'))
    await renderAt(`/runs/${RUN_ID}`)
    await openComposer(TEST_TARGET)
    const reads = fetchRunDetailMock.mock.calls.length
    await send(TEST_TARGET, 'false-fail')
    const denied = inComposer('[data-feedback-denied]')
    expect(denied?.textContent).toContain(MARK_FAILED_TEXT)
    expect(denied?.textContent).not.toContain('safety gate')
    expect(denied?.querySelector('[data-remedy-kind]')).toBeNull()
    expect(fetchRunDetailMock).toHaveBeenCalledTimes(reads)
    expect(headerEntry()?.getAttribute('data-feedback-marked')).toBe('false')
  })
  it.each(['run-not-found', 'member-not-found', 'step-not-found', 'ambiguous-address'])('does not report HTTP-success %s as marked', async kind => {
    markRunMock.mockResolvedValue({ kind })
    await renderAt(`/runs/${RUN_ID}`)
    await openComposer(TEST_TARGET)
    const reads = fetchRunDetailMock.mock.calls.length
    await send(TEST_TARGET, 'false-fail')
    expect(inComposer('[data-feedback-denied]')?.textContent).toContain(kind)
    expect(statusText()).toBe(DRAFT_KEPT_STATUS)
    expect(container!.querySelector(choice('false-fail'))?.getAttribute('aria-checked')).toBe('true')
    expect(fetchRunDetailMock).toHaveBeenCalledTimes(reads)
    expect(headerEntry()?.getAttribute('data-feedback-marked')).toBe('false')
  })
  it('sends the durable step address and renders denial only at that step', async () => {
    markRunMock.mockRejectedValue(new Error('Denied'))
    await renderAt(`/runs/${RUN_ID}`)
    await send(STEP_TARGET, 'confirmed-bug')
    expect(markRunMock).toHaveBeenCalledExactlyOnceWith(RUN_ID, { kind: 'confirmed-bug', testId: TEST_ID, stepIndex: 2 })
    expect(composerTarget()).toBe(STEP_TARGET.address)
    expect(inComposer('[data-feedback-denied]')).not.toBeNull()
    await openComposer(TEST_TARGET)
    expect(inComposer('[data-feedback-denied]')).toBeNull()
  })
  it('does not invent feedback availability for a host that omits marks', async () => {
    fetchRunDetailMock.mockResolvedValue({ ...initial, members: [member(7, { testId: TEST_ID })] })
    await renderAt(`/runs/${RUN_ID}`)
    expect(container!.querySelector('[data-feedback-entry]')).toBeNull()
  })
  it('disables repeated submissions until the in-flight request settles', async () => {
    let resolve!: (value: unknown) => void
    markRunMock.mockReturnValue(new Promise(value => { resolve = value }))
    await renderAt(`/runs/${RUN_ID}`)
    await send(TEST_TARGET, 'false-fail')
    expect(submitButton().getAttribute('aria-disabled')).toBe('true')
    expect(submitReason()).toBe(SUBMIT_REASON_SENDING)
    await submitFeedback()
    expect(markRunMock).toHaveBeenCalledTimes(1)
    await act(async () => resolve({ kind: 'run-not-found' }))
    await flushRender()
    expect(markRunMock).toHaveBeenCalledTimes(1)
  })
})
