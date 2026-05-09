// @vitest-environment jsdom

import { act, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useStepAutocomplete } from '@/components/step-autocomplete'
import type { VariableSuggestion } from '@/hooks/use-variable-suggestions'

const HOOK_ID = 'h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle'

const suggestions: VariableSuggestion[] = [
  {
    namespace: 'runHook',
    name: 'login',
    label: 'hook',
    insertValue: HOOK_ID,
    description: HOOK_ID,
  },
]

function Harness() {
  const [text, setText] = useState('Do {{runHook:lo')
  const anchorRef = useRef<HTMLDivElement | null>(null)
  const { dropdown } = useStepAutocomplete({
    text,
    cursorPos: text.length,
    suggestions,
    onInsert: (fullSyntax, startPos, endPos) => {
      setText((prev) => `${prev.slice(0, startPos)}${fullSyntax}${prev.slice(endPos)}`)
    },
    anchorRef,
  })

  return (
    <div ref={anchorRef}>
      <div data-testid="text">{text}</div>
      {dropdown}
    </div>
  )
}

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
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

async function render(): Promise<HTMLElement> {
  const currentRoot = root
  const currentContainer = container
  if (!currentRoot || !currentContainer) {
    throw new Error('Test root not initialized')
  }

  await act(async () => {
    currentRoot.render(<Harness />)
  })
  await act(async () => {
    await Promise.resolve()
  })

  return currentContainer
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  })
  await act(async () => {
    await Promise.resolve()
  })
}

describe('step-autocomplete', () => {
  it('renders readable hook names and inserts exact quoted runHook ID syntax', async () => {
    const rootElement = await render()
    const suggestionButton = Array.from(document.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('login'),
    )

    expect(suggestionButton?.textContent).toContain(HOOK_ID)
    if (!(suggestionButton instanceof HTMLElement)) {
      throw new Error('Expected runHook suggestion button')
    }

    await click(suggestionButton)

    expect(rootElement.querySelector('[data-testid="text"]')?.textContent).toBe(`Do {{runHook:"${HOOK_ID}"}}`)
  })
})
