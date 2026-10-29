// THE FRAME PROXY'S STATE MACHINE (403-02 Task 2 · D-02/D-04/D-06/D-16 · T-403-03/04/06/07/11).
//
// EVERY SOCKET-LEVEL CELL DRIVES THE PRODUCTION FRAME. `startServer({ db, port: 0,
// runServiceAttach, liveView })` is what a person's `agent-qa dashboard` runs; the upgrade arm, the
// `?runId=` read, the `createFrameProxy` construction and the embed route are all in `server.ts`,
// not in the proxy module. A suite that called `createFrameProxy` directly would prove the proxy
// works and leave the wiring unmeasured — WINDOWS' "green that never ran". The ONE exception is the
// slow-viewer cell, which needs a socket whose `bufferedAmount` it controls; it says so at the site.
//
// THE VALIDATOR IS THE REAL ONE. `validateLiveUrlToken` from `@vostride/agent-qa-agent`, bound to a
// signer this file constructs — so `bad_signature`, `expired` and `scope_mismatch` are the function
// layer's own verdicts travelling through the proxy, not names this file invented. `agent` is a
// devDependency of this package for exactly this fixture; the package SOURCE still imports nothing
// from it (validate:arch drops `__tests__` from its scan, and the run-service routes' no-agent rule
// is about the shipped bundle).
//
// WHAT IS PLANTED: the `RunSession`. That is the designed injection seam — `runServiceAttach` is a
// first-class `startServer` option — and it is the only way to script a frame source deterministically.

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { AddressInfo } from 'node:net'

import {
  LIVE_URL_SCOPE,
  type LiveFrame,
  type LiveFrameEndReason,
  type LiveFrameSubscription,
  type LiveStreamDeclaration,
  type LiveUrlClaims,
  type LiveUrlSigner,
  type RunCompletion,
  type RunSession,
} from '@vostride/agent-qa-schema'
import { mintLiveUrlToken, validateLiveUrlToken } from '@vostride/agent-qa-agent'
import { createLiveStreamHub } from '@vostride/agent-qa-runner'
import type { LiveStreamCapability, RunTimerPort } from '@vostride/agent-qa-runner'
import WebSocket from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DashboardDatabase } from '../db/database.js'
import {
  LIVE_EMBED_EXPIRED_MESSAGE,
  LIVE_EMBED_HOST_PARAM,
  LIVE_EMBED_NO_STREAM_MESSAGE,
  LIVE_EMBED_REPORT_EVENTS,
  LIVE_EMBED_SESSION_ENDED_MESSAGE,
  LIVE_EMBED_STATES,
} from '../live-view/embed-page.js'
import { createLiveEditorSubjects } from '../live-view/editor-subjects.js'
import type { LiveEditorSubjects } from '../live-view/editor-subjects.js'
import { createFrameProxy } from '../live-view/frame-proxy.js'
import {
  LIVE_VIEW_HELLO_MAX_BYTES,
  LIVE_VIEW_REFUSAL_CLOSE_CODE,
  LIVE_VIEW_SLOW_VIEWER_BYTES,
  LIVE_VIEW_WS_PATH,
} from '../live-view/protocol.js'
import { startServer } from '../server/server.js'

// ---- The signer, and the tokens a viewer presents ----------------------------------------------

const SIGNING_KEY = 'zz-403-02-frame-proxy-signing-key'

/** The `cli/src/composition/live-url-signer.ts` shape, constructed here so no key is ever shared. */
const signer: LiveUrlSigner = {
  sign: (data) => createHmac('sha256', SIGNING_KEY).update(data).digest('base64url'),
  equals: (a, b) => {
    const left = Buffer.from(a)
    const right = Buffer.from(b)
    return left.length === right.length && timingSafeEqual(left, right)
  },
}

function tokenFor(input: {
  runId: string
  handle?: number
  scope?: LiveUrlClaims['scope']
  exp?: number
}): string {
  const now = Date.now()
  return mintLiveUrlToken(signer, {
    subject: { kind: 'run', runId: input.runId, handle: input.handle ?? 0 },
    scope: input.scope ?? LIVE_URL_SCOPE,
    iat: now,
    exp: input.exp ?? now + 60_000,
  })
}

/** An editor subject's token: the same signer and scope, the editor kind. */
function editorTokenFor(input: { sessionId: string; exp?: number }): string {
  const now = Date.now()
  return mintLiveUrlToken(signer, {
    subject: { kind: 'editor', sessionId: input.sessionId },
    scope: LIVE_URL_SCOPE,
    iat: now,
    exp: input.exp ?? now + 60_000,
  })
}

// ---- The planted run session -------------------------------------------------------------------

interface PlantedSession {
  readonly session: RunSession
  /** Push one frame to every attached frame subscriber. */
  emit(frame: LiveFrame): void
  /** Resolve `session.done`, which is what makes the proxy say `ended`. */
  finish(): void
  /**
   * The hub's `register(handle, undefined)` shape, exercised through the seam: the handle's stream
   * ends, its subscriber set is cleared, and every subscriber's `onEnd` is called. The RUN is
   * untouched — `done` is still pending, which is the whole point of CR-03.
   */
  endStream(reason?: LiveFrameEndReason): void
  readonly acked: number[]
  readonly unsubscribes: number
  readonly cancels: number
  readonly subscribeCalls: number
}

function plantSession(input: {
  runId: string
  stream?: LiveStreamDeclaration
  /** Called at the top of every `subscribeFrames`, so a cell can see what was sent before it. */
  onSubscribe?: () => void
  /** `nothing`: the handle settled between the two reads, so the subscription comes back undefined. */
  subscribeAnswers?: 'nothing'
}): PlantedSession {
  const sinks = new Set<(frame: LiveFrame) => void>()
  const ends = new Set<(reason: LiveFrameEndReason) => void>()
  const acked: number[] = []
  let unsubscribes = 0
  let cancels = 0
  let subscribeCalls = 0
  let finish: () => void = () => {}
  const done = new Promise<RunCompletion>((resolve) => {
    finish = () => { resolve({ verdict: 'passed' } as unknown as RunCompletion) }
  })
  const stream = input.stream ?? { kind: 'cdp-screencast' }
  const session = {
    id: input.runId,
    status: 'running',
    executionContext: 'local-headless',
    subscribe: () => () => undefined,
    subscribeFrames: (
      _handle: number,
      onFrame: (frame: LiveFrame) => void,
      onEnd?: (reason: LiveFrameEndReason) => void,
    ): LiveFrameSubscription | undefined => {
      input.onSubscribe?.()
      subscribeCalls += 1
      if (input.subscribeAnswers === 'nothing') return undefined
      sinks.add(onFrame)
      if (onEnd !== undefined) ends.add(onEnd)
      return {
        ack: (frameId: number) => { acked.push(frameId) },
        unsubscribe: () => {
          unsubscribes += 1
          sinks.delete(onFrame)
          if (onEnd !== undefined) ends.delete(onEnd)
        },
      }
    },
    streamCapabilityOf: (): LiveStreamDeclaration => stream,
    cancel: () => { cancels += 1 },
    done,
  } as unknown as RunSession
  return {
    session,
    emit: (frame) => { for (const sink of [...sinks]) sink(frame) },
    finish: () => { finish() },
    endStream: (reason = 'withdrawn') => {
      const leaving = [...ends]
      ends.clear()
      sinks.clear()
      for (const onEnd of leaving) onEnd(reason)
    },
    get acked() { return acked },
    get unsubscribes() { return unsubscribes },
    get cancels() { return cancels },
    get subscribeCalls() { return subscribeCalls },
  }
}

// ---- The production frame ----------------------------------------------------------------------

interface Frame {
  readonly origin: string
  readonly wsOrigin: string
  readonly attach: ReturnType<typeof vi.fn>
  close(): void
}

const openFrames: Frame[] = []
const openSockets: WebSocket[] = []

async function productionFrame(sessions: Record<string, RunSession>): Promise<Frame> {
  const db = new DashboardDatabase({ dbPath: ':memory:' })
  const attach = vi.fn((runId: string): RunSession | undefined => sessions[runId])
  const started = await startServer({
    declaredSecretMask: (text) => text,
    db,
    port: 0,
    runServiceAttach: attach,
    liveView: {
      // BY REFERENCE. A `validate` this file re-implemented would be a second opinion about what a
      // valid token is, which is the exact drift the one-pair rule exists to prevent.
      validate: (token, expectation) => validateLiveUrlToken(signer, token, expectation),
      mintLiveUrl: async () => { throw new Error('this fixture does not mint') },
    },
  })
  const port = (started.server.address() as AddressInfo).port
  const frame: Frame = {
    origin: `http://127.0.0.1:${String(port)}`,
    wsOrigin: `ws://127.0.0.1:${String(port)}`,
    attach,
    close: () => { started.close(); db.close() },
  }
  openFrames.push(frame)
  return frame
}

afterEach(() => {
  while (openSockets.length > 0) {
    const socket = openSockets.pop()
    try { socket?.close() } catch { /* already gone */ }
  }
  while (openFrames.length > 0) openFrames.pop()?.close()
})

// ---- Speaking the protocol ---------------------------------------------------------------------

interface ServerText {
  readonly type?: string
  readonly reason?: string
  readonly stream?: { kind?: string }
  readonly runId?: string
  readonly handle?: number
  readonly expiresAt?: number
  readonly id?: number
  readonly width?: number
  readonly height?: number
  readonly ts?: number
  readonly kind?: string
}

interface Viewer {
  readonly texts: ServerText[]
  readonly binaries: Buffer[]
  /** Every message in arrival order, so a `frame` header's binary partner is provably adjacent. */
  readonly order: string[]
  send(value: unknown): void
  sendRaw(data: string | Buffer, options?: { binary?: boolean }): void
  /** Resolve once a text message of one of these types has arrived. */
  waitFor(types: readonly string[], budgetMs?: number): Promise<ServerText>
  waitForBinaries(count: number, budgetMs?: number): Promise<void>
  waitForClose(budgetMs?: number): Promise<number | undefined>
  close(): void
  readonly closeCode: number | undefined
}

async function openViewer(frame: Frame, query: string): Promise<Viewer> {
  const socket = new WebSocket(`${frame.wsOrigin}${LIVE_VIEW_WS_PATH}${query}`)
  openSockets.push(socket)
  const texts: ServerText[] = []
  const binaries: Buffer[] = []
  const order: string[] = []
  let closeCode: number | undefined
  let closed = false
  const listeners = new Set<() => void>()
  const wake = (): void => { for (const listener of [...listeners]) listener() }

  socket.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) { binaries.push(Buffer.from(data)); order.push('binary') }
    else {
      try { texts.push(JSON.parse(data.toString('utf8')) as ServerText) } catch { texts.push({}) }
      order.push(`text:${texts[texts.length - 1]?.type ?? '?'}`)
    }
    wake()
  })
  socket.on('close', (code: number) => { closeCode = code; closed = true; wake() })
  socket.on('error', () => { closed = true; wake() })

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => { resolve() })
    socket.once('error', (error: Error) => { reject(error) })
    socket.once('close', () => { resolve() })
  })

  const until = (predicate: () => boolean, budgetMs: number, what: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const check = (): void => {
        if (predicate()) { cleanup(); resolve(); return }
        if (closed) { cleanup(); resolve(); return }
      }
      const budget = setTimeout(() => {
        cleanup()
        reject(new Error(`${what}: nothing arrived within ${String(budgetMs)} ms. seen=${order.join('|')}`))
      }, budgetMs)
      const cleanup = (): void => { clearTimeout(budget); listeners.delete(check) }
      listeners.add(check)
      check()
    })

  return {
    texts,
    binaries,
    order,
    send: (value) => { socket.send(JSON.stringify(value)) },
    sendRaw: (data, options) => { socket.send(data, { binary: options?.binary ?? false }) },
    waitFor: async (types, budgetMs = 5_000) => {
      await until(() => texts.some((text) => types.includes(text.type ?? '')), budgetMs, `waiting for ${types.join('/')}`)
      const found = texts.find((text) => types.includes(text.type ?? ''))
      expect(found, `no ${types.join('/')} arrived. seen=${order.join('|')} closeCode=${String(closeCode)}`)
        .toBeDefined()
      return found as ServerText
    },
    waitForBinaries: (count, budgetMs = 5_000) =>
      until(() => binaries.length >= count, budgetMs, `waiting for ${String(count)} binary message(s)`),
    waitForClose: async (budgetMs = 5_000) => {
      await until(() => closed, budgetMs, 'waiting for close')
      return closeCode
    },
    close: () => { socket.close() },
    get closeCode() { return closeCode },
  }
}

// ---- THE ONE DIRECT-PROXY FIXTURE --------------------------------------------------------------
//
// Three claims in this file are about a socket whose STATE a real socket cannot be made to have on
// cue: `bufferedAmount` above the drop threshold (cell 18), a `readyState` that flips BETWEEN two
// statements of one callback (cell 24), and what had been WRITTEN at the instant the proxy
// subscribed (cell 27 — a real socket's receipt is asynchronous, so it cannot order the two). All
// three need a scripted socket, and all go through this ONE construction — so the census cell
// below still finds a single direct-proxy call site and another cell cannot quietly opt out of
// the shipped frame by writing its own.

interface DirectProxyViewer {
  /** Everything written to the socket, in order. Text and binary alike. */
  readonly sent: unknown[]
  /** The text messages among `sent`, parsed, in order. */
  readonly texts: ServerText[]
  /** Speak the hello, as the message handler the proxy registered would receive it. */
  greet(token: string): void
  /** Speak any later client message (`ack`, `renew`) the same way. */
  send(value: unknown): void
  setBuffered(bytes: number): void
  /** Kill the socket the way a real one dies: `readyState` 3, and `send` throws. */
  die(): void
  /** Called after every successful write, so a cell can die mid-frame. */
  onSent?: (data: unknown) => void
  /** The proxy's close call, if it made one. */
  readonly closed: { code: number | undefined; reason: string | undefined } | undefined
  /** Every registry lookup the proxy made, as `run:<id>` or `editor:<id>`, in order. */
  readonly lookups: string[]
}

/**
 * The subjects behind the direct proxy: one planted run session answering every run lookup, or
 * run sessions by id beside an editor-subject registry. The editor cells use this
 * fixture because the server wiring that hands the proxy its editor lookup lands in Plan 11.
 */
type DirectProxySubjects =
  | PlantedSession
  | { readonly runs?: Record<string, RunSession>; readonly editors?: LiveEditorSubjects }

function directProxyViewer(subjects: DirectProxySubjects, runId: string): DirectProxyViewer {
  const sent: unknown[] = []
  const lookups: string[] = []
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>()
  let buffered = 0
  let readyState = 1
  let closed: DirectProxyViewer['closed']
  const speak = (value: unknown): void => {
    for (const handler of handlers.get('message') ?? []) handler(JSON.stringify(value), false)
  }
  const api: DirectProxyViewer = {
    sent,
    get texts() {
      return sent
        .filter((data): data is string => typeof data === 'string')
        .map((data) => JSON.parse(data) as ServerText)
    },
    greet: (token) => { speak({ type: 'hello', token }) },
    send: speak,
    setBuffered: (bytes) => { buffered = bytes },
    die: () => { readyState = 3 },
    get closed() { return closed },
    lookups,
  }
  const fakeSocket = {
    OPEN: 1,
    get readyState() { return readyState },
    get bufferedAmount() { return buffered },
    send: (data: unknown) => {
      // A REAL `ws` THROWS on a closed socket. Reproducing that is the whole of cell (24).
      if (readyState !== 1) throw new Error(`WebSocket is not open: readyState ${String(readyState)}`)
      sent.push(data)
      api.onSent?.(data)
    },
    close: (code?: number, reason?: string) => {
      closed ??= { code, reason }
      if (readyState === 1) readyState = 2
    },
    ping: () => {},
    on(event: string, handler: (...args: unknown[]) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
      return this
    },
    once(event: string, handler: (...args: unknown[]) => void) { return this.on(event, handler) },
  }
  const planted = 'session' in subjects ? subjects : undefined
  const runs = 'session' in subjects ? undefined : subjects.runs
  const editors = 'session' in subjects ? undefined : subjects.editors
  const proxy = createFrameProxy({
    validate: (token, expectation) => validateLiveUrlToken(signer, token, expectation),
    attach: (id) => {
      lookups.push(`run:${id}`)
      return planted !== undefined ? planted.session : runs?.[id]
    },
    ...(editors === undefined
      ? {}
      : {
        attachEditor: (id: string) => {
          lookups.push(`editor:${id}`)
          return editors.attach(id)
        },
      }),
  })
  proxy(fakeSocket as unknown as WebSocket, runId)
  return api
}

// ---- Real hubs behind a subject ----------------------------------------------------------------

/** A real `createLiveStreamHub` with one scripted producer on handle 0, emitting frames of `width`. */
function hubSource(width: number): {
  readonly hub: ReturnType<typeof createLiveStreamHub>
  started(): boolean
  emit(id: number): void
} {
  const timer: RunTimerPort = { schedule: () => () => undefined, now: () => Date.now() }
  const hub = createLiveStreamHub({ timer })
  let sink: ((frame: LiveFrame) => void) | undefined
  hub.register(0, {
    kind: 'cdp-screencast',
    start: async (onFrame) => { sink = onFrame },
    ack: async () => {},
    stop: async () => { sink = undefined },
  })
  return {
    hub,
    started: () => sink !== undefined,
    emit: (id) => {
      sink?.({ id, bytes: new Uint8Array([0xff, 0xd8, id]), metadata: { width, height: 360 } })
    },
  }
}

/** A run whose frames come from a real hub. */
function hubRun(runId: string, width: number): {
  readonly source: ReturnType<typeof hubSource>
  readonly session: RunSession
} {
  const source = hubSource(width)
  const session = {
    ...plantSession({ runId }).session,
    subscribeFrames: (
      handle: number,
      onFrame: (frame: LiveFrame) => void,
      onEnd?: (reason: LiveFrameEndReason) => void,
    ) => source.hub.subscribe(handle, onFrame, onEnd),
    streamCapabilityOf: (handle: number) => source.hub.capabilityOf(handle),
  } as RunSession
  return { source, session }
}

/** An editor subject registered through `createLiveEditorSubjects`, its frames from a real hub. */
function plantEditor(subjects: LiveEditorSubjects, sessionId: string, width: number): {
  readonly source: ReturnType<typeof hubSource>
  /** The session is over: its hub closes, then `ended` settles. */
  end(): Promise<void>
} {
  const source = hubSource(width)
  let settle: () => void = () => {}
  const ended = new Promise<void>((resolve) => { settle = resolve })
  subjects.register(sessionId, {
    streamCapabilityOf: (handle) => source.hub.capabilityOf(handle),
    subscribeFrames: (handle, onFrame, onEnd) => source.hub.subscribe(handle, onFrame, onEnd),
    ended,
  })
  return {
    source,
    end: async () => {
      await source.hub.close()
      settle()
    },
  }
}

const jpeg = (id: number): LiveFrame => ({
  id,
  bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, id, 0x00, 0xff, 0xd9]),
  metadata: { width: 640, height: 360 },
})

// ---- The cells ---------------------------------------------------------------------------------

describe('the frame proxy through the production startServer frame', () => {
  it('(1) hello → ready → frame header + binary JPEG → ack reaches the run session', async () => {
    const planted = plantSession({ runId: 'r1' })
    const frame = await productionFrame({ r1: planted.session })
    const viewer = await openViewer(frame, '?runId=r1')
    viewer.send({ type: 'hello', token: tokenFor({ runId: 'r1', handle: 3 }) })

    const ready = await viewer.waitFor(['ready'])
    expect(ready.type).toBe('ready')
    expect(ready.runId).toBe('r1')
    expect(ready.handle, 'the handle comes from the CLAIMS, not from the query').toBe(3)
    expect(ready.stream?.kind).toBe('cdp-screencast')
    expect(typeof ready.expiresAt).toBe('number')

    planted.emit(jpeg(11))
    await viewer.waitForBinaries(1)
    const header = viewer.texts.find((text) => text.type === 'frame')
    expect(header, 'a frame is a TEXT header followed by ONE binary message').toBeDefined()
    expect(header?.id).toBe(11)
    expect(header?.width).toBe(640)
    expect(header?.height).toBe(360)
    // 428: ts and kind are ADDITIVE. A frame that carries neither sends exactly the old header.
    expect(Object.keys(header ?? {}).sort(), 'an unstamped frame keeps the pre-428 header keys')
      .toEqual(['height', 'id', 'type', 'width'])
    expect(header).not.toHaveProperty('ts')
    expect(header).not.toHaveProperty('kind')
    expect([...(viewer.binaries[0] as Buffer)], 'the viewer receives the producer\'s own bytes')
      .toEqual([...jpeg(11).bytes])
    expect(viewer.order.slice(-2), 'the binary follows its header immediately')
      .toEqual(['text:frame', 'binary'])

    viewer.send({ type: 'ack', id: 11 })
    await vi.waitFor(() => { expect(planted.acked).toEqual([11]) })
  })

  it('(2) refuses a BINARY first message as malformed, before attach, with close 4400', async () => {
    const planted = plantSession({ runId: 'r1' })
    const frame = await productionFrame({ r1: planted.session })
    const viewer = await openViewer(frame, '?runId=r1')
    viewer.sendRaw(Buffer.from([0x01, 0x02, 0x03]), { binary: true })
    const refused = await viewer.waitFor(['refused'])
    expect(refused.reason).toBe('malformed')
    expect(await viewer.waitForClose()).toBe(LIVE_VIEW_REFUSAL_CLOSE_CODE)
    expect(frame.attach, 'a refused handshake must never reach the run registry').not.toHaveBeenCalled()
  })

  it('(3) refuses an OVERSIZED first message as malformed, measured in BYTES', async () => {
    // The cap is a BYTE cap. A JS string's `.length` counts UTF-16 code units, so a hello padded
    // with multi-byte characters is under the character cap and over the byte cap — which is the
    // direction that matters, because the byte count is what the socket actually buffers.
    const planted = plantSession({ runId: 'r1' })
    const frame = await productionFrame({ r1: planted.session })

    const plainViewer = await openViewer(frame, '?runId=r1')
    plainViewer.sendRaw(JSON.stringify({ type: 'hello', token: 'x'.repeat(5_000) }))
    expect((await plainViewer.waitFor(['refused'])).reason).toBe('malformed')
    expect(await plainViewer.waitForClose()).toBe(LIVE_VIEW_REFUSAL_CLOSE_CODE)

    // Under the CHARACTER cap, over the BYTE cap — AND CARRYING A VALID TOKEN. The valid token is
    // what makes this cell discriminate: a padded hello with a GARBAGE token is refused
    // `malformed` by the validator anyway, so it would be green under either cap and prove
    // nothing. With a real token, a character-length cap lets this message through to `ready`
    // while a byte cap refuses it — which is exactly the difference under test.
    const pad = '€'.repeat(1_400)
    const body = JSON.stringify({ type: 'hello', token: tokenFor({ runId: 'r1' }), pad })
    expect(body.length, 'the fixture must be under the character cap for this cell to discriminate')
      .toBeLessThan(LIVE_VIEW_HELLO_MAX_BYTES)
    expect(Buffer.byteLength(body), 'and over the byte cap').toBeGreaterThan(LIVE_VIEW_HELLO_MAX_BYTES)
    const wideViewer = await openViewer(frame, '?runId=r1')
    wideViewer.sendRaw(body)
    const wideAnswer = await wideViewer.waitFor(['refused', 'ready'])
    expect(
      wideAnswer.type,
      'a hello over the BYTE cap must be refused even though it is under the character cap — the '
      + 'byte count is what the socket actually buffers, so a character cap is not the cap',
    ).toBe('refused')
    expect(wideAnswer.reason).toBe('malformed')
    expect(await wideViewer.waitForClose()).toBe(LIVE_VIEW_REFUSAL_CLOSE_CODE)
    expect(frame.attach).not.toHaveBeenCalled()
  })

  it('(4) refuses non-JSON and a non-hello first message as malformed, before attach', async () => {
    const planted = plantSession({ runId: 'r1' })
    const frame = await productionFrame({ r1: planted.session })

    const garbage = await openViewer(frame, '?runId=r1')
    garbage.sendRaw('this is not json')
    expect((await garbage.waitFor(['refused'])).reason).toBe('malformed')
    expect(await garbage.waitForClose()).toBe(LIVE_VIEW_REFUSAL_CLOSE_CODE)

    const outOfOrder = await openViewer(frame, '?runId=r1')
    outOfOrder.send({ type: 'ack', id: 1 })
    expect(
      (await outOfOrder.waitFor(['refused'])).reason,
      'an `ack` before `hello` is a viewer trying to skip the handshake',
    ).toBe('malformed')
    expect(await outOfOrder.waitForClose()).toBe(LIVE_VIEW_REFUSAL_CLOSE_CODE)

    const notAnObject = await openViewer(frame, '?runId=r1')
    notAnObject.sendRaw('"a bare string"')
    expect((await notAnObject.waitFor(['refused'])).reason).toBe('malformed')

    expect(frame.attach).not.toHaveBeenCalled()
  })

  it('(5) refuses a TAMPERED signature by name — bad_signature — before attach', async () => {
    const planted = plantSession({ runId: 'r1' })
    const frame = await productionFrame({ r1: planted.session })
    const token = tokenFor({ runId: 'r1' })
    const tampered = `${token.slice(0, -4)}${token.endsWith('AAAA') ? 'BBBB' : 'AAAA'}`
    const viewer = await openViewer(frame, '?runId=r1')
    viewer.send({ type: 'hello', token: tampered })
    expect((await viewer.waitFor(['refused'])).reason).toBe('bad_signature')
    expect(await viewer.waitForClose()).toBe(LIVE_VIEW_REFUSAL_CLOSE_CODE)
    expect(frame.attach, 'a forged token must never reach the run registry').not.toHaveBeenCalled()
  })

  it('(6) refuses an EXPIRED token by name — expired — before attach', async () => {
    const planted = plantSession({ runId: 'r1' })
    const frame = await productionFrame({ r1: planted.session })
    const viewer = await openViewer(frame, '?runId=r1')
    viewer.send({ type: 'hello', token: tokenFor({ runId: 'r1', exp: Date.now() - 1_000 }) })
    expect((await viewer.waitFor(['refused'])).reason).toBe('expired')
    expect(await viewer.waitForClose()).toBe(LIVE_VIEW_REFUSAL_CLOSE_CODE)
    expect(frame.attach).not.toHaveBeenCalled()
  })

  it('(7) refuses a token minted for ANOTHER run — scope_mismatch — before attach', async () => {
    const one = plantSession({ runId: 'r1' })
    const two = plantSession({ runId: 'r2' })
    const frame = await productionFrame({ r1: one.session, r2: two.session })
    const viewer = await openViewer(frame, '?runId=r1')
    viewer.send({ type: 'hello', token: tokenFor({ runId: 'r2' }) })
    expect(
      (await viewer.waitFor(['refused'])).reason,
      'a valid token for r2 presented on r1\'s socket is the cross-run read this refusal exists for',
    ).toBe('scope_mismatch')
    expect(await viewer.waitForClose()).toBe(LIVE_VIEW_REFUSAL_CLOSE_CODE)
    expect(frame.attach).not.toHaveBeenCalled()
  })

  it('(8) refuses a token whose scope is not `view` — scope_mismatch — before attach', async () => {
    const planted = plantSession({ runId: 'r1' })
    const frame = await productionFrame({ r1: planted.session })
    const viewer = await openViewer(frame, '?runId=r1')
    viewer.send({ type: 'hello', token: tokenFor({ runId: 'r1', scope: 'control' as LiveUrlClaims['scope'] }) })
    expect((await viewer.waitFor(['refused'])).reason).toBe('scope_mismatch')
    expect(frame.attach).not.toHaveBeenCalled()
  })

  it('(9) refuses a VALID token for a run this process never started — unknown_run', async () => {
    // The one refusal where `attach` IS called: attach is the lookup, and its `undefined` is the
    // answer. Refusing before it would mean refusing without asking.
    const frame = await productionFrame({})
    const viewer = await openViewer(frame, '?runId=r_gone')
    viewer.send({ type: 'hello', token: tokenFor({ runId: 'r_gone' }) })
    expect((await viewer.waitFor(['refused'])).reason).toBe('unknown_run')
    expect(await viewer.waitForClose()).toBe(LIVE_VIEW_REFUSAL_CLOSE_CODE)
    expect(frame.attach, 'attach is the lookup this refusal reports').toHaveBeenCalledWith('r_gone')
  })

  it('(10) an upgrade with NO runId is destroyed — no socket, no ready, no refusal', async () => {
    const planted = plantSession({ runId: 'r1' })
    const frame = await productionFrame({ r1: planted.session })
    const socket = new WebSocket(`${frame.wsOrigin}${LIVE_VIEW_WS_PATH}`)
    openSockets.push(socket)
    const outcome = await new Promise<string>((resolve) => {
      socket.once('open', () => { resolve('open') })
      socket.once('error', () => { resolve('error') })
      socket.once('close', () => { resolve('close') })
    })
    expect(outcome, 'a socket that never names a run is refused at the upgrade, before the proxy exists')
      .not.toBe('open')
    expect(frame.attach).not.toHaveBeenCalled()
  })

  it('(11) `stream: { kind: none }` is READY with no frames — an honest absence, not an error', async () => {
    const planted = plantSession({ runId: 'r1', stream: { kind: 'none' } })
    const frame = await productionFrame({ r1: planted.session })
    const viewer = await openViewer(frame, '?runId=r1')
    viewer.send({ type: 'hello', token: tokenFor({ runId: 'r1' }) })
    const ready = await viewer.waitFor(['ready'])
    expect(ready.stream?.kind).toBe('none')
    expect(
      planted.subscribeCalls,
      'no painter, and no frame subscription either — a handle with no stream is not subscribed to',
    ).toBe(0)
    planted.emit(jpeg(1))
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(viewer.binaries, 'a none-stream socket carries no pixels').toEqual([])
    expect(viewer.closeCode, 'and it stays OPEN so the page can still receive `ended`').toBeUndefined()
  })

  it('(12) `session.done` resolving sends `ended { runFinished }` and closes 1000', async () => {
    const planted = plantSession({ runId: 'r1' })
    const frame = await productionFrame({ r1: planted.session })
    const viewer = await openViewer(frame, '?runId=r1')
    viewer.send({ type: 'hello', token: tokenFor({ runId: 'r1' }) })
    await viewer.waitFor(['ready'])
    planted.finish()
    const ended = await viewer.waitFor(['ended'])
    expect(ended.reason).toBe('runFinished')
    expect(await viewer.waitForClose()).toBe(1000)
  })

  it('(23) a member FINISHING sends `ended { handleFinished }` on the still-open socket', async () => {
    // CR-03. A multi-member run settles one member at a time, and `shell.ts` withdraws that
    // handle's declaration the instant its race settles. Before this cell the hub dropped the
    // handle's subscriber set without a word, so this viewer sat on `data-embed-state="live"` over
    // a frozen last frame until the WHOLE run ended — a stale picture claiming to be live, which is
    // the one thing the embed page's own law ("every absence is named") forbids.
    //
    // EVERY ABSENCE HERE IS PRECEDED BY A PRESENCE. `ready` with a real declared kind, one
    // subscription, and one painted JPEG are asserted BEFORE the end is triggered — otherwise
    // "the viewer was told the stream ended" and "the viewer was never streaming" read identically.
    const planted = plantSession({ runId: 'r1' })
    const frame = await productionFrame({ r1: planted.session })
    const viewer = await openViewer(frame, '?runId=r1')
    viewer.send({ type: 'hello', token: tokenFor({ runId: 'r1', handle: 2 }) })

    const ready = await viewer.waitFor(['ready'])
    expect(ready.stream?.kind, 'the witness: this viewer really is watching a declared stream')
      .toBe('cdp-screencast')
    expect(planted.subscribeCalls, 'and it really did subscribe to the frames').toBe(1)

    planted.emit(jpeg(7))
    await viewer.waitForBinaries(1)
    expect(viewer.binaries.length, 'the witness: pixels really flowed before the end was declared')
      .toBe(1)

    // THE MEMBER FINISHES. The run does NOT — `session.done` is still pending below.
    planted.endStream()

    const first = await viewer.waitFor(['ended'])
    expect(first.reason, 'a finished member is named, not left frozen and labelled live')
      .toBe('handleFinished')
    expect(
      viewer.closeCode,
      'and the socket STAYS OPEN — `runFinished` is a different fact and is still coming',
    ).toBeUndefined()

    // NOW the run ends. Both facts arrive, in order, on the one socket.
    planted.finish()
    expect(await viewer.waitForClose()).toBe(1000)
    expect(
      viewer.texts.filter((text) => text.type === 'ended').map((text) => text.reason),
      'two ends, each by its own name, in the order they happened',
    ).toEqual(['handleFinished', 'runFinished'])
    expect(viewer.order.join('|')).toBe('text:ready|text:frame|binary|text:ended|text:ended')
    expect(planted.cancels, 'and nothing about this touched the run (D-16)').toBe(0)
  })

  it('(27) READY-AFTER-SUBSCRIBE: the subscription exists before the viewer is told ready', () => {
    // DIRECT PROXY, and for the reason the fixture's header gives: the claim is about what had been
    // written to the socket at the instant `subscribeFrames` ran. A real socket receives
    // asynchronously, so a production-frame viewer would see `ready` after the subscription under
    // either order and the cell could not tell them apart.
    const writtenAtSubscribe: number[] = []
    let viewer: DirectProxyViewer | undefined
    const planted = plantSession({
      runId: 'r27',
      onSubscribe: () => { writtenAtSubscribe.push(viewer?.sent.length ?? -1) },
    })
    viewer = directProxyViewer(planted, 'r27')
    viewer.greet(tokenFor({ runId: 'r27' }))

    expect(planted.subscribeCalls, 'the witness: the proxy did subscribe').toBe(1)
    expect(
      writtenAtSubscribe,
      'nothing may reach the viewer before the subscription exists — a `ready` sent first promises '
      + 'frames from a subscription that may never be made',
    ).toEqual([0])
    const first = JSON.parse(String(viewer.sent[0])) as ServerText
    expect(first.type, 'and the first thing the viewer is sent is ready').toBe('ready')
  })

  it('(28) UNKNOWN-HANDLE-EMITTED: a declared stream whose subscription comes back empty is refused by name', async () => {
    // #274 (a+b). The handle settled between `streamCapabilityOf` and `subscribeFrames`: the first
    // read declared a stream, the second found nothing. Before 428 the viewer got `ready` and then
    // waited forever for a first frame; the declared reason was never sent.
    const planted = plantSession({ runId: 'r28', subscribeAnswers: 'nothing' })
    const frame = await productionFrame({ r28: planted.session })
    const viewer = await openViewer(frame, '?runId=r28')
    viewer.send({ type: 'hello', token: tokenFor({ runId: 'r28', handle: 4 }) })

    const answer = await viewer.waitFor(['refused', 'ready'])
    expect(planted.subscribeCalls, 'the witness: the stream was declared and a subscription tried')
      .toBe(1)
    expect(answer.type, 'an unresolvable handle is refused, never greeted').toBe('refused')
    expect(answer.reason).toBe('unknown_handle')
    expect(await viewer.waitForClose()).toBe(LIVE_VIEW_REFUSAL_CLOSE_CODE)
    expect(viewer.texts.some((text) => text.type === 'ready'), 'and ready is never sent').toBe(false)
  })

  it('(29) CLOSED-IS-NOT-HANDLE-FINISHED: a closed hub is not a finished member', async () => {
    const capabilityFor = (): { capability: LiveStreamCapability; started: () => boolean } => {
      let running = false
      return {
        capability: {
          kind: 'cdp-screencast',
          start: async () => { running = true },
          ack: async () => {},
          stop: async () => { running = false },
        },
        started: () => running,
      }
    }
    const hubSession = (runId: string): {
      hub: ReturnType<typeof createLiveStreamHub>
      planted: PlantedSession
      session: RunSession
    } => {
      const timer: RunTimerPort = { schedule: () => () => undefined, now: () => Date.now() }
      const hub = createLiveStreamHub({ timer })
      const planted = plantSession({ runId })
      const session = {
        ...planted.session,
        subscribeFrames: (
          handle: number,
          onFrame: (frame: LiveFrame) => void,
          onEnd?: (reason: LiveFrameEndReason) => void,
        ) => hub.subscribe(handle, onFrame, onEnd),
        streamCapabilityOf: (handle: number) => hub.capabilityOf(handle),
      } as RunSession
      return { hub, planted, session }
    }

    // WITHDRAWN: the member finished while its run continues. Cell (23)'s fact, through a real hub.
    const withdrawn = hubSession('r29w')
    const withdrawnProducer = capabilityFor()
    withdrawn.hub.register(0, withdrawnProducer.capability)
    // CLOSED: the whole hub went down. The run's own end is the message that follows.
    const closed = hubSession('r29c')
    const closedProducer = capabilityFor()
    closed.hub.register(0, closedProducer.capability)
    const frame = await productionFrame({ r29w: withdrawn.session, r29c: closed.session })

    const first = await openViewer(frame, '?runId=r29w')
    first.send({ type: 'hello', token: tokenFor({ runId: 'r29w' }) })
    expect((await first.waitFor(['ready'])).stream?.kind).toBe('cdp-screencast')
    await vi.waitFor(() => { expect(withdrawnProducer.started(), 'the witness: streaming').toBe(true) })
    withdrawn.hub.register(0, undefined)
    expect((await first.waitFor(['ended'])).reason, 'a withdrawal is a finished member')
      .toBe('handleFinished')
    expect(first.closeCode, 'and the run is still going').toBeUndefined()

    const second = await openViewer(frame, '?runId=r29c')
    second.send({ type: 'hello', token: tokenFor({ runId: 'r29c' }) })
    expect((await second.waitFor(['ready'])).stream?.kind).toBe('cdp-screencast')
    await vi.waitFor(() => { expect(closedProducer.started(), 'the witness: streaming').toBe(true) })
    await closed.hub.close()
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(
      second.texts.filter((text) => text.type === 'ended').map((text) => text.reason),
      'a closed hub says nothing by itself — it is the subject ending, not a member finishing',
    ).toEqual([])
    expect(second.closeCode).toBeUndefined()

    closed.planted.finish()
    expect(await second.waitForClose()).toBe(1000)
    expect(
      second.texts.filter((text) => text.type === 'ended').map((text) => text.reason),
      'the subject\'s own end is the one end this viewer hears',
    ).toEqual(['runFinished'])
  })

  it('(13) THE EXPIRY DEADLINE: a socket whose token lapses mid-stream is refused BY NAME', async () => {
    const planted = plantSession({ runId: 'r1' })
    const frame = await productionFrame({ r1: planted.session })
    const viewer = await openViewer(frame, '?runId=r1')
    // A REAL short TTL against REAL timers — the deadline is armed off the claims' own `exp`, so a
    // 300 ms token is the honest way to watch it fire without waiting five minutes.
    viewer.send({ type: 'hello', token: tokenFor({ runId: 'r1', exp: Date.now() + 300 }) })
    await viewer.waitFor(['ready'])
    const refused = await viewer.waitFor(['refused'], 3_000)
    expect(
      refused.reason,
      'an expiring socket is REFUSED BY NAME so the page can say "link expired" — never dropped',
    ).toBe('expired')
    expect(await viewer.waitForClose()).toBe(LIVE_VIEW_REFUSAL_CLOSE_CODE)
  })

  it('(14) `renew` with a later token extends the socket PAST the first token\'s exp', async () => {
    const planted = plantSession({ runId: 'r1' })
    const frame = await productionFrame({ r1: planted.session })
    const viewer = await openViewer(frame, '?runId=r1')
    const firstExp = Date.now() + 400
    viewer.send({ type: 'hello', token: tokenFor({ runId: 'r1', exp: firstExp }) })
    await viewer.waitFor(['ready'])

    await new Promise((resolve) => setTimeout(resolve, 150))
    const secondExp = Date.now() + 30_000
    viewer.send({ type: 'renew', token: tokenFor({ runId: 'r1', exp: secondExp }) })
    const renewed = await viewer.waitFor(['renewed'])
    expect(renewed.expiresAt).toBe(secondExp)

    // Past the FIRST token's expiry, and the socket is still carrying frames.
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(Date.now(), 'the cell must actually have crossed the first deadline').toBeGreaterThan(firstExp)
    expect(
      viewer.texts.some((text) => text.type === 'refused'),
      'a renewed socket must not be refused on the deadline the renew replaced — that is the '
      + 'silent-re-mint contract D-02 promises the viewer',
    ).toBe(false)
    planted.emit(jpeg(7))
    await viewer.waitForBinaries(1)
    expect(viewer.closeCode).toBeUndefined()
  })

  it('(15) `renew` with a BAD token is refused by name and closes — a renew is not a lesser check', async () => {
    const planted = plantSession({ runId: 'r1' })
    const frame = await productionFrame({ r1: planted.session })
    const viewer = await openViewer(frame, '?runId=r1')
    viewer.send({ type: 'hello', token: tokenFor({ runId: 'r1' }) })
    await viewer.waitFor(['ready'])
    const token = tokenFor({ runId: 'r1' })
    viewer.send({ type: 'renew', token: `${token.slice(0, -4)}${token.endsWith('AAAA') ? 'BBBB' : 'AAAA'}` })
    expect((await viewer.waitFor(['refused'])).reason).toBe('bad_signature')
    expect(await viewer.waitForClose()).toBe(LIVE_VIEW_REFUSAL_CLOSE_CODE)

    const other = await openViewer(frame, '?runId=r1')
    other.send({ type: 'hello', token: tokenFor({ runId: 'r1' }) })
    await other.waitFor(['ready'])
    other.send({ type: 'renew', token: tokenFor({ runId: 'r1', exp: Date.now() - 1 }) })
    expect((await other.waitFor(['refused'])).reason).toBe('expired')
  })

  it('(16) DETACH: closing a viewer socket unsubscribes and touches NOTHING else on the run', async () => {
    // T-403-07's cell. The RED bar is an implementation that cancels the run when its last viewer
    // leaves — "attach, don't own" is the law INVK-05 pins, and a viewer that can end a run by
    // closing a tab is a viewer that has become the owner.
    const planted = plantSession({ runId: 'r1' })
    const frame = await productionFrame({ r1: planted.session })
    const viewer = await openViewer(frame, '?runId=r1')
    viewer.send({ type: 'hello', token: tokenFor({ runId: 'r1' }) })
    await viewer.waitFor(['ready'])
    expect(planted.subscribeCalls).toBe(1)

    viewer.close()
    await vi.waitFor(() => { expect(planted.unsubscribes).toBe(1) })
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(planted.unsubscribes, 'exactly one release, not one per timer or listener').toBe(1)
    expect(planted.cancels, 'a detach NEVER cancels the run — cancel stays runs.cancel\'s alone').toBe(0)
    // `done` is still pending: nothing about the run was decided by a window closing.
    const settled = await Promise.race([
      planted.session.done.then(() => 'settled'),
      new Promise<string>((resolve) => setTimeout(() => { resolve('still running') }, 150)),
    ])
    expect(settled, 'the run outlives its viewers').toBe('still running')
  })

  it('(17) TWO VIEWERS on one run each get their own subscription and identical frame ids', async () => {
    const planted = plantSession({ runId: 'r1' })
    const frame = await productionFrame({ r1: planted.session })
    const a = await openViewer(frame, '?runId=r1')
    const b = await openViewer(frame, '?runId=r1')
    a.send({ type: 'hello', token: tokenFor({ runId: 'r1' }) })
    b.send({ type: 'hello', token: tokenFor({ runId: 'r1' }) })
    await a.waitFor(['ready'])
    await b.waitFor(['ready'])
    expect(planted.subscribeCalls, 'the proxy does not share one subscription between sockets').toBe(2)

    planted.emit(jpeg(1))
    planted.emit(jpeg(2))
    await a.waitForBinaries(2)
    await b.waitForBinaries(2)
    const idsOf = (viewer: Viewer): number[] =>
      viewer.texts.filter((text) => text.type === 'frame').map((text) => text.id as number)
    expect(idsOf(a)).toEqual([1, 2])
    expect(idsOf(b), 'two viewers of one stream see the same ids in the same order').toEqual(idsOf(a))

    // One viewer leaving does not disturb the other.
    a.close()
    await vi.waitFor(() => { expect(planted.unsubscribes).toBe(1) })
    planted.emit(jpeg(3))
    await b.waitForBinaries(3)
    expect(idsOf(b)).toEqual([1, 2, 3])
  })

  it('(18) SLOW VIEWER: a backed-up socket is skipped for the frame and acked on its behalf', async () => {
    // THE ONE CELL THAT DOES NOT USE `startServer`. The claim is about a socket whose
    // `bufferedAmount` is above the drop threshold, and `bufferedAmount` is a read-only property of
    // a real `ws` socket that no amount of production framing lets a test set. The gauge is what is
    // under test here; every OTHER proxy claim in this file is measured through the shipped frame.
    const planted = plantSession({ runId: 'r1' })
    const viewer = directProxyViewer(planted, 'r1')
    const sent = viewer.sent
    viewer.greet(tokenFor({ runId: 'r1' }))
    expect(sent.length, 'the fake socket received `ready`').toBe(1)

    // Healthy: the frame is sent as a header + bytes and NOT acked on the viewer's behalf.
    planted.emit(jpeg(1))
    expect(sent.length).toBe(3)
    expect(planted.acked, 'a keeping-up viewer acks for itself').toEqual([])

    // Backed up beyond the threshold: the pixels are dropped and the frame is acked anyway, so the
    // CDP producer keeps flowing for everybody else.
    viewer.setBuffered(LIVE_VIEW_SLOW_VIEWER_BYTES + 1)
    planted.emit(jpeg(2))
    expect(sent.length, 'nothing is written to a socket that is already too far behind').toBe(3)
    expect(
      planted.acked,
      'and the frame is acked on its behalf — CDP will not produce frame N+1 until N is acked, so '
      + 'one slow viewer must cost itself frames rather than cost the producer its stream',
    ).toEqual([2])

    // A SECOND viewer on the same session still receives the frame the slow one dropped.
    const healthy: LiveFrame[] = []
    planted.session.subscribeFrames(0, (received) => { healthy.push(received) })
    planted.emit(jpeg(3))
    expect(healthy.map((received) => received.id)).toEqual([3])
  })

  it('(24) A SOCKET THAT DIES BETWEEN THE HEADER AND THE BYTES costs itself the frame, not the run', async () => {
    // THE SECOND CELL THAT DOES NOT USE `startServer`, and for the same reason as (18): the claim
    // is about a socket whose `readyState` changes BETWEEN two statements of one callback, and a
    // real socket cannot be made to do that on cue. What is under test is the guard.
    //
    // WHY IT MATTERS. `ws.send` throws on a closed socket, and that throw travels up into the hub's
    // delivery walk, which detaches the viewer and REPORTS the fault. Before WR-06 that report was
    // wired to the run's durable event log, so a person closing a tab in the wrong millisecond wrote
    // a row into the run's permanent transcript. The routing fix is measured in the runner's
    // bus-silence cell; this cell measures the other half — that the proxy stops producing the
    // throw at all, and acks so the producer is not left waiting on a viewer that is gone.
    const planted = plantSession({ runId: 'r1' })
    const viewer = directProxyViewer(planted, 'r1')
    viewer.greet(tokenFor({ runId: 'r1' }))
    // THE WITNESS: the viewer really was greeted and really was subscribed, so what follows is a
    // delivery that happened rather than a delivery that never started.
    expect(viewer.sent.length, 'the fake socket received `ready`').toBe(1)
    expect(planted.subscribeCalls, 'and it is genuinely subscribed to the frames').toBe(1)

    // THE INTERLEAVING. The socket dies the instant the TEXT header goes out — between the two
    // statements the bare binary send sat across.
    viewer.onSent = (data) => { if (typeof data === 'string') viewer.die() }

    // The hub's `deliver` is what calls this; a throw here is what detaches the viewer and gets
    // reported. `plantSession.emit` stands in for that walk, so an escaping throw fails the cell.
    expect(() => { planted.emit(jpeg(9)) }, 'a dead socket must not throw back into the frame walk')
      .not.toThrow()
    expect(viewer.sent.length, 'the header went out before the socket died — the delivery was real').toBe(2)
    expect(
      planted.acked,
      'and the lost frame is acked on the dead viewer behalf: CDP will not produce frame N+1 until '
      + 'N is acked, so a viewer that vanished must not stall the stream for everyone else',
    ).toEqual([9])
  })

  it('(26) TRACER-FRAME-TS: capture time and producer kind reach the header through a real hub', async () => {
    // The one path PXH-LIVE-03's dot reads: producer -> real hub -> RunSession seam -> production
    // proxy -> the viewer's frame header. The proxy never stamps a time of its own; the hub stamps
    // timer.now() only when the producer supplied none.
    const CAPTURE_NOW = 1_700_000_000_000
    const timer: RunTimerPort = { schedule: () => () => undefined, now: () => CAPTURE_NOW }
    const hub = createLiveStreamHub({ timer })
    let sink: ((frame: LiveFrame) => void) | undefined
    const capability: LiveStreamCapability = {
      kind: 'cdp-screencast',
      start: async (onFrame) => { sink = onFrame },
      ack: async () => {},
      stop: async () => { sink = undefined },
    }
    hub.register(0, capability)
    const session = {
      ...plantSession({ runId: 'r26' }).session,
      subscribeFrames: (
        handle: number,
        onFrame: (frame: LiveFrame) => void,
        onEnd?: () => void,
      ) => hub.subscribe(handle, onFrame, onEnd),
      streamCapabilityOf: (handle: number) => hub.capabilityOf(handle),
    } as RunSession
    const frame = await productionFrame({ r26: session })
    const viewer = await openViewer(frame, '?runId=r26')
    viewer.send({ type: 'hello', token: tokenFor({ runId: 'r26', handle: 0 }) })

    const ready = await viewer.waitFor(['ready'])
    expect(ready.stream?.kind, 'the declaration comes from the real hub').toBe('cdp-screencast')
    await vi.waitFor(() => { expect(sink, 'the hub started the producer for this viewer').toBeDefined() })

    sink?.({ id: 1, bytes: new Uint8Array([0xff, 0xd8, 0x01]), metadata: { width: 640, height: 360 } })
    await viewer.waitForBinaries(1)
    const unstamped = viewer.texts.filter((text) => text.type === 'frame')[0]
    expect(unstamped?.id).toBe(1)
    expect(unstamped?.ts, 'a frame captured without a time reads the hub clock, in epoch ms')
      .toBe(CAPTURE_NOW)
    expect(unstamped?.kind, 'and names the capability that produced it').toBe('cdp-screencast')
    expect(viewer.order.slice(-2)).toEqual(['text:frame', 'binary'])
    viewer.send({ type: 'ack', id: 1 })

    sink?.({
      id: 2,
      bytes: new Uint8Array([0xff, 0xd8, 0x02]),
      metadata: { width: 640, height: 360, timestamp: 1_699_999_999_000 },
    })
    await viewer.waitForBinaries(2)
    const stamped = viewer.texts.filter((text) => text.type === 'frame')[1]
    expect(stamped?.id).toBe(2)
    expect(stamped?.ts, 'a producer-supplied capture time is never overwritten').toBe(1_699_999_999_000)
    expect(stamped?.kind).toBe('cdp-screencast')
    await hub.close()
  })

  it('(19) the embed page: 200, the four headers, the nonce equality, and a fresh nonce per response', async () => {
    const planted = plantSession({ runId: 'r1' })
    const frame = await productionFrame({ r1: planted.session })
    const response = await fetch(`${frame.origin}/live/r1`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('referrer-policy'), 'a fragment token must not ride a Referer out')
      .toBe('no-referrer')
    const csp = response.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("default-src 'none'")
    expect(response.headers.get('x-frame-options'), 'this page EXISTS to be embedded').toBeNull()

    const body = await response.text()
    expect(body).toContain('data-embed-state="connecting"')
    expect(body, 'the canvas must not swallow the host page\'s clicks').toContain('pointer-events')

    const scriptNonce = /<script nonce="([^"]+)">/u.exec(body)?.[1]
    const cspNonce = /script-src 'nonce-([^']+)'/u.exec(csp)?.[1]
    expect(scriptNonce, 'the page serves exactly one nonce\'d inline script').toBeDefined()
    expect(
      scriptNonce,
      'a script whose nonce differs from the CSP\'s is a script the browser refuses to run — the '
      + 'embed would be blank in every host, and no server-side cell would notice',
    ).toBe(cspNonce)

    const second = await fetch(`${frame.origin}/live/r1`)
    const secondBody = await second.text()
    const secondNonce = /<script nonce="([^"]+)">/u.exec(secondBody)?.[1]
    expect(secondNonce, 'a nonce reused across responses is not a nonce').not.toBe(scriptNonce)
  })

  it('(20) the served page carries the EXACT expired copy, in the branch that renders it', async () => {
    const planted = plantSession({ runId: 'r1' })
    const frame = await productionFrame({ r1: planted.session })
    const body = await (await fetch(`${frame.origin}/live/r1`)).text()
    const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/u.exec(body)?.[1] ?? ''
    expect(script.length, 'the served document must contain the embed script').toBeGreaterThan(200)

    // THE LITERAL IS COMPARED TO THE SERVED BYTES, not to another copy of itself: the constant this
    // package exports and the string the page renders are the same string, or a viewer sees copy
    // nobody asserted. The ws-level `expired` refusal (cell 13) is the answer this branch renders;
    // the browser-rendered assertion of the text is 403-01's tracer cell (iii-b).
    expect(script, 'the served script must carry the exported expired message verbatim')
      .toContain(JSON.stringify(LIVE_EMBED_EXPIRED_MESSAGE))
    expect(script).toContain('data-embed-message')

    // And it is the `expired` REASON that assigns it — not some other state that happens to share
    // the words. Both tokens live in the same statement.
    const expiredBranch = /'expired'[^\n]*\n?[^\n]*/gu
    const branches = script.match(expiredBranch) ?? []
    expect(
      branches.some((line) => line.includes(JSON.stringify(LIVE_EMBED_EXPIRED_MESSAGE))),
      `no branch keyed on the 'expired' reason assigns ${JSON.stringify(LIVE_EMBED_EXPIRED_MESSAGE)}`,
    ).toBe(true)
    expect(LIVE_EMBED_STATES, 'and `expired` is a declared state of the page').toContain('expired')
  })

  it('(25) the served page carries the EXACT no-stream copy, in the branch keyed on kind none', async () => {
    const planted = plantSession({ runId: 'r1' })
    const frame = await productionFrame({ r1: planted.session })
    const body = await (await fetch(`${frame.origin}/live/r1`)).text()
    const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/u.exec(body)?.[1] ?? ''
    expect(script.length, 'the served document must contain the embed script').toBeGreaterThan(200)

    // THE SAME SHAPE AS (20): the constant and the served bytes are one string, or the pane and
    // the embed drift apart again the way G-403-1 found them.
    expect(script, 'the served script must carry the exported no-stream message verbatim')
      .toContain(JSON.stringify(LIVE_EMBED_NO_STREAM_MESSAGE))

    const noneBranch = /kind === 'none'[^\n]*\n?[^\n]*/gu
    const branches = script.match(noneBranch) ?? []
    expect(
      branches.some((line) => line.includes(JSON.stringify(LIVE_EMBED_NO_STREAM_MESSAGE))),
      `no branch keyed on kind === 'none' assigns ${JSON.stringify(LIVE_EMBED_NO_STREAM_MESSAGE)}`,
    ).toBe(true)
    expect(LIVE_EMBED_STATES, 'and `no-stream` is a declared state of the page').toContain('no-stream')
    // This document owns no step list and cannot see its host's, so it names no position for one.
    expect(LIVE_EMBED_NO_STREAM_MESSAGE).not.toMatch(/\b(?:below|beneath|above|left|right)\b/u)
  })

  // the one deliberate change to the served page. Each cell reads the SERVED bytes, as
  // (20) and (25) do, so the constant and the document cannot drift apart.
  async function servedEmbed(): Promise<{ style: string; script: string }> {
    const planted = plantSession({ runId: 'r1' })
    const frame = await productionFrame({ r1: planted.session })
    const body = await (await fetch(`${frame.origin}/live/r1`)).text()
    const style = /<style nonce="[^"]+">([\s\S]*?)<\/style>/u.exec(body)?.[1] ?? ''
    const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/u.exec(body)?.[1] ?? ''
    expect(script.length, 'the served document must contain the embed script').toBeGreaterThan(200)
    return { style, script }
  }

  it('(34) SERVED-SESSION-ENDED-COPY: the EXACT session-ended copy, in the branch keyed on sessionEnded', async () => {
    expect(LIVE_EMBED_SESSION_ENDED_MESSAGE, 'the copy is one exported constant').toBe('session ended')
    const { script } = await servedEmbed()
    expect(script, 'the served script must carry the exported session-ended message verbatim')
      .toContain(JSON.stringify(LIVE_EMBED_SESSION_ENDED_MESSAGE))

    const sessionBranch = /'sessionEnded'[^\n]*\n?[^\n]*/gu
    const branches = script.match(sessionBranch) ?? []
    expect(
      branches.some((line) => line.includes(JSON.stringify(LIVE_EMBED_SESSION_ENDED_MESSAGE))
        && line.includes("'session-ended'")),
      `no branch keyed on 'sessionEnded' sets the session-ended state with ${JSON.stringify(LIVE_EMBED_SESSION_ENDED_MESSAGE)}`,
    ).toBe(true)
    expect(LIVE_EMBED_STATES, 'and `session-ended` is a declared state of the page').toContain('session-ended')
  })

  it('(35) SERVED-SNAPSHOT-PAINTER-BRANCH: both declared kinds paint, and the Blob names no MIME type', async () => {
    const { script } = await servedEmbed()
    const readyAt = script.indexOf("msg.type === 'ready'")
    expect(readyAt, 'the served script has a ready branch').toBeGreaterThan(-1)
    const noStreamAt = script.indexOf("setState('no-stream'", readyAt)
    expect(noStreamAt, 'the ready branch has its no-stream arm').toBeGreaterThan(readyAt)
    const paintingArm = script.slice(readyAt, noStreamAt)
    expect(paintingArm, 'the screencast paints').toContain("'cdp-screencast'")
    expect(paintingArm, 'the snapshot kind paints on the same canvas, before the no-stream arm')
      .toContain("'snapshot'")

    const blobCalls = [...script.matchAll(/new Blob\(([^)]*)\)/gu)].map((match) => match[1] ?? '')
    expect(blobCalls.length, 'the witness: the painter builds a Blob').toBeGreaterThan(0)
    for (const call of blobCalls) {
      expect(
        call,
        'a typed Blob tells a non-Chromium host the bytes are that type; with no type the decoder '
          + 'sniffs, so PNG snapshot bytes paint too (RESEARCH A2)',
      ).not.toContain('type')
    }
  })

  it('(36) SERVED-HOST-HINT-RULE: the host hint hides the centred text, read from the query named by LIVE_EMBED_HOST_PARAM', async () => {
    expect(LIVE_EMBED_HOST_PARAM, 'the hint is one exported query name').toBe('host')
    const { style, script } = await servedEmbed()
    expect(style, 'a hinted host speaks for the page, so the page does not say it twice')
      .toContain('main[data-embed-host] p { display: none; }')
    expect(script, 'the hint is read from the query, never the fragment that carries the token')
      .toContain(`new URLSearchParams(location.search).get(${JSON.stringify(LIVE_EMBED_HOST_PARAM)})`)
    expect(script, 'the hint lands through setAttribute, never through markup')
      .toContain("root.setAttribute('data-embed-host'")
  })

  it('(37) SERVED-REPORT-HAS-NO-TOKEN: every report to the host is closed-set words and numbers', async () => {
    const { script } = await servedEmbed()
    const definition = /function report\(payload\) \{[\s\S]*?\n {2}\}/u.exec(script)?.[0] ?? ''
    expect(definition, 'the served script defines one report function').not.toBe('')
    expect(definition, 'which returns when there is no host').toContain('window.parent === window')
    expect(definition, 'and posts the payload to its parent').toContain("window.parent.postMessage(payload, '*')")
    expect(definition).not.toMatch(/token|runId|location/u)

    const callCount = (script.match(/\breport\(/gu) ?? []).length - 1
    const literals = [...script.matchAll(/\breport\(\{([^}]*)\}\)/gu)].map((match) => match[1] ?? '')
    expect(literals.length, 'every report call passes an object literal').toBe(callCount)
    expect(literals.length, 'the witness: the scan found the report calls').toBeGreaterThanOrEqual(5)

    const allowed = new Set(['event', 'kind', 'ts', 'width', 'height', 'reason'])
    const events = new Set<string>()
    for (const literal of literals) {
      expect(literal, 'a report never mentions the token, the run id or the location')
        .not.toMatch(/token|runId|location/u)
      for (const part of literal.split(',')) {
        const key = part.split(':')[0]?.trim() ?? ''
        expect(allowed.has(key), `report key ${key} is outside the closed set`).toBe(true)
      }
      const event = /event: '([a-z]+)'/u.exec(literal)?.[1]
      if (event !== undefined) events.add(event)
    }
    expect([...events].sort(), 'each report event is reported, and nothing else')
      .toEqual([...LIVE_EMBED_REPORT_EVENTS].sort())
  })

  it('(22) THE FRAME IS THE SHIPPED ONE — asserted on this file\'s own source', async () => {
    /* self-scan:begin */
    // The plan asked for at least six `startServer(` call sites. This file has ONE, inside
    // `productionFrame`, because twenty copies of the same seven-line construction is worse code
    // and no stronger a claim. What the criterion is actually about — "these cells drive the
    // shipped frame, not a router somebody mounted here" — is therefore asserted directly, on the
    // `run-service-anchors.test.ts` idiom: the one construction site is pinned, its users are
    // counted, and the two ways a later edit could quietly swap in a lookalike are refused.
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const here = fileURLToPath(import.meta.url)
    const whole = readFileSync(here, 'utf8')

    // THE DETECTOR MUST NOT BE ITS OWN SUBJECT. This cell's body names every token it hunts for, so
    // a whole-file scan is satisfied by the scan itself — the failure shape 393 named. The sentinels
    // below fence this cell out, and the fence is asserted to have actually cut something.
    const OPEN = '/* self-scan:begin *' + '/'
    const CLOSE = '/* self-scan:end *' + '/'
    const from = whole.indexOf(OPEN)
    const to = whole.indexOf(CLOSE)
    expect(from, 'the self-scan fence must be present').toBeGreaterThan(-1)
    expect(to, 'the self-scan fence must be closed').toBeGreaterThan(from)
    const source = whole.slice(0, from) + whole.slice(to + CLOSE.length)
    expect(
      whole.length - source.length,
      'the fence must actually exclude this cell, or the scan is reading its own vocabulary',
    ).toBeGreaterThan(500)

    const startServerSites = (source.match(/await startServer\(/gu) ?? []).length
    expect(startServerSites, 'the production server is constructed in exactly one place').toBe(1)
    const constructionSite = /async function productionFrame\([\s\S]*?\n\}/u.exec(source)?.[0] ?? ''
    expect(constructionSite, 'and that place is `productionFrame`').toContain('startServer(')
    expect(constructionSite, 'threading the two ports the live view needs off the shipped option')
      .toContain('runServiceAttach')
    expect(constructionSite).toContain('liveView')

    const users = (source.match(/await productionFrame\(/gu) ?? []).length
    expect(users, 'every socket-level cell in this file goes through that one frame').toBeGreaterThanOrEqual(6)

    // The two lookalikes: a bare router mount, or a hand-rolled `WebSocketServer` this file
    // upgrades itself. Either would leave every assertion above reading identically while
    // measuring something `agent-qa dashboard` never runs.
    expect(source.includes('createRouter('), 'no router may be mounted in-process here').toBe(false)
    expect(source.includes('new WebSocketServer('), 'and no upgrade path may be re-implemented here')
      .toBe(false)
    // The ONE sanctioned direct-proxy CALL SITE — the slow-viewer gauge cell, which says at the
    // site why it cannot use the shipped frame. A second one would be a cell quietly opting out.
    expect((source.match(/createFrameProxy\(/gu) ?? []).length, 'exactly one direct-proxy call site')
      .toBe(1)
    /* self-scan:end */
  })

  it('(21) the proxy module holds NO cancel and measures its hello cap in BYTES — pinned in source', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const { dirname, join } = await import('node:path')
    const here = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(join(here, '..', 'live-view', 'frame-proxy.ts'), 'utf8')
    expect(
      source.includes('cancel'),
      'the frame proxy must not name `cancel` at all — the one call a viewer could make that ends '
      + 'somebody else\'s run is a call this module should not be able to make (T-403-07)',
    ).toBe(false)
    expect(
      source,
      'a character-length cap is not a byte cap; the byte count is what the socket buffers',
    ).toContain('Buffer.byteLength')
  })
})

describe('the editor subject on the frame socket', () => {
  const widthsOf = (viewer: DirectProxyViewer): number[] =>
    viewer.texts.filter((text) => text.type === 'frame').map((text) => text.width as number)

  it('(30) KIND-DISPATCH-BY-SIGNED-SUBJECT: one id, two subjects, and each token opens only its own', async () => {
    const editors = createLiveEditorSubjects()
    const run = hubRun('shared-id', 640)
    const editor = plantEditor(editors, 'shared-id', 800)
    const subjects = { runs: { 'shared-id': run.session }, editors }

    const runViewer = directProxyViewer(subjects, 'shared-id')
    runViewer.greet(tokenFor({ runId: 'shared-id' }))
    expect(runViewer.texts[0]?.type, 'the run token is greeted').toBe('ready')
    expect(runViewer.lookups, 'and only the run registry was asked').toEqual(['run:shared-id'])
    await vi.waitFor(() => { expect(run.source.started()).toBe(true) })
    expect(editor.source.started(), 'the editor producer is untouched by a run token').toBe(false)
    run.source.emit(1)
    expect(widthsOf(runViewer), 'the run token sees the run\'s frames').toEqual([640])

    const editorViewer = directProxyViewer(subjects, 'shared-id')
    editorViewer.greet(editorTokenFor({ sessionId: 'shared-id' }))
    const ready = editorViewer.texts[0]
    expect(ready?.type, 'the editor token is greeted').toBe('ready')
    expect(editorViewer.lookups, 'and only the editor registry was asked')
      .toEqual(['editor:shared-id'])
    // D-10, RESEARCH Open Question 1: the published field names do not move. `runId` is the path
    // id and `handle` is 0; there is no subject field.
    expect(ready?.runId).toBe('shared-id')
    expect(ready?.handle).toBe(0)
    expect(ready?.stream?.kind).toBe('cdp-screencast')
    expect(Object.keys(ready ?? {}).sort()).toEqual(['expiresAt', 'handle', 'runId', 'stream', 'type'])
    await vi.waitFor(() => { expect(editor.source.started()).toBe(true) })
    editor.source.emit(2)
    expect(widthsOf(editorViewer), 'the editor token sees the editor\'s frames').toEqual([800])
    expect(widthsOf(runViewer), 'and the run viewer never saw them').toEqual([640])

    await run.source.hub.close()
    await editor.end()
  })

  it('(30) KIND-DISPATCH-BY-SIGNED-SUBJECT: a token presented at another subject\'s id is refused scope_mismatch before any attach', () => {
    const editors = createLiveEditorSubjects()
    const run = hubRun('run-r', 640)
    const editor = plantEditor(editors, 'editor-s', 800)
    const subjects = { runs: { 'run-r': run.session }, editors }

    const runTokenAtEditor = directProxyViewer(subjects, 'editor-s')
    runTokenAtEditor.greet(tokenFor({ runId: 'run-r' }))
    expect(runTokenAtEditor.texts.map((text) => text.reason)).toEqual(['scope_mismatch'])
    expect(runTokenAtEditor.closed?.code).toBe(LIVE_VIEW_REFUSAL_CLOSE_CODE)
    expect(runTokenAtEditor.lookups, 'refused before any registry is asked').toEqual([])

    const editorTokenAtRun = directProxyViewer(subjects, 'run-r')
    editorTokenAtRun.greet(editorTokenFor({ sessionId: 'editor-s' }))
    expect(editorTokenAtRun.texts.map((text) => text.reason)).toEqual(['scope_mismatch'])
    expect(editorTokenAtRun.closed?.code).toBe(LIVE_VIEW_REFUSAL_CLOSE_CODE)
    expect(editorTokenAtRun.lookups).toEqual([])
    expect(run.source.started() || editor.source.started(), 'no producer was started').toBe(false)
  })

  it('(31) UNKNOWN-SESSION-BY-NAME: a valid editor token for a session nobody holds is refused unknown_session', () => {
    const editors = createLiveEditorSubjects()
    plantEditor(editors, 'someone-else', 800)
    const viewer = directProxyViewer({ runs: {}, editors }, 'ghost')
    viewer.greet(editorTokenFor({ sessionId: 'ghost' }))
    expect(viewer.texts.map((text) => text.type)).toEqual(['refused'])
    expect(viewer.texts[0]?.reason).toBe('unknown_session')
    expect(viewer.closed?.code).toBe(LIVE_VIEW_REFUSAL_CLOSE_CODE)
    expect(viewer.closed?.reason).toBe('unknown_session')
    expect(viewer.lookups, 'the editor lookup is the answer, and no run was asked')
      .toEqual(['editor:ghost'])
  })

  it('(32) RENEW-KEEPS-SUBJECT-KIND: an editor socket renews with an editor token and refuses a run one', () => {
    const editors = createLiveEditorSubjects()
    const editor = plantEditor(editors, 'shared-id', 800)
    const run = hubRun('shared-id', 640)
    const viewer = directProxyViewer({ runs: { 'shared-id': run.session }, editors }, 'shared-id')
    viewer.greet(editorTokenFor({ sessionId: 'shared-id', exp: Date.now() + 5_000 }))
    expect(viewer.texts[0]?.type, 'the witness: the editor socket is open').toBe('ready')

    const laterExp = Date.now() + 60_000
    viewer.send({ type: 'renew', token: editorTokenFor({ sessionId: 'shared-id', exp: laterExp }) })
    const renewed = viewer.texts.find((text) => text.type === 'renewed')
    expect(renewed?.expiresAt, 'a fresh editor token extends the deadline').toBe(laterExp)
    expect(viewer.closed).toBeUndefined()

    viewer.send({ type: 'renew', token: tokenFor({ runId: 'shared-id' }) })
    expect(
      viewer.texts.filter((text) => text.type === 'refused').map((text) => text.reason),
      'a renew is validated against the kind resolved at greet, never re-dispatched',
    ).toEqual(['scope_mismatch'])
    expect(viewer.closed?.code).toBe(LIVE_VIEW_REFUSAL_CLOSE_CODE)
    expect(viewer.lookups, 'the run registry was never asked').toEqual(['editor:shared-id'])
    void editor.end()
  })

  it('(33) SESSION-END-SAYS-SESSION-ENDED: an editor session ending sends ended { sessionEnded } and closes 1000', async () => {
    const editors = createLiveEditorSubjects()
    const editor = plantEditor(editors, 'session-e', 800)
    const viewer = directProxyViewer({ editors }, 'session-e')
    viewer.greet(editorTokenFor({ sessionId: 'session-e' }))
    expect(viewer.texts[0]?.type).toBe('ready')
    await vi.waitFor(() => { expect(editor.source.started(), 'the witness: streaming').toBe(true) })
    editor.source.emit(1)
    expect(widthsOf(viewer)).toEqual([800])

    await editor.end()
    await vi.waitFor(() => { expect(viewer.closed).toBeDefined() })
    expect(
      viewer.texts.filter((text) => text.type === 'ended').map((text) => text.reason),
      'the session\'s own end, by its own name — the closed hub under it said nothing',
    ).toEqual(['sessionEnded'])
    expect(viewer.closed).toEqual({ code: 1000, reason: 'sessionEnded' })
  })
})
