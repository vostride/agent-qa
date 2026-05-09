// @vitest-environment jsdom

import { act } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useKeyboardShortcuts } from '@/hooks/use-keyboard-shortcuts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface HarnessProps {
  testId: string
  filePath: string
  onEdit: (payload: { testId: string }) => void
  onRun: (payload: { filePath: string }) => void
  onLive: (payload: { testId: string }) => void
}

function ShortcutHarness({ testId, filePath, onEdit, onRun, onLive }: HarnessProps) {
  useKeyboardShortcuts({
    e: () => onEdit({ testId }),
    r: () => onRun({ filePath }),
    l: () => onLive({ testId }),
  })

  return (
    <div>
      <input data-testid="plain-input" defaultValue="editable" />
      <textarea data-testid="plain-textarea" defaultValue="editable" />
      <div data-testid="editable-div" contentEditable suppressContentEditableWarning>
        editable
      </div>
      <div className="monaco-editor">
        <textarea data-testid="readonly-monaco" aria-readonly="true" defaultValue="readonly" />
      </div>
    </div>
  )
}

let container: HTMLDivElement | null = null
let root: Root | null = null

function dispatchKey(target: EventTarget, key: string) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
}

afterEach(() => {
  const mountedRoot = root
  if (mountedRoot) {
    act(() => {
      mountedRoot.unmount()
    })
  }
  root = null
  if (container) {
    container.remove()
  }
  container = null
  vi.clearAllMocks()
})

describe('useKeyboardShortcuts viewer freshness', () => {
  it('uses the latest test id and file path immediately after rerender', () => {
    const oldHandlers = {
      onEdit: vi.fn(),
      onRun: vi.fn(),
      onLive: vi.fn(),
    }
    const newHandlers = {
      onEdit: vi.fn(),
      onRun: vi.fn(),
      onLive: vi.fn(),
    }

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root!.render(
        <ShortcutHarness
          {...oldHandlers}
          testId="t_old"
          filePath="tests/old.yaml"
        />,
      )
    })

    act(() => {
      flushSync(() => {
        root!.render(
          <ShortcutHarness
            {...newHandlers}
            testId="t_new"
            filePath="tests/new.yaml"
          />,
        )
      })
      dispatchKey(document, 'r')
      dispatchKey(document, 'e')
      dispatchKey(document, 'l')
    })

    expect(oldHandlers.onRun).not.toHaveBeenCalled()
    expect(oldHandlers.onEdit).not.toHaveBeenCalled()
    expect(oldHandlers.onLive).not.toHaveBeenCalled()
    expect(newHandlers.onRun).toHaveBeenCalledWith({ filePath: 'tests/new.yaml' })
    expect(newHandlers.onEdit).toHaveBeenCalledWith({ testId: 't_new' })
    expect(newHandlers.onLive).toHaveBeenCalledWith({ testId: 't_new' })
  })

  it('blocks shortcuts inside normal editable fields but allows read-only Monaco textareas', () => {
    const onEdit = vi.fn()
    const onRun = vi.fn()
    const onLive = vi.fn()

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root!.render(
        <ShortcutHarness
          testId="t_alpha"
          filePath="tests/alpha.yaml"
          onEdit={onEdit}
          onRun={onRun}
          onLive={onLive}
        />,
      )
    })

    const input = container.querySelector('[data-testid="plain-input"]') as HTMLInputElement
    const textarea = container.querySelector('[data-testid="plain-textarea"]') as HTMLTextAreaElement
    const editableDiv = container.querySelector('[data-testid="editable-div"]') as HTMLDivElement
    const readonlyMonaco = container.querySelector('[data-testid="readonly-monaco"]') as HTMLTextAreaElement

    Object.defineProperty(editableDiv, 'isContentEditable', {
      configurable: true,
      value: true,
    })

    act(() => {
      dispatchKey(input, 'r')
      dispatchKey(textarea, 'e')
      dispatchKey(editableDiv, 'l')
    })

    expect(onRun).not.toHaveBeenCalled()
    expect(onEdit).not.toHaveBeenCalled()
    expect(onLive).not.toHaveBeenCalled()

    act(() => {
      dispatchKey(readonlyMonaco, 'r')
      dispatchKey(readonlyMonaco, 'e')
      dispatchKey(readonlyMonaco, 'l')
    })

    expect(onRun).toHaveBeenCalledWith({ filePath: 'tests/alpha.yaml' })
    expect(onEdit).toHaveBeenCalledWith({ testId: 't_alpha' })
    expect(onLive).toHaveBeenCalledWith({ testId: 't_alpha' })
  })
})
