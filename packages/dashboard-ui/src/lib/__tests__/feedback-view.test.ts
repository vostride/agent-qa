// The likelier correction contradicts the target's own recorded result, so it is offered first.

import { describe, expect, it } from 'vitest'
import type {
  Mark,
  MarkPreviewKnowledgeRecord,
  RunDetailMember,
  RunDetailStep,
  RunsMarkPreviewResult,
} from '@vostride/agent-qa-schema'
import {
  MARK_PREVIEW_REFUSALS,
  RunsMarkPreviewResultSchema,
  RunsMarksHistoryResultSchema,
} from '@vostride/agent-qa-schema'
import { generateRunId } from '@vostride/agent-qa-ids'
import type { FeedbackReadFailure } from '@/lib/api'

import { UNNAMED_STEP_LABEL } from '@/lib/display-step'
import {
  CHOICE_LABELS,
  CHOICE_LEGEND,
  CHOICE_MEANINGS,
  CONTENT_ABSENCE_TEXT,
  DISPOSITION_TEXT,
  DRAFT_WORDING_NOT_SHOWN_TEXT,
  FEEDBACK_CHOICE_ORDER,
  FEEDBACK_COMPOSER_STATES,
  FEEDBACK_ENTRY_SCOPES,
  FEEDBACK_ENTRY_TEST_LABEL,
  FEEDBACK_OUTCOME_CLASSES,
  FEEDBACK_PREVIEW_STATES,
  PREVIEW_IDLE_TEXT,
  PREVIEW_LINE_LABELS,
  PREVIEW_UPDATING_TEXT,
  PREVIEW_FIX_TEXT,
  RECORD_EFFECT_TEXT,
  UNREADABLE_RECORD_TEXT,
  SUBMIT_REASON_ALREADY_MARKED,
  SUBMIT_REASON_CHECKING,
  SUBMIT_REASON_NO_CHOICE,
  SUBMIT_REASON_NO_UNIQUE_ADDRESS,
  SUBMIT_REASON_PREVIEW_FAILED,
  SUBMIT_REASON_REFUSED,
  SUBMIT_REASON_SENDING,
  CLI_ESCAPE_PARTS,
  CLI_ESCAPE_TEXT,
  PREVIEW_REFUSAL_TEXT,
  PREVIEW_RETRY_ACCESSIBLE_NAME,
  RETRY_LABEL,
  PREVIEW_READ_FAILED_TEXT,
  alreadyMarkedText,
  feedbackReadFailureReason,
  previewRefusalText,
  dispositionText,
  quarantinedText,
  APPLIED_KNOWLEDGE_PREFIX,
  APPLIED_TEST_FILE_PREFIX,
  APPLIED_UNAVAILABLE_TEXT,
  appliedRecordUnavailableText,
  TECHNICAL_DETAILS_LABEL,
  TECHNICAL_DETAILS_ROW_LABELS,
  basisDetailText,
  type SubmitBlockInput,
  NO_STEP_VERDICT_TEXT,
  ONE_STEP_SCOPE_TEXT,
  RECORDED_RESULT_TEXT,
  WHOLE_TEST_SCOPE_TEXT,
  composerHeading,
  feedbackEntryLabel,
  feedbackOutcomeClass,
  feedbackPartsText,
  feedbackPreviewState,
  knowledgeLine,
  previewFixText,
  recordEffectLine,
  replacesLine,
  resolvedStepText,
  showRecordsLabel,
  showStepLabel,
  feedbackTargetView,
  hasUniqueAddress,
  isDraftEmpty,
  markGlyphLabel,
  memberOutcomeClass,
  pinnedTargetText,
  resolveHeaderFeedbackTarget,
  scopeLine,
  stepTriggerTooltip,
  submitBlockedReason,
  switchTargetLabel,
  unsentDraftLabel,
  ACTIVE_TEXT,
  FEEDBACK_HISTORY_STATES,
  HISTORY_EMPTY_TEXT,
  HISTORY_READ_FAILED_TEXT,
  HISTORY_RETRY_ACCESSIBLE_NAME,
  REPLACEMENT_EXPLANATION,
  feedbackHistoryState,
  formatMarkTime,
  historyStateText,
  historyTargetLabel,
  historyTitle,
  replacedByText,
  runHistoryLabel,
  FEEDBACK_LAYOUTS,
  FEEDBACK_STACK_BELOW_PX,
  feedbackDefaultLayout,
  feedbackLayout,
  feedbackPanelIds,
} from '@/lib/feedback-view'
import { memberDisplayName, memberHandleLabel } from '@/lib/run-detail-view'

const MARKS: readonly Mark[] = ['false-fail', 'false-pass', 'confirmed-bug']

function member(outcome?: RunDetailMember['outcome']): Pick<RunDetailMember, 'outcome'> {
  return outcome === undefined ? {} : { outcome }
}

function step(pass: boolean | undefined): Pick<RunDetailStep, 'verifierVerdict'> {
  return (pass === undefined ? {} : { verifierVerdict: { pass, reasoning: '' } }) as Pick<RunDetailStep, 'verifierVerdict'>
}

describe('choice order and meaning', () => {
  it('CHOICE-LABELS-EXACT: the three labels are the locked plain-language copy, keyed by exactly the marks', () => {
    expect(CHOICE_LABELS).toEqual({
      'false-fail': 'This should have passed',
      'false-pass': 'This should have failed',
      'confirmed-bug': 'This is a real product bug',
    })
    expect(Object.keys(CHOICE_LABELS).sort()).toEqual([...MARKS].sort())
  })

  it('CHOICE-ORDER-FAILED: a failed target offers should-have-passed, real bug, should-have-failed', () => {
    expect(FEEDBACK_CHOICE_ORDER.failed.map((kind) => CHOICE_LABELS[kind])).toEqual([
      CHOICE_LABELS['false-fail'],
      CHOICE_LABELS['confirmed-bug'],
      CHOICE_LABELS['false-pass'],
    ])
  })

  it('CHOICE-ORDER-PASSED: a passed target offers should-have-failed, real bug, should-have-passed', () => {
    expect(FEEDBACK_CHOICE_ORDER.passed.map((kind) => CHOICE_LABELS[kind])).toEqual([
      CHOICE_LABELS['false-pass'],
      CHOICE_LABELS['confirmed-bug'],
      CHOICE_LABELS['false-fail'],
    ])
  })

  it('CHOICE-ORDER-HEALED-TIMEOUT: healed counts as passed; timed out, cancelled and skipped count as failed', () => {
    expect(memberOutcomeClass('passed')).toBe('passed')
    expect(memberOutcomeClass('healed')).toBe('passed')
    expect(memberOutcomeClass('failed')).toBe('failed')
    expect(memberOutcomeClass('timeout')).toBe('failed')
    expect(memberOutcomeClass('cancelled')).toBe('failed')
    expect(memberOutcomeClass('skipped')).toBe('failed')
  })

  it('OUTCOME-CLASS-FALLBACK: no outcome takes the run status class, else failed; a step reads its own verdict, else its test', () => {
    expect(feedbackOutcomeClass({ member: member(), runStatus: 'passed' })).toBe('passed')
    expect(feedbackOutcomeClass({ member: member(), runStatus: 'healed' })).toBe('passed')
    expect(feedbackOutcomeClass({ member: member(), runStatus: 'failed' })).toBe('failed')
    expect(feedbackOutcomeClass({ member: member(), runStatus: 'running' })).toBe('failed')
    expect(feedbackOutcomeClass({ member: member(), runStatus: undefined })).toBe('failed')
    expect(feedbackOutcomeClass({ member: undefined, runStatus: 'passed' })).toBe('passed')
    expect(feedbackOutcomeClass({ member: member('failed'), runStatus: 'passed' })).toBe('failed')

    expect(feedbackOutcomeClass({ member: member('failed'), step: step(true), runStatus: 'failed' })).toBe('passed')
    expect(feedbackOutcomeClass({ member: member('passed'), step: step(false), runStatus: 'passed' })).toBe('failed')
    expect(feedbackOutcomeClass({ member: member('healed'), step: step(undefined), runStatus: 'failed' })).toBe('passed')
    expect(feedbackOutcomeClass({ member: member('skipped'), step: step(undefined), runStatus: 'passed' })).toBe('failed')
    expect(feedbackOutcomeClass({ member: member(), step: step(undefined), runStatus: 'passed' })).toBe('passed')
  })

  it('CHOICE-MEANINGS-TOTAL: every class carries a meaning for every mark, and the failed row reads word for word', () => {
    expect(Object.keys(CHOICE_MEANINGS).sort()).toEqual([...FEEDBACK_OUTCOME_CLASSES].sort())
    for (const cls of FEEDBACK_OUTCOME_CLASSES) {
      expect(Object.keys(CHOICE_MEANINGS[cls]).sort()).toEqual([...MARKS].sort())
      for (const kind of MARKS) expect(CHOICE_MEANINGS[cls][kind].trim()).not.toBe('')
    }
    expect(CHOICE_MEANINGS.failed).toEqual({
      'false-fail': 'The app behaved correctly; the test was wrong to fail.',
      'confirmed-bug': 'The failure is real — the app is broken here.',
      'false-pass': 'The test missed a problem it should have caught.',
    })
    expect(new Set(MARKS.map((kind) => CHOICE_MEANINGS.passed[kind])).size).toBe(3)
    expect(CHOICE_LEGEND.trim()).not.toBe('')
  })

  it('CLOSED-SETS-RUNTIME: the outcome classes and composer states are exactly the published sets', () => {
    expect(FEEDBACK_OUTCOME_CLASSES).toEqual(['passed', 'failed'])
    expect(FEEDBACK_COMPOSER_STATES).toEqual(['composing', 'submitting', 'recorded', 'retained'])
    expect(Object.keys(FEEDBACK_CHOICE_ORDER).sort()).toEqual([...FEEDBACK_OUTCOME_CLASSES].sort())
    for (const cls of FEEDBACK_OUTCOME_CLASSES) {
      expect([...FEEDBACK_CHOICE_ORDER[cls]].sort()).toEqual([...MARKS].sort())
    }
  })
})

describe('the composer names its target', () => {
  const checkout = { testIndex: 1, name: 'checkout', outcome: 'failed' } as const
  const coupon = { stepIndex: 2, stepText: 'apply coupon', verifierVerdict: { pass: true, reasoning: '' } }

  it('COMPOSER-HEADING: a step, a test in a suite and a single-test run each get their own heading parts', () => {
    expect(composerHeading({ member: checkout, step: coupon, stepCount: 5, suite: true })).toEqual({
      prefix: 'Feedback on step 3 of 5 · ',
      name: 'apply coupon',
    })
    expect(composerHeading({ member: checkout, step: coupon, stepCount: 5, suite: false })).toEqual({
      prefix: 'Feedback on step 3 of 5 · ',
      name: 'apply coupon',
    })
    expect(composerHeading({ member: checkout, stepCount: 5, suite: true })).toEqual({
      prefix: 'Feedback on ',
      name: memberDisplayName(checkout),
      suffix: ` ${memberHandleLabel(1)}`,
    })
    expect(composerHeading({ member: checkout, stepCount: 5, suite: false })).toEqual({
      prefix: 'Feedback on ',
      name: memberDisplayName(checkout),
    })
    expect(composerHeading({ member: checkout, step: { stepIndex: 0 }, stepCount: 1, suite: false }).name).toBe(UNNAMED_STEP_LABEL)
    expect(feedbackPartsText({ prefix: 'a', name: 'b', suffix: 'c' })).toBe('abc')
    expect(feedbackPartsText({ prefix: 'a' })).toBe('a')

    const detail = {
      members: [{ testIndex: 0, attempts: 1 }, { testIndex: 1, attempts: 1, totalSteps: 7 }],
      steps: [0, 1, 2].map((stepIndex) => ({ testIndex: 0, stepIndex, cacheStatus: 'miss', verifierVerdict: { pass: true, reasoning: '' }, selfHealOccurred: false, briefDigest: 'd' }) as const),
    }
    expect(feedbackPartsText(feedbackTargetView({ detail, target: { testIndex: 0, stepIndex: 1 }, runStatus: 'passed' }).heading))
      .toBe(`Feedback on step 2 of 3 · ${UNNAMED_STEP_LABEL}`)
    expect(feedbackPartsText(feedbackTargetView({ detail, target: { testIndex: 1, stepIndex: 0 }, runStatus: 'passed' }).heading))
      .toBe(`Feedback on step 1 of 7 · ${UNNAMED_STEP_LABEL}`)
  })

  it('SCOPE-LINE: whole test or one step, the suite step naming its test, then the target recorded result', () => {
    const passedStep = { ...coupon, status: 'passed' as const }
    expect(feedbackPartsText(scopeLine({ member: checkout, suite: true, runStatus: 'failed' })))
      .toBe(`${WHOLE_TEST_SCOPE_TEXT} · ${RECORDED_RESULT_TEXT.failed}`)
    expect(scopeLine({ member: checkout, step: passedStep, suite: true, runStatus: 'failed' })).toEqual({
      prefix: `${ONE_STEP_SCOPE_TEXT} in `,
      name: memberDisplayName(checkout),
      suffix: ` ${memberHandleLabel(1)} · ${RECORDED_RESULT_TEXT.passed}`,
    })
    expect(feedbackPartsText(scopeLine({ member: checkout, step: passedStep, suite: false, runStatus: 'failed' })))
      .toBe(`${ONE_STEP_SCOPE_TEXT} · ${RECORDED_RESULT_TEXT.passed}`)
    expect(feedbackPartsText(scopeLine({ member: checkout, step: { ...coupon, status: 'healed' }, suite: false, runStatus: 'failed' })))
      .toBe(`${ONE_STEP_SCOPE_TEXT} · ${RECORDED_RESULT_TEXT.healed}`)
    expect(feedbackPartsText(scopeLine({ member: checkout, step: { ...coupon, status: 'failed' }, suite: false, runStatus: 'failed' })))
      .toBe(`${ONE_STEP_SCOPE_TEXT} · ${RECORDED_RESULT_TEXT.passed}`)
    expect(feedbackPartsText(scopeLine({ member: { ...checkout, outcome: 'timeout' }, step: { stepIndex: 2 }, suite: false, runStatus: 'failed' })))
      .toBe(`${ONE_STEP_SCOPE_TEXT} · ${NO_STEP_VERDICT_TEXT(RECORDED_RESULT_TEXT.timeout)}`)
    expect(feedbackPartsText(scopeLine({ member: { testIndex: 0 }, suite: false, runStatus: 'healed' })))
      .toBe(`${WHOLE_TEST_SCOPE_TEXT} · ${RECORDED_RESULT_TEXT.healed}`)
    expect(feedbackPartsText(scopeLine({ member: { testIndex: 0 }, suite: false, runStatus: 'running' })))
      .toBe(`${WHOLE_TEST_SCOPE_TEXT} · ${RECORDED_RESULT_TEXT.failed}`)
  })

  it('RECORDED-RESULT-ROWS: one row per member outcome, each counting as the class the order uses', () => {
    expect(RECORDED_RESULT_TEXT).toEqual({
      passed: 'recorded: passed',
      healed: 'recorded: healed — counts as passed',
      failed: 'recorded: failed',
      timeout: 'recorded: timed out — counts as failed',
      cancelled: 'recorded: cancelled — counts as failed',
      skipped: 'recorded: skipped — counts as failed',
    })
    for (const [outcome, text] of Object.entries(RECORDED_RESULT_TEXT)) {
      expect(text.endsWith(memberOutcomeClass(outcome as keyof typeof RECORDED_RESULT_TEXT))).toBe(true)
    }
    expect(NO_STEP_VERDICT_TEXT(RECORDED_RESULT_TEXT.failed))
      .toBe("no step verdict recorded — using the test's result (recorded: failed)")
  })
})

describe('the header entry names itself', () => {
  it('ENTRY-SCOPES-RUNTIME: the entry scopes are exactly test and step', () => {
    expect([...FEEDBACK_ENTRY_SCOPES]).toEqual(['test', 'step'])
  })

  it('ENTRY-LABEL: a step, a single test and a suite test each name their target, with the plain marked suffix', () => {
    expect(feedbackEntryLabel({ scope: 'step', stepNumber: 3 })).toBe('Give feedback on step 3')
    expect(feedbackEntryLabel({ scope: 'test' })).toBe(FEEDBACK_ENTRY_TEST_LABEL)
    expect(feedbackEntryLabel({ scope: 'test', memberName: 'Checkout', handle: '#2' })).toBe('Give feedback on Checkout #2')
    expect(feedbackEntryLabel({ scope: 'test', markedChoice: 'false-fail' })).toBe(
      `${FEEDBACK_ENTRY_TEST_LABEL} — already marked: ${CHOICE_LABELS['false-fail']}`,
    )
    expect(feedbackEntryLabel({ scope: 'step', stepNumber: 1, markedChoice: 'confirmed-bug' })).toBe(
      `Give feedback on step 1 — already marked: ${CHOICE_LABELS['confirmed-bug']}`,
    )
  })
})

describe('which test the header entry means', () => {
  const suite = (...outcomes: RunDetailMember['outcome'][]) => ({
    members: outcomes.map((outcome, testIndex) => ({ testIndex, attempts: 1, ...(outcome === undefined ? {} : { outcome }) })),
  })

  it.each([
    ['a selected step wins', suite('passed', 'failed', 'failed'), { testIndex: 2, stepIndex: 0 }, undefined, 2],
    ['then the member filter', suite('passed', 'failed', 'failed'), null, 0, 0],
    ['then the first failed member, by handle order', suite('passed', 'failed', 'failed'), null, undefined, 1],
    ['then the first member', suite('passed', 'healed', 'passed'), null, undefined, 0],
    ['a filter naming no member falls through', suite('passed', 'passed', 'failed'), null, 7, 2],
    ['a single-test run always targets its test', suite('failed'), { testIndex: 4, stepIndex: 1 }, 3, 0],
  ] as const)('HEADER-TARGET-ORDER: %s', (_rung, detail, selectedStep, memberFilter, expected) => {
    expect(resolveHeaderFeedbackTarget({ detail, selectedStep, memberFilter, runStatus: 'failed' })).toEqual({ testIndex: expected })
  })

  it('HEADER-TARGET-ORDER: no projection resolves no target', () => {
    expect(resolveHeaderFeedbackTarget({ detail: undefined, selectedStep: null, memberFilter: undefined, runStatus: 'failed' })).toBeUndefined()
    expect(resolveHeaderFeedbackTarget({ detail: null, selectedStep: null, memberFilter: undefined, runStatus: 'failed' })).toBeUndefined()
  })
})

describe('a test the dashboard cannot address', () => {
  const members = (...testIds: (string | undefined)[]) => ({
    members: testIds.map((testId, testIndex) => ({ testIndex, attempts: 1, ...(testId === undefined ? {} : { testId }) })),
  })

  it('HAS-UNIQUE-ADDRESS: mirrors onMark — a suite member needs a testId no other member holds; a single test always has one', () => {
    expect(hasUniqueAddress(members(undefined), 0)).toBe(true)
    expect(hasUniqueAddress(members('t_a', 't_b'), 1)).toBe(true)
    expect(hasUniqueAddress(members('t_a', 't_a'), 0)).toBe(false)
    expect(hasUniqueAddress(members(undefined, 't_b'), 0)).toBe(false)
    expect(hasUniqueAddress(members('', 't_b'), 0)).toBe(false)
    expect(hasUniqueAddress(members('t_a', 't_b'), 5)).toBe(false)
  })

  it('HAS-UNIQUE-ADDRESS: no unique address is the first reason Send feedback is unavailable', () => {
    const base = { kind: undefined, currentKey: '', landedKey: undefined, landedOutcome: undefined, inFlight: false }
    expect(submitBlockedReason({ ...base, noUniqueAddress: true })).toBe(SUBMIT_REASON_NO_UNIQUE_ADDRESS)
    expect(submitBlockedReason({ ...base, noUniqueAddress: false })).toBe(SUBMIT_REASON_NO_CHOICE)
  })
})

describe('the step door and the passive trace name themselves', () => {
  it('MARK-GLYPH-LABEL: a passive glyph reads the plain choice; the step tooltip names the step, or says it is already marked', () => {
    expect(markGlyphLabel('false-fail')).toBe('Marked: This should have passed')
    for (const kind of MARKS) expect(markGlyphLabel(kind)).toBe(`Marked: ${CHOICE_LABELS[kind]}`)
    expect(stepTriggerTooltip(3, false)).toBe('Give feedback on step 3')
    expect(stepTriggerTooltip(3, true)).toBe('Step 3 is already marked — review or change')
  })
})

describe('the pinned target names both places', () => {
  const checkout = { testIndex: 1, name: 'checkout' }
  const login = { testIndex: 0, name: 'login' }
  const test = (entry: { testIndex: number; name: string }) => `${memberDisplayName(entry)} ${memberHandleLabel(entry.testIndex)}`

  it('PINNED-COPY: a step target names the viewed and the targeted step by number', () => {
    expect(pinnedTargetText({ stepIndex: 3 }, { stepIndex: 1 })).toBe("You're viewing step 4 — this feedback is about step 2.")
    expect(switchTargetLabel({ stepIndex: 3 })).toBe('Switch to step 4')
  })

  it('PINNED-COPY: in a suite, different tests are named by name and handle; the same test is not', () => {
    expect(pinnedTargetText({ stepIndex: 0, member: checkout }, { member: login }))
      .toBe(`You're viewing step 1 of ${test(checkout)} — this feedback is about ${test(login)}.`)
    expect(pinnedTargetText({ stepIndex: 0, member: checkout }, { stepIndex: 2, member: login }))
      .toBe(`You're viewing step 1 of ${test(checkout)} — this feedback is about step 3 of ${test(login)}.`)
    expect(pinnedTargetText({ stepIndex: 4, member: login }, { stepIndex: 2, member: login }))
      .toBe("You're viewing step 5 — this feedback is about step 3.")
    expect(switchTargetLabel({ member: checkout })).toBe(`Switch to ${test(checkout)}`)
  })

  it('PINNED-COPY: an unsent draft is named as a step, a suite test, or this test', () => {
    expect(unsentDraftLabel({ stepIndex: 1 })).toBe('Unsent draft: step 2')
    expect(unsentDraftLabel({ member: checkout })).toBe(`Unsent draft: ${test(checkout)}`)
    expect(unsentDraftLabel({})).toBe('Unsent draft: this test')
  })

  it('PINNED-COPY: a draft is empty with no choice and an empty note', () => {
    expect(isDraftEmpty({ note: '' })).toBe(true)
    expect(isDraftEmpty({ kind: 'false-fail', note: '' })).toBe(false)
    expect(isDraftEmpty({ note: 'x' })).toBe(false)
  })
})

// Each sentence comes from one `runs.mark.preview` field; a zero-count clause is dropped.
describe('the preview names what the mark will do', () => {
  it('RESOLVED-STEP-TEXT: the sentence is keyed on the read\'s reason and the kind, and a step mark has none', () => {
    expect(resolvedStepText('failing-step', 'false-fail', 3, 5)).toBe('This marks step 3 of 5 — the first step that failed.')
    for (const kind of MARKS) {
      expect(resolvedStepText('failing-step', kind, 3, 5)).toBe('This marks step 3 of 5 — the first step that failed.')
    }
    expect(resolvedStepText('passing-verdict', 'false-pass', 5, 5)).toBe('This marks step 5 of 5 — the last step, where the test finished.')
    expect(resolvedStepText('passing-verdict', 'confirmed-bug', 5, 5)).toBe('This marks step 5 of 5 — the last step, because no step failed.')
    expect(resolvedStepText('passing-verdict', 'false-fail', 5, 5)).toBe('This marks step 5 of 5 — the last step, because no step failed.')
    expect(resolvedStepText('step-mark', 'false-fail', 2, 5)).toBeUndefined()
    expect(showStepLabel(3)).toBe('Show step 3')
  })

  it('PREVIEW-STATES-RUNTIME: the preview states are exactly the published set', () => {
    expect([...FEEDBACK_PREVIEW_STATES]).toEqual(['idle', 'loading', 'consequences', 'quarantined', 'already-marked', 'refused', 'failed'])
  })

  it('PREVIEW-STATE-MAPPING: no choice is idle, nothing landed is loading, a failed read or a refusal names itself', () => {
    const read = (result: Pick<RunsMarkPreviewResult, 'kind'>) => ({ kind: 'read' as const, result: result as RunsMarkPreviewResult })
    expect(feedbackPreviewState({ kind: undefined, landed: undefined })).toBe('idle')
    expect(feedbackPreviewState({ kind: undefined, landed: read({ kind: 'consequences' }) })).toBe('idle')
    expect(feedbackPreviewState({ kind: 'false-fail', landed: undefined })).toBe('loading')
    expect(feedbackPreviewState({ kind: 'false-fail', landed: { kind: 'failed', reason: 'network' } })).toBe('failed')
    for (const refusal of MARK_PREVIEW_REFUSALS) {
      expect(feedbackPreviewState({ kind: 'false-fail', landed: read({ kind: refusal }) })).toBe('refused')
    }
    for (const arm of ['consequences', 'quarantined', 'already-marked'] as const) {
      expect(feedbackPreviewState({ kind: 'false-fail', landed: read({ kind: arm }) })).toBe(arm)
    }
    expect(PREVIEW_IDLE_TEXT).toBe('Choose an option above to see what this will do.')
    expect(PREVIEW_UPDATING_TEXT).toBe('Updating…')
    expect(PREVIEW_LINE_LABELS).toEqual({ knowledge: 'Knowledge', change: 'Change' })
  })

  it('PREVIEW-ZERO-ONE-MANY: one and many read differently, and a zero-count clause is omitted', () => {
    expect(knowledgeLine({ confirmed: 1, overturned: 0 }, 1)).toBe('1 record confirmed')
    expect(knowledgeLine({ confirmed: 2, overturned: 0 }, 2)).toBe('2 records confirmed')
    expect(knowledgeLine({ confirmed: 0, overturned: 0 }, 0)).toBe('No knowledge records are reached')
    expect(knowledgeLine({ confirmed: 1, overturned: 3 }, 3)).toBe('1 record confirmed · 3 counted against')
    expect(knowledgeLine({ confirmed: 0, overturned: 2 }, 1)).toBe('2 counted against')
    expect(knowledgeLine({ confirmed: 0, overturned: 0 }, 1)).not.toBe('')
    expect(showRecordsLabel(3)).toBe('Show records (3)')
  })

  it('PREVIEW-RECORD-EFFECT: confirms, counts against, both, a repeat count, and the unreadable sentence', () => {
    const record = (served: boolean, evidence: MarkPreviewKnowledgeRecord['evidence']): MarkPreviewKnowledgeRecord =>
      ({ recordId: 'r', served, contentAbsence: { reason: 'not-found' }, evidence })
    const overturn = { direction: 'overturn' as const, overturnsEvidenceToken: 't', overturnsCurationJobId: 'job' }
    expect(RECORD_EFFECT_TEXT).toEqual({ confirm: 'confirms', overturn: 'counts against' })
    expect(recordEffectLine(record(true, { kind: 'effects', effects: [{ direction: 'confirm' }] }))).toBe('confirms')
    expect(recordEffectLine(record(true, { kind: 'effects', effects: [{ direction: 'confirm' }, overturn] }))).toBe('confirms · counts against')
    expect(recordEffectLine(record(false, { kind: 'effects', effects: [overturn, overturn] }))).toBe('counts against × 2')
    expect(recordEffectLine(record(true, { kind: 'unreadable' }))).toBe(UNREADABLE_RECORD_TEXT)
    expect(UNREADABLE_RECORD_TEXT).toBe("This record can't be read — it keeps its place, and nothing is applied to it.")
    expect(CONTENT_ABSENCE_TEXT).toEqual({
      'not-found': 'Record content not found',
      'scan-incomplete': 'Record content could not be fully read',
      'not-bound': "Record content isn't available on this host",
    })
  })

  it('PREVIEW-CHANGE-LINE: each fix kind reads what will change, and its wording is never offered', () => {
    const checked = { servedRecords: 0, procedureReads: 0, assertionDrift: false }
    const target = { grain: 'record' as const, recordId: 'rec-1' }
    expect(previewFixText({ kind: 'knowledge', fix: 'fact', target })).toBe('A knowledge fact will be added')
    expect(previewFixText({ kind: 'knowledge', fix: 'caution', target })).toBe('A caution will be added')
    expect(previewFixText({ kind: 'knowledge', fix: 'procedure-hint', target })).toBe('A procedure hint will be added')
    expect(previewFixText({ kind: 'test-edit', testRef: 'tests/checkout.yaml' })).toBe('The test file will be edited')
    expect(previewFixText({ kind: 'no-draftable-fix', checked })).toBe('No fix can be made from this run')
    expect(previewFixText({ kind: 'confirmed-bug' }))
      .toBe('Nothing changes — a real product bug needs a product fix, not a test or knowledge change')
    expect(PREVIEW_FIX_TEXT['test-edit']).toBe('The test file will be edited')
    expect(DRAFT_WORDING_NOT_SHOWN_TEXT).toBe("The exact wording isn't shown here — it's written when you send.")
    for (const text of [PREVIEW_FIX_TEXT['test-edit'], PREVIEW_FIX_TEXT['no-draftable-fix'], PREVIEW_FIX_TEXT['confirmed-bug'],
      ...Object.values(PREVIEW_FIX_TEXT.knowledge)]) expect(text).not.toMatch(/review|proposal|draft/i)
  })

  it('PREVIEW-REPLACES-LINE: the earlier mark by ordinal and time, that its change stays, and no guessed time', () => {
    expect(replacesLine(2, '14:05')).toBe('Replaces your earlier mark (#2, 14:05); what it changed stays')
    expect(replacesLine(2, undefined)).toBe('Replaces your earlier mark (#2); what it changed stays')
  })
})

// A quarantined mark still records; a repeat, a refusal or a failed read never does.
describe('the special arms and the failed read', () => {
  const RUN_ID = generateRunId()

  it('PREVIEW-QUARANTINED: each quarantine class names its cause inside the locked sentence', () => {
    expect(quarantinedText('timeout')).toBe(
      'This test failed from a timeout, so your mark is recorded but quarantined — no knowledge or tests change.',
    )
    expect(quarantinedText('flake')).toBe(
      'This test failed from a flaky run, so your mark is recorded but quarantined — no knowledge or tests change.',
    )
    expect(quarantinedText('environment')).toBe(
      'This test failed from an environment problem, so your mark is recorded but quarantined — no knowledge or tests change.',
    )
  })

  it('PREVIEW-ALREADY-MARKED: the repeat names when it was said, and drops the time it does not know', () => {
    expect(alreadyMarkedText('Sep 23, 10:41')).toBe("You already said this (Sep 23, 10:41). A new note alone isn't recorded.")
    expect(alreadyMarkedText()).toBe("You already said this. A new note alone isn't recorded.")
  })

  it('PREVIEW-REFUSAL-TEXT: each refusal arm reads its own sentence from its own fields', () => {
    const arm = (value: Record<string, unknown>) => RunsMarkPreviewResultSchema.parse({ runId: RUN_ID, ...value })
    expect(Object.keys(PREVIEW_REFUSAL_TEXT).sort()).toEqual([...MARK_PREVIEW_REFUSALS].sort())
    expect(previewRefusalText(arm({ kind: 'run-not-found' }) as never)).toBe(
      "This run is no longer in the run store, so feedback can't be recorded.",
    )
    expect(previewRefusalText(arm({ kind: 'member-not-found', testId: 't_x' }) as never)).toBe(
      "This test can't be found in the run, so feedback can't be recorded.",
    )
    expect(previewRefusalText(arm({ kind: 'step-not-found', testIndex: 0, stepIndex: 4, stepCount: 3 }) as never)).toBe(
      'This test recorded 3 steps, so there is no step 5 to mark.',
    )
    expect(previewRefusalText(arm({ kind: 'step-not-found', testIndex: 0, stepIndex: 1, stepCount: 1 }) as never)).toBe(
      'This test recorded 1 step, so there is no step 2 to mark.',
    )
    expect(previewRefusalText(arm({ kind: 'step-not-found', testIndex: 0, stepIndex: 0, stepCount: 0 }) as never)).toBe(
      'This test recorded no steps, so there is nothing to mark.',
    )
    expect(previewRefusalText(arm({
      kind: 'ambiguous-address', candidates: [{ testIndex: 0, testId: 't_a' }, { testIndex: 1, testId: 't_a' }, { testIndex: 2 }],
    }) as never)).toBe("3 tests in this run share this address, so the mark can't be placed.")
  })

  it('PREVIEW-FAILED-TEXT: each read failure is one product sentence, then the CLI escape hatch and a named Retry', () => {
    const reasons: Record<FeedbackReadFailure, string> = {
      network: "the dashboard server didn't answer",
      'ledger-corrupt': "this run's feedback ledger is damaged",
      'ledger-unavailable': "this run's feedback ledger can't be read right now",
      refused: 'the server refused the request',
      shape: "the server's answer didn't match the expected shape",
    }
    for (const [failure, reason] of Object.entries(reasons) as [FeedbackReadFailure, string][]) {
      expect(feedbackReadFailureReason(failure)).toBe(reason)
    }
    expect(PREVIEW_READ_FAILED_TEXT("the dashboard server didn't answer")).toBe(
      "Couldn't check what this will do — the dashboard server didn't answer.",
    )
    expect(CLI_ESCAPE_TEXT).toBe('You can still record feedback from the CLI (agent-qa runs mark) or over MCP.')
    expect(feedbackPartsText(CLI_ESCAPE_PARTS)).toBe(CLI_ESCAPE_TEXT)
    expect(CLI_ESCAPE_PARTS.name).toBe('agent-qa runs mark')
    expect(RETRY_LABEL).toBe('Retry')
    expect(PREVIEW_RETRY_ACCESSIBLE_NAME).toBe('Retry checking what this will do')
    expect(PREVIEW_RETRY_ACCESSIBLE_NAME.startsWith(RETRY_LABEL)).toBe(true)
  })
})

describe('one first-match rule decides Send feedback', () => {
  const enabled: SubmitBlockInput = {
    noUniqueAddress: false,
    kind: 'false-fail',
    currentKey: 'k-now',
    landedKey: 'k-now',
    landedOutcome: 'consequences',
    inFlight: false,
  }

  it('SUBMIT-BLOCKED-REASON-ORDER: each condition alone yields its own reason, and a current consequences or quarantined read yields none', () => {
    const rows: [string, Partial<SubmitBlockInput>, string][] = [
      ['no unique address', { noUniqueAddress: true }, SUBMIT_REASON_NO_UNIQUE_ADDRESS],
      ['no choice', { kind: undefined }, SUBMIT_REASON_NO_CHOICE],
      ['nothing landed', { landedKey: undefined, landedOutcome: undefined }, SUBMIT_REASON_CHECKING],
      ['not current', { landedKey: 'k-before' }, SUBMIT_REASON_CHECKING],
      ['failed', { landedOutcome: 'failed' }, SUBMIT_REASON_PREVIEW_FAILED],
      ...MARK_PREVIEW_REFUSALS.map((kind): [string, Partial<SubmitBlockInput>, string] => [kind, { landedOutcome: kind }, SUBMIT_REASON_REFUSED]),
      ['already-marked', { landedOutcome: 'already-marked' }, SUBMIT_REASON_ALREADY_MARKED],
      ['in flight', { inFlight: true }, SUBMIT_REASON_SENDING],
      ['quarantined', { landedOutcome: 'quarantined' }, ''],
      ['consequences', {}, ''],
    ]
    for (const [name, over, reason] of rows) {
      expect(submitBlockedReason({ ...enabled, ...over }), name).toBe(reason)
    }
    expect(SUBMIT_REASON_PREVIEW_FAILED).toBe("Consequences couldn't be checked — retry above.")
    expect(SUBMIT_REASON_REFUSED).toBe("This mark can't be recorded — see above.")
    expect(SUBMIT_REASON_ALREADY_MARKED).toBe("You already said this — there's nothing new to record.")
  })

  it('SUBMIT-BLOCKED-REASON-ORDER: with every blocking condition true the first row wins, and lifting each in turn hands over to the next', () => {
    const cascade: [Partial<SubmitBlockInput>, string][] = [
      [{}, SUBMIT_REASON_NO_UNIQUE_ADDRESS],
      [{ noUniqueAddress: false }, SUBMIT_REASON_NO_CHOICE],
      [{ kind: 'false-fail' }, SUBMIT_REASON_CHECKING],
      [{ landedKey: 'k-now' }, SUBMIT_REASON_PREVIEW_FAILED],
      [{ landedOutcome: 'run-not-found' }, SUBMIT_REASON_REFUSED],
      [{ landedOutcome: 'already-marked' }, SUBMIT_REASON_ALREADY_MARKED],
      [{ landedOutcome: 'consequences' }, SUBMIT_REASON_SENDING],
      [{ inFlight: false }, ''],
    ]
    let input: SubmitBlockInput = {
      noUniqueAddress: true,
      kind: undefined,
      currentKey: 'k-now',
      landedKey: 'k-before',
      landedOutcome: 'failed',
      inFlight: true,
    }
    for (const [lift, reason] of cascade) {
      input = { ...input, ...lift }
      expect(submitBlockedReason(input), JSON.stringify(lift)).toBe(reason)
    }
  })
})

describe('Technical details copy', () => {
  it('TECHNICAL-DETAILS-ROWS: the locked row labels, and the basis with its prior mark when there is one', () => {
    expect(TECHNICAL_DETAILS_LABEL).toBe('Technical details')
    expect(TECHNICAL_DETAILS_ROW_LABELS).toEqual({
      kind: 'Mark kind',
      address: 'Address',
      testId: 'Test id',
      records: 'Reached records',
      basis: 'Basis',
    })
    expect(basisDetailText({ ledgerOrdinal: 7 })).toBe('ledger ordinal 7')
    expect(basisDetailText({ ledgerOrdinal: 7, priorMarkOrdinal: 4 })).toBe('ledger ordinal 7 · prior mark #4')
  })
})

// A time is the browser's own format of `markedAt`, so cells compute it with `formatMarkTime`.
describe('the history copy', () => {
  const RUN_ID = generateRunId()

  it('MARK-TIME-FORMAT: the month, day and 24-hour time of markedAt in the browser locale; a non-finite time has none', () => {
    const format = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    for (const ms of [0, Date.UTC(2026, 8, 23, 10, 41), Date.UTC(2026, 0, 1, 23, 5)]) {
      expect(formatMarkTime(ms)).toBe(format.format(new Date(ms)))
    }
    expect(formatMarkTime(Number.NaN)).toBeUndefined()
    expect(formatMarkTime(Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(formatMarkTime(undefined)).toBeUndefined()
  })

  it('(runtime): the history states are exactly the published set, and each read maps to its own', () => {
    expect(FEEDBACK_HISTORY_STATES).toEqual(['loading', 'history', 'empty', 'run-not-found', 'ledger-corrupt', 'ledger-unavailable', 'failed'])
    const read = (value: Record<string, unknown>) => ({ kind: 'read' as const, result: RunsMarksHistoryResultSchema.parse({ runId: RUN_ID, ...value }) })
    expect(feedbackHistoryState(undefined)).toBe('loading')
    expect(feedbackHistoryState({ kind: 'failed', reason: 'network' })).toBe('failed')
    expect(feedbackHistoryState(read({ kind: 'run-not-found' }))).toBe('run-not-found')
    expect(feedbackHistoryState(read({ kind: 'ledger-corrupt', line: 7 }))).toBe('ledger-corrupt')
    expect(feedbackHistoryState(read({ kind: 'ledger-unavailable' }))).toBe('ledger-unavailable')
    expect(feedbackHistoryState(read({ kind: 'history', entries: [] }))).toBe('empty')
    expect(feedbackHistoryState(read({
      kind: 'history',
      entries: [{
        markId: 'mark_0123456789ab', runId: RUN_ID, testIndex: 0, kind: 'false-fail', origin: 'user', ordinal: 1, markedAt: 0,
        disposition: { kind: 'no-draftable-fix', checked: { servedRecords: 0, procedureReads: 0, assertionDrift: false } },
        evidence: { confirmed: 0, overturned: 0 }, active: true,
      }],
    }))).toBe('history')
  })

  it('HISTORY-COPY: titles and counts, active and replaced, the one explanation and each state sentence', () => {
    expect(historyTitle('step', 2)).toBe('Feedback on this step (2)')
    expect(historyTitle('test', 0)).toBe('Feedback on this test (0)')
    expect(runHistoryLabel(3)).toBe('All feedback on this run (3)')
    expect(ACTIVE_TEXT).toBe('Active')
    expect(replacedByText('Sep 23, 10:41')).toBe('Replaced by your later mark at Sep 23, 10:41')
    expect(replacedByText()).toBe('Replaced by your later mark')
    expect(REPLACEMENT_EXPLANATION).toBe('Only your latest mark on a test or step counts.')
    expect(HISTORY_EMPTY_TEXT).toEqual({
      step: 'No feedback on this step yet.',
      test: 'No feedback on this test yet.',
      run: 'No feedback on this run yet.',
    })
    expect(historyStateText('run-not-found')).toBe("This run's feedback history can't be found.")
    expect(historyStateText('ledger-corrupt', 7)).toBe("This run's feedback history is damaged at line 7, so it can't be shown.")
    expect(historyStateText('ledger-unavailable')).toBe("This run's feedback history can't be read right now.")
    expect(HISTORY_READ_FAILED_TEXT(feedbackReadFailureReason('network')))
      .toBe(`Couldn't load this run's feedback history — ${feedbackReadFailureReason('network')}.`)
    expect(HISTORY_RETRY_ACCESSIBLE_NAME).toBe('Retry loading feedback history')
    expect(HISTORY_RETRY_ACCESSIBLE_NAME.startsWith(RETRY_LABEL)).toBe(true)
  })

  it('HISTORY-APPLIED-COPY: an applied fix says what it changed; a historical draft says its change was not recorded', () => {
    expect(APPLIED_KNOWLEDGE_PREFIX).toBe('Changed knowledge: ')
    expect(APPLIED_TEST_FILE_PREFIX).toBe('Edited the test file ')
    expect(APPLIED_UNAVAILABLE_TEXT).toBe('What this mark changed was not recorded.')
    expect(appliedRecordUnavailableText('mem_1')).toBe('mem_1 (content unavailable)')
    expect(dispositionText({ kind: 'drafted', fix: 'fact', proposalId: 'prop_x', proposalKind: 'knowledge' }))
      .toBe('Recorded — a fix was drafted (older mark)')
    expect(DISPOSITION_TEXT.applied).toEqual({
      fact: 'Recorded — a knowledge fact was added',
      caution: 'Recorded — a caution was added',
      'procedure-hint': 'Recorded — a procedure hint was added',
      'test-edit': 'Recorded — the test file was edited',
    })
  })

  it('HISTORY-TARGET-LABEL: a step entry names its number, total and step; a whole-test entry names its test and handle', () => {
    const detail = {
      members: [{ testIndex: 1, attempts: 1, name: 'checkout', totalSteps: 5 }],
      steps: [{ testIndex: 1, stepIndex: 1, stepText: 'apply coupon', cacheStatus: 'miss', verifierVerdict: { pass: true, reasoning: '' }, selfHealOccurred: false, briefDigest: 'd' } as const],
    }
    expect(historyTargetLabel({ testIndex: 1, stepIndex: 1 }, detail)).toEqual({ prefix: 'Step 2 of 5 · ', name: 'apply coupon' })
    expect(feedbackPartsText(historyTargetLabel({ testIndex: 1 }, detail))).toBe(`checkout ${memberHandleLabel(1)} · whole test`)
    expect(historyTargetLabel({ testIndex: 1 }, detail).name).toBe('checkout')
    expect(historyTargetLabel({ testIndex: 1, stepIndex: 3 }, detail)).toEqual({ prefix: 'Step 4 of 5 · ', name: UNNAMED_STEP_LABEL })
    expect(feedbackPartsText(historyTargetLabel({ testIndex: 0 }, null))).toBe(`${memberDisplayName({ testIndex: 0 })} ${memberHandleLabel(0)} · whole test`)
  })
})

describe('docked or stacked is one rule', () => {
  it('LAYOUT-RULE: the open composer stacks only on a measured page narrower than 768px; closed or unmeasured is docked', () => {
    expect(FEEDBACK_STACK_BELOW_PX).toBe(768)
    expect(feedbackLayout(0, true)).toBe('docked')
    expect(feedbackLayout(400, true)).toBe('stacked')
    expect(feedbackLayout(767, true)).toBe('stacked')
    expect(feedbackLayout(768, true)).toBe('docked')
    expect(feedbackLayout(1280, true)).toBe('docked')
    expect(feedbackLayout(400, false)).toBe('docked')
  })

  it('LAYOUT-RULE: each arrangement has its own panel ids, so the library keeps a layout per orientation', () => {
    expect(feedbackPanelIds('docked')).toEqual({ tree: 'run-tree', evidence: 'run-evidence', feedback: 'run-feedback' })
    expect(feedbackPanelIds('stacked')).toEqual({
      tree: 'run-tree-stacked',
      evidence: 'run-evidence-stacked',
      feedback: 'run-feedback-stacked',
    })
  })

  it('LAYOUT-RULE: stacked seeds 30/30/40 at any width; docked converts the 384px composer against the width', () => {
    const stacked = { 'run-tree-stacked': 30, 'run-evidence-stacked': 30, 'run-feedback-stacked': 40 }
    expect(feedbackDefaultLayout('stacked', 400)).toEqual(stacked)
    expect(feedbackDefaultLayout('stacked', 0)).toEqual(stacked)

    const docked = feedbackDefaultLayout('docked', 1280)
    expect(Object.keys(docked).sort()).toEqual(['run-evidence', 'run-feedback', 'run-tree'])
    expect(Object.values(docked).reduce((sum, value) => sum + value, 0)).toBeCloseTo(100)
    expect(docked['run-feedback']).toBeCloseTo(Math.min(Math.max((384 / 1280) * 100, (320 / 1280) * 100), 50))
    expect(docked['run-tree']! / docked['run-evidence']!).toBeCloseTo(35 / 65)
    expect(feedbackDefaultLayout('docked', 800)['run-feedback']).toBeCloseTo(48)
    expect(feedbackDefaultLayout('docked', 700)['run-feedback']).toBe(50)
    expect(feedbackDefaultLayout('docked', 0)['run-feedback']).toBe(30)
  })

  it('LAYOUTS-RUNTIME: the layouts are exactly docked and stacked', () => {
    expect([...FEEDBACK_LAYOUTS]).toEqual(['docked', 'stacked'])
  })
})
