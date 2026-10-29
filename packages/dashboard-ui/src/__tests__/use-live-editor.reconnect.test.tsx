// @vitest-environment jsdom

// 428 code review (428-REVIEW.md): the editor keeps reconnect on (D-09), so a dropped control
// socket is an ordinary event during a suite run. CR-01: the drop settles a test in flight, so
// "Run all tests" ends instead of waiting forever for an answer the old socket cannot carry.
// WR-01: a socket the server replaced (4409) does not reconnect and take the session back.

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  useLiveEditor,
  type LiveEditorExternalTest,
  type UseLiveEditorReturn,
} from '../hooks/use-live-editor'
import { LIVE_EDITOR_SUPERSEDED_CLOSE_CODE } from '../lib/live-preview'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class ReconnectProbeSocket {
  static instances: ReconnectProbeSocket[] = []
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly sent: Record<string, unknown>[] = []
  readyState = 1
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null

  constructor(readonly url: string) {
    ReconnectProbeSocket.instances.push(this)
  }

  emit(message: Record<string, unknown>): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(message) }))
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }

  /** The network drops the socket: not a local close, not the server's 4404. */
  drop(code = 1006): void {
    this.readyState = 3
    this.onclose?.(new CloseEvent('close', { code }))
  }

  close(): void {
    this.readyState = 3
  }
}

interface Holder {
  current: UseLiveEditorReturn | null
}

function Harness({ holder, tests }: { holder: Holder; tests: LiveEditorExternalTest[] }) {
  holder.current = useLiveEditor('session-reconnect', { tests, allowReconnect: true })
  return null
}

function test(testId: string, path: string): LiveEditorExternalTest {
  return { testId, path, name: testId, steps: ['click login'], setup: [], teardown: [] }
}

let container: HTMLDivElement | null = null
let root: Root | null = null
let originalWebSocket: typeof WebSocket | undefined

beforeEach(() => {
  originalWebSocket = globalThis.WebSocket
  ReconnectProbeSocket.instances = []
  globalThis.WebSocket = ReconnectProbeSocket as unknown as typeof WebSocket
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
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
  ReconnectProbeSocket.instances = []
  if (originalWebSocket) globalThis.WebSocket = originalWebSocket
})

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('useLiveEditor reconnect during a suite run', () => {
  it('DROP-SETTLES-RUNNING-TEST: a socket drop during Run all tests cancels the test and ends the run', async () => {
    const holder: Holder = { current: null }
    await act(async () => {
      root?.render(React.createElement(Harness, { holder, tests: [test('t_a', 'a.yaml'), test('t_b', 'b.yaml')] }))
    })
    const socket = ReconnectProbeSocket.instances[0]
    if (socket === undefined) throw new Error('no control socket opened')
    await act(async () => {
      socket.emit({ type: 'session-ready', platform: 'web', interactive: true })
    })

    let settled = false
    await act(async () => {
      void holder.current?.runAllTests().then(() => {
        settled = true
      })
      await Promise.resolve()
    })
    await flush()
    expect(holder.current?.isRunningAllTests).toBe(true)
    expect(holder.current?.tests[0]?.status).toBe('running')

    await act(async () => {
      socket.drop()
    })
    await flush()
    await flush()

    expect(settled, 'runAllTests resolved after the drop').toBe(true)
    expect(holder.current?.isRunningAllTests).toBe(false)
    expect(holder.current?.runningTestIndex).toBeNull()
    expect(holder.current?.tests[0]?.status).toBe('cancelled')
    expect(holder.current?.connectionState, 'a reconnect is on its way').toBe('connecting')
    expect(socket.sent.filter((message) => message.type === 'execute-test'), 'the run stopped at the dropped test')
      .toHaveLength(1)
  })

  it('SUPERSEDED-DOES-NOT-RECONNECT: a 4409 close leaves the page disconnected instead of taking the session back', async () => {
    const holder: Holder = { current: null }
    await act(async () => {
      root?.render(React.createElement(Harness, { holder, tests: [] }))
    })
    const socket = ReconnectProbeSocket.instances[0]
    if (socket === undefined) throw new Error('no control socket opened')
    await act(async () => {
      socket.emit({ type: 'session-ready', platform: 'web', interactive: true })
    })

    await act(async () => {
      socket.drop(LIVE_EDITOR_SUPERSEDED_CLOSE_CODE)
    })

    expect(holder.current?.connectionState).toBe('disconnected')
    expect(holder.current?.sessionGone, 'the session itself is still held').toBe(false)
  })
})
