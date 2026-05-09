// @vitest-environment jsdom

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TestNavbar } from '@/components/test-navbar'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/split-button', () => ({
  SplitButton: ({ label, onRun }: { label: string; onRun: (l: boolean) => void }) => (
    <button data-testid="split-button" onClick={() => onRun(true)}>{label}</button>
  ),
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactElement }) => children,
  TooltipTrigger: ({ children }: { children: ReactElement }) => children,
  TooltipContent: ({ children }: { children: ReactElement }) => children,
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: ReactElement }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: ReactElement }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactElement }) => <div>{children}</div>,
}))

let container: HTMLDivElement
let root: Root

const baseProps = {
  testName: 'My Test',
  testId: 't_some-id',
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

function findSessionBadge(): HTMLElement | null {
  return Array.from(container.querySelectorAll('*')).find((el) => {
    const txt = el.textContent?.trim() ?? ''
    return /^Session #\d+$/.test(txt) && el.children.length === 0
  }) as HTMLElement | null
}

describe('TestNavbar Session #N badge (D-33 retrofit)', () => {
  it('renders Session #N badge when hasLiveSession=true, liveConnectionState=connected, and liveSessionNumber is a number', () => {
    mount(
      <TestNavbar
        {...baseProps}
        hasLiveSession
        liveConnectionState="connected"
        liveSessionNumber={3}
        onLiveConnect={vi.fn()}
        onLiveEnd={vi.fn()}
      />,
    )
    expect(container.textContent).toContain('Session #3')
    const badge = findSessionBadge()
    expect(badge).not.toBeNull()
  })

  it('renders Session #N badge during executing state', () => {
    mount(
      <TestNavbar
        {...baseProps}
        hasLiveSession
        liveConnectionState="executing"
        liveSessionNumber={7}
        onLiveConnect={vi.fn()}
        onLiveEnd={vi.fn()}
      />,
    )
    expect(container.textContent).toContain('Session #7')
  })

  it('does NOT render Session badge when hasLiveSession=false', () => {
    mount(
      <TestNavbar
        {...baseProps}
        hasLiveSession={false}
        liveSessionNumber={3}
      />,
    )
    expect(container.textContent).not.toContain('Session #')
  })

  it('does NOT render Session badge when liveSessionNumber is null or undefined', () => {
    mount(
      <TestNavbar
        {...baseProps}
        hasLiveSession
        liveConnectionState="connected"
        liveSessionNumber={null}
        onLiveConnect={vi.fn()}
        onLiveEnd={vi.fn()}
      />,
    )
    expect(container.textContent).not.toContain('Session #')
  })

  it('Session badge carries neutral-token classes (text-[10px] tracking-wider font-medium text-muted-foreground bg-muted/50 border-border/50) and aria-live="polite"', () => {
    mount(
      <TestNavbar
        {...baseProps}
        hasLiveSession
        liveConnectionState="connected"
        liveSessionNumber={5}
        onLiveConnect={vi.fn()}
        onLiveEnd={vi.fn()}
      />,
    )
    const badge = findSessionBadge()
    expect(badge).not.toBeNull()
    const className = badge!.className
    expect(className).toContain('text-[10px]')
    expect(className).toContain('tracking-wider')
    expect(className).toContain('font-medium')
    expect(className).toContain('text-muted-foreground')
    expect(className).toContain('bg-muted/50')
    expect(className).toContain('border-border/50')
    expect(badge!.getAttribute('aria-live')).toBe('polite')
  })

  it('Session badge renders AFTER the End Live Session button in DOM order', () => {
    mount(
      <TestNavbar
        {...baseProps}
        hasLiveSession
        liveConnectionState="connected"
        liveSessionNumber={2}
        onLiveConnect={vi.fn()}
        onLiveEnd={vi.fn()}
      />,
    )
    const buttons = Array.from(container.querySelectorAll('button'))
    const endButton = buttons.find((btn) => btn.textContent?.includes('End Live Session'))
    expect(endButton).toBeDefined()
    const badge = findSessionBadge()
    expect(badge).not.toBeNull()

    const endIndex = Array.prototype.indexOf.call(container.querySelectorAll('*'), endButton!)
    const badgeIndex = Array.prototype.indexOf.call(container.querySelectorAll('*'), badge!)
    expect(badgeIndex).toBeGreaterThan(endIndex)
  })

  it('does NOT render Session badge during connecting state', () => {
    mount(
      <TestNavbar
        {...baseProps}
        hasLiveSession={false}
        liveConnectionState="connecting"
        liveSessionNumber={1}
        onLiveConnect={vi.fn()}
      />,
    )
    expect(container.textContent).not.toContain('Session #')
  })
})
