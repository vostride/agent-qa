// @vitest-environment jsdom

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SuiteNavbar } from '@/components/suite-navbar'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/split-button', () => ({
  SplitButton: ({ label, disabled, onRun }: { label: string; disabled?: boolean; onRun: (l: boolean) => void }) => (
    <button
      data-testid="split-button"
      data-disabled={disabled ? 'true' : 'false'}
      disabled={disabled}
      onClick={() => onRun(true)}
    >
      {label}
    </button>
  ),
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactElement }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactElement }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactElement }) => <div data-testid="tooltip-content">{children}</div>,
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: ReactElement }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: ReactElement }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactElement }) => <div>{children}</div>,
}))

let container: HTMLDivElement
let root: Root

const shortSuiteId = 's_able-acre'

const baseProps = {
  suiteName: 'Smoke Suite',
  suiteId: shortSuiteId,
  unsaved: false,
  isCreateMode: false,
  mode: 'edit' as const,
  isSaving: false,
  isValidating: false,
  isRunning: false,
  hasInvalidFilename: false,
  shortcutsOpen: false,
  onBack: vi.fn(),
  onSave: vi.fn(),
  onValidate: vi.fn(),
  onRun: vi.fn(),
  onSettingsOpen: vi.fn(),
  onToggleShortcuts: vi.fn(),
}

function mount(el: ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => { root.render(<MemoryRouter>{el}</MemoryRouter>) })
}

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

describe('SuiteNavbar live mode', () => {
  it('does NOT render live button group when onLiveConnect and onLiveEnd are absent', () => {
    mount(<SuiteNavbar {...baseProps} />)
    expect(container.textContent).not.toContain('Connect Live Session')
    expect(container.textContent).not.toContain('End Live Session')
    expect(container.textContent).not.toContain('Connecting')
  })

  // D-15
  it('renders Connect Live Session button with PlayCircle icon when liveConnectionState=idle', () => {
    mount(
      <SuiteNavbar
        {...baseProps}
        liveConnectionState="idle"
        onLiveConnect={vi.fn()}
      />
    )
    expect(container.textContent).toContain('Connect Live Session')
    // PlayCircle should have h-3.5 w-3.5 class (UI-SPEC Interaction State Table)
    const connectBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Connect Live Session'),
    )
    expect(connectBtn).toBeTruthy()
    // PlayCircle icon (lucide-react) renders as an SVG
    expect(connectBtn!.querySelector('svg')).toBeTruthy()
  })

  // D-15
  it('renders "Connecting..." with spinner when liveConnectionState=connecting', () => {
    mount(
      <SuiteNavbar
        {...baseProps}
        liveConnectionState="connecting"
        onLiveConnect={vi.fn()}
      />
    )
    expect(container.textContent).toContain('Connecting...')
    // Loader2 renders with animate-spin
    const spinner = container.querySelector('.animate-spin')
    expect(spinner).toBeTruthy()
  })

  // D-15
  it('renders End Live Session destructive button when hasLiveSession && liveConnectionState=connected', () => {
    mount(
      <SuiteNavbar
        {...baseProps}
        hasLiveSession
        liveConnectionState="connected"
        onLiveEnd={vi.fn()}
      />
    )
    const endBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('End Live Session'),
    )
    expect(endBtn).toBeTruthy()
  })

  // D-15
  it('renders End Live Session when liveConnectionState=executing', () => {
    mount(
      <SuiteNavbar
        {...baseProps}
        hasLiveSession
        liveConnectionState="executing"
        onLiveEnd={vi.fn()}
      />
    )
    const endBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('End Live Session'),
    )
    expect(endBtn).toBeTruthy()
  })

  it('disables Connect when isLiveActionDisabled=true', () => {
    mount(
      <SuiteNavbar
        {...baseProps}
        liveConnectionState="idle"
        isLiveActionDisabled
        onLiveConnect={vi.fn()}
      />
    )
    const connectBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Connect Live Session'),
    )
    expect(connectBtn).toBeTruthy()
    expect((connectBtn as HTMLButtonElement).disabled).toBe(true)
  })

  // D-31
  it('renders Session #3 badge when hasLiveSession && typeof liveSessionNumber === "number"', () => {
    mount(
      <SuiteNavbar
        {...baseProps}
        hasLiveSession
        liveConnectionState="connected"
        liveSessionNumber={3}
        onLiveEnd={vi.fn()}
      />
    )
    expect(container.textContent).toContain('Session #3')
  })

  it('does NOT render Session badge when hasLiveSession=false', () => {
    mount(
      <SuiteNavbar
        {...baseProps}
        hasLiveSession={false}
        liveConnectionState="idle"
        liveSessionNumber={3}
        onLiveConnect={vi.fn()}
      />
    )
    expect(container.textContent).not.toContain('Session #')
  })

  it('does NOT render Session badge when liveConnectionState=connecting (per UI-SPEC)', () => {
    mount(
      <SuiteNavbar
        {...baseProps}
        hasLiveSession
        liveConnectionState="connecting"
        liveSessionNumber={3}
        onLiveConnect={vi.fn()}
      />
    )
    expect(container.textContent).not.toContain('Session #')
  })

  // UI-SPEC Color §Accent NOT used for Session badge
  it('Session badge uses neutral classes bg-muted/50 text-muted-foreground', () => {
    mount(
      <SuiteNavbar
        {...baseProps}
        hasLiveSession
        liveConnectionState="connected"
        liveSessionNumber={7}
        onLiveEnd={vi.fn()}
      />
    )
    const badge = Array.from(container.querySelectorAll('*')).find((el) =>
      el.textContent?.trim() === 'Session #7',
    )
    expect(badge).toBeTruthy()
    // The badge itself (or a close ancestor) should carry the neutral classes.
    // We search up through parents for a className containing the tokens.
    let probe: Element | null = badge as Element
    let foundMuted = false
    let foundTracking = false
    for (let i = 0; i < 5 && probe; i += 1) {
      const cls = probe.getAttribute('class') ?? ''
      if (cls.includes('text-muted-foreground') && cls.includes('bg-muted/50')) foundMuted = true
      if (cls.includes('text-[10px]') && cls.includes('tracking-wider')) foundTracking = true
      probe = probe.parentElement
    }
    expect(foundMuted).toBe(true)
    expect(foundTracking).toBe(true)
  })

  // D-16
  it('Run Suite split button becomes disabled when hasLiveSession=true', () => {
    mount(
      <SuiteNavbar
        {...baseProps}
        hasLiveSession
        liveConnectionState="connected"
        onLiveEnd={vi.fn()}
      />
    )
    const splitBtn = container.querySelector('[data-testid="split-button"]')
    expect(splitBtn).toBeTruthy()
    expect(splitBtn!.getAttribute('data-disabled')).toBe('true')
  })

  // D-16
  it('Run Suite tooltip reads "End the live session to queue a new suite run." when disabled due to live session', () => {
    mount(
      <SuiteNavbar
        {...baseProps}
        hasLiveSession
        liveConnectionState="connected"
        onLiveEnd={vi.fn()}
      />
    )
    expect(container.textContent).toContain('End the live session to queue a new suite run.')
  })
})
