// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import * as component from '../evidence-state'
import * as view from '@/lib/evidence-state-view'
import { EVIDENCE_INCOMPLETE_LABEL } from '@/lib/run-detail-view'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement
let root: Root
function mount(node: ReactNode) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(node))
  return container
}
afterEach(() => {
  if (root) act(() => root.unmount())
  container?.remove()
})

test('STATE-INLINE-VARIANT', () => {
  const onAction = vi.fn()
  const element = mount(<component.EvidenceState kind="frame" state="unavailable" incomplete variant="inline" title={EVIDENCE_INCOMPLETE_LABEL} explanation={view.EVIDENCE_INCOMPLETE_EXPLANATION()} actionLabel="Unused" onAction={onAction} />)
  const badge = element.querySelector('[data-evidence-state="unavailable"]')
  expect(badge?.tagName).toBe('SPAN')
  expect(badge?.getAttribute('data-slot')).toBe('badge')
  expect(badge?.getAttribute('data-variant')).toBe('outline')
  expect(badge?.getAttribute('data-evidence-kind')).toBe('frame')
  expect(badge?.getAttribute('data-evidence-tone')).toBe('neutral')
  expect(badge?.getAttribute('data-evidence-incomplete')).toBe('true')
  expect(badge?.textContent).toBe(EVIDENCE_INCOMPLETE_LABEL)
  expect(badge?.querySelector('svg')?.getAttribute('class')).toContain('h-3 w-3')
  expect(element.querySelector('button, a, [href], [data-masked], [data-run-detail-error]')).toBeNull()
  expect(onAction).not.toHaveBeenCalled()
})

test('STATE-LOADING-NOT-A-STATE', () => {
  expect(component.EvidenceLoading).toBeTypeOf('function')
  const element = mount(<component.EvidenceLoading kind="a11y" />)
  const loading = element.querySelector('[data-evidence-loading]')
  expect(loading?.getAttribute('aria-busy')).toBe('true')
  expect(loading?.getAttribute('data-evidence-kind')).toBe('a11y')
  expect(loading?.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(3)
  const status = loading?.querySelector('[role="status"]')
  expect(status?.textContent).toBe(view.EVIDENCE_LOADING_LABEL())
  expect(status?.classList.contains('sr-only')).toBe(true)
  expect(element.querySelector('[data-evidence-state], [data-masked], [data-run-detail-error]')).toBeNull()
})

test('STATE-PANE-TONES keeps distinct icons, roles, wrapping and failure actions', () => {
  expect(view.EVIDENCE_ICON_OF_STATE).toBeDefined()
  expect(new Set(Object.values(view.EVIDENCE_ICON_OF_STATE)).size).toBe(6)
  const onAction = vi.fn()
  const element = mount(<div />)
  for (const state of view.EVIDENCE_STATES) {
    const copy = state === 'failed' ? view.EVIDENCE_COPY.a11y.failed.load : view.EVIDENCE_COPY.a11y[state]
    act(() => root.render(<component.EvidenceState kind="a11y" state={state} failure="load" {...copy} actionLabel={state === 'failed' ? view.EVIDENCE_RETRY_LABELS.a11y : undefined} onAction={onAction} />))
    const pane = element.querySelector('[data-evidence-state]')
    expect(pane?.getAttribute('role')).toBe(state === 'failed' ? 'alert' : 'status')
    expect(pane?.getAttribute('data-evidence-tone')).toBe(view.EVIDENCE_TONE_OF_STATE[state])
    expect(pane?.getAttribute('data-evidence-failure')).toBe(state === 'failed' ? 'load' : null)
    expect(pane?.classList.contains('min-h-[16rem]')).toBe(true)
    expect(pane?.querySelector('p')?.classList.contains('max-w-sm')).toBe(true)
    expect(pane?.textContent).toContain(copy.title)
    expect(pane?.textContent).toContain(copy.explanation)
    expect(pane?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    expect(element.querySelector('[data-masked], [data-run-detail-error]')).toBeNull()
    if (state === 'failed') act(() => element.querySelector('button')!.click())
  }
  expect(onAction).toHaveBeenCalledOnce()
})
