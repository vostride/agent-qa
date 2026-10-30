// Every clock is a parameter, so window cells sit on either side of the half-open boundary.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { LiveStreamDeclaration, LiveViewSubjectKind } from '@vostride/agent-qa-schema'

import {
  LIVE_DOT_MEANINGS,
  LIVE_DOT_NAMES,
  LIVE_DOT_STATES,
  LIVE_EDITOR_SESSION_GONE_CLOSE_CODE,
  LIVE_EMBED_END_REASONS,
  LIVE_EMBED_REFUSAL_REASONS,
  LIVE_EMBED_REPORT_EVENTS,
  LIVE_EMBED_STREAM_KINDS,
  LIVE_FRESHNESS_WINDOW_MS,
  LIVE_PREVIEW_ACTION_LABELS,
  LIVE_PREVIEW_ACTIONS,
  LIVE_PREVIEW_HOST_QUERY,
  LIVE_PREVIEW_STATES,
  LIVE_RECONNECT_BACKOFF_MS,
  NO_STREAM_RETRY_MS,
  NO_STREAM_TEXT,
  PREVIEW_DELAYED_TEXT,
  PREVIEW_DISCONNECTED_TEXT,
  PREVIEW_EXPIRED_TEXT,
  PREVIEW_LOADING_TEXT,
  PREVIEW_MEMBER_ENDED_TEXT,
  PREVIEW_RECONNECTING_TEXT,
  PREVIEW_RUN_ENDED_TEXT,
  PREVIEW_SESSION_ENDED_TEXT,
  PREVIEW_UNAVAILABLE_TEXT,
  SNAPSHOT_PREVIEW_LABEL,
  WAITING_ATTEMPT_LIMIT,
  WAITING_GAVE_UP_LABEL,
  WAITING_GAVE_UP_TEXT,
  createInitialLivePreview,
  deriveLivePreview,
  parseEmbedReport,
  reduceLivePreview,
  type EmbedReport,
  type LivePreviewEvent,
  type LivePreviewMachine,
  type LivePreviewView,
} from '../live-preview'

describe('the preview vocabulary', () => {
  it('the states, dots, report events and actions are exactly the published sets', () => {
    expect(LIVE_PREVIEW_STATES).toEqual([
      'loading',
      'waiting',
      'live',
      'delayed',
      'reconnecting',
      'disconnected',
      'expired',
      'session-ended',
      'run-ended',
      'member-ended',
      'no-stream',
      'unavailable',
    ])
    expect(LIVE_DOT_STATES).toEqual(['green', 'amber', 'red'])
    expect(LIVE_EMBED_REPORT_EVENTS).toEqual(['ready', 'frame', 'ended', 'refused', 'lost'])
    expect(LIVE_PREVIEW_ACTIONS).toEqual(['reconnect', 'refresh', 'start-fresh'])
    expect(LIVE_EMBED_STREAM_KINDS).toEqual(['cdp-screencast', 'snapshot', 'mjpeg', 'webrtc'])
    expect(LIVE_EMBED_END_REASONS).toEqual(['runFinished', 'handleFinished', 'sessionEnded'])
    expect(LIVE_EMBED_REFUSAL_REASONS).toEqual([
      'malformed',
      'bad_signature',
      'expired',
      'scope_mismatch',
      'unknown_run',
      'unknown_handle',
      'unknown_session',
    ])
    expect(Object.keys(LIVE_PREVIEW_ACTION_LABELS).sort()).toEqual([...LIVE_PREVIEW_ACTIONS].sort())
    expect(Object.keys(LIVE_DOT_NAMES).sort()).toEqual([...LIVE_DOT_STATES].sort())
    expect(Object.keys(LIVE_DOT_MEANINGS).sort()).toEqual([...LIVE_DOT_STATES].sort())
    for (const text of [
      ...Object.values(LIVE_PREVIEW_ACTION_LABELS),
      ...Object.values(LIVE_DOT_NAMES),
      ...Object.values(LIVE_DOT_MEANINGS),
    ]) {
      expect(text.trim().length, 'every label is a real sentence').toBeGreaterThan(0)
    }
  })

  it('the constants and the corner copy are the recorded defaults', () => {
    expect(LIVE_FRESHNESS_WINDOW_MS).toBe(5_000)
    expect(LIVE_RECONNECT_BACKOFF_MS).toEqual([1_000, 2_000, 4_000])
    expect(NO_STREAM_RETRY_MS).toBe(2_500)
    expect(WAITING_ATTEMPT_LIMIT).toBe(24)
    expect(LIVE_PREVIEW_HOST_QUERY).toBe('?host=dashboard')
    expect(LIVE_EDITOR_SESSION_GONE_CLOSE_CODE).toBe(4404)
    expect(SNAPSHOT_PREVIEW_LABEL).toBe('Snapshot preview · updates every 1s')
    expect(PREVIEW_LOADING_TEXT).toBe('Connecting to the preview…')
    expect(PREVIEW_DELAYED_TEXT).toBe('Preview delayed')
    expect(PREVIEW_RECONNECTING_TEXT).toBe('Reconnecting…')
    expect(PREVIEW_DISCONNECTED_TEXT).toBe('Disconnected')
    expect(PREVIEW_EXPIRED_TEXT).toBe('Link expired')
    expect(PREVIEW_SESSION_ENDED_TEXT).toBe('Session ended')
    expect(PREVIEW_RUN_ENDED_TEXT).toBe('Run ended')
    expect(PREVIEW_MEMBER_ENDED_TEXT).toBe('This test finished while the run goes on')
    expect(PREVIEW_UNAVAILABLE_TEXT).toBe('Live preview is not available here')
    expect(NO_STREAM_TEXT).toBe('no live preview for this target — the step list keeps advancing')
    expect(WAITING_GAVE_UP_TEXT).toBe('waited for the live view, but nothing arrived — the step list keeps advancing')
    expect(WAITING_GAVE_UP_LABEL).toBe('gave up')
    expect(LIVE_PREVIEW_ACTION_LABELS).toEqual({ reconnect: 'Reconnect', refresh: 'Refresh', 'start-fresh': 'Start fresh' })
    expect(LIVE_DOT_NAMES).toEqual({
      green: 'Live preview healthy',
      amber: 'Live preview delayed',
      red: 'Live preview stopped',
    })
  })

  it('PARSE-EMBED-REPORT-CLOSED: only the closed report shapes parse, into fresh objects', () => {
    expect(parseEmbedReport({ event: 'frame', ts: 1, kind: 'snapshot', width: 2, height: 3 })).toEqual({
      event: 'frame',
      ts: 1,
      kind: 'snapshot',
      width: 2,
      height: 3,
    })

    const stringTs = parseEmbedReport({ event: 'frame', ts: '1', kind: 'snapshot', width: 2, height: 3 })
    expect(stringTs, 'a mistyped optional field is dropped, not trusted').toEqual({
      event: 'frame',
      kind: 'snapshot',
      width: 2,
      height: 3,
    })
    expect(stringTs).not.toHaveProperty('ts')

    const withToken = parseEmbedReport({ event: 'frame', token: 'v2.x', ts: 1, width: 2, height: 3 })
    expect(withToken).toEqual({ event: 'frame', ts: 1, width: 2, height: 3 })
    expect(withToken, 'an extra field is never carried').not.toHaveProperty('token')
    expect(JSON.stringify(withToken)).not.toContain('v2.')

    const input = { event: 'ended', reason: 'sessionEnded' }
    const ended = parseEmbedReport(input)
    expect(ended).toEqual({ event: 'ended', reason: 'sessionEnded' })
    expect(ended, 'the parsed report is a fresh object').not.toBe(input)

    expect(parseEmbedReport({ event: 'ready', kind: 'cdp-screencast' })).toEqual({ event: 'ready', kind: 'cdp-screencast' })
    expect(parseEmbedReport({ event: 'ready', kind: 'none' })).toEqual({ event: 'ready', kind: 'none' })
    expect(parseEmbedReport({ event: 'refused', reason: 'expired' })).toEqual({ event: 'refused', reason: 'expired' })
    expect(parseEmbedReport({ event: 'lost', extra: 1 })).toEqual({ event: 'lost' })

    expect(parseEmbedReport({ event: 'hello' })).toBeUndefined()
    expect(parseEmbedReport(null)).toBeUndefined()
    expect(parseEmbedReport('frame')).toBeUndefined()
    expect(parseEmbedReport({ event: 'refused', reason: 'nonsense' })).toBeUndefined()
    expect(parseEmbedReport({ event: 'ended', reason: 'finished' })).toBeUndefined()
    expect(parseEmbedReport({ event: 'ready', kind: 'vnc' })).toBeUndefined()
    expect(parseEmbedReport({ event: 'frame', ts: 1, width: '2', height: 3 })).toBeUndefined()
    expect(parseEmbedReport({ event: 'frame', ts: 1, width: Number.NaN, height: 3 })).toBeUndefined()
    expect(parseEmbedReport(['frame'])).toBeUndefined()
  })

  it('NO-BUS-IMPORT: the machine source names no bus, liveness source, socket state or run-stream opener', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/lib/live-preview.ts'), 'utf8')
    const needles = [
      'run-stream' + '-reducer',
      'RunEvent' + 'Envelope',
      'Liveness' + 'Source',
      'openRun' + 'Stream',
      'ready' + 'State',
    ]
    for (const needle of needles) {
      expect(source, `live-preview.ts must not mention ${needle}`).not.toContain(needle)
    }
  })
})

const T = 1_000_000
const W = 1280
const H = 720

const minted = (kind: LiveStreamDeclaration['kind'], memberAnswered = true): LivePreviewEvent => ({
  type: 'minted',
  stream: { kind } as LiveStreamDeclaration,
  memberAnswered,
})
const embed = (report: EmbedReport): LivePreviewEvent => ({ type: 'embed', report })
const frame = (ts: number | undefined, kind?: 'cdp-screencast' | 'snapshot'): LivePreviewEvent =>
  embed({ event: 'frame', ...(ts === undefined ? {} : { ts }), ...(kind === undefined ? {} : { kind }), width: W, height: H })
const lost: LivePreviewEvent = embed({ event: 'lost' })

function play(state: LivePreviewMachine, steps: ReadonlyArray<readonly [LivePreviewEvent, number]>): LivePreviewMachine {
  return steps.reduce((next, [event, at]) => reduceLivePreview(next, event, at), state)
}

/** Minted, socket ready, no frame yet. */
function embedded(at: number, kind: 'cdp-screencast' | 'snapshot' = 'cdp-screencast'): LivePreviewMachine {
  return play(createInitialLivePreview(), [
    [{ type: 'mint-started' }, at],
    [minted(kind), at],
    [embed({ event: 'ready', kind }), at],
  ])
}

/** Embedded with one on-time frame at `at`. */
function liveAt(at: number, kind: 'cdp-screencast' | 'snapshot' = 'cdp-screencast'): LivePreviewMachine {
  return reduceLivePreview(embedded(at, kind), frame(at, kind), at)
}

const ENTRY_POINTS: ReadonlyArray<{ subject: { kind: LiveViewSubjectKind }; memberAnswered: boolean }> = [
  { subject: { kind: 'run' }, memberAnswered: true },
  // An editor session's browser is up once the session exists, so its mint always has an answer.
  { subject: { kind: 'editor' }, memberAnswered: true },
]

function oneMachineScript(memberAnswered: boolean): LivePreviewView[] {
  const trace: LivePreviewView[] = []
  let state = createInitialLivePreview()
  const step = (event: LivePreviewEvent, at: number, deriveAt = at) => {
    state = reduceLivePreview(state, event, at)
    trace.push(deriveLivePreview(state, deriveAt))
  }
  step({ type: 'mint-started' }, T - 100)
  step(minted('cdp-screencast', memberAnswered), T - 50)
  step(embed({ event: 'ready', kind: 'cdp-screencast' }), T - 20)
  step(frame(T), T, T + 1_000)
  trace.push(deriveLivePreview(state, T + 5_000))
  step(frame(T + 6_000), T + 6_000)
  step(lost, T + 7_000)
  step(lost, T + 8_000)
  step(lost, T + 10_000)
  step(lost, T + 14_000)
  step({ type: 'retry' }, T + 20_000)
  step(minted('cdp-screencast', memberAnswered), T + 20_100)
  step(frame(T + 20_500), T + 20_500)
  step({ type: 'renew-failed' }, T + 30_000)
  step({ type: 'reset' }, T + 31_000)
  return trace
}

const size = { width: W, height: H }

describe('one machine for both entry points', () => {
  describe.each(ENTRY_POINTS)('the $subject.kind subject', ({ memberAnswered }) => {
    it('ONE-MACHINE-BOTH-ENTRY-POINTS: the same event script derives the same corner, step by step', () => {
      const trace = oneMachineScript(memberAnswered)
      expect(trace).toEqual([
        { state: 'loading', words: PREVIEW_LOADING_TEXT, snapshot: false },
        { state: 'loading', words: PREVIEW_LOADING_TEXT, snapshot: false },
        { state: 'loading', words: PREVIEW_LOADING_TEXT, snapshot: false },
        { state: 'live', dot: 'green', snapshot: false, frameSize: size },
        { state: 'delayed', dot: 'amber', words: PREVIEW_DELAYED_TEXT, snapshot: false, frameSize: size },
        { state: 'live', dot: 'green', snapshot: false, frameSize: size },
        { state: 'reconnecting', dot: 'amber', words: PREVIEW_RECONNECTING_TEXT, snapshot: false, retryInMs: 1_000, frameSize: size },
        { state: 'reconnecting', dot: 'amber', words: PREVIEW_RECONNECTING_TEXT, snapshot: false, retryInMs: 2_000, frameSize: size },
        { state: 'reconnecting', dot: 'amber', words: PREVIEW_RECONNECTING_TEXT, snapshot: false, retryInMs: 4_000, frameSize: size },
        { state: 'disconnected', dot: 'red', words: PREVIEW_DISCONNECTED_TEXT, action: 'reconnect', snapshot: false, frameSize: size },
        { state: 'loading', words: PREVIEW_LOADING_TEXT, snapshot: false },
        { state: 'loading', words: PREVIEW_LOADING_TEXT, snapshot: false },
        { state: 'live', dot: 'green', snapshot: false, frameSize: size },
        { state: 'expired', dot: 'red', words: PREVIEW_EXPIRED_TEXT, action: 'refresh', snapshot: false, frameSize: size },
        { state: 'loading', words: PREVIEW_LOADING_TEXT, snapshot: false },
      ])
      expect(trace, 'the other entry point, same script').toEqual(oneMachineScript(ENTRY_POINTS[0].memberAnswered))
    })

    it('LOADING-UNTIL-FIRST-FRAME: minted and ready but no frame yet is no dot and the one loading sentence', () => {
      const view = deriveLivePreview(embedded(T), T + 60_000)
      expect(view.state).toBe('loading')
      expect(view.dot).toBeUndefined()
      expect(view.words).toBe(PREVIEW_LOADING_TEXT)
      expect(deriveLivePreview(createInitialLivePreview(), T)).toEqual(view)
    })
  })

  it('FRESHNESS-BOUNDARY: the window is half-open at LIVE_FRESHNESS_WINDOW_MS', () => {
    const state = liveAt(T)
    expect(deriveLivePreview(state, T + 4_999).dot).toBe('green')
    const late = deriveLivePreview(state, T + LIVE_FRESHNESS_WINDOW_MS)
    expect(late.dot).toBe('amber')
    expect(late.state).toBe('delayed')
    expect(late.words).toBe(PREVIEW_DELAYED_TEXT)
  })

  it('STALL-TURNS-AMBER: frames every 200 ms, then none; green until 5 s after the last, then amber', () => {
    let state = embedded(T)
    for (let at = T; at <= T + 2_000; at += 200) {
      state = reduceLivePreview(state, frame(at), at)
      expect(deriveLivePreview(state, at + 199).dot).toBe('green')
    }
    const last = T + 2_000
    for (let at = last; at < last + 5_000; at += 100) {
      expect(deriveLivePreview(state, at).dot, `green at +${at - last} ms`).toBe('green')
    }
    expect(deriveLivePreview(state, last + 5_000).dot).toBe('amber')
    expect(deriveLivePreview(state, last + 60_000).dot).toBe('amber')
  })

  it('STATIC-PAGE-STAYS-GREEN: the 2 s keepalive keeps the dot green for a minute', () => {
    let state = embedded(T)
    let nextFrame = T
    for (let at = T; at <= T + 60_000; at += 500) {
      while (nextFrame <= at) {
        state = reduceLivePreview(state, frame(nextFrame), nextFrame)
        nextFrame += 2_000
      }
      expect(deriveLivePreview(state, at).dot, `green at +${at - T} ms`).toBe('green')
    }
  })

  it.each([
    ['behind', -600_000],
    ['ahead of', 600_000],
  ])('SKEW-CALIBRATED: a producer clock ten minutes %s the viewer still reads green, and a stall still ages', (_, offset) => {
    let state = embedded(T)
    for (let at = T; at <= T + 10_000; at += 1_000) {
      state = reduceLivePreview(state, frame(at + offset), at)
      expect(deriveLivePreview(state, at + 500).dot).toBe('green')
    }
    const last = T + 10_000
    expect(deriveLivePreview(state, last + 4_999).dot).toBe('green')
    expect(deriveLivePreview(state, last + 5_000).dot).toBe('amber')

    const untimed = reduceLivePreview(state, frame(undefined), last + 6_000)
    expect(deriveLivePreview(untimed, last + 6_000).dot, 'a frame without ts ages from its arrival').toBe('green')
    expect(deriveLivePreview(untimed, last + 10_999).dot).toBe('green')
    expect(deriveLivePreview(untimed, last + 11_000).dot).toBe('amber')
  })

  it('SNAPSHOT-LABEL-IFF-SNAPSHOT-FRAME: the flag follows the newest frame, and only while green', () => {
    expect(SNAPSHOT_PREVIEW_LABEL).toBe('Snapshot preview · updates every 1s')

    const snap = liveAt(T, 'snapshot')
    expect(deriveLivePreview(snap, T + 1_000)).toMatchObject({ state: 'live', dot: 'green', snapshot: true })

    const fallback = reduceLivePreview(embedded(T, 'cdp-screencast'), frame(T, 'snapshot'), T)
    expect(deriveLivePreview(fallback, T + 1_000).snapshot, 'the snapshot fallback under a screencast declaration').toBe(true)
    const back = reduceLivePreview(fallback, frame(T + 1_000, 'cdp-screencast'), T + 1_000)
    expect(deriveLivePreview(back, T + 1_500).snapshot).toBe(false)

    const unlabelled = reduceLivePreview(embedded(T, 'snapshot'), frame(T), T)
    expect(deriveLivePreview(unlabelled, T + 500).snapshot, 'a kind-less frame takes the declared kind').toBe(true)

    expect(deriveLivePreview(snap, T + 5_000)).toMatchObject({ dot: 'amber', snapshot: false })
    expect(deriveLivePreview(reduceLivePreview(snap, lost, T + 1_000), T + 1_000)).toMatchObject({ dot: 'amber', snapshot: false })
    expect(deriveLivePreview(reduceLivePreview(snap, { type: 'renew-failed' }, T + 1_000), T + 1_000)).toMatchObject({
      dot: 'red',
      snapshot: false,
    })
  })

  it('LOST-RECONNECTS-THEN-DISCONNECTS: three quiet attempts on the backoff, then red with Reconnect', () => {
    let state = liveAt(T)
    for (let attempt = 1; attempt <= LIVE_RECONNECT_BACKOFF_MS.length; attempt += 1) {
      state = reduceLivePreview(state, lost, T + attempt)
      expect(deriveLivePreview(state, T + attempt)).toMatchObject({
        state: 'reconnecting',
        dot: 'amber',
        words: PREVIEW_RECONNECTING_TEXT,
        retryInMs: LIVE_RECONNECT_BACKOFF_MS[attempt - 1],
      })
      expect(deriveLivePreview(state, T + attempt).action).toBeUndefined()
    }
    state = reduceLivePreview(state, lost, T + 10)
    const fourth = deriveLivePreview(state, T + 10)
    expect(fourth).toMatchObject({ state: 'disconnected', dot: 'red', words: PREVIEW_DISCONNECTED_TEXT, action: 'reconnect' })
    expect(fourth.retryInMs).toBeUndefined()

    let again = play(liveAt(T), [
      [lost, T + 1],
      [lost, T + 2],
      [{ type: 'lost-scheduled' }, T + 3],
      [minted('cdp-screencast'), T + 4],
    ])
    expect(deriveLivePreview(again, T + 4), 'a fresh mint is not a frame').toMatchObject({ state: 'reconnecting', retryInMs: 2_000 })
    again = reduceLivePreview(again, frame(T + 5), T + 5)
    expect(deriveLivePreview(again, T + 5).state).toBe('live')
    again = reduceLivePreview(again, lost, T + 6)
    expect(deriveLivePreview(again, T + 6), 'a frame after a reconnect resets the count').toMatchObject({
      state: 'reconnecting',
      retryInMs: 1_000,
    })
  })

  it('RENEW-FAILURE-EXPIRED: a failed silent re-mint and an expired refusal are red with Refresh', () => {
    for (const event of [{ type: 'renew-failed' }, embed({ event: 'refused', reason: 'expired' })] as const) {
      expect(deriveLivePreview(reduceLivePreview(liveAt(T), event, T + 1), T + 1)).toEqual({
        state: 'expired',
        dot: 'red',
        words: PREVIEW_EXPIRED_TEXT,
        action: 'refresh',
        snapshot: false,
        frameSize: size,
      })
    }
  })

  it('REFUSED-BY-REASON: a lost subject reconnects and any other refusal disconnects', () => {
    for (const reason of ['unknown_run', 'unknown_handle'] as const) {
      const view = deriveLivePreview(reduceLivePreview(liveAt(T), embed({ event: 'refused', reason }), T + 1), T + 1)
      expect(view).toMatchObject({ state: 'reconnecting', retryInMs: 1_000 })
    }
    for (const reason of ['malformed', 'bad_signature', 'scope_mismatch'] as const) {
      const view = deriveLivePreview(reduceLivePreview(liveAt(T), embed({ event: 'refused', reason }), T + 1), T + 1)
      expect(view).toMatchObject({ state: 'disconnected', dot: 'red', action: 'reconnect' })
    }
  })

  it('SESSION-GONE-START-FRESH: every way an editor session goes away is red with Start fresh', () => {
    const gone: LivePreviewMachine[] = [
      reduceLivePreview(createInitialLivePreview(), { type: 'mint-refused', word: 'unknown_session' }, T),
      reduceLivePreview(liveAt(T), embed({ event: 'refused', reason: 'unknown_session' }), T + 1),
      reduceLivePreview(liveAt(T), embed({ event: 'ended', reason: 'sessionEnded' }), T + 1),
      reduceLivePreview(liveAt(T), { type: 'subject-over', reason: 'session-ended' }, T + 1),
    ]
    for (const state of gone) {
      expect(deriveLivePreview(state, T + 2)).toMatchObject({
        state: 'session-ended',
        dot: 'red',
        words: PREVIEW_SESSION_ENDED_TEXT,
        action: 'start-fresh',
        snapshot: false,
      })
    }
  })

  it('ENDINGS-HAVE-NO-ALARM: run-ended, member-ended, no-stream and unavailable say their sentence with no dot', () => {
    const cases: Array<[LivePreviewMachine, LivePreviewView['state'], string]> = [
      [reduceLivePreview(liveAt(T), embed({ event: 'ended', reason: 'runFinished' }), T + 1), 'run-ended', PREVIEW_RUN_ENDED_TEXT],
      [reduceLivePreview(liveAt(T), { type: 'subject-over', reason: 'run-ended' }, T + 1), 'run-ended', PREVIEW_RUN_ENDED_TEXT],
      [reduceLivePreview(liveAt(T), embed({ event: 'ended', reason: 'handleFinished' }), T + 1), 'member-ended', PREVIEW_MEMBER_ENDED_TEXT],
      [reduceLivePreview(createInitialLivePreview(), minted('none', true), T), 'no-stream', NO_STREAM_TEXT],
      [reduceLivePreview(createInitialLivePreview(), { type: 'mint-refused', word: 'live_view_unavailable' }, T), 'unavailable', PREVIEW_UNAVAILABLE_TEXT],
    ]
    for (const [state, name, words] of cases) {
      const view = deriveLivePreview(state, T + 2)
      expect(view.state).toBe(name)
      expect(view.words).toBe(words)
      expect(view.dot, `${name} carries no alarm colour`).toBeUndefined()
      expect(view.action).toBeUndefined()
      expect(view.snapshot).toBe(false)
    }

    const over = reduceLivePreview(liveAt(T), embed({ event: 'ended', reason: 'runFinished' }), T + 1)
    expect(deriveLivePreview(reduceLivePreview(over, frame(T + 2), T + 2), T + 2).state, 'an ending is not undone by a late frame').toBe('run-ended')
    expect(deriveLivePreview(reduceLivePreview(over, lost, T + 2), T + 2).state).toBe('run-ended')
  })

  it('NOT-YET-VS-NO: a none before the member starts is waiting, after it is no-stream', () => {
    const notYet = reduceLivePreview(createInitialLivePreview(), minted('none', false), T)
    expect(deriveLivePreview(notYet, T)).toEqual({ state: 'waiting', words: PREVIEW_LOADING_TEXT, snapshot: false })

    const unknownRun = reduceLivePreview(createInitialLivePreview(), { type: 'mint-refused', word: 'unknown_run' }, T)
    expect(deriveLivePreview(unknownRun, T).state).toBe('waiting')

    expect(deriveLivePreview(reduceLivePreview(createInitialLivePreview(), minted('none', true), T), T).state).toBe('no-stream')
    expect(deriveLivePreview(reduceLivePreview(notYet, minted('none', true), T + 1), T + 1).state, 'the member started meanwhile').toBe('no-stream')
    expect(deriveLivePreview(reduceLivePreview(notYet, minted('cdp-screencast', false), T + 1), T + 1).state, 'the browser came up').toBe('loading')
  })

  it('BOUNDED-WAIT: the wait gives up once at WAITING_ATTEMPT_LIMIT and never re-enters waiting', () => {
    let state = createInitialLivePreview()
    for (let attempt = 1; attempt < WAITING_ATTEMPT_LIMIT; attempt += 1) {
      const event: LivePreviewEvent = attempt % 5 === 0 ? { type: 'mint-refused', word: 'unknown_run' } : minted('none', false)
      state = reduceLivePreview(state, event, T + attempt * NO_STREAM_RETRY_MS)
      expect(deriveLivePreview(state, T).state, `attempt ${attempt}`).toBe('waiting')
    }
    state = reduceLivePreview(state, minted('none', false), T + 100_000)
    const gaveUp = {
      state: 'no-stream',
      words: WAITING_GAVE_UP_TEXT,
      label: WAITING_GAVE_UP_LABEL,
      snapshot: false,
    }
    expect(deriveLivePreview(state, T + 100_000)).toEqual(gaveUp)
    state = reduceLivePreview(state, minted('none', false), T + 110_000)
    expect(deriveLivePreview(state, T + 110_000)).toEqual(gaveUp)
    state = reduceLivePreview(state, { type: 'mint-refused', word: 'unknown_run' }, T + 120_000)
    expect(deriveLivePreview(state, T + 120_000)).toEqual(gaveUp)

    expect(reduceLivePreview(state, { type: 'reset' }, T + 130_000), 'a new subject starts over').toEqual(createInitialLivePreview())
  })

  it('WAIT-UNANSWERED-COUNTS: an interval that passes with the question still out counts toward the bound', () => {
    let state = reduceLivePreview(createInitialLivePreview(), minted('none', false), T)
    for (let attempt = 2; attempt < WAITING_ATTEMPT_LIMIT; attempt += 1) {
      state = reduceLivePreview(state, { type: 'wait-unanswered' }, T + attempt * NO_STREAM_RETRY_MS)
      expect(deriveLivePreview(state, T).state, `attempt ${attempt}`).toBe('waiting')
    }
    state = reduceLivePreview(state, { type: 'wait-unanswered' }, T + 100_000)
    expect(deriveLivePreview(state, T + 100_000)).toMatchObject({ state: 'no-stream', label: WAITING_GAVE_UP_LABEL })
    expect(
      reduceLivePreview(state, minted('cdp-screencast', false), T + 110_000),
      'an answer landing after the bound does not reopen it',
    ).toEqual(state)

    const live = liveAt(T)
    expect(reduceLivePreview(live, { type: 'wait-unanswered' }, T + 1), 'outside waiting it changes nothing').toBe(live)
    const minting = createInitialLivePreview()
    expect(reduceLivePreview(minting, { type: 'wait-unanswered' }, T + 1)).toBe(minting)
  })

  it('NO-NUMBERS-IN-WORDS: every state the machine can reach says its words without a digit', () => {
    const reached: LivePreviewView[] = [
      deriveLivePreview(createInitialLivePreview(), T),
      deriveLivePreview(reduceLivePreview(createInitialLivePreview(), minted('none', false), T), T),
      deriveLivePreview(liveAt(T), T + 1),
      deriveLivePreview(liveAt(T, 'snapshot'), T + 1),
      deriveLivePreview(liveAt(T), T + 8_000),
      ...[1, 2, 3, 4].map((count) => {
        let state = liveAt(T)
        for (let n = 0; n < count; n += 1) state = reduceLivePreview(state, lost, T + n)
        return deriveLivePreview(state, T + 10)
      }),
      deriveLivePreview(reduceLivePreview(liveAt(T), { type: 'renew-failed' }, T + 1), T + 1),
      deriveLivePreview(reduceLivePreview(liveAt(T), { type: 'subject-over', reason: 'session-ended' }, T + 1), T + 1),
      deriveLivePreview(reduceLivePreview(liveAt(T), { type: 'subject-over', reason: 'run-ended' }, T + 1), T + 1),
      deriveLivePreview(reduceLivePreview(liveAt(T), embed({ event: 'ended', reason: 'handleFinished' }), T + 1), T + 1),
      deriveLivePreview(reduceLivePreview(createInitialLivePreview(), minted('none', true), T), T),
      deriveLivePreview(
        Array.from({ length: WAITING_ATTEMPT_LIMIT }).reduce<LivePreviewMachine>(
          (state, _, n) => reduceLivePreview(state, minted('none', false), T + n),
          createInitialLivePreview(),
        ),
        T,
      ),
      deriveLivePreview(reduceLivePreview(createInitialLivePreview(), { type: 'mint-refused', word: 'live_view_unavailable' }, T), T),
    ]
    expect(new Set(reached.map((view) => view.state)), 'the census covers every state').toEqual(new Set(LIVE_PREVIEW_STATES))
    for (const view of reached) {
      expect(view.words ?? '', `${view.state} words`).not.toMatch(/\d/)
      expect(view.label ?? '', `${view.state} label`).not.toMatch(/\d/)
    }
    expect(SNAPSHOT_PREVIEW_LABEL, 'the one number in the corner is the literal snapshot label').toMatch(/\d/)
  })

  it('PURE-AND-TOTAL: every event from every phase answers a state and never mutates its input', () => {
    const events: LivePreviewEvent[] = [
      { type: 'mint-started' },
      minted('cdp-screencast'),
      minted('none', false),
      minted('none', true),
      { type: 'mint-refused', word: 'unknown_run' },
      { type: 'mint-refused', word: 'unknown_session' },
      { type: 'mint-refused', word: 'live_view_unavailable' },
      { type: 'renew-failed' },
      embed({ event: 'ready', kind: 'cdp-screencast' }),
      frame(T),
      embed({ event: 'ended', reason: 'runFinished' }),
      embed({ event: 'refused', reason: 'malformed' }),
      lost,
      { type: 'lost-scheduled' },
      { type: 'wait-unanswered' },
      { type: 'retry' },
      { type: 'subject-over', reason: 'run-ended' },
      { type: 'reset' },
    ]
    const starts = events.map((event) => reduceLivePreview(liveAt(T), event, T + 1))
    for (const start of [createInitialLivePreview(), liveAt(T), ...starts]) {
      const before = JSON.stringify(start)
      for (const event of events) {
        const next = reduceLivePreview(Object.freeze(start), event, T + 2)
        expect(LIVE_PREVIEW_STATES).toContain(deriveLivePreview(next, T + 3).state)
      }
      expect(JSON.stringify(start)).toBe(before)
    }
  })
})
