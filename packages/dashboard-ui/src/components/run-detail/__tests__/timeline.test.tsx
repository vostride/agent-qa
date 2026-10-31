// @vitest-environment jsdom
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { asRef } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { buildTimelineModel, type TimelineModel } from '@/lib/playhead'
import type { RunDetailGroup } from '@/lib/run-detail-view'

const modules = import.meta.glob<typeof import('../timeline')>('../timeline.tsx', { eager: true })
type Props = ComponentProps<typeof import('../timeline').Timeline>
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let host: HTMLDivElement
let model: TimelineModel
const change = vi.fn()
const seek = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })))
  const group: RunDetailGroup = {
    member: { testIndex: 0, attempts: 1 },
    steps: [0, 1].map(stepIndex => ({
      step: { testIndex: 0, stepIndex, cacheStatus: 'miss', verifierVerdict: { pass: true, reasoning: '' }, selfHealOccurred: stepIndex === 0, briefDigest: 'digest' },
      subActions: [0, 1].map(subActionIndex => ({
        testIndex: 0, stepIndex, subActionIndex, plan: 'private reasoning',
        plannedAction: { type: 'fill', ref: asRef('e1'), text: '[secret:PW]', clearMode: 'replace', submit: false },
        result: { success: subActionIndex === 0 }, screenStateHash: 'screen',
        recordingOffsetMs: (stepIndex * 2 + subActionIndex) * 10000,
        artifactRefs: subActionIndex === 1 ? [] : [{ id: `decision-screenshot:${'a'.repeat(64)}`, sha: 'a'.repeat(64) }],
      })),
    })),
  }
  model = buildTimelineModel(group)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
function render(extra: Partial<Props> = {}) {
  const module = modules['../timeline.tsx']
  expect(module, 'Timeline exists').toBeDefined()
  const { Timeline } = module!
  act(() => root.render(<Timeline model={model} playhead={model.markers[0]!} source='frames' onPlayheadChange={change} onSeekFraction={seek} {...extra} />))
}
function query(selector: string) { return host.querySelector<HTMLElement>(selector)! }




test('TIMELINE-AXIS-ATTRIBUTE', () => {
  render()
  expect(query('[data-timeline]').dataset.timelineAxis).toBe('ordinal')
  render({ model: { ...model, axis: 'time', extent: 42000 } })
  expect(query('[data-timeline]').dataset.timelineAxis).toBe('time')
  expect(query('[data-timeline]').dataset.timelineMember).toBe('0')
})






test('TIMELINE-SLIDER-ARIA', () => {
  render()
  const slider = query('[role="slider"]')
  expect(slider.getAttribute('aria-label')).toBe('Test timeline')
  expect(slider.getAttribute('aria-valuemin')).toBe('0')
  expect(slider.getAttribute('aria-valuemax')).toBe('100')
  expect(slider.getAttribute('aria-valuenow')).toBe('13')
  expect(slider.getAttribute('aria-valuetext')).toBe('Step 1, sub-action 1 of 4: Filled with [secret:PW], passed, 0:00')
  expect(host.querySelectorAll('[tabindex="0"]')).toHaveLength(1)
})

function pointer(element: HTMLElement, type: string, clientX = 0) {
  const event = new MouseEvent(type, { bubbles: true, clientX, button: 0 })
  Object.defineProperty(event, 'pointerId', { value: 7 })
  Object.defineProperty(event, 'pointerType', { value: 'mouse' })
  act(() => element.dispatchEvent(event))
}
function track() {
  const element = query('[data-timeline-track]')
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({ left: 10, width: 400 } as DOMRect)
  element.setPointerCapture = vi.fn()
  element.hasPointerCapture = vi.fn(() => true)
  element.releasePointerCapture = vi.fn()
  return element
}
function address(index: number) {
  const marker = model.markers[index]!
  return { testIndex: marker.testIndex, stepIndex: marker.stepIndex, subActionIndex: marker.subActionIndex }
}
function key(element: HTMLElement, value: string) {
  const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })
  act(() => element.dispatchEvent(event))
  expect(event.defaultPrevented).toBe(true)
}

test('TIMELINE-SNAP-FRAMES-NEAREST', () => {
  render()
  const element = track()
  pointer(element, 'pointerdown', 208)
  expect(change).toHaveBeenLastCalledWith(address(1))
  expect(element.setPointerCapture).toHaveBeenCalledWith(7)
  pointer(element, 'pointermove', 330)
  expect(change).toHaveBeenLastCalledWith(address(3))
  pointer(element, 'pointerup', 330)
  expect(element.releasePointerCapture).toHaveBeenCalledWith(7)
  pointer(element, 'pointermove', 60)
  expect(change).toHaveBeenLastCalledWith(address(3))
  expect(seek).not.toHaveBeenCalled()
})
test('TIMELINE-SNAP-VIDEO-FREE', () => {
  render({ source: 'video' })
  const element = track()
  pointer(element, 'pointerdown', 72)
  expect(change).toHaveBeenLastCalledWith(address(0))
  expect(seek).toHaveBeenLastCalledWith(0.125, expect.objectContaining(address(0)))
  pointer(element, 'pointermove', 210)
  expect(seek).toHaveBeenLastCalledWith(0.5)
  expect(change).toHaveBeenLastCalledWith(address(1))
  pointer(element, 'pointercancel', 210)
  pointer(element, 'pointermove', 400)
  expect(seek).toHaveBeenLastCalledWith(0.5)
})
test('TIMELINE-KEYS-ON-THUMB', () => {
  render({ playhead: model.markers[1]! })
  const slider = query('[role="slider"]')
  key(slider, 'ArrowRight'); expect(change).toHaveBeenLastCalledWith(address(2))
  key(slider, 'ArrowLeft'); expect(change).toHaveBeenLastCalledWith(address(0))
  key(slider, 'Home'); expect(change).toHaveBeenLastCalledWith(address(0))
  key(slider, 'End'); expect(change).toHaveBeenLastCalledWith(address(3))
  key(slider, 'PageDown'); expect(change).toHaveBeenLastCalledWith(address(2))
  render({ playhead: model.markers[3]! })
  key(query('[role="slider"]'), 'PageUp'); expect(change).toHaveBeenLastCalledWith(address(0))
  const calls = change.mock.calls.length
  act(() => query('[data-timeline]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
  expect(change).toHaveBeenCalledTimes(calls)
})









test('TIMELINE-MARKERS retains one pill thumb and accessible icons without permanent counts', () => {
  render({ playhead: model.markers[2]! })
  expect(host.querySelectorAll('[role="slider"]')).toHaveLength(1)
  expect(query('[role="slider"]').getAttribute('aria-valuenow')).toBe('63')
  expect(host.textContent).toBe('')
  expect(host.querySelectorAll('[data-timeline-marker] svg')).toHaveLength(4)
  expect(host.querySelectorAll('[data-timeline-stem]')).toHaveLength(0)
  expect(host.querySelectorAll('[data-timeline-circle]')).toHaveLength(4)
  render({ source: 'video', observedPosition: 0.5, playhead: model.markers[2]! })
  expect(query('[aria-current="step"]').dataset.timelineMarker).toBe('3')
  expect(host.querySelectorAll('[data-timeline-signals], [data-timeline-readout], [data-timeline-segment]')).toHaveLength(0)
  render({ model: { ...model, markers: [], segments: [], playhead: null }, playhead: null })
  expect(query('[data-timeline]')).toBeNull()
})

test('TIMELINE-MARKER-DETAILS and coincident groups preserve masked reachable actions', async () => {
  render({ source: 'video' })
  const marker = query('[data-timeline-marker="1"]')
  expect(marker.getAttribute('aria-label')).toContain('Step 1')
  expect(marker.getAttribute('aria-label')).toContain('Filled')
  expect(marker.getAttribute('aria-label')).toContain('Filled with [secret:PW]')
  await act(async () => { marker.focus() })
  expect(document.querySelector('[role="tooltip"], [data-timeline-marker-details]')).toBeNull()
  act(() => marker.click())
  expect(change).toHaveBeenLastCalledWith(address(0))
  expect(seek).toHaveBeenLastCalledWith(model.markers[0]!.position, expect.objectContaining(address(0)))
  const coincident = { ...model, markers: model.markers.map(entry => ({ ...entry, position: 0.5 })) }
  render({ model: coincident })
  expect(host.querySelectorAll('[data-timeline-marker-group]')).toHaveLength(1)
  expect(host.querySelectorAll('[data-timeline-marker]')).toHaveLength(0)
  act(() => query('[data-timeline-marker-group]').click())
  const options = document.querySelectorAll<HTMLButtonElement>('[data-slot="popover-content"] [data-timeline-marker]')
  expect(options).toHaveLength(4)
  act(() => options[2]!.click())
  expect(change).toHaveBeenLastCalledWith(address(2))
})

test('a group list closed with Escape hands focus back to its trigger, but not away from a group list opened before the hand-back', async () => {
  render({ model: { ...model, markers: model.markers.map((entry, index) => ({ ...entry, position: index < 2 ? 0.25 : 0.75 })) } })
  const [first, second] = [...host.querySelectorAll<HTMLButtonElement>('[data-timeline-marker-group]')]
  const focusedEntry = () => document.activeElement?.closest('[data-slot="popover-content"]') ? document.activeElement.getAttribute('data-timeline-marker') : null
  const escape = () => act(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  const handBack = () => act(() => new Promise(resolve => setTimeout(resolve, 0)))
  act(() => first!.click())
  expect(focusedEntry()).toBe('1')
  escape()
  await handBack()
  expect(document.activeElement).toBe(first)
  act(() => first!.click())
  escape()
  // jsdom runs no exit animation, so the first list is gone at once and its hand-back is still to come.
  expect(document.querySelector('[data-slot="popover-content"]')).toBeNull()
  act(() => second!.click())
  expect(focusedEntry()).toBe('3')
  await handBack()
  expect([...document.querySelectorAll('[data-slot="popover-content"] [data-timeline-marker]')].map(entry => entry.getAttribute('data-timeline-marker'))).toEqual(['3', '4'])
  expect(focusedEntry()).toBe('3')
})
