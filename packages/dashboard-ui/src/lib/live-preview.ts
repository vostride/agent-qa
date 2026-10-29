// THE LIVE PREVIEW.
//
// One pure module owns what the preview corner may say for both entry points, a run and an editor
// session. Health comes only from the frame facts the embed page reports; every clock is a
// parameter. The words are exported constants so conformance files can read them by path, which
// is why each is a single-quoted literal with no apostrophe.

import type { LiveStreamDeclaration, LiveStreamKind } from '@vostride/agent-qa-schema'

export type LivePreviewStateName =
  | 'loading'
  | 'waiting'
  | 'live'
  | 'delayed'
  | 'reconnecting'
  | 'disconnected'
  | 'expired'
  | 'session-ended'
  | 'run-ended'
  | 'member-ended'
  | 'no-stream'
  | 'unavailable'
// prettier-ignore
export const LIVE_PREVIEW_STATES = [
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
] as const satisfies readonly LivePreviewStateName[]

export type LiveDotState = 'green' | 'amber' | 'red'
// prettier-ignore
export const LIVE_DOT_STATES = [
  'green',
  'amber',
  'red',
] as const satisfies readonly LiveDotState[]

/** The facts the embed page posts to its host; spelled again here because dashboard-ui imports only ids and schema. */
export type LiveEmbedReportEvent = 'ready' | 'frame' | 'ended' | 'refused' | 'lost'
// prettier-ignore
export const LIVE_EMBED_REPORT_EVENTS = [
  'ready',
  'frame',
  'ended',
  'refused',
  'lost',
] as const satisfies readonly LiveEmbedReportEvent[]

export type LivePreviewAction = 'reconnect' | 'refresh' | 'start-fresh'
// prettier-ignore
export const LIVE_PREVIEW_ACTIONS = [
  'reconnect',
  'refresh',
  'start-fresh',
] as const satisfies readonly LivePreviewAction[]

// prettier-ignore
export const LIVE_EMBED_STREAM_KINDS = [
  'cdp-screencast',
  'snapshot',
  'mjpeg',
  'webrtc',
] as const satisfies readonly LiveStreamKind[]

export type LiveEmbedEndReason = 'runFinished' | 'handleFinished' | 'sessionEnded'
// prettier-ignore
export const LIVE_EMBED_END_REASONS = [
  'runFinished',
  'handleFinished',
  'sessionEnded',
] as const satisfies readonly LiveEmbedEndReason[]

export type LiveEmbedRefusalReason =
  | 'malformed'
  | 'bad_signature'
  | 'expired'
  | 'scope_mismatch'
  | 'unknown_run'
  | 'unknown_handle'
  | 'unknown_session'
// prettier-ignore
export const LIVE_EMBED_REFUSAL_REASONS = [
  'malformed',
  'bad_signature',
  'expired',
  'scope_mismatch',
  'unknown_run',
  'unknown_handle',
  'unknown_session',
] as const satisfies readonly LiveEmbedRefusalReason[]

/** Green iff the newest frame is younger than this; one window for screencast and snapshot frames. */
export const LIVE_FRESHNESS_WINDOW_MS = 5_000

/** One quiet automatic reconnect per entry; the attempt after the last is disconnected. */
export const LIVE_RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000] as const

/** How long the preview waits before asking the mint door again while the browser is not up yet. */
export const NO_STREAM_RETRY_MS = 2_500

/** Backstop only: 24 waiting mints at 2.5 s is about a minute. */
export const WAITING_ATTEMPT_LIMIT = 24

/** How soon a failed silent re-mint asks again while the token it would replace still has time left. */
export const RENEW_RETRY_MS = 5_000

/** The embed's host hint; the server spells the parameter LIVE_EMBED_HOST_PARAM. */
export const LIVE_PREVIEW_HOST_QUERY = '?host=dashboard'

/** The server's close code for an editor control socket whose session is gone. */
export const LIVE_EDITOR_SESSION_GONE_CLOSE_CODE = 4404

/** The server's close code for an editor control socket a newer one replaced; the page does not reconnect. */
export const LIVE_EDITOR_SUPERSEDED_CLOSE_CODE = 4409

export const SNAPSHOT_PREVIEW_LABEL = 'Snapshot preview · updates every 1s'
export const PREVIEW_LOADING_TEXT = 'Connecting to the preview…'
export const PREVIEW_DELAYED_TEXT = 'Preview delayed'
export const PREVIEW_RECONNECTING_TEXT = 'Reconnecting…'
export const PREVIEW_DISCONNECTED_TEXT = 'Disconnected'
export const PREVIEW_EXPIRED_TEXT = 'Link expired'
export const PREVIEW_SESSION_ENDED_TEXT = 'Session ended'
export const PREVIEW_RUN_ENDED_TEXT = 'Run ended'
export const PREVIEW_MEMBER_ENDED_TEXT = 'This test finished while the run goes on'
export const PREVIEW_UNAVAILABLE_TEXT = 'Live preview is not available here'

/** What a target that declared no live stream renders; the step list is named by role, never by position. */
export const NO_STREAM_TEXT = 'no live preview for this target — the step list keeps advancing'

/** What the preview observed when its bounded wait expired, claiming nothing about whether the target has a preview. */
export const WAITING_GAVE_UP_TEXT = 'waited for the live view, but nothing arrived — the step list keeps advancing'

/** The badge beside the gave-up sentence, never part of it. */
export const WAITING_GAVE_UP_LABEL = 'gave up'

export const LIVE_PREVIEW_ACTION_LABELS = {
  reconnect: 'Reconnect',
  refresh: 'Refresh',
  'start-fresh': 'Start fresh',
} as const satisfies Record<LivePreviewAction, string>

export const LIVE_DOT_NAMES = {
  green: 'Live preview healthy',
  amber: 'Live preview delayed',
  red: 'Live preview stopped',
} as const satisfies Record<LiveDotState, string>

export const LIVE_DOT_MEANINGS = {
  green: 'Frames are arriving from the browser.',
  amber: 'The newest frame is late, or the preview is reconnecting.',
  red: 'The preview stopped receiving frames.',
} as const satisfies Record<LiveDotState, string>

export type EmbedReport =
  | { event: 'ready'; kind: LiveStreamKind | 'none' }
  | { event: 'frame'; ts?: number; kind?: LiveStreamKind; width: number; height: number }
  | { event: 'ended'; reason: LiveEmbedEndReason }
  | { event: 'refused'; reason: LiveEmbedRefusalReason }
  | { event: 'lost' }

function oneOf<T extends string>(set: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (set as readonly string[]).includes(value)
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Any window can post to the dashboard, so a report is rebuilt field by field from the closed sets
 * and anything else is dropped. An unknown word never becomes a new member.
 */
export function parseEmbedReport(data: unknown): EmbedReport | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
  const fields = data as Record<string, unknown>
  switch (fields.event) {
    case 'ready': {
      const kind = fields.kind
      if (kind === 'none') return { event: 'ready', kind }
      return oneOf(LIVE_EMBED_STREAM_KINDS, kind) ? { event: 'ready', kind } : undefined
    }
    case 'frame': {
      const { ts, kind, width, height } = fields
      if (!finite(width) || !finite(height)) return undefined
      return {
        event: 'frame',
        ...(finite(ts) ? { ts } : {}),
        ...(oneOf(LIVE_EMBED_STREAM_KINDS, kind) ? { kind } : {}),
        width,
        height,
      }
    }
    case 'ended':
      return oneOf(LIVE_EMBED_END_REASONS, fields.reason) ? { event: 'ended', reason: fields.reason } : undefined
    case 'refused':
      return oneOf(LIVE_EMBED_REFUSAL_REASONS, fields.reason) ? { event: 'refused', reason: fields.reason } : undefined
    case 'lost':
      return { event: 'lost' }
    default:
      return undefined
  }
}

/** The machine's only input. Nothing here can carry a bus envelope or a transport's state. */
export type LivePreviewEvent =
  | { type: 'mint-started' }
  | { type: 'minted'; stream: LiveStreamDeclaration; memberAnswered: boolean }
  | { type: 'mint-refused'; word: string }
  | { type: 'renew-failed' }
  | { type: 'embed'; report: EmbedReport }
  | { type: 'lost-scheduled' }
  /** The not-yet poll's interval passed with its question still out: it counts toward the bound, so a door that never answers still ends the wait. */
  | { type: 'wait-unanswered' }
  | { type: 'retry' }
  | { type: 'subject-over'; reason: 'run-ended' | 'session-ended' }
  | { type: 'reset' }

type LivePreviewPhase =
  | 'minting'
  | 'waiting'
  | 'embedded'
  | 'reconnecting'
  | 'disconnected'
  | 'expired'
  | 'session-ended'
  | 'run-ended'
  | 'member-ended'
  | 'no-stream'
  | 'unavailable'

export interface LivePreviewFrame {
  /** Capture time on the producer's clock, epoch ms. */
  ts: number
  kind?: LiveStreamKind
  width: number
  height: number
  arrivedAt: number
}

export interface LivePreviewMachine {
  phase: LivePreviewPhase
  declared?: LiveStreamKind
  ready?: LiveStreamKind | 'none'
  frame?: LivePreviewFrame
  /** The smallest arrival minus capture seen since the subject was set: the producer-to-viewer clock offset plus the fastest delivery. */
  skew?: number
  reconnectAttempts?: number
  waitingAttempts?: number
  gaveUp?: true
}

export interface LivePreviewView {
  state: LivePreviewStateName
  dot?: LiveDotState
  words?: string
  label?: string
  action?: LivePreviewAction
  snapshot: boolean
  retryInMs?: number
  frameSize?: { width: number; height: number }
}

const ENDED_PHASES: readonly LivePreviewPhase[] = ['run-ended', 'member-ended', 'session-ended']

export function createInitialLivePreview(): LivePreviewMachine {
  return { phase: 'minting' }
}

/** What survives a fresh mint: the clock calibration for this subject and a spent wait. */
function carried(state: LivePreviewMachine): Pick<LivePreviewMachine, 'skew' | 'gaveUp'> {
  return {
    ...(state.skew === undefined ? {} : { skew: state.skew }),
    ...(state.gaveUp === true ? { gaveUp: true } : {}),
  }
}

function lose(state: LivePreviewMachine): LivePreviewMachine {
  const attempts = (state.reconnectAttempts ?? 0) + 1
  const phase = attempts <= LIVE_RECONNECT_BACKOFF_MS.length ? 'reconnecting' : 'disconnected'
  return { ...state, phase, reconnectAttempts: attempts }
}

function wait(state: LivePreviewMachine): LivePreviewMachine {
  if (state.gaveUp === true) return { ...carried(state), phase: 'no-stream' }
  const attempts = (state.waitingAttempts ?? 0) + 1
  return attempts >= WAITING_ATTEMPT_LIMIT
    ? { ...carried(state), phase: 'no-stream', gaveUp: true }
    : { ...carried(state), phase: 'waiting', waitingAttempts: attempts }
}

/**
 * The mint doors' definite refusals: this host serves no live view, or the request itself is one it
 * will never serve. Any other failure (a fetch that never arrived, a 5xx) is worth the quiet
 * reconnect, not a dead end.
 */
const MINT_REFUSED_FOR_GOOD: readonly string[] = ['live_view_unavailable', 'invalid_handle', 'cross_site_refused']

function showing(state: LivePreviewMachine): boolean {
  return state.phase === 'embedded' || state.phase === 'reconnecting'
}

function reduceReport(state: LivePreviewMachine, report: EmbedReport, now: number): LivePreviewMachine {
  switch (report.event) {
    case 'ready':
      if (!showing(state)) return state
      // The greet read the capability after the mint did: a member that withdrew in between is
      // greeted with `none`, and no frame or end will follow on this socket.
      if (report.kind === 'none') return { ...carried(state), phase: 'no-stream' }
      return { ...state, ready: report.kind }
    case 'frame': {
      if (!showing(state)) return state
      const skew = report.ts === undefined ? state.skew : Math.min(state.skew ?? Infinity, now - report.ts)
      const ts = report.ts ?? now - (state.skew ?? 0)
      const kind = report.kind ?? state.declared
      const { reconnectAttempts: _spent, ...rest } = state
      return {
        ...rest,
        phase: 'embedded',
        ...(skew === undefined ? {} : { skew }),
        frame: { ts, ...(kind === undefined ? {} : { kind }), width: report.width, height: report.height, arrivedAt: now },
      }
    }
    case 'ended':
      if (report.reason === 'runFinished') return { ...state, phase: 'run-ended' }
      if (report.reason === 'handleFinished') return { ...state, phase: 'member-ended' }
      return { ...state, phase: 'session-ended' }
    case 'refused':
      if (report.reason === 'expired') return { ...state, phase: 'expired' }
      if (report.reason === 'unknown_session') return { ...state, phase: 'session-ended' }
      if (report.reason === 'unknown_run' || report.reason === 'unknown_handle') return lose(state)
      return { ...state, phase: 'disconnected' }
    case 'lost':
      return showing(state) ? lose(state) : state
  }
}

/** Pure and total: the host passes its clock reading, and an ending is left only by reset. */
export function reduceLivePreview(state: LivePreviewMachine, event: LivePreviewEvent, now: number): LivePreviewMachine {
  if (event.type === 'reset') return createInitialLivePreview()
  if (event.type === 'subject-over') return { ...state, phase: event.reason }
  if (ENDED_PHASES.includes(state.phase)) return state

  switch (event.type) {
    case 'mint-started':
    case 'lost-scheduled':
      return state
    case 'wait-unanswered':
      return state.phase === 'waiting' ? wait(state) : state
    case 'minted': {
      if (event.stream.kind === 'none') {
        return event.memberAnswered ? { ...carried(state), phase: 'no-stream' } : wait(state)
      }
      const declared = event.stream.kind
      if (showing(state)) return { ...state, declared }
      if (state.phase !== 'minting' && state.phase !== 'waiting') return state
      return { ...carried(state), phase: 'embedded', declared }
    }
    case 'mint-refused':
      if (event.word === 'unknown_session') return { ...state, phase: 'session-ended' }
      if (event.word === 'unknown_run') return wait(state)
      return MINT_REFUSED_FOR_GOOD.includes(event.word) ? { ...state, phase: 'unavailable' } : lose(state)
    case 'renew-failed':
      return { ...state, phase: 'expired' }
    case 'embed':
      return reduceReport(state, event.report, now)
    case 'retry':
      return { ...carried(state), phase: 'minting' }
  }
}

function view(state: LivePreviewMachine, fields: Omit<LivePreviewView, 'snapshot'> & { snapshot?: boolean }): LivePreviewView {
  const frame = state.frame
  return {
    snapshot: false,
    ...fields,
    ...(frame === undefined ? {} : { frameSize: { width: frame.width, height: frame.height } }),
  }
}

/** What the corner says at `now`. Reads frame facts only: never a bus, a socket or a run event. */
export function deriveLivePreview(state: LivePreviewMachine, now: number): LivePreviewView {
  switch (state.phase) {
    case 'minting':
      return view(state, { state: 'loading', words: PREVIEW_LOADING_TEXT })
    case 'waiting':
      return view(state, { state: 'waiting', words: PREVIEW_LOADING_TEXT })
    case 'embedded': {
      const frame = state.frame
      if (frame === undefined) return view(state, { state: 'loading', words: PREVIEW_LOADING_TEXT })
      const age = now - (frame.ts + (state.skew ?? 0))
      return age < LIVE_FRESHNESS_WINDOW_MS
        ? view(state, { state: 'live', dot: 'green', snapshot: frame.kind === 'snapshot' })
        : view(state, { state: 'delayed', dot: 'amber', words: PREVIEW_DELAYED_TEXT })
    }
    case 'reconnecting': {
      const attempt = Math.min(Math.max(state.reconnectAttempts ?? 1, 1), LIVE_RECONNECT_BACKOFF_MS.length)
      return view(state, {
        state: 'reconnecting',
        dot: 'amber',
        words: PREVIEW_RECONNECTING_TEXT,
        retryInMs: LIVE_RECONNECT_BACKOFF_MS[attempt - 1],
      })
    }
    case 'disconnected':
      return view(state, { state: 'disconnected', dot: 'red', words: PREVIEW_DISCONNECTED_TEXT, action: 'reconnect' })
    case 'expired':
      return view(state, { state: 'expired', dot: 'red', words: PREVIEW_EXPIRED_TEXT, action: 'refresh' })
    case 'session-ended':
      return view(state, { state: 'session-ended', dot: 'red', words: PREVIEW_SESSION_ENDED_TEXT, action: 'start-fresh' })
    case 'run-ended':
      return view(state, { state: 'run-ended', words: PREVIEW_RUN_ENDED_TEXT })
    case 'member-ended':
      return view(state, { state: 'member-ended', words: PREVIEW_MEMBER_ENDED_TEXT })
    case 'no-stream':
      return state.gaveUp === true
        ? view(state, { state: 'no-stream', words: WAITING_GAVE_UP_TEXT, label: WAITING_GAVE_UP_LABEL })
        : view(state, { state: 'no-stream', words: NO_STREAM_TEXT })
    case 'unavailable':
      return view(state, { state: 'unavailable', words: PREVIEW_UNAVAILABLE_TEXT })
  }
}
