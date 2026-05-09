// @vitest-environment jsdom

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SuiteNavbar } from '@/components/suite-navbar'

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

describe('SuiteNavbar', () => {
  it('renders Suites breadcrumb and edit crumb in edit mode', () => {
    mount(<SuiteNavbar {...baseProps} />)
    expect(container.textContent).toContain('Suites')
    expect(container.textContent).toContain('Smoke Suite')
    expect(container.textContent).toContain('Edit')
  })

  it('renders New Suite label in create mode', () => {
    mount(<SuiteNavbar {...baseProps} isCreateMode suiteId="" />)
    expect(container.textContent).toContain('New Suite')
    expect(container.textContent).not.toContain('Edit')
  })

  it('renders IdBadge with label="S" when not in create mode', () => {
    mount(<SuiteNavbar {...baseProps} />)
    expect(container.textContent).toContain('S:')
    expect(container.textContent).toContain(shortSuiteId)
  })

  it('shows Unsaved badge when unsaved=true', () => {
    mount(<SuiteNavbar {...baseProps} unsaved />)
    expect(container.textContent).toContain('Unsaved')
  })

  it('renders Validate, Save, Settings buttons', () => {
    mount(<SuiteNavbar {...baseProps} />)
    expect(container.textContent).toContain('Validate')
    expect(container.textContent).toContain('Save')
    expect(container.textContent).toContain('Settings')
  })

  it('renders Run Suite split button when not in create mode', () => {
    mount(<SuiteNavbar {...baseProps} />)
    const btn = container.querySelector('[data-testid="split-button"]')!
    expect(btn).not.toBeNull()
    expect(btn.textContent).toContain('Run Suite')
  })

  it('does NOT render Connect Live Session or End Live Session buttons', () => {
    mount(<SuiteNavbar {...baseProps} />)
    expect(container.textContent).not.toContain('Connect Live Session')
    expect(container.textContent).not.toContain('End Live Session')
    expect(container.textContent).not.toContain('Connecting')
  })

  it('Run label shows "Running..." during isRunning', () => {
    mount(<SuiteNavbar {...baseProps} isRunning />)
    const btn = container.querySelector('[data-testid="split-button"]')!
    expect(btn.textContent).toContain('Running...')
  })
})
