import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { createSessionHandler } from '../live-editor/ws-handler.js'
import type { LiveSession } from '../live-editor/live-session.js'
import type { SessionState } from '../live-editor/types.js'

const HOOK_ID = 'h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle'

class MockWebSocket {
  readyState = 1
  OPEN = 1

  sentMessages: string[] = []
  private handlers = new Map<string, Function>()

  send(data: string) {
    this.sentMessages.push(data)
  }

  close(_code?: number, _reason?: string) {}

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
    ...overrides,
  } as unknown as LiveSession
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

  it('get-screenshot sends base64 screenshot', async () => {
    const handler = createSessionHandler(session as unknown as LiveSession, onTerminate)
    handler(ws as any)

    ws.simulateMessage({ type: 'get-screenshot' })
    await vi.waitFor(() => expect(ws.sentMessages.length).toBe(3))

    const msg = ws.parsed(2)
    expect(msg.type).toBe('screenshot')
    expect(msg.data).toBe(Buffer.from('fake-png').toString('base64'))
  })

  it('get-screenshot sends error when unavailable', async () => {
    ;(session.getScreenshot as any).mockResolvedValue(undefined)

    const handler = createSessionHandler(session as unknown as LiveSession, onTerminate)
    handler(ws as any)

    ws.simulateMessage({ type: 'get-screenshot' })
    await vi.waitFor(() => expect(ws.sentMessages.length).toBe(3))

    const msg = ws.parsed(2)
    expect(msg.type).toBe('error')
    expect(msg.message).toBe('Screenshot unavailable')
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

  it('on close cleans up the disposable session immediately', async () => {
    const handler = createSessionHandler(session as unknown as LiveSession, onTerminate)
    handler(ws as any)

    ws.simulateClose()
    await vi.waitFor(() => expect(session.cleanup).toHaveBeenCalled())
    expect(session.startIdleTimer).not.toHaveBeenCalled()
    expect(onTerminate).toHaveBeenCalled()
  })
})
