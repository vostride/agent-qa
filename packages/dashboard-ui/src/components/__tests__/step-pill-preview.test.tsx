// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { StepPillPreview } from '@/components/step-pill-preview'

const HOOK_ID = 'h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  container?.remove()
  container = null
  root = null
})

describe('StepPillPreview', () => {
  it('renders readable hook names for runHook pills while preserving canonical id metadata', () => {
    if (!container || !root) {
      throw new Error('Test root not initialized')
    }
    const mountedRoot = root
    const mountedContainer = container

    act(() => {
      mountedRoot.render(
        <StepPillPreview
          text={`Run ${`{{runHook:"${HOOK_ID}"}}`} before continuing`}
          hookLabels={{ [HOOK_ID]: 'Seed Auth' }}
        />,
      )
    })

    const pill = mountedContainer.querySelector('span.rounded-sm')
    expect(pill?.textContent).toBe('Seed Auth')
    expect(mountedContainer.textContent).toContain(HOOK_ID)
    expect(mountedContainer.textContent).toContain(`{{runHook:"${HOOK_ID}"}}`)
  })
})
