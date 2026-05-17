// @vitest-environment jsdom

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LiveSessionPane } from '@/components/live-session-pane'
import type { LiveModeAuthStateCaptureConfig } from '@/components/live-mode-auth-state-control'
import type { AuthStateMetadata } from '@/lib/api'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/editor/editor-step-detail', () => ({
  EditorStepDetail: ({ step }: { step: { name?: string } }) => <div data-testid="step-detail">{step.name}</div>,
}))

vi.mock('@/components/editor/aria-panel', () => ({
  EditorAriaPanel: () => <div data-testid="aria-panel" />,
}))

vi.mock('@/components/editor/screencast-viewer', () => ({
  ScreencastViewer: () => <div data-testid="screencast-viewer" />,
}))

vi.mock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children }: { children: ReactElement | ReactElement[] }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: ReactElement | ReactElement[] }) => <div>{children}</div>,
  ResizableHandle: () => <div data-testid="resizable-handle" />,
}))

let container: HTMLDivElement
let root: Root

const existingAdminState: AuthStateMetadata = {
  version: 1,
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
  const paneOverrides = { ...overrides, authStateCapture } as Record<string, unknown>

  act(() => {
    root.render(
      <LiveSessionPane
        connectionState="connected"
        isLaunching={false}
        targetName="staging-web"
        targetLabel="https://staging.example.com"
        platform="web"
        screenshot={null}
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
      />,
    )
  })

  return authStateCapture
}

beforeEach(() => {
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
