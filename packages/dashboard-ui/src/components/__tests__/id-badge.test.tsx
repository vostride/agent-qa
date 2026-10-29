// @vitest-environment jsdom
// 2026-10-03 (quick 261003-cpv, 432-UI-REVIEW priority fix 3 and pillars 3-5): the id badge reports
// a copy only after the clipboard write resolved, names its action, announces the result, and shares
// the record-id copy control's status pattern, check colour and type scale.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { IdBadge } from '@/components/id-badge'
import { RecordIdCopy } from '@/components/run-detail/record-id-copy'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const VALUE = 's_0123456789abcdef0123'
let container: HTMLDivElement
let root: Root

function mount(element: React.ReactElement) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root.render(element))
}

function setClipboard(writeText: ((text: string) => Promise<void>) | undefined) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: writeText === undefined ? undefined : { writeText },
  })
}

beforeEach(() => setClipboard(undefined))
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

async function click(button: HTMLElement) {
  await act(async () => {
    button.click()
    await Promise.resolve()
  })
}

describe("the copy button's label and type size", () => {
  it('names its action and stays on the type scale', () => {
    mount(<IdBadge label="S" value={VALUE} />)
    const button = container.querySelector<HTMLElement>('button')!
    expect(button.getAttribute('aria-label')).toBe(`Copy S: ${VALUE}`)
    expect(container.innerHTML).not.toContain('text-[10px]')
    expect(container.querySelector('[role="status"]')).not.toBeNull()
  })

  it('a rejected write shows no success and announces the failure with the id', async () => {
    setClipboard(() => Promise.reject(new Error('blocked')))
    mount(<IdBadge label="S" value={VALUE} />)
    const button = container.querySelector<HTMLElement>('button')!
    await click(button)
    expect(button.getAttribute('data-copy-status')).toBe('failed')
    expect(container.querySelector('[role="status"]')?.textContent).toContain(VALUE)
    expect(container.querySelector('[role="status"]')?.textContent).toMatch(/Could not copy/)
  })

  it('a missing clipboard is a failure, not a success', async () => {
    mount(<IdBadge label="T" value={VALUE} />)
    const button = container.querySelector<HTMLElement>('button')!
    await click(button)
    expect(button.getAttribute('data-copy-status')).toBe('failed')
  })

  it('a resolved write shows the check and announces the copy', async () => {
    const writes: string[] = []
    setClipboard((text) => {
      writes.push(text)
      return Promise.resolve()
    })
    mount(<IdBadge label="S" value={VALUE} />)
    const button = container.querySelector<HTMLElement>('button')!
    await click(button)
    expect(writes).toEqual([VALUE])
    expect(button.getAttribute('data-copy-status')).toBe('copied')
    expect(container.querySelector('[role="status"]')?.textContent).toMatch(/copied/i)
  })

  it('both copy controls use one success colour and one icon size', async () => {
    setClipboard(() => Promise.resolve())
    mount(<><IdBadge label="S" value={VALUE} /><RecordIdCopy id="mem_1" /></>)
    for (const button of container.querySelectorAll<HTMLElement>('button')) await click(button)
    const checks = [...container.querySelectorAll('svg')].map((svg) => svg.getAttribute('class') ?? '')
    expect(checks).toHaveLength(2)
    for (const classes of checks) {
      expect(classes).toContain('text-success')
      expect(classes).toContain('size-3.5')
      expect(classes).not.toMatch(/emerald/)
    }
  })
})
