// @vitest-environment jsdom

// The live step list words a member's note, its outcome and each row's status in the current language.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import i18n from '@/i18n'
import { StepList } from '@/components/live-run/step-list'
import { DID_NOT_RUN_NOTE, type LiveStepRow, type MemberRow } from '@/lib/run-stream-reducer'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement | null = null
let root: Root | null = null

afterEach(async () => {
  await act(async () => {
    await i18n.changeLanguage('en')
  })
  i18n.removeResourceBundle('fr', 'translation')
  act(() => {
    root?.unmount()
  })
  container?.remove()
  container = null
  root = null
})

const MEMBERS: MemberRow[] = [
  { testIndex: 0, name: 'checkout', outcome: 'passed', note: DID_NOT_RUN_NOTE, sawStepStarted: false },
  { testIndex: 1, name: 'login', outcome: 'passed', sawStepStarted: true },
]

const STEPS: LiveStepRow[] = [
  { testIndex: 1, stepIndex: 0, status: 'passed', text: 'open the page', ticks: 0, createdSeq: 1 },
]

function mount(): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(<StepList members={MEMBERS} steps={STEPS} terminal={false} />)
  })
  return container
}

describe('the live step list in another language', () => {
  it('shows the member note, the member outcome and the row status in the current language', async () => {
    const view = mount()
    const note = view.querySelector('[data-member="0"] [data-member-note]')
    const outcome = view.querySelector('[data-member="0"] [data-member-outcome]')
    const glyph = view.querySelector('[data-step-status="passed"] [role="img"]')
    expect(note?.textContent).toBe('did not run')
    expect(outcome?.textContent).toBe('passed')
    expect(glyph?.getAttribute('aria-label')).toBe('passed')

    i18n.addResourceBundle('fr', 'translation', {
      'runDetail.member.didNotRun': 'non exécuté',
      'status.name.passed': 'réussi',
    })
    await act(async () => {
      await i18n.changeLanguage('fr')
    })
    expect(view.querySelector('[data-member="0"] [data-member-note]'), 'not remounted').toBe(note)
    expect(note?.textContent).toBe('non exécuté')
    expect(outcome?.textContent).toBe('réussi')
    expect(outcome?.getAttribute('data-member-outcome')).toBe('passed')
    expect(glyph?.getAttribute('aria-label')).toBe('réussi')

    await act(async () => {
      await i18n.changeLanguage('en')
    })
    expect(note?.textContent).toBe('did not run')
    expect(outcome?.textContent).toBe('passed')
    expect(glyph?.getAttribute('aria-label')).toBe('passed')
  })

  it('shows a note it does not know as it arrived', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root?.render(
        <StepList
          members={[{ testIndex: 0, name: 'checkout', note: 'held by the farm', sawStepStarted: false }]}
          steps={[]}
          terminal
        />,
      )
    })
    expect(container.querySelector('[data-member-note]')?.textContent).toBe('held by the farm')
  })
})
