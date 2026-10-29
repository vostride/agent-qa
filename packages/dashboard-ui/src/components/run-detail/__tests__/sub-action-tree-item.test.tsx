// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { asRef, type RunDetailSubAction } from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SubActionTreeItem } from '../sub-action-tree-item'
import { TooltipProvider } from '@/components/ui/tooltip'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
let container: HTMLDivElement
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  container?.remove()
})

function mount(success = false, cached = false) {
  const sub: RunDetailSubAction = {
    testIndex: 0, stepIndex: 0, subActionIndex: 2, plan: 'The planner reasoning stays in Overview',
    plannedAction: { type: 'click', ref: asRef('link') },
    grounding: { descriptor: { name: 'Learn more' }, attempts: [] },
    result: { success }, screenStateHash: 'screen',
  }
  const onSelect = vi.fn()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(<TooltipProvider><ul role='tree'>
    <SubActionTreeItem sub={sub} stepId='0:0' cached={cached} isSelected onSelect={onSelect} />
  </ul></TooltipProvider>))
  return { row: container.querySelector('[data-sub-action]')!, sub, onSelect }
}

it('TREE-ROW-FAMILY-ICON keeps the icon, failure words, cache marker and row address', () => {
  const { row, onSelect } = mount(false, true)
  expect(row.querySelector('[data-action-family="pointer"][data-action-outcome="failed"]')).not.toBeNull()
  expect(row.textContent).toBe("Tried to click 'Learn more' — failed")
  expect(row.querySelector('.h-1\\.5.rounded-full')).toBeNull()
  expect(row.getAttribute('data-sub-action-result')).toBe('failure')
  expect(row.getAttribute('data-sub-action-id')).toBe('0:0-2')
  expect(row.getAttribute('role')).toBe('treeitem')
  expect(row.getAttribute('aria-level')).toBe('2')
  expect(row.getAttribute('aria-selected')).toBe('true')
  expect(row.querySelector('[data-cache-marker="sub-action-status"]')?.parentElement?.querySelector('svg.lucide-mouse-pointer-2')).not.toBeNull()
  const button = row.querySelector('button')!
  expect(button.className).toContain('rounded-md bg-primary/10 ring-1 ring-inset ring-primary/60')
  act(() => button.click())
  expect(onSelect).toHaveBeenCalledOnce()
})

it('TREE-ROW-NO-PLAN-TEXT uses a truncated sentence and shows a stored secret marker as text', () => {
  const { row, sub } = mount(true)
  expect(row.textContent).not.toContain(sub.plan)
  expect(row.querySelector('[data-sub-action-plan]')).toBeNull()
  expect(row.textContent).toBe("Clicked 'Learn more'")
  expect(row.querySelector('.truncate')).not.toBeNull()
  const secret = '[secret:PW]'
  act(() => root!.render(<SubActionTreeItem sub={{ ...sub,
    plannedAction: { type: 'fill', ref: asRef('password'), text: secret, clearMode: 'replace', submit: false },
  }} stepId='0:0' cached={false} isSelected={false} onSelect={() => {}} />))
  expect(container.querySelector('[data-masked]')).toBeNull()
  expect(container.textContent).toBe("Filled 'Learn more' with [secret:PW]")
})

describe('a skipped tap that sent no input', () => {
  it('the tree item marks a skipped tap no-input', () => {
    const { sub } = mount(true)
    expect(container.querySelector('[data-sub-action]')!.getAttribute('data-sub-action-result')).toBe('success')
    act(() => root!.render(<SubActionTreeItem sub={{ ...sub, result: { success: false } }}
      stepId='0:0' cached={false} isSelected={false} onSelect={() => {}} />))
    expect(container.querySelector('[data-sub-action]')!.getAttribute('data-sub-action-result')).toBe('failure')
    act(() => root!.render(<SubActionTreeItem sub={{ ...sub,
      plannedAction: { type: 'tap', ref: asRef('wifi') },
      grounding: { descriptor: { name: 'Wi-Fi' }, attempts: [] },
      result: { success: false, metadata: { idempotentNoop: { currentState: 'checked', inputSent: false } } },
    }} stepId='0:0' cached={false} isSelected={false} onSelect={() => {}} />))
    const row = container.querySelector('[data-sub-action]')!
    expect(row.getAttribute('data-sub-action-result')).toBe('no-input')
    expect(row.querySelector('[data-action-outcome="no-input"]')).not.toBeNull()
    expect(row.textContent).toBe("Did not tap 'Wi-Fi' — no input sent, already checked")
    expect(row.querySelector('svg.text-red-500')).toBeNull()
  })
})
