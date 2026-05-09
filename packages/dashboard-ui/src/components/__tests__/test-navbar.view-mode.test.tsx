// @vitest-environment jsdom

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TestNavbar } from '@/components/test-navbar'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/split-button', () => ({
  SplitButton: ({
    label,
    onRun,
    shortcutKey,
  }: {
    label: string
    onRun: (local: boolean) => void
    shortcutKey?: string
  }) => (
    <button data-testid="split-button" onClick={() => onRun(true)}>
      {label}
      {shortcutKey ? <span data-testid="split-button-shortcut">{shortcutKey}</span> : null}
    </button>
  ),
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactElement }) => children,
  TooltipTrigger: ({ children }: { children: ReactElement }) => children,
  TooltipContent: ({ children }: { children: ReactElement }) => <>{children}</>,
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: ReactElement }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: ReactElement }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactElement }) => <div>{children}</div>,
}))

let container: HTMLDivElement
let root: Root

const baseProps = {
  testName: 'Viewer Test',
  testId: 't_view-123',
  unsaved: false,
  isCreateMode: false,
  mode: 'view' as const,
  testHref: '/test/t_view-123/edit',
  isSaving: false,
  isValidating: false,
  isRunning: false,
  hasInvalidFilename: false,
  shortcutsOpen: true,
  showTestId: true,
  onBack: vi.fn(),
  onSave: vi.fn(),
  onValidate: vi.fn(),
  onRun: vi.fn(),
  onLiveConnect: vi.fn(),
  onSettingsOpen: vi.fn(),
  onToggleShortcuts: vi.fn(),
}

function mount(el: ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(<MemoryRouter>{el}</MemoryRouter>)
  })
}

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.clearAllMocks()
})

describe('TestNavbar view mode contract', () => {
  it('renders only view-mode actions and viewer shortcut hints', () => {
    mount(<TestNavbar {...baseProps} />)

    expect(container.textContent).toContain('Edit')
    expect(container.textContent).toContain('Run')
    expect(container.textContent).toContain('Connect Live Session')
    expect(container.textContent).toContain('Shortcuts')

    expect(container.textContent).not.toContain('Save')
    expect(container.textContent).not.toContain('Validate')
    expect(container.textContent).not.toContain('Settings')
    expect(container.textContent).not.toContain('t_view-123')

    expect(container.textContent).toContain('E')
    expect(container.textContent).toContain('Edit')
    expect(container.textContent).toContain('R')
    expect(container.textContent).toContain('Run')
    expect(container.textContent).toContain('L')
    expect(container.textContent).toContain('Connect Live Session')
    expect(container.textContent).not.toContain('Cmd+S')
    expect(container.textContent).not.toContain('Run test')

    const runButton = container.querySelector('[data-testid="split-button"]')
    expect(runButton?.textContent).toContain('RunR')
  })
})
