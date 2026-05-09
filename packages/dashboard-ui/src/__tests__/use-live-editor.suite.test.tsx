// @vitest-environment jsdom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  useLiveEditor,
  type LiveEditorExternalTest,
  type UseLiveEditorReturn,
} from '../hooks/use-live-editor'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type SentMessage = Record<string, unknown>

class MockWebSocket {
  static instances: MockWebSocket[] = []
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly url: string
  readonly sent: SentMessage[] = []
  readonly closeCalls: { count: number } = { count: 0 }
  readyState = 1
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  emit(message: Record<string, unknown>): void {
    this.onmessage?.(
      new MessageEvent('message', {
        data: JSON.stringify(message),
      }),
    )
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }

  close(): void {
    this.closeCalls.count += 1
    this.readyState = 3
    this.onclose?.(new CloseEvent('close'))
  }
}

interface HarnessRefHolder {
  current: UseLiveEditorReturn | null
}

interface HarnessProps {
  tests?: LiveEditorExternalTest[]
  setupHooks?: string[]
  teardownHooks?: string[]
  sessionId?: string | null
  refHolder: HarnessRefHolder
}

function LiveEditorHarness(props: HarnessProps) {
  const editor = useLiveEditor(props.sessionId ?? 'session-suite', {
    tests: props.tests,
    setupHooks: props.setupHooks,
    teardownHooks: props.teardownHooks,
    allowReconnect: false,
  })
  props.refHolder.current = editor
  return null
}

let container: HTMLDivElement | null = null
let root: Root | null = null
let originalWebSocket: typeof WebSocket | undefined

beforeEach(async () => {
  originalWebSocket = globalThis.WebSocket
  MockWebSocket.instances = []
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)

  await flush()
})

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount()
    })
  }
  container?.remove()
  root = null
  container = null
  MockWebSocket.instances = []
  if (originalWebSocket) {
    globalThis.WebSocket = originalWebSocket
  } else {
    delete (globalThis as { WebSocket?: typeof WebSocket }).WebSocket
  }
})

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

async function render(props: HarnessProps): Promise<void> {
  const currentRoot = root
  if (!currentRoot) throw new Error('Test root not initialized')
  await act(async () => {
    currentRoot.render(React.createElement(LiveEditorHarness, props))
  })
  await flush()
}

function openSession(socket: MockWebSocket): void {
  socket.emit({ type: 'session-ready', platform: 'web', interactive: true })
}

function buildTest(overrides: Partial<LiveEditorExternalTest> = {}): LiveEditorExternalTest {
  return {
    testId: overrides.testId ?? 't_1',
    path: overrides.path ?? 'a.yaml',
    name: overrides.name ?? 'Test A',
    steps: overrides.steps ?? ['click login'],
    setup: overrides.setup ?? [],
    teardown: overrides.teardown ?? [],
    draftId: overrides.draftId,
    context: overrides.context,
  }
}

function buildTestMeta(
  sent: Record<string, unknown>,
  testName: string,
) {
  return {
    testExecutionId: String(sent.testExecutionId),
    testIndex: Number(sent.testIndex ?? 0),
    testId: String(sent.testId),
    testName,
  }
}

function ref(holder: HarnessRefHolder): UseLiveEditorReturn {
  const editor = holder.current
  if (!editor) throw new Error('Hook ref not populated')
  return editor
}

describe('useLiveEditor suite mode', () => {
  it('exposes empty tests array when called without tests option', async () => {
    const holder: HarnessRefHolder = { current: null }
    await render({ refHolder: holder })
    const editor = ref(holder)
    expect(editor.tests).toEqual([])
    expect(typeof editor.executeTestByIndex).toBe('function')
  })

  it('populates tests[i] with idle status from tests option', async () => {
    const holder: HarnessRefHolder = { current: null }
    await render({
      refHolder: holder,
      tests: [buildTest()],
    })
    const editor = ref(holder)
    expect(editor.tests).toHaveLength(1)
    expect(editor.tests[0].status).toBe('idle')
    expect(editor.tests[0].testId).toBe('t_1')
    expect(editor.tests[0].path).toBe('a.yaml')
    expect(editor.tests[0].name).toBe('Test A')
  })

  // D-03
  it('executeTestByIndex sends execute-test WS message with testExecutionId, testId, path, testIndex', async () => {
    const holder: HarnessRefHolder = { current: null }
    await render({
      refHolder: holder,
      tests: [buildTest({ testId: 't_a', path: 'a.yaml', name: 'A' })],
    })
    const socket = MockWebSocket.instances[0]
    openSession(socket)
    await flush()

    await act(async () => {
      void ref(holder).executeTestByIndex(0, { suiteName: 'Suite One' })
      await Promise.resolve()
    })
    await flush()

    const sent = socket.sent.find((m) => m.type === 'execute-test')
    expect(sent).toBeTruthy()
    expect(sent).toMatchObject({
      type: 'execute-test',
      testId: 't_a',
      path: 'a.yaml',
      testIndex: 0,
    })
    expect(typeof sent?.testExecutionId).toBe('string')
  })

  // D-03
  it('applies test-complete message to tests[i].status and duration', async () => {
    const holder: HarnessRefHolder = { current: null }
    await render({
      refHolder: holder,
      tests: [buildTest({ testId: 't_a' })],
    })
    const socket = MockWebSocket.instances[0]
    openSession(socket)
    await flush()

    await act(async () => {
      void ref(holder).executeTestByIndex(0)
      await Promise.resolve()
    })
    await flush()

    await act(async () => {
      const sent = socket.sent.find((message) => message.type === 'execute-test') as Record<string, unknown>
      socket.emit({
        type: 'test-complete',
        test: buildTestMeta(sent, 'Test A'),
        result: { status: 'passed', duration: 1234 },
      })
    })
    await flush()

    const editor = ref(holder)
    expect(editor.tests[0].status).toBe('passed')
    expect(editor.tests[0].duration).toBe(1234)
    expect(editor.runningTestIndex).toBeNull()
  })

  // D-04
  it('runAllTests iterates tests in order', async () => {
    const holder: HarnessRefHolder = { current: null }
    await render({
      refHolder: holder,
      tests: [
        buildTest({ testId: 't_a', path: 'a.yaml', name: 'A' }),
        buildTest({ testId: 't_b', path: 'b.yaml', name: 'B' }),
        buildTest({ testId: 't_c', path: 'c.yaml', name: 'C' }),
      ],
    })
    const socket = MockWebSocket.instances[0]
    openSession(socket)
    await flush()

    const runPromise = act(async () => {
      void ref(holder).runAllTests({ suiteName: 'S' })
      await Promise.resolve()
    })

    for (let i = 0; i < 3; i++) {
      await flush()
      await act(async () => {
        const sent = socket.sent.filter((message) => message.type === 'execute-test')[i] as Record<string, unknown>
        socket.emit({
          type: 'test-complete',
          test: buildTestMeta(sent, ['A', 'B', 'C'][i] ?? `Test ${i}`),
          result: { status: 'passed', duration: 10 },
        })
      })
      await flush()
    }
    await runPromise

    const dispatched = socket.sent.filter((m) => m.type === 'execute-test')
    expect(dispatched).toHaveLength(3)
    expect(dispatched.map((m) => m.testId)).toEqual(['t_a', 't_b', 't_c'])
    expect(ref(holder).isRunningAllTests).toBe(false)
  })

  // D-07 fail-fast
  it('runAllTests breaks on first failed test (D-07 fail-fast)', async () => {
    const holder: HarnessRefHolder = { current: null }
    await render({
      refHolder: holder,
      tests: [
        buildTest({ testId: 't_a' }),
        buildTest({ testId: 't_b' }),
        buildTest({ testId: 't_c' }),
      ],
    })
    const socket = MockWebSocket.instances[0]
    openSession(socket)
    await flush()

    const runPromise = act(async () => {
      void ref(holder).runAllTests()
      await Promise.resolve()
    })

    await flush()
    await act(async () => {
      const sent = socket.sent.find((message) => message.type === 'execute-test') as Record<string, unknown>
      socket.emit({
        type: 'test-complete',
        test: buildTestMeta(sent, 'Test A'),
        result: { status: 'failed', duration: 10, error: 'boom' },
      })
    })
    await flush()
    await runPromise

    const dispatched = socket.sent.filter((m) => m.type === 'execute-test')
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0].testId).toBe('t_a')
  })

  // D-07
  it('runAllTests breaks on cancelled result', async () => {
    const holder: HarnessRefHolder = { current: null }
    await render({
      refHolder: holder,
      tests: [
        buildTest({ testId: 't_a' }),
        buildTest({ testId: 't_b' }),
      ],
    })
    const socket = MockWebSocket.instances[0]
    openSession(socket)
    await flush()

    const runPromise = act(async () => {
      void ref(holder).runAllTests()
      await Promise.resolve()
    })

    await flush()
    await act(async () => {
      const sent = socket.sent.find((message) => message.type === 'execute-test') as Record<string, unknown>
      socket.emit({
        type: 'test-complete',
        test: buildTestMeta(sent, 'Test A'),
        result: { status: 'cancelled', duration: 5 },
      })
    })
    await flush()
    await runPromise

    const dispatched = socket.sent.filter((m) => m.type === 'execute-test')
    expect(dispatched).toHaveLength(1)
  })

  // D-08
  it('cancelRunAllTests halts the in-flight queue', async () => {
    const holder: HarnessRefHolder = { current: null }
    await render({
      refHolder: holder,
      tests: [
        buildTest({ testId: 't_a' }),
        buildTest({ testId: 't_b' }),
        buildTest({ testId: 't_c' }),
      ],
    })
    const socket = MockWebSocket.instances[0]
    openSession(socket)
    await flush()

    const runPromise = act(async () => {
      void ref(holder).runAllTests()
      await Promise.resolve()
    })

    await flush()

    await act(async () => {
      ref(holder).cancelRunAllTests()
    })
    await flush()

    await act(async () => {
      const sent = socket.sent.find((message) => message.type === 'execute-test') as Record<string, unknown>
      socket.emit({
        type: 'test-complete',
        test: buildTestMeta(sent, 'Test A'),
        result: { status: 'cancelled', duration: 5 },
      })
    })
    await flush()
    await runPromise

    const dispatched = socket.sent.filter((m) => m.type === 'execute-test')
    expect(dispatched).toHaveLength(1)
    expect(ref(holder).isRunningAllTests).toBe(false)
  })

  // D-04
  it('isRunningAllTests flips true during runAllTests and false after', async () => {
    const holder: HarnessRefHolder = { current: null }
    await render({
      refHolder: holder,
      tests: [buildTest({ testId: 't_a' })],
    })
    const socket = MockWebSocket.instances[0]
    openSession(socket)
    await flush()

    expect(ref(holder).isRunningAllTests).toBe(false)

    let runDone = false
    const runPromise = ref(holder).runAllTests().finally(() => {
      runDone = true
    })

    // Yield so the hook can set isRunningAllTests=true and dispatch the first test
    await flush()
    await flush()
    expect(ref(holder).isRunningAllTests).toBe(true)
    expect(runDone).toBe(false)

    await act(async () => {
      const sent = socket.sent.find((message) => message.type === 'execute-test') as Record<string, unknown>
      socket.emit({
        type: 'test-complete',
        test: buildTestMeta(sent, 'Test A'),
        result: { status: 'passed', duration: 10 },
      })
    })
    await flush()
    await runPromise
    await flush()

    expect(ref(holder).isRunningAllTests).toBe(false)
  })

  // D-04
  it('runningTestIndex reflects the currently executing test index', async () => {
    const holder: HarnessRefHolder = { current: null }
    await render({
      refHolder: holder,
      tests: [buildTest({ testId: 't_a' })],
    })
    const socket = MockWebSocket.instances[0]
    openSession(socket)
    await flush()

    expect(ref(holder).runningTestIndex).toBeNull()

    await act(async () => {
      void ref(holder).executeTestByIndex(0)
      await Promise.resolve()
    })
    await flush()

    expect(ref(holder).runningTestIndex).toBe(0)

    await act(async () => {
      const sent = socket.sent.find((message) => message.type === 'execute-test') as Record<string, unknown>
      socket.emit({
        type: 'test-complete',
        test: buildTestMeta(sent, 'Test A'),
        result: { status: 'passed', duration: 1 },
      })
    })
    await flush()

    expect(ref(holder).runningTestIndex).toBeNull()
  })

  // D-13 — playground model
  it('test-list changes do NOT invalidate in-flight session (D-13 playground model)', async () => {
    const holder: HarnessRefHolder = { current: null }
    await render({
      refHolder: holder,
      sessionId: 'session-pg',
      tests: [buildTest({ testId: 't_a' })],
    })
    const socket = MockWebSocket.instances[0]
    openSession(socket)
    await flush()

    const beforeSessionId = ref(holder).sessionId
    const beforeConnection = ref(holder).connectionState
    expect(beforeConnection).toBe('connected')

    await render({
      refHolder: holder,
      sessionId: 'session-pg',
      tests: [
        buildTest({ testId: 't_a' }),
        buildTest({ testId: 't_b', path: 'b.yaml', name: 'B' }),
      ],
    })

    const after = ref(holder)
    expect(after.sessionId).toBe(beforeSessionId)
    expect(after.connectionState).toBe('connected')
    expect(after.tests).toHaveLength(2)
    expect(after.tests[1].testId).toBe('t_b')
    expect(MockWebSocket.instances).toHaveLength(1)
    expect(socket.closeCalls.count).toBe(0)
  })

  it('routes test-owned hooks and step detail onto the owning test only', async () => {
    const holder: HarnessRefHolder = { current: null }
    await render({
      refHolder: holder,
      tests: [buildTest({ testId: 't_detail', name: 'Checkout', path: 'checkout.yaml' })],
    })
    const socket = MockWebSocket.instances[0]
    openSession(socket)
    await flush()

    await act(async () => {
      void ref(holder).executeTestByIndex(0)
      await Promise.resolve()
    })
    await flush()

    const sent = socket.sent.find((message) => message.type === 'execute-test') as Record<string, unknown>
    const test = buildTestMeta(sent, 'Checkout')

    await act(async () => {
      socket.emit({ type: 'test-start', test })
      socket.emit({
        type: 'hook-start',
        hook: {
          hookId: 'hook-setup-1',
          hookName: 'setup.auth',
          phase: 'setup',
          owner: { scope: 'test', ...test },
          createdAt: '2026-04-18T00:00:00.000Z',
        },
      })
      socket.emit({
        type: 'hook-complete',
        hook: {
          hookId: 'hook-setup-1',
          hookName: 'setup.auth',
          phase: 'setup',
          owner: { scope: 'test', ...test },
          status: 'passed',
          duration: 5,
          stdout: 'ok',
          stderr: '',
          variables: { AUTH_TOKEN: 'abc' },
          createdAt: '2026-04-18T00:00:00.000Z',
        },
      })
      socket.emit({
        type: 'test-step-start',
        step: {
          ...test,
          stepIndex: 0,
          stepInstruction: 'click checkout',
        },
      })
      socket.emit({
        type: 'test-step-phase',
        step: {
          ...test,
          stepIndex: 0,
          stepInstruction: 'click checkout',
        },
        phase: 'observe',
        data: { text: 'Checkout button visible' },
      })
      socket.emit({
        type: 'test-step-complete',
        step: {
          ...test,
          stepIndex: 0,
          stepInstruction: 'click checkout',
        },
        result: {
          status: 'passed',
          duration: 22,
          consoleLogs: [{ level: 'info', text: 'clicked', timestamp: 1 }],
          networkLogs: [],
          executionLogs: [],
        },
      })
    })
    await flush()

    const editor = ref(holder)
    expect(editor.setupHooks).toEqual([])
    expect(editor.teardownHooks).toEqual([])
    expect(editor.tests[0].perTestSetupHooks).toHaveLength(1)
    expect(editor.tests[0].perTestSetupHooks[0]?.name).toBe('setup.auth')
    expect(editor.tests[0].liveSteps).toHaveLength(1)
    expect(editor.tests[0].liveSteps[0]?.instruction).toBe('click checkout')
    expect(editor.tests[0].liveSteps[0]?.phases[0]?.text).toBe('Checkout button visible')
    expect(editor.tests[0].liveSteps[0]?.status).toBe('passed')
  })
})
