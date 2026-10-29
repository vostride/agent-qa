// THE LIVE PREVIEW'S CLOSED SETS AND ITS INPUT, PINNED BY TYPE (428 D-14/D-15/D-16, v54 bar).
//
// Each runtime array and its union are two spellings of one closed set; the runtime twin is
// CLOSED-SETS-428 in live-preview.test.ts. NO-BUS-INPUT is D-15 rule 4: no bus envelope, liveness
// source or socket state can reach the machine, so health read off the bus is a type error.

import { expectTypeOf, test } from 'vitest'
import type {
  LiveStreamKind,
  LiveUrlRefusalReason,
  RunEventEnvelope,
} from '@vostride/agent-qa-schema'

import {
  LIVE_DOT_STATES,
  LIVE_EMBED_END_REASONS,
  LIVE_EMBED_REFUSAL_REASONS,
  LIVE_EMBED_REPORT_EVENTS,
  LIVE_EMBED_STREAM_KINDS,
  LIVE_PREVIEW_ACTIONS,
  LIVE_PREVIEW_STATES,
  type LiveDotState,
  type LiveEmbedEndReason,
  type LiveEmbedRefusalReason,
  type LiveEmbedReportEvent,
  type LivePreviewAction,
  type LivePreviewEvent,
  type LivePreviewStateName,
} from '../live-preview'

type FieldTypes<U> = U extends unknown ? U[keyof U] : never

test('preview states are an exact union', () => {
  type Expected =
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
  expectTypeOf<LivePreviewStateName>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof LIVE_PREVIEW_STATES)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<LivePreviewStateName, (typeof LIVE_PREVIEW_STATES)[number]>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<(typeof LIVE_PREVIEW_STATES)[number], LivePreviewStateName>>().toEqualTypeOf<never>()
})

test('live dot states are an exact union', () => {
  type Expected = 'green' | 'amber' | 'red'
  expectTypeOf<LiveDotState>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof LIVE_DOT_STATES)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<LiveDotState, (typeof LIVE_DOT_STATES)[number]>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<(typeof LIVE_DOT_STATES)[number], LiveDotState>>().toEqualTypeOf<never>()
})

test('embed report events are an exact union', () => {
  type Expected = 'ready' | 'frame' | 'ended' | 'refused' | 'lost'
  expectTypeOf<LiveEmbedReportEvent>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof LIVE_EMBED_REPORT_EVENTS)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<LiveEmbedReportEvent, (typeof LIVE_EMBED_REPORT_EVENTS)[number]>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<(typeof LIVE_EMBED_REPORT_EVENTS)[number], LiveEmbedReportEvent>>().toEqualTypeOf<never>()
})

test('preview actions are an exact union', () => {
  type Expected = 'reconnect' | 'refresh' | 'start-fresh'
  expectTypeOf<LivePreviewAction>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof LIVE_PREVIEW_ACTIONS)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<LivePreviewAction, (typeof LIVE_PREVIEW_ACTIONS)[number]>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<(typeof LIVE_PREVIEW_ACTIONS)[number], LivePreviewAction>>().toEqualTypeOf<never>()
})

test('the parser knows every declared stream kind and no other', () => {
  expectTypeOf<(typeof LIVE_EMBED_STREAM_KINDS)[number]>().toEqualTypeOf<LiveStreamKind>()
})

test('embed end reasons are an exact union', () => {
  type Expected = 'runFinished' | 'handleFinished' | 'sessionEnded'
  expectTypeOf<LiveEmbedEndReason>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof LIVE_EMBED_END_REASONS)[number]>().toEqualTypeOf<Expected>()
})

test('the token verdicts plus the three the socket alone answers', () => {
  type Expected = LiveUrlRefusalReason | 'unknown_run' | 'unknown_handle' | 'unknown_session'
  expectTypeOf<LiveEmbedRefusalReason>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof LIVE_EMBED_REFUSAL_REASONS)[number]>().toEqualTypeOf<Expected>()
})

/**
 * The transport state a bus liveness judgement read, restated here since 428 D-03 deleted the
 * reducer's `LivenessSource`: an `EventSource.readyState` and whether the source is retrying.
 * The machine must still admit neither.
 */
interface BusTransportState {
  readyState: number
  erroredWhileConnecting: boolean
}

test('NO-BUS-INPUT: the machine admits no bus envelope, liveness source or socket state', () => {
  expectTypeOf<Extract<LivePreviewEvent, { envelope: unknown }>>().toEqualTypeOf<never>()
  expectTypeOf<Extract<LivePreviewEvent, { readyState: unknown }>>().toEqualTypeOf<never>()
  expectTypeOf<Extract<FieldTypes<LivePreviewEvent>, RunEventEnvelope>>().toEqualTypeOf<never>()
  expectTypeOf<Extract<RunEventEnvelope, FieldTypes<LivePreviewEvent>>>().toEqualTypeOf<never>()
  expectTypeOf<Extract<BusTransportState, FieldTypes<LivePreviewEvent>>>().toEqualTypeOf<never>()
})
