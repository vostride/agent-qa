// @vitest-environment jsdom

// THE EDITOR'S RUN PANEL ON THE RUN-STREAM WIRE.
//
// This panel was the last UI client of the legacy execution-event projection. These cells
// bind it to the SAME wire `pages/live-run.tsx` reads: `openRunStream` frames folded through
// `reduceRunStream`. `openRunStream` is MOCKED here (unlike the live-run suite, which stubs
// `EventSource` to observe the door's URL) because what is under test is the panel's use of the
// stream — one source per run id, closed on teardown — not the door's URL composition, which the
// 403 `api.run-stream` suite already binds.
//
// THE ONE ROW. The panel renders its rows through the live page's
// `LiveStepRowView`: a named glyph and the label as written, no clock. The
// duration a finalized row used to show lives in run detail now, so the finalize cell asserts it
// is absent (re-spelled in place; the title is unchanged).
//
// THE RETIREMENT CELL IS THE RETIREMENT'S OWN. A panel that fell back to constructing its own
// `EventSource` against the retired feed would satisfy every other cell here, so the retirement is
// asserted directly: zero constructions of a URL naming the legacy path.

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RunResultsPanel } from '@/components/run-results-panel'
import type { RunStreamOptions } from '@/lib/api'
import { LIVE_STEP_STATUS_NAMES } from '@/lib/live-step-row'
import type { StepStatus } from '@/lib/run-stream-reducer'

import type { RunEventEnvelope, RunEventPayload, RunEventType } from '@vostride/agent-qa-schema'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const RUN_ID = 'run-1'
// THE NEEDLE IS CONCATENATED so this file cannot satisfy the phase's grep-clean deletion
// inventory by matching itself — the `v1-retry-machinery-deleted` idiom.
const LEGACY_FEED_PATH = '/api/execution' + '/events'

const { optionsRef, closeMock, openRunStreamMock } = vi.hoisted(() => ({
  optionsRef: { current: null as null | RunStreamOptions },
  closeMock: vi.fn(),
  openRunStreamMock: vi.fn(),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    openRunStream: openRunStreamMock,
  }
})
vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>{children}</button>
  ),
}))
vi.mock('@/components/ui/badge', () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}))

let container: HTMLDivElement | null = null
let root: Root | null = null
let nextSeq = 1

function envelope(type: RunEventType, payload: unknown): RunEventEnvelope {
  return {
    seq: nextSeq++,
    ts: Date.now(),
    runId: RUN_ID,
    type,
    payload: payload as RunEventPayload,
  }
}

const stepStarted = (stepText: string, testIndex = 0, stepIndex = 0) =>
  envelope('stepStarted', { testIndex, stepIndex, stepText })

const stepFinalized = (extra: Record<string, unknown>, testIndex = 0, stepIndex = 0) =>
  envelope('stepFinalized', {
    testIndex,
    stepIndex,
    cacheStatus: 'miss',
    selfHealOccurred: false,
    briefDigest: 'd',
    ...extra,
  })

const testStarted = (totalSteps: number, stepTexts?: readonly string[], testIndex = 0) =>
  envelope('testStarted', {
    testId: `t${String(testIndex)}`,
    testIndex,
    name: 'the member',
    totalSteps,
    ...(stepTexts === undefined ? {} : { stepTexts: [...stepTexts] }),
  })

const verdict = (word: string) => envelope('verdict', { verdict: word })
const runFinished = () => envelope('runFinished', {})

function feed(...envelopes: RunEventEnvelope[]) {
  act(() => {
    for (const each of envelopes) {
      optionsRef.current?.onEvent?.(each)
      if (each.type === 'runFinished') optionsRef.current?.onFinished?.(each)
    }
  })
}

async function renderPanel(runId: string | null = RUN_ID) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)

  await act(async () => {
    root!.render(<RunResultsPanel runId={runId} onClose={() => {}} />)
  })

  return container
}

beforeEach(() => {
  nextSeq = 1
  optionsRef.current = null
  closeMock.mockReset()
  openRunStreamMock.mockReset()
  openRunStreamMock.mockImplementation((_runId: string, options: RunStreamOptions) => {
    optionsRef.current = options
    return { close: closeMock } as unknown as EventSource
  })
})

afterEach(() => {
  if (root) {
    act(() => root!.unmount())
  }
  root = null
  container?.remove()
  container = null
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('RunResultsPanel on the run stream', () => {
  it('opens exactly one run stream per mounted run id and closes it on teardown', async () => {
    await renderPanel()

    expect(openRunStreamMock).toHaveBeenCalledTimes(1)
    expect(openRunStreamMock.mock.calls[0]?.[0]).toBe(RUN_ID)

    act(() => root!.unmount())
    root = null

    expect(closeMock).toHaveBeenCalledTimes(1)
  })

  it('renders a running row from stepStarted and finalizes it from stepFinalized', async () => {
    const view = await renderPanel()

    feed(stepStarted('Open the page'))
    expect(view.textContent).toContain('Open the page')
    expect(view.querySelectorAll('[data-step-status="running"]')).toHaveLength(1)

    feed(stepFinalized({ status: 'passed', durationMs: 1200 }))
    expect(view.querySelectorAll('[data-step-status="passed"]')).toHaveLength(1)
    // a row carries no duration; run detail has it.
    expect(view.textContent).not.toContain('1.2s')
  })

  it('renders the terminal badge from the verdict and marks still-running rows', async () => {
    const passing = await renderPanel()
    feed(stepStarted('Open the page'), stepFinalized({ status: 'passed', durationMs: 5 }), verdict('passed'), runFinished())
    expect(passing.textContent).toContain('Passed')
    expect(passing.textContent).not.toContain('Failed')

    act(() => root!.unmount())
    root = null
    container?.remove()

    const failing = await renderPanel()
    feed(stepStarted('Open the page'), verdict('failed'), runFinished())
    expect(failing.textContent).toContain('Failed')
    // The row never finalized on its own; the run's ending is what settles it.
    expect(failing.querySelectorAll('[data-step-status="failed"]')).toHaveLength(1)
  })

  it('renders the error posture when the stream errors before any envelope', async () => {
    const view = await renderPanel()

    act(() => {
      optionsRef.current?.onError?.(new Event('error'), { readyState: 2 } as EventSource)
    })

    expect(view.textContent).toContain('Failed')
    expect(view.textContent).not.toContain('Waiting for events')
  })

  it('never constructs an EventSource against the retired execution-events feed', async () => {
    const constructed: string[] = []
    class RecordingEventSource {
      constructor(url: string) { constructed.push(url) }
      addEventListener() {}
      close() {}
      readyState = 0
    }
    vi.stubGlobal('EventSource', RecordingEventSource)

    const view = await renderPanel()
    feed(stepStarted('Open the page'), verdict('passed'), runFinished())

    expect(view.textContent).toContain('Open the page')
    expect(constructed.filter((url) => url.includes(LEGACY_FEED_PATH))).toHaveLength(0)
  })
})

describe('RunResultsPanel renders the one live row', () => {
  it('PANEL-USES-SHARED-ROW: each reducer row is an li with its status, ticks and a glyph named by status', async () => {
    const view = await renderPanel()

    feed(stepStarted('Open the page'), stepFinalized({ status: 'passed', durationMs: 5 }), stepStarted('Click Save', 0, 1))

    const rows = [...view.querySelectorAll('[data-step-status]')]
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.tagName)).toEqual(['LI', 'LI'])
    expect(rows.every((row) => row.parentElement?.tagName === 'UL')).toBe(true)
    expect(rows.map((row) => row.getAttribute('data-step-status'))).toEqual(['passed', 'running'])
    for (const row of rows) {
      expect(row.getAttribute('data-step-ticks')).not.toBeNull()
      const glyphs = row.querySelectorAll('[role="img"]')
      expect(glyphs).toHaveLength(1)
      const status = row.getAttribute('data-step-status') as StepStatus
      expect(glyphs[0]?.getAttribute('aria-label')).toBe(LIVE_STEP_STATUS_NAMES[status])
    }
  })

  it('PANEL-NO-CLOCK: after 90 s of a running step the panel shows no clock, no duration and no elapsed badge', async () => {
    vi.useFakeTimers()
    const view = await renderPanel()

    feed(stepStarted('Open the page'), stepFinalized({ status: 'passed', durationMs: 1200 }), stepStarted('Click Save', 0, 1))
    act(() => {
      vi.advanceTimersByTime(90_000)
    })

    const text = view.textContent ?? ''
    expect(text).not.toMatch(/\d+:\d{2}/)
    expect(text).not.toMatch(/\d+(\.\d+)?(ms|s|m|h)\b/)
    expect(view.querySelector('.lucide-clock')).toBeNull()
    expect(view.querySelector('[data-elapsed]')).toBeNull()
  })

  // an old run's numbered placeholder is the characters it holds.
  it('PANEL-OLD-PLACEHOLDER-AS-TEXT: an old <SECRET_n> placeholder in step text renders as written, with no chip', async () => {
    const view = await renderPanel()

    feed(stepStarted('type <SECRET_1> into Password'))

    expect(view.querySelector('[data-masked]')).toBeNull()
    expect(view.textContent).toContain('type <SECRET_1> into Password')
  })
})

describe('RunResultsPanel draws a row only when it has text', () => {
  const WAITING = 'Waiting for events...'
  const readings = (view: HTMLElement) =>
    [...view.querySelectorAll('li')].map((row) => [row.getAttribute('data-step-status'), row.textContent])
  const placeholders = (view: HTMLElement) =>
    [...view.querySelectorAll('li')].filter((row) => /^step \d+$/iu.test(row.textContent ?? ''))

  it('PANEL-NO-STEP-PLACEHOLDER: an old producer draws only started rows, step texts draw pending rows, and nothing drawn still waits', async () => {
    const old = await renderPanel()
    const connecting = old.textContent?.includes(WAITING)
    feed(testStarted(2))
    const oldBeforeStart = { waiting: old.textContent?.includes(WAITING), lists: old.querySelectorAll('ul').length }
    feed(stepStarted('Open the page'))
    const oldAfterStart = { rows: readings(old), placeholders: placeholders(old).length, waiting: old.textContent?.includes(WAITING) }

    act(() => root!.unmount())
    root = null
    container?.remove()

    const known = await renderPanel()
    feed(testStarted(2, ['Open the page', 'Click Save']), stepStarted('Open the page'))
    const withTexts = { rows: readings(known), placeholders: placeholders(known).length }

    expect({ connecting, oldBeforeStart, oldAfterStart, withTexts }).toEqual({
      connecting: true,
      oldBeforeStart: { waiting: true, lists: 0 },
      oldAfterStart: { rows: [['running', 'Open the page']], placeholders: 0, waiting: false },
      withTexts: { rows: [['running', 'Open the page'], ['pending', 'Click Save']], placeholders: 0 },
    })
  })
})

describe('RunResultsPanel shows the whole label', () => {
  const LONG =
    'Select "Show" from the navbar, scroll to the end and click more, wait for the whole list to finish '
    + 'loading, then check that every card keeps its full title and its supercalifragilistic caption'
  const CLIPPING_CLASS =
    /^(?:truncate|overflow-hidden|overflow-x-hidden|overflow-clip|overflow-x-clip|text-ellipsis|overflow-ellipsis|whitespace-nowrap|text-nowrap|line-clamp-.+)$/u

  it('PANEL-FULL-LABEL: a long step text renders in full in the panel\'s row, and nothing in the row clips it', async () => {
    expect(LONG.length).toBeGreaterThanOrEqual(180)
    const view = await renderPanel()

    feed(testStarted(1, [LONG]), stepStarted(LONG))

    const rows = [...view.querySelectorAll('li[data-step-status]')]
    expect(rows).toHaveLength(1)
    const li = rows[0] as HTMLElement
    expect(li.textContent).toBe(LONG)
    for (const word of LONG.split(/\s+/u)) {
      expect(li.textContent, word).toContain(word)
    }
    const clipping = [li, ...li.querySelectorAll('*')].flatMap((element) =>
      [...element.classList].filter((token) => CLIPPING_CLASS.test(token)).map((token) => `${element.tagName}.${token}`),
    )
    expect(clipping).toEqual([])
  })
})
