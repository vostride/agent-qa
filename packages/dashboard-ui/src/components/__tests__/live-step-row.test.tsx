// @vitest-environment jsdom

// A live step row is one status glyph and the label; each status has its own shape, tone and name.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import { LIVE_STEP_GLYPHS, LiveStepRowView } from '@/components/live-step-row'
import { LIVE_STEP_STATUS_NAMES, liveLabelText } from '@/lib/live-step-row'
import { STEP_STATUSES, type LiveStepRow, type StepStatus } from '@/lib/run-stream-reducer'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Concatenated so this file cannot satisfy the deletion census by matching itself.
const TICKS_LABEL_ATTR = 'data-step-ticks' + '-label'
const CLOCK_PATTERN = /\d+:\d{2}/

// A label long enough to overflow any pane.
const LONG_LABEL =
  'Select "Show" from the navbar, scroll to the end and click more, wait for the list to finish loading, '
  + `then check that ${'every '.repeat(12)}card keeps its whole title and supercalifragilisticexpialidocious caption`

/** Any class that clips a label to one line or hides what does not fit. */
const CLIPPING_CLASS =
  /^(?:truncate|overflow-hidden|overflow-x-hidden|overflow-clip|overflow-x-clip|text-ellipsis|overflow-ellipsis|whitespace-nowrap|text-nowrap|line-clamp-.+)$/u

function clippingClasses(root: Element, skip: (element: Element) => boolean = () => false): string[] {
  return [root, ...root.querySelectorAll('*')]
    .filter((element) => !skip(element))
    .flatMap((element) =>
      [...element.classList].filter((token) => CLIPPING_CLASS.test(token)).map((token) => `${element.tagName}.${token}`),
    )
}

/** Any class that names motion, on the row or anything inside it. */
const ANIMATION_CLASS = /animate|breath|pulse/iu

function animationClasses(root: Element): string[] {
  return [root, ...root.querySelectorAll('*')].flatMap((element) =>
    [...element.classList].filter((token) => ANIMATION_CLASS.test(token)).map((token) => `${element.tagName}.${token}`),
  )
}

// THE NEEDLES ARE CONCATENATED so this file cannot satisfy a census of the removed motion by
// matching itself.
const REMOVED_ROW_KEYFRAMES = 'live-' + 'step'
const REMOVED_ROW_CLASS = 'live-step-' + 'breathing'

/** globals.css with its comments removed, so prose never answers for a rule. */
function stylesheetRules(): { css: string; rules: { selector: string; body: string }[]; reduced: string[] } {
  const css = readFileSync(resolve(__dirname, '../../styles/globals.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '')
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)].map((match) => ({
    selector: (match[1] ?? '').trim(),
    body: match[2] ?? '',
  }))
  const reduced: string[] = []
  for (const match of css.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/gu)) {
    let depth = 1
    let at = (match.index ?? 0) + match[0].length
    const start = at
    while (depth > 0 && at < css.length) {
      if (css[at] === '{') depth += 1
      if (css[at] === '}') depth -= 1
      at += 1
    }
    reduced.push(css.slice(start, at - 1))
  }
  return { css, rules, reduced }
}

let container: HTMLDivElement | null = null
let root: Root | null = null

function row(overrides: Partial<LiveStepRow> = {}): LiveStepRow {
  return {
    testIndex: 0,
    stepIndex: 0,
    status: 'running',
    text: 'click Save',
    startedAt: 1_000,
    ticks: 0,
    createdSeq: 1,
    ...overrides,
  }
}

function render(value: LiveStepRow): HTMLLIElement {
  if (!container) {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  }
  act(() => {
    root!.render(
      <ul>
        <LiveStepRowView row={value} />
      </ul>,
    )
  })
  const li = container.querySelector('li')
  if (!li) throw new Error('the row rendered no li')
  return li
}

/** The list the row was rendered into, for the cells where drawing no row is the claim. */
function renderList(value: LiveStepRow): HTMLUListElement {
  if (!container) {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  }
  act(() => {
    root!.render(
      <ul>
        <LiveStepRowView row={value} />
      </ul>,
    )
  })
  const list = container.querySelector('ul')
  if (!list) throw new Error('the list did not render')
  return list
}

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  container?.remove()
  container = null
})

describe('THE LIVE STEP ROW', () => {
  it('GLYPH-TABLE-TOTAL-AND-INJECTIVE: every status has a glyph and no two statuses share one', () => {
    expect(new Set(Object.keys(LIVE_STEP_GLYPHS))).toEqual(new Set(STEP_STATUSES))
    expect(new Set(Object.values(LIVE_STEP_GLYPHS)).size).toBe(STEP_STATUSES.length)
  })

  it('ROW-IS-GLYPH-AND-LABEL: each status renders a glyph and a label, and no clock, count or bar', () => {
    for (const status of STEP_STATUSES) {
      const li = render(
        row({ status, ticks: 7, startedAt: 1_000, durationMs: status === 'running' ? undefined : 65_000 }),
      )
      expect(li.children, status).toHaveLength(2)
      expect(li.textContent ?? '', status).not.toMatch(CLOCK_PATTERN)
      expect(li.textContent ?? '', status).not.toContain('action')
      expect(li.querySelector('[role="progressbar"]'), status).toBeNull()
      expect(li.querySelector(`[${TICKS_LABEL_ATTR}]`), status).toBeNull()
    }
  })

  it('RUNNING-GLYPH-STILL: the running glyph is a still blue shape, and a sub-action does not re-key it', () => {
    const first = render(row({ status: 'running', ticks: 3 }))
    const wrapperAt3 = first.children[0] as HTMLElement
    const glyph = wrapperAt3.querySelector('svg')
    expect(glyph?.classList.contains('text-blue-500'), 'the running glyph is blue').toBe(true)
    // Neither green nor a dot: the page's one green dot is the preview's.
    expect(glyph?.getAttribute('class') ?? '').not.toMatch(/emerald|green|live-dot/)
    expect(animationClasses(first)).toEqual([])
    expect(wrapperAt3.hasAttribute('data-step-motion')).toBe(false)
    expect(wrapperAt3.hasAttribute('data-motion-key')).toBe(false)
    expect(first.getAttribute('data-step-ticks')).toBe('3')

    const second = render(row({ status: 'running', ticks: 4 }))
    expect(second.children[0], 'a sub-action keeps the same glyph node').toBe(wrapperAt3)
    expect(second.getAttribute('data-step-ticks')).toBe('4')
    expect(animationClasses(second)).toEqual([])

    for (const status of STEP_STATUSES.filter((each) => each !== 'running')) {
      const li = render(row({ status, ticks: 4 }))
      expect(animationClasses(li), status).toEqual([])
      expect(li.querySelector('[data-step-motion]'), status).toBeNull()
      expect(li.querySelector('[data-motion-key]'), status).toBeNull()
    }
  })

  it('STATUS-NAME-NOT-COLOUR: every glyph carries its status name, so colour is never the only signal', () => {
    for (const status of STEP_STATUSES) {
      const li = render(row({ status }))
      const wrapper = li.children[0] as HTMLElement
      expect(wrapper.getAttribute('role'), status).toBe('img')
      expect(wrapper.getAttribute('aria-label'), status).toBe(LIVE_STEP_STATUS_NAMES[status as StepStatus])
    }
  })

  it('PLAIN-LABEL-UNCHANGED: a label with no placeholder renders as is', () => {
    expect(render(row({ text: 'click Save' })).textContent).toBe('click Save')
  })

  it('NO-STEP-PLACEHOLDER: a row with no text renders no element in any status, and no drawn row reads step N', () => {
    for (const status of STEP_STATUSES) {
      for (const text of ['', '   ', undefined as unknown as string]) {
        const list = renderList(row({ status, text, stepIndex: 2 }))
        expect(list.children, `${status} ${JSON.stringify(text)}`).toHaveLength(0)
        expect(list.textContent, `${status} ${JSON.stringify(text)}`).toBe('')
      }
    }
    const drawn = STEP_STATUSES.flatMap((status, stepIndex) =>
      ['', 'click Save'].map((text) => renderList(row({ status, text, stepIndex })).textContent ?? ''),
    )
    expect(drawn.filter((text) => text !== '')).toHaveLength(STEP_STATUSES.length)
    expect(drawn.filter((text) => /^step \d+$/iu.test(text))).toEqual([])
  })

  it('FULL-LABEL-WRAPS: in every status a long label wraps in full, and nothing in the row clips or ellipsises it', () => {
    for (const status of STEP_STATUSES) {
      const li = render(row({ status, text: LONG_LABEL }))
      expect(li.textContent, status).toBe(LONG_LABEL)
      expect(clippingClasses(li), status).toEqual([])
      const label = li.children[1] as HTMLElement
      expect(label.classList.contains('whitespace-normal'), `${status}: whitespace-normal`).toBe(true)
      expect(
        label.classList.contains('break-words') || label.classList.contains('[overflow-wrap:anywhere]'),
        `${status}: long words break`,
      ).toBe(true)
      expect(li.classList.contains('items-start'), `${status}: the row aligns its items to the start`).toBe(true)
      expect(li.classList.contains('items-center'), status).toBe(false)
    }
  })

  it('GLYPH-ON-FIRST-LINE: the glyph sits in a box one label line tall, centred, so it stays on the first line', () => {
    for (const status of STEP_STATUSES) {
      const li = render(row({ status, text: LONG_LABEL }))
      const wrapper = li.children[0] as HTMLElement
      const label = li.children[1] as HTMLElement
      const height = [...wrapper.classList].find((token) => /^h-\d+(?:\.\d+)?$/u.test(token))
      expect(height, `${status}: the glyph's box has a fixed height`).toBeDefined()
      const lineToken = `leading-${(height ?? 'h-none').slice(2)}`
      expect(label.classList.contains(lineToken), `${status}: the label's line is ${lineToken}`).toBe(true)
      expect(wrapper.classList.contains('items-center'), `${status}: the glyph is centred in its box`).toBe(true)
      expect(wrapper.classList.contains('shrink-0'), status).toBe(true)
      expect(wrapper.getAttribute('role'), status).toBe('img')
      expect(li.children, status).toHaveLength(2)
    }
  })

  it('NO-ROW-ANIMATION-CSS: globals.css has no live row keyframes, no breathing class and no reduced-motion rule for a row', () => {
    const { css, rules, reduced } = stylesheetRules()
    const keyframes = [...css.matchAll(/@keyframes\s+([\w-]+)/gu)].map((match) => match[1] ?? '')
    expect(keyframes.filter((name) => name.startsWith(REMOVED_ROW_KEYFRAMES))).toEqual([])
    expect(rules.filter((rule) => rule.selector.includes(`.${REMOVED_ROW_CLASS}`)).map((rule) => rule.selector)).toEqual([])
    expect(css.includes(REMOVED_ROW_CLASS)).toBe(false)
    const rowRulesUnderReducedMotion = reduced.flatMap((block) =>
      [...block.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
        .map((match) => (match[1] ?? '').trim())
        .filter((selector) => selector.includes('.live-step')),
    )
    expect(rowRulesUnderReducedMotion).toEqual([])
    // The control: the parser reads real rules, including the reduced-motion block the editor keeps.
    expect(keyframes.length).toBeGreaterThan(0)
    expect(reduced.some((block) => block.includes('.live-running-surface'))).toBe(true)
  })
})

// A live label is shown as written: an old numbered placeholder is its characters, with no chip.
describe('SECRET PLACEHOLDERS ON A LIVE ROW', () => {
  it('SECRET-PLACEHOLDER-AS-TEXT: an old <SECRET_n> placeholder is shown as written, with no chip', () => {
    const li = render(row({ status: 'running', text: 'type <SECRET_1> into Password' }))
    expect(li.children[1]?.textContent).toBe('type <SECRET_1> into Password')
    expect(li.querySelector('[data-masked]')).toBeNull()
  })

  it('LABEL-WRAPS-WHOLE: a long label with an old placeholder wraps in full, and nothing clips it', () => {
    const text = `type <SECRET_1> into the ${'very '.repeat(40)}long Password field`
    const li = render(row({ text }))
    const label = li.children[1] as HTMLElement
    for (const token of ['min-w-0', 'flex-1', 'whitespace-normal']) {
      expect(label.classList.contains(token), `${token} present`).toBe(true)
    }
    for (const token of ['overflow-hidden', 'items-center']) {
      expect(label.classList.contains(token), `${token} absent`).toBe(false)
    }
    expect(clippingClasses(li)).toEqual([])
    expect(label.textContent).toBe(text)
  })

  it('two placeholders and an email placeholder are shown as written, with no chip', () => {
    const text = 'sign in with <EMAIL_0> and <SECRET_1> then <SECRET_2>'
    const li = render(row({ text }))
    expect(li.children[1]?.textContent).toBe(text)
    expect(li.querySelector('[data-masked]')).toBeNull()
  })

  it('liveLabelText returns its input unchanged, old placeholders included', () => {
    for (const label of ['a <SECRET_1> b', '<EMAIL_12>', 'type [secret:PASSWORD]', 'click Save', '']) {
      expect(liveLabelText(label), label).toBe(label)
    }
    const source = readFileSync(resolve(__dirname, '../../lib/live-step-row.ts'), 'utf8')
    expect(source).not.toContain('@vostride/agent-qa-schema')
  })
})
