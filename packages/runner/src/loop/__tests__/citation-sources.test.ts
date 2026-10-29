// C439-CITATION-EVIDENCE (439 D-10): a citation is found only in text the application or the runner
// observed. The planner's own words in the record (a failed read's expected value, a claim judged
// false, an action's claim, query or typed value) stay in the verifier's prompt but are never
// citable. Model-free: buildVerifierCitationSources feeds judgeConditions directly.

import { describe, expect, it } from 'vitest'
import type { CitationSource } from '@vostride/agent-qa-schema'
import type { Action } from '../../platform.js'
import { makeScreenState } from '../../testing/screen-fixtures.js'
import { buildVerificationPrompt, buildVerifierCitationSources } from '../prompts.js'
import { judgeConditions } from '../requested-conditions.js'
import type { RecordedAction, RecordedRead, VerifierStepRecord } from '../step-record.js'
import type { ConditionJudgment } from '../types.js'

const identity = (value: string) => value
const START = makeScreenState({ url: 'https://x/cart', tree: '- heading "Cart" [ref=e9]' })
const FINAL = makeScreenState({ url: 'https://x/cart', tree: '- heading "Your cart" [ref=e9]' })

const FILL: Action = { type: 'fill', ref: 'e1', text: 'Sam Taylor' } as Action
const ASSERT_URL: Action = { type: 'assertValue', source: 'url', op: 'equals', expected: 'https://x/orders' } as Action
const ASSERT_CLAIM: Action = {
  type: 'assertAI',
  claim: 'The order was placed',
  mode: 'text',
} as Action
const EXTRACT: Action = {
  type: 'extractAI',
  query: 'The confirmation number shown',
  schema: [],
} as unknown as Action

function action(index: number, entry: Omit<RecordedAction, 'index'>): RecordedAction {
  return { index, ...entry }
}

function record(actions: RecordedAction[], reads: RecordedRead[] = []): VerifierStepRecord {
  return { startScreen: START, actions, reads, carried: [] }
}

const FAILED_URL_READ: RecordedRead = {
  index: 1,
  kind: 'assertValue',
  text: 'url equals "https://x/orders": failed (read "https://x/cart")',
  assert: { source: 'url', op: 'equals', expected: 'https://x/orders', passed: false },
}

const FALSE_CLAIM_READ: RecordedRead = {
  index: 1,
  kind: 'assertAI',
  text: '"The order was placed" (text): judged false: the cart still lists two items',
  claim: 'The order was placed',
  judged: false,
  mode: 'text',
}

const PASSED_TEXT_READ: RecordedRead = {
  index: 1,
  kind: 'assertValue',
  text: 'text contains "Order placed": passed (read "Order placed #42")',
  assert: { source: 'text', op: 'contains', expected: 'Order placed', passed: true },
}

const URL_RECORD = record(
  [action(1, { action: ASSERT_URL, outcome: 'failure', error: 'assertValue on source "url" (equals) did not hold — re-observe or declare the step failed via stepFailed.' })],
  [FAILED_URL_READ],
)

const CLAIM_RECORD = record(
  [
    action(1, {
      action: ASSERT_CLAIM,
      outcome: 'failure',
      error: 'Claim "The order was placed" judged false: the cart still lists two items — re-observe the screen or declare the step failed via stepFailed.',
    }),
  ],
  [FALSE_CLAIM_READ],
)

const FILL_RECORD = record([
  action(1, { action: FILL, element: { role: 'textbox', name: 'Full name' }, outcome: 'success' }),
])

function judge(
  stepRecord: VerifierStepRecord,
  stepText: string,
  citations: { source: CitationSource; quote: string }[],
  final = FINAL,
) {
  const last = stepRecord.actions[stepRecord.actions.length - 1]!.action
  const condition: ConditionJudgment = {
    quote: stepText,
    verdict: 'met',
    needs: 'none',
    controlRef: '',
    file: { name: '', match: 'none', text: '' },
    citations,
    reasoning: 'judged met',
  }
  return judgeConditions({
    stepText,
    output: { conditions: [condition], dialogs: [], isAppError: false, reasoning: 'overall' },
    sources: buildVerifierCitationSources(stepRecord.startScreen, final, last, undefined, stepRecord),
    mask: identity,
    imageAttached: false,
    ending: 'completion',
  })
}

function expectNotCitable(result: ReturnType<typeof judge>): void {
  const condition = result.evidence.conditions[0]!
  expect(condition.citations[0]?.found).toBe(false)
  expect(condition.verdict).not.toBe('met')
  expect(result.pass).toBe(false)
}

function expectCitable(result: ReturnType<typeof judge>): void {
  const condition = result.evidence.conditions[0]!
  expect(condition.citations[0]?.found).toBe(true)
  expect(condition.verdict).toBe('met')
  expect(result.pass).toBe(true)
}

describe('which record lines a verdict may cite', () => {
  it("a failed assertValue's expected value is not citable", () => {
    const step = 'Open the orders page'
    expectNotCitable(judge(URL_RECORD, step, [{ source: 'read', quote: 'https://x/orders' }]))
    expectNotCitable(judge(URL_RECORD, step, [{ source: 'action', quote: 'https://x/orders' }]))
    expectCitable(judge(URL_RECORD, step, [{ source: 'read', quote: 'https://x/cart' }]))
  })

  it('an assertAI claim judged false is not citable', () => {
    const step = 'Place the order'
    expectNotCitable(judge(CLAIM_RECORD, step, [{ source: 'read', quote: 'The order was placed' }]))
    expectNotCitable(judge(CLAIM_RECORD, step, [{ source: 'action', quote: 'The order was placed' }]))
    expectNotCitable(judge(CLAIM_RECORD, step, [{ source: 'read', quote: 'the cart still lists two items' }]))
  })

  it("the planner's unverified claim and extraction query on an action line are not citable", () => {
    const step = 'Place the order'
    const passedClaim = record([action(1, { action: ASSERT_CLAIM, outcome: 'success' })])
    expectNotCitable(judge(passedClaim, step, [{ source: 'action', quote: 'The order was placed' }]))
    const extracted = record([action(1, { action: EXTRACT, outcome: 'success' })])
    expectNotCitable(judge(extracted, step, [{ source: 'action', quote: 'The confirmation number shown' }]))
    expectCitable(judge(passedClaim, step, [{ source: 'action', quote: '→ success' }]))
  })

  it('a typed value is not citable from the action line', () => {
    const step = 'Enter Sam Taylor as the name'
    expectNotCitable(judge(FILL_RECORD, step, [{ source: 'action', quote: 'Sam Taylor' }]))
    const shown = makeScreenState({ url: 'https://x/cart', tree: '- textbox "Full name": Sam Taylor [ref=e1]' })
    expectCitable(judge(FILL_RECORD, step, [{ source: 'final-screen', quote: 'Sam Taylor' }], shown))
    expectCitable(judge(FILL_RECORD, step, [{ source: 'action', quote: '(textbox "Full name") → success' }]))
  })

  it('a passed read stays citable', () => {
    const passed = record(
      [action(1, { action: { type: 'assertValue', source: 'url', op: 'contains', expected: 'Order placed' } as Action, outcome: 'success' })],
      [PASSED_TEXT_READ],
    )
    expectCitable(judge(passed, 'Place the order', [{ source: 'read', quote: 'Order placed #42' }]))
    expectCitable(judge(passed, 'Place the order', [{ source: 'read', quote: 'contains "Order placed": passed' }]))
  })

  it("a failed waitFor's expected text is not citable", () => {
    const waited = record([
      action(1, { action: { type: 'click', ref: 'e3' } as Action, element: { role: 'button', name: 'Place order' }, outcome: 'success' }),
      action(2, {
        action: { type: 'waitFor', on: 'text', text: 'Order confirmed' } as unknown as Action,
        outcome: 'failure',
        error: 'waitFor: text "Order confirmed" did not appear within 5000ms.',
      }),
    ])
    expectNotCitable(judge(waited, 'Place the order', [{ source: 'action', quote: 'Order confirmed' }]))
  })

  it("a failed navigate's URL in its error is not citable", () => {
    const navigated = record([
      action(1, {
        action: { type: 'navigate', to: 'url', url: 'https://x/orders/confirmed' } as Action,
        outcome: 'failure',
        error: 'page.goto: net::ERR_CONNECTION_REFUSED at https://x/orders/confirmed',
      }),
    ])
    expectNotCitable(judge(navigated, 'Open the orders page', [{ source: 'action', quote: 'https://x/orders/confirmed' }]))
  })

  it("a target-mismatch refusal's stated target is not citable", () => {
    const refused = record([
      action(1, {
        action: { type: 'click', ref: 'e3' } as Action,
        element: { role: 'button', name: 'Cancel' },
        outcome: 'refused',
        error: 'target-mismatch: click e3 is button "Cancel", but the stated target is button "Submit order" (name differs). No input was sent.',
      }),
    ])
    expectNotCitable(judge(refused, 'Submit order', [{ source: 'action', quote: 'Submit order' }]))
  })

  it('an assertAI rationale that restates the claim is not citable', () => {
    const restated = record(
      [
        action(1, {
          action: ASSERT_CLAIM,
          outcome: 'failure',
          error: 'Claim "The order was placed" judged false: No "Order placed" confirmation is visible — re-observe the screen or declare the step failed via stepFailed.',
        }),
      ],
      [{ ...FALSE_CLAIM_READ, text: '"The order was placed" (text): judged false: No "Order placed" confirmation is visible' }],
    )
    const step = 'Place the order'
    expectNotCitable(judge(restated, step, [{ source: 'read', quote: 'No "Order placed" confirmation is visible' }]))
    expectNotCitable(judge(restated, step, [{ source: 'read', quote: 'Order placed' }]))
  })

  it('the verifier prompt still shows the full record', () => {
    const full = record(
      [...URL_RECORD.actions, { ...CLAIM_RECORD.actions[0]!, index: 2 }, { ...FILL_RECORD.actions[0]!, index: 3 }],
      [FALSE_CLAIM_READ, FAILED_URL_READ],
    )
    const prompt = buildVerificationPrompt('Place the order', START, FINAL, FILL, false, undefined, undefined, undefined, undefined, full)
    expect(prompt).toContain('url equals "https://x/orders": failed (read "https://x/cart")')
    expect(prompt).toContain('"The order was placed" (text): judged false')
    expect(prompt).toContain(`planner's unverified claim: "The order was placed"`)
    expect(prompt).toContain('with text="Sam Taylor"')
  })

  it("the verifier prompt shows a failed action's error and a false assertAI's rationale, the citation sources neither", () => {
    const error = 'text "Order confirmed" did not appear'
    const rationale = 'the cart still lists two items'
    const failed = record(
      [
        action(1, {
          action: { type: 'waitFor', on: 'text', text: 'Order confirmed' } as unknown as Action,
          outcome: 'failure',
          error: `waitFor: ${error} within 5000ms.`,
        }),
        { ...CLAIM_RECORD.actions[0]!, index: 2 },
      ],
      [{ ...FALSE_CLAIM_READ, index: 2 }],
    )
    const last = failed.actions[failed.actions.length - 1]!.action
    const prompt = buildVerificationPrompt('Place the order', START, FINAL, last, false, undefined, undefined, undefined, undefined, failed)
    expect(prompt).toContain(error)
    expect(prompt).toContain(`judged false: ${rationale}`)
    const sources = Object.values(buildVerifierCitationSources(START, FINAL, last, undefined, failed)).join('\n')
    expect(sources).not.toContain(error)
    expect(sources).not.toContain(rationale)
  })
})
