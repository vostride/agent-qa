import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { createSessionHandler } from '../live-editor/ws-handler.js'
import type { LiveSession } from '../live-editor/live-session.js'
import type { SessionState } from '../live-editor/types.js'

const PARSEABLE_TEST_ID = 't_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle'
const PER_TEST_SETUP_HOOK_ID = 'h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle'

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

  parsed(index: number) {
    return JSON.parse(this.sentMessages[index]!)
  }
}

function createMockSession(overrides: Partial<LiveSession> = {}) {
  const state: SessionState = {
    sessionId: 'suite-live-session',
    platform: 'web',
    status: 'idle',
    currentStep: null,
    currentUrl: null,
    stepsExecuted: 0,
    createdAt: Date.now(),
    interactive: true,
    terminalError: null,
    authState: null,
  }

  let sink: ((message: unknown) => void) | null = null
  let generation = 0

  return {
    sessionId: 'suite-live-session',
    status: 'idle' as LiveSession['status'],
    executeStepCommand: vi.fn(),
    executeHookCommand: vi.fn(),
    executeTestCommand: vi.fn().mockImplementation(async (testExecutionId: string, draft: any) => {
      sink?.({
        type: 'hook-start',
        hook: {
          hookId: 'hook-setup-1',
          hookName: 'per-test.setup',
          phase: 'setup',
          owner: {
            scope: 'test',
            testExecutionId,
            testIndex: draft.testIndex,
            testId: draft.testId,
            testName: draft.testName,
          },
          status: 'running',
          createdAt: '2026-04-18T00:00:00.000Z',
        },
      })
      sink?.({
        type: 'test-step-start',
        step: {
          testExecutionId,
          testIndex: draft.testIndex,
          testId: draft.testId,
          testName: draft.testName,
          stepIndex: 0,
          stepInstruction: draft.steps[0],
        },
      })
      sink?.({
        type: 'test-step-phase',
        step: {
          testExecutionId,
          testIndex: draft.testIndex,
          testId: draft.testId,
          testName: draft.testName,
          stepIndex: 0,
          stepInstruction: draft.steps[0],
        },
        phase: 'observe',
        data: { text: 'Login form visible' },
      })
      sink?.({
        type: 'test-step-complete',
        step: {
          testExecutionId,
          testIndex: draft.testIndex,
          testId: draft.testId,
          testName: draft.testName,
          stepIndex: 0,
          stepInstruction: draft.steps[0],
        },
        result: {
          status: 'passed',
          duration: 15,
          consoleLogs: [],
          networkLogs: [],
          executionLogs: [],
        },
      })
      sink?.({
        type: 'hook-complete',
        hook: {
          hookId: 'hook-setup-1',
          hookName: 'per-test.setup',
          phase: 'setup',
          owner: {
            scope: 'test',
            testExecutionId,
            testIndex: draft.testIndex,
            testId: draft.testId,
            testName: draft.testName,
          },
          status: 'passed',
          duration: 5,
          stdout: 'ok',
          stderr: '',
          variables: { AUTH_TOKEN: 'token-1' },
          createdAt: '2026-04-18T00:00:00.000Z',
        },
      })

      return {
        status: 'passed',
        duration: 20,
        setupHookExecutions: [],
        stepResults: [{ status: 'passed', duration: 15 }],
        teardownHookExecutions: [],
      }
    }),
    cancelStep: vi.fn(),
    getState: vi.fn().mockReturnValue(state),
    getScreenshot: vi.fn(),
    getAriaTree: vi.fn(),
    cleanup: vi.fn().mockResolvedValue(undefined),
    startIdleTimer: vi.fn(),
    clearIdleTimer: vi.fn(),
    noteUserActivity: vi.fn(),
    attachMessageSink: vi.fn().mockImplementation((nextSink: ((message: unknown) => void) | null) => {
      sink = nextSink
    }),
    beginAttachment: vi.fn(() => ++generation),
    isCurrentAttachment: vi.fn((candidate: number) => candidate === generation),
    ...overrides,
  } as unknown as LiveSession
}

describe('ws-handler suite-mode transport', () => {
  let ws: MockWebSocket
  let session: ReturnType<typeof createMockSession>
  let onTerminate: Mock<() => void>

  const testFileManager = {
    testsDir: '/workspace/tests',
    read: vi.fn().mockResolvedValue(
      `test-id: ${PARSEABLE_TEST_ID}\nname: Checkout\ntarget: demo-target\nsteps:\n  - click checkout\nsetup:\n  - ${PER_TEST_SETUP_HOOK_ID}\n`,
    ),
  }

  beforeEach(() => {
    ws = new MockWebSocket()
    session = createMockSession()
    onTerminate = vi.fn()
    testFileManager.read.mockClear()
    vi.clearAllMocks()
  })

  it('preserves test ownership and per-test lifecycle messages across execute-test', async () => {
    const handler = createSessionHandler(
      session as unknown as LiveSession,
      onTerminate,
      undefined,
      testFileManager as any,
    )
    handler(ws as any)

    ws.simulateMessage({
      type: 'execute-test',
      testExecutionId: 'exec-123',
      testId: 't_checkout',
      path: 'tests/checkout.yaml',
      testIndex: 2,
    })

    await vi.waitFor(() => expect(ws.sentMessages.length).toBeGreaterThanOrEqual(9))

    expect(ws.parsed(2)).toMatchObject({
      type: 'test-start',
      test: {
        testExecutionId: 'exec-123',
        testIndex: 2,
        testId: 't_checkout',
        testName: 'Checkout',
      },
    })
    expect(ws.parsed(3)).toMatchObject({
      type: 'hook-start',
      hook: {
        owner: {
          scope: 'test',
          testExecutionId: 'exec-123',
          testIndex: 2,
          testId: 't_checkout',
          testName: 'Checkout',
        },
      },
    })
    expect(ws.parsed(4)).toMatchObject({
      type: 'test-step-start',
      step: {
        testExecutionId: 'exec-123',
        testIndex: 2,
        testId: 't_checkout',
        stepIndex: 0,
        stepInstruction: 'click checkout',
      },
    })
    expect(ws.parsed(5)).toMatchObject({
      type: 'test-step-phase',
      step: {
        testExecutionId: 'exec-123',
        stepIndex: 0,
      },
      phase: 'observe',
    })
    expect(ws.parsed(6)).toMatchObject({
      type: 'test-step-complete',
      step: {
        testExecutionId: 'exec-123',
        stepIndex: 0,
      },
      result: {
        status: 'passed',
      },
    })
    expect(ws.parsed(8)).toMatchObject({
      type: 'test-complete',
      test: {
        testExecutionId: 'exec-123',
        testIndex: 2,
        testId: 't_checkout',
        testName: 'Checkout',
      },
      result: {
        status: 'passed',
      },
    })
  })
})

describe('ws-handler execute-test hands the member auth state name to the session', () => {
  const memberWith = (use: string) =>
    `test-id: ${PARSEABLE_TEST_ID}\nname: Checkout\ntarget: demo-target\n${use}steps:\n  - click checkout\n`

  async function executeMember(content: string): Promise<Record<string, unknown>> {
    const ws = new MockWebSocket()
    const session = createMockSession()
    const testFileManager = { testsDir: '/workspace/tests', read: vi.fn().mockResolvedValue(content) }
    createSessionHandler(session as unknown as LiveSession, vi.fn(), undefined, testFileManager as any)(ws as any)
    ws.simulateMessage({
      type: 'execute-test',
      testExecutionId: 'exec-auth',
      testId: PARSEABLE_TEST_ID,
      path: 'tests/checkout.yaml',
      testIndex: 0,
    })
    const execute = session.executeTestCommand as unknown as Mock
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1))
    return execute.mock.calls[0]?.[1] as Record<string, unknown>
  }

  it.each([
    ['the string form', 'use:\n  authState: admin\n'],
    ['the object form', 'use:\n  authState:\n    name: admin\n    load: false\n'],
  ])('carries the name the member names in %s', async (_label, use) => {
    const draft = await executeMember(memberWith(use))

    expect(draft.authStateName).toBe('admin')
  })

  it('carries no name for a member that names none', async () => {
    const draft = await executeMember(memberWith(''))

    expect('authStateName' in draft).toBe(false)
  })
})
