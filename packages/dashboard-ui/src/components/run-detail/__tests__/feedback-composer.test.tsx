// @vitest-environment jsdom
// THE COMPOSER SAYS WHAT IT IS ABOUT AND OFFERS THE THREE CHOICES, PICKING NONE.
//
// The order under a step follows the STEP's own verdict, so a passing step inside a failed test opens
// with "This should have failed". All three rows render in every composer state, none disabled, each
// radio described by its meaning line, and nothing is checked until the person picks. The heading and
// scope line paint producer names as text nodes, never markup.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mark, RunDetailMember, RunDetailProjection, RunDetailStep, RunsMarkPreviewResult } from '@vostride/agent-qa-schema'
import { RunsMarkPreviewResultSchema } from '@vostride/agent-qa-schema'
import { generateRunId } from '@vostride/agent-qa-ids'

import { FeedbackComposer, type FeedbackComposerProps } from '../feedback-composer'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  CHOICE_LEGEND,
  CHOICE_MEANINGS,
  FEEDBACK_CHOICE_ORDER,
  FEEDBACK_COMPOSER_STATES,
  SUBMIT_REASON_NO_CHOICE,
  TECHNICAL_DETAILS_LABEL,
  TECHNICAL_DETAILS_ROW_LABELS,
  feedbackAddress,
  feedbackPartsText,
  feedbackTargetView,
  type FeedbackTarget,
} from '@/lib/feedback-view'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const HOSTILE = '<img src=x onerror="globalThis.__pwned = true">'

function stepRow(testIndex: number, stepIndex: number, pass: boolean, stepText?: string): RunDetailStep {
  return {
    testIndex,
    stepIndex,
    ...(stepText === undefined ? {} : { stepText }),
    cacheStatus: 'miss',
    verifierVerdict: { pass, reasoning: '' },
    selfHealOccurred: false,
    briefDigest: 'digest',
  }
}

function member(testIndex: number, name: string, outcome: RunDetailMember['outcome']): RunDetailMember {
  return { testIndex, name, attempts: 1, ...(outcome === undefined ? {} : { outcome }) }
}

type Detail = Pick<RunDetailProjection, 'members' | 'steps'>

const singleFailed: Detail = {
  members: [member(0, 'checkout', 'failed')],
  steps: [stepRow(0, 0, true, 'open cart'), stepRow(0, 1, true, 'apply coupon'), stepRow(0, 2, false, 'pay')],
}

const suite: Detail = {
  members: [member(0, 'login', 'passed'), member(1, HOSTILE, 'failed')],
  steps: [stepRow(0, 0, true, 'sign in'), stepRow(1, 0, true, HOSTILE), stepRow(1, 1, false, 'pay')],
}

function props(detail: Detail, target: FeedbackTarget, overrides: Partial<FeedbackComposerProps> = {}): FeedbackComposerProps {
  const view = feedbackTargetView({ detail, target, runStatus: 'failed' })
  return {
    composerId: 'composer',
    headingId: 'composer-heading',
    state: 'composing',
    scope: target.stepIndex === undefined ? 'test' : 'step',
    target: feedbackAddress(target),
    outcomeClass: view.outcomeClass,
    heading: view.heading,
    scopeLine: view.scopeLine,
    selected: undefined,
    onChoose: vi.fn(),
    previewState: 'idle',
    previewCurrent: false,
    submitReason: SUBMIT_REASON_NO_CHOICE,
    onSubmit: vi.fn(),
    status: '',
    onClose: vi.fn(),
    ...overrides,
  }
}

let root: Root | undefined
let container: HTMLDivElement

function render(next: FeedbackComposerProps) {
  if (root === undefined) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  }
  act(() => root!.render(<TooltipProvider><FeedbackComposer {...next} /></TooltipProvider>))
}

afterEach(() => {
  if (root !== undefined) act(() => root!.unmount())
  root = undefined
  container.remove()
})

const rows = () => [...container.querySelectorAll<HTMLElement>('[data-feedback-choice]')]
const radios = () => [...container.querySelectorAll<HTMLElement>('[data-feedback-choice] [role="radio"]')]

describe('feedback composer', () => {
  it('CHOICE-ORDER-STEP-OWN-RESULT: a passing step in a failed test opens with should-have-failed; the failed test opens with should-have-passed', () => {
    render(props(singleFailed, { testIndex: 0, stepIndex: 1 }))
    expect(container.querySelector('[data-feedback-choices]')?.getAttribute('data-feedback-outcome-class')).toBe('passed')
    expect(rows().map((row) => row.getAttribute('data-feedback-choice'))).toEqual(['false-pass', 'confirmed-bug', 'false-fail'])
    expect(rows().map((row) => row.getAttribute('data-choice-position'))).toEqual(['1', '2', '3'])

    render(props(singleFailed, { testIndex: 0 }))
    expect(container.querySelector('[data-feedback-choices]')?.getAttribute('data-feedback-outcome-class')).toBe('failed')
    expect(rows().map((row) => row.getAttribute('data-feedback-choice'))).toEqual([...FEEDBACK_CHOICE_ORDER.failed])
    expect(rows()[0]?.getAttribute('data-feedback-choice')).toBe('false-fail')
  })

  it('ALL-THREE-ALWAYS-VISIBLE: three enabled rows in every state, each radio described by its meaning line', () => {
    for (const state of FEEDBACK_COMPOSER_STATES) {
      for (const target of [{ testIndex: 0 }, { testIndex: 0, stepIndex: 1 }]) {
        const next = props(singleFailed, target, { state })
        render(next)
        expect(rows()).toHaveLength(3)
        expect(container.querySelector('fieldset legend')?.textContent).toBe(CHOICE_LEGEND)
        for (const radio of radios()) {
          expect(radio.hasAttribute('disabled')).toBe(false)
          expect(radio.hasAttribute('data-disabled')).toBe(false)
          const kind = radio.closest('[data-feedback-choice]')!.getAttribute('data-feedback-choice') as keyof (typeof CHOICE_MEANINGS)['failed']
          const describedBy = radio.getAttribute('aria-describedby')
          expect(describedBy).toBeTruthy()
          expect(document.getElementById(describedBy!)?.textContent).toBe(CHOICE_MEANINGS[next.outcomeClass][kind])
        }
        expect(container.querySelectorAll('[data-feedback-choices] .truncate')).toHaveLength(0)
      }
    }
  })

  it('NO-CHOICE-PRESELECTED: nothing is checked on mount or after the target changes', () => {
    const onChoose = vi.fn()
    render(props(singleFailed, { testIndex: 0 }, { onChoose }))
    expect(radios().map((radio) => radio.getAttribute('aria-checked'))).toEqual(['false', 'false', 'false'])

    act(() => radios()[1]!.click())
    expect(onChoose).toHaveBeenCalledExactlyOnceWith(FEEDBACK_CHOICE_ORDER.failed[1])

    render(props(singleFailed, { testIndex: 0 }, { onChoose, selected: 'confirmed-bug' }))
    expect(radios().map((radio) => radio.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false'])

    render(props(singleFailed, { testIndex: 0, stepIndex: 1 }, { onChoose }))
    expect(radios().map((radio) => radio.getAttribute('aria-checked'))).toEqual(['false', 'false', 'false'])
  })

  it('HEADING-AND-SCOPE-RENDERED: the heading and scope line read the view parts, and producer markup stays text', () => {
    for (const target of [{ testIndex: 1, stepIndex: 0 }, { testIndex: 1 }, { testIndex: 0, stepIndex: 0 }]) {
      const next = props(suite, target)
      render(next)
      const heading = container.querySelector('h2')!
      expect(heading.id).toBe('composer-heading')
      expect(heading.textContent).toBe(feedbackPartsText(next.heading))
      expect(heading.className).toContain('break-words')
      expect(container.querySelector('[data-feedback-scope-line]')?.textContent).toBe(feedbackPartsText(next.scopeLine))
      expect(container.querySelector('img')).toBeNull()
      expect(container.querySelectorAll('.truncate')).toHaveLength(0)
    }
    expect(container.querySelector('h2')?.textContent).toContain('sign in')
    render(props(suite, { testIndex: 1, stepIndex: 0 }))
    expect(container.querySelector('h2')?.textContent).toContain(HOSTILE)
    expect(container.querySelector('[data-feedback-scope-line]')?.textContent).toContain(HOSTILE)
    expect((globalThis as { __pwned?: boolean }).__pwned).toBeUndefined()
  })
})

// MACHINERY IS ONE DISCLOSURE AWAY (426-08 · D-13, SC2). The internal mark words and every id live only
// under a collapsed Technical details, each row present only when its fact exists; everything else in
// the composer speaks in plain words.
const RUN_ID = generateRunId()
const MARKS: readonly Mark[] = ['false-fail', 'false-pass', 'confirmed-bug']
const INTERNAL_WORD = new RegExp(`(^|[^\\w-])(${MARKS.join('|')})(?![\\w-])`)

function consequencesFor(kind: Mark, over: Record<string, unknown> = {}): RunsMarkPreviewResult {
  return RunsMarkPreviewResultSchema.parse({
    kind: 'consequences',
    runId: RUN_ID,
    prospective: true,
    markKind: kind,
    member: { testIndex: 0, testId: 't_checkout' },
    resolvedStep: { stepIndex: 2, reason: 'step-mark' },
    latest: { kind: 'supersedes', markId: 'mark_0123456789ab', ordinal: 4 },
    basis: { ledgerOrdinal: 7, priorMarkOrdinal: 4 },
    knowledge: {
      servedRecordIds: ['rec_alpha', 'rec_beta'],
      appendsEvidence: true,
      records: ['rec_alpha', 'rec_beta'].map(recordId => ({
        recordId, served: true, contentAbsence: { reason: 'not-found' }, evidence: { kind: 'effects', effects: [{ direction: 'confirm' }] },
      })),
      evidence: { confirmed: 2, overturned: 0 },
    },
    draft: kind === 'confirmed-bug'
      ? { kind: 'confirmed-bug' }
      : { kind: 'no-draftable-fix', checked: { servedRecords: 2, procedureReads: 0, assertionDrift: false } },
    ...over,
  })
}

function technicalTrigger() {
  return [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === TECHNICAL_DETAILS_LABEL)
}
function openTechnical() {
  const trigger = technicalTrigger()
  expect(trigger, 'no Technical details trigger').not.toBeUndefined()
  act(() => trigger!.click())
}
const technicalRows = () =>
  [...container.querySelectorAll<HTMLElement>('[data-feedback-technical] [data-technical-row]')].map(dd => [
    dd.getAttribute('data-technical-row'),
    dd.previousElementSibling?.textContent,
    [...dd.children].length > 0 ? [...dd.children].map(child => child.textContent) : dd.textContent,
  ])
function textNodes(root: Element): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) nodes.push(node as Text)
  return nodes
}

describe('Technical details', () => {
  it('TECHNICAL-DETAILS-ROWS: collapsed by default; opened, one row per fact the mark has, in the locked order and words', () => {
    render(props(singleFailed, { testIndex: 0, stepIndex: 2 }, {
      selected: 'false-pass',
      previewState: 'consequences',
      previewCurrent: true,
      previewRead: consequencesFor('false-pass'),
      testId: 't_checkout',
    }))
    expect(technicalTrigger()?.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('[data-feedback-technical]')).toBeNull()

    openTechnical()
    const content = container.querySelector('[data-feedback-technical]')
    expect(content, 'no Technical details content').not.toBeNull()
    expect(content!.className).toContain('bg-muted/40')
    expect(technicalRows()).toEqual([
      ['kind', TECHNICAL_DETAILS_ROW_LABELS.kind, 'false-pass'],
      ['address', TECHNICAL_DETAILS_ROW_LABELS.address, '0:2'],
      ['testId', TECHNICAL_DETAILS_ROW_LABELS.testId, 't_checkout'],
      ['records', TECHNICAL_DETAILS_ROW_LABELS.records, 'rec_alpha, rec_beta'],
      ['basis', TECHNICAL_DETAILS_ROW_LABELS.basis, 'ledger ordinal 7 · prior mark #4'],
    ])
    for (const dd of content!.querySelectorAll('dd')) {
      for (const cls of ['font-mono', 'break-all', 'select-text']) expect(dd.className).toContain(cls)
      expect(dd.previousElementSibling?.tagName).toBe('DT')
      expect(dd.previousElementSibling?.className).toContain('text-muted-foreground')
    }
  })

  it('TECHNICAL-DETAILS-ROWS: an absent fact has no row — no choice, no read and no test id leave only the address', () => {
    render(props(singleFailed, { testIndex: 0 }))
    openTechnical()
    expect(technicalRows()).toEqual([['address', TECHNICAL_DETAILS_ROW_LABELS.address, '0:run']])

    const quarantined = RunsMarkPreviewResultSchema.parse({
      kind: 'quarantined', runId: RUN_ID, prospective: true, markKind: 'false-fail', member: { testIndex: 0 },
      resolvedStep: { stepIndex: 2, reason: 'failing-step' }, latest: { kind: 'first' }, basis: { ledgerOrdinal: 3 }, class: 'timeout',
    })
    render(props(singleFailed, { testIndex: 0 }, { selected: 'false-fail', previewState: 'quarantined', previewCurrent: true, previewRead: quarantined }))
    expect(technicalRows()).toEqual([
      ['kind', TECHNICAL_DETAILS_ROW_LABELS.kind, 'false-fail'],
      ['address', TECHNICAL_DETAILS_ROW_LABELS.address, '0:run'],
      ['basis', TECHNICAL_DETAILS_ROW_LABELS.basis, 'ledger ordinal 3'],
    ])

    render(props(singleFailed, { testIndex: 0 }, {
      selected: 'false-fail', previewState: 'consequences', previewCurrent: false, previewRead: consequencesFor('false-fail'),
    }))
    expect(technicalRows().map(([row]) => row)).toEqual(['kind', 'address'])
  })

  it.each(MARKS)('NO-INTERNAL-NAME-IN-COPY: with %s picked and its preview on screen, no text outside Technical details names a mark kind', (kind) => {
    render(props(singleFailed, { testIndex: 0 }, {
      selected: kind,
      previewState: 'consequences',
      previewCurrent: true,
      previewRead: consequencesFor(kind),
      previewReplacesTime: 'Sep 23, 10:41',
      testId: 't_checkout',
      submitReason: '',
    }))
    openTechnical()
    const composer = container.querySelector('[data-feedback-composer]')!
    const outside = textNodes(composer).filter(node => node.parentElement?.closest('[data-feedback-technical]') == null)
    expect(outside.length).toBeGreaterThan(0)
    const leaked = outside.map(node => node.textContent ?? '').filter(text => INTERNAL_WORD.test(text))
    expect(leaked, `internal mark names outside Technical details: ${leaked.join(' | ')}`).toEqual([])
    const technical = container.querySelector('[data-feedback-technical]')
    expect(technical, 'no Technical details content').not.toBeNull()
    expect(textNodes(technical!).map(node => node.textContent)).toContain(kind)
  })
})

// THE MARK'S APPROVAL, INLINE (426-10 · D-20, SC4). The question the policy gate asked before a mark
// was recorded sat in the composer's footer as a labelled group — never a dialog, never modal.
//
// RE-SPELLED 2026-10-01: the question, the group and the state a mark waited in are
// deleted. Each cell keeps its name and now pins the absence in the real composer, in every state it
// can be in: no group, no answers, nothing that takes focus, and the submit row always present.
const approvalSurface = () => container.querySelector('[data-feedback-approval], [data-confirm-answer], [data-confirm-outcome], [data-feedback-approval-waiting]')

describe('the inline approval region', () => {
  it('APPROVAL-IS-A-GROUP: a labelled group with the shipped title, the action class in mono and the preview as text', () => {
    for (const state of FEEDBACK_COMPOSER_STATES) {
      render(props(singleFailed, { testIndex: 0, stepIndex: 2 }, { state, selected: 'false-fail' }))
      expect(approvalSurface(), `an approval surface rendered in ${state}`).toBeNull()
      expect(container.querySelectorAll('[role="group"][aria-labelledby]')).toHaveLength(0)
      expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0)
      expect(document.querySelectorAll('[aria-modal]')).toHaveLength(0)
    }
  })

  it('APPROVAL-HINTS-VISIBLE: three rows, each an answer button described by its visible hint, none with a title', () => {
    for (const state of FEEDBACK_COMPOSER_STATES) {
      render(props(singleFailed, { testIndex: 0 }, { state, selected: 'false-fail', submitReason: '' }))
      expect(container.querySelectorAll('[data-confirm-answer]')).toHaveLength(0)
      const submit = container.querySelector<HTMLElement>('[data-feedback-submit]')
      expect(submit, `the submit row is missing in ${state}`).not.toBeNull()
      expect(submit!.getAttribute('aria-describedby')).toBeTruthy()
    }
  })

  it('APPROVAL-FOCUS-YES: focus moves to Yes when the region appears', () => {
    const elsewhere = document.createElement('button')
    document.body.append(elsewhere)
    elsewhere.focus()
    render(props(singleFailed, { testIndex: 0 }, { state: 'submitting', selected: 'false-fail' }))
    expect(document.activeElement, 'a submitting composer took focus').toBe(elsewhere)
    elsewhere.remove()
  })

  it('APPROVAL-OUTCOME-LINE: a resolved question shows the shipped outcome line and no answers', () => {
    render(props(singleFailed, { testIndex: 0 }, {
      state: 'retained',
      selected: 'false-fail',
      submitReason: '',
      status: 'Draft kept.',
      denial: { reason: 'The mark could not be recorded here.' },
    }))
    expect(container.querySelector('[data-feedback-denied]')?.textContent).toContain('The mark could not be recorded here.')
    expect(container.querySelector('[data-confirm-outcome]')).toBeNull()
    expect(container.querySelector('[data-feedback-submit]')).not.toBeNull()
  })
})
