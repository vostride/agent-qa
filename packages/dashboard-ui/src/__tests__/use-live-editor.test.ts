// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { act, createElement, useEffect, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  syncExternalHooks,
  syncExternalSteps,
  useLiveEditor,
  type EditorStep,
  type LiveHookExecution,
  type UseLiveEditorReturn,
} from '../hooks/use-live-editor'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SETUP_HOOK_ID = 'h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle'
const NEXT_HOOK_ID = 'h_aster-bloom-cloud-drift-ember-field-glade-hollow-ivory-jasper'

function makeStep(
  id: string,
  instruction: string,
  overrides: Partial<EditorStep> = {},
): EditorStep {
  return {
    id,
    draftId: id,
    instruction,
    status: 'idle',
    phases: [],
    executionHistory: [],
    consoleLogs: [],
    networkLogs: [],
    variableSnapshot: null,
    originalStepName: null,
    liveSubActions: null,
    executionLogs: [],
    executionGeneration: 0,
    ...overrides,
  }
}

function makeHook(
  id: string,
  name: string,
  phase: 'setup' | 'teardown',
  overrides: Partial<LiveHookExecution> = {},
): LiveHookExecution {
  return {
    id,
    name,
    phase,
    status: 'pending',
    stdout: null,
    stderr: null,
    variables: null,
    ...overrides,
  }
}

describe('syncExternalSteps', () => {
  it('preserves step identity and live state across in-place instruction edits', () => {
    const prev = [
      makeStep('step-a', 'Open login page', {
        status: 'passed',
        phases: [{ phase: 'plan', text: 'Use the login route', timestamp: '2026-04-16T00:00:00.000Z' }],
      }),
      makeStep('step-b', 'Enter credentials'),
    ]

    const next = syncExternalSteps(prev, [
      { draftId: 'step-a', instruction: 'Open the login page' },
      { draftId: 'step-b', instruction: 'Enter credentials' },
    ])

    expect(next[0].id).toBe('step-a')
    expect(next[0].draftId).toBe('step-a')
    expect(next[0].instruction).toBe('Open the login page')
    expect(next[0].status).toBe('passed')
    expect(next[0].phases[0]?.text).toBe('Use the login route')
  })

  it('reorders external steps by draft id without dropping step state', () => {
    const prev = [
      makeStep('step-a', 'Open login page', { status: 'passed' }),
      makeStep('step-b', 'Enter credentials', { status: 'failed', error: 'Missing field' }),
    ]

    const next = syncExternalSteps(prev, [
      { draftId: 'step-b', instruction: 'Enter credentials' },
      { draftId: 'step-a', instruction: 'Open login page' },
    ])

    expect(next.map((step) => step.id)).toEqual(['step-b', 'step-a'])
    expect(next[0].status).toBe('failed')
    expect(next[0].error).toBe('Missing field')
    expect(next[1].status).toBe('passed')
  })
})

describe('syncExternalHooks', () => {
  it('preserves hook identity and execution state across hook list refreshes', () => {
    const prev = [
      makeHook(SETUP_HOOK_ID, 'Seed Auth', 'setup', {
        status: 'passed',
        variables: { AUTH_TOKEN: 'hook-token' },
      }),
    ]

    const next = syncExternalHooks(prev, [SETUP_HOOK_ID], 'setup')

    expect(next[0].id).toBe(SETUP_HOOK_ID)
    expect(next[0].name).toBe('Seed Auth')
    expect(next[0].status).toBe('passed')
    expect(next[0].variables?.AUTH_TOKEN).toBe('hook-token')
  })

  it('rebuilds hook rows when the configured hook names change', () => {
    const prev = [
      makeHook(SETUP_HOOK_ID, 'Seed Auth', 'setup', { status: 'passed' }),
    ]

    const next = syncExternalHooks(prev, [NEXT_HOOK_ID], 'setup')

    expect(next).toHaveLength(1)
    expect(next[0].name).toBe(NEXT_HOOK_ID)
    expect(next[0].status).toBe('pending')
    expect(next[0].id).toBe(NEXT_HOOK_ID)
  })
})

// The needles are concatenated so this file cannot match itself.
const RETIRED_REQUEST = 'get-' + 'screenshot'
const RETIRED_MEMBERS = ['screen' + 'shot', 'request' + 'Screenshot']
const POLLING_NAMES = ['start' + 'ScreenshotPolling', 'set' + 'Screenshot']

class PollingProbeSocket {
  static instances: PollingProbeSocket[] = []
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly sent: Array<Record<string, unknown>> = []
  readyState = 1
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null

  constructor(readonly url: string) {
    PollingProbeSocket.instances.push(this)
  }

  emit(message: Record<string, unknown>): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(message) }))
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }

  close(): void {
    this.readyState = 3
    this.onclose?.(new CloseEvent('close'))
  }
}

describe('HOOK-HAS-NO-SCREENSHOT-POLLING', () => {
  let container: HTMLDivElement
  let root: Root
  let originalWebSocket: typeof WebSocket
  const holder: { current: UseLiveEditorReturn | null } = { current: null }

  function Harness() {
    holder.current = useLiveEditor('session-poll', { allowReconnect: false })
    return null
  }

  beforeEach(async () => {
    vi.useFakeTimers()
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    originalWebSocket = globalThis.WebSocket
    PollingProbeSocket.instances = []
    globalThis.WebSocket = PollingProbeSocket as unknown as typeof WebSocket
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(createElement(Harness))
    })
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    container.remove()
    holder.current = null
    globalThis.WebSocket = originalWebSocket
    delete (document as { hidden?: boolean }).hidden
    vi.useRealTimers()
  })

  it('HOOK-HAS-NO-SCREENSHOT-POLLING: a connected session sends no retired request in 10 s', async () => {
    const socket = PollingProbeSocket.instances[0]
    expect(socket).toBeDefined()
    await act(async () => {
      socket.emit({ type: 'session-ready', platform: 'web', interactive: true })
    })
    expect(holder.current?.connectionState).toBe('connected')

    await act(async () => {
      vi.advanceTimersByTime(10_000)
    })

    expect(socket.sent.filter((message) => message.type === RETIRED_REQUEST)).toEqual([])
  })

  it('HOOK-HAS-NO-SCREENSHOT-POLLING: the return has no screenshot and no requestScreenshot', () => {
    const editor = holder.current
    expect(editor).not.toBeNull()
    for (const member of RETIRED_MEMBERS) {
      expect(Object.keys(editor ?? {})).not.toContain(member)
    }
  })

  it("HOOK-HAS-NO-SCREENSHOT-POLLING: the hook's source names no polling function or retired message", () => {
    const source = readFileSync(resolve(process.cwd(), 'src/hooks/use-live-editor.ts'), 'utf8')
    for (const needle of [...POLLING_NAMES, RETIRED_REQUEST]) {
      expect(source).not.toContain(needle)
    }
  })
})

// The server only detaches on a dropped socket, so an explicit end must reach it another way.
class LifecycleProbeSocket {
  static instances: LifecycleProbeSocket[] = []
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly sent: Array<Record<string, unknown>> = []
  readyState = 1
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null

  constructor(readonly url: string) {
    LifecycleProbeSocket.instances.push(this)
  }

  emit(message: Record<string, unknown>): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(message) }))
  }

  open(): void {
    this.readyState = 1
    this.onopen?.(new Event('open'))
  }

  drop(code: number): void {
    this.readyState = 3
    this.onclose?.(new CloseEvent('close', { code }))
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }

  close(): void {
    this.readyState = 3
    this.onclose?.(new CloseEvent('close', { code: 1000 }))
  }
}

describe('editor session lifecycle', () => {
  let container: HTMLDivElement
  let root: Root | null
  let originalWebSocket: typeof WebSocket
  const fetchMock = vi.fn()
  const holder: { current: UseLiveEditorReturn | null } = { current: null }

  function deleteCallsFor(sessionId: string) {
    return fetchMock.mock.calls.filter(
      ([url, init]) =>
        url === `/api/live-editor/sessions/${sessionId}`
        && (init as RequestInit | undefined)?.method === 'DELETE',
    )
  }

  async function mount(element: ReturnType<typeof createElement>) {
    root = createRoot(container)
    await act(async () => {
      root?.render(element)
    })
  }

  async function unmount() {
    await act(async () => {
      root?.unmount()
    })
    root = null
  }

  beforeEach(() => {
    vi.useFakeTimers()
    originalWebSocket = globalThis.WebSocket
    LifecycleProbeSocket.instances = []
    globalThis.WebSocket = LifecycleProbeSocket as unknown as typeof WebSocket
    fetchMock.mockReset()
    fetchMock.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve({ ok: true }),
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = null
  })

  afterEach(async () => {
    if (root) await unmount()
    container.remove()
    holder.current = null
    globalThis.WebSocket = originalWebSocket
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  function Harness({ sessionId, allowReconnect }: { sessionId: string | null; allowReconnect: boolean }) {
    holder.current = useLiveEditor(sessionId, { allowReconnect })
    return null
  }

  // The hook's effect runs first, so unmount closes the socket before the page asks for the end.
  function PageShapedHarness({ sessionId }: { sessionId: string }) {
    const editor = useLiveEditor(sessionId, { allowReconnect: false })
    const terminateRef = useRef(editor.terminateSession)
    terminateRef.current = editor.terminateSession
    useEffect(() => () => {
      terminateRef.current()
    }, [])
    holder.current = editor
    return null
  }

  it('UNMOUNT-DELETES-WITH-SOCKET-CLOSED: an end with the socket already closed sends nothing and DELETEs with keepalive', async () => {
    await mount(createElement(Harness, { sessionId: 'session-ends', allowReconnect: false }))
    const socket = LifecycleProbeSocket.instances[0]
    await act(async () => {
      socket.emit({ type: 'session-ready', platform: 'web', interactive: true })
    })
    await act(async () => {
      socket.drop(1006)
    })

    await act(async () => {
      holder.current?.terminateSession()
    })

    expect(socket.sent.filter((message) => message.type === 'terminate-session')).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/live-editor/sessions/session-ends',
      expect.objectContaining({ method: 'DELETE', keepalive: true }),
    )
  })

  it('UNMOUNT-DELETES-WITH-SOCKET-CLOSED: leaving the page still DELETEs after the hook closed the socket', async () => {
    await mount(createElement(PageShapedHarness, { sessionId: 'session-page' }))
    const socket = LifecycleProbeSocket.instances[0]
    await act(async () => {
      socket.emit({ type: 'session-ready', platform: 'web', interactive: true })
    })

    await unmount()

    expect(socket.readyState).toBe(LifecycleProbeSocket.CLOSED)
    expect(deleteCallsFor('session-page')).toHaveLength(1)
    expect(deleteCallsFor('session-page')[0]?.[1]).toMatchObject({ keepalive: true })
  })

  it('UNMOUNT-DELETES-WITH-SOCKET-CLOSED: an end with the socket open also says terminate-session', async () => {
    await mount(createElement(Harness, { sessionId: 'session-open', allowReconnect: false }))
    const socket = LifecycleProbeSocket.instances[0]
    await act(async () => {
      socket.emit({ type: 'session-ready', platform: 'web', interactive: true })
    })

    await act(async () => {
      holder.current?.terminateSession()
    })

    expect(socket.sent.filter((message) => message.type === 'terminate-session')).toHaveLength(1)
    expect(deleteCallsFor('session-open')).toHaveLength(1)
  })

  it('PAGEHIDE-DELETES: pagehide during a session DELETEs with keepalive, and the listener leaves with the hook', async () => {
    await mount(createElement(Harness, { sessionId: 'session-hide', allowReconnect: false }))
    const socket = LifecycleProbeSocket.instances[0]
    await act(async () => {
      socket.emit({ type: 'session-ready', platform: 'web', interactive: true })
    })

    await act(async () => {
      window.dispatchEvent(new Event('pagehide'))
    })

    expect(deleteCallsFor('session-hide')).toHaveLength(1)
    expect(deleteCallsFor('session-hide')[0]?.[1]).toMatchObject({ keepalive: true })

    await unmount()
    window.dispatchEvent(new Event('pagehide'))

    expect(deleteCallsFor('session-hide')).toHaveLength(1)
  })

  it('PAGEHIDE-DELETES: no session, no DELETE', async () => {
    await mount(createElement(Harness, { sessionId: null, allowReconnect: false }))

    await act(async () => {
      window.dispatchEvent(new Event('pagehide'))
    })

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('SESSION-GONE-ON-4404: a 4404 close names the session gone, cancels the running step and schedules no reconnect', async () => {
    await mount(createElement(Harness, { sessionId: 'session-gone', allowReconnect: true }))
    const socket = LifecycleProbeSocket.instances[0]
    await act(async () => {
      socket.emit({ type: 'session-ready', platform: 'web', interactive: true })
    })
    await act(async () => {
      holder.current?.executeStep('Open the page')
    })
    expect(holder.current?.steps[0]?.status).toBe('running')

    await act(async () => {
      socket.drop(4404)
    })

    expect(holder.current?.sessionGone).toBe(true)
    expect(holder.current?.connectionState).toBe('disconnected')
    expect(holder.current?.steps[0]?.status).toBe('cancelled')

    await act(async () => {
      vi.advanceTimersByTime(10_000)
    })

    expect(LifecycleProbeSocket.instances).toHaveLength(1)
    expect(holder.current?.sessionGone).toBe(true)
  })

  it('SESSION-GONE-ON-4404: a new session id clears it', async () => {
    await mount(createElement(Harness, { sessionId: 'session-gone', allowReconnect: true }))
    await act(async () => {
      LifecycleProbeSocket.instances[0].drop(4404)
    })
    expect(holder.current?.sessionGone).toBe(true)

    await act(async () => {
      root?.render(createElement(Harness, { sessionId: 'session-fresh', allowReconnect: true }))
    })

    expect(holder.current?.sessionGone).toBe(false)
    expect(LifecycleProbeSocket.instances.at(-1)?.url).toContain('sessionId=session-fresh')
  })

  it('RECONNECT-RESUMES-SESSION: a 1006 close reconnects to the same session at 1 s, 2 s and 4 s and resumes it', async () => {
    await mount(createElement(Harness, { sessionId: 'session-keep', allowReconnect: true }))
    await act(async () => {
      LifecycleProbeSocket.instances[0].emit({ type: 'session-ready', platform: 'web', interactive: true })
    })
    expect(holder.current?.connectionState).toBe('connected')

    for (const [attempt, delay] of [[1, 1_000], [2, 2_000], [3, 4_000]] as const) {
      await act(async () => {
        LifecycleProbeSocket.instances[attempt - 1].drop(1006)
      })
      expect(holder.current?.connectionState).not.toBe('disconnected')
      expect(holder.current?.sessionGone).toBe(false)

      await act(async () => {
        vi.advanceTimersByTime(delay - 1)
      })
      expect(LifecycleProbeSocket.instances).toHaveLength(attempt)
      await act(async () => {
        vi.advanceTimersByTime(1)
      })
      expect(LifecycleProbeSocket.instances).toHaveLength(attempt + 1)
      expect(LifecycleProbeSocket.instances[attempt].url).toContain('sessionId=session-keep')
    }

    const resumed = LifecycleProbeSocket.instances[3]
    await act(async () => {
      resumed.open()
      resumed.emit({ type: 'session-ready', platform: 'web', interactive: true })
    })

    expect(holder.current?.connectionState).toBe('connected')
    expect(holder.current?.sessionId).toBe('session-keep')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('RECONNECT-RESUMES-SESSION: after three failed reconnects the hook says disconnected and stops', async () => {
    await mount(createElement(Harness, { sessionId: 'session-lost', allowReconnect: true }))
    for (const delay of [1_000, 2_000, 4_000]) {
      await act(async () => {
        LifecycleProbeSocket.instances.at(-1)?.drop(1006)
      })
      await act(async () => {
        vi.advanceTimersByTime(delay)
      })
    }
    await act(async () => {
      LifecycleProbeSocket.instances.at(-1)?.drop(1006)
    })

    expect(holder.current?.connectionState).toBe('disconnected')
    await act(async () => {
      vi.advanceTimersByTime(30_000)
    })
    expect(LifecycleProbeSocket.instances).toHaveLength(4)
  })

  it('RECONNECT-RESUMES-SESSION: a session change never reconnects the old session', async () => {
    await mount(createElement(Harness, { sessionId: 'session-old', allowReconnect: true }))
    await act(async () => {
      root?.render(createElement(Harness, { sessionId: 'session-new', allowReconnect: true }))
    })
    await act(async () => {
      vi.advanceTimersByTime(10_000)
    })

    const urls = LifecycleProbeSocket.instances.map((socket) => socket.url)
    expect(urls.filter((url) => url.includes('sessionId=session-old'))).toHaveLength(1)
    expect(urls.filter((url) => url.includes('sessionId=session-new'))).toHaveLength(1)
    expect(LifecycleProbeSocket.instances.at(-1)?.readyState).toBe(LifecycleProbeSocket.OPEN)
  })

  it('RECONNECT-RESUMES-SESSION: both editor pages let the hook reconnect and pass sessionGone to the pane', () => {
    for (const page of ['src/pages/test-editor.tsx', 'src/pages/suite-editor.tsx']) {
      const source = readFileSync(resolve(process.cwd(), page), 'utf8')
      expect(source, page).toContain('sessionGone={liveEditor.' + 'sessionGone}')
      expect(source, page).not.toContain('allowReconnect: ' + 'false')
    }
  })
})
