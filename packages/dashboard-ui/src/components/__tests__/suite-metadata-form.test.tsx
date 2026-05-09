// @vitest-environment jsdom

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SuiteMetadataForm } from '@/components/suite-metadata-form'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/hooks/use-targets', () => ({
  useTargets: () => ({ targets: ['dashboard', 'mobile-app'], isLoading: false }),
}))

vi.mock('@/hooks/use-target-details', () => ({
  useTargetDetails: () => ({
    targets: {
      dashboard: { platform: 'web' as const, url: 'https://example.com' },
      'mobile-app': { platform: 'android' as const, appPackage: 'com.example.app' },
    },
    globalUse: null,
    isLoading: false,
  }),
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactElement }) => children,
  TooltipTrigger: ({ children }: { children: ReactElement }) => children,
  TooltipContent: ({ children }: { children: ReactElement }) => children,
}))

vi.mock('@/components/step-autocomplete', () => ({
  useStepAutocomplete: () => ({
    visible: false,
    setVisible: () => {},
    handleKeyDown: () => false,
    dropdown: null,
  }),
}))

vi.mock('@/components/ui/select', () => ({
  Select: ({ children, value }: { children: ReactElement; value?: string }) => (
    <div data-testid="select" data-value={value ?? ''}>{children}</div>
  ),
  SelectTrigger: ({ children, id, className }: { children: ReactElement; id?: string; className?: string }) => (
    <button id={id} className={className} type="button">{children}</button>
  ),
  SelectValue: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
  SelectContent: ({ children }: { children: ReactElement }) => <div>{children}</div>,
  SelectItem: ({ children, value }: { children: ReactElement; value: string }) => (
    <div data-value={value}>{children}</div>
  ),
}))

let container: HTMLDivElement
let root: Root

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

const baseSuggestions = [
  { namespace: 'env', name: 'API_URL', label: 'env' },
  { namespace: 'runHook', name: 'login', label: 'hook' },
]

describe('SuiteMetadataForm', () => {
  it('renders inline suite-id with regenerate icon in create mode', () => {
    const onChange = vi.fn()
    mount(
      <SuiteMetadataForm
        name="My Suite"
        suiteId="s_able-acre"
        target=""
        context=""
        isCreateMode
        suggestions={baseSuggestions}
        onChange={onChange}
      />,
    )
    expect(container.textContent).toContain('Suite ID')
    const regen = container.querySelector('[aria-label="Generate new ID"]')
    expect(regen).not.toBeNull()
  })

  it('renders plain text suite-id in edit mode (no regenerate)', () => {
    mount(
      <SuiteMetadataForm
        name="My Suite"
        suiteId="s_blue-bolt"
        target="dashboard"
        context=""
        isCreateMode={false}
        suggestions={baseSuggestions}
        onChange={vi.fn()}
      />,
    )
    expect(container.textContent).toContain('s_blue-bolt')
    expect(container.querySelector('[aria-label="Generate new ID"]')).toBeNull()
  })

  it('renders pill preview when context contains {{env:...}}', () => {
    mount(
      <SuiteMetadataForm
        name="X"
        suiteId="s_a"
        target="dashboard"
        context="Use {{env:API_URL}} for the base URL"
        isCreateMode={false}
        suggestions={baseSuggestions}
        onChange={vi.fn()}
      />,
    )
    // StepPillPreview renders the varName inside a pill span
    expect(container.textContent).toContain('API_URL')
    // The pill span uses rounded-sm class per step-pill-preview
    expect(container.querySelector('span.rounded-sm')).not.toBeNull()
  })

  it('renders readable hook names for runHook context pills when hook labels are available', () => {
    const HOOK_ID = 'h_web-cran-thon-driver-token-sla-gra-stum-resent-vod'

    mount(
      <SuiteMetadataForm
        name="X"
        suiteId="s_a"
        target="dashboard"
        context={`Run {{runHook:"${HOOK_ID}"}} before every test`}
        isCreateMode={false}
        suggestions={baseSuggestions}
        hookLabels={{ [HOOK_ID]: 'Seed Auth' }}
        onChange={vi.fn()}
      />,
    )

    const pill = container.querySelector('span[aria-label="variable: Seed Auth"]')
    expect(pill).not.toBeNull()
    expect(pill?.textContent).toBe('Seed Auth')
  })

  it('does not render pill preview when context has no template vars', () => {
    mount(
      <SuiteMetadataForm
        name="X"
        suiteId="s_a"
        target="dashboard"
        context="plain text"
        isCreateMode={false}
        suggestions={baseSuggestions}
        onChange={vi.fn()}
      />,
    )
    // No segments with pill role -> no rounded-sm pill spans
    expect(container.querySelectorAll('span[aria-label^="variable:"]').length).toBe(0)
  })

  it('renders target-detail caption with platform label + URL for web target', () => {
    mount(
      <SuiteMetadataForm
        name="X"
        suiteId="s_a"
        target="dashboard"
        context=""
        isCreateMode={false}
        suggestions={baseSuggestions}
        onChange={vi.fn()}
      />,
    )
    expect(container.textContent).toContain('web')
    expect(container.textContent).toContain('https://example.com')
  })

  it('renders Suite Name, Suite ID, Target, Context labels and required asterisks', () => {
    mount(
      <SuiteMetadataForm
        name="X"
        suiteId="s_a"
        target="dashboard"
        context=""
        isCreateMode
        suggestions={baseSuggestions}
        onChange={vi.fn()}
      />,
    )
    expect(container.textContent).toContain('Suite Name')
    expect(container.textContent).toContain('Suite ID')
    expect(container.textContent).toContain('Target')
    expect(container.textContent).toContain('Context')
    // Two required fields (Suite Name + Target) → two asterisks
    const asterisks = container.querySelectorAll('span.text-destructive')
    expect(asterisks.length).toBeGreaterThanOrEqual(2)
  })

  it('accepts filtered suggestions prop (caller filters capture: per D-18)', () => {
    const onChange = vi.fn()
    // Passing a pre-filtered list (no capture: namespace) — the caller's responsibility.
    mount(
      <SuiteMetadataForm
        name="X"
        suiteId="s_a"
        target="dashboard"
        context=""
        isCreateMode
        suggestions={baseSuggestions}
        onChange={onChange}
      />,
    )
    // Contract: SuiteMetadataForm renders without crashing given a filtered list.
    // Filter enforcement is covered in suite-visual-builder.hooks.test.tsx (Wave 3).
    expect(container).not.toBeNull()
  })

  // Gap 5 regression — suite-id regenerate button positioned INSIDE the input's right edge
  it('positions the regenerate button inside the suite-id input with absolute positioning (Gap 5)', () => {
    const onChange = vi.fn()
    mount(
      <SuiteMetadataForm
        name=""
        suiteId="s_initial-test-id-here"
        target=""
        context=""
        isCreateMode
        suggestions={[]}
        onChange={onChange}
      />,
    )
    const input = container.querySelector('#suite-id') as HTMLInputElement | null
    expect(input).not.toBeNull()
    // Input has pr-9 to reserve space for the inside-right button so text doesn't overlap
    expect(input!.className).toContain('pr-9')
    // Legacy flex-1 class is gone now that the parent is a relative-positioned container
    expect(input!.className).not.toContain('flex-1')
    // Parent is a relative-positioned container (positioning anchor for the absolute button)
    const parent = input!.parentElement
    expect(parent).not.toBeNull()
    expect(parent!.className).toContain('relative')
    // Parent no longer uses the old flex-gap sibling layout
    expect(parent!.className).not.toMatch(/\bflex\s+items-center\s+gap-2\b/)
    // Regenerate button is absolutely positioned at the right edge, vertically centered
    const btn = container.querySelector(
      'button[aria-label="Generate new ID"]',
    ) as HTMLButtonElement | null
    expect(btn).not.toBeNull()
    expect(btn!.className).toContain('absolute')
    expect(btn!.className).toContain('right-1')
    expect(btn!.className).toMatch(/-translate-y-1\/2/)
    // Button sized down from icon-sm default so it fits cleanly inside an h-8 input
    expect(btn!.className).toContain('h-6')
    expect(btn!.className).toContain('w-6')
    // The button is a child of the same relative container as the Input
    expect(btn!.parentElement).toBe(parent)
  })
})
