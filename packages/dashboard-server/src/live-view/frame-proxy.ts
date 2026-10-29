// Validation precedes either lookup, and a detach only unsubscribes; the run is never touched.

import type WebSocket from 'ws'

import type {
  LiveFrame,
  LiveFrameEndReason,
  LiveFrameSubscription,
  LiveUrlVerdict,
  LiveViewSubjectKind,
  LiveViewSubjectRef,
  RunSession,
} from '@vostride/agent-qa-schema'

import {
  LIVE_VIEW_HELLO_MAX_BYTES,
  LIVE_VIEW_PING_MS,
  LIVE_VIEW_REFUSAL_CLOSE_CODE,
  LIVE_VIEW_SLOW_VIEWER_BYTES,
} from './protocol.js'
import type { LiveViewRefusalReason, LiveViewServerMessage } from './protocol.js'
import type { LiveEditorAttachment } from './editor-subjects.js'

export interface FrameProxyDeps {
  validate(token: string, expect: { subject: LiveViewSubjectRef; now: number }): LiveUrlVerdict
  attach(runId: string): RunSession | undefined
  // The editor-subject lookup; absent means no editor subject is served on this socket.
  attachEditor?(sessionId: string): LiveEditorAttachment | undefined
  now?: () => number
}

/** What the socket reads frames from: a run session, or an editor session's attachment. */
type FrameSource = Pick<RunSession, 'streamCapabilityOf' | 'subscribeFrames'>

/** Guarded send — the `live-editor/ws-handler.ts` idiom, so a closed socket is never written to. */
function send(ws: WebSocket, message: LiveViewServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message))
}

export function createFrameProxy(deps: FrameProxyDeps): (ws: WebSocket, runId: string) => void {
  const now = deps.now ?? ((): number => Date.now())

  // `runId` is the path id. For an editor subject it is the session id; the published name stays.
  return (ws: WebSocket, runId: string): void => {
    let subscription: LiveFrameSubscription | undefined
    /** The subject kind the greet resolved. A renew is validated against this kind only. */
    let subjectKind: LiveViewSubjectKind | undefined
    /** The handle the greet opened, and the expiry the deadline is armed for. */
    let greetedHandle: number | undefined
    let deadlineAt: number | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    let ping: ReturnType<typeof setInterval> | undefined
    let greeted = false

    const clearTimers = (): void => {
      if (deadline !== undefined) clearTimeout(deadline)
      if (ping !== undefined) clearInterval(ping)
      deadline = undefined
      ping = undefined
    }

    const refuse = (reason: LiveViewRefusalReason): void => {
      send(ws, { type: 'refused', reason })
      clearTimers()
      subscription?.unsubscribe()
      subscription = undefined
      ws.close(LIVE_VIEW_REFUSAL_CLOSE_CODE, reason)
    }

    /** Arm (or re-arm) the expiry deadline. An unrenewed socket is refused BY NAME, not dropped. */
    const armDeadline = (expiresAt: number): void => {
      if (deadline !== undefined) clearTimeout(deadline)
      deadlineAt = expiresAt
      const remaining = Math.max(0, expiresAt - now())
      deadline = setTimeout(() => { refuse('expired') }, remaining)
      deadline.unref?.()
    }

    const onFrame = (frame: LiveFrame): void => {
      if (ws.readyState !== ws.OPEN) return
      // SLOW VIEWER: drop the pixels, ack anyway. CDP will not produce frame N+1 until N is acked,
      // so a viewer that cannot keep up must cost itself frames and never cost the producer its
      // stream. A live view that falls behind should skip, not stall.
      if (ws.bufferedAmount > LIVE_VIEW_SLOW_VIEWER_BYTES) {
        subscription?.ack(frame.id)
        return
      }
      // The capture time and kind the frame carries; a time taken here would measure delivery.
      send(ws, {
        type: 'frame',
        id: frame.id,
        width: frame.metadata.width,
        height: frame.metadata.height,
        ...(frame.metadata.timestamp !== undefined ? { ts: frame.metadata.timestamp } : {}),
        ...(frame.kind !== undefined ? { kind: frame.kind } : {}),
      })
      // A socket can close between the check above and here, and `ws.send` then throws to the hub.
      if (ws.readyState !== ws.OPEN) {
        // The viewer is gone. It owes an ack it can never give, and CDP will not produce the next
        // frame until somebody does — so ack on its behalf rather than stalling the producer.
        subscription?.ack(frame.id)
        return
      }
      try {
        ws.send(frame.bytes, (error?: Error) => {
          // An async write failure costs this viewer the frame and nothing else.
          if (error !== undefined) subscription?.ack(frame.id)
        })
      } catch {
        subscription?.ack(frame.id)
      }
    }

    // `withdrawn` ends one member's stream with the socket left open; `closed` says nothing here.
    const onStreamEnd = (reason: LiveFrameEndReason): void => {
      subscription = undefined
      if (reason === 'withdrawn') send(ws, { type: 'ended', reason: 'handleFinished' })
    }

    const validateAs = (token: string, kind: LiveViewSubjectKind): LiveUrlVerdict =>
      deps.validate(token, { subject: { kind, id: runId }, now: now() })

    // The token's signed kind decides: a run first, then an editor only on a `scope_mismatch`.
    const resolve = (token: string): LiveUrlVerdict => {
      const asRun = validateAs(token, 'run')
      if (asRun.kind === 'refused' && asRun.reason === 'scope_mismatch' && deps.attachEditor) {
        return validateAs(token, 'editor')
      }
      return asRun
    }

    /** Subscribe, then say ready, then wait for the subject's own end. */
    const open = (
      source: FrameSource,
      handle: number,
      expiresAt: number,
      end: { ended: Promise<unknown>; reason: 'runFinished' | 'sessionEnded' },
    ): void => {
      greetedHandle = handle
      const stream = source.streamCapabilityOf(handle)
      // Subscribe before `ready`, which promises a frame; `{ kind: 'none' }` keeps the socket open.
      if (stream.kind !== 'none') {
        subscription = source.subscribeFrames(handle, onFrame, onStreamEnd)
        if (subscription === undefined) {
          refuse('unknown_handle')
          return
        }
      }
      // An editor subject reuses the published fields: `runId` is the path id and `handle` is 0.
      send(ws, { type: 'ready', runId, handle, stream, expiresAt })
      armDeadline(expiresAt)
      ping = setInterval(() => {
        if (ws.readyState === ws.OPEN) ws.ping()
      }, LIVE_VIEW_PING_MS)
      ping.unref?.()

      const finish = (): void => {
        send(ws, { type: 'ended', reason: end.reason })
        clearTimers()
        ws.close(1000, end.reason)
      }
      end.ended.then(finish, finish)
    }

    const greet = (token: string): void => {
      const verdict = resolve(token)
      if (verdict.kind !== 'ok') {
        refuse(verdict.reason)
        return
      }
      const subject = verdict.claims.subject
      subjectKind = subject.kind
      if (subject.kind === 'run') {
        const session = deps.attach(runId)
        if (session === undefined) {
          refuse('unknown_run')
          return
        }
        open(session, subject.handle, verdict.claims.exp, {
          ended: session.done,
          reason: 'runFinished',
        })
        return
      }
      const attachment = deps.attachEditor?.(runId)
      if (attachment === undefined) {
        refuse('unknown_session')
        return
      }
      open(attachment, 0, verdict.claims.exp, { ended: attachment.ended, reason: 'sessionEnded' })
    }

    ws.on('message', (data: unknown, isBinary?: boolean) => {
      // A BINARY first message is malformed by definition — the hello is text.
      if (isBinary === true) {
        refuse('malformed')
        return
      }
      const raw = String(data)
      // A byte cap: multi-byte characters fit a character cap while being kilobytes on the wire.
      const bytes = Buffer.isBuffer(data) ? data.byteLength : Buffer.byteLength(raw)
      if (bytes > LIVE_VIEW_HELLO_MAX_BYTES) {
        refuse('malformed')
        return
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        refuse('malformed')
        return
      }
      if (typeof parsed !== 'object' || parsed === null) {
        refuse('malformed')
        return
      }
      const message = parsed as { type?: unknown; token?: unknown; id?: unknown }

      if (!greeted) {
        if (message.type !== 'hello' || typeof message.token !== 'string') {
          refuse('malformed')
          return
        }
        greeted = true
        greet(message.token)
        return
      }

      if (message.type === 'ack' && typeof message.id === 'number') {
        subscription?.ack(message.id)
        return
      }
      if (message.type === 'renew' && typeof message.token === 'string') {
        // A renew inside the socket extends the deadline and is re-validated in full.
        if (subjectKind === undefined) {
          refuse('malformed')
          return
        }
        const verdict = validateAs(message.token, subjectKind)
        if (verdict.kind !== 'ok') {
          refuse(verdict.reason)
          return
        }
        // A renew must name the greeted handle; a replayed older token never shortens the deadline.
        const renewed = verdict.claims.subject
        if (renewed.kind === 'run' && renewed.handle !== greetedHandle) {
          refuse('scope_mismatch')
          return
        }
        if (deadlineAt === undefined || verdict.claims.exp > deadlineAt) armDeadline(verdict.claims.exp)
        send(ws, { type: 'renewed', expiresAt: deadlineAt ?? verdict.claims.exp })
        return
      }
      refuse('malformed')
    })

    ws.on('close', () => {
      // Detach releases this viewer's hold and timers; the run is not consulted or told.
      subscription?.unsubscribe()
      subscription = undefined
      clearTimers()
    })

    ws.on('error', () => {
      subscription?.unsubscribe()
      subscription = undefined
      clearTimers()
    })
  }
}
