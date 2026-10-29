// the runner's judge over the verifier's per-condition
// output, case by case. judgeConditions is called directly with hand-built citation sources; the
// fallback cell drives a real LLMVerifier over a failing fake model. C439-COVERAGE and
// C439-PHRASES pin the coverage and phrase checks.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { asRef, stepOutcomeUnproven } from '@vostride/agent-qa-schema'
import type {
  CitationSource,
  ConditionRecord,
  ConditionVerdictsEvidence,
} from '@vostride/agent-qa-schema'
import type { Action } from '../../platform.js'
import { makeScreenState } from '../../testing/screen-fixtures.js'
import { buildVerifierCitationSources } from '../prompts.js'
import {
  admitsNotDone,
  coverConditions,
  judgeConditions,
  stemWord,
  tokenize,
} from '../requested-conditions.js'
import type { CitationSources, JudgeConditionsInput } from '../requested-conditions.js'
import type { RecordedAction, VerifierStepRecord } from '../step-record.js'
import type { ConditionJudgment, VerificationResult } from '../types.js'
import { LLMVerifier } from '../verifier.js'
import { SecretRedactor, SecretStore } from '../secrets.js'
import { makeFakeTokenAccounting } from './loop-harness.js'

vi.mock('ai', async (importActual) => {
  const actual = await importActual<typeof import('ai')>()
  return { ...actual, generateText: vi.fn() }
})

const STEP = 'Send the message'
const identity = (value: string) => value
const signInRedactor = new SecretRedactor(new SecretStore({ SIGNIN_EMAIL: 'sam.taylor@example.test' }))
const maskSignIn = (value: string) => signInRedactor.redactString(value)

function sources(parts: Partial<CitationSources> = {}): CitationSources {
  return { 'start-screen': '', 'final-screen': '', action: '', read: '', carried: '', ...parts }
}

function judgment(
  verdict: ConditionJudgment['verdict'],
  citations: { source: CitationSource; quote: string }[] = [],
  overrides: Partial<ConditionJudgment> = {},
): ConditionJudgment {
  return {
    quote: STEP,
    verdict,
    needs: 'none',
    controlRef: '',
    file: { name: '', match: 'none', text: '' },
    citations,
    reasoning: `judged ${verdict}`,
    ...overrides,
  }
}

function output(conditions: ConditionJudgment[], extra: Partial<VerificationResult> = {}): VerificationResult {
  return { conditions, dialogs: [], isAppError: false, reasoning: 'overall', ...extra }
}

function judge(input: Partial<JudgeConditionsInput> & Pick<JudgeConditionsInput, 'output'>) {
  return judgeConditions({
    stepText: STEP,
    sources: sources(),
    mask: identity,
    imageAttached: false,
    ending: 'completion',
    ...input,
  })
}

function record(verdict: ConditionRecord['verdict']): ConditionRecord {
  return { quote: STEP, verdict, reason: 'r', citations: [] }
}

function block(
  ending: ConditionVerdictsEvidence['ending'],
  verdicts: ConditionRecord['verdict'][],
): { conditionVerdicts: ConditionVerdictsEvidence } {
  return { conditionVerdicts: { ending, conditions: verdicts.map(record) } }
}

const START = makeScreenState({ url: 'https://x/orders', tree: '- heading "Orders" [ref=e1]' })
const ROW_FINAL = makeScreenState({ url: 'https://x/orders', tree: '- row "Order 1001" [ref=e5]' })
const DARK_FINAL = makeScreenState({ url: 'https://x/settings', tree: '- radio "Dark" [checked] [ref=e4]' })

function stepRecord(actions: Omit<RecordedAction, 'index'>[]): VerifierStepRecord {
  return { startScreen: START, actions: actions.map((entry, i) => ({ index: i + 1, ...entry })), reads: [], carried: [] }
}

const DOWNLOAD_RECORD = stepRecord([
  {
    action: { type: 'click', ref: asRef('e2') },
    element: { role: 'button', name: 'Download CSV' },
    outcome: 'success',
    operationEvidence: {
      downloads: [{ suggestedFilename: 'orders.csv', extension: '.csv', size: 120, sha256: '0a1b', state: 'completed' }],
    },
  },
])

const THEME_RECORD = stepRecord([
  { action: { type: 'click', ref: asRef('e4') }, element: { role: 'radio', name: 'Dark' }, outcome: 'success' },
  { action: { type: 'click', ref: asRef('e5') }, element: { role: 'button', name: 'Save' }, outcome: 'success' },
  { action: { type: 'navigate', to: 'reload' } as Action, outcome: 'success' },
])

const CLICK_RECORD = stepRecord([
  { action: { type: 'click', ref: asRef('e3') }, element: { role: 'button', name: 'Go' }, outcome: 'success' },
])

const PROFILE_FINAL = makeScreenState({
  url: 'https://x/profile',
  tree: '- heading "Profile" [ref=e1]\n- textbox "Display name": Alex [ref=e2]',
})
const LIGHT_FINAL = makeScreenState({
  url: 'https://x/settings',
  tree: '- heading "Settings" [ref=e1]\n- radio "Light" [checked] [ref=e4]',
})

const DEAD_SAVE_RECORD = stepRecord([
  {
    action: { type: 'fill', ref: asRef('e2'), text: 'Sam', clearMode: 'replace', submit: false },
    element: { role: 'textbox', name: 'Display name' },
    outcome: 'success',
  },
  { action: { type: 'click', ref: asRef('e3') }, element: { role: 'button', name: 'Save' }, outcome: 'success' },
  { action: { type: 'navigate', to: 'reload' } as Action, outcome: 'success' },
])

const SAVE_READ_RECORD: VerifierStepRecord = {
  ...stepRecord([
    { action: { type: 'click', ref: asRef('e3') }, element: { role: 'button', name: 'Save' }, outcome: 'success' },
    {
      action: { type: 'assertValue', source: 'title', op: 'equals', expected: 'Settings' } as never,
      outcome: 'success',
    },
  ]),
  reads: [
    {
      index: 2,
      kind: 'assertValue',
      text: 'title equals "Settings": passed',
      assert: { source: 'title', op: 'equals', expected: 'Settings', passed: true },
    },
  ],
}

const SAVE_DOWNLOAD_RECORD = stepRecord([
  {
    action: { type: 'click', ref: asRef('e3') },
    element: { role: 'button', name: 'Save' },
    outcome: 'success',
    operationEvidence: {
      downloads: [{ suggestedFilename: 'orders.csv', extension: '.csv', size: 120, sha256: '0a1b', state: 'completed' }],
    },
  },
])

function judgeRecord(
  step: string,
  recorded: VerifierStepRecord,
  citation: { source: CitationSource; quote: string },
  reasoning: string,
  options: { final?: ReturnType<typeof makeScreenState>; needs?: ConditionJudgment['needs'] } = {},
) {
  const final = options.final ?? ROW_FINAL
  const last = recorded.actions[recorded.actions.length - 1]!.action
  return judgeConditions({
    stepText: step,
    output: output([
      judgment('met', [citation], { quote: step, reasoning, needs: options.needs ?? 'none' }),
    ]),
    sources: buildVerifierCitationSources(recorded.startScreen, final, last, undefined, recorded),
    mask: identity,
    imageAttached: false,
    ending: 'completion',
    guards: { finalElements: final.elements, platform: final.platform, record: recorded, imageAttached: false },
  })
}

describe('judging requested conditions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('a quote differing only in whitespace and line breaks is found', () => {
    const result = judge({
      output: output([judgment('met', [{ source: 'final-screen', quote: 'heading  "Message\n sent"' }])]),
      sources: sources({ 'final-screen': '- heading "Message sent" [ref=e1]' }),
    })

    expect(result.pass).toBe(true)
    expect(result.evidence.conditions[0].verdict).toBe('met')
    expect(result.evidence.conditions[0].citations[0]).toMatchObject({
      source: 'final-screen',
      found: true,
    })
  })

  it('a masked placeholder in a quote matches the clear value in the record', () => {
    const placeholder = maskSignIn('sam.taylor@example.test')
    expect(placeholder).toBe('[secret:SIGNIN_EMAIL]')

    const result = judge({
      output: output([judgment('met', [{ source: 'final-screen', quote: `Signed in as ${placeholder}` }])]),
      sources: sources({ 'final-screen': '- text "Signed in as sam.taylor@example.test" [ref=e2]' }),
      mask: maskSignIn,
    })

    expect(result.pass).toBe(true)
    expect(result.evidence.conditions[0].citations[0]).toEqual({
      source: 'final-screen',
      quote: `Signed in as ${placeholder}`,
      found: true,
    })
  })

  it('a quote under three non-space characters never counts', () => {
    const result = judge({
      output: output([judgment('met', [{ source: 'final-screen', quote: 'OK' }])]),
      sources: sources({ 'final-screen': '- button "OK" [ref=e1]' }),
    })

    expect(result.pass).toBe(false)
    expect(result.evidence.conditions[0]).toMatchObject({
      verdict: 'unverified',
      judged: 'met',
      guard: 'citation-missing',
    })
    expect(result.evidence.conditions[0].citations[0].found).toBe(false)
  })

  it('a citation found in another part records where it was found', () => {
    const result = judge({
      output: output([judgment('met', [{ source: 'start-screen', quote: 'Message sent' }])]),
      sources: sources({
        'start-screen': '- button "Send" [ref=e1]',
        'final-screen': '- heading "Message sent" [ref=e2]',
      }),
    })

    expect(result.pass).toBe(true)
    expect(result.evidence.conditions[0].citations[0]).toEqual({
      source: 'final-screen',
      quote: 'Message sent',
      found: true,
    })
  })

  it('a verifier error is unverified, never a pass', () => {
    const result = judge({
      output: output([judgment('met', [{ source: 'final-screen', quote: 'Message sent' }])], {
        verifierError: 'Overloaded',
      }),
      sources: sources({ 'final-screen': '- heading "Message sent"' }),
    })

    expect(result.pass).toBe(false)
    expect(result.evidence.conditions).toHaveLength(1)
    expect(result.evidence.conditions[0]).toMatchObject({
      quote: STEP,
      verdict: 'unverified',
      guard: 'verifier-error',
    })
    expect(result.evidence.conditions[0].reason).toContain('Overloaded')
    expect(result.reason.startsWith('Unverified:')).toBe(true)
  })

  it('the real verifier falls back to no conditions when the model call fails', async () => {
    const { generateText } = await import('ai')
    const before = makeScreenState()
    const after = makeScreenState()
    const action: Action = { type: 'click', ref: asRef('e2') }
    vi.mocked(generateText).mockRejectedValueOnce(new Error('Overloaded'))

    const verifier = new LLMVerifier({} as never, makeFakeTokenAccounting())
    const result = await verifier.verify(STEP, before, after, action)

    expect(result.verification.verifierError).toBe('Overloaded')
    expect(result.verification.conditions).toEqual([])
    const judged = judge({ output: result.verification })
    expect(judged.pass).toBe(false)
    expect(judged.evidence.conditions[0].guard).toBe('verifier-error')

    vi.mocked(generateText).mockRejectedValueOnce(new Error('The operation was aborted'))
    const controller = new AbortController()
    controller.abort()
    await expect(
      verifier.verify(STEP, before, after, action, undefined, controller.signal),
    ).rejects.toThrow('The operation was aborted')
  })

  it('not-met, unverified and inconclusive each block the pass and the reason lists them in that order', () => {
    const long = `The receipt was sent to sam.taylor@example.test ${'and more words '.repeat(30)}`
    const result = judge({
      output: output([
        judgment('unverified', [], { quote: 'the message', reasoning: long }),
        judgment('not-met', [], { quote: 'Send', reasoning: 'The Send button is still enabled' }),
        judgment('inconclusive', [], { quote: 'Send the message', reasoning: 'Colour needs an image' }),
      ]),
      mask: maskSignIn,
    })

    expect(result.pass).toBe(false)
    const notMet = result.reason.indexOf('Not met:')
    const unverified = result.reason.indexOf('Unverified:')
    const inconclusive = result.reason.indexOf('Inconclusive:')
    expect(notMet).toBe(0)
    expect(unverified).toBeGreaterThan(notMet)
    expect(inconclusive).toBeGreaterThan(unverified)
    expect(result.reason).toContain('"Send" (The Send button is still enabled)')
    expect(result.reason).not.toContain('sam.taylor@example.test')
    expect(result.reason).toContain('[secret:SIGNIN_EMAIL]')
    for (const condition of result.evidence.conditions) {
      expect(condition.reason.length).toBeLessThanOrEqual(200)
    }
    expect(result.evidence.conditions.map((condition) => condition.verdict)).toEqual([
      'unverified',
      'not-met',
      'inconclusive',
    ])
  })

  it("stepOutcomeUnproven counts the verifier's endings and an unresolved judgment, never a timeout or a cancel", () => {
    expect(stepOutcomeUnproven(block('completion', ['met', 'unverified']))).toBe(true)
    expect(stepOutcomeUnproven(block('completion', ['unverified', 'not-met']))).toBe(false)
    expect(stepOutcomeUnproven(block('unresolved', ['unverified']))).toBe(true)
    expect(stepOutcomeUnproven(block('timeout', ['unverified']))).toBe(false)
    expect(stepOutcomeUnproven(block('cancelled', ['unverified']))).toBe(false)
    expect(stepOutcomeUnproven({})).toBe(false)
  })
})

function uncoveredWords(step: string, quotes: string[]): string[] {
  const coverage = coverConditions(tokenize(step), quotes.map(tokenize))
  return coverage.uncovered.map((token) => token.text)
}

describe('step word coverage by quoted conditions', () => {
  it('stop words never need coverage', () => {
    expect(uncoveredWords('Please verify that the banner is shown', ['banner'])).toEqual(['shown'])
    expect(uncoveredWords('Check the cart and then confirm it', ['cart'])).toEqual([])
  })

  it('overlapping quotes cover the first clause once', () => {
    const step = 'Add the blue mug to the cart and verify the cart shows 2 items'
    const coverage = coverConditions(
      tokenize(step),
      ['Add the blue mug', 'blue mug to the cart'].map(tokenize),
    )
    expect(coverage.inStep).toEqual([true, true])
    expect(coverage.uncovered.map((token) => token.text)).toEqual(['cart', 'shows', '2', 'items'])
  })

  it('a quote occurring twice covers both occurrences', () => {
    expect(uncoveredWords('Click Next, then click Next again', ['click Next'])).toEqual(['again'])
  })

  it('a placeholder token in the step is covered by a quote holding it', () => {
    const step = maskSignIn('Sign in as sam.taylor@example.test')
    const placeholder = maskSignIn('sam.taylor@example.test')
    expect(placeholder).toBe('[secret:SIGNIN_EMAIL]')
    expect(tokenize(step).map((token) => token.text)).toContain(placeholder)
    expect(uncoveredWords(step, ['Sign in'])).toEqual([placeholder])
    expect(uncoveredWords(step, [`Sign in as ${placeholder}`])).toEqual([])

    const result = judge({
      stepText: 'Sign in as sam.taylor@example.test',
      output: output([
        judgment('met', [{ source: 'final-screen', quote: 'Welcome' }], {
          quote: `Sign in as ${placeholder}`,
        }),
      ]),
      sources: sources({ 'final-screen': '- heading "Welcome" [ref=e1]' }),
      mask: maskSignIn,
    })
    expect(result.pass).toBe(true)
  })

  it('full-width digits match ASCII after NFKC', () => {
    expect(uncoveredWords('Verify the cart shows \uFF12 items', ['the cart shows 2 items'])).toEqual(
      [],
    )
  })

  it('a verify step quoted without its verb is fully covered', () => {
    const step = 'Verify the cart shows 2 items'
    expect(uncoveredWords(step, ['the cart shows 2 items'])).toEqual([])
    const result = judge({
      stepText: step,
      output: output([
        judgment('met', [{ source: 'final-screen', quote: 'Cart: 2 items' }], {
          quote: 'the cart shows 2 items',
        }),
      ]),
      sources: sources({ 'final-screen': '- text "Cart: 2 items" [ref=e1]' }),
    })
    expect(result.pass).toBe(true)
    expect(result.evidence.conditions).toHaveLength(1)
  })

  it('a quote that is not a run of the step words is unverified and its words stay uncovered', () => {
    const step = 'Verify the cart shows 2 items'
    const result = judge({
      stepText: step,
      output: output([
        judgment('met', [{ source: 'final-screen', quote: 'Cart: 2 items' }], {
          quote: 'the cart shows items',
        }),
      ]),
      sources: sources({ 'final-screen': '- text "Cart: 2 items" [ref=e1]' }),
    })
    expect(result.pass).toBe(false)
    expect(result.evidence.conditions[0]).toMatchObject({
      verdict: 'unverified',
      judged: 'met',
      guard: 'quote-not-in-step',
    })
    expect(result.evidence.conditions[1]).toMatchObject({
      quote: 'cart shows 2 items',
      verdict: 'unverified',
      guard: 'not-covered',
      reason: 'No condition covers these words of the step',
    })
  })
})

describe('verdict phrases about an unchanged page or an unproven effect', () => {
  it.each([
    ['The setting has not been saved', 'Save the setting', 'has not been saved'],
    ["The message wasn't sent", 'Send the message', "wasn't sent"],
    ['I did not submit it', 'Submit the form', 'did not submit'],
    ['The app failed to export the file', 'Export orders', 'failed to export'],
    ['Clicked Pay but nothing happened', 'Click Pay', 'nothing happened'],
  ])('refused: %s on %s', (reasoning, quote, phrase) => {
    expect(admitsNotDone(reasoning, quote)).toBe(phrase)
  })

  it.each([
    ['The dialog has not reappeared', 'Close the dialog'],
    ['No error is shown', 'Verify no error is shown'],
    ['The card was not charged twice', 'Pay once'],
    ['Clicked the tab and nothing happened', 'Open the Help tab'],
    ['The error is not visible', 'Verify the error is not visible'],
  ])('kept met: %s on %s', (reasoning, quote) => {
    expect(admitsNotDone(reasoning, quote)).toBeUndefined()
  })

  it.each([
    ['Nothing changed on the page, but the operation evidence shows orders.csv completed', 'Click Download CSV'],
    ['Nothing changed visually, the clipboard holds the link', 'Copy the order link'],
    ['nothing happened on screen, but after the reload the value is kept', 'Click Save'],
    ['The screen did not change; the background save completed and the reload shows it', 'Change the theme and save'],
  ])('known limitation: a proven effect described as an unchanged page is refused: %s on %s', (reasoning, quote) => {
    expect(admitsNotDone(reasoning, quote)).toBeDefined()
  })

  it.each([
    ['Nothing changed on the page; the order was not paid', 'Click Pay', 'was not paid'],
    ['Nothing happened on screen; the button did nothing', 'Click Save', 'Nothing happened'],
    ['Nothing changed visually, but clicking Send had no effect', 'Click Send', 'Nothing changed'],
    ['The screen did not change and the file was not downloaded', 'Change the format and download CSV', 'did not change'],
    ['The page did not change, but it was not saved', 'Change the theme and save', 'did not change'],
  ])('still refused beside an unchanged screen: %s on %s', (reasoning, quote, phrase) => {
    expect(admitsNotDone(reasoning, quote)).toBe(phrase)
  })

  it.each([
    ['The theme on the page did not change', 'Change the theme and save', 'did not change'],
    ['Nothing changed in the display name field', 'Change the display name and save', 'Nothing changed'],
    ['Nothing changed on the page, the row is still listed', 'Delete the first row', 'Nothing changed'],
    ['did nothing on the page', 'Click Save', 'did nothing'],
    ['nothing happened on screen and the order was not placed', 'Place the order', 'was not placed'],
  ])('refused although it mentions the screen: %s on %s', (reasoning, quote, phrase) => {
    expect(admitsNotDone(reasoning, quote)).toBe(phrase)
  })

  it('known limitation: a proven effect described as an unchanged page is refused: a proven download', () => {
    const step = 'Click Download CSV'
    const result = judge({
      stepText: step,
      output: output([
        judgment('met', [{ source: 'action', quote: 'Download "orders.csv" (.csv): completed' }], {
          quote: step,
          reasoning: 'Nothing changed on the page, but the operation evidence shows orders.csv completed',
        }),
      ]),
      sources: sources({ action: '1. click on ref="e2" → success\naction 1: Download "orders.csv" (.csv): completed' }),
      plannerReasoning: 'nothing happened on screen, but the download completed',
      guards: {
        finalElements: [],
        platform: 'web',
        imageAttached: false,
        record: { actions: [DOWNLOAD_RECORD.actions[0]!], reads: [] },
      },
    })

    expect(result.evidence.conditions[0]).toMatchObject({
      verdict: 'not-met',
      guard: 'admits-not-done',
      reason: 'The reasoning says "Nothing changed"',
    })
    expect(result.pass).toBe(false)
  })

  it.each([
    ['Nothing changed on the page, the download of orders.csv completed', 'Click Download CSV', 'Nothing changed'],
    ['Although nothing changed on screen, orders.csv was downloaded', 'Click Download CSV', 'nothing changed'],
  ])('known limitation: a proven effect described as an unchanged page is refused end to end: %s on %s', (reasoning, step, phrase) => {
    const result = judgeRecord(step, DOWNLOAD_RECORD, { source: 'action', quote: 'Download "orders.csv" (.csv): completed' }, reasoning)
    expect(result.evidence.conditions[0]).toMatchObject({
      verdict: 'not-met',
      guard: 'admits-not-done',
      reason: `The reasoning says "${phrase}"`,
    })
    expect(result.pass).toBe(false)
  })

  it('known limitation: a proven effect described as an unchanged page is refused: a saved theme re-read after the reload', () => {
    const result = judgeRecord(
      'Change the theme to dark and save',
      THEME_RECORD,
      { source: 'final-screen', quote: 'radio "Dark" [checked]' },
      'Although the page did not change, the reload shows the dark theme',
      { final: DARK_FINAL, needs: 'persistence' },
    )
    expect(result.evidence.conditions[0]).toMatchObject({
      verdict: 'not-met',
      guard: 'admits-not-done',
      reason: 'The reasoning says "did not change"',
    })
    expect(result.pass).toBe(false)
  })

  it.each([
    ['Nothing changed visually, the row is still listed', 'Delete the first row', 'Nothing changed'],
    ['Nothing changed visually in the display name field', 'Change the display name', 'Nothing changed'],
    ['Nothing changed', 'Change the display name', 'Nothing changed'],
    ['The UI did not change', 'Change the UI theme to dark', 'did not change'],
    ['Nothing happened on the page.', 'Click Pay', 'Nothing happened'],
  ])('refused end to end without proof of the effect: %s on %s', (reasoning, step, phrase) => {
    const result = judgeRecord(step, CLICK_RECORD, { source: 'final-screen', quote: 'row "Order 1001"' }, reasoning)
    expect(result.evidence.conditions[0]!.citations[0]?.found).toBe(true)
    expect(result.evidence.conditions[0]).toMatchObject({
      verdict: 'not-met',
      guard: 'admits-not-done',
      reason: `The reasoning says "${phrase}"`,
    })
    expect(result.pass).toBe(false)
  })

  it('an assertion-only step is not refused for an unchanged page', () => {
    const result = judgeRecord(
      'Verify the first row is listed',
      CLICK_RECORD,
      { source: 'final-screen', quote: 'row "Order 1001"' },
      'Nothing changed on the page, the first row is listed',
    )
    expect(result.evidence.conditions[0]).toMatchObject({ verdict: 'met' })
    expect(result.pass).toBe(true)
  })

  it.each([
    ['The display name did not change; the Profile heading shows after the reload', 'persistence', 'did not change'],
    ['The display name did not change; the Profile heading shows after the reload', 'none', 'did not change'],
    ['Nothing changed in the display name field after Save', 'persistence', 'Nothing changed'],
    ['Nothing changed in the display name field after Save', 'none', 'Nothing changed'],
  ] as const)('a dead save after a reload is refused: %s (needs %s)', (reasoning, needs, phrase) => {
    const result = judgeRecord(
      'Change the display name to Sam and save',
      DEAD_SAVE_RECORD,
      { source: 'final-screen', quote: 'heading "Profile"' },
      reasoning,
      { final: PROFILE_FINAL, needs },
    )
    expect(result.evidence.conditions[0]!.citations[0]?.found).toBe(true)
    expect(result.evidence.conditions[0]).toMatchObject({
      verdict: 'not-met',
      guard: 'admits-not-done',
      reason: `The reasoning says "${phrase}"`,
    })
    expect(result.pass).toBe(false)
  })

  it('a dead theme save after a reload is refused: The theme did not change after Save', () => {
    const result = judgeRecord(
      'Change the theme to dark and save',
      THEME_RECORD,
      { source: 'final-screen', quote: 'heading "Settings"' },
      'The theme did not change after Save',
      { final: LIGHT_FINAL, needs: 'persistence' },
    )
    expect(result.evidence.conditions[0]).toMatchObject({ verdict: 'not-met', guard: 'admits-not-done' })
    expect(result.pass).toBe(false)
  })

  it.each([
    ['an unrelated passed read', SAVE_READ_RECORD, { source: 'read', quote: 'title equals "Settings": passed' }, 'Nothing happened after clicking Save', 'Nothing happened'],
    ['a download line', SAVE_DOWNLOAD_RECORD, { source: 'action', quote: 'Download "orders.csv" (.csv): completed' }, 'Nothing changed after clicking Save', 'Nothing changed'],
  ] as const)('a dead save citing %s is refused', (_label, recorded, citation, reasoning, phrase) => {
    const result = judgeRecord('Click Save', recorded, citation, reasoning)
    expect(result.evidence.conditions[0]!.citations[0]?.found).toBe(true)
    expect(result.evidence.conditions[0]).toMatchObject({
      verdict: 'not-met',
      guard: 'admits-not-done',
      reason: `The reasoning says "${phrase}"`,
    })
    expect(result.pass).toBe(false)
  })

  it('stemWord folds the inflections the check compares', () => {
    const pairs: [string, string][] = [
      ['submitted', 'submit'],
      ['saved', 'save'],
      ['copied', 'copy'],
      ['sent', 'send'],
      ['paid', 'pay'],
      ['deleted', 'delete'],
      ['downloaded', 'download'],
      ['placed', 'place'],
    ]
    for (const [inflected, base] of pairs) {
      expect(stemWord(inflected), inflected).toBe(stemWord(base))
    }
  })

  it('a met condition whose reasoning admits it is not met, and the reason quotes the phrase', () => {
    const result = judge({
      stepText: 'Save the setting',
      output: output([
        judgment('met', [{ source: 'final-screen', quote: 'Settings' }], {
          quote: 'Save the setting',
          reasoning: 'The toggle moved but the setting has not been saved',
        }),
      ]),
      sources: sources({ 'final-screen': '- heading "Settings" [ref=e1]' }),
    })
    expect(result.pass).toBe(false)
    expect(result.evidence.conditions[0]).toMatchObject({
      verdict: 'not-met',
      judged: 'met',
      guard: 'admits-not-done',
      reason: 'The reasoning says "has not been saved"',
    })
  })

  it("the planner's completion reasoning refuses a met condition", () => {
    const met = output([
      judgment('met', [{ source: 'final-screen', quote: 'Message sent' }]),
    ])
    const sourcesWithLine = sources({ 'final-screen': '- heading "Message sent" [ref=e1]' })
    const refused = judge({
      output: met,
      sources: sourcesWithLine,
      plannerReasoning: "Typed the text; the message wasn't sent yet",
    })
    expect(refused.pass).toBe(false)
    expect(refused.evidence.conditions[0].guard).toBe('admits-not-done')
    const kept = judge({
      output: met,
      sources: sourcesWithLine,
      plannerReasoning: 'Clicked Send and the message appears in the thread',
    })
    expect(kept.pass).toBe(true)
  })
})
