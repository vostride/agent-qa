// The FRAME PROXY — the server end of one viewer's socket.
//
// WHAT IT HOLDS AND WHAT IT DOES NOT. It holds a validator it was HANDED, a run lookup it was
// HANDED and, when it serves editor sessions, an editor lookup it was HANDED. It parses no token,
// mints nothing, and reads no token off a URL: the first text message is the only carriage, and
// `deps.validate` is the function layer's own `validateLiveUrlToken` bound to the same signer that
// minted (LIVE-02's third prohibition made structural).
//
// TWO SUBJECTS, ONE SOCKET. The path id names a run or an editor session, and the
// token's SIGNED subject kind decides which lookup is asked. A run token only ever reaches the run
// lookup and an editor token only ever reaches the editor lookup, even when both hold the same id.
// Validation always comes before either lookup, so `unknown_run` and `unknown_session` are only
// reachable with a valid token for that exact id.
//
// a detach NEVER touches the run. Closing a viewer's socket unsubscribes it from the frame
// hub and clears this socket's timers, and that is the whole of it — nothing that ends a run,
// nothing that tears one down, no effect a person would not expect from closing a window.
//
// THAT CLAIM IS PINNED BY A SOURCE SCAN, which is why the run-ending verb does not appear anywhere
// in this file, not even in prose: `live-view.frame-proxy.test.ts` cell (21) asserts the token is
// absent from these bytes, so an implementation that grew the call — or a comment that talked
// itself into one — is a named RED rather than a review someone has to notice.

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
  /** the editor-subject lookup. Absent means no editor subject is served on this socket. */
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
      // the capture time and kind the frame CARRIES, forwarded when present. The proxy
      // keeps no clock of its own for this: a time taken here measures socket delivery, not capture.
      send(ws, {
        type: 'frame',
        id: frame.id,
        width: frame.metadata.width,
        height: frame.metadata.height,
        ...(frame.metadata.timestamp !== undefined ? { ts: frame.metadata.timestamp } : {}),
        ...(frame.kind !== undefined ? { kind: frame.kind } : {}),
      })
      // THE BINARY HALF IS GUARDED TOO. The check at the top of this callback is not
      // enough: a socket can close between it and here, and `ws.send` then THROWS — straight up
      // into the hub's delivery walk, which detaches the viewer and reports the fault. The header
      // above already goes through the guarded writer; this one used to be bare.
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

    /**
     * THIS HANDLE'S STREAM ENDED UNDER THE VIEWER, AND THE HUB SAYS WHY (403 CR-03, 428 RESEARCH P9).
     *
     * `withdrawn`: a multi-member run settles one member at a time, and the member's browser goes
     * down with it. Without a word the viewer kept a frozen last frame under
     * `data-embed-state="live"` until the whole run ended — a stale picture claiming to be live,
     * which is exactly what the embed page's own law forbids. The socket is NOT closed:
     * `runFinished` is a different fact, it is still coming, and a viewer who is told one end is
     * not thereby told the other.
     *
     * `closed`: the hub itself went down because the whole subject is over. That is not a finished
     * member, so nothing is said here; the subject's own end message follows.
     */
    const onStreamEnd = (reason: LiveFrameEndReason): void => {
      subscription = undefined
      if (reason === 'withdrawn') send(ws, { type: 'ended', reason: 'handleFinished' })
    }

    const validateAs = (token: string, kind: LiveViewSubjectKind): LiveUrlVerdict =>
      deps.validate(token, { subject: { kind, id: runId }, now: now() })

    /**
     * RESOLVE THE SUBJECT BY THE TOKEN'S SIGNED KIND. A run first; only a
     * `scope_mismatch` there, on a socket that serves editor sessions, is worth asking again as an
     * editor. Every other refusal is the answer as it stands.
     */
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
      // SUBSCRIBE FIRST, THEN READY (428 D-14, #274). `ready` tells the page a first frame is
      // coming, so it may only be said once a subscription exists. A declared stream whose
      // subscription comes back undefined settled between the two reads, and the viewer is told
      // so by name instead of waiting for a frame that will never arrive.
      // `{ kind: 'none' }` is an HONEST answer, not a failure: the socket stays open so the page
      // can still receive `ended`, and no painter is ever started.
      if (stream.kind !== 'none') {
        subscription = source.subscribeFrames(handle, onFrame, onStreamEnd)
        if (subscription === undefined) {
          refuse('unknown_handle')
          return
        }
      }
      // an editor subject reuses the published fields as they are. `runId` is the path id
      // and `handle` is 0; no subject field is added.
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
      // THE CAP IS A BYTE CAP, AND THE DIFFERENCE IS NOT PEDANTRY. `String#length` counts UTF-16
      // code units, so a hello padded with multi-byte characters sits under a 4096-CHARACTER cap
      // while being several kilobytes of actual traffic — and bytes are what the socket buffered,
      // what the process allocated, and what T-403-11 is about. Measured off the received frame
      // where there is one, so the number is the wire's own rather than a re-encoding of it.
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
        // D-02's silent re-mint, INSIDE the socket: a fresh token extends this viewer's deadline
        // without re-opening anything. It is re-validated in full — a renew is not a lesser check.
        if (subjectKind === undefined) {
          refuse('malformed')
          return
        }
        const verdict = validateAs(message.token, subjectKind)
        if (verdict.kind !== 'ok') {
          refuse(verdict.reason)
          return
        }
        // a token is view-scoped to one handle, so a renew must name the handle this
        // socket greeted with; and an older token, replayed or reordered, never shortens the
        // deadline a newer one set.
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
      // D-16, AND NOTHING ELSE. Detach releases this viewer's hold and this socket's timers. The
      // run is not consulted, not ended, and not told.
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
