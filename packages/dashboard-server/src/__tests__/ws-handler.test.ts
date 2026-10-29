import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { generateTestId } from '@vostride/agent-qa-ids'
import { createSessionHandler } from '../live-editor/ws-handler.js'
import { IDLE_TIMEOUT_MS, LiveSession } from '../live-editor/live-session.js'
import type { ServerMessage, SessionState } from '../live-editor/types.js'
import type { TestFileManager } from '../tests/test-file-manager.js'

const HOOK_ID = 'h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle'

class MockWebSocket {
  readyState = 1
  OPEN = 1

  sentMessages: string[] = []
  private handlers = new Map<string, Function>()

  send(data: string) {
    this.sentMessages.push(data)
  }

  closes: Array<[number | undefined, string | undefined]> = []

  close(code?: number, reason?: string) {
    this.closes.push([code, reason])
  }

  on(event: string, handler: Function) {
    this.handlers.set(event, handler)
  }

  simulateMessage(msg: object) {
    const handler = this.handlers.get('message')
    if (handler) handler(Buffer.from(JSON.stringify(msg)))
  }

  simulateRawMessage(raw: string) {
    const handler = this.handlers.get('message')
    if (handler) handler(Buffer.from(raw))
  }

  simulateClose() {
    const handler = this.handlers.get('close')
    if (handler) handler()
  }

  simulateError() {
    const handler = this.handlers.get('error')
    if (handler) handler(new Error('socket reset'))
  }

  parsed(index: number) {
    return JSON.parse(this.sentMessages[index])
  }
}

function createMockSession(overrides: Partial<LiveSession> = {}) {
  const state: SessionState = {
    sessionId: 'test-session-123',
    platform: 'web',
    status: 'idle',
    currentStep: null,
    currentUrl: null,
    stepsExecuted: 0,
    createdAt: Date.now(),
    interactive: true,
    terminalError: null,
  }

  // The attachment generation (RESEARCH P4), shared by every handler attached to this session.
  let generation = 0

  return {
    sessionId: 'test-session-123',
    status: 'idle' as LiveSession['status'],
    executeStepCommand: vi.fn().mockResolvedValue({
      status: 'passed',
      duration: 500,
      capturedVariables: {},
      variableSnapshot: { BASE_URL: { value: 'https://example.com', source: 'env' } },
      originalStepName: 'Click {{runJS:"window.location.href"}}',
      consoleLogs: [{ level: 'info', text: 'clicked login', timestamp: 1_700_000_000_000 }],
      networkLogs: [{ url: 'https://example.com/login', method: 'POST', status: 200, requestHeaders: {}, responseHeaders: {}, startTime: 1, endTime: 2 }],
      executionLogs: [{ id: 'runjs-1', type: 'runjs', name: 'window.location.href', phase: 'inline', status: 'passed', duration: 3, stdout: 'https://example.com/login', stderr: null, returnData: 'https://example.com/login', variables: null, createdAt: '2026-04-16T00:00:00.000Z' }],
      subActionsData: [{ index: 0, observation: 'Login form visible', reasoning: 'Submit the form', plannedAction: { type: 'click', ref: 'login' }, result: 'success', screenStateBefore: '<main />', cached: false }],
    }),
    executeHookCommand: vi.fn().mockResolvedValue({
      id: 'hook-exec-1',
      hookId: HOOK_ID,
      type: 'hook',
      name: 'Seed Auth',
      phase: 'setup',
      status: 'passed',
      duration: 12,
      stdout: 'ok',
      stderr: null,
      returnData: null,
      variables: { AUTH_TOKEN: 'hook-token' },
      createdAt: '2026-04-16T00:00:00.000Z',
    }),
    cancelStep: vi.fn(),
    getState: vi.fn().mockReturnValue(state),
    getScreenshot: vi.fn().mockResolvedValue(Buffer.from('fake-png')),
    getAriaTree: vi.fn().mockResolvedValue(null),
    cleanup: vi.fn().mockResolvedValue(undefined),
    startIdleTimer: vi.fn(),
    clearIdleTimer: vi.fn(),
    attachMessageSink: vi.fn(),
    beginAttachment: vi.fn(() => ++generation),
    isCurrentAttachment: vi.fn((candidate: number) => candidate === generation),
    ...overrides,
  } as unknown as LiveSession
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('ws-handler', () => {
  let ws: MockWebSocket
  let session: ReturnType<typeof createMockSession>
  let onTerminate: Mock<() => void>

  beforeEach(() => {
    ws = new MockWebSocket()
    session = createMockSession()
    onTerminate = vi.fn()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends session-ready on handler attach', () => {
    const handler = createSessionHandler(session as unknown as LiveSession, onTerminate)
    handler(ws as any)

    expect(ws.sentMessages).toHaveLength(2)
    const msg = ws.parsed(0)
    expect(msg.type).toBe('session-ready')
    expect(msg.sessionId).toBe('test-session-123')
    expect(msg.platform).toBe('web')
    expect(msg.interactive).toBe(true)
    expect(msg.error).toBeNull()
    expect(ws.parsed(1).type).toBe('session-state')
  })

  it('execute-step calls executeStepCommand and sends step-complete', async () => {
    const handler = createSessionHandler(session as unknown as LiveSession, onTerminate)
    handler(ws as any)

    ws.simulateMessage({
      type: 'execute-step',
      stepInstruction: 'Click login',
      stepIndex: 0,
      draft: { testName: 'Draft Login', testContext: 'Use unsaved context' },
    })
    await vi.waitFor(() => expect(ws.sentMessages.length).toBeGreaterThanOrEqual(4))

    expect(session.executeStepCommand).toHaveBeenCalledWith(
      'Click login',
      0,
      expect.any(Function),
      { testName: 'Draft Login', testContext: 'Use unsaved context' },
    )
    const msg = ws.parsed(2)
    expect(msg.type).toBe('step-complete')
    expect(msg.result.status).toBe('passed')
    expect(msg.result.duration).toBe(500)
    expect(msg.result.variableSnapshot.BASE_URL.value).toBe('https://example.com')
    expect(msg.result.originalStepName).toBe('Click {{runJS:"window.location.href"}}')
    expect(msg.result.consoleLogs[0].text).toBe('clicked login')
    expect(msg.result.executionLogs[0].type).toBe('runjs')
    expect(ws.parsed(3).type).toBe('session-state')
  })

  it('execute-step sends step-busy when session is executing', async () => {
    session.status = 'executing'
    ;(session.getState as any).mockReturnValue({
      sessionId: 'test-session-123',
      platform: 'web',
      status: 'executing',
      currentStep: 'Click button',
      currentUrl: null,
      stepsExecuted: 1,
      createdAt: Date.now(),
      interactive: true,
      terminalError: null,
    })

    const handler = createSessionHandler(session as unknown as LiveSession, onTerminate)
    handler(ws as any)

    ws.simulateMessage({ type: 'execute-step', stepInstruction: 'Type email' })
    await vi.waitFor(() => expect(ws.sentMessages.length).toBe(3))

    const msg = ws.parsed(2)
    expect(msg.type).toBe('step-busy')
    expect(msg.currentStep).toBe('Click button')
    expect(session.executeStepCommand).not.toHaveBeenCalled()
  })

  it('execute-step sends step-error on exception', async () => {
    ;(session.executeStepCommand as any).mockRejectedValue(new Error('Adapter crashed'))

    const handler = createSessionHandler(session as unknown as LiveSession, onTerminate)
    handler(ws as any)

    ws.simulateMessage({ type: 'execute-step', stepInstruction: 'Click broken' })
    await vi.waitFor(() => expect(ws.sentMessages.length).toBe(3))

    const msg = ws.parsed(2)
    expect(msg.type).toBe('step-error')
    expect(msg.error).toBe('Adapter crashed')
  })

  it('execute-step sends step-cancelled when result status is cancelled', async () => {
    ;(session.executeStepCommand as any).mockResolvedValue({
      status: 'cancelled', duration: 200, capturedVariables: {},
    })

    const handler = createSessionHandler(session as unknown as LiveSession, onTerminate)
    handler(ws as any)

    ws.simulateMessage({ type: 'execute-step', stepInstruction: 'Click cancel' })
    await vi.waitFor(() => expect(ws.sentMessages.length).toBe(4))

    const msg = ws.parsed(2)
    expect(msg.type).toBe('step-cancelled')
    expect(ws.parsed(3).type).toBe('session-state')
  })

  it('cancel-step calls session.cancelStep', async () => {
    const handler = createSessionHandler(session as unknown as LiveSession, onTerminate)
    handler(ws as any)

    ws.simulateMessage({ type: 'cancel-step' })
    await vi.waitFor(() => expect(session.cancelStep).toHaveBeenCalled())
  })

  it('execute-hook calls executeHookCommand and sends session-state', async () => {
    const handler = createSessionHandler(session as unknown as LiveSession, onTerminate)
    handler(ws as any)

    ws.simulateMessage({ type: 'execute-hook', phase: 'setup', hookId: HOOK_ID })
    await vi.waitFor(() => expect(ws.sentMessages.length).toBe(3))

    expect(session.executeHookCommand).toHaveBeenCalledWith('setup', HOOK_ID)
    expect(ws.parsed(2).type).toBe('session-state')
  })

  it('terminate-session calls cleanup and sends session-terminated', async () => {
    const handler = createSessionHandler(session as unknown as LiveSession, onTerminate)
    handler(ws as any)

    ws.simulateMessage({ type: 'terminate-session' })
    await vi.waitFor(() => expect(ws.sentMessages.length).toBe(3))

    expect(session.cleanup).toHaveBeenCalled()
    const msg = ws.parsed(2)
    expect(msg.type).toBe('session-terminated')
  })

  it('terminate-session calls onTerminate callback', async () => {
    const handler = createSessionHandler(session as unknown as LiveSession, onTerminate)
    handler(ws as any)

    ws.simulateMessage({ type: 'terminate-session' })
    await vi.waitFor(() => expect(onTerminate).toHaveBeenCalled())
  })

  // 428-19 (D-07): the control socket no longer carries screenshots. Both cells keep their titles
  // and assert the retirement: the mock session could still capture, and the handler never asks.
  it('get-screenshot sends base64 screenshot', async () => {
    const handler = createSessionHandler(session as unknown as LiveSession, onTerminate)
    handler(ws as any)

    ws.simulateMessage({ type: 'get-screenshot' })
    await vi.waitFor(() => expect(ws.sentMessages.length).toBe(3))

    const types = ws.sentMessages.map((raw) => JSON.parse(raw).type)
    expect(types).not.toContain('screenshot')
    expect((session as unknown as { getScreenshot: Mock }).getScreenshot).not.toHaveBeenCalled()
  })

  it('get-screenshot sends error when unavailable', async () => {
    const handler = createSessionHandler(session as unknown as LiveSession, onTerminate)
    handler(ws as any)

    ws.simulateMessage({ type: 'get-screenshot' })
    await vi.waitFor(() => expect(ws.sentMessages.length).toBe(3))

    const msg = ws.parsed(2)
    expect(msg.type).toBe('error')
    expect(msg.message).toBe('Unknown message type: get-screenshot')
  })

  it('get-state sends session-state', async () => {
    const handler = createSessionHandler(session as unknown as LiveSession, onTerminate)
    handler(ws as any)

    ws.simulateMessage({ type: 'get-state' })
    await vi.waitFor(() => expect(ws.sentMessages.length).toBe(3))

    const msg = ws.parsed(2)
    expect(msg.type).toBe('session-state')
    expect(msg.state.sessionId).toBe('test-session-123')
    expect(msg.state.platform).toBe('web')
  })

  it('sends error for invalid JSON', async () => {
    const handler = createSessionHandler(session as unknown as LiveSession, onTerminate)
    handler(ws as any)

    ws.simulateRawMessage('not json')
    await vi.waitFor(() => expect(ws.sentMessages.length).toBe(3))

    const msg = ws.parsed(2)
    expect(msg.type).toBe('error')
    expect(msg.message).toBe('Invalid JSON')
  })

  it('sends error for unknown message type', async () => {
    const handler = createSessionHandler(session as unknown as LiveSession, onTerminate)
    handler(ws as any)

    ws.simulateMessage({ type: 'foo' })
    await vi.waitFor(() => expect(ws.sentMessages.length).toBe(3))

    const msg = ws.parsed(2)
    expect(msg.type).toBe('error')
    expect(msg.message).toBe('Unknown message type: foo')
  })

  it('forwards hook lifecycle payloads from the session transport', () => {
    const attachMessageSink = vi.fn().mockImplementation((sink: ((message: unknown) => void) | null) => {
      sink?.({
        type: 'hook-start',
        hook: {
          executionId: 'hook-exec-1',
          hookId: HOOK_ID,
          hookName: 'Seed Auth',
          phase: 'setup',
          owner: { scope: 'suite' },
          status: 'running',
          createdAt: '2026-04-16T00:00:00.000Z',
        },
      })
      sink?.({
        type: 'hook-complete',
        hook: {
          executionId: 'hook-exec-1',
          hookId: HOOK_ID,
          hookName: 'Seed Auth',
          phase: 'setup',
          owner: { scope: 'suite' },
          status: 'passed',
          duration: 15,
          stdout: 'ok',
          stderr: '',
          variables: { AUTH_TOKEN: 'hook-token' },
          createdAt: '2026-04-16T00:00:00.000Z',
        },
      })
    })
    session = createMockSession({ attachMessageSink } as Partial<LiveSession>)

    const handler = createSessionHandler(session as unknown as LiveSession, onTerminate)
    handler(ws as any)

    expect(attachMessageSink).toHaveBeenCalled()
    expect(ws.parsed(1).type).toBe('hook-start')
    expect(ws.parsed(2).type).toBe('hook-complete')
    expect(ws.parsed(1).hook.executionId).toBe('hook-exec-1')
    expect(ws.parsed(1).hook.hookId).toBe(HOOK_ID)
    expect(ws.parsed(2).hook.executionId).toBe('hook-exec-1')
    expect(ws.parsed(2).hook.variables.AUTH_TOKEN).toBe('hook-token')
  })

  it('UNEXPECTED-CLOSE-DETACHES: an unexpected close detaches the session instead of ending it', async () => {
    const handler = createSessionHandler(session as unknown as LiveSession, onTerminate)
    handler(ws as any)

    ws.simulateClose()
    await flushMicrotasks()

    expect(session.attachMessageSink).toHaveBeenLastCalledWith(null)
    expect(session.startIdleTimer).toHaveBeenCalledTimes(1)
    expect(session.cleanup, 'the browser, draft, page, hooks and lease stay').not.toHaveBeenCalled()
    expect(onTerminate).not.toHaveBeenCalled()
    expect(session.cancelStep, 'an idle session has no step to cancel').not.toHaveBeenCalled()
  })

  describe('EXPIRY-TERMINATES-ONCE', () => {
    function withRealIdleTimer() {
      let idle: ReturnType<typeof setTimeout> | undefined
      return createMockSession({
        startIdleTimer: vi.fn((onExpire: () => void) => {
          clearTimeout(idle)
          idle = setTimeout(onExpire, IDLE_TIMEOUT_MS)
        }),
        clearIdleTimer: vi.fn(() => clearTimeout(idle)),
      } as Partial<LiveSession>)
    }

    it('EXPIRY-TERMINATES-ONCE: a detached session ends through onTerminate once the idle window passes', async () => {
      vi.useFakeTimers()
      session = withRealIdleTimer()
      createSessionHandler(session as unknown as LiveSession, onTerminate)(ws as any)

      ws.simulateClose()
      await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 1)
      expect(onTerminate, 'not one millisecond early').not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      expect(onTerminate).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS)
      expect(onTerminate).toHaveBeenCalledTimes(1)
      expect(session.cleanup, 'teardown is the manager\'s, through onTerminate').not.toHaveBeenCalled()
    })

    it('EXPIRY-TERMINATES-ONCE: an error event takes the same detach path, and the close after it adds nothing', async () => {
      vi.useFakeTimers()
      session = withRealIdleTimer()
      createSessionHandler(session as unknown as LiveSession, onTerminate)(ws as any)

      ws.simulateError()
      ws.simulateClose()
      await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 1)
      expect(onTerminate).not.toHaveBeenCalled()
      expect(session.attachMessageSink).toHaveBeenLastCalledWith(null)
      expect(session.startIdleTimer).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(1)
      expect(onTerminate).toHaveBeenCalledTimes(1)
    })
  })

  it('TERMINATE-MESSAGE-ENDS-AT-ONCE: an explicit terminate-session ends the session without waiting for any timer', async () => {
    vi.useFakeTimers()
    createSessionHandler(session as unknown as LiveSession, onTerminate)(ws as any)

    ws.simulateMessage({ type: 'terminate-session' })
    await flushMicrotasks()

    expect(session.cleanup).toHaveBeenCalledTimes(1)
    expect(onTerminate).toHaveBeenCalledTimes(1)
    expect(ws.parsed(2).type).toBe('session-terminated')
    expect(ws.closes).toEqual([[1000, 'Session terminated']])

    ws.simulateClose()
    await flushMicrotasks()
    expect(session.startIdleTimer, 'the close that follows an explicit end arms nothing').not.toHaveBeenCalled()
    expect(session.cleanup).toHaveBeenCalledTimes(1)
    expect(onTerminate).toHaveBeenCalledTimes(1)
  })

  it('SUPERSEDED-CLOSE-IS-INERT: a superseded socket\'s late close cannot detach the socket that replaced it', async () => {
    const first = new MockWebSocket()
    const second = new MockWebSocket()
    createSessionHandler(session as unknown as LiveSession, onTerminate)(first as any)
    createSessionHandler(session as unknown as LiveSession, onTerminate)(second as any)
    const sinkCalls = (session.attachMessageSink as unknown as Mock).mock.calls

    first.simulateClose()
    await flushMicrotasks()

    expect(sinkCalls.at(-1)?.[0], 'the second socket\'s sink stays attached').toEqual(expect.any(Function))
    expect(session.startIdleTimer).not.toHaveBeenCalled()
    expect(session.cleanup).not.toHaveBeenCalled()
    expect(onTerminate).not.toHaveBeenCalled()

    second.simulateClose()
    await flushMicrotasks()

    expect(sinkCalls.at(-1)?.[0]).toBeNull()
    expect(session.startIdleTimer).toHaveBeenCalledTimes(1)
  })

  it('DETACH-CANCELS-IN-FLIGHT-STEP: a drop during an executing step cancels it server-side', async () => {
    session.status = 'executing'
    createSessionHandler(session as unknown as LiveSession, onTerminate)(ws as any)

    ws.simulateClose()
    await flushMicrotasks()

    expect(session.cancelStep).toHaveBeenCalledTimes(1)
    expect(session.cleanup).not.toHaveBeenCalled()
  })

  it('REATTACH-RESUMES-AND-FLUSHES: a re-attach inside the window resumes the session and flushes what it missed', async () => {
    vi.useFakeTimers()
    const live = new LiveSession('reattach-session')
    const clearIdleTimer = vi.spyOn(live, 'clearIdleTimer')
    const first = new MockWebSocket()
    createSessionHandler(live, onTerminate)(first as any)

    first.simulateClose()
    await flushMicrotasks()
    expect(live.status, 'detached, not ended').not.toBe('terminated')

    // dispatch is the session's one outbound path; with no sink attached it buffers.
    const missed: ServerMessage = { type: 'error', message: 'sent while detached' }
    ;(live as unknown as { dispatch(message: ServerMessage): void }).dispatch(missed)
    expect(first.sentMessages.map((raw) => JSON.parse(raw).type)).not.toContain('error')

    const second = new MockWebSocket()
    const callsBefore = clearIdleTimer.mock.calls.length
    createSessionHandler(live, onTerminate)(second as any)

    expect(clearIdleTimer.mock.calls.length).toBeGreaterThan(callsBefore)
    expect(second.sentMessages.map((raw) => JSON.parse(raw))).toEqual([
      expect.objectContaining({ type: 'session-ready', sessionId: 'reattach-session' }),
      missed,
      expect.objectContaining({ type: 'session-state' }),
    ])

    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS * 2)
    expect(onTerminate, 'the re-attach cleared the idle window').not.toHaveBeenCalled()
  })
})

describe('execute-test console lines', () => {
  const PAIR = /^::stop-commands::([0-9a-f]{32})\n[\s\S]*\n::\1::\n$/u
  const NAME = '::set-output name=x::y'
  const TEST_YAML =
    `test-id: ${generateTestId()}\nname: "${NAME}"\ntarget: web\nsteps:\n  - Click login\n`
  let writes: string[]
  let logSpy: Mock
  let errSpy: Mock

  beforeEach(() => {
    writes = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk))
      return true
    })
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {}) as unknown as Mock
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {}) as unknown as Mock
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  async function executeTest(read: () => Promise<string>): Promise<void> {
    const ws = new MockWebSocket()
    const session = createMockSession({
      executeTestCommand: vi.fn().mockResolvedValue({
        status: 'failed',
        duration: 7,
        error: '##[error]x',
        setupHookExecutions: [],
        stepResults: [],
        teardownHookExecutions: [],
      }),
    } as Partial<LiveSession>)
    const files = { read: vi.fn(read) } as unknown as TestFileManager
    createSessionHandler(session, vi.fn(), undefined, files)(ws as any)
    ws.simulateMessage({ type: 'execute-test', testExecutionId: 'e1', testId: 'x', path: 'a.yaml' })
    await vi.waitFor(() => {
      const types = ws.sentMessages.map((m) => (JSON.parse(m) as { type: string }).type)
      const ended = types.filter((type) => type === 'test-complete' || type === 'test-error')
      expect(ended).toHaveLength(1)
    })
  }

  it('prints the starting and finished lines in a pair each under GitHub Actions', async () => {
    vi.stubEnv('GITHUB_ACTIONS', 'true')

    await executeTest(async () => TEST_YAML)

    expect(writes).toHaveLength(2)
    for (const block of writes) {
      expect(block).toMatch(PAIR)
      expect(block).toContain(`"${NAME}"`)
    }
    expect(writes[0]).toContain('execute-test: starting')
    expect(writes[1]).toContain('execute-test: finished')
    expect(writes[1]).toContain('error=##[error]x')
    expect(logSpy).not.toHaveBeenCalled()
  })

  it('prints a read failure and the caught error in a pair each under GitHub Actions', async () => {
    vi.stubEnv('GITHUB_ACTIONS', 'true')

    await executeTest(async () => {
      throw new Error(NAME)
    })

    expect(writes).toHaveLength(2)
    for (const block of writes) expect(block).toMatch(PAIR)
    expect(writes[0]).toContain('execute-test: read failed for path=a.yaml')
    expect(writes[0]).toContain(NAME)
    expect(writes[1]).toContain('execute-test: caught error for path=a.yaml')
    expect(writes[1]).toContain(`Cannot read test file "a.yaml": ${NAME}`)
    expect(errSpy).not.toHaveBeenCalled()
  })

  it('prints parse errors inside one pair under GitHub Actions', async () => {
    vi.stubEnv('GITHUB_ACTIONS', 'true')

    await executeTest(async () => 'name: [\n')

    expect(writes).toHaveLength(2)
    expect(writes[0]).toMatch(PAIR)
    expect(writes[0]).toContain('execute-test: parse errors for a.yaml')
    expect(writes[0]).toContain('not readable as YAML')
    expect(errSpy).not.toHaveBeenCalled()
  })

  it('passes console.log and console.error the same arguments as before off Actions', async () => {
    await executeTest(async () => TEST_YAML)
    const readError = new Error('gone')
    await executeTest(async () => {
      throw readError
    })

    expect(logSpy.mock.calls).toEqual([
      [`[ws-handler] execute-test: starting "${NAME}" (1 steps, setup=0, teardown=0)`],
      [`[ws-handler] execute-test: finished "${NAME}" status=failed duration=7ms error=##[error]x`],
    ])
    expect(errSpy.mock.calls).toEqual([
      ['[ws-handler] execute-test: read failed for path=a.yaml', readError],
      [
        '[ws-handler] execute-test: caught error for path=a.yaml',
        {
          message: 'Cannot read test file "a.yaml": gone',
          stack: expect.any(String),
          code: undefined,
        },
      ],
    ])
    expect(writes).toHaveLength(0)
  })
})
