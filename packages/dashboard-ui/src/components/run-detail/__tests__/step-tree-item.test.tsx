// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunDetailMemberMark } from '@vostride/agent-qa-schema'
import { StepTreeItem } from '../step-tree-item'
import { TooltipProvider } from '@/components/ui/tooltip'
import { fromRunDetailStep } from '@/lib/display-step'
import { CHOICE_LABELS, feedbackEntryLabel, markGlyphLabel, stepTriggerTooltip } from '@/lib/feedback-view'
import type { Selection } from '@/lib/selection'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
const step = fromRunDetailStep({ testIndex: 7, stepIndex: 2, stepText: 'Check cart', cacheStatus: 'miss',
  verifierVerdict: { pass: false, reasoning: 'Cart differs' }, selfHealOccurred: false, briefDigest: 'digest' }, [])
afterEach(() => { act(() => root.unmount()); container.remove() })

// The row keeps the selected-row door and the passive glyph; marking happens in the composer.
const markAttributes = () => [...container.querySelectorAll('*')]
  .flatMap(element => element.getAttributeNames().filter(name => name.startsWith('data-mark')))

describe('step marking', () => {
  it('uses the durable address: the row door opens feedback on 7:2 and the row submits nothing itself', () => {
    const onOpen = mountRow({ isSelected: true, selection: { type: 'step', stepId: step.id } })
    const trigger = triggers()[0]!
    expect(trigger.getAttribute('data-feedback-target')).toBe('7:2')
    act(() => { trigger.click() })
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(trigger)
    expect(markAttributes()).toEqual([])
    expect(container.querySelector('[data-step-mark]')).toBeNull()
  })
  it('renders only the matching step mark, as its named glyph', () => {
    mountRow({ isSelected: false, marks: [
      { markId: 'mark_0123456789ab', kind: 'false-fail', ordinal: 1, disposition: { kind: 'quarantined', class: 'flake' } },
      { markId: 'mark_0123456789ac', kind: 'confirmed-bug', ordinal: 2, stepIndex: 2, disposition: { kind: 'confirmed-bug', confirmedRecords: 0 } },
      { markId: 'mark_0123456789ad', kind: 'false-pass', ordinal: 3, stepIndex: 3, disposition: { kind: 'quarantined', class: 'timeout' } },
    ] })
    expect(glyphs()).toHaveLength(1)
    expect(glyphs()[0]!.getAttribute('aria-label')).toBe(markGlyphLabel('confirmed-bug'))
    expect(markAttributes()).toEqual([])
    expect(row().textContent).not.toContain('confirmed-bug')
    expect(readFileSync('src/components/run-detail/step-tree-item.tsx', 'utf8')).not.toContain('dangerouslySetInnerHTML')
  })
  it('renders no review control and no anchor for a drafted step mark; the command lives in the composer history (HISTORY-REVIEW-COMMAND)', () => {
    mountRow({ isSelected: false, marks: [{ markId: 'mark_0123456789ae', kind: 'false-fail', ordinal: 4, stepIndex: 2,
      disposition: { kind: 'drafted', fix: 'caution', proposalId: 'prop_step-review', proposalKind: 'knowledge' } }] })
    expect(row().querySelector('a')).toBeNull()
    expect(row().querySelector('[data-review-command]')).toBeNull()
    expect(row().textContent).not.toContain('prop_step-review')
  })
  it('holds no textarea, submit or cancel control, selected or not', () => {
    for (const isSelected of [false, true]) {
      mountRow({ isSelected, selection: isSelected ? { type: 'step', stepId: step.id } : null, marks: [stepMark('false-pass')] })
      expect(row().querySelector('textarea, input')).toBeNull()
      const buttons = [...row().querySelectorAll('button')]
      expect(buttons).toEqual(isSelected ? [row().querySelector(':scope > button'), triggers()[0]] : [row().querySelector(':scope > button')])
      act(() => root.unmount()); container.remove()
    }
    mountRow({ isSelected: false })
  })
})

// The door sits in a non-button span, so the row button stays the li's one direct button child.
const SHIPPED_ROW_CLASSES = ['flex', 'w-full', 'items-start', 'gap-2', 'py-2', 'px-3', 'text-left', 'hover:bg-muted/50']
const stepMark = (kind: RunDetailMemberMark['kind']): RunDetailMemberMark =>
  ({ markId: 'mark_0123456789af', kind, ordinal: 5, stepIndex: 2, disposition: { kind: 'quarantined', class: 'flake' } })
function mountRow({ isSelected, marks = [], selection = null }: {
  isSelected: boolean; marks?: readonly RunDetailMemberMark[]; selection?: Selection | null
}) {
  const onOpenFeedback = vi.fn()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root.render(<MemoryRouter><TooltipProvider delayDuration={0}><ul><StepTreeItem step={step} isSelected={isSelected}
    isExpanded selection={selection} onSelect={() => {}} marks={marks}
    onOpenFeedback={onOpenFeedback} composerId="run-feedback-composer" /></ul></TooltipProvider></MemoryRouter>))
  return onOpenFeedback
}
const row = () => container.querySelector<HTMLLIElement>('li[data-step-id]')!
const triggers = () => [...container.querySelectorAll<HTMLButtonElement>('[data-feedback-entry="step"]')]
const glyphs = () => [...container.querySelectorAll<HTMLElement>('[data-feedback-mark-glyph="step"]')]

describe('the step door on the owning row', () => {
  it('TRIGGER-ON-OWNING-ROW-ONLY: the selected row carries one 28px step door addressed to its step; an unselected row none', async () => {
    const onOpen = mountRow({ isSelected: true, selection: { type: 'step', stepId: step.id } })
    expect(triggers()).toHaveLength(1)
    const trigger = triggers()[0]!
    expect(trigger.getAttribute('data-feedback-target')).toBe('7:2')
    expect(trigger.getAttribute('aria-label')).toBe('Give feedback on step 3')
    expect(trigger.classList.contains('size-7')).toBe(true)
    expect(trigger.getAttribute('aria-controls')).toBe('run-feedback-composer')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(trigger.getAttribute('data-feedback-marked')).toBe('false')
    expect(trigger.hasAttribute('title')).toBe(false)
    await act(async () => { trigger.focus() })
    const tip = [...document.querySelectorAll('[data-slot="tooltip-content"]')].map(el => el.textContent ?? '').join('|')
    expect(tip).toContain(stepTriggerTooltip(3, false))
    act(() => { trigger.click() })
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(trigger)
    act(() => root.unmount()); container.remove()

    mountRow({ isSelected: false })
    expect(triggers()).toHaveLength(0)
  })

  it('TRIGGER-SUBACTION-PARENT: a sub-action selection under the step keeps the door on its parent row', () => {
    mountRow({ isSelected: true, selection: { type: 'subaction', stepId: step.id, subIndex: 0 } })
    expect(triggers()).toHaveLength(1)
    expect(triggers()[0]!.getAttribute('data-feedback-target')).toBe('7:2')
  })

  it('ROW-BUTTON-STAYS-DIRECT-CHILD: one direct button child with its shipped classes in both states; pr-9 only while the door shows', () => {
    for (const isSelected of [false, true]) {
      mountRow({ isSelected, selection: isSelected ? { type: 'step', stepId: step.id } : null })
      const direct = row().querySelectorAll<HTMLButtonElement>(':scope > button')
      expect(direct).toHaveLength(1)
      expect(row().firstElementChild).toBe(direct[0])
      for (const token of SHIPPED_ROW_CLASSES) expect(direct[0]!.classList.contains(token), token).toBe(true)
      expect(direct[0]!.classList.contains('pr-9')).toBe(isSelected)
      expect(row().classList.contains('relative')).toBe(true)
      if (isSelected) {
        const wrap = triggers()[0]!.parentElement!
        expect(wrap.tagName).toBe('SPAN')
        expect(wrap.parentElement).toBe(row())
        expect(wrap.previousElementSibling).toBe(direct[0])
        expect(['absolute', 'right-1', 'top-1'].every(token => wrap.classList.contains(token))).toBe(true)
      }
      act(() => root.unmount()); container.remove()
    }
    mountRow({ isSelected: false })
  })
})

describe('the passive trace on a marked row', () => {
  it('GLYPH-ON-MARKED-ROW: a marked row that is not the door row carries one named glyph inside its button, before the duration', () => {
    mountRow({ isSelected: false, marks: [stepMark('confirmed-bug')] })
    expect(glyphs()).toHaveLength(1)
    const glyph = glyphs()[0]!
    expect(glyph.getAttribute('role')).toBe('img')
    expect(glyph.getAttribute('aria-label')).toBe(markGlyphLabel('confirmed-bug'))
    expect(glyph.getAttribute('data-feedback-target')).toBe('7:2')
    expect(glyph.hasAttribute('tabindex')).toBe(false)
    expect(glyph.hasAttribute('title')).toBe(false)
    expect(['size-4', 'shrink-0'].every(token => glyph.classList.contains(token))).toBe(true)
    expect(glyph.closest('li[data-step-id] > button')).toBe(row().querySelector(':scope > button'))
    expect(glyph.nextElementSibling?.textContent).toBe(row().querySelector(':scope > button > span:last-child')?.textContent)
    expect(glyph.nextElementSibling).toBe(row().querySelector(':scope > button > span:last-child'))
    act(() => root.unmount()); container.remove()

    mountRow({ isSelected: false, marks: [{ ...stepMark('false-fail'), stepIndex: 3 }] })
    expect(glyphs()).toHaveLength(0)
  })

  it('NO-GLYPH-ON-TRIGGER-ROW: the door row shows the filled door and no glyph, so one row never shows two bubbles', () => {
    mountRow({ isSelected: true, selection: { type: 'step', stepId: step.id }, marks: [stepMark('false-fail')] })
    expect(glyphs()).toHaveLength(0)
    const trigger = triggers()[0]!
    expect(trigger.getAttribute('data-feedback-marked')).toBe('true')
    const svg = trigger.querySelector('svg')!
    expect(svg.classList.contains('lucide-message-square')).toBe(true)
    expect(svg.classList.contains('fill-current')).toBe(true)
    expect(trigger.getAttribute('aria-label')).toBe(feedbackEntryLabel({ scope: 'step', stepNumber: 3, markedChoice: 'false-fail' }))
    expect(trigger.getAttribute('aria-label')?.endsWith(` — already marked: ${CHOICE_LABELS['false-fail']}`)).toBe(true)
  })
})
