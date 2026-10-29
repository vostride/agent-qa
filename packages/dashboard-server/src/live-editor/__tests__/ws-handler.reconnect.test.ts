// 428 code review fixes on the editor control socket (428-REVIEW.md).
//
// Phase 428 turned a dropped control socket into a detach (D-09), so a page can reconnect to the
// same session. These cells pin what that path owes the page: a command's outcome reaches the
// socket attached when it finishes (CR-01), and a socket a newer one replaced stops driving the
// session (WR-01), and a session that ends closes its socket and leaves no timer behind (WR-02).
// Teardown is not held hostage by a hub close that never settles (WR-03). The session is the
// real LiveSession; only the commands' own work is stubbed.

import { afterEach, describe, expect, it, vi } from 'vitest'

import { IDLE_TIMEOUT_MS, LIVE_HUB_CLOSE_LIMIT_MS, LiveSession } from '../live-session.js'
import { SessionManager } from '../session-manager.js'
import { LIVE_EDITOR_SUPERSEDED_CLOSE_CODE, LIVE_EDITOR_UNKNOWN_SESSION_CLOSE_CODE } from '../types.js'
import type { LiveHookPayload, LiveTestResultPayload, ServerMessage } from '../types.js'
import { createSessionHandler } from '../ws-handler.js'

const TEST_ID = 't_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle'

class FakeSocket {
  readyState = 1
  OPEN = 1
  readonly sent: Record<string, unknown>[] = []
  readonly closes: Array<{ code?: number; reason?: string }> = []
  private handlers = new Map<string, Array<(...args: unknown[]) => unknown>>()

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason })
    this.readyState = 3
  }

  on(event: string, handler: (...args: unknown[]) => unknown): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
  }

  message(msg: object): void {
    for (const handler of this.handlers.get('message') ?? []) void handler(Buffer.from(JSON.stringify(msg)))
  }

  drop(): void {
    this.readyState = 3
    for (const handler of this.handlers.get('close') ?? []) handler()
  }

  types(): unknown[] {
    return this.sent.map((message) => message.type)
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

const testFileManager = {
  testsDir: '/workspace/tests',
  read: vi.fn(async () => `test-id: ${TEST_ID}\nname: Checkout\ntarget: demo-target\nsteps:\n  - click checkout\n`),
}

const cancelledResult: LiveTestResultPayload = {
  status: 'cancelled',
  duration: 12,
  setupHookExecutions: [],
  stepResults: [],
  teardownHookExecutions: [],
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

function attach(session: LiveSession, onTerminate = vi.fn()): FakeSocket {
  const socket = new FakeSocket()
  createSessionHandler(session, onTerminate, undefined, testFileManager as never)(socket as never)
  return socket
}

describe('428 review: the editor control socket', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('CR-01 RESULT-REACHES-RECONNECTED-SOCKET: a test that finishes after a reconnect reports to the new socket', async () => {
    const session = new LiveSession('cr01-reconnected')
    const finished = deferred<LiveTestResultPayload>()
    vi.spyOn(session, 'executeTestCommand').mockReturnValue(finished.promise)

    const first = attach(session)
    first.message({ type: 'execute-test', testExecutionId: 'exec-1', testId: TEST_ID, path: 'checkout.yaml', testIndex: 0 })
    await vi.waitFor(() => { expect(first.types()).toContain('test-start') })

    first.drop()
    const second = attach(session)
    finished.resolve(cancelledResult)
    await flush()

    expect(first.types(), 'the dropped socket is not the one told').not.toContain('test-complete')
    const complete = second.sent.find((message) => message.type === 'test-complete')
    expect(complete, `the reconnected socket hears how the test ended; it saw ${JSON.stringify(second.types())}`)
      .toMatchObject({ type: 'test-complete', test: { testExecutionId: 'exec-1' }, result: { status: 'cancelled' } })
  })

  it('CR-01 RESULT-HELD-UNTIL-REATTACH: a test that finishes while no socket is attached is flushed to the next one', async () => {
    const session = new LiveSession('cr01-held')
    const finished = deferred<LiveTestResultPayload>()
    vi.spyOn(session, 'executeTestCommand').mockReturnValue(finished.promise)

    const first = attach(session)
    first.message({ type: 'execute-test', testExecutionId: 'exec-2', testId: TEST_ID, path: 'checkout.yaml', testIndex: 0 })
    await vi.waitFor(() => { expect(first.types()).toContain('test-start') })

    first.drop()
    finished.resolve(cancelledResult)
    await flush()

    const second = attach(session)
    expect(second.types().slice(0, 2)).toEqual(['session-ready', 'test-complete'])
    expect(second.sent[1]).toMatchObject({ test: { testExecutionId: 'exec-2' } })
  })

  it('CR-01 HOOK-CAPTURE-KEEPS-REATTACHED-SINK: a socket that reattaches during a captured hook keeps receiving', async () => {
    const session = new LiveSession('cr01-hooks')
    const gate = deferred<void>()
    const hook = { executionId: 'x', hookId: 'h', hookName: 'Seed', phase: 'setup', owner: { scope: 'suite' }, status: 'passed', createdAt: 'now' } as unknown as LiveHookPayload
    const internals = session as unknown as {
      runLifecycleHooks: (...args: unknown[]) => Promise<{ allPassed: boolean; logs: unknown[] }>
      runLifecycleHooksCapturing: (phase: string, ids: string[], sink: LiveHookPayload[]) => Promise<unknown>
      dispatch: (message: ServerMessage) => void
    }
    internals.runLifecycleHooks = async () => {
      await gate.promise
      internals.dispatch({ type: 'hook-complete', hook })
      return { allPassed: true, logs: [] }
    }

    const before: ServerMessage[] = []
    const after: ServerMessage[] = []
    session.attachMessageSink((message) => before.push(message))
    const captured: LiveHookPayload[] = []
    const running = internals.runLifecycleHooksCapturing('setup', ['h'], captured)
    session.attachMessageSink(null)
    session.attachMessageSink((message) => after.push(message))
    gate.resolve()
    await running

    session.deliver({ type: 'session-terminated' })
    expect(captured, 'the hook is still captured for the test result').toEqual([hook])
    expect(after.map((message) => message.type), 'the reattached sink kept its place')
      .toEqual(['hook-complete', 'session-terminated'])
    expect(before).toEqual([])
  })

  it('WR-01 SUPERSEDED-SOCKET-CLOSED: a newer socket closes the one it replaced by name', () => {
    const session = new LiveSession('wr01-closed')
    const first = attach(session)
    const second = attach(session)

    expect(first.closes).toEqual([{ code: LIVE_EDITOR_SUPERSEDED_CLOSE_CODE, reason: 'superseded' }])
    expect(second.closes).toEqual([])
  })

  it('WR-01 SUPERSEDED-SOCKET-CANNOT-DRIVE: the replaced socket\'s commands are ignored and cannot end the session', async () => {
    const session = new LiveSession('wr01-drive')
    const cleanup = vi.spyOn(session, 'cleanup')
    const onTerminate = vi.fn()
    const first = attach(session, onTerminate)
    const second = attach(session, onTerminate)
    const firstSeen = first.sent.length

    first.message({ type: 'terminate-session' })
    first.message({ type: 'get-state' })
    await flush()
    expect(cleanup).not.toHaveBeenCalled()
    expect(onTerminate).not.toHaveBeenCalled()
    expect(first.sent.length, 'the replaced socket gets no replies').toBe(firstSeen)

    second.message({ type: 'get-state' })
    await flush()
    expect(second.types().at(-1), 'the current socket still drives').toBe('session-state')
  })

  it('WR-01 ONE-LOG-POLL: a replaced mobile socket stops draining device logs', async () => {
    vi.useFakeTimers()
    const session = new LiveSession('wr01-logs')
    vi.spyOn(session, 'getState').mockReturnValue({ ...session.getState(), platform: 'android', interactive: true })
    const drain = vi.spyOn(session, 'drainDeviceLogs').mockResolvedValue([])
    attach(session)
    attach(session)

    await vi.advanceTimersByTimeAsync(2_000)
    expect(drain, 'only the current socket polls').toHaveBeenCalledTimes(1)
  })

  it('WR-02 END-CLOSES-CONTROL-SOCKET: a session ended elsewhere closes its socket as gone and arms no idle window', async () => {
    vi.useFakeTimers()
    const session = new LiveSession('wr02-closes')
    const onTerminate = vi.fn()
    const socket = attach(session, onTerminate)

    await session.cleanup()
    expect(socket.closes).toEqual([{ code: LIVE_EDITOR_UNKNOWN_SESSION_CLOSE_CODE, reason: 'session_ended' }])

    socket.drop()
    expect(vi.getTimerCount(), 'the close that follows arms no timer on the dead session').toBe(0)
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS * 2)
    expect(onTerminate).not.toHaveBeenCalled()
  })

  it('WR-02 IDLE-TIMER-INERT-ONCE-ENDED: startIdleTimer on an ended session arms nothing', async () => {
    vi.useFakeTimers()
    const session = new LiveSession('wr02-inert')
    await session.cleanup()
    session.startIdleTimer(vi.fn())
    expect(vi.getTimerCount()).toBe(0)
  })

  it('WR-02 IDLE-TIMER-UNREF: the idle window never holds the process open', () => {
    const session = new LiveSession('wr02-unref')
    session.startIdleTimer(vi.fn())
    const timer = (session as unknown as { idleTimer: NodeJS.Timeout | null }).idleTimer
    expect(timer?.hasRef()).toBe(false)
    session.clearIdleTimer()
  })

  it('WR-02 EXPIRY-FAILURE-HANDLED: an idle expiry whose cleanup rejects is reported, not left unhandled', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.spyOn(LiveSession.prototype, 'initialize').mockResolvedValue(undefined)
    vi.spyOn(LiveSession.prototype, 'cleanup').mockRejectedValue(new Error('teardown failed'))
    const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const manager = new SessionManager()
    const { sessionId } = await manager.createSession({
      platform: 'web',
      llmConfig: { provider: 'anthropic-compatible', model: 'm', baseURL: 'https://example.invalid' },
    })

    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS)
    await new Promise((resolve) => setImmediate(resolve))
    expect(manager.getSession(sessionId)).toBeUndefined()
    expect(reported).toHaveBeenCalledWith(expect.stringContaining(sessionId), expect.any(Error))
  })

  it('WR-03 TEARDOWN-NOT-HELD-BY-HUB: a hub close that never settles cannot keep the browser up', async () => {
    vi.useFakeTimers()
    const session = new LiveSession('wr03-hub')
    const adapterCleanup = vi.fn(async () => undefined)
    const internals = session as unknown as { liveHub: unknown; adapter: unknown }
    internals.liveHub = { close: () => new Promise<void>(() => undefined) }
    internals.adapter = { cleanup: adapterCleanup }
    let ended = false
    void session.liveAttachment().ended.then(() => {
      ended = true
    })

    let finished = false
    void session.cleanup().then(() => {
      finished = true
    })
    await vi.advanceTimersByTimeAsync(LIVE_HUB_CLOSE_LIMIT_MS)
    await flush()

    expect(finished, 'cleanup went on past the wedged hub').toBe(true)
    expect(adapterCleanup).toHaveBeenCalledTimes(1)
    expect(ended, 'frame sockets hear the session ended').toBe(true)
    expect(session.status).toBe('terminated')
  })
})
