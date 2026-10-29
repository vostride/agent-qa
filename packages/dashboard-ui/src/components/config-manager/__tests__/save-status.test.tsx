// @vitest-environment jsdom

// `SaveStatus` renders what `deriveSaveStatus` answers; precedence is tested in config-autosave.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SaveStatus } from '@/components/config-manager/save-status'
import type { ConfigSaveStatus } from '@/lib/config-autosave'
import {
  NOT_SAVED_ACTION_NAME,
  RETRY_LABEL,
  SAVE_STATUS_WORDS,
  UNDO_LABEL,
  undoLine,
} from '@/lib/config-copy'
import { SAVE_STATES, type SaveState } from '@/lib/config-tabs'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const LONG_NAME = 'openrouter-anthropic-claude-sonnet-4-with-a-very-long-registered-model-name'

const STATUSES: Record<SaveState, ConfigSaveStatus> = {
  idle: { state: 'idle', failingFieldKeys: [] },
  saving: { state: 'saving', failingFieldKeys: [] },
  saved: { state: 'saved', failingFieldKeys: [] },
  draft: { state: 'draft', failingFieldKeys: [] },
  failed: { state: 'failed', failingFieldKeys: ['["use","timeout","step"]'] },
  undo: {
    state: 'undo',
    failingFieldKeys: [],
    undo: { line: undoLine('delete-model', 'gpt'), name: 'gpt', token: 'u1' },
  },
}

let container: HTMLDivElement
let root: Root
const handlers = { onRetry: vi.fn(), onUndo: vi.fn(), onGoToDraft: vi.fn() }

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  handlers.onRetry.mockReset()
  handlers.onUndo.mockReset()
  handlers.onGoToDraft.mockReset()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

function show(status: ConfigSaveStatus) {
  act(() => {
    root.render(<SaveStatus status={status} {...handlers} />)
  })
}

function statusElement(): HTMLElement {
  const element = container.querySelector<HTMLElement>('[data-save-status]')
  if (element === null) throw new Error('no data-save-status element')
  return element
}

function liveRegion(): HTMLElement {
  const regions = container.querySelectorAll<HTMLElement>('[role="status"]')
  expect(regions).toHaveLength(1)
  return regions[0]!
}

function glyphs(): string[] {
  return [...statusElement().querySelectorAll('svg')].flatMap((svg) =>
    [...svg.classList].filter((name) => name.startsWith('lucide-')),
  )
}

function button(name: string): HTMLButtonElement {
  const found = [...statusElement().querySelectorAll('button')].find(
    (candidate) => (candidate.getAttribute('aria-label') ?? candidate.textContent) === name,
  )
  if (found === undefined) throw new Error(`no button named ${name}`)
  return found
}

describe('the save status faces', () => {
  it('SAVE-STATUS-TONES: each of the six states renders its data attribute, word and glyph', () => {
    expect(Object.keys(STATUSES)).toEqual([...SAVE_STATES])

    show(STATUSES.idle)
    expect(statusElement().dataset.saveStatus).toBe('idle')
    expect(statusElement().textContent).toBe('')
    expect(glyphs()).toEqual([])

    show(STATUSES.saving)
    expect(statusElement().dataset.saveStatus).toBe('saving')
    expect(statusElement().textContent).toBe(SAVE_STATUS_WORDS.saving)
    expect(glyphs()).toContain('lucide-loader-circle')
    expect(statusElement().querySelector('.text-muted-foreground')?.textContent).toBe(
      SAVE_STATUS_WORDS.saving,
    )

    show(STATUSES.saved)
    expect(statusElement().dataset.saveStatus).toBe('saved')
    expect(statusElement().textContent).toBe(SAVE_STATUS_WORDS.saved)
    expect(glyphs()).toContain('lucide-check')

    show(STATUSES.draft)
    expect(statusElement().dataset.saveStatus).toBe('draft')
    expect(statusElement().textContent).toBe(SAVE_STATUS_WORDS.draft)
    expect(glyphs()).toEqual([])
    const dot = statusElement().querySelector('[data-save-status-dot]')
    expect(dot?.classList.contains('bg-amber-500')).toBe(true)
    expect(dot?.classList.contains('size-2')).toBe(true)
    const notSaved = button(NOT_SAVED_ACTION_NAME)
    expect(notSaved.dataset.variant).toBe('link')
    act(() => notSaved.click())
    expect(handlers.onGoToDraft).toHaveBeenCalledTimes(1)

    show(STATUSES.failed)
    expect(statusElement().dataset.saveStatus).toBe('failed')
    expect(statusElement().textContent).toBe(`${SAVE_STATUS_WORDS.failed}·${RETRY_LABEL}`)
    expect(glyphs()).toContain('lucide-circle-alert')
    expect(statusElement().querySelector('.text-destructive:not(svg)')?.textContent).toBe(
      SAVE_STATUS_WORDS.failed,
    )
    const retry = button(RETRY_LABEL)
    expect(retry.dataset.variant).toBe('link')
    act(() => retry.click())
    expect(handlers.onRetry).toHaveBeenCalledTimes(1)

    show(STATUSES.undo)
    expect(statusElement().dataset.saveStatus).toBe('undo')
    expect(statusElement().textContent).toBe(`Deleted gpt·${UNDO_LABEL}`)
    expect(glyphs()).toEqual([])
    const undo = button(UNDO_LABEL)
    expect(undo.dataset.variant).toBe('link')
    act(() => undo.click())
    expect(handlers.onUndo).toHaveBeenCalledTimes(1)

    expect(container.querySelector('[data-sonner-toaster]')).toBeNull()
  })

  it('IDLE-KEEPS-BOX: idle renders an empty slot with the same box as every other state', () => {
    show(STATUSES.idle)
    const idle = statusElement()
    expect(idle.childNodes).toHaveLength(0)
    const idleBox = idle.className
    expect(idleBox).toContain('min-h-6')
    expect(idleBox).toContain('shrink-0')
    for (const state of SAVE_STATES) {
      show(STATUSES[state])
      expect(statusElement().className, state).toBe(idleBox)
    }
  })
})

describe('the polite region', () => {
  it('SAVING-NOT-ANNOUNCED: Saving never reaches the polite region', () => {
    show(STATUSES.saving)
    expect(liveRegion().textContent).toBe('')
    expect(liveRegion().getAttribute('aria-live')).toBe('polite')
    expect(liveRegion().getAttribute('aria-atomic')).toBe('true')
    expect(liveRegion().classList.contains('sr-only')).toBe(true)

    show(STATUSES.saved)
    show(STATUSES.saving)
    expect(liveRegion().textContent).toBe('')
  })

  it("ANNOUNCES-ONCE: Saved, Not saved, Couldn't save and each Undo line are announced once as they appear", async () => {
    show(STATUSES.idle)
    const focused = document.activeElement

    const heard: string[] = []
    const region = liveRegion()
    const observer = new MutationObserver(() => {
      const text = region.textContent ?? ''
      if (text !== '') heard.push(text)
    })
    observer.observe(region, { childList: true, characterData: true, subtree: true })
    const flush = async () => {
      await act(async () => {
        await Promise.resolve()
      })
    }

    show(STATUSES.saved)
    await flush()
    show({ ...STATUSES.saved })
    await flush()
    show({ ...STATUSES.saved, failingFieldKeys: [] })
    await flush()
    expect(heard).toEqual([SAVE_STATUS_WORDS.saved])

    show(STATUSES.draft)
    await flush()
    show({ ...STATUSES.draft })
    await flush()
    show(STATUSES.failed)
    await flush()
    show({ ...STATUSES.failed })
    await flush()
    show(STATUSES.undo)
    await flush()
    show({ ...STATUSES.undo })
    await flush()
    const second = { line: undoLine('delete-target', 'staging'), name: 'staging', token: 'u2' }
    show({ state: 'undo', failingFieldKeys: [], undo: second })
    await flush()
    observer.disconnect()

    expect(heard).toEqual([
      SAVE_STATUS_WORDS.saved,
      SAVE_STATUS_WORDS.draft,
      SAVE_STATUS_WORDS.failed,
      'Deleted gpt',
      'Deleted target staging',
    ])
    expect(document.activeElement).toBe(focused)
  })
})

describe('long text and motion', () => {
  it('UNDO-LINE-FULL-NAME: a long name truncates at max-w-40 and the full sentence is the accessible name', () => {
    const line = undoLine('delete-model', LONG_NAME)
    show({ state: 'undo', failingFieldKeys: [], undo: { line, name: LONG_NAME, token: 'u3' } })

    const lineElement = statusElement().querySelector<HTMLElement>('[data-save-undo-line]')
    expect(lineElement?.getAttribute('aria-label')).toBe(`Deleted ${LONG_NAME}`)
    const name = statusElement().querySelector<HTMLElement>('[data-save-undo-name]')
    expect(name?.textContent).toBe(LONG_NAME)
    expect(name?.classList.contains('max-w-40')).toBe(true)
    expect(name?.classList.contains('truncate')).toBe(true)
    expect(liveRegion().textContent).toBe(line)
  })

  it('REDUCED-MOTION-STILL: the spinner spins only under motion-safe and the Saved fade is instant under reduced motion', () => {
    show(STATUSES.saving)
    const spinner = statusElement().querySelector('svg.lucide-loader-circle')
    expect(spinner?.classList.contains('motion-safe:animate-spin')).toBe(true)
    expect(spinner?.classList.contains('animate-spin')).toBe(false)

    show(STATUSES.saved)
    const saved = statusElement().querySelector<HTMLElement>('[data-save-status-saved]')
    expect(saved?.classList.contains('transition-opacity')).toBe(true)
    expect(saved?.classList.contains('duration-300')).toBe(true)
    expect(saved?.classList.contains('motion-reduce:transition-none')).toBe(true)
  })

  it('SAVED-FADES-OUT: after saved turns idle the word fades out, hidden from assistive tech, then the slot empties', () => {
    vi.useFakeTimers()
    show(STATUSES.saved)
    show(STATUSES.idle)
    const ghost = statusElement().querySelector<HTMLElement>('[data-save-status-saved]')
    expect(ghost?.classList.contains('opacity-0')).toBe(true)
    expect(ghost?.getAttribute('aria-hidden')).toBe('true')
    expect(liveRegion().textContent).toBe('')
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(statusElement().childNodes).toHaveLength(0)
  })
})
