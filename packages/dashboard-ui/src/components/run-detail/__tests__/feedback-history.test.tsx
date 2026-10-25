// @vitest-environment jsdom
// WHAT HAPPENED AND WHAT COUNTS (426-09 · D-22, D-23).
//
// The pinned target's marks come first, newest first; the whole ledger is one collapsed disclosure
// away with each entry naming its target. Latest-mark-wins replacement is explained once, an applied
// fix states in one line what it changed (432-09 · D-25), and every way the history read can fail
// renders as itself — never as "no feedback". Fixtures are schema-parsed.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MarkDisposition, MarkHistoryChangedRecord, RunDetailProjection } from '@vostride/agent-qa-schema'
import { MARKS, RunsMarksHistoryResultSchema } from '@vostride/agent-qa-schema'
import { generateRunId } from '@vostride/agent-qa-ids'

import { FeedbackHistory, type FeedbackHistoryProps } from '../feedback-history'
import type { FeedbackReadFailure, MarksHistoryRead } from '@/lib/api'
import {
  ACTIVE_TEXT,
  CHOICE_LABELS,
  HISTORY_EMPTY_TEXT,
  HISTORY_READ_FAILED_TEXT,
  HISTORY_RETRY_ACCESSIBLE_NAME,
  REPLACEMENT_EXPLANATION,
  appliedChangeText,
  appliedChangeView,
  dispositionText,
  feedbackPartsText,
  feedbackReadFailureReason,
  formatMarkTime,
  historyChangeText,
  historyStateText,
  historyTargetLabel,
  historyTitle,
  replacedByText,
  runHistoryLabel,
} from '@/lib/feedback-view'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const RUN_ID = generateRunId()
const HOSTILE = '<img src=x onerror="globalThis.__pwned = true">'
const markId = (n: number) => `mark_${n.toString(16).padStart(12, '0')}`
const T = (minute: number) => Date.UTC(2026, 8, 23, 10, minute)

const NO_FIX = { kind: 'no-draftable-fix', checked: { servedRecords: 0, procedureReads: 0, assertionDrift: false } } as const
const applied = (recordIds: readonly string[] = ['mem_caution_1']): MarkDisposition =>
  ({ kind: 'applied', fix: 'caution', change: { kind: 'knowledge', changeId: 'prop_0123456789ab', recordIds: [...recordIds] } })
const CAUTION = {
  content: 'The coupon field refuses expired codes.',
  summary: 'coupon refused',
  kind: 'caution',
  applicability: { product: 'shop', scope: 'shop', anchors: [] as string[], openedAtOrdinal: 1 },
  currentStatus: 'active',
  currentTrust: { confirmations: 1, contradictions: 0, evidenceTokens: [] as string[], lastEventOrdinal: 1 },
} as const
const changed = (content: string = CAUTION.content): MarkHistoryChangedRecord[] =>
  [{ recordId: 'mem_caution_1', recordContent: { ...CAUTION, content } }]

type EntryInput = Record<string, unknown> & { n: number }

function ledger(entries: readonly EntryInput[]): MarksHistoryRead {
  return {
    kind: 'read',
    result: RunsMarksHistoryResultSchema.parse({
      kind: 'history',
      runId: RUN_ID,
      entries: entries.map(({ n, ...entry }) => ({
        markId: markId(n),
        runId: RUN_ID,
        testIndex: 0,
        kind: 'false-fail',
        origin: 'user',
        ordinal: n,
        markedAt: T(n),
        disposition: NO_FIX,
        evidence: { confirmed: 0, overturned: 0 },
        active: true,
        ...entry,
      })),
    }),
  }
}

function arm(value: Record<string, unknown>): MarksHistoryRead {
  return { kind: 'read', result: RunsMarksHistoryResultSchema.parse({ runId: RUN_ID, ...value }) }
}

const detail: Pick<RunDetailProjection, 'members' | 'steps'> = {
  members: [{ testIndex: 0, attempts: 1, name: 'checkout', totalSteps: 3 }],
  steps: ['open cart', 'apply coupon', 'pay'].map((stepText, stepIndex) => ({
    testIndex: 0,
    stepIndex,
    stepText,
    cacheStatus: 'miss' as const,
    verifierVerdict: { pass: false, reasoning: '' },
    selfHealOccurred: false,
    briefDigest: 'd',
  })),
}

// Two marks on step 2 (0:1), the older replaced by the newer, and one on the whole test between them.
const TWO_ON_STEP = ledger([
  { n: 1, stepIndex: 1, kind: 'false-fail', active: false, supersededBy: markId(3) },
  { n: 2, kind: 'confirmed-bug', disposition: { kind: 'confirmed-bug', confirmedRecords: 0 } },
  {
    n: 3,
    stepIndex: 1,
    kind: 'false-pass',
    supersedes: markId(1),
    note: 'The coupon should have been refused',
    disposition: applied(),
    changedRecords: changed(),
  },
])

let container: HTMLDivElement
let root: Root

function mount(overrides: Partial<FeedbackHistoryProps> = {}) {
  const onRetry = vi.fn()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const props: FeedbackHistoryProps = { scope: 'step', address: '0:1', read: TWO_ON_STEP, detail, onRetry, ...overrides }
  act(() => root.render(<FeedbackHistory {...props} />))
  return onRetry
}

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const q = <T extends Element = HTMLElement>(selector: string) => container.querySelector<T>(selector)
const entryIds = (list: Element | null) =>
  [...(list?.querySelectorAll('[data-history-entry]') ?? [])].map((entry) => entry.getAttribute('data-mark-id'))
const entryOf = (list: Element | null, id: string) => list?.querySelector<HTMLElement>(`[data-history-entry][data-mark-id="${id}"]`) ?? null
const runTrigger = () => q('[data-feedback-history="run"]')?.querySelector<HTMLButtonElement>('button[aria-expanded]') ?? null

function openRunList() {
  const trigger = runTrigger()
  expect(trigger, 'no run list trigger').not.toBeNull()
  act(() => trigger!.click())
}

describe('426-09 the target list and the run list', () => {
  it('HISTORY-TARGET-FIRST: the target list holds the target\'s marks newest first; the run list is collapsed, then lists the ledger newest first with each target named', () => {
    mount()
    const target = q('[data-feedback-history="target"]')
    expect(target).not.toBeNull()
    expect(target!.getAttribute('data-history-state')).toBe('history')
    expect(target!.querySelector('h3')?.textContent).toBe(historyTitle('step', 2))
    expect(entryIds(target)).toEqual([markId(3), markId(1)])

    const run = q('[data-feedback-history="run"]')
    expect(run).not.toBeNull()
    expect(runTrigger()?.getAttribute('aria-expanded')).toBe('false')
    expect(runTrigger()?.textContent).toBe(runHistoryLabel(3))
    expect(entryIds(run)).toEqual([])

    openRunList()
    expect(entryIds(q('[data-feedback-history="run"]'))).toEqual([markId(3), markId(2), markId(1)])
    const labels = [...q('[data-feedback-history="run"]')!.querySelectorAll('[data-history-target]')].map((node) => node.textContent)
    expect(labels).toEqual([
      feedbackPartsText(historyTargetLabel({ testIndex: 0, stepIndex: 1 }, detail)),
      feedbackPartsText(historyTargetLabel({ testIndex: 0 }, detail)),
      feedbackPartsText(historyTargetLabel({ testIndex: 0, stepIndex: 1 }, detail)),
    ])
    expect(target!.querySelector('[data-history-target]')).toBeNull()
  })

  it('HISTORY-ENTRY-ANATOMY: choice, time, Active or Replaced with the later mark\'s time, the quoted note and the disposition', () => {
    mount()
    const target = q('[data-feedback-history="target"]')
    const newer = entryOf(target, markId(3))!
    expect(newer.getAttribute('data-history-active')).toBe('true')
    expect(newer.textContent).toContain(CHOICE_LABELS['false-pass'])
    const time = newer.querySelector('time')!
    expect(time.getAttribute('dateTime')).toBe(new Date(T(3)).toISOString())
    expect(time.textContent).toBe(formatMarkTime(T(3)))
    expect(newer.textContent).toContain(ACTIVE_TEXT)
    expect(newer.textContent).toContain('“The coupon should have been refused”')
    // RE-SPELLED 2026-10-03 (quick 261003-cpv, 432-UI-REVIEW fix 2): the disposition and what the fix
    // changed are one line.
    expect(newer.querySelector('[data-history-disposition]')?.textContent)
      .toBe(historyChangeText({ disposition: applied(), changedRecords: changed() }))
    expect(newer.querySelector('[data-history-disposition]')?.textContent?.startsWith(dispositionText(applied()))).toBe(true)

    const older = entryOf(target, markId(1))!
    expect(older.getAttribute('data-history-active')).toBe('false')
    expect(older.textContent).toContain(replacedByText(formatMarkTime(T(3))))
    expect(older.textContent).not.toContain(ACTIVE_TEXT)
    expect(older.className).toContain('text-muted-foreground')
    expect(older.querySelector('[data-history-disposition]')?.textContent).toBe(dispositionText(NO_FIX))
    expect(older.textContent).not.toContain('“')
  })

  it('HISTORY-ENTRY-ANATOMY: a replaced entry whose later mark is not in the ledger says so without a time', () => {
    mount({
      read: ledger([
        { n: 1, stepIndex: 1, active: false, supersededBy: 'mark_0000000000ff' },
        { n: 2, stepIndex: 1, kind: 'false-pass' },
      ]),
    })
    const older = entryOf(q('[data-feedback-history="target"]'), markId(1))!
    expect(older.textContent).toContain(replacedByText())
    expect(older.textContent).not.toContain(replacedByText(formatMarkTime(T(2))))
  })
})

describe('426-09 latest-mark-wins is explained once', () => {
  it('HISTORY-REPLACED-EXPLAINED: any replaced entry puts one explanation above the target list; none replaced, none shown', () => {
    mount()
    const notes = container.querySelectorAll('[data-feedback-replaced-note]')
    expect(notes).toHaveLength(1)
    expect(notes[0]!.textContent).toBe(REPLACEMENT_EXPLANATION)
    const target = q('[data-feedback-history="target"]')!
    expect(notes[0]!.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    openRunList()
    expect(container.querySelectorAll('[data-feedback-replaced-note]')).toHaveLength(1)
    act(() => root.unmount())
    container.remove()

    mount({ scope: 'test', address: '0:run' })
    expect(container.querySelectorAll('[data-feedback-replaced-note]')).toHaveLength(1)
    act(() => root.unmount())
    container.remove()

    mount({ read: ledger([{ n: 1, stepIndex: 1 }, { n: 2 }]) })
    expect(container.querySelector('[data-feedback-replaced-note]')).toBeNull()
  })
})

// RE-SPELLED 432-09 from '426-09 a drafted proposal names its state and its review command': a mark
// applies its fix in the call, so the entry says what changed and offers nothing to review (D-25).
describe('432-09 an applied fix says in one line what it changed', () => {
  it('C432-APPLIED-HISTORY-DOM: the knowledge line carries the changed record content, the file line the written path, both as text', () => {
    const file = { kind: 'applied', fix: 'test-edit', change: { kind: 'test-file', filePath: 'tests/checkout.yaml', contentDigest: 'abc' } } as const
    mount({
      read: ledger([
        { n: 1, stepIndex: 1, disposition: applied(['mem_caution_1', 'mem_gone']), changedRecords: [...changed(), { recordId: 'mem_gone', contentAbsence: { reason: 'not-found' } }] },
        { n: 2, stepIndex: 1, disposition: file, active: true },
        { n: 3, stepIndex: 1, disposition: { kind: 'drafted', fix: 'fact', proposalId: 'prop_0123456789ab', proposalKind: 'knowledge' } },
      ].map((entry, index, all) => index < all.length - 1 ? { ...entry, active: false, supersededBy: markId(entry.n + 1) } : entry)),
    })
    const target = q('[data-feedback-history="target"]')
    const line = (n: number) => entryOf(target, markId(n))!.querySelector('[data-history-applied]')
    const knowledge = line(1)!
    expect(knowledge.getAttribute('data-history-applied')).toBe('knowledge')
    // RE-SPELLED 2026-10-03 (quick 261003-cpv, 432-UI-REVIEW fix 2): the applied line IS the entry's
    // one line, so it reads the disposition and then what the fix changed.
    expect(knowledge.textContent).toBe(historyChangeText({ disposition: applied(['mem_caution_1', 'mem_gone']),
      changedRecords: [...changed(), { recordId: 'mem_gone', contentAbsence: { reason: 'not-found' } }] }))
    expect(knowledge.textContent).toContain(appliedChangeText(appliedChangeView({ disposition: applied(['mem_caution_1', 'mem_gone']),
      changedRecords: [...changed(), { recordId: 'mem_gone', contentAbsence: { reason: 'not-found' } }] })!).slice('Changed knowledge: '.length))
    expect(knowledge.textContent).toContain(CAUTION.content)
    const written = line(2)!
    expect(written.getAttribute('data-history-applied')).toBe('test-file')
    expect(written.textContent).toBe('Recorded — the test file was edited: tests/checkout.yaml')
    expect(written.querySelector('code')?.textContent).toBe('tests/checkout.yaml')
    // A pre-432 drafted receipt never recorded its change: the line says so rather than inventing one.
    expect(line(3)!.getAttribute('data-history-applied')).toBe('unavailable')
    expect(line(3)!.textContent).toBe('Recorded — a fix was drafted (older mark); what it changed was not recorded.')
    expect([1, 2, 3].map(n => entryOf(target, markId(n))!.querySelectorAll('[data-history-applied]').length)).toEqual([1, 1, 1])
  })

  it('C432-APPLIED-HISTORY-DOM: an entry that changed nothing has no applied line, and hostile record content stays text', () => {
    mount({ read: ledger([{ n: 1, stepIndex: 1 }, { n: 2, stepIndex: 2, disposition: { kind: 'confirmed-bug', confirmedRecords: 1 } }]) })
    expect(q('[data-history-applied]')).toBeNull()
    act(() => root.unmount())
    container.remove()

    mount({ read: ledger([{ n: 1, stepIndex: 1, disposition: applied(), changedRecords: changed(HOSTILE) }]) })
    expect(container.querySelector('img')).toBeNull()
    expect(q('[data-history-applied]')!.textContent).toContain(HOSTILE)
    expect((globalThis as { __pwned?: boolean }).__pwned).toBeUndefined()
  })

  it('C432-NO-REVIEW-CTA: no entry carries a proposal state, a review command or a copy control, and nothing under the history is a link', () => {
    mount()
    openRunList()
    expect(q('[data-history-proposal-state]')).toBeNull()
    expect(q('[data-history-review]')).toBeNull()
    expect(q('[data-review-command]')).toBeNull()
    expect(container.querySelectorAll('button[data-history-entry] , [data-history-entry] button')).toHaveLength(0)
    expect(container.textContent).not.toMatch(/review|proposal/i)
    expect(container.querySelectorAll('[data-feedback-history] a, [data-feedback-history] [href]')).toHaveLength(0)
    expect(container.querySelectorAll('a')).toHaveLength(0)
  })
})

describe('426-09 each way the history can be absent renders as itself', () => {
  const failures: FeedbackReadFailure[] = ['network', 'ledger-corrupt', 'ledger-unavailable', 'refused', 'shape']
  // The sentence is computed inside the cell, so a missing copy function fails its own cell only.
  const rows: [string, MarksHistoryRead, () => string, boolean][] = [
    ['run-not-found', arm({ kind: 'run-not-found' }), () => historyStateText('run-not-found'), false],
    ['ledger-corrupt', arm({ kind: 'ledger-corrupt', line: 7 }), () => historyStateText('ledger-corrupt', 7), false],
    ['ledger-unavailable', arm({ kind: 'ledger-unavailable' }), () => historyStateText('ledger-unavailable'), true],
    ...failures.map((reason): [string, MarksHistoryRead, () => string, boolean] => [
      'failed',
      { kind: 'failed', reason },
      () => HISTORY_READ_FAILED_TEXT(feedbackReadFailureReason(reason)),
      true,
    ]),
  ]

  it.each(rows)('HISTORY-STATES: %s renders its own sentence, never the empty copy', (state, read, sentence, retries) => {
    const onRetry = mount({ read })
    const target = q('[data-feedback-history="target"]')
    expect(target?.getAttribute('data-history-state')).toBe(state)
    expect(target!.textContent).toContain(sentence())
    for (const empty of Object.values(HISTORY_EMPTY_TEXT)) expect(container.textContent).not.toContain(empty)
    expect(container.querySelector('[data-history-entry]')).toBeNull()
    const retry = q<HTMLButtonElement>('[data-feedback-history-retry]')
    if (!retries) {
      expect(retry).toBeNull()
      return
    }
    expect(retry?.getAttribute('aria-label')).toBe(HISTORY_RETRY_ACCESSIBLE_NAME)
    act(() => retry!.click())
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('HISTORY-STATES: ledger-corrupt names the damaged line', () => {
    mount({ read: arm({ kind: 'ledger-corrupt', line: 7 }) })
    expect(q('[data-feedback-history="target"]')!.textContent).toContain('line 7')
  })

  it('HISTORY-STATES: before the first read settles, two skeleton rows that do not animate under reduced motion', () => {
    mount({ read: undefined })
    const target = q('[data-feedback-history="target"]')!
    expect(target.getAttribute('data-history-state')).toBe('loading')
    const skeletons = [...target.querySelectorAll('[data-slot="skeleton"]')]
    expect(skeletons).toHaveLength(2)
    for (const skeleton of skeletons) {
      expect(skeleton.className).toContain('h-10')
      expect(skeleton.className).toContain('motion-reduce:animate-none')
    }
    for (const empty of Object.values(HISTORY_EMPTY_TEXT)) expect(container.textContent).not.toContain(empty)
  })

  it('HISTORY-STATES: an empty ledger reads its own copy with counts of zero; a ledger with nothing on this target reads the target\'s', () => {
    mount({ read: ledger([]) })
    const target = q('[data-feedback-history="target"]')!
    expect(target.getAttribute('data-history-state')).toBe('empty')
    expect(target.querySelector('h3')?.textContent).toBe(historyTitle('step', 0))
    expect(target.textContent).toContain(HISTORY_EMPTY_TEXT.step)
    expect(runTrigger()?.textContent).toBe(runHistoryLabel(0))
    openRunList()
    expect(q('[data-feedback-history="run"]')!.textContent).toContain(HISTORY_EMPTY_TEXT.run)
    act(() => root.unmount())
    container.remove()

    mount({ scope: 'test', address: '0:run', read: ledger([{ n: 1, stepIndex: 1 }]) })
    expect(q('[data-feedback-history="target"]')!.getAttribute('data-history-state')).toBe('empty')
    expect(q('[data-feedback-history="target"]')!.textContent).toContain(HISTORY_EMPTY_TEXT.test)
    expect(runTrigger()?.textContent).toBe(runHistoryLabel(1))
  })
})

describe('426-09 producer text stays text, and the internal words stay out', () => {
  it('HISTORY-MASKED-NOTE-ESCAPED: a note or a step name carrying markup creates no element', () => {
    const hostileDetail = { ...detail, steps: detail.steps.map((step) => ({ ...step, stepText: HOSTILE })) }
    mount({ detail: hostileDetail, read: ledger([{ n: 1, stepIndex: 1, note: HOSTILE }]) })
    openRunList()
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain(HOSTILE)
    expect((globalThis as { __pwned?: boolean }).__pwned).toBeUndefined()
  })

  it('HISTORY-NO-INTERNAL-NAME: no text under the history names false-fail, false-pass or confirmed-bug', () => {
    mount()
    openRunList()
    const texts: string[] = []
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) texts.push(node.textContent ?? '')
    expect(container.querySelectorAll('[data-history-entry]').length).toBeGreaterThan(0)
    const leaked = texts.filter((text) => MARKS.some((mark) => text.includes(mark)))
    expect(leaked, `internal mark names in the history: ${leaked.join(' | ')}`).toEqual([])
  })
})

// 2026-10-03 (quick 261003-cpv, 432-UI-REVIEW priority fix 2 and the D-09 pointer; 432 review IN-32):
// ONE line per entry says what the mark did, never a disposition line plus a second line that can
// contradict it, and the correction pointer appears with the first applied change.
describe('C261003-CPV-HISTORY-ONE-LINE: one entry, one line about what it changed', () => {
  const lineOf = (entry: HTMLElement) => [...entry.querySelectorAll('[data-history-disposition], [data-history-applied]')]

  it('C261003-CPV-HISTORY-ONE-LINE: an applied knowledge fix is one line naming the fix and its content', () => {
    mount({ read: ledger([{ n: 1, stepIndex: 1, disposition: applied(), changedRecords: changed() }]) })
    const lines = lineOf(entryOf(q('[data-feedback-history="target"]'), markId(1))!)
    expect(lines).toHaveLength(1)
    expect(lines[0]!.textContent).toBe(`Recorded — a caution was added: “${CAUTION.content}”`)
    expect(lines[0]!.getAttribute('data-history-applied')).toBe('knowledge')
  })

  it('C261003-CPV-HISTORY-ONE-LINE: a historical drafted mark is one line that claims no change', () => {
    mount({ read: ledger([{ n: 1, stepIndex: 1, disposition: { kind: 'drafted', fix: 'fact', proposalId: 'prop_0123456789ab', proposalKind: 'knowledge' } }]) })
    const lines = lineOf(entryOf(q('[data-feedback-history="target"]'), markId(1))!)
    expect(lines).toHaveLength(1)
    expect(lines[0]!.textContent).toBe('Recorded — a fix was drafted (older mark); what it changed was not recorded.')
  })

  it('C261003-CPV-HISTORY-ONE-LINE (IN-32): an applied receipt with no records leaves no dangling prefix', () => {
    mount({ read: ledger([{ n: 1, stepIndex: 1, disposition: applied([]), changedRecords: [] }]) })
    const entry = entryOf(q('[data-feedback-history="target"]'), markId(1))!
    const lines = lineOf(entry)
    expect(lines).toHaveLength(1)
    expect(lines[0]!.textContent).toBe('Recorded — a caution was added; its content was not recorded.')
    expect(entry.textContent).not.toContain('Changed knowledge:')
  })

  it('C261003-CPV-HISTORY-ONE-LINE: the correction pointer shows with the first applied change, and not without one', () => {
    mount({ read: ledger([{ n: 1, stepIndex: 1, disposition: applied(), changedRecords: changed() }]) })
    const notes = container.querySelectorAll('[data-feedback-correction-note]')
    expect(notes).toHaveLength(1)
    expect(notes[0]!.textContent).toMatch(/mark again/)
    expect(notes[0]!.textContent).toMatch(/stays/)
    act(() => root.unmount())
    container.remove()

    mount({ read: ledger([{ n: 1, stepIndex: 1 }, { n: 2 }]) })
    expect(container.querySelector('[data-feedback-correction-note]')).toBeNull()
  })
})
