// @vitest-environment jsdom

// THE SHARED LIVE PREVIEW, IN A DOM (428-15 · PXH-LIVE-01, PXH-LIVE-03, D-02/D-13/D-14/D-16/D-17).
//
// The embed is an opaque-origin document, so these cells stand in for it the only way a host can
// observe it: a MessageEvent on window whose source is the rendered iframe's own contentWindow.
// Every clock is fake, because the dot's colour is a claim about the age of a frame.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  LivePreview,
  type LivePreviewEditorSubject,
  type LivePreviewRunSubject,
  type LivePreviewSubject,
} from '@/components/live-preview/live-preview'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  LIVE_DOT_MEANINGS,
  LIVE_DOT_NAMES,
  LIVE_FRESHNESS_WINDOW_MS,
  LIVE_PREVIEW_ACTION_LABELS,
  LIVE_RECONNECT_BACKOFF_MS,
  PREVIEW_DELAYED_TEXT,
  PREVIEW_DISCONNECTED_TEXT,
  PREVIEW_EXPIRED_TEXT,
  RENEW_RETRY_MS,
  SNAPSHOT_PREVIEW_LABEL,
} from '@/lib/live-preview'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const RUN_ID = 'r1'
const SESSION_ID = 'e1'
const BASE_TIME = 1_700_000_000_000
const TTL_MS = 300_000

const { fetchLiveUrlMock, fetchEditorLiveUrlMock } = vi.hoisted(() => ({
  fetchLiveUrlMock: vi.fn(),
  fetchEditorLiveUrlMock: vi.fn(),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, fetchLiveUrl: fetchLiveUrlMock, fetchEditorLiveUrl: fetchEditorLiveUrlMock }
})

const runSubject = (overrides: Partial<LivePreviewRunSubject> = {}): LivePreviewRunSubject => ({
  kind: 'run',
  runId: RUN_ID,
  handle: 0,
  membersByHandle: {},
  terminal: false,
  runOver: false,
  ...overrides,
})

const editorSubject = (overrides: Partial<LivePreviewEditorSubject> = {}): LivePreviewEditorSubject => ({
  kind: 'editor',
  sessionId: SESSION_ID,
  sessionGone: false,
  onStartFresh: () => {},
  ...overrides,
})

let host: { container: HTMLDivElement; root: Root } | undefined

function tree(subject: LivePreviewSubject, chrome?: ReactNode) {
  return (
    <TooltipProvider>
      <LivePreview subject={subject} {...(chrome === undefined ? {} : { chrome })} />
    </TooltipProvider>
  )
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function mount(subject: LivePreviewSubject, chrome?: ReactNode): Promise<void> {
  unmount()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  host = { container, root }
  act(() => { root.render(tree(subject, chrome)) })
  await flush()
}

async function rerender(subject: LivePreviewSubject, chrome?: ReactNode): Promise<void> {
  const current = host
  if (current === undefined) throw new Error('nothing is mounted')
  act(() => { current.root.render(tree(subject, chrome)) })
  await flush()
}

function unmount(): void {
  if (host === undefined) return
  const current = host
  host = undefined
  act(() => { current.root.unmount() })
  current.container.remove()
}

async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

const q = (selector: string) => document.querySelector(selector)
const qa = (selector: string) => [...document.querySelectorAll(selector)]
const previewState = () => q('[data-preview-state]')?.getAttribute('data-preview-state')
const embed = () => q('[data-live-embed]') as HTMLIFrameElement | null
const embedWindow = (): Window | null => embed()?.contentWindow ?? null

async function post(data: unknown, source: Window | null = embedWindow()): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { data, source }))
    await Promise.resolve()
  })
}

const frame = (width = 800, height = 600, kind = 'cdp-screencast') => ({
  event: 'frame',
  ts: Date.now(),
  kind,
  width,
  height,
})
const lost = { event: 'lost' }

/** A second, unrelated window: a sibling iframe the preview did not render. */
function strangerWindow(): Window {
  const other = document.createElement('iframe')
  document.body.appendChild(other)
  const win = other.contentWindow
  if (win === null) throw new Error('jsdom gave the stranger iframe no window')
  return win
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(BASE_TIME)
  fetchLiveUrlMock.mockImplementation(async (runId: string, handle = 0) => ({
    liveUrl: `http://x/live/${runId}#v2.a.b.${String(Date.now())}`,
    expiresAt: Date.now() + TTL_MS,
    handle,
    stream: { kind: 'cdp-screencast' },
  }))
  fetchEditorLiveUrlMock.mockImplementation(async (sessionId: string) => ({
    liveUrl: `http://x/live/${sessionId}#v2.e.b.${String(Date.now())}`,
    expiresAt: Date.now() + TTL_MS,
    stream: { kind: 'cdp-screencast' },
  }))
})

afterEach(() => {
  unmount()
  for (const stray of qa('iframe')) stray.remove()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('the preview listens only to its own embed', () => {
  it('BRIDGE-SOURCE-CHECKED: a report from another window or from no window changes nothing', async () => {
    await mount(runSubject())
    expect(embed()).not.toBeNull()
    const before = previewState()

    await post(frame(), strangerWindow())
    const afterStranger = previewState()
    await post(frame(), null)
    const afterNull = previewState()
    await post({ event: 'refused', reason: 'SENTINEL-POSTED-4d2e' })
    const afterUnknownWord = previewState()
    await post(frame())

    expect({ before, afterStranger, afterNull, afterUnknownWord, after: previewState() }).toEqual({
      before: 'loading',
      afterStranger: 'loading',
      afterNull: 'loading',
      afterUnknownWord: 'loading',
      after: 'live',
    })
    expect(document.body.innerHTML).not.toContain('SENTINEL-POSTED-4d2e')
  })
})

describe('the iframe is the one sandboxed embed with the host hint', () => {
  it('HOST-HINT-IN-SRC: the src is the minted liveUrl with the host query before the fragment', async () => {
    await mount(runSubject())
    expect(embed()?.getAttribute('src')).toBe(`http://x/live/${RUN_ID}?host=dashboard#v2.a.b.${String(BASE_TIME)}`)
  })

  it('SANDBOX-SCRIPTS-ONLY: the sandbox is exactly allow-scripts', async () => {
    await mount(runSubject())
    expect(qa('iframe')).toHaveLength(1)
    expect(embed()?.getAttribute('sandbox')).toBe('allow-scripts')
  })
})

describe('renew in place, reconnect by remount', () => {
  it('HALF-LIFE-RENEW-KEEPS-IFRAME: the renew changes only the fragment of the same node, and a failed renew is expired once its token runs out', async () => {
    await mount(runSubject())
    await post(frame())
    const first = embed()
    expect(fetchLiveUrlMock).toHaveBeenCalledTimes(1)

    await advance(TTL_MS / 2)
    expect(fetchLiveUrlMock).toHaveBeenCalledTimes(2)
    expect(embed()).toBe(first)
    expect(embed()?.getAttribute('src')).toBe(
      `http://x/live/${RUN_ID}?host=dashboard#v2.a.b.${String(BASE_TIME + TTL_MS / 2)}`,
    )

    // 428 WR-04: a failed renew with time left on the token keeps the picture and asks again.
    fetchLiveUrlMock.mockRejectedValue(new Error('live_url_mint_failed'))
    await advance(TTL_MS / 2)
    expect(fetchLiveUrlMock).toHaveBeenCalledTimes(3)
    await post(frame())
    expect(previewState(), 'the token the embed holds is still good').toBe('live')
    await advance(RENEW_RETRY_MS)
    expect(fetchLiveUrlMock, 'the renew is asked again').toHaveBeenCalledTimes(4)

    const renewedExpiry = BASE_TIME + TTL_MS / 2 + TTL_MS
    while (Date.now() < renewedExpiry) await advance(RENEW_RETRY_MS)
    expect({
      state: previewState(),
      dot: q('[data-live-dot]')?.getAttribute('data-live-dot'),
      words: q('[data-preview-words]')?.textContent,
      action: q('[data-preview-action]')?.getAttribute('data-preview-action'),
    }).toEqual({ state: 'expired', dot: 'red', words: PREVIEW_EXPIRED_TEXT, action: 'refresh' })
  })

  it('RECONNECT-REMOUNTS: a lost report, the first backoff, a fresh mint, and a different iframe node', async () => {
    await mount(runSubject())
    await post(frame())
    const first = embed()
    expect(first).not.toBeNull()

    await post(lost)
    expect(previewState()).toBe('reconnecting')
    expect(q('[data-live-dot]')?.getAttribute('data-live-dot')).toBe('amber')

    await advance(LIVE_RECONNECT_BACKOFF_MS[0])
    expect(fetchLiveUrlMock).toHaveBeenCalledTimes(2)
    expect(embed()).not.toBeNull()
    expect(embed()).not.toBe(first)
  })
})

describe('the corner dot', () => {
  it('ONE-DOT-WITH-NAME-AND-TOOLTIP: one focusable button named for the state, described by its meaning', async () => {
    await mount(runSubject())
    expect(qa('[data-live-dot]'), 'no dot before the first frame').toHaveLength(0)
    await post(frame())

    const dots = qa('[data-live-dot]')
    expect(dots).toHaveLength(1)
    const dot = dots[0] as HTMLElement
    expect(dot.tagName).toBe('BUTTON')
    expect(dot.getAttribute('data-live-dot')).toBe('green')
    expect(dot.getAttribute('aria-label')).toBe(LIVE_DOT_NAMES.green)
    const meaningId = dot.getAttribute('aria-describedby')
    expect(meaningId).toBeTruthy()
    const meaning = document.getElementById(meaningId ?? '')
    expect(meaning?.hidden).toBe(true)
    expect(meaning?.textContent).toBe(LIVE_DOT_MEANINGS.green)
    expect(dot.tabIndex).toBe(0)
    act(() => { dot.focus() })
    expect(document.activeElement).toBe(dot)
  })

  // RE-SPELLED 2026-09-26 (428-34, owner decision 2026-09-26 (4), G-428-4). Was "ASPECT-BOX: the
  // frame box takes the reported aspect ratio and holds both the iframe and the corner". The owner
  // moved the dot off the picture into the preview's chrome, so the box holds the picture alone.
  it('ASPECT-BOX: the frame box takes the reported aspect ratio and holds only the iframe', async () => {
    await mount(runSubject())
    await post(frame(800, 600))
    const box = q('[data-preview-frame]') as HTMLElement | null
    expect(box).not.toBeNull()
    expect(box?.style.aspectRatio).toBe('800 / 600')
    expect([...(box?.children ?? [])].map((child) => child.hasAttribute('data-live-embed'))).toEqual([true])
    expect({
      dot: box?.querySelector('[data-live-dot]') ?? null,
      corner: box?.querySelector('[data-preview-corner]') ?? null,
      words: box?.querySelector('[data-preview-words]') ?? null,
    }).toEqual({ dot: null, corner: null, words: null })
  })

  // RE-SPELLED 2026-09-26 (owner decision 2026-09-26 (6)). Was "... puts the label in the chrome's
  // status cluster, right after the green dot". The dot left the chrome for the top-right corner, so
  // the label now leads the status cluster on its own while the dot stays green in its corner.
  it('SNAPSHOT-LABEL: a snapshot frame puts the label first in the chrome\'s status cluster, with the green dot in its corner', async () => {
    await mount(runSubject())
    await post(frame(800, 600))
    expect(q('[data-snapshot-label]'), 'a screencast frame carries no label').toBeNull()
    await post(frame(800, 600, 'snapshot'))
    const corner = q('[data-preview-chrome] [data-preview-corner]')
    expect(corner?.firstElementChild?.hasAttribute('data-snapshot-label')).toBe(true)
    expect(corner?.querySelector('[data-snapshot-label]')?.textContent).toBe(SNAPSHOT_PREVIEW_LABEL)
    expect(corner?.querySelector('[data-live-dot]') ?? null).toBeNull()
    expect(q('[data-preview-dot-corner] [data-live-dot]')?.getAttribute('data-live-dot')).toBe('green')
  })

  // The words are read inside the chrome since 2026-09-26 (428-34, G-428-4); the claim is unchanged.
  it('AMBER-WORDS: a frame then nothing for the freshness window turns the dot amber with its words', async () => {
    await mount(runSubject())
    await post(frame())
    expect(q('[data-live-dot]')?.getAttribute('data-live-dot')).toBe('green')
    expect(q('[data-preview-words]')).toBeNull()

    await advance(LIVE_FRESHNESS_WINDOW_MS)
    expect({
      state: previewState(),
      dot: q('[data-live-dot]')?.getAttribute('data-live-dot'),
      words: q('[data-preview-chrome] [data-preview-corner] [data-preview-words]')?.textContent,
    }).toEqual({ state: 'delayed', dot: 'amber', words: PREVIEW_DELAYED_TEXT })
  })

  // The words and the action are read inside the chrome since 2026-09-26 (428-34, G-428-4).
  it('RED-ACTION: four lost reports through their backoffs turn red with a Reconnect that mints again', async () => {
    await mount(runSubject())
    await post(frame())
    for (const backoff of LIVE_RECONNECT_BACKOFF_MS) {
      await post(lost)
      expect(previewState()).toBe('reconnecting')
      await advance(backoff)
    }
    await post(lost)
    const calls = fetchLiveUrlMock.mock.calls.length

    const action = q('[data-preview-chrome] [data-preview-action]') as HTMLButtonElement | null
    expect({
      state: previewState(),
      dot: q('[data-live-dot]')?.getAttribute('data-live-dot'),
      words: q('[data-preview-chrome] [data-preview-words]')?.textContent,
      action: action?.getAttribute('data-preview-action'),
      label: action?.textContent,
      calls,
    }).toEqual({
      state: 'disconnected',
      dot: 'red',
      words: PREVIEW_DISCONNECTED_TEXT,
      action: 'reconnect',
      label: LIVE_PREVIEW_ACTION_LABELS.reconnect,
      calls: 1 + LIVE_RECONNECT_BACKOFF_MS.length,
    })
    expect(LIVE_PREVIEW_ACTION_LABELS.reconnect).toBe('Reconnect')

    const before = embed()
    await act(async () => {
      action?.click()
      await Promise.resolve()
    })
    await flush()
    expect(fetchLiveUrlMock).toHaveBeenCalledTimes(calls + 1)
    expect(previewState()).toBe('loading')
    expect(embed()).not.toBeNull()
    expect(embed()).not.toBe(before)
  })
})

describe('the chrome row renders only with content', () => {
  // RE-SPELLED 2026-09-26 (428-33, owner decision 2026-09-26 (3), G-428-3). Was "CHROME-ONLY-WITH-
  // CONTENT: a single-member run has no row; two handles or a host chrome node have one". The owner
  // removed the handle selector, so a run subject never has chrome of its own; the host decides the
  // handle. A run subject watching handle 1 of a suite still renders no row, no picker and no select.
  //
  // RE-SPELLED AGAIN 2026-09-26 (428-34, owner decision 2026-09-26 (4), G-428-4). Was "... a run
  // subject renders no row and never a picker; a host chrome node has one". The status cluster now
  // leads the chrome, so a run subject has a row once it has something to say beside the picture.
  // Before its mint answers it has neither status nor host chrome, and so no row.
  //
  // RE-SPELLED 2026-09-26 (owner decision 2026-09-26 (6)): the dot alone never makes a row, so the
  // status that makes one is loading's words, and a live green frame takes the row away again.
  it('CHROME-ONLY-WITH-CONTENT: no status and no host chrome is no row; status words alone or a host chrome node alone makes one', async () => {
    const unanswered = () => new Promise<never>(() => {})
    fetchLiveUrlMock.mockImplementationOnce(unanswered)
    await mount(runSubject({ handle: 0 }))
    expect({ state: previewState(), chrome: q('[data-preview-chrome]') }).toEqual({ state: 'loading', chrome: null })

    fetchLiveUrlMock.mockImplementationOnce(unanswered)
    await mount(runSubject({ handle: 1 }))
    expect({
      chrome: q('[data-preview-chrome]'),
      pickers: qa('[data-handle-picker]').length,
      selects: qa('select').length,
    }).toEqual({ chrome: null, pickers: 0, selects: 0 })

    await mount(runSubject({ handle: 0 }))
    const statusOnly = q('[data-preview-chrome]')
    expect(previewState()).toBe('loading')
    expect([...(statusOnly?.children ?? [])].map((child) => child.hasAttribute('data-preview-corner'))).toEqual([true])
    await post(frame())
    expect({ state: previewState(), chrome: q('[data-preview-chrome]') }).toEqual({ state: 'live', chrome: null })

    fetchEditorLiveUrlMock.mockImplementationOnce(unanswered)
    await mount(editorSubject(), <span data-editor-toolbar>toolbar</span>)
    const hostOnly = q('[data-preview-chrome]')
    expect({
      toolbar: hostOnly?.querySelector('[data-editor-toolbar]') !== null,
      corner: hostOnly?.querySelector('[data-preview-corner]') ?? null,
    }).toEqual({ toolbar: true, corner: null })
  })
})

// OWNER DECISION 2026-09-26 (6), superseding (4): "There should not be a row / border just for this
// ... it should be at the top right of the browser container and should be very subtle". The dot
// floats alone in the preview area's top-right corner, outside both the chrome row and the frame
// box; the snapshot label, the words and the one action still lead the chrome when there are any.
describe('the dot floats top-right, outside the chrome', () => {
  it('DOT-TOP-RIGHT: the dot is in its own corner, never in the chrome, and the picture holds no status', async () => {
    const pictureStatus = () => {
      const box = q('[data-preview-frame]')
      return {
        iframe: box?.querySelector('[data-live-embed]') !== null && box !== null,
        dot: box?.querySelector('[data-live-dot]') ?? null,
        corner: box?.querySelector('[data-preview-corner]') ?? null,
        words: box?.querySelector('[data-preview-words]') ?? null,
      }
    }
    const bare = { iframe: true, dot: null, corner: null, words: null }

    const cornerDot = () => q('[data-preview-dot-corner] [data-live-dot]')?.getAttribute('data-live-dot') ?? null

    await mount(runSubject())
    await post(frame())
    expect({ chrome: q('[data-preview-chrome]'), dot: cornerDot() }).toEqual({ chrome: null, dot: 'green' })
    expect(q('[data-preview-dot-corner]')?.parentElement?.contains(q('[data-preview-frame]'))).toBe(true)
    expect(pictureStatus()).toEqual(bare)

    await mount(editorSubject(), <span data-editor-toolbar>toolbar</span>)
    await post(frame())
    const children = [...(q('[data-preview-chrome]')?.children ?? [])]
    expect(children.map((child) =>
      child.hasAttribute('data-preview-corner') ? 'status' : child.hasAttribute('data-editor-toolbar') ? 'toolbar' : 'other',
    )).toEqual(['toolbar'])
    expect(q('[data-preview-chrome] [data-live-dot]')).toBeNull()
    expect(cornerDot()).toBe('green')
    expect(pictureStatus()).toEqual(bare)

    await mount(runSubject())
    await post(frame())
    for (const backoff of LIVE_RECONNECT_BACKOFF_MS) {
      await post(lost)
      await advance(backoff)
    }
    await post(lost)
    const status = q('[data-preview-chrome] [data-preview-corner]')
    expect({
      state: previewState(),
      dot: cornerDot(),
      dotInChrome: q('[data-preview-chrome] [data-live-dot]'),
      words: status?.querySelector('[data-preview-words]')?.textContent ?? null,
      action: status?.querySelector('[data-preview-action]')?.getAttribute('data-preview-action') ?? null,
    }).toEqual({ state: 'disconnected', dot: 'red', dotInChrome: null, words: PREVIEW_DISCONNECTED_TEXT, action: 'reconnect' })
    expect(pictureStatus()).toEqual(bare)
  })
})

describe('the host decides the handle', () => {
  it('HANDLE-FROM-HOST: the preview mints for the handle it is given, and a new handle starts over with a mint for it', async () => {
    await mount(runSubject({ handle: 0 }))
    expect(fetchLiveUrlMock.mock.calls.at(-1)).toEqual([RUN_ID, 0])
    await post(frame())
    expect(previewState()).toBe('live')

    await rerender(runSubject({ handle: 1 }))
    expect({
      lastCall: fetchLiveUrlMock.mock.calls.at(-1),
      state: previewState(),
    }).toEqual({ lastCall: [RUN_ID, 1], state: 'loading' })

    const calls = fetchLiveUrlMock.mock.calls.length
    await rerender(runSubject({ handle: 1 }))
    expect(fetchLiveUrlMock, 'the same handle again is not a new subject').toHaveBeenCalledTimes(calls)
  })
})

describe('the editor subject', () => {
  it('EDITOR-START-FRESH: a session that is gone says so, and Start fresh calls the host', async () => {
    const onStartFresh = vi.fn()
    await mount(editorSubject({ onStartFresh }))
    expect(fetchEditorLiveUrlMock).toHaveBeenCalledWith(SESSION_ID)
    expect(fetchLiveUrlMock).not.toHaveBeenCalled()
    expect(q('[data-preview-subject]')?.getAttribute('data-preview-subject')).toBe('editor')
    expect(embed()?.getAttribute('src')).toBe(`http://x/live/${SESSION_ID}?host=dashboard#v2.e.b.${String(BASE_TIME)}`)

    await rerender(editorSubject({ onStartFresh, sessionGone: true }))
    const action = q('[data-preview-action]') as HTMLButtonElement | null
    expect({
      state: previewState(),
      dot: q('[data-live-dot]')?.getAttribute('data-live-dot'),
      action: action?.getAttribute('data-preview-action'),
      label: action?.textContent,
      iframes: qa('iframe').length,
    }).toEqual({
      state: 'session-ended',
      dot: 'red',
      action: 'start-fresh',
      label: LIVE_PREVIEW_ACTION_LABELS['start-fresh'],
      iframes: 0,
    })

    await act(async () => { action?.click() })
    expect(onStartFresh).toHaveBeenCalledTimes(1)
  })
})

// THE NEEDLE IS CONCATENATED so this file cannot satisfy a census of the removed motion by matching
// itself.
const REMOVED_DOT_KEYFRAMES = 'live-' + 'dot'

// RE-SPELLED 2026-09-26 (428-32, owner decision 2026-09-26 (5), G-428-5). This describe was "motion
// (D-02, dot geometry and motion)" and its cell was REDUCED-MOTION-STILL-DOT, "only the green dot
// pulses, and it is still under reduced motion". The owner asked for a plain dot, so the dot is still
// under any motion preference. D-02's geometry, its three colours and its three names stay.
describe('the still dot', () => {
  it('DOT-IS-STILL: no .live-dot rule animates, no dot keyframes exist, and three colours and three names remain', () => {
    const css = readFileSync(resolve(__dirname, '../../../styles/globals.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '')
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)].map((match) => ({
      selector: (match[1] ?? '').trim(),
      body: match[2] ?? '',
    }))
    const dotRules = rules.filter((rule) => rule.selector.includes('.live-dot'))
    expect(dotRules.map((rule) => rule.selector), 'the control: the dot rules are read').toContain('.live-dot')
    const animating = dotRules
      .filter((rule) => /(?:^|[;\s])animation(?:-name)?\s*:/u.test(rule.body))
      .map((rule) => rule.selector)
    expect(animating).toEqual([])
    const keyframes = [...css.matchAll(/@keyframes\s+([\w-]+)/gu)].map((match) => match[1] ?? '')
    expect(keyframes.length, 'the control: keyframes are read').toBeGreaterThan(0)
    expect(keyframes.filter((name) => name.startsWith(REMOVED_DOT_KEYFRAMES))).toEqual([])

    const colours = (['green', 'amber', 'red'] as const).map((state) => {
      const rule = rules.find((each) => each.selector === `.live-dot-${state}`)
      return /background-color:\s*([^;]+);/u.exec(rule?.body ?? '')?.[1]?.trim()
    })
    expect(colours.every((colour) => colour !== undefined), JSON.stringify(colours)).toBe(true)
    expect(new Set(colours).size, JSON.stringify(colours)).toBe(3)

    expect(Object.keys(LIVE_DOT_NAMES).sort()).toEqual(['amber', 'green', 'red'])
    expect(new Set(Object.values(LIVE_DOT_NAMES)).size).toBe(3)
  })
})

describe('cleanup', () => {
  it('CLEANUP-ON-UNMOUNT: no fetch after unmount, and a late post throws nothing and changes nothing', async () => {
    await mount(runSubject())
    const win = embedWindow()
    expect(win).not.toBeNull()
    const calls = fetchLiveUrlMock.mock.calls.length
    unmount()

    await advance(TTL_MS * 2)
    expect(fetchLiveUrlMock).toHaveBeenCalledTimes(calls)
    await expect(post(frame(), win)).resolves.toBeUndefined()
    await expect(post(lost, win)).resolves.toBeUndefined()
    expect(q('[data-live-preview]')).toBeNull()
    expect(fetchLiveUrlMock).toHaveBeenCalledTimes(calls)
  })

  it('CLEANUP-ON-UNMOUNT (subject change): a new subject starts over and the old timers are gone', async () => {
    const SWITCH_AFTER_MS = 10_000
    await mount(runSubject())
    await post(frame())
    expect(previewState()).toBe('live')
    await advance(SWITCH_AFTER_MS)

    await rerender(runSubject({ runId: 'r2' }))
    expect(fetchLiveUrlMock.mock.calls.at(-1)).toEqual(['r2', 0])
    expect(previewState()).toBe('loading')

    // The first subject's renew was due at TTL / 2 after mount; the second's is due later.
    const calls = fetchLiveUrlMock.mock.calls.length
    await advance(TTL_MS / 2 - SWITCH_AFTER_MS / 2)
    expect(fetchLiveUrlMock, 'the old half-life timer is gone').toHaveBeenCalledTimes(calls)
    await advance(SWITCH_AFTER_MS)
    expect(fetchLiveUrlMock.mock.calls.at(-1), 'the new subject renews on its own clock').toEqual(['r2', 0])
    expect(fetchLiveUrlMock).toHaveBeenCalledTimes(calls + 1)
  })
})
