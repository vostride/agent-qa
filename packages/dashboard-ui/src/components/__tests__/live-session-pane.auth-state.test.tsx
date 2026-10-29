// @vitest-environment jsdom

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LiveSessionPane } from '@/components/live-session-pane'
import type { LiveModeAuthStateCaptureConfig } from '@/components/live-mode-auth-state-control'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AuthStateMetadata } from '@/lib/api'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/editor/editor-step-detail', () => ({
  EditorStepDetail: ({ step }: { step: { name?: string } }) => <div data-testid="step-detail">{step.name}</div>,
}))

vi.mock('@/components/editor/aria-panel', () => ({
  EditorAriaPanel: () => <div data-testid="aria-panel" />,
}))

const { fetchEditorLiveUrlMock } = vi.hoisted(() => ({ fetchEditorLiveUrlMock: vi.fn() }))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, fetchEditorLiveUrl: fetchEditorLiveUrlMock }
})

vi.mock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children }: { children: ReactElement | ReactElement[] }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: ReactElement | ReactElement[] }) => <div>{children}</div>,
  ResizableHandle: () => <div data-testid="resizable-handle" />,
}))

let container: HTMLDivElement
let root: Root

const existingAdminState: AuthStateMetadata = {
  version: 2,
  kind: 'web',
  target: 'staging-web',
  name: 'admin',
  capturedAt: '2026-05-17T10:00:00.000Z',
}

function click(element: Element | null | undefined) {
  if (!element) throw new Error('Expected element to click')
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function changeInput(input: HTMLInputElement, value: string) {
  act(() => {
    const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    valueSetter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function buttonByLabel(label: string): HTMLButtonElement | null {
  return Array.from(document.body.querySelectorAll('button'))
    .find((button) => button.getAttribute('aria-label') === label || button.textContent?.includes(label)) ?? null
}

function lastButtonByLabel(label: string): HTMLButtonElement | null {
  return Array.from(document.body.querySelectorAll('button'))
    .filter((button) => button.getAttribute('aria-label') === label || button.textContent?.includes(label))
    .at(-1) ?? null
}

type PaneOverrides = Omit<Partial<React.ComponentProps<typeof LiveSessionPane>>, 'authStateCapture'>
  & { authStateCapture?: Partial<LiveModeAuthStateCaptureConfig> | null }
  & Record<string, unknown>

function renderPane(overrides: PaneOverrides = {}) {
  const authStateCapture = {
    sessionId: 'session-1',
    targetName: 'staging-web',
    initialName: null,
    authStates: [] as AuthStateMetadata[],
    isSaving: false,
    error: null,
    onSave: vi.fn().mockResolvedValue(undefined),
    ...(overrides.authStateCapture ?? {}),
  }
  const paneOverrides = { liveSessionId: 's1', ...overrides, authStateCapture } as Record<string, unknown>

  act(() => {
    root.render(
      <TooltipProvider>
        <LiveSessionPane
          connectionState="connected"
          isLaunching={false}
          targetName="staging-web"
          targetLabel="https://staging.example.com"
          platform="web"
          currentUrl="https://staging.example.com/dashboard"
          pendingNavigation={null}
          steps={[]}
          setupHooks={[]}
          teardownHooks={[]}
          tests={[]}
          selection={null}
          runningStepId={null}
          terminalState={null}
          draftState="saved"
          ariaTree={null}
          errorMessage={null}
          devtoolsTab="reasoning"
          canRunAll={false}
          isRunningAll={false}
          isStoppingRunAll={false}
          onDevtoolsTabChange={vi.fn()}
          onRunAll={vi.fn()}
          onStopAll={vi.fn()}
          onEndSession={vi.fn()}
          onBack={vi.fn()}
          onForward={vi.fn()}
          onRefresh={vi.fn()}
          onNavigate={vi.fn()}
          onRequestAriaTree={vi.fn()}
          {...(paneOverrides as any)}
        />
      </TooltipProvider>,
    )
  })

  return authStateCapture
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** A frame report from the preview's own embed: the one source the preview listens to. */
async function postFrame(): Promise<void> {
  const embed = container.querySelector<HTMLIFrameElement>('[data-live-preview] [data-live-embed]')
  if (embed?.contentWindow == null) throw new Error('Expected the preview embed')
  const data = { event: 'frame', ts: Date.now(), kind: 'cdp-screencast', width: 800, height: 600 }
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { data, source: embed.contentWindow }))
    await Promise.resolve()
  })
}

beforeEach(() => {
  fetchEditorLiveUrlMock.mockReset()
  fetchEditorLiveUrlMock.mockImplementation(async (sessionId: string) => ({
    liveUrl: `http://x/live/${sessionId}#v2.e.b`,
    expiresAt: Date.now() + 300_000,
    stream: { kind: 'cdp-screencast' },
  }))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.stubGlobal('navigator', {
    ...navigator,
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  })
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  vi.unstubAllGlobals()
})

describe('LiveSessionPane auth-state capture control', () => {
  it('renders a Save auth state split button for connected web sessions', () => {
    renderPane()

    expect(buttonByLabel('Save auth state')).not.toBeNull()
    expect(buttonByLabel('Open auth state save form')).not.toBeNull()
    expect(document.body.textContent).not.toContain('.agent-qa/auth-states')
    expect(document.body.textContent).not.toContain('cookies')
    expect(document.body.textContent).not.toContain('localStorage')
    expect(document.body.textContent).not.toContain('IndexedDB')
  })

  it('opens the same form from both split-button segments', () => {
    renderPane()

    click(buttonByLabel('Save auth state'))
    expect(document.body.textContent).toContain('Capture the current browser session for this target.')
    expect(document.body.textContent).toContain('Target')
    expect(document.body.textContent).toContain('staging-web')

    act(() => {
      root.unmount()
      root = createRoot(container)
    })
    renderPane()
    click(buttonByLabel('Open auth state save form'))
    expect(document.body.textContent).toContain('Capture the current browser session for this target.')
    expect(document.body.textContent).toContain('Auth state name')
  })

  it.each([
    ['idle', { connectionState: 'idle' }],
    ['terminal', { terminalState: { reason: 'ended', title: 'Ended', description: 'Done' } }],
    ['disconnected', { connectionState: 'disconnected' }],
    ['android', { platform: 'android', targetName: 'android-target', targetLabel: 'Android device' }],
    ['ios', { platform: 'ios', targetName: 'ios-target', targetLabel: 'iOS device' }],
  ] as const)('does not render the control for %s state', (_label, overrides) => {
    renderPane(overrides as Partial<React.ComponentProps<typeof LiveSessionPane>>)

    expect(buttonByLabel('Save auth state')).toBeNull()
  })

  it('disables the control while executing and re-enables when connected', () => {
    renderPane({ connectionState: 'executing' })

    expect(buttonByLabel('Save auth state')?.disabled).toBe(true)
    expect(buttonByLabel('Open auth state save form')?.disabled).toBe(true)

    act(() => {
      root.unmount()
      root = createRoot(container)
    })
    renderPane({ connectionState: 'connected' })

    expect(buttonByLabel('Save auth state')?.disabled).toBe(false)
    expect(buttonByLabel('Open auth state save form')?.disabled).toBe(false)
  })

  it('uses a valid draft prefill and suppresses invalid draft values', () => {
    renderPane({ authStateCapture: { initialName: 'admin' } })
    click(buttonByLabel('Save auth state'))
    expect((document.body.querySelector('input[name="authStateName"]') as HTMLInputElement).value).toBe('admin')

    act(() => {
      root.unmount()
      root = createRoot(container)
    })
    renderPane({ authStateCapture: { initialName: '../admin.json' } })
    click(buttonByLabel('Save auth state'))
    expect((document.body.querySelector('input[name="authStateName"]') as HTMLInputElement).value).toBe('')
    expect(document.body.textContent).not.toContain('../admin.json')
  })

  it('switches to replace mode when the typed name already exists for the target', () => {
    renderPane({
      authStateCapture: {
        initialName: 'admin',
        authStates: [existingAdminState],
      },
    })

    click(buttonByLabel('Save auth state'))

    expect(document.body.textContent).toContain('Existing auth state will be replaced.')
    expect(lastButtonByLabel('Replace auth state')).not.toBeNull()
  })

  it('keeps create mode for new names', () => {
    renderPane({
      authStateCapture: {
        initialName: 'new-admin',
        authStates: [existingAdminState],
      },
    })

    click(buttonByLabel('Save auth state'))

    expect(document.body.textContent).not.toContain('Existing auth state will be replaced.')
    expect(lastButtonByLabel('Save auth state')).not.toBeNull()
  })

  it('validates names and submits name plus replace only', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    renderPane({
      authStateCapture: {
        initialName: 'admin',
        authStates: [existingAdminState],
        onSave,
      },
    })

    click(buttonByLabel('Save auth state'))
    const input = document.body.querySelector('input[name="authStateName"]') as HTMLInputElement
    changeInput(input, 'Admin')
    click(lastButtonByLabel('Save auth state'))
    expect(document.body.textContent).toContain('Auth state name must be a lowercase slug.')
    expect(onSave).not.toHaveBeenCalled()

    changeInput(input, 'admin')
    click(lastButtonByLabel('Replace auth state'))
    await Promise.resolve()

    expect(onSave).toHaveBeenCalledWith({ name: 'admin', replace: true })
    expect(JSON.stringify(onSave.mock.calls[0][0])).not.toContain('target')
    expect(JSON.stringify(onSave.mock.calls[0][0])).not.toContain('path')
  })
})

// THE EDITOR'S LIVE HEADER, JUST THE ESSENTIALS (428 D-05). Owner: "what if we drop everything.
// I am a fan of minimal things. Just a dot maybe." The header keeps the target name, the draft
// badge, Run All / Stop All and End Live Session. The connection badge, the session number, the
// running label, the URL line under the title and the "Restart required" badge are gone; the
// hooks-changed banner and the error text are each said once, only when they apply. Health is the
// preview dot's alone, so the header carries no status dot of its own.
const STATUS_WORDS = /^(Ready|Connecting|Connected|Executing|Disconnected|Error|Ended)$/i

function statusWordElements(scope: Element): Element[] {
  return [...scope.querySelectorAll('*')].filter((element) => STATUS_WORDS.test(element.textContent?.trim() ?? ''))
}

function header(): HTMLElement {
  const element = container.querySelector<HTMLElement>('[data-live-header]')
  if (!element) throw new Error('Expected the live header')
  return element
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

describe('LiveSessionPane live header', () => {
  it('EDITOR-HEADER-MINIMAL: the target, the draft badge and the actions, and nothing about the connection', () => {
    renderPane({
      draftState: 'unsaved',
      liveSessionNumber: 3,
      runningStepId: 'step-missing',
      canRunAll: true,
      showEndSessionAction: true,
    })

    const text = header().textContent ?? ''
    expect(text).toContain('staging-web')
    expect(text).toContain('Using unsaved draft')
    expect(text).toContain('Run All Steps')
    expect(text).toContain('End Live Session')
    expect(text).not.toContain('Session #')
    expect(text).not.toMatch(/Running (step|current)/)
    expect(statusWordElements(header())).toHaveLength(0)
    expect(text).not.toContain('Restart required')
    const urlLines = [...header().querySelectorAll('span, div')].filter(
      (element) => element.textContent?.trim() === 'https://staging.example.com/dashboard',
    )
    expect(urlLines).toHaveLength(0)

    act(() => {
      root.unmount()
      root = createRoot(container)
    })
    renderPane({ isRunningAll: true, connectionState: 'executing', showEndSessionAction: true })
    const running = header().textContent ?? ''
    expect(running).toContain('Stop All Steps')
    expect(statusWordElements(header())).toHaveLength(0)
  })

  it('EDITOR-HEADER-MINIMAL: the hooks-changed banner and the error text are each said once, only when they apply', () => {
    renderPane()
    expect(container.textContent).not.toContain('Hook order or names changed')

    act(() => {
      root.unmount()
      root = createRoot(container)
    })
    renderPane({ setupHooksStale: true, errorMessage: 'The browser went away' })

    const text = container.textContent ?? ''
    expect(occurrences(text, 'Hook order or names changed')).toBe(1)
    expect(occurrences(text, 'The browser went away')).toBe(1)
    expect(text).not.toContain('Restart required')
  })

  it.each(['idle', 'connecting', 'connected', 'executing', 'disconnected', 'error'] as const)(
    'EDITOR-HEADER-NO-STATUS-DOT: a %s pane header carries no pulsing or emerald status mark',
    (connectionState) => {
      renderPane({ connectionState })

      const marks = [...header().querySelectorAll('*')].filter((element) => {
        const className = element.getAttribute('class') ?? ''
        return className.includes('animate-pulse') || className.includes('bg-emerald')
      })
      expect(marks).toHaveLength(0)
      expect(statusWordElements(header())).toHaveLength(0)
    },
  )
})

// THE EDITOR WATCHES THROUGH THE ONE SHARED PREVIEW (428 PXH-LIVE-01, D-02, D-07). Test → Live
// renders `LivePreview` with an editor subject where the image-polling viewer used to be, and the
// editor's navigation and auth-state controls sit in the preview's chrome row, which renders only
// when it has something to hold.
describe('LiveSessionPane shared live preview', () => {
  it('EDITOR-RENDERS-SHARED-PREVIEW: a connected pane renders the editor subject\'s one embed and no live image', async () => {
    renderPane()
    await flush()

    expect(fetchEditorLiveUrlMock).toHaveBeenCalledWith('s1')
    const preview = container.querySelector('[data-live-preview][data-preview-subject="editor"]')
    expect(preview).not.toBeNull()
    const embeds = [...(preview?.querySelectorAll('[data-live-embed]') ?? [])]
    expect(embeds).toHaveLength(1)
    expect(embeds[0]?.tagName).toBe('IFRAME')
    expect(embeds[0]?.getAttribute('src')).toContain('/live/s1?host=dashboard#')
    expect(container.querySelectorAll('img')).toHaveLength(0)
  })

  it('EDITOR-RENDERS-SHARED-PREVIEW: the terminal card and the idle explainer stay the editor\'s own', async () => {
    renderPane({ terminalState: { reason: 'ended', title: 'Session ended', description: 'Done' } })
    await flush()
    expect(container.textContent).toContain('Session ended')
    expect(container.querySelector('[data-live-preview]')).toBeNull()

    act(() => {
      root.unmount()
      root = createRoot(container)
    })
    renderPane({ connectionState: 'idle', liveSessionId: null })
    await flush()
    expect(container.textContent).toContain('Live mode is target-scoped')
    expect(container.querySelector('[data-live-preview]')).toBeNull()
  })

  // RE-SPELLED 2026-09-26 (428-34, owner decision 2026-09-26 (4), G-428-4). Was "EDITOR-CHROME-ROW:
  // a web session's navigation, address bar, auth-state capture and copy URL are the chrome row".
  // The preview's status now leads that row at the container's top-left, so after a frame the dot
  // comes first and the editor's toolbar follows it in the same row.
  //
  // RE-SPELLED 2026-09-26 (owner decision 2026-09-26 (6)): the dot left the row for the preview's
  // top-right corner, so after a frame the toolbar still leads the row and the dot is not in it.
  it('EDITOR-CHROME-ROW: a web session\'s toolbar is the chrome row, and after a frame the dot sits outside it', async () => {
    renderPane()
    await flush()

    const chrome = container.querySelector('[data-live-preview] [data-preview-chrome]')
    expect(chrome).not.toBeNull()
    const labels = [...(chrome?.querySelectorAll('button') ?? [])].map(
      (button) => button.getAttribute('aria-label') ?? button.textContent?.trim(),
    )
    expect(labels).toEqual(expect.arrayContaining(['Go back', 'Go forward', 'Refresh page', 'Save auth state', 'Copy URL']))
    expect(chrome?.querySelectorAll('input')).toHaveLength(1)
    expect(header().querySelector('input')).toBeNull()

    await postFrame()
    const row = container.querySelector('[data-live-preview] [data-preview-chrome]')
    const children = [...(row?.children ?? [])]
    const toolbarAt = children.findIndex((child) => child.querySelector('[aria-label="Go back"]') !== null)
    expect({
      dotInRow: row?.querySelector('[data-live-dot]') ?? null,
      dot: container.querySelector('[data-preview-dot-corner] [data-live-dot]')?.getAttribute('data-live-dot') ?? null,
      toolbarAt,
      inputs: row?.querySelectorAll('input').length,
    }).toEqual({ dotInRow: null, dot: 'green', toolbarAt: 0, inputs: 1 })
    expect(header().querySelector('[data-live-dot]')).toBeNull()
  })

  // RE-SPELLED 2026-09-26 (428-34, owner decision 2026-09-26 (4), G-428-4). Was "EDITOR-CHROME-ROW:
  // a mobile session without those controls renders no empty chrome row", read before any frame.
  // A mobile session still passes no toolbar, so before its preview has anything to say there is no
  // row, and once a frame arrives the row holds the dot and nothing of the web toolbar.
  //
  // RE-SPELLED 2026-09-26 (owner decision 2026-09-26 (6)): the dot never makes a row, so after a
  // frame a mobile session still has none and the dot floats in the preview's top-right corner.
  it('EDITOR-CHROME-ROW: a mobile session has no row before or after its first frame, and the dot floats in its corner', async () => {
    const mobile = { platform: 'android', targetName: 'android-target', targetLabel: 'Android device' } as const
    fetchEditorLiveUrlMock.mockImplementationOnce(() => new Promise<never>(() => {}))
    renderPane(mobile)
    await flush()
    expect(container.querySelector('[data-live-preview]')).not.toBeNull()
    expect(container.querySelector('[data-preview-chrome]')).toBeNull()

    act(() => {
      root.unmount()
      root = createRoot(container)
    })
    renderPane(mobile)
    await flush()
    await postFrame()
    expect({
      row: container.querySelector('[data-live-preview] [data-preview-chrome]'),
      dot: container.querySelector('[data-preview-dot-corner] [data-live-dot]')?.getAttribute('data-live-dot') ?? null,
    }).toEqual({ row: null, dot: 'green' })
  })
})

