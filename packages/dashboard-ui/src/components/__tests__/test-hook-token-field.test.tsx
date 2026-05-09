// @vitest-environment jsdom

import { act, useState, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { VisualBuilder } from '@/components/visual-builder'
import type { LiveHookExecution } from '@/hooks/use-live-editor'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SETUP_ALPHA_ID = 'h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle'
const SETUP_BETA_ID = 'h_aster-bloom-cloud-drift-ember-field-glade-hollow-ivory-jasper'
const TEARDOWN_ALPHA_ID = 'h_canyon-dawn-elm-fjord-grove-harbor-ivory-jungle-kestrel-lantern'
const TEARDOWN_BETA_ID = 'h_cedar-drift-ember-forest-glacier-harbor-island-jetty-kelp-lotus'
const KNOWN_HOOK_ID = 'h_meadow-nova-orbit-prairie-quartz-river-summit-thicket-umbra-valley'
const UNKNOWN_HOOK_ID = 'h_willow-xenon-yarrow-zephyr-acorn-bramble-cinder-dahlia-everest-flint'

const {
  dndOnDragEnds,
  fetchHookCatalogMock,
} = vi.hoisted(() => ({
  dndOnDragEnds: [] as Array<((event: { active: { id: string }; over: { id: string } | null }) => void) | undefined>,
  fetchHookCatalogMock: vi.fn(),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')

  return {
    ...actual,
    fetchHookCatalog: fetchHookCatalogMock,
  }
})

vi.mock('@/components/test-metadata-form', () => ({
  TestMetadataForm: () => <div data-testid="metadata-form" />,
}))

let stepCardPropsById: Record<string, { value: string; hookLabels?: Record<string, string> }> = {}

vi.mock('@/components/step-card-editor', () => ({
  StepCardEditor: ({ id, value, hookLabels }: { id: string; value: string; hookLabels?: Record<string, string> }) => {
    stepCardPropsById[id] = { value, hookLabels }
    return <div data-testid={`step-card-${id}`}>{value}</div>
  },
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactElement }) => children,
  TooltipTrigger: ({ children }: { children: ReactElement }) => children,
  TooltipContent: ({ children }: { children: ReactElement }) => children,
}))

vi.mock('@dnd-kit/core', async () => {
  const React = await import('react')

  return {
    DndContext: ({
      children,
      onDragEnd,
    }: {
      children: ReactElement
      onDragEnd?: (event: { active: { id: string }; over: { id: string } | null }) => void
    }) => {
      const indexRef = React.useRef<number>(dndOnDragEnds.length)
      dndOnDragEnds[indexRef.current] = onDragEnd

      return <div data-dnd-context={String(indexRef.current)}>{children}</div>
    },
    closestCenter: () => null,
    PointerSensor: class PointerSensor {},
    KeyboardSensor: class KeyboardSensor {},
    useSensor: (...args: unknown[]) => ({ args }),
    useSensors: (...sensors: unknown[]) => sensors,
  }
})

vi.mock('@dnd-kit/sortable', async () => {
  const React = await import('react')

  function arrayMove<T>(items: T[], from: number, to: number): T[] {
    const next = [...items]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    return next
  }

  return {
    SortableContext: ({ children, items }: { children: ReactElement; items: string[] }) => (
      <div data-sortable-context={items.join(',')}>{children}</div>
    ),
    useSortable: ({ id }: { id: string }) => {
      const setNodeRef = React.useCallback(() => {}, [])

      return {
        attributes: { 'data-sortable-item': id },
        listeners: { 'data-sortable-handle': id },
        setNodeRef,
        transform: null,
        transition: undefined,
        isDragging: false,
      }
    },
    arrayMove,
    sortableKeyboardCoordinates: () => ({ x: 0, y: 0 }),
    verticalListSortingStrategy: {},
  }
})

const BASE_YAML = `name: Hook Builder
target: demo
context: Hook editing
setup:
  - ${SETUP_ALPHA_ID}
  - ${SETUP_BETA_ID}
steps:
  - Open the builder
teardown:
  - ${TEARDOWN_ALPHA_ID}
  - ${TEARDOWN_BETA_ID}
`

function Harness({
  initialContent = BASE_YAML,
  showLiveStepActions = false,
  canRunLiveHook = false,
  liveSetupHooks = [],
  liveTeardownHooks = [],
  disabled = false,
}: {
  initialContent?: string
  showLiveStepActions?: boolean
  canRunLiveHook?: boolean
  liveSetupHooks?: LiveHookExecution[]
  liveTeardownHooks?: LiveHookExecution[]
  disabled?: boolean
}) {
  const [content, setContent] = useState(initialContent)

  return (
    <div>
      <VisualBuilder
        content={content}
        onChange={setContent}
        disabled={disabled}
        showLiveStepActions={showLiveStepActions}
        canRunLiveHook={canRunLiveHook}
        liveSetupHooks={liveSetupHooks}
        liveTeardownHooks={liveTeardownHooks}
      />
      <pre data-testid="yaml-content">{content}</pre>
    </div>
  )
}

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  dndOnDragEnds.length = 0
  stepCardPropsById = {}
  fetchHookCatalogMock.mockReset()
  fetchHookCatalogMock.mockResolvedValue({
    hooks: [
      { id: SETUP_ALPHA_ID, name: 'setup.alpha', runtime: 'node', file: '/tmp/setup-alpha.js', timeout: 30_000, network: true },
      { id: SETUP_BETA_ID, name: 'setup.beta', runtime: 'node', file: '/tmp/setup-beta.js', timeout: 30_000, network: true },
      { id: TEARDOWN_ALPHA_ID, name: 'teardown.alpha', runtime: 'node', file: '/tmp/teardown-alpha.js', timeout: 30_000, network: true },
      { id: TEARDOWN_BETA_ID, name: 'teardown.beta', runtime: 'node', file: '/tmp/teardown-beta.js', timeout: 30_000, network: true },
      { id: KNOWN_HOOK_ID, name: 'known.hook', runtime: 'node', file: '/tmp/known-hook.js', timeout: 30_000, network: true },
    ],
    filePath: 'runtime/hooks/custom-hooks.yaml',
    errors: [],
    missing: false,
  })

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  container?.remove()
  container = null
  root = null
  document.body.innerHTML = ''
})

async function render(ui: ReactElement): Promise<HTMLElement> {
  const currentRoot = root
  const currentContainer = container

  if (!currentRoot || !currentContainer) {
    throw new Error('Test root not initialized')
  }

  await act(async () => {
    currentRoot.render(ui)
  })
  await flush()

  return currentContainer
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

function getSection(rootElement: HTMLElement, phase: 'setup' | 'teardown'): HTMLElement {
  const section = rootElement.querySelector(`[data-hook-section="${phase}"]`)
  if (!(section instanceof HTMLElement)) {
    throw new Error(`Unable to find ${phase} section`)
  }
  return section
}

function getLiveSection(rootElement: HTMLElement, phase: 'setup' | 'teardown'): HTMLElement {
  const section = rootElement.querySelector(`[data-live-hook-section="${phase}"]`)
  if (!(section instanceof HTMLElement)) {
    throw new Error(`Unable to find ${phase} live section`)
  }
  return section
}

function getButtonByText(scope: ParentNode, text: string): HTMLButtonElement {
  const button = Array.from(scope.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.trim() === text,
  )

  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Unable to find button "${text}"`)
  }

  return button
}

function getComposerInput(scope: ParentNode): HTMLInputElement | null {
  const input = scope.querySelector('input[placeholder="Search hook names or paste an h_ ID"]')
  return input instanceof HTMLInputElement ? input : null
}

function getHookNames(scope: ParentNode): string[] {
  return Array.from(scope.querySelectorAll('[data-hook-row-name]'))
    .map((node) => node.textContent?.trim() ?? '')
    .filter(Boolean)
}

function getRunButtons(scope: ParentNode): HTMLButtonElement[] {
  return Array.from(scope.querySelectorAll('button')).filter(
    (button): button is HTMLButtonElement =>
      button instanceof HTMLButtonElement && button.textContent?.trim() === 'Run',
  )
}

function savedHookId(name: string): string {
  switch (name) {
    case 'setup.alpha': return SETUP_ALPHA_ID
    case 'setup.beta': return SETUP_BETA_ID
    case 'teardown.alpha': return TEARDOWN_ALPHA_ID
    case 'teardown.beta': return TEARDOWN_BETA_ID
    case 'known.hook': return KNOWN_HOOK_ID
    default: throw new Error(`Unknown hook fixture "${name}"`)
  }
}

function dndHookId(phase: 'setup' | 'teardown', name: string): string {
  return `${phase}:${savedHookId(name)}`
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

async function typeValue(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
    descriptor?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function pressKey(element: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key }))
  })
}

async function dragHook(rootElement: HTMLElement, activeId: string, overId: string): Promise<void> {
  const handle = rootElement.querySelector(`[data-sortable-handle="${activeId}"]`)
  if (!(handle instanceof HTMLElement)) {
    throw new Error(`Unable to find drag handle "${activeId}"`)
  }

  const contextElement = handle.closest('[data-dnd-context]')
  const contextIndex = Number(contextElement?.getAttribute('data-dnd-context'))
  const callback = dndOnDragEnds[contextIndex]

  if (!callback) {
    throw new Error(`Missing drag callback for context ${String(contextIndex)}`)
  }

  await act(async () => {
    callback({
      active: { id: activeId },
      over: { id: overId },
    })
  })
  await flush()
}

describe('VisualBuilder hook authoring', () => {
  it('keeps each hook composer collapsed until Add Hook is clicked', async () => {
    const rootElement = await render(
      <Harness
        initialContent={`name: Empty Hooks
target: demo
steps:
  - Open the builder
`}
      />,
    )

    const setupSection = getSection(rootElement, 'setup')
    const teardownSection = getSection(rootElement, 'teardown')

    expect(getComposerInput(setupSection)).toBeNull()
    expect(getComposerInput(teardownSection)).toBeNull()

    await click(getButtonByText(setupSection, 'Add Hook'))

    expect(getComposerInput(setupSection)).not.toBeNull()
    expect(getComposerInput(teardownSection)).toBeNull()
  })

  it('renders hook names first, shows stable IDs, and saves canonical IDs instead of names', async () => {
    const rootElement = await render(
      <Harness
        initialContent={`name: Add Hook
target: demo
steps:
  - Open the builder
`}
      />,
    )

    const setupSection = getSection(rootElement, 'setup')

    await click(getButtonByText(setupSection, 'Add Hook'))
    const input = getComposerInput(setupSection)
    if (!input) throw new Error('Expected setup composer input')

    await typeValue(input, 'known.hook')
    await pressKey(input, 'Enter')

    expect(getHookNames(setupSection)).toEqual(['known.hook'])
    expect(setupSection.textContent).toContain(KNOWN_HOOK_ID)
    expect(setupSection.textContent).toContain('Saved as stable ID')
    expect(rootElement.querySelector('[data-testid="yaml-content"]')?.textContent).toContain(KNOWN_HOOK_ID)
    expect(rootElement.querySelector('[data-testid="yaml-content"]')?.textContent).not.toContain('known.hook')
    expect(getComposerInput(setupSection)).toBeNull()
  })

  it('passes hook label mappings into step previews even when no variable suggestions are provided', async () => {
    await render(
      <Harness
        initialContent={`name: Hook Step Preview
target: demo
steps:
  - Run {{runHook:"${KNOWN_HOOK_ID}"}} before continuing
`}
      />,
    )

    expect(stepCardPropsById['draft-step-0']?.hookLabels?.[KNOWN_HOOK_ID]).toBe('known.hook')
  })

  it('rejects arbitrary human names but accepts pasted canonical h_ IDs', async () => {
    const rootElement = await render(
      <Harness
        initialContent={`name: Paste ID
target: demo
steps:
  - Open the builder
`}
      />,
    )

    const setupSection = getSection(rootElement, 'setup')

    await click(getButtonByText(setupSection, 'Add Hook'))
    const input = getComposerInput(setupSection)
    if (!input) throw new Error('Expected setup composer input')

    await typeValue(input, 'mystery.setup')
    await pressKey(input, 'Enter')

    expect(getHookNames(setupSection)).toEqual([])
    expect(setupSection.textContent).toContain('Search hook names or paste an h_ ID')

    await typeValue(input, UNKNOWN_HOOK_ID)
    await pressKey(input, 'Enter')

    expect(getHookNames(setupSection)).toEqual([UNKNOWN_HOOK_ID])
    expect(setupSection.textContent).toContain(UNKNOWN_HOOK_ID)
    expect(setupSection.textContent).toContain('Not found in configured hooks file')
    expect(rootElement.querySelector('[data-testid="yaml-content"]')?.textContent).toContain(UNKNOWN_HOOK_ID)
  })

  it('reorders within each section and blocks cross-section drag attempts', async () => {
    const rootElement = await render(<Harness />)

    await dragHook(
      rootElement,
      dndHookId('setup', 'setup.alpha'),
      dndHookId('setup', 'setup.beta'),
    )
    expect(getHookNames(getSection(rootElement, 'setup'))).toEqual([
      'setup.beta',
      'setup.alpha',
    ])
    expect(getHookNames(getSection(rootElement, 'teardown'))).toEqual([
      'teardown.alpha',
      'teardown.beta',
    ])

    await dragHook(
      rootElement,
      dndHookId('teardown', 'teardown.beta'),
      dndHookId('teardown', 'teardown.alpha'),
    )
    expect(getHookNames(getSection(rootElement, 'setup'))).toEqual([
      'setup.beta',
      'setup.alpha',
    ])
    expect(getHookNames(getSection(rootElement, 'teardown'))).toEqual([
      'teardown.beta',
      'teardown.alpha',
    ])

    await dragHook(
      rootElement,
      dndHookId('setup', 'setup.beta'),
      dndHookId('teardown', 'teardown.beta'),
    )
    expect(getHookNames(getSection(rootElement, 'setup'))).toEqual([
      'setup.beta',
      'setup.alpha',
    ])
    expect(getHookNames(getSection(rootElement, 'teardown'))).toEqual([
      'teardown.beta',
      'teardown.alpha',
    ])
  })

  it('ignores direct hook drag callbacks when hook authoring is disabled', async () => {
    const rootElement = await render(<Harness disabled />)
    const setupSection = getSection(rootElement, 'setup')
    const handle = setupSection.querySelector(
      `[data-sortable-handle="${dndHookId('setup', 'setup.alpha')}"]`,
    )

    expect(handle instanceof HTMLButtonElement ? handle.disabled : false).toBe(true)

    await dragHook(
      rootElement,
      dndHookId('setup', 'setup.alpha'),
      dndHookId('setup', 'setup.beta'),
    )

    expect(getHookNames(setupSection)).toEqual([
      'setup.alpha',
      'setup.beta',
    ])
    expect(rootElement.querySelector('[data-testid="yaml-content"]')?.textContent).toBe(BASE_YAML)
  })

  it('uses drag handles without move-up or move-down buttons', async () => {
    const rootElement = await render(<Harness />)

    expect(rootElement.querySelectorAll('button[aria-label^="Move "]')).toHaveLength(0)
    expect(rootElement.querySelectorAll('[data-sortable-handle]')).toHaveLength(4)
  })

  it('shows Run only for teardown live hook rows', async () => {
    const rootElement = await render(
      <Harness
        showLiveStepActions
        canRunLiveHook
        liveSetupHooks={[
          {
            id: SETUP_ALPHA_ID,
            name: 'setup.alpha',
            phase: 'setup',
            status: 'pending',
            stdout: null,
            stderr: null,
            variables: null,
          },
        ]}
        liveTeardownHooks={[
          {
            id: TEARDOWN_ALPHA_ID,
            name: 'teardown.alpha',
            phase: 'teardown',
            status: 'pending',
            stdout: null,
            stderr: null,
            variables: null,
          },
        ]}
      />,
    )

    expect(getRunButtons(getLiveSection(rootElement, 'setup'))).toHaveLength(0)
    expect(getRunButtons(getLiveSection(rootElement, 'teardown'))).toHaveLength(1)
  })
})
