// @vitest-environment jsdom

// THE HONEST RUN-TIME SURFACE, IN A DOM (403-05 · HNST-01/02/03, LIVE-04, D-08/D-12/D-13/D-15).
//
// WHY THESE CELLS ASSERT ON `outerHTML` AND NOT ON VISIBLE TEXT. The claim HNST-01 makes is that
// nothing provisional is REACHABLE — not that nothing provisional is legible. A `title=`, an
// `aria-label`, a `data-` attribute or a `hidden` node would each satisfy "no visible text" while
// putting the model's half-finished intent one devtools click (or one screen reader) away. 403-04
// measured the same shape one layer down and found that TypeScript does not help here: the spread
// that would leak those five fields has the target type as its declared type, so excess-property
// checking never fires. The sentinels below are the same constants the reducer suite feeds, so a
// feed and an assertion cannot drift apart.
//
// WHY EVERY CLOCK IS FAKE. The preview re-mints at half its TTL, and NO-CLOCK-ON-ANY-ROW advances
// time to prove the rows show none. Each is a cell whose verdict would otherwise depend
// on real elapsed time — the flake shape 403-03 measured, which reads exactly like a real defect
// when it fires.
//
// WHY THE NO-LIVENESS-PILL CELLS RUN k=5. The page used to carry a bus liveness pill
// the owner removed it, and a dead bus now shows only as rows that stop moving. The
// three traffic scenarios the pill was measured over are kept, each now asserting that nothing on
// the page speaks about the channel. Fresh mount per iteration, so nothing carries across.
//
// `openRunStream` IS NOT MOCKED. It composes the door's URL and enumerates the bus's event names
// from the schema; mocking it would replace the very contract these cells exist to bind. What is
// stubbed is `EventSource` itself — the browser primitive — so the URL the page asks for is the
// observable.

import { act, useEffect, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/lib/api'
import LiveRunPage from '@/pages/live-run'
import { STEPS_EMPTY_TEXT } from '@/components/live-run/step-list'
import {
  NO_STREAM_RETRY_MS,
  NO_STREAM_TEXT,
  PREVIEW_LOADING_TEXT,
  WAITING_ATTEMPT_LIMIT,
  WAITING_GAVE_UP_LABEL,
  WAITING_GAVE_UP_TEXT,
} from '@/lib/live-preview'
import { getRunStatusFaviconHref } from '@/hooks/use-run-status-favicon'
import { DID_NOT_RUN_NOTE } from '@/lib/run-stream-reducer'

import { CURRENT_BUS_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type { RunEventEnvelope, RunEventPayload, RunEventType } from '@vostride/agent-qa-schema'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * THE SAME TWO STRINGS THE 403-04 REDUCER SUITE FEEDS. One constant per sentinel, used for both
 * the feed and the assertion, so no edit can quietly make the cell hunt for a string nothing
 * produces — a sentinel cell that looks for the wrong needle is green forever.
 */
const SENTINEL_REASONING = 'SENTINEL-REASONING-7f3a'
const SENTINEL_ACTION = 'SENTINEL-ACTION-9c1e'

const RUN_ID = 'r1'
const STOP_REQUESTED = 'Stop requested. The run will end with its own verdict.'
const NOT_STOPPABLE = "This run can't be stopped from the dashboard. Stop it where it was started."
// Concatenated so this file cannot satisfy the phase's deletion census by matching itself.
const TICKS_LABEL_ATTR = 'data-step-ticks' + '-label'
const BASE_TIME = 1_700_000_000_000
const TTL_MS = 300_000

/** `EventSource.readyState`, restated for a double that has no browser behind it. */
const CONNECTING = 0
const OPEN = 1
const CLOSED = 2

const {
  cancelRunMock,
  classifyRunStreamCloseMock,
  fetchLiveUrlMock,
  fetchRunMock,
  navigateMock,
} = vi.hoisted(() => ({
  cancelRunMock: vi.fn(),
  classifyRunStreamCloseMock: vi.fn(),
  fetchLiveUrlMock: vi.fn(),
  fetchRunMock: vi.fn(),
  navigateMock: vi.fn(),
}))

vi.mock('@/lib/api', async () => {
  // The ACTUAL module is spread so `openRunStream` and `RUN_EVENT_TYPES` stay real: the URL the
  // page asks for and the event names it listens on are the contract under test, not scaffolding.
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    cancelRun: cancelRunMock,
    classifyRunStreamClose: classifyRunStreamCloseMock,
    fetchLiveUrl: fetchLiveUrlMock,
    fetchRun: fetchRunMock,
  }
})
vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router')
  return { ...actual, useNavigate: () => navigateMock }
})
vi.mock('@/hooks/use-page-title', () => ({ usePageTitle: () => {} }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }))
// The panel doubles render the props the layout cells read: the Group's orientation and
// each panel's id and default size.
vi.mock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children, orientation }: { children: ReactNode; orientation?: string }) => (
    <div data-resizable-group data-orientation={orientation}>{children}</div>
  ),
  ResizablePanel: ({ children, id, defaultSize }: { children: ReactNode; id?: string; defaultSize?: unknown }) => (
    <div data-resizable-panel data-panel-id={id} data-default-size={JSON.stringify(defaultSize)}>{children}</div>
  ),
  ResizableHandle: () => <div data-resizable-handle />,
}))

/** The browser primitive, doubled: constructed URLs recorded, every dispatch driven by hand. */
class FakeEventSource {
  static instances: FakeEventSource[] = []
  readonly listeners = new Map<string, Array<(event: Event) => void>>()
  readyState = CONNECTING
  closed = false

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, handler: (event: Event) => void): void {
    const existing = this.listeners.get(type) ?? []
    existing.push(handler)
    this.listeners.set(type, existing)
  }

  removeEventListener(type: string, handler: (event: Event) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((one) => one !== handler))
  }

  close(): void {
    this.closed = true
    this.readyState = CLOSED
  }

  private dispatch(type: string, event: Event): void {
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event)
  }

  /** The socket came up. Tracked so "open and silent" is a state the page can be in. */
  open(): void {
    this.readyState = OPEN
    this.dispatch('open', new Event('open'))
  }

  emit(envelope: RunEventEnvelope): void {
    this.readyState = OPEN
    this.dispatch(
      envelope.type,
      new MessageEvent(envelope.type, { data: JSON.stringify(envelope), lastEventId: String(envelope.seq) }),
    )
  }

  /** The ONE thing a browser tells a page about any refusal: a bare, wordless error. */
  fail(readyState: number): void {
    this.readyState = readyState
    this.dispatch('error', new Event('error'))
  }
}

const sources = () => FakeEventSource.instances
const latest = (): FakeEventSource => {
  const one = FakeEventSource.instances.at(-1)
  if (one === undefined) throw new Error('no EventSource was constructed')
  return one
}

let nextSeq = 1

function envelope(type: RunEventType, payload: unknown, seq?: number): RunEventEnvelope {
  const resolved = seq ?? nextSeq
  nextSeq = Math.max(nextSeq, resolved) + 1
  return { seq: resolved, ts: Date.now(), runId: RUN_ID, type, payload: payload as RunEventPayload }
}

const runStarted = (handles?: readonly number[]) =>
  envelope('runStarted', {
    busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION,
    scope: { kind: 'suite', id: 's' },
    executionContext: 'local',
    buildOrdinal: 1,
    ...(handles === undefined ? {} : { handles: [...handles] }),
  })

const testStarted = (testIndex = 0, name = 'the member', totalSteps?: number, stepTexts?: readonly string[]) =>
  envelope('testStarted', {
    testId: `t${String(testIndex)}`,
    testIndex,
    name,
    totalSteps,
    ...(stepTexts === undefined ? {} : { stepTexts: [...stepTexts] }),
  })

const stepStarted = (testIndex = 0, stepIndex = 0, stepText = 'open the page') =>
  envelope('stepStarted', { testIndex, stepIndex, stepText })

const stepFinalized = (testIndex = 0, stepIndex = 0, extra: Record<string, unknown> = {}) =>
  envelope('stepFinalized', {
    testIndex,
    stepIndex,
    cacheStatus: 'miss',
    verifierVerdict: { pass: true, reasoning: SENTINEL_REASONING },
    selfHealOccurred: false,
    briefDigest: 'd',
    durationMs: 1200,
    ...extra,
  })

/**
 * A `subActionRecorded` carrying the forbidden fields a real producer emits — the agent's plan,
 * the action it intends, its candidate targets and the result it has not verified.
 */
const subActionRecorded = (testIndex = 0, stepIndex = 0, subActionIndex = 0) =>
  envelope('subActionRecorded', {
    testIndex,
    stepIndex,
    subActionIndex,
    plan: SENTINEL_REASONING,
    plannedAction: { type: SENTINEL_ACTION, kind: 'click', target: { descriptor: SENTINEL_REASONING } },
    grounding: { candidates: [{ reasoning: SENTINEL_REASONING }] },
    result: { status: 'success', detail: SENTINEL_REASONING },
    screenStateHash: 'h1',
  })

const testFinished = (testIndex = 0, outcome = 'failed') =>
  envelope('testFinished', { testId: `t${String(testIndex)}`, testIndex, outcome, durationMs: 10 })

const heartbeat = () => envelope('heartbeat', {})
const verdict = (word = 'passed') => envelope('verdict', { verdict: word })
const runFinished = () => envelope('runFinished', { status: 'passed', durationMs: 100 })

let observedPath = ''

function LocationProbe() {
  const location = useLocation()
  useEffect(() => {
    observedPath = location.pathname
  }, [location.pathname])
  return null
}

let host: { container: HTMLDivElement; root: Root } | undefined

function unmountHost(): void {
  if (host === undefined) return
  const current = host
  host = undefined
  act(() => { current.root.unmount() })
  current.container.remove()
}

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

async function mount(runId = RUN_ID): Promise<void> {
  unmountHost()
  FakeEventSource.instances = []
  nextSeq = 1
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  host = { container, root }
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[`/runs/${runId}/live`]}>
        <Routes>
          <Route
            path="/runs/:id/live"
            element={
              <>
                <LiveRunPage />
                <LocationProbe />
              </>
            }
          />
          <Route path="/runs/:id" element={<div data-run-detail-page />} />
        </Routes>
      </MemoryRouter>,
    )
  })
  await flush()
}

async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

/** A backgrounded tab returning to view, as jsdom lets a cell say it. Reverted before returning. */
async function flipVisible(): Promise<void> {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
  try {
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await Promise.resolve()
    })
  } finally {
    delete (document as { visibilityState?: unknown }).visibilityState
  }
}

async function emit(...envelopes: readonly RunEventEnvelope[]): Promise<void> {
  const source = latest()
  await act(async () => {
    for (const one of envelopes) source.emit(one)
    await Promise.resolve()
  })
}

async function open(): Promise<void> {
  const source = latest()
  await act(async () => { source.open() })
}

async function fail(readyState: number): Promise<void> {
  const source = latest()
  await act(async () => {
    source.fail(readyState)
    await Promise.resolve()
  })
  await flush()
}

const q = (selector: string) => document.querySelector(selector)
const qa = (selector: string) => [...document.querySelectorAll(selector)]
const stepsPane = (): Element => {
  const pane = q('[data-live-pane="steps"]')
  if (pane === null) throw new Error('the steps pane does not exist')
  return pane
}
/** Everything the removed pill used to say, read the two ways it could come back: a node or words. */
const livenessClaims = () => ({
  elements: qa('[data-liveness]').length,
  activityWords: /last activity|no activity yet/iu.test(document.body.textContent ?? ''),
})
const NO_LIVENESS_CLAIM = { elements: 0, activityWords: false }
const previewState = () => q('[data-preview-state]')?.getAttribute('data-preview-state')

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(BASE_TIME)
  FakeEventSource.instances = []
  ;(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource
  observedPath = ''
  fetchRunMock.mockResolvedValue({
    run: { id: RUN_ID, name: 'a run', status: 'running', filePath: 'tests/a.yaml' },
    steps: [],
    tests: [],
  })
  fetchLiveUrlMock.mockImplementation(async (_runId: string, handle = 0) => ({
    liveUrl: `http://x/live/${RUN_ID}?h=${String(handle)}#v2.a.b.${String(Date.now())}`,
    expiresAt: Date.now() + TTL_MS,
    handle,
    stream: { kind: 'cdp-screencast' },
  }))
  classifyRunStreamCloseMock.mockResolvedValue({ kind: 'lost' })
  cancelRunMock.mockResolvedValue({ outcome: 'stop-requested', message: STOP_REQUESTED })
})

afterEach(() => {
  unmountHost()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('the live page is two panes and nothing else', () => {
  it('the sentinels are pinned to the exact strings the sibling suites hardcode', () => {
    // 403-04's reducer suite and 403-06's Playwright suite each spell these literally. A rename
    // here would leave three suites hunting for three different needles, and all three green.
    expect(SENTINEL_REASONING).toBe('SENTINEL-REASONING-7f3a')
    expect(SENTINEL_ACTION).toBe('SENTINEL-ACTION-9c1e')
  })

  it('renders exactly two [data-live-pane] elements, steps and preview', async () => {
    await mount()
    const panes = qa('[data-live-pane]')
    expect(panes.map((pane) => pane.getAttribute('data-live-pane'))).toEqual(['steps', 'preview'])
    expect(panes).toHaveLength(2)
  })

  it('THE SENTINEL CELL: a mid-step plan and planned action reach no corner of the document', async () => {
    await mount()
    await open()
    await emit(runStarted(), testStarted(0, 'the member', 1), stepStarted(), subActionRecorded())

    // The WHOLE serialised document: text, attributes, aria-*, title and hidden nodes alike. A
    // query for visible text would pass over a `title=` leak, and a leak in a `title=` is a leak.
    const serialised = document.documentElement.outerHTML
    expect(serialised).not.toContain(SENTINEL_REASONING)
    expect(serialised).not.toContain(SENTINEL_ACTION)

    // ...and the absolute half: the envelope carrying them WAS folded, so the assertion above is
    // about a page that saw the payload, not about a page that never received one.
    const rows = qa('[data-live-pane="steps"] li')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.getAttribute('data-step-status')).toBe('running')
    expect(rows[0]?.getAttribute('data-step-ticks')).toBe('1')
    expect(JSON.stringify(subActionRecorded().payload)).toContain(SENTINEL_REASONING)
  })

  it('the step rows are inert: no click target, no link and no image inside the steps pane', async () => {
    await mount()
    await open()
    await emit(runStarted(), testStarted(0, 'the member', 1), stepStarted(), subActionRecorded())

    expect([...stepsPane().querySelectorAll('a, button, [role="button"], [onclick], img')]).toEqual([])
    expect(stepsPane().querySelectorAll('li')).toHaveLength(1)
  })
})

// RE-SPELLED 2026-09-26 (428-32, owner decision 2026-09-26 (5), G-428-5). The running glyph is still,
// so the page no longer marks a row "in motion". These cells count the running status instead, and
// NO-ACTION-COUNT asserts that no motion marker is left anywhere in the document.
describe('the running row advances without inventing a phase', () => {
  // Was "finalizing clears the motion and keeps the status word".
  it('finalizing ends the running status and keeps the status word', async () => {
    await mount()
    await open()
    await emit(runStarted(), testStarted(0, 'the member', 1), stepStarted())
    expect(qa('[data-step-status="running"]')).toHaveLength(1)

    await emit(stepFinalized(0, 0, { status: 'passed' }))
    expect(q('[data-live-pane="steps"] li')?.getAttribute('data-step-status')).toBe('passed')
    expect(qa('[data-step-status="running"]')).toEqual([])
  })

  // Was "exactly one row is in motion at a time".
  it('exactly one row is running at a time', async () => {
    await mount()
    await open()
    await emit(runStarted(), testStarted(0, 'the member', 2), stepStarted(0, 0))
    await emit(stepFinalized(0, 0, { status: 'passed' }), stepStarted(0, 1, 'click the button'))

    expect(qa('[data-step-status="running"]')).toHaveLength(1)
    expect(qa('[data-live-pane="steps"] li').map((row) => row.getAttribute('data-step-status'))).toEqual([
      'passed',
      'running',
    ])
  })

  it('a self-heal is `healed`, never a plain pass', async () => {
    await mount()
    await open()
    await emit(runStarted(), testStarted(0, 'the member', 1), stepStarted())
    await emit(stepFinalized(0, 0, { status: undefined, selfHealOccurred: true }))

    expect(q('[data-live-pane="steps"] li')?.getAttribute('data-step-status')).toBe('healed')
  })

  // RE-SPELLED 2026-09-26. This cell asserted the row said `3 actions`. The owner
  // removed the count: the breathing glyph's re-key is the one progress signal left, and it says
  // "something happened" without a number.
  // RE-SPELLED AGAIN 2026-09-26 (428-32, owner decision 2026-09-26 (5), G-428-5). Its title ended
  // "and the motion re-keys on each one". The glyph no longer moves or re-keys, so the ticks reach
  // the row only as data-step-ticks, and no motion marker is left in the document.
  it('NO-ACTION-COUNT: a running row after three sub-actions shows no count, and the ticks reach the row only as data-step-ticks', async () => {
    await mount()
    await open()
    await emit(runStarted(), testStarted(0, 'the member', 1), stepStarted())
    expect(q('[data-live-pane="steps"] li')?.getAttribute('data-step-ticks')).toBe('0')

    await emit(subActionRecorded(0, 0, 0), subActionRecorded(0, 0, 1), subActionRecorded(0, 0, 2))

    expect(q(`[${TICKS_LABEL_ATTR}]`)).toBeNull()
    expect(stepsPane().textContent ?? '').not.toMatch(/action/iu)
    expect(q('[data-live-pane="steps"] li')?.getAttribute('data-step-ticks')).toBe('3')
    expect(document.querySelectorAll('[data-step-motion]')).toHaveLength(0)
    // No phase was invented from the ticks, in any casing.
    expect(stepsPane().outerHTML.toLowerCase()).not.toMatch(/observing|planning|acting/)
  })

  // RE-SPELLED 2026-09-26 (428-30, owner decision 2026-09-26 (2), G-428-2). The pending arm relied
  // on a text-less pending row being drawn. A row with no text is no longer drawn, so this
  // testStarted now carries stepTexts and the claim is unchanged.
  it('NO-CLOCK-ON-ANY-ROW: running, finished and pending rows show no time, however long the run goes', async () => {
    await mount()
    await open()
    await emit(
      runStarted(),
      testStarted(0, 'the member', 3, ['open the page', 'click the button', 'check the toast']),
      stepStarted(0, 0),
      stepFinalized(0, 0, { status: 'passed', durationMs: 65_000 }),
      stepStarted(0, 1, 'click the button'),
    )
    await advance(90_000)

    const rows = qa('[data-live-pane="steps"] li')
    expect(rows.map((row) => row.getAttribute('data-step-status'))).toEqual(['passed', 'running', 'pending'])
    for (const row of rows) {
      expect(row.textContent ?? '', row.getAttribute('data-step-status') ?? '').not.toMatch(/\d+:\d{2}/)
    }
  })
})

describe('a pending row reads its real step text or is not drawn', () => {
  const rowReadings = () =>
    qa('[data-live-pane="steps"] li').map((row) => [row.getAttribute('data-step-status'), row.textContent])

  it('PENDING-ROWS-SHOW-KNOWN-TEXT: the texts testStarted carried label the pending rows', async () => {
    await mount()
    await open()
    await emit(
      runStarted(),
      testStarted(0, 'the member', 3, ['open the page', 'click Save', 'check the toast']),
      stepStarted(0, 0),
    )

    expect(rowReadings()).toEqual([
      ['running', 'open the page'],
      ['pending', 'click Save'],
      ['pending', 'check the toast'],
    ])
  })

  it('TEXTLESS-PENDING-ROWS-ABSENT: an old producer\'s pending rows are not drawn, and no row reads step N', async () => {
    await mount()
    await open()
    await emit(runStarted(), testStarted(0, 'the member', 3))
    const beforeFirstStep = {
      empty: q('[data-steps-empty]')?.textContent,
      rows: stepsPane().querySelectorAll('li').length,
    }
    await emit(stepStarted(0, 0))
    const afterFirstStep = rowReadings()
    const placeholders = qa('[data-live-pane="steps"] li').filter((row) => /^step \d+$/iu.test(row.textContent ?? ''))

    await mount()
    await open()
    await emit(runStarted(), testStarted(0, 'the member', 3), testFinished(0, 'skipped'))
    const neverStarted = {
      note: q('[data-member-note]')?.textContent,
      rows: stepsPane().querySelectorAll('li').length,
    }

    expect({ beforeFirstStep, afterFirstStep, placeholders, neverStarted }).toEqual({
      beforeFirstStep: { empty: STEPS_EMPTY_TEXT, rows: 0 },
      afterFirstStep: [['running', 'open the page']],
      placeholders: [],
      neverStarted: { note: DID_NOT_RUN_NOTE, rows: 0 },
    })
  })
})

describe('a member header only where there is more than one member', () => {
  it('NO-REPEATED-SINGLE-MEMBER-TITLE: a single-member run says its title once', async () => {
    fetchRunMock.mockResolvedValue({
      run: { id: RUN_ID, name: 'Checkout flow', status: 'running', filePath: 'tests/a.yaml' },
      steps: [],
      tests: [],
    })
    await mount()
    await open()
    await emit(runStarted(), testStarted(0, 'Checkout flow', 1), stepStarted())

    expect(q('h2')?.textContent).toBe('Checkout flow')
    expect(qa('[data-member] h3')).toEqual([])
    expect(stepsPane().querySelectorAll('h3')).toHaveLength(0)
    expect((document.body.textContent ?? '').split('Checkout flow')).toHaveLength(2)
  })

  it('SINGLE-MEMBER-NOTE-AS-SENTENCE: a single member that did not run says so once, as the pane\'s sentence', async () => {
    await mount()
    await open()
    await emit(runStarted(), testStarted(0, 'the member', 2), testFinished(0, 'skipped'))

    const notes = qa('[data-member-note]')
    expect(notes).toHaveLength(1)
    expect(notes[0]?.tagName).toBe('P')
    expect(notes[0]?.textContent).toBe(DID_NOT_RUN_NOTE)
    expect(stepsPane().contains(notes[0] ?? null)).toBe(true)
    expect(stepsPane().querySelectorAll('h3')).toHaveLength(0)
    expect((stepsPane().textContent ?? '').split(DID_NOT_RUN_NOTE)).toHaveLength(2)
  })

  it('MULTI-MEMBER-COMPACT-HEADER: a two-member suite has one header per member, the name then the outcome or note', async () => {
    await mount()
    await open()
    await emit(
      runStarted([0, 1]),
      testStarted(0, 'first member', 1),
      stepStarted(0, 0),
      stepFinalized(0, 0, { status: 'passed' }),
      testFinished(0, 'passed'),
      testStarted(1, 'second member', 1),
      testFinished(1, 'skipped'),
    )

    const headers = qa('[data-member] h3')
    expect(headers).toHaveLength(2)
    expect(headers[0]?.firstElementChild?.textContent).toBe('first member')
    expect(headers[0]?.querySelector('[data-member-outcome]')?.textContent).toBe('passed')
    expect(headers[0]?.querySelector('[data-member-note]')).toBeNull()
    expect(headers[1]?.firstElementChild?.textContent).toBe('second member')
    expect(headers[1]?.querySelector('[data-member-note]')?.textContent).toBe(DID_NOT_RUN_NOTE)
  })
})

describe('NO-LIVENESS-PILL: the page makes no claim about the bus channel', () => {
  // RE-SPELLED 2026-09-26. These four cells were HNST-03's pill cells: `live` across
  // heartbeats, `lost` over an open and silent socket, `reconnecting` while dialling, and the
  // preview holding its state through each. D-03 removes the pill, so the same traffic now
  // asserts that no liveness element and no activity age appear. The positive half of each cell
  // proves the page DID fold the traffic, so the absence is about a page that heard the bus.
  // RE-SPELLED 2026-09-26 (428-30, owner decision 2026-09-26 (2), G-428-2). Its positive half
  // counted a text-less pending row as proof the page folded the stream. A row with no text is no
  // longer drawn, so this testStarted now carries stepTexts and the claim is unchanged.
  it('NO-LIVENESS-PILL k=5: 11 s of heartbeat-only traffic renders no liveness element', async () => {
    for (let k = 0; k < 5; k += 1) {
      await mount()
      await open()
      await emit(runStarted(), testStarted(0, 'the member', 1, ['open the page']))
      expect(qa('[data-live-pane="steps"] li'), 'the page folded the stream').toHaveLength(1)

      await advance(9_000)
      expect(livenessClaims()).toEqual(NO_LIVENESS_CLAIM)
      await advance(1_000)
      await emit(heartbeat())
      await advance(1_000)
      expect(livenessClaims()).toEqual(NO_LIVENESS_CLAIM)
      expect(sources()).toHaveLength(1)
    }
  })

  it('NO-LIVENESS-PILL k=5: an OPEN socket that has heard nothing for 21 s renders no liveness element', async () => {
    for (let k = 0; k < 5; k += 1) {
      await mount()
      await open()
      expect(latest().readyState).toBe(OPEN)

      await advance(21_000)
      expect(latest().readyState).toBe(OPEN)
      expect(latest().closed).toBe(false)
      expect(livenessClaims()).toEqual(NO_LIVENESS_CLAIM)
    }
  })

  // RE-SPELLED 2026-09-26 (428-30, owner decision 2026-09-26 (2), G-428-2). Its positive half
  // counted a text-less pending row as proof the restored socket delivered. A row with no text is
  // no longer drawn, so this testStarted now carries stepTexts and the claim is unchanged.
  it('NO-LIVENESS-PILL k=5: a socket dropped while dialling and then restored renders no liveness element', async () => {
    for (let k = 0; k < 5; k += 1) {
      await mount()
      await open()
      await emit(runStarted())

      await fail(CONNECTING)
      expect(livenessClaims()).toEqual(NO_LIVENESS_CLAIM)
      // The browser retries this socket itself — the page does not open a second one, and a
      // dialling error is not a close the door is asked to classify.
      expect(sources()).toHaveLength(1)
      expect(classifyRunStreamCloseMock).not.toHaveBeenCalled()

      await open()
      await emit(testStarted(0, 'the member', 1, ['open the page']))
      expect(qa('[data-live-pane="steps"] li'), 'the restored socket delivers').toHaveLength(1)
      expect(livenessClaims()).toEqual(NO_LIVENESS_CLAIM)
    }
  })

  it('the preview keeps its own state across a dropped and restored socket, and nothing claims liveness', async () => {
    await mount()
    await open()
    await emit(runStarted())
    expect(previewState()).toBe('loading')

    await fail(CONNECTING)
    expect(previewState()).toBe('loading')

    await advance(20_000)
    expect(previewState()).toBe('loading')
    expect(livenessClaims()).toEqual(NO_LIVENESS_CLAIM)
  })
})

describe('the header is the title, the file path, Cancel and view run detail', () => {
  const header = (): Element => {
    const found = q('[data-tour-id="tour-live-run-status"]')?.parentElement
    if (found === null || found === undefined) throw new Error('the live header does not exist')
    return found
  }

  it('NO-PULSING-RADIO: nothing in the header pulses, and it holds exactly the four things', async () => {
    await mount()
    await open()
    await emit(runStarted(), testStarted(0, 'the member', 1), stepStarted())

    const titleGroup = q('[data-tour-id="tour-live-run-status"]')
    expect({
      titleGroupIcons: titleGroup?.querySelectorAll('svg').length,
      pulsing: header().querySelectorAll('[class*="animate-pulse"]').length,
      title: titleGroup?.querySelector('h2')?.textContent,
      titleGroupText: titleGroup?.textContent,
      buttons: [...header().querySelectorAll('button')].map((button) => button.textContent),
      links: [...header().querySelectorAll('a')].map((link) => link.hasAttribute('data-run-detail-link')),
      headerText: header().textContent,
    }).toEqual({
      titleGroupIcons: 0,
      pulsing: 0,
      title: 'a run',
      titleGroupText: 'a runtests/a.yaml',
      buttons: ['Cancel'],
      links: [true],
      headerText: 'a runtests/a.yamlCancelview run detail',
    })

    // Cancel is there only while the run is running.
    await emit(stepFinalized(0, 0, { status: 'passed' }), testFinished(0, 'passed'), runFinished())
    expect(header().querySelectorAll('button')).toHaveLength(0)
    expect(header().textContent).toBe('a runtests/a.yamlview run detail')
  })
})

const REFUSAL = 'This run belongs to another agent-qa process (pid 4242). Stop it there with Ctrl+C.'
const ORPHAN = 'The process running this run (pid 4242) ended before it finished.'
const CANCELLED_BEFORE_START = 'Run cancelled before it started.'
const CANCEL_TOAST = { id: `cancel-${RUN_ID}` }

async function pressCancel(): Promise<void> {
  const button = qa('button').find((one) => one.textContent === 'Cancel')
  if (button === undefined) throw new Error('the Cancel button does not exist')
  await act(async () => { (button as HTMLButtonElement).click() })
  await flush()
  await flush()
}

async function clickCancel(): Promise<void> {
  await mount()
  await open()
  await emit(runStarted(), testStarted(0, 'the member', 1), stepStarted())
  await pressCancel()
}

describe('the sentences in the cancel toasts', () => {
  it("the refusal toast shows the route's sentence", async () => {
    cancelRunMock.mockRejectedValueOnce(
      new ApiError(409, 'Conflict', { error: REFUSAL, reason: 'owned-by-live-process', ownerPid: 4242 }),
    )
    await clickCancel()
    expect(cancelRunMock).toHaveBeenCalledWith(RUN_ID)
    expect(vi.mocked(toast.error).mock.calls).toEqual([[REFUSAL, CANCEL_TOAST]])
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled()

    vi.mocked(toast.error).mockClear()
    cancelRunMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await clickCancel()
    expect(vi.mocked(toast.error).mock.calls).toEqual([['Failed to cancel run', CANCEL_TOAST]])
  })

  it("an orphan answer's toast shows its sentence", async () => {
    cancelRunMock.mockResolvedValueOnce({ cancelled: false, message: ORPHAN })
    await clickCancel()
    expect(vi.mocked(toast.info).mock.calls).toEqual([[ORPHAN, CANCEL_TOAST]])

    vi.mocked(toast.info).mockClear()
    cancelRunMock.mockResolvedValueOnce({ outcome: 'cancelled', message: CANCELLED_BEFORE_START })
    await clickCancel()
    expect(vi.mocked(toast.success).mock.calls).toEqual([[CANCELLED_BEFORE_START, CANCEL_TOAST]])
    expect(vi.mocked(toast.info)).not.toHaveBeenCalled()
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
  })
})

describe('the kind and id of each cancel toast', () => {
  it('an orphan answer shows its sentence as an info toast, never success', async () => {
    cancelRunMock.mockResolvedValueOnce({ cancelled: false, message: ORPHAN })
    await clickCancel()
    expect(vi.mocked(toast.info).mock.calls).toEqual([[ORPHAN, CANCEL_TOAST]])
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled()
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled()

    vi.mocked(toast.info).mockClear()
    cancelRunMock.mockResolvedValueOnce({ outcome: 'cancelled', message: CANCELLED_BEFORE_START })
    await clickCancel()
    expect(vi.mocked(toast.success).mock.calls).toEqual([[CANCELLED_BEFORE_START, CANCEL_TOAST]])
    expect(vi.mocked(toast.info)).not.toHaveBeenCalled()
  })

  it("only the 409 refusal shows the route's sentence; any other error reads Failed to cancel run", async () => {
    cancelRunMock.mockRejectedValueOnce(
      new ApiError(409, 'Conflict', { error: REFUSAL, reason: 'owned-by-live-process', ownerPid: 4242 }),
    )
    await clickCancel()
    expect(vi.mocked(toast.error).mock.calls).toEqual([[REFUSAL, CANCEL_TOAST]])

    const others: unknown[] = [
      new ApiError(404, 'Not Found', { error: 'Run not found or not cancellable' }),
      new ApiError(500, 'Internal Server Error', { error: 'SQLITE_BUSY: database is locked' }),
      new TypeError('Failed to fetch'),
    ]
    for (const error of others) {
      vi.mocked(toast.error).mockClear()
      cancelRunMock.mockRejectedValueOnce(error)
      await clickCancel()
      expect(vi.mocked(toast.error).mock.calls, String(error)).toEqual([['Failed to cancel run', CANCEL_TOAST]])
    }
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled()
    expect(vi.mocked(toast.info)).not.toHaveBeenCalled()
  })

  it('repeated cancel toasts for one run share one id', async () => {
    const refusal = () =>
      new ApiError(409, 'Conflict', { error: REFUSAL, reason: 'owned-by-live-process', ownerPid: 4242 })
    cancelRunMock.mockRejectedValueOnce(refusal()).mockRejectedValueOnce(refusal())
    await clickCancel()
    await pressCancel()
    expect(cancelRunMock).toHaveBeenCalledTimes(2)
    expect(vi.mocked(toast.error).mock.calls).toEqual([
      [REFUSAL, CANCEL_TOAST],
      [REFUSAL, CANCEL_TOAST],
    ])
  })
})

const faviconHref = (): string | null =>
  document.querySelector('link[rel="icon"][type="image/svg+xml"]')?.getAttribute('href') ?? null

describe('the cancel answers on the live-run page', () => {
  it("the live-run page shows a stop request as an info toast and keeps the run's status", async () => {
    cancelRunMock.mockResolvedValueOnce({ outcome: 'stop-requested', message: STOP_REQUESTED })
    await mount()
    await open()
    await emit(runStarted(), testStarted(0, 'the member', 1), stepStarted())
    const runningIcon = faviconHref()
    expect(runningIcon).toBe(getRunStatusFaviconHref('running'))
    await pressCancel()

    expect(vi.mocked(toast.info).mock.calls).toEqual([[STOP_REQUESTED, CANCEL_TOAST]])
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled()
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
    expect({
      icon: faviconHref(),
      cancelButton: qa('button').some((one) => one.textContent === 'Cancel'),
      terminalBand: q('[data-terminal-state]'),
      navigated: navigateMock.mock.calls.length,
    }).toEqual({ icon: runningIcon, cancelButton: true, terminalBand: null, navigated: 0 })

    await emit(testFinished(0, 'cancelled'), verdict('cancelled'))
    expect(navigateMock.mock.calls).toEqual([
      [`/runs/${RUN_ID}`, { replace: true, state: { arrivedOnVerdict: 'cancelled' } }],
    ])
    expect(faviconHref()).toBe(getRunStatusFaviconHref('cancelled'))
  })

  it("the live-run page shows a pending run's cancel as a success toast with the route's sentence", async () => {
    cancelRunMock.mockResolvedValueOnce({ outcome: 'cancelled', message: CANCELLED_BEFORE_START })
    await clickCancel()
    expect(vi.mocked(toast.success).mock.calls).toEqual([[CANCELLED_BEFORE_START, CANCEL_TOAST]])
    expect(vi.mocked(toast.info)).not.toHaveBeenCalled()
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
  })

  it("the live-run page shows a finished run's answer as an info toast", async () => {
    const finished = 'This run already finished: passed.'
    cancelRunMock.mockResolvedValueOnce({ outcome: 'finished', status: 'passed', message: finished })
    await clickCancel()
    expect(vi.mocked(toast.info).mock.calls).toEqual([[finished, CANCEL_TOAST]])
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled()
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
  })

  it('the live-run page reads an answer with no sentence as a failed cancel, never a cancel', async () => {
    cancelRunMock.mockResolvedValueOnce({ cancelled: true })
    await clickCancel()
    expect(vi.mocked(toast.error).mock.calls).toEqual([['Failed to cancel run', CANCEL_TOAST]])
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled()
    expect(vi.mocked(toast.info)).not.toHaveBeenCalled()
  })

  it("a 409 not-stoppable answer shows the route's sentence as an error toast", async () => {
    cancelRunMock.mockRejectedValueOnce(
      new ApiError(409, 'Conflict', { error: NOT_STOPPABLE, reason: 'not-stoppable-here' }),
    )
    await clickCancel()
    expect(vi.mocked(toast.error).mock.calls).toEqual([[NOT_STOPPABLE, CANCEL_TOAST]])
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled()
    expect(vi.mocked(toast.info)).not.toHaveBeenCalled()
  })
})

describe('a stream that carried no step is never a blank pane', () => {
  it('says `waiting for the first step` while live and `did not run` once the member settles', async () => {
    await mount()
    await open()
    await emit(runStarted(), testStarted(0, 'the member'))

    expect(q('[data-steps-empty]')?.textContent).toBe(STEPS_EMPTY_TEXT)
    expect(STEPS_EMPTY_TEXT).toBe('waiting for the first step')

    await emit(testFinished(0, 'failed'))

    expect(q('[data-steps-empty]')).toBeNull()
    expect(q('[data-member-note]')?.textContent).toBe(DID_NOT_RUN_NOTE)
    expect(stepsPane().textContent).not.toContain(STEPS_EMPTY_TEXT)
  })
})

describe('the page ends where the run ends, and MOVES the viewer with it', () => {
  // WHAT REPLACED WHAT. 403 D-12 ended this page on the verdict and
  // deliberately went nowhere: run detail had not been rebuilt, and a redirect would have taken
  // the decision away from a person watching a failure land. 404 owns verdict-exactly-once and
  // run detail is rebuilt, so the page now moves with the run — on the ENVELOPE, not on
  // `runFinished`, because the post-verdict step sits between the two and D-10 says it never
  // gates anything a person sees.
  //
  // `replace`, NOT `push`. Back must return to wherever the person came from. A pushed entry
  // would put a DEAD live page — a socket the door has already closed — one Back press away, and
  // the page they landed on would immediately navigate them forward again.
  it('navigates to run detail on the FIRST verdict, replacing history and naming the verdict word', async () => {
    await mount()
    await open()
    await emit(runStarted(), testStarted(0, 'the member', 1), stepStarted())
    expect(navigateMock, 'a running run goes nowhere').not.toHaveBeenCalled()
    expect(q('[data-terminal-state]'), 'and shows no terminal band').toBeNull()

    await emit(stepFinalized(0, 0, { status: 'passed' }), testFinished(0, 'passed'), verdict('passed'))

    expect(navigateMock).toHaveBeenCalledTimes(1)
    expect(navigateMock).toHaveBeenCalledWith(
      `/runs/${RUN_ID}`,
      { replace: true, state: { arrivedOnVerdict: 'passed' } },
    )
    // THE BAND IS NOT ON SCREEN AT THE MOMENT OF NAVIGATION. D-14 keeps it for the paths where
    // navigation CANNOT happen; painting it here would be a page saying "this run is over, stay
    // put" in the same tick it moved the viewer somewhere else.
    expect(q('[data-terminal-state]')).toBeNull()
  })

  it('a second verdict and a following `runFinished` add no second navigation', async () => {
    await mount()
    await open()
    await emit(runStarted(), testStarted(0, 'the member', 1))
    await emit(verdict('passed'))
    expect(navigateMock).toHaveBeenCalledTimes(1)

    // The reducer takes the FIRST verdict and drops the rest; this asserts the EFFECT
    // inherits that, because an effect keyed on a field that never changes cannot fire twice.
    await emit(verdict('failed'), runFinished())
    await advance(30_000)

    expect(navigateMock, 'one run, one arrival').toHaveBeenCalledTimes(1)
    expect(sources(), 'and no reconnect behind it').toHaveLength(1)
    expect(classifyRunStreamCloseMock).not.toHaveBeenCalled()
  })

  // RE-PINNED 2026-08-26. Before this phase this cell was "freezes with the
  // verdict, ends the preview, links run detail, and neither reconnects nor navigates" and it
  // published `verdict` + `runFinished` together. D-13 inverts that path: a verdict NAVIGATES. So
  // the cell keeps its subject — the honest terminal band — and moves to the path where the band
  // is still the only truthful thing to render: a producer that ended a run without ever declaring
  // a verdict. The band is a FALLBACK now, and this is what it falls back from.
  it('a `runFinished` with NO verdict renders the terminal band, links run detail, and goes nowhere', async () => {
    await mount()
    await open()
    await emit(runStarted(), testStarted(0, 'the member', 1), stepStarted())
    expect(sources()).toHaveLength(1)

    await emit(stepFinalized(0, 0, { status: 'passed' }), testFinished(0, 'passed'), runFinished())

    expect(q('[data-terminal-state]')).not.toBeNull()
    expect(document.body.textContent).toContain('run ended')
    expect(previewState()).toBe('run-ended')
    expect(q('[data-live-embed]')).toBeNull()
    expect(q('[data-run-detail-link]')?.getAttribute('href')).toBe(`/runs/${RUN_ID}`)
    // Liveness is a claim about a channel; a finished run has none to make.
    expect(q('[data-liveness]')).toBeNull()

    await advance(30_000)

    expect(sources()).toHaveLength(1)
    expect(
      navigateMock,
      'D-14: with no verdict there is nothing to move the viewer TO the record about — the band '
      + 'says so and the link offers it',
    ).not.toHaveBeenCalled()
    expect(observedPath).toBe(`/runs/${RUN_ID}/live`)
    expect(classifyRunStreamCloseMock).not.toHaveBeenCalled()
  })

  // THE SECOND D-14 PATH, and the one that is not a producer defect at all. A close the door
  // classifies as `unknown_run` after this page has already folded envelopes is a retention window
  // that elapsed — the replay would land past the end. No verdict ever reaches the reducer, so
  // there is nothing to navigate on, and the honest thing is the band plus the durable link.
  it('a close classified past the end (`unknown_run` with envelopes already seen) bands rather than navigates', async () => {
    classifyRunStreamCloseMock.mockResolvedValue({ kind: 'unknown_run' })
    await mount()
    await open()
    await emit(runStarted(), testStarted(0, 'the member', 1))

    await fail(CLOSED)

    expect(q('[data-run-over]')?.textContent?.trim()).toBe('this run is over — view run detail')
    expect(q('[data-run-detail-link]')?.getAttribute('href')).toBe(`/runs/${RUN_ID}`)
    expect(navigateMock, 'a page that never saw a verdict has no verdict to move on').not.toHaveBeenCalled()
    expect(observedPath).toBe(`/runs/${RUN_ID}/live`)
  })

  it('the rows are frozen: an envelope after `runFinished` changes no status', async () => {
    await mount()
    await open()
    await emit(runStarted(), testStarted(0, 'the member', 1), stepStarted(), stepFinalized(0, 0, { status: 'passed' }))
    await emit(verdict('passed'), runFinished())

    await emit(stepStarted(0, 0, 'a late start'))

    expect(q('[data-live-pane="steps"] li')?.getAttribute('data-step-status')).toBe('passed')
  })
})

describe('the preview is one embed or an honest sentence', () => {
  // NO SENTENCE NAMES A POSITION FOR THE STEPS PANE. The live page renders the
  // step list BESIDE the preview and the served embed owns no step list at all, so a direction
  // word is false in every host; the pane names the steps pane by ROLE instead.
  const DIRECTION_WORDS = /\b(?:below|beneath|above|left|right)\b/u

  // `none` IS TWO SITUATIONS WEARING ONE WORD (403-07, gap 1), and the pane's whole honesty rests
  // on telling them apart. `startRun` publishes the session synchronously; the member's browser —
  // and therefore its screencast capability — arrives later, so the FIRST mint of an ordinary run
  // answers `none` while the run is perfectly healthy. Reading that as the D-08 declared absence
  // printed `no live preview for this target` over a run that was about to stream. The
  // discriminator is the watched member's own lifecycle, and both halves are cells.
  it('a member that FINISHES WITHOUT EVER STARTING A STEP gets the did-not-run sentence, not motion for the rest of the run', async () => {
    fetchLiveUrlMock.mockResolvedValue({
      liveUrl: 'http://x/live/r1#v2.a.b',
      expiresAt: BASE_TIME + TTL_MS,
      handle: 0,
      stream: { kind: 'none' },
    })
    await mount()
    await open()
    // RE-SPELLED 2026-09-26 (428-33, owner decision 2026-09-26 (3), G-428-3). This cell used to emit
    // testStarted(1) as well and relied on the preview's old default handle 0. The preview now follows
    // the running member, so a running member 1 would take the watch; with no other member running,
    // the watch holds on member 0, which is the member this cell is about. Every claim is unchanged.
    await emit(runStarted([0, 1]), testFinished(0, 'skipped'))

    const at0 = previewState()
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await advance(NO_STREAM_RETRY_MS)
    }

    expect({
      at0,
      after: previewState(),
      text: q('[data-preview-state] p')?.textContent,
      reason: q('[data-preview-reason]')?.getAttribute('data-preview-reason'),
      label: q('[data-preview-reason-label]'),
      memberNote: q('[data-member-note]') !== null,
      iframes: qa('iframe').length,
    }).toEqual({
      at0: 'waiting',
      after: 'no-stream',
      text: NO_STREAM_TEXT,
      reason: 'declared',
      label: null,
      memberNote: true,
      iframes: 0,
    })
  })

  it('a handle with no member row at all is bounded, and says it gave up rather than that there is nothing', async () => {
    fetchLiveUrlMock.mockResolvedValue({
      liveUrl: 'http://x/live/r1#v2.a.b',
      expiresAt: BASE_TIME + TTL_MS,
      handle: 0,
      stream: { kind: 'none' },
    })
    await mount()
    await open()
    // RE-SPELLED 2026-09-26 (428-33, owner decision 2026-09-26 (3), G-428-3). The cell used to emit
    // testStarted(1) up front and switch handle through the picker, which is gone. Under the follow
    // rule a member with a row is running, so the roster comes alone first: handle 0 has no member
    // row, the first-roster rule watches it, and it reaches the bound exactly as before. Member 1
    // then starts without answering, and the preview switches to it with nobody touching anything.
    await emit(runStarted([0, 1]))

    const at0 = previewState()
    for (let attempt = 0; attempt < WAITING_ATTEMPT_LIMIT; attempt += 1) {
      await advance(NO_STREAM_RETRY_MS)
    }
    const afterCap = previewState()
    const textAfterCap = q('[data-preview-state] p')?.textContent
    const reasonAfterCap = q('[data-preview-reason]')?.getAttribute('data-preview-reason')
    const labelAfterCap = q('[data-preview-reason-label]')?.textContent
    const callsAfterCap = fetchLiveUrlMock.mock.calls.length

    await emit(testStarted(1, 'the live member', 1))

    expect(WAITING_GAVE_UP_TEXT).not.toBe(NO_STREAM_TEXT)
    expect({
      at0,
      afterCap,
      textAfterCap,
      reasonAfterCap,
      labelAfterCap,
      callsAfterCap,
      afterSwitch: previewState(),
      callsAfterSwitch: fetchLiveUrlMock.mock.calls.length,
      lastCall: fetchLiveUrlMock.mock.calls.at(-1),
    }).toEqual({
      at0: 'waiting',
      afterCap: 'no-stream',
      textAfterCap: WAITING_GAVE_UP_TEXT,
      reasonAfterCap: 'gave-up',
      labelAfterCap: WAITING_GAVE_UP_LABEL,
      callsAfterCap: WAITING_ATTEMPT_LIMIT,
      afterSwitch: 'waiting',
      callsAfterSwitch: WAITING_ATTEMPT_LIMIT + 1,
      lastCall: [RUN_ID, 1],
    })
  })

  // THE BOUND IS A BOUND. Three roads led back into `waiting` after the cap; each
  // is one cell, and each reads the same triple so a sentence cannot lag the state by a render.
  //
  // RE-SPELLED 2026-09-26 (428-33, owner decision 2026-09-26 (3), G-428-3). (A)..(D) used to start
  // member 1 while the preview sat on its old default handle 0. The preview now follows the running
  // member, so that start would switch it to handle 1 after the mount's mint for handle 0, and every
  // call count would be one higher. The running-but-unanswered member is now member 0, the one the
  // preview watches from mount, so each cell counts the same calls on the same handle as before, and
  // (C)'s late outcome is the watched member's own.
  const noneAnswer = () => ({
    liveUrl: 'http://x/live/r1#v2.a.b',
    expiresAt: Date.now() + TTL_MS,
    handle: 0,
    stream: { kind: 'none' as const },
  })
  const settled = () => ({
    state: previewState(),
    text: q('[data-preview-state] p')?.textContent,
    calls: fetchLiveUrlMock.mock.calls.length,
  })
  const gaveUp = { state: 'no-stream', text: WAITING_GAVE_UP_TEXT, calls: WAITING_ATTEMPT_LIMIT }

  it('(A) after the cap, a tab returning to view re-mints NOTHING — twice', async () => {
    fetchLiveUrlMock.mockImplementation(async () => noneAnswer())
    await mount()
    await open()
    await emit(runStarted([0, 1]), testStarted(0, 'the live member', 1))
    for (let attempt = 0; attempt < WAITING_ATTEMPT_LIMIT; attempt += 1) {
      await advance(NO_STREAM_RETRY_MS)
    }
    const afterCap = settled()

    await advance(TTL_MS)
    await flipVisible()
    await advance(NO_STREAM_RETRY_MS)
    const afterFirstFlip = settled()

    await advance(TTL_MS)
    await flipVisible()
    await advance(NO_STREAM_RETRY_MS)
    const afterSecondFlip = settled()

    expect({ afterCap, afterFirstFlip, afterSecondFlip }).toEqual({
      afterCap: gaveUp,
      afterFirstFlip: gaveUp,
      afterSecondFlip: gaveUp,
    })
  })

  it('(B) a 24th mint that lands AFTER the cap is discarded, not re-opened', async () => {
    let release: ((answer: ReturnType<typeof noneAnswer>) => void) | undefined
    let ordinal = 0
    fetchLiveUrlMock.mockImplementation(async () => {
      ordinal += 1
      if (ordinal === WAITING_ATTEMPT_LIMIT) {
        return new Promise<ReturnType<typeof noneAnswer>>((resolve) => { release = resolve })
      }
      return noneAnswer()
    })
    await mount()
    await open()
    await emit(runStarted([0, 1]), testStarted(0, 'the live member', 1))
    for (let attempt = 0; attempt < WAITING_ATTEMPT_LIMIT; attempt += 1) {
      await advance(NO_STREAM_RETRY_MS)
    }
    const afterCap = settled()
    expect(release, 'the 24th mint must still be in flight at the cap').toBeDefined()

    await act(async () => {
      release?.(noneAnswer())
      await Promise.resolve()
    })
    await flush()
    const afterRelease = settled()
    await advance(NO_STREAM_RETRY_MS)
    const afterRetryWindow = settled()

    expect({ afterCap, afterRelease, afterRetryWindow }).toEqual({
      afterCap: gaveUp,
      afterRelease: gaveUp,
      afterRetryWindow: gaveUp,
    })
  })

  it('(C) an outcome arriving after the cap does not swap the sentence behind a re-mint', async () => {
    fetchLiveUrlMock.mockImplementation(async () => noneAnswer())
    await mount()
    await open()
    await emit(runStarted([0, 1]), testStarted(0, 'the live member', 1))
    for (let attempt = 0; attempt < WAITING_ATTEMPT_LIMIT; attempt += 1) {
      await advance(NO_STREAM_RETRY_MS)
    }
    await emit(testFinished(0, 'skipped'))
    const afterOutcome = settled()

    await advance(TTL_MS)
    await flipVisible()
    await advance(NO_STREAM_RETRY_MS)
    const afterFlip = settled()

    await emit(heartbeat())
    const afterUnrelated = settled()

    expect({ afterOutcome, afterFlip, afterUnrelated }).toEqual({
      afterOutcome: gaveUp,
      afterFlip: gaveUp,
      afterUnrelated: gaveUp,
    })
  })

  it('(D) a retry answered slower than the interval is KEPT: a screencast on call 2 embeds, and the timer does not re-ask over it', async () => {
    let ordinal = 0
    fetchLiveUrlMock.mockImplementation(async () => {
      ordinal += 1
      if (ordinal === 2) {
        await new Promise((resolve) => { setTimeout(resolve, NO_STREAM_RETRY_MS + 1) })
        return {
          liveUrl: 'http://x/live/r1#v2.a.b',
          expiresAt: Date.now() + TTL_MS,
          handle: 0,
          stream: { kind: 'cdp-screencast' as const },
        }
      }
      return noneAnswer()
    })
    await mount()
    await open()
    await emit(runStarted([0, 1]), testStarted(0, 'the live member', 1))
    await advance(NO_STREAM_RETRY_MS)
    const whileSlow = settled()
    await advance(NO_STREAM_RETRY_MS)
    const atNextTick = settled()
    await advance(2)
    const afterAnswer = { ...settled(), iframes: qa('iframe').length }

    expect({ whileSlow, atNextTick, afterAnswer }).toEqual({
      whileSlow: { state: 'waiting', text: PREVIEW_LOADING_TEXT, calls: 2 },
      atNextTick: { state: 'waiting', text: PREVIEW_LOADING_TEXT, calls: 2 },
      afterAnswer: { state: 'loading', text: undefined, calls: 2, iframes: 1 },
    })
  })

  it('a `none` from a member whose browser is not up yet is a NOT-YET, and the pane keeps asking', async () => {
    fetchLiveUrlMock.mockResolvedValue({
      liveUrl: 'http://x/live/r1#v2.a.b',
      expiresAt: BASE_TIME + TTL_MS,
      handle: 0,
      stream: { kind: 'none' },
    })
    await mount()
    await open()
    await emit(runStarted([0]), testStarted(0, 'the member', 1))

    expect(previewState()).toBe('waiting')
    expect(q('[data-live-pane="preview"]')?.textContent).not.toContain(NO_STREAM_TEXT)
    expect(q('iframe')).toBeNull()
    expect(fetchLiveUrlMock).toHaveBeenCalledTimes(1)

    // THE POLL IS THE FIX. A pane that asked once would sit here for the whole run; the assertion
    // that matters is that the SECOND and THIRD questions get asked without anything prompting them.
    await advance(NO_STREAM_RETRY_MS)
    expect(fetchLiveUrlMock).toHaveBeenCalledTimes(2)
    await advance(NO_STREAM_RETRY_MS)
    expect(fetchLiveUrlMock).toHaveBeenCalledTimes(3)
    expect(previewState()).toBe('waiting')
    expect(q('iframe')).toBeNull()
  })

  it('a declared `none` — the member started and still has no stream — renders the sentence and no iframe', async () => {
    fetchLiveUrlMock.mockResolvedValue({
      liveUrl: 'http://x/live/r1#v2.a.b',
      expiresAt: BASE_TIME + TTL_MS,
      handle: 0,
      stream: { kind: 'none' },
    })
    await mount()
    await open()
    await emit(runStarted([0]), testStarted(0, 'the member', 1), stepStarted())

    // The member's browser IS up now — its steps are advancing — and the handle still declares
    // nothing to stream. That is the D-08 absence, and it gets the sentence rather than motion.
    await advance(NO_STREAM_RETRY_MS)

    expect(previewState()).toBe('no-stream')
    expect(q('[data-live-pane="preview"]')?.textContent).toContain(NO_STREAM_TEXT)
    expect(q('[data-preview-reason]')?.getAttribute('data-preview-reason')).toBe('declared')
    expect(NO_STREAM_TEXT).toContain('step list')
    expect(WAITING_GAVE_UP_TEXT).toContain('step list')
    expect(NO_STREAM_TEXT).not.toMatch(DIRECTION_WORDS)
    expect(WAITING_GAVE_UP_TEXT).not.toMatch(DIRECTION_WORDS)
    expect(q('iframe')).toBeNull()

    // AND THE SENTENCE IS TERMINAL. A retry that fired from `no-stream` would poll straight
    // through a declared absence and turn D-08 into a flicker.
    const settled = fetchLiveUrlMock.mock.calls.length
    await advance(NO_STREAM_RETRY_MS * 3)
    expect(fetchLiveUrlMock.mock.calls.length).toBe(settled)
    expect(previewState()).toBe('no-stream')
  })

  it('any non-none kind embeds identically — `mjpeg` is not a special case', async () => {
    fetchLiveUrlMock.mockResolvedValue({
      liveUrl: 'http://x/live/r1#v2.mjpeg',
      expiresAt: BASE_TIME + TTL_MS,
      handle: 0,
      stream: { kind: 'mjpeg' },
    })
    await mount()
    await open()

    expect(previewState()).toBe('loading')
    const frame = q('[data-live-embed]')
    expect(frame?.getAttribute('src')).toBe('http://x/live/r1?host=dashboard#v2.mjpeg')
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts')
  })

  // RE-SPELLED 2026-09-26 (428-33, owner decision 2026-09-26 (3), G-428-3). Was "a roster of more
  // than one handle offers a picker that re-mints for the chosen handle". The owner removed the
  // picker; the re-mint for the other handle is kept, and the member starting is what drives it.
  it('a roster of more than one handle offers no picker, and the preview re-mints for the member that starts', async () => {
    await mount()
    await open()
    await emit(runStarted([0, 1]))

    expect(q('[data-handle-picker]')).toBeNull()
    expect(fetchLiveUrlMock.mock.calls.at(-1)).toEqual([RUN_ID, 0])

    await emit(testStarted(1))

    expect(q('[data-handle-picker]')).toBeNull()
    expect(fetchLiveUrlMock.mock.calls.at(-1)).toEqual([RUN_ID, 1])
  })

  it('a single-handle run shows no picker', async () => {
    await mount()
    await open()
    await emit(runStarted([0]))

    expect(q('[data-handle-picker]')).toBeNull()
    expect(previewState()).toBe('loading')
  })

  it('the mint is renewed silently at half its life and the frame swaps to the new url', async () => {
    await mount()
    await open()
    const first = q('[data-live-embed]')?.getAttribute('src')
    expect(fetchLiveUrlMock).toHaveBeenCalledTimes(1)

    await advance(TTL_MS / 2)

    expect(fetchLiveUrlMock).toHaveBeenCalledTimes(2)
    const second = q('[data-live-embed]')?.getAttribute('src')
    expect(second).not.toBe(first)
    expect(second).toBe(`http://x/live/${RUN_ID}?h=0&host=dashboard#v2.a.b.${String(BASE_TIME + TTL_MS / 2)}`)
    // Silent: nothing about the swap reaches the person watching.
    expect(previewState()).toBe('loading')
  })

  it('a refused mint names the door’s own word and shows no frame', async () => {
    fetchLiveUrlMock.mockRejectedValue(new Error('live_view_unavailable'))
    await mount()
    await open()

    expect(previewState()).toBe('unavailable')
    expect(q('[data-preview-error]')?.getAttribute('data-preview-error')).toBe('live_view_unavailable')
    expect(q('iframe')).toBeNull()
  })
})

// THE PREVIEW FOLLOWS THE RUNNING MEMBER (G-428-3, owner decision 2026-09-26 (3)). The owner saw a
// suite's page sit on "This test finished while the run goes on" while its second member ran, with a
// handle selector as the only way off it, and asked for the selector to go and the handle to follow.
describe('the preview follows the running member, and nobody picks a handle', () => {
  it('FOLLOWS-RUNNING-MEMBER: when member 0 finishes and member 1 starts, the preview mints for handle 1', async () => {
    await mount()
    await open()
    await emit(runStarted([0, 1]), testStarted(0, 'the first member', 1), stepStarted(0, 0))
    const whileFirstRuns = fetchLiveUrlMock.mock.calls.at(-1)

    await emit(testFinished(0, 'passed'))
    const betweenMembers = fetchLiveUrlMock.mock.calls.at(-1)

    await emit(testStarted(1, 'the second member', 1), stepStarted(1, 0))
    await flush()

    expect({
      whileFirstRuns,
      betweenMembers,
      afterSecondStarts: fetchLiveUrlMock.mock.calls.at(-1),
      memberEnded: previewState() === 'member-ended',
      embedsSecond: q('[data-live-embed]')?.getAttribute('src')?.includes('?h=1&') ?? false,
    }).toEqual({
      whileFirstRuns: [RUN_ID, 0],
      betweenMembers: [RUN_ID, 0],
      afterSecondStarts: [RUN_ID, 1],
      memberEnded: false,
      embedsSecond: true,
    })
  })

  it('NO-HANDLE-PICKER: a two-member suite with both members started shows no selector and no watching label', async () => {
    await mount()
    await open()
    await emit(runStarted([0, 1]), testStarted(0, 'the first member', 1), testStarted(1, 'the second member', 1))

    expect({
      pickers: qa('[data-handle-picker]').length,
      selects: qa('select').length,
      watchingLabels: qa('label').filter((label) => label.textContent?.trim() === 'watching').length,
      watchingWord: /\bwatching\b/iu.test(document.body.textContent ?? ''),
    }).toEqual({ pickers: 0, selects: 0, watchingLabels: 0, watchingWord: false })
  })
})

describe('the wordless close is classified, never guessed', () => {
  it('a replay floor re-attaches at the floor and says what it cost', async () => {
    classifyRunStreamCloseMock.mockResolvedValue({ kind: 'replay_floor', earliestAvailableSeq: 40 })
    await mount()
    await open()
    await emit(runStarted(), testStarted(0, 'the member', 1), heartbeat(), envelope('heartbeat', {}, 12))
    expect(sources()).toHaveLength(1)

    await fail(CLOSED)

    expect(classifyRunStreamCloseMock).toHaveBeenCalledWith(RUN_ID, { lastEventId: 12 })
    expect(sources()).toHaveLength(2)
    expect(latest().url).toBe(`/api/run-stream/${RUN_ID}?lastEventId=39`)
    expect(q('[data-gap-marker]')?.textContent?.trim()).toBe('27 events missed (seq 13–39) — see run detail')
  })

  it('an unknown run stops retrying and routes to the durable record', async () => {
    classifyRunStreamCloseMock.mockResolvedValue({ kind: 'unknown_run' })
    await mount()
    await open()
    await emit(runStarted())

    await fail(CLOSED)

    expect(q('[data-run-over]')?.textContent?.trim()).toBe('this run is over — view run detail')
    expect(sources()).toHaveLength(1)

    await advance(30_000)
    expect(sources()).toHaveLength(1)
    expect(classifyRunStreamCloseMock).toHaveBeenCalledTimes(1)
  })

  it('a plain reattach resumes at the last seq seen, and never below it', async () => {
    classifyRunStreamCloseMock.mockResolvedValue({ kind: 'reattach' })
    await mount()
    await open()
    // The out-of-order delivery: seq 12 arrives, then seq 5. The resume point is the HIGHEST seq
    // seen, because re-delivery is idempotent here and skipping past a gap is not.
    await emit(runStarted(), envelope('heartbeat', {}, 12), envelope('heartbeat', {}, 5))

    await fail(CLOSED)

    expect(sources()).toHaveLength(2)
    expect(latest().url).toBe(`/api/run-stream/${RUN_ID}?lastEventId=12`)
    expect(q('[data-gap-marker]')).toBeNull()
  })

  it('the first attach carries no resume point at all', async () => {
    await mount()
    expect(latest().url).toBe(`/api/run-stream/${RUN_ID}`)
  })
})

describe('the bus is the truth on this page', () => {
  it('a run row the door cannot answer for is a notice, never a blocker', async () => {
    fetchRunMock.mockRejectedValue(new Error('500'))
    await mount()
    await open()
    await emit(runStarted(), testStarted(0, 'the member', 1), stepStarted())

    expect(qa('[data-live-pane]')).toHaveLength(2)
    expect(q('[data-run-meta-unavailable]')).not.toBeNull()
    expect(q('[data-live-pane="steps"] li')?.getAttribute('data-step-status')).toBe('running')
    expect(previewState()).toBe('loading')
  })

  it('a run warning is reduced to a code and a message', async () => {
    await mount()
    await open()
    await emit(runStarted(), envelope('runWarning', { code: 'w1', message: 'a warning', context: { secret: SENTINEL_REASONING } }))

    expect(q('[data-run-notice="w1"]')?.textContent).toBe('a warning')
    expect(document.documentElement.outerHTML).not.toContain(SENTINEL_REASONING)
  })
})

describe('the live header says which rung served this run, from the evidence', () => {
  const FLOOR = { schemaVersion: 2, rung: 'static-floor', reason: 'native-runtime-unavailable' } as const
  const TOP = { schemaVersion: 2, rung: 'memidex' } as const
  const BOOTSTRAP = { schemaVersion: 2, rung: 'bundle-scan', reason: 'index-not-built' } as const

  it('paints NOTHING before a frame has carried a rung — "not yet known" is the absent element', async () => {
    await mount()
    await open()
    await emit(runStarted(), testStarted(0, 'the member', 1), stepStarted(), stepFinalized(0, 0, { status: 'passed' }))

    expect(q('[data-rung-banner]')).toBeNull()
    expect(qa('[data-rung]')).toHaveLength(0)
    expect(q('[data-run-meta-strip]')).toBeNull()
  })

  it('paints NO strip at all on a healthy run — the top rung is not a sentence', async () => {
    // WR-01. `memidex` is a DEFINED value with no sentence: the banner returns null for it. A
    // container gated on the value rather than on the sentence therefore opened an empty bordered
    // rule under the header of every healthy live run, once its first evidence-carrying frame
    // landed. Container and child share one predicate, so they cannot disagree.
    await mount()
    await open()
    await emit(
      runStarted(),
      testStarted(0, 'the member', 1),
      stepStarted(),
      stepFinalized(0, 0, { status: 'passed', retrievalRung: TOP }),
    )

    expect(q('[data-run-meta-strip]')).toBeNull()
    expect(q('[data-rung-banner]')).toBeNull()
    expect(qa('[data-live-pane]')).toHaveLength(2)
  })

  it('opens the strip for a gap beside a memidex rung, and paints no banner in it', async () => {
    // The other half of the same predicate: the strip still opens for anything that DOES have a
    // sentence. A healthy rung standing beside a gap marker neither suppresses the strip nor
    // paints a banner of its own.
    classifyRunStreamCloseMock.mockResolvedValue({ kind: 'replay_floor', earliestAvailableSeq: 40 })
    await mount()
    await open()
    await emit(
      runStarted(),
      testStarted(0, 'the member', 1),
      stepStarted(),
      stepFinalized(0, 0, { status: 'passed', retrievalRung: TOP }),
      envelope('heartbeat', {}, 12),
    )

    await fail(CLOSED)

    expect(q('[data-run-meta-strip]')).not.toBeNull()
    expect(q('[data-gap-marker]')).not.toBeNull()
    expect(q('[data-rung-banner]')).toBeNull()
  })

  it('paints the same sentence run detail paints, in the meta strip, once a frame carries the rung', async () => {
    await mount()
    await open()
    await emit(
      runStarted(),
      testStarted(0, 'the member', 1),
      stepStarted(),
      stepFinalized(0, 0, { status: 'passed', retrievalRung: FLOOR }),
    )

    const banner = q('[data-rung-banner]')
    expect(banner).not.toBeNull()
    expect(banner?.tagName).toBe('P')
    expect(banner?.getAttribute('data-rung')).toBe('static-floor')
    expect(banner?.getAttribute('data-rung-reason')).toBe('native-runtime-unavailable')
    expect(banner?.getAttribute('data-retrieval-class')).toBe('semantic-search-unavailable')
    expect(banner?.textContent).toBe(
      "This run's knowledge retrieval used the lightweight static-floor embeddings instead of the full model — native ONNX runtime unavailable. To check the store's health now, run agent-qa doctor. It reports current health and doesn't change what this run recorded.",
    )
    // IN THE STRIP, NOT IN A THIRD PANE. 403's two-pane rule is what this cell is really guarding:
    // the banner joins the header's existing second line beside `data-gap-marker` and the notices.
    expect(banner?.parentElement?.className).toContain('flex-wrap')
    expect(qa('[data-live-pane]')).toHaveLength(2)
  })

  it('LIVE-STRIP-INFO-ABSENT: a run recorded on a fresh index opens no strip and paints no banner', async () => {
    // A fresh store's bootstrap is information the tab states; the container and the
    // banner share rungBannerText, so neither opens for an info class.
    await mount()
    await open()
    await emit(
      runStarted(),
      testStarted(0, 'the member', 1),
      stepStarted(),
      stepFinalized(0, 0, { status: 'passed', retrievalRung: BOOTSTRAP }),
    )

    expect(q('[data-rung-banner]')).toBeNull()
    expect(q('[data-run-meta-strip]')).toBeNull()
    expect(qa('[data-rung]')).toHaveLength(0)
    expect(qa('[data-live-pane]')).toHaveLength(2)
  })

  it('opens the strip for a rung even when nothing else in it has anything to say', async () => {
    // The strip is conditional. A rung arriving on a healthy, ungapped, still-running stream must
    // open it on its own, or the banner would be reachable only by coincidence.
    await mount()
    await open()
    await emit(runStarted(), testStarted(0, 'the member', 1), stepStarted())
    expect(q('[data-rung-banner]')).toBeNull()

    await emit(stepFinalized(0, 0, { status: 'passed', retrievalRung: FLOOR }))
    expect(q('[data-run-meta-strip]')).not.toBeNull()
    expect(q('[data-rung-banner]')).not.toBeNull()
    expect(q('[data-gap-marker]')).toBeNull()
    expect(q('[data-run-over]')).toBeNull()
  })
})

// A controllable ResizeObserver, as in run-detail.feedback.test.tsx: it records what each observer
// watches and reports a width only when a cell asks, so an observer never called back is the
// unmeasured page.
class StubResizeObserver {
  static live = new Set<StubResizeObserver>()
  readonly targets = new Set<Element>()
  constructor(readonly callback: ResizeObserverCallback) { StubResizeObserver.live.add(this) }
  observe(target: Element): void { this.targets.add(target) }
  unobserve(target: Element): void { this.targets.delete(target) }
  disconnect(): void {
    this.targets.clear()
    StubResizeObserver.live.delete(this)
  }
}

describe('below 768 px the page stacks with the preview on top', () => {
  const group = (): Element => {
    const found = q('[data-resizable-group]')
    if (found === null) throw new Error('the panel group does not exist')
    return found
  }
  const paneOrder = () => qa('[data-live-pane]').map((pane) => pane.getAttribute('data-live-pane'))
  const panelIds = () => qa('[data-resizable-panel]').map((panel) => panel.getAttribute('data-panel-id'))

  async function resizePage(width: number): Promise<void> {
    const root = group().parentElement
    const watching = [...StubResizeObserver.live].filter((observer) => root !== null && observer.targets.has(root))
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
    await flush()
  }

  beforeEach(() => {
    StubResizeObserver.live.clear()
    vi.stubGlobal('ResizeObserver', StubResizeObserver)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('STACKS-BELOW-768-PREVIEW-FIRST: at 400 px the group is vertical and the preview comes first; at 1280 px it is horizontal with the steps first', async () => {
    await mount()
    await open()
    await emit(runStarted(), testStarted(0, 'the member', 1))

    await resizePage(400)
    const stacked = { orientation: group().getAttribute('data-orientation'), panes: paneOrder(), ids: panelIds() }

    await resizePage(1280)
    const docked = { orientation: group().getAttribute('data-orientation'), panes: paneOrder(), ids: panelIds() }

    expect({ stacked, docked }).toEqual({
      stacked: { orientation: 'vertical', panes: ['preview', 'steps'], ids: ['live-preview-stacked', 'live-steps-stacked'] },
      docked: { orientation: 'horizontal', panes: ['steps', 'preview'], ids: ['live-steps', 'live-preview'] },
    })
  })

  it('GROUP-KEY-STABLE: crossing the breakpoint keeps the same Group node and the same step list, and does not re-mint the preview', async () => {
    await mount()
    await open()
    await emit(runStarted(), testStarted(0, 'the member', 1))

    const groupBefore = group()
    const stepsBefore = stepsPane()
    const mintsBefore = fetchLiveUrlMock.mock.calls.length
    await resizePage(400)
    const flippedTo = group().getAttribute('data-orientation')
    await resizePage(1280)

    expect({
      flippedTo,
      backTo: group().getAttribute('data-orientation'),
      sameGroup: group() === groupBefore,
      sameSteps: stepsPane() === stepsBefore,
      mints: fetchLiveUrlMock.mock.calls.length - mintsBefore,
    }).toEqual({ flippedTo: 'vertical', backTo: 'horizontal', sameGroup: true, sameSteps: true, mints: 0 })
  })

  it('TWO-PANES-BOTH-LAYOUTS: exactly two [data-live-pane] docked, stacked and unmeasured', async () => {
    await mount()
    const unmeasured = { orientation: group().getAttribute('data-orientation'), panes: qa('[data-live-pane]').length }
    await resizePage(400)
    const stacked = { orientation: group().getAttribute('data-orientation'), panes: qa('[data-live-pane]').length }
    await resizePage(1280)
    const docked = { orientation: group().getAttribute('data-orientation'), panes: qa('[data-live-pane]').length }

    expect({ unmeasured, stacked, docked }).toEqual({
      unmeasured: { orientation: 'horizontal', panes: 2 },
      stacked: { orientation: 'vertical', panes: 2 },
      docked: { orientation: 'horizontal', panes: 2 },
    })
  })
})
