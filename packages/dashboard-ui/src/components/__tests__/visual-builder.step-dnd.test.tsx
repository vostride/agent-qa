// @vitest-environment jsdom

import { act, useState, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

import { VisualBuilder } from '@/components/visual-builder'
import type { EditorStep } from '@/hooks/use-live-editor'
import type { Selection } from '@/lib/selection'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { dndOnDragEnds } = vi.hoisted(() => ({
  dndOnDragEnds: [] as Array<((event: { active: { id: string }; over: { id: string } | null }) => void) | undefined>,
}))

vi.mock('@/components/test-metadata-form', () => ({
  TestMetadataForm: () => <div data-testid="metadata-form" />,
}))

vi.mock('@/components/test-hooks-form', () => ({
  useTestHookCatalog: () => ({ hooks: [], warningCopy: null }),
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactElement }) => children,
  TooltipTrigger: ({ children }: { children: ReactElement }) => children,
  TooltipContent: ({ children }: { children: ReactElement }) => children,
}))

vi.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ children }: { children: ReactElement | ReactElement[] }) => <div>{children}</div>,
  AlertDialogTrigger: ({ children }: { children: ReactElement }) => children,
  AlertDialogContent: ({ children }: { children: ReactElement | ReactElement[] }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: ReactElement | ReactElement[] }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: ReactElement | ReactElement[] }) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: { children: ReactElement | ReactElement[] }) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: { children: ReactElement | ReactElement[] }) => <div>{children}</div>,
  AlertDialogCancel: ({ children }: { children: ReactElement | ReactElement[] }) => <button type="button">{children}</button>,
  AlertDialogAction: ({
    children,
    onClick,
  }: {
    children: ReactElement | ReactElement[] | string
    onClick?: () => void
  }) => <button type="button" onClick={onClick}>{children}</button>,
}))

vi.mock('@/components/step-autocomplete', () => ({
  useStepAutocomplete: () => ({ dropdown: null, handleKeyDown: () => false, setVisible: () => {} }),
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

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children, items }: { children: ReactElement; items: string[] }) => (
    <div data-sortable-context={items.join(',')}>{children}</div>
  ),
  useSortable: ({ id }: { id: string; disabled?: boolean }) => ({
    attributes: { 'data-sortable-item': id },
    listeners: { 'data-sortable-handle': id },
    setNodeRef: () => {},
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
  sortableKeyboardCoordinates: () => ({ x: 0, y: 0 }),
  verticalListSortingStrategy: {},
}))

vi.mock('@dnd-kit/utilities', () => ({
  CSS: { Transform: { toString: () => '' } },
}))

const INITIAL_IDS = ['draft-alpha', 'draft-beta', 'draft-gamma']
const REORDERED_IDS = ['draft-beta', 'draft-alpha', 'draft-gamma']

const BASE_YAML = `name: Step DnD
test-id: step-dnd
target: demo
steps:
  - First step
  - Second step
  - Third step
`

const INVALID_YAML = `name: Step DnD
target: demo
steps:
  - [broken
`

function makeLiveStep(id: string, instruction: string, subActionsData: EditorStep['subActionsData'] = null): EditorStep {
  return {
    id,
    draftId: id,
    instruction,
    status: 'idle',
    phases: [],
    executionHistory: [],
    consoleLogs: [],
    networkLogs: [],
    variableSnapshot: null,
    originalStepName: null,
    subActionsData,
    executionLogs: [],
    executionGeneration: 0,
  }
}

const LIVE_STEPS_BY_ID: Record<string, EditorStep> = {
  'draft-alpha': makeLiveStep('draft-alpha', 'First step'),
  'draft-beta': makeLiveStep('draft-beta', 'Second step', [
    {
      index: 0,
      observation: '',
      reasoning: '',
      plannedAction: { type: 'click', target: 'button' },
      result: 'success',
      screenStateBefore: '',
      cached: false,
    },
  ]),
  'draft-gamma': makeLiveStep('draft-gamma', 'Third step'),
}

function getDraftIdsForYaml(yaml: string): string[] {
  return yaml.indexOf('Second step') < yaml.indexOf('First step')
    ? REORDERED_IDS
    : INITIAL_IDS
}

function Harness({
  initialContent = BASE_YAML,
  initialDraftStepIds = INITIAL_IDS,
  selection = null,
  openStepSettingsId = null,
  withLiveSteps = false,
}: {
  initialContent?: string
  initialDraftStepIds?: string[]
  selection?: Selection | null
  openStepSettingsId?: string | null
  withLiveSteps?: boolean
}) {
  const [content, setContent] = useState(initialContent)
  const [draftStepIds, setDraftStepIds] = useState(initialDraftStepIds)
  const [settingsId, setSettingsId] = useState(openStepSettingsId)
  const liveEditorSteps = withLiveSteps
    ? draftStepIds.map((id) => LIVE_STEPS_BY_ID[id])
    : undefined

  function handleChange(nextYaml: string): void {
    setContent(nextYaml)
    if (nextYaml !== INVALID_YAML) {
      setDraftStepIds(getDraftIdsForYaml(nextYaml))
    }
  }

  return (
    <div>
      <button type="button" onClick={() => handleChange(INVALID_YAML)}>Make YAML Invalid</button>
      <VisualBuilder
        content={content}
        onChange={handleChange}
        draftStepIds={draftStepIds}
        openStepSettingsId={settingsId}
        onOpenStepSettingsChange={setSettingsId}
        selection={selection}
        onSelect={() => {}}
        liveEditorSteps={liveEditorSteps}
      />
      <pre data-testid="yaml-content">{content}</pre>
    </div>
  )
}

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  dndOnDragEnds.length = 0
  ;(globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
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

function getStepTexts(rootElement: HTMLElement): string[] {
  return Array.from(rootElement.querySelectorAll('textarea[placeholder="Describe what this step should do..."]'))
    .map((textarea) => textarea instanceof HTMLTextAreaElement ? textarea.value : '')
}

function getHandle(rootElement: HTMLElement, id: string): HTMLButtonElement {
  const handle = rootElement.querySelector(`[data-sortable-handle="${id}"]`)
  if (!(handle instanceof HTMLButtonElement)) {
    throw new Error(`Unable to find step handle "${id}"`)
  }
  return handle
}

function getCardForHandle(rootElement: HTMLElement, id: string): HTMLElement {
  let node: HTMLElement | null = getHandle(rootElement, id)
  while (node && !node.className.includes('group/step')) {
    node = node.parentElement
  }
  if (!node) throw new Error(`Unable to find card for "${id}"`)
  return node
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()
}

async function dragStep(rootElement: HTMLElement, activeId: string, overId: string): Promise<void> {
  const handle = getHandle(rootElement, activeId)
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

describe('VisualBuilder step drag identity', () => {
  it('uses stable draft step IDs for sortable items and rendered step handles', async () => {
    const rootElement = await render(<Harness />)

    expect(rootElement.querySelector('[data-sortable-context]')?.getAttribute('data-sortable-context')).toBe(
      INITIAL_IDS.join(','),
    )
    expect(getHandle(rootElement, 'draft-alpha').getAttribute('aria-label')).toBe('Reorder step 1')
    expect(getHandle(rootElement, 'draft-beta').getAttribute('aria-label')).toBe('Reorder step 2')
    expect(getStepTexts(rootElement)).toEqual(['First step', 'Second step', 'Third step'])
  })

  it('maps stable drag IDs to current YAML indices and re-renders visible order', async () => {
    const rootElement = await render(<Harness />)

    await dragStep(rootElement, 'draft-beta', 'draft-alpha')

    expect(getStepTexts(rootElement)).toEqual(['Second step', 'First step', 'Third step'])
    const yaml = rootElement.querySelector('[data-testid="yaml-content"]')?.textContent ?? ''
    expect(yaml.indexOf('- Second step')).toBeLessThan(yaml.indexOf('- First step'))
    expect(rootElement.querySelector('[data-sortable-context]')?.getAttribute('data-sortable-context')).toBe(
      REORDERED_IDS.join(','),
    )
  })

  it('keeps selected and open settings state attached to the moved stable step ID', async () => {
    const rootElement = await render(
      <Harness
        selection={{ type: 'step', stepId: 'draft-beta' }}
        openStepSettingsId="draft-beta"
      />,
    )

    await dragStep(rootElement, 'draft-beta', 'draft-alpha')

    const betaCard = getCardForHandle(rootElement, 'draft-beta')
    expect(getHandle(rootElement, 'draft-beta').getAttribute('aria-label')).toBe('Reorder step 1')
    expect(betaCard.className).toContain('ring-primary')
    expect(betaCard.textContent).toContain('Step settings open')
  })

  it('keeps selected live sub-action state attached to the moved stable step ID', async () => {
    const rootElement = await render(
      <Harness
        withLiveSteps
        selection={{ type: 'subaction', stepId: 'draft-beta', subIndex: 0 }}
      />,
    )

    await dragStep(rootElement, 'draft-beta', 'draft-alpha')

    const betaCard = getCardForHandle(rootElement, 'draft-beta')
    const selectedSubAction = Array.from(betaCard.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('click button'),
    )
    expect(getHandle(rootElement, 'draft-beta').getAttribute('aria-label')).toBe('Reorder step 1')
    expect(selectedSubAction?.className).toContain('border-primary/40')
  })

  it('does not reorder against the last valid display while YAML is invalid', async () => {
    const rootElement = await render(<Harness />)

    await click(Array.from(rootElement.querySelectorAll('button')).find((button) => button.textContent === 'Make YAML Invalid')!)
    expect(rootElement.textContent).toContain('YAML has errors')
    expect(getHandle(rootElement, 'draft-beta').disabled).toBe(true)

    await dragStep(rootElement, 'draft-beta', 'draft-alpha')

    expect(rootElement.querySelector('[data-testid="yaml-content"]')?.textContent).toBe(INVALID_YAML)
    expect(getStepTexts(rootElement)).toEqual(['First step', 'Second step', 'Third step'])
  })
})
