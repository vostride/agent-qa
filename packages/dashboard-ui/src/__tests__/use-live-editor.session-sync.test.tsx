// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  syncExternalHooks,
  useLiveEditor,
  type LiveEditorExternalStep,
} from '../hooks/use-live-editor'

const SETUP_ALPHA_ID = 'h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle'
const SETUP_BETA_ID = 'h_aster-bloom-cloud-drift-ember-field-glade-hollow-ivory-jasper'
const TEARDOWN_ALPHA_ID = 'h_canyon-dawn-elm-fjord-grove-harbor-ivory-jungle-kestrel-lantern'
const TEARDOWN_BETA_ID = 'h_cedar-drift-ember-forest-glacier-harbor-island-jetty-kelp-lotus'

class MockWebSocket {
  static instances: MockWebSocket[] = []

  readonly url: string
  readonly closeCalls: { count: number } = { count: 0 }
  readyState = 0
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

  close(): void {
    this.closeCalls.count += 1
    this.readyState = 3
    this.onclose?.(new CloseEvent('close'))
  }
}

interface HarnessProps {
  steps: LiveEditorExternalStep[]
  setupHooks: string[]
  teardownHooks: string[]
}

function LiveEditorHarness({ steps, setupHooks, teardownHooks }: HarnessProps) {
  const liveEditor = useLiveEditor('session-123', {
    steps,
    setupHooks,
    teardownHooks,
    allowReconnect: false,
  })

  return (
    <div>
      <div data-testid="connection-state">{liveEditor.connectionState}</div>
      <div data-testid="steps">
        {liveEditor.steps.map((step) => `${step.id}:${step.instruction}`).join('|')}
      </div>
      <div data-testid="setup-hooks">
        {liveEditor.setupHooks.map((hook) => `${hook.id}:${hook.name}`).join('|')}
      </div>
      <div data-testid="teardown-hooks">
        {liveEditor.teardownHooks.map((hook) => `${hook.id}:${hook.name}`).join('|')}
      </div>
    </div>
  )
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

async function render(props: HarnessProps): Promise<HTMLElement> {
  const currentRoot = root
  const currentContainer = container

  if (!currentRoot || !currentContainer) {
    throw new Error('Test root not initialized')
  }

  await act(async () => {
    currentRoot.render(<LiveEditorHarness {...props} />)
  })
  await flush()

  return currentContainer
}

function getByTestId(rootElement: HTMLElement, testId: string): HTMLElement {
  const element = rootElement.querySelector(`[data-testid="${testId}"]`)
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Missing test element "${testId}"`)
  }
  return element
}

function connectSession(socket: MockWebSocket): void {
  socket.emit({
    type: 'session-ready',
    platform: 'web',
    interactive: true,
  })
}

describe('useLiveEditor session sync', () => {
  it('keeps the live websocket open when external steps change', async () => {
    const rootElement = await render({
      steps: [{ draftId: 'step-a', instruction: 'Open login page' }],
      setupHooks: [SETUP_ALPHA_ID],
      teardownHooks: [TEARDOWN_ALPHA_ID],
    })

    expect(MockWebSocket.instances).toHaveLength(1)
    const socket = MockWebSocket.instances[0]
    connectSession(socket)
    await flush()

    const initialStepMarkup = getByTestId(rootElement, 'steps').textContent ?? ''

    await render({
      steps: [{ draftId: 'step-a', instruction: 'Open the login page' }],
      setupHooks: [SETUP_ALPHA_ID],
      teardownHooks: [TEARDOWN_ALPHA_ID],
    })

    expect(MockWebSocket.instances).toHaveLength(1)
    expect(socket.closeCalls.count).toBe(0)
    expect(getByTestId(rootElement, 'connection-state').textContent).toBe('connected')
    expect(getByTestId(rootElement, 'steps').textContent).toContain('Open the login page')
    expect(getByTestId(rootElement, 'steps').textContent).toContain(initialStepMarkup.split(':')[0] ?? '')
  })

  it('keeps the live websocket open when external hook lists change', async () => {
    const rootElement = await render({
      steps: [{ draftId: 'step-a', instruction: 'Open login page' }],
      setupHooks: [SETUP_ALPHA_ID],
      teardownHooks: [TEARDOWN_ALPHA_ID],
    })

    expect(MockWebSocket.instances).toHaveLength(1)
    const socket = MockWebSocket.instances[0]
    connectSession(socket)
    await flush()

    await render({
      steps: [{ draftId: 'step-a', instruction: 'Open login page' }],
      setupHooks: [SETUP_BETA_ID, SETUP_ALPHA_ID],
      teardownHooks: [TEARDOWN_BETA_ID],
    })

    expect(MockWebSocket.instances).toHaveLength(1)
    expect(socket.closeCalls.count).toBe(0)
    expect(getByTestId(rootElement, 'connection-state').textContent).toBe('connected')
    expect(getByTestId(rootElement, 'setup-hooks').textContent).toContain(SETUP_BETA_ID)
    expect(getByTestId(rootElement, 'setup-hooks').textContent).toContain(SETUP_ALPHA_ID)
    expect(getByTestId(rootElement, 'teardown-hooks').textContent).toContain(TEARDOWN_BETA_ID)
  })

  it('preserves hook row identity by canonical hook ID when labels change', () => {
    const prevHooks = [{
      id: SETUP_ALPHA_ID,
      name: 'Old Login Label',
      phase: 'setup' as const,
      status: 'passed' as const,
      stdout: null,
      stderr: null,
      variables: null,
    }]

    const nextHooks = syncExternalHooks(prevHooks, [SETUP_ALPHA_ID], 'setup')

    expect(nextHooks[0]).toBe(prevHooks[0])
    expect(nextHooks[0]?.id).toBe(SETUP_ALPHA_ID)
    expect(nextHooks[0]?.name).toBe('Old Login Label')
  })
})
