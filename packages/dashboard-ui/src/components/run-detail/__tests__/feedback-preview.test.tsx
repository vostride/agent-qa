// @vitest-environment jsdom
// "WHAT THIS WILL DO", PAINTED FROM THE READ (426-06 · D-16, D-17, UI-SPEC S5).
//
// Every fixture is parsed by RunsMarkPreviewResultSchema, so each one satisfies the read's own
// superRefines: served records lead, only a false-pass overturns or reaches an unserved record, and the
// evidence counts are the planned effects. The section says only what the read states — two labelled
// lines, the records on demand, the replaced mark — and no id reaches a text node a person reads.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MARK_PREVIEW_REFUSALS, RunsMarkPreviewResultSchema, type RunsMarkPreviewResult } from '@vostride/agent-qa-schema'
import { generateRunId, generateTestId } from '@vostride/agent-qa-ids'

import { FeedbackPreview, type FeedbackPreviewProps } from '../feedback-preview'
import type { FeedbackReadFailure } from '@/lib/api'
import {
  CLI_ESCAPE_PARTS,
  CLI_ESCAPE_TEXT,
  PREVIEW_READ_FAILED_TEXT,
  PREVIEW_REFUSAL_TEXT,
  PREVIEW_RETRY_ACCESSIBLE_NAME,
  RETRY_LABEL,
  alreadyMarkedText,
  feedbackReadFailureReason,
  previewRefusalText,
  quarantinedText,
  CONTENT_ABSENCE_TEXT,
  DRAFT_WORDING_NOT_SHOWN_TEXT,
  PREVIEW_IDLE_TEXT,
  PREVIEW_LINE_LABELS,
  PREVIEW_TITLE,
  PREVIEW_UPDATING_TEXT,
  RECORD_EFFECT_TEXT,
  UNREADABLE_RECORD_TEXT,
  knowledgeLine,
  previewFixText,
  recordEffectLine,
  replacesLine,
  showRecordsLabel,
} from '@/lib/feedback-view'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const RUN_ID = generateRunId()
const TEST_ID = generateTestId()
const HOSTILE = '<img src=x onerror="globalThis.__previewPwned = true">'
const PRIOR_MARK_ID = 'mark_0123456789ab'

function content(text: string) {
  return {
    content: text,
    summary: `summary of ${text}`,
    kind: 'fact' as const,
    applicability: { product: 'shop', scope: 'checkout', anchors: [], openedAtOrdinal: 1 },
    currentStatus: 'active' as const,
    currentTrust: { confirmations: 1, contradictions: 0, evidenceTokens: [], lastEventOrdinal: 3 },
  }
}

const overturn = (token: string) => ({ direction: 'overturn', overturnsEvidenceToken: token, overturnsCurationJobId: 'job-curate-1' })

/** A false-fail superseding mark #2: one served record confirmed and a knowledge fact to be added (432-09). */
function falseFail(over: Record<string, unknown> = {}): RunsMarkPreviewResult {
  return RunsMarkPreviewResultSchema.parse({
    kind: 'consequences',
    runId: RUN_ID,
    prospective: true,
    markKind: 'false-fail',
    member: { testIndex: 0, testId: TEST_ID },
    resolvedStep: { stepIndex: 2, reason: 'failing-step' },
    latest: { kind: 'supersedes', markId: PRIOR_MARK_ID, ordinal: 2 },
    basis: { ledgerOrdinal: 3, priorMarkOrdinal: 2 },
    knowledge: {
      servedRecordIds: ['rec-served-alpha'],
      appendsEvidence: true,
      records: [{
        recordId: 'rec-served-alpha', recordContent: content('Coupon field sits below the total'), served: true,
        evidence: { kind: 'effects', effects: [{ direction: 'confirm' }] },
      }],
      evidence: { confirmed: 1, overturned: 0 },
    },
    draft: { kind: 'knowledge', fix: 'fact', target: { grain: 'record', recordId: 'rec-target-beta' } },
    ...over,
  })
}

/** A false-pass reaching two served records (one unreadable) and one correlated unserved record. */
function falsePass(): RunsMarkPreviewResult {
  return RunsMarkPreviewResultSchema.parse({
    kind: 'consequences',
    runId: RUN_ID,
    prospective: true,
    markKind: 'false-pass',
    member: { testIndex: 0, testId: TEST_ID },
    resolvedStep: { stepIndex: 4, reason: 'passing-verdict' },
    latest: { kind: 'first' },
    basis: { ledgerOrdinal: 0 },
    knowledge: {
      servedRecordIds: ['rec-served-one', 'rec-served-two'],
      appendsEvidence: true,
      records: [
        { recordId: 'rec-served-one', recordContent: content('Receipt page lists the order number'), served: true,
          evidence: { kind: 'effects', effects: [{ direction: 'confirm' }, overturn('tok-1')] } },
        { recordId: 'rec-served-two', contentAbsence: { reason: 'scan-incomplete' }, served: true, evidence: { kind: 'unreadable' } },
        { recordId: 'rec-unserved-three', recordContent: content('Checkout always shows a receipt'), served: false,
          evidence: { kind: 'effects', effects: [overturn('tok-2'), overturn('tok-3')] } },
      ],
      evidence: { confirmed: 1, overturned: 3 },
    },
    draft: { kind: 'test-edit', testRef: 'tests/checkout.yaml' },
  })
}

let root: Root | undefined
let container: HTMLDivElement

function render(props: FeedbackPreviewProps) {
  if (root === undefined) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  }
  act(() => root!.render(<FeedbackPreview {...props} />))
}

afterEach(() => {
  if (root !== undefined) act(() => root!.unmount())
  root = undefined
  container.remove()
})

const section = () => container.querySelector<HTMLElement>('[data-feedback-preview]')!
const line = (name: string) => container.querySelector<HTMLElement>(`[data-preview-line="${name}"]`)

async function openRecords() {
  const trigger = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.startsWith('Show records'))
  expect(trigger, 'no Show records trigger').toBeDefined()
  expect(container.querySelectorAll('[data-preview-record]')).toHaveLength(0)
  await act(async () => { trigger!.click() })
}

function visibleText(): string {
  const walker = document.createTreeWalker(section(), NodeFilter.SHOW_TEXT)
  const texts: string[] = []
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) texts.push(node.textContent ?? '')
  return texts.join('\n')
}

describe('426-06 the What this will do section', () => {
  it('PREVIEW-LINES: the knowledge and change lines from the read, in order, and no id reaches visible text', async () => {
    const read = falseFail()
    if (read.kind !== 'consequences') throw new Error('fixture')
    render({ state: 'consequences', current: true, read })

    const title = document.getElementById(section().getAttribute('aria-labelledby')!)
    expect(title?.textContent).toBe(PREVIEW_TITLE)
    expect(title?.className).toContain('text-sm')
    expect(section().getAttribute('data-preview-state')).toBe('consequences')
    expect(section().getAttribute('data-preview-current')).toBe('true')
    expect(section().getAttribute('aria-busy')).toBe('false')

    const dl = section().querySelector('dl')!
    expect(dl.className).toContain('grid-cols-[auto_1fr]')
    expect([...dl.querySelectorAll('dt')].map((dt) => dt.textContent)).toEqual([
      PREVIEW_LINE_LABELS.knowledge, PREVIEW_LINE_LABELS.change,
    ])
    const dds = [...dl.querySelectorAll('dd')]
    expect(dds.map((dd) => dd.getAttribute('data-preview-line'))).toEqual(['knowledge', 'change'])
    for (const dd of dds) {
      expect(dd.className).toContain('break-words')
      expect(dd.textContent?.trim()).not.toBe('')
    }

    expect(line('knowledge')!.textContent).toContain(knowledgeLine(read.knowledge.evidence, 1))
    expect(line('knowledge')!.textContent).toContain(showRecordsLabel(1))
    expect(line('change')!.textContent).toBe(previewFixText(read.draft) + DRAFT_WORDING_NOT_SHOWN_TEXT)

    await openRecords()
    for (const secret of ['rec-served-alpha', 'rec-target-beta', PRIOR_MARK_ID, TEST_ID, RUN_ID]) {
      expect(visibleText(), `visible text carries ${secret}`).not.toContain(secret)
    }
  })

  it('PREVIEW-LINES: empty facts each read a sentence and no dd renders empty', () => {
    const read = falseFail({
      latest: { kind: 'first' }, basis: { ledgerOrdinal: 0 },
      knowledge: { servedRecordIds: [], appendsEvidence: false, records: [], evidence: { confirmed: 0, overturned: 0 } },
      draft: { kind: 'no-draftable-fix', checked: { servedRecords: 0, procedureReads: 0, assertionDrift: false } },
    })
    render({ state: 'consequences', current: true, read })
    for (const name of ['knowledge', 'change']) expect(line(name), `no ${name} line`).not.toBeNull()
    expect(line('knowledge')!.textContent).toBe('No knowledge records are reached')
    expect(line('change')!.textContent).toBe('No fix can be made from this run')
    expect(line('replaces')).toBeNull()
    expect([...container.querySelectorAll('button')].some((button) => button.textContent?.startsWith('Show records'))).toBe(false)
  })

  it('PREVIEW-RECORDS-SERVED-FIRST: the records open in the read\'s order, served first, the unserved one last counting against', async () => {
    const read = falsePass()
    if (read.kind !== 'consequences') throw new Error('fixture')
    render({ state: 'consequences', current: true, read })
    expect(line('knowledge'), 'no knowledge line').not.toBeNull()
    expect(line('knowledge')!.textContent).toContain(knowledgeLine(read.knowledge.evidence, 3))
    await openRecords()

    const items = [...container.querySelectorAll<HTMLElement>('li[data-preview-record]')]
    expect(items).toHaveLength(3)
    expect(items.map((item) => item.getAttribute('data-preview-record'))).toEqual(['served', 'unreadable', 'unserved'])
    expect(items[0]!.textContent).toBe('Receipt page lists the order number' + recordEffectLine(read.knowledge.records[0]!))
    const last = items[2]!
    expect(last.textContent).toBe('Checkout always shows a receipt' + recordEffectLine(read.knowledge.records[2]!))
    expect(last.textContent).toContain(RECORD_EFFECT_TEXT.overturn)
    expect(container.querySelector('li[data-preview-record] ul, li[data-preview-record] [class*="overflow-y"]')).toBeNull()

    expect(line('change')!.textContent).toBe(previewFixText(read.draft) + DRAFT_WORDING_NOT_SHOWN_TEXT)
  })

  it('PREVIEW-UNREADABLE-RECORD: an unreadable record keeps its li, reads its absence and the unreadable sentence', async () => {
    const read = falsePass()
    render({ state: 'consequences', current: true, read })
    await openRecords()
    const unreadable = container.querySelector<HTMLElement>('li[data-preview-record="unreadable"]')
    expect(unreadable, 'the unreadable record lost its li').not.toBeNull()
    expect(unreadable!.textContent).toBe(CONTENT_ABSENCE_TEXT['scan-incomplete'] + UNREADABLE_RECORD_TEXT)
  })

  // RE-SPELLED 432-09 (D-11) from 'PREVIEW-REPLACES-LINE: a superseding mark reads the replaced
  // ordinal, the time when given, and the withdrawal': a later mark withdraws nothing it applied.
  it('PREVIEW-REPLACES-LINE: a superseding mark reads the replaced ordinal, the time when given, and that its change stays', () => {
    render({ state: 'consequences', current: true, read: falseFail(), replacesTime: '14:05' })
    const replaces = line('replaces')
    expect(replaces, 'no replaces line').not.toBeNull()
    expect(replaces!.tagName).toBe('P')
    expect(replaces!.textContent).toBe(replacesLine(2, '14:05'))
    expect(replaces!.textContent).toContain('what it changed stays')
    expect(replaces!.textContent).not.toMatch(/withdraw|proposal/)

    render({ state: 'consequences', current: true, read: falseFail() })
    expect(line('replaces')!.textContent).toBe('Replaces your earlier mark (#2); what it changed stays')
  })

  it('PREVIEW-MASKED-ESCAPED: hostile record content stays text and creates no element', async () => {
    const read = falseFail({
      knowledge: {
        servedRecordIds: ['rec-served-alpha'], appendsEvidence: true,
        records: [{ recordId: 'rec-served-alpha', recordContent: content(HOSTILE), served: true,
          evidence: { kind: 'effects', effects: [{ direction: 'confirm' }] } }],
        evidence: { confirmed: 1, overturned: 0 },
      },
    })
    render({ state: 'consequences', current: true, read })
    await openRecords()
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('li[data-preview-record]')!.textContent).toContain(HOSTILE)
    expect((globalThis as { __previewPwned?: boolean }).__previewPwned).toBeUndefined()
    expect(container.querySelectorAll('[data-feedback-preview] .truncate')).toHaveLength(0)
  })

  it('PREVIEW-NO-FLASH: the first load is four reduced-motion skeletons; a re-fetch keeps the lines, dimmed and busy', () => {
    render({ state: 'idle', current: false })
    expect(section().textContent).toContain(PREVIEW_IDLE_TEXT)
    expect(section().getAttribute('aria-busy')).toBe('false')

    render({ state: 'loading', current: false })
    const skeletons = [...section().querySelectorAll<HTMLElement>('[data-slot="skeleton"]')]
    expect(skeletons).toHaveLength(4)
    for (const skeleton of skeletons) {
      expect(skeleton.className).toContain('h-4')
      expect(skeleton.className).toContain('motion-reduce:animate-none')
    }
    expect(section().getAttribute('aria-busy')).toBe('true')
    expect(section().querySelector('dl')).toBeNull()

    render({ state: 'consequences', current: false, read: falseFail(), updating: true })
    expect(section().querySelector('dl')).not.toBeNull()
    expect(section().querySelectorAll('[data-slot="skeleton"]')).toHaveLength(0)
    expect(section().querySelector('.opacity-60')?.contains(section().querySelector('dl'))).toBe(true)
    expect(section().textContent).toContain(PREVIEW_UPDATING_TEXT)
    expect(section().getAttribute('aria-busy')).toBe('true')
    expect(section().getAttribute('data-preview-current')).toBe('false')

    render({ state: 'consequences', current: true, read: falseFail() })
    expect(section().querySelector('.opacity-60')).toBeNull()
    expect(section().textContent).not.toContain(PREVIEW_UPDATING_TEXT)
    expect(section().getAttribute('aria-busy')).toBe('false')
  })
})

// THE OTHER ARMS, EACH IN ITS OWN PLAIN WORDS (426-07 · D-18, D-19, UI-SPEC S5). A quarantined mark and
// an identical repeat are muted blocks; a refusal is runs.mark's own arm in a DenialBlock with nothing
// to do; a failed read names why, offers a Retry that says what it retries, and the CLI escape hatch.
const QUARANTINED = RunsMarkPreviewResultSchema.parse({
  kind: 'quarantined', runId: RUN_ID, prospective: true, markKind: 'false-fail', member: { testIndex: 0, testId: TEST_ID },
  resolvedStep: { stepIndex: 2, reason: 'failing-step' }, latest: { kind: 'first' }, basis: { ledgerOrdinal: 0 }, class: 'timeout',
})
const ALREADY_MARKED = RunsMarkPreviewResultSchema.parse({
  kind: 'already-marked', runId: RUN_ID,
  prior: {
    markId: PRIOR_MARK_ID, kind: 'false-fail', ordinal: 1, testIndex: 0, testId: TEST_ID,
    disposition: { kind: 'no-draftable-fix', checked: { servedRecords: 0, procedureReads: 0, assertionDrift: false } },
  },
  basis: { ledgerOrdinal: 1, priorMarkOrdinal: 1 },
})
const REFUSALS: Record<(typeof MARK_PREVIEW_REFUSALS)[number], RunsMarkPreviewResult> = {
  'run-not-found': RunsMarkPreviewResultSchema.parse({ kind: 'run-not-found', runId: RUN_ID }),
  'member-not-found': RunsMarkPreviewResultSchema.parse({ kind: 'member-not-found', runId: RUN_ID, testId: TEST_ID }),
  'step-not-found': RunsMarkPreviewResultSchema.parse({ kind: 'step-not-found', runId: RUN_ID, testIndex: 0, stepIndex: 4, stepCount: 3 }),
  'ambiguous-address': RunsMarkPreviewResultSchema.parse({
    kind: 'ambiguous-address', runId: RUN_ID, candidates: [{ testIndex: 0, testId: TEST_ID }, { testIndex: 1, testId: TEST_ID }],
  }),
}
const READ_FAILURES = ['network', 'ledger-corrupt', 'ledger-unavailable', 'refused', 'shape'] as const satisfies readonly FeedbackReadFailure[]

describe('426-07 the special arms, the refusals and the failed read', () => {
  it('PREVIEW-QUARANTINED: a quarantined read is one muted block naming its cause, with no consequence lines', () => {
    render({ state: 'quarantined', current: true, read: QUARANTINED })
    const block = line('quarantined')
    expect(block, 'no quarantined block').not.toBeNull()
    expect(block!.textContent).toBe(quarantinedText('timeout'))
    for (const cls of ['rounded-md', 'bg-muted/40', 'px-3', 'py-2', 'text-xs']) expect(block!.className).toContain(cls)
    expect(section().querySelector('dl')).toBeNull()
    expect(section().querySelector('[data-entry="denial"]')).toBeNull()
  })

  it('PREVIEW-ALREADY-MARKED: an identical repeat reads when it was said, or no time when history has none', () => {
    render({ state: 'already-marked', current: true, read: ALREADY_MARKED, alreadyMarkedTime: 'Sep 23, 10:41' })
    const block = line('already-marked')
    expect(block, 'no already-marked block').not.toBeNull()
    expect(block!.textContent).toBe(alreadyMarkedText('Sep 23, 10:41'))
    expect(block!.className).toContain('bg-muted/40')
    expect(section().querySelector('dl')).toBeNull()

    render({ state: 'already-marked', current: true, read: ALREADY_MARKED })
    expect(line('already-marked')!.textContent).toBe(alreadyMarkedText())
    expect(visibleText()).not.toContain(PRIOR_MARK_ID)
  })

  it.each([...MARK_PREVIEW_REFUSALS])('PREVIEW-REFUSALS: %s renders its own sentence in one DenialBlock with no remedies', (kind) => {
    const read = REFUSALS[kind]
    render({ state: 'refused', current: true, read })
    const refusal = container.querySelector<HTMLElement>(`[data-preview-refusal="${kind}"]`)
    expect(refusal, `no ${kind} refusal`).not.toBeNull()
    const denials = section().querySelectorAll('[data-entry="denial"]')
    expect(denials).toHaveLength(1)
    expect(refusal!.contains(denials[0]!)).toBe(true)
    const text = (PREVIEW_REFUSAL_TEXT[kind] as (arm: RunsMarkPreviewResult) => string)(read)
    expect(text).toBe(previewRefusalText(read as never))
    expect(denials[0]!.textContent).toBe(text)
    expect(section().querySelector('[data-remedy-kind]')).toBeNull()
    expect(section().querySelector('dl')).toBeNull()
    expect(section().querySelector('[data-feedback-preview-retry]')).toBeNull()
    for (const secret of [RUN_ID, TEST_ID]) expect(visibleText()).not.toContain(secret)
  })

  it('PREVIEW-REFUSALS: a test with no steps reads that it has nothing to mark', () => {
    const noSteps = RunsMarkPreviewResultSchema.parse({ kind: 'step-not-found', runId: RUN_ID, testIndex: 0, stepIndex: 0, stepCount: 0 })
    render({ state: 'refused', current: true, read: noSteps })
    expect(section().querySelector('[data-entry="denial"]'), 'no refusal block').not.toBeNull()
    expect(section().querySelector('[data-entry="denial"]')!.textContent).toBe('This test recorded no steps, so there is nothing to mark.')
  })

  it.each([...READ_FAILURES])('PREVIEW-FAILED-RETRY: a %s failure names its reason, offers a named Retry and the CLI escape hatch', (failure) => {
    const onRetry = vi.fn()
    render({ state: 'failed', current: true, failure, onRetry })
    const denial = section().querySelector('[data-entry="denial"]')
    expect(denial, 'no failure block').not.toBeNull()
    expect(denial!.textContent).toBe(PREVIEW_READ_FAILED_TEXT(feedbackReadFailureReason(failure)))
    expect(section().querySelector('[data-remedy-kind]')).toBeNull()

    const retry = container.querySelector<HTMLButtonElement>('[data-feedback-preview-retry]')
    expect(retry, 'no Retry button').not.toBeNull()
    expect(retry!.tagName).toBe('BUTTON')
    expect(retry!.textContent).toBe(RETRY_LABEL)
    expect(retry!.getAttribute('aria-label')).toBe(PREVIEW_RETRY_ACCESSIBLE_NAME)
    expect(retry!.getAttribute('aria-label')!.startsWith(retry!.textContent!)).toBe(true)
    expect(denial!.compareDocumentPosition(retry!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    const escape = [...section().querySelectorAll('p')].find((p) => p.textContent === CLI_ESCAPE_TEXT)
    expect(escape, 'no CLI escape line').toBeDefined()
    expect(retry!.compareDocumentPosition(escape!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(escape!.querySelector('.font-mono')?.textContent).toBe(CLI_ESCAPE_PARTS.name)

    expect(onRetry).not.toHaveBeenCalled()
    act(() => retry!.click())
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})
