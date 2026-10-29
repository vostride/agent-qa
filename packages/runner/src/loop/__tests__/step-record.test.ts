// C439-STEP-RECORD (439 D-03, D-10): the verifier judges from the whole step's record, every action
// with its outcome and evidence, every value read and the settled start and final screens, and
// never from the planner's reasoning or the test author's context.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { asRef } from '@vostride/agent-qa-schema'
import type { DownloadEvidence, ElementInfo, ScreenState } from '@vostride/agent-qa-schema'
import type { Action, ActionResult, PlatformAdapter } from '../../platform.js'
import { makeScreenState } from '../../testing/screen-fixtures.js'
import { scriptedVerification } from '../../testing/condition-verdicts.js'
import { executeStep } from '../index.js'
import { LLMVerifier } from '../verifier.js'
import {
  RECORD_LINE_CHAR_CAP,
  renderStepRecord,
  type RecordedAction,
  type VerifierStepRecord,
} from '../step-record.js'
import type { ActionPlan, Planner, Verifier } from '../types.js'
import { makeActionPlan, makeFakeTokenAccounting, makeStepContext } from './loop-harness.js'

vi.mock('ai', async (importActual) => {
  const actual = await importActual<typeof import('ai')>()
  return { ...actual, generateText: vi.fn() }
})

const USAGE = { inputTokens: 10, outputTokens: 2 }
const NO_FILE = { name: '', match: 'none', text: '' }

function el(ref: string, role: string, name: string, y: number): ElementInfo {
  const bounds = { x: 20, y, width: 350, height: 44 }
  return {
    ref: asRef(ref),
    role,
    name,
    nameNormalized: name.toLowerCase(),
    bounds,
    center: { x: 195, y: y + 22 },
    state: { enabled: true, focused: false, visible: true },
    labels: {},
    attributes: {},
  }
}

function screen(url: string, elements: ElementInfo[]): ScreenState {
  const refMap: ScreenState['refMap'] = {}
  for (const element of elements) {
    refMap[element.ref] = { bounds: element.bounds!, center: element.center! }
  }
  return makeScreenState({
    url,
    tree: elements.map((element) => `- ${element.role} "${element.name}" [ref=${element.ref}]`).join('\n'),
    elements,
    refMap,
  })
}

function sequenceAdapter(screens: ScreenState[], results: ActionResult[]): PlatformAdapter {
  let executed = 0
  return {
    platform: 'web',
    async setup() {},
    async cleanup() {},
    async observe() {
      return screens[Math.min(executed, screens.length - 1)]!
    },
    async execute(_action: Action): Promise<ActionResult> {
      const result = results[Math.min(executed, results.length - 1)]!
      executed++
      return result
    },
  }
}

function scriptedPlanner(plans: ActionPlan[]): Planner {
  let call = 0
  return {
    async plan() {
      const plan = plans[Math.min(call, plans.length - 1)]!
      call++
      return { plan }
    },
  }
}

function condition(quote: string, citation: { source: string; quote: string }) {
  return {
    quote,
    verdict: 'met',
    needs: 'none',
    controlRef: '',
    file: NO_FILE,
    citations: [citation],
    reasoning: 'Shown in the record',
  }
}

async function fakeVerifierModel(output: unknown): Promise<string[]> {
  const { generateText } = await import('ai')
  const turns: string[] = []
  vi.mocked(generateText).mockImplementation(async (args: { messages?: unknown }) => {
    const messages = (args.messages ?? []) as Array<{ content: Array<{ type: string; text?: string }> }>
    turns.push(messages.flatMap((message) => message.content).map((part) => part.text ?? '').join('\n'))
    return { output, usage: USAGE } as never
  })
  return turns
}

const STOP = makeActionPlan({ reasoning: 'Give up', action: { type: 'click', ref: 'e1' }, stepComplete: false, stepFailed: true })

const FORM = screen('https://shop.test/form', [
  el('e1', 'textbox', 'Message', 120),
  el('e2', 'button', 'Send', 200),
])
const SENT = screen('https://shop.test/form', [
  el('e1', 'textbox', 'Message', 120),
  el('e2', 'button', 'Send', 200),
  el('e3', 'heading', 'Message sent', 260),
])

function download(name: string): DownloadEvidence {
  return { suggestedFilename: name, extension: '.csv', size: 42, sha256: 'd'.repeat(64), state: 'completed' }
}

describe('the step record the verifier reads', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('the verifier sees every action and read of the step, and no planner reasoning', async () => {
    const step = 'Write a message and send it'
    const turns = await fakeVerifierModel({
      conditions: [condition(step, { source: 'final-screen', quote: 'heading "Message sent"' })],
      dialogs: [],
      isAppError: false,
      reasoning: 'The message was sent',
    })
    const plans = [
      makeActionPlan({
        reasoning: 'zz-reason-1 type the message',
        action: { type: 'fill', ref: 'e1', text: 'Hello there' },
        stepComplete: false,
      }),
      makeActionPlan({
        reasoning: 'zz-reason-2 confirm the page',
        action: { type: 'assertValue', source: 'url', op: 'equals', expected: 'https://shop.test/form' },
        stepComplete: false,
      }),
      makeActionPlan({
        reasoning: 'zz-reason-3 send it',
        action: { type: 'click', ref: 'e2' },
        stepComplete: true,
      }),
    ]
    const result = await executeStep(
      step,
      {
        adapter: sequenceAdapter(
          [FORM, FORM, FORM, SENT],
          [{ success: true }, { success: true, data: 'https://shop.test/form' }, { success: true }],
        ),
        planner: scriptedPlanner(plans),
        verifier: new LLMVerifier({} as never, makeFakeTokenAccounting()),
      },
      makeStepContext({ stepInstruction: step }),
    )

    expect(result.status).toBe('passed')
    expect(turns).toHaveLength(1)
    const turn = turns[0]!
    expect(turn).toContain('1. fill ref="e1" with text="Hello there" (textbox "Message") → success')
    expect(turn).toContain('2. assertValue url equals "https://shop.test/form" → success')
    expect(turn).toContain('3. click on ref="e2" (button "Send") → success')
    expect(turn).toContain('read 2: assertValue url equals "https://shop.test/form": passed (read "https://shop.test/form")')
    expect(turn).toContain('Screen at the start of the step:')
    expect(turn).toContain('Screen now (settled, after the last action):')
    expect(turn).not.toContain('Action taken:')
    for (const marker of ['zz-reason-1', 'zz-reason-2', 'zz-reason-3']) expect(turn).not.toContain(marker)
  })

  it("an earlier action's download is citable", async () => {
    const step = 'Export the invoice'
    await fakeVerifierModel({
      conditions: [condition(step, { source: 'action', quote: 'invoice-1042.csv' })],
      dialogs: [],
      isAppError: false,
      reasoning: 'The invoice was downloaded',
    })
    const plans = [
      makeActionPlan({ reasoning: 'Export', action: { type: 'click', ref: 'e2' }, stepComplete: false }),
      makeActionPlan({ reasoning: 'Close the menu', action: { type: 'click', ref: 'e1' }, stepComplete: true }),
    ]
    const result = await executeStep(
      step,
      {
        adapter: sequenceAdapter([FORM], [
          { success: true, metadata: { download: [download('invoice-1042.csv')] } },
          { success: true },
        ]),
        planner: scriptedPlanner(plans),
        verifier: new LLMVerifier({} as never, makeFakeTokenAccounting()),
      },
      makeStepContext({ stepInstruction: step }),
    )

    expect(result.status).toBe('passed')
    const recorded = result.evidence!.conditionVerdicts!.conditions[0]!
    expect(recorded.verdict).toBe('met')
    expect(recorded.citations[0]).toEqual({ source: 'action', quote: 'invoice-1042.csv', found: true })
  })

  it("the author's context is never evidence", async () => {
    const step = 'Place the order'
    const turns = await fakeVerifierModel({
      conditions: [condition(step, { source: 'final-screen', quote: 'Order 5521 is confirmed' })],
      dialogs: [],
      isAppError: false,
      reasoning: 'The order is confirmed',
    })
    const result = await executeStep(
      step,
      {
        adapter: sequenceAdapter([FORM], [{ success: true }]),
        planner: scriptedPlanner([
          makeActionPlan({ reasoning: 'Order', action: { type: 'click', ref: 'e2' }, stepComplete: true }),
          STOP,
        ]),
        verifier: new LLMVerifier({} as never, makeFakeTokenAccounting()),
      },
      makeStepContext({ stepInstruction: step, testContext: 'Order 5521 is confirmed' }),
    )

    expect(turns[0]).toContain('Order 5521 is confirmed')
    expect(result.status).not.toBe('passed')
    const recorded = result.evidence!.conditionVerdicts!.conditions[0]!
    expect(recorded.verdict).toBe('unverified')
    expect(recorded.guard).toBe('citation-missing')
    expect(recorded.citations[0]!.found).toBe(false)
  })

  it('a long step is bounded and keeps every evidence line', () => {
    const actions: RecordedAction[] = Array.from({ length: 60 }, (_, i) => ({
      index: i + 1,
      action: { type: 'click', ref: `e${i + 1}` } as Action,
      outcome: i === 0 ? 'failure' : 'success',
      ...(i === 0 ? { error: 'x'.repeat(500) } : {}),
      ...(i === 6 ? { operationEvidence: { downloads: [download('report-07.csv')] } } : {}),
      ...(i === 49 ? { operationEvidence: { downloads: [download('report-50.csv')] } } : {}),
    }))
    const record: VerifierStepRecord = { startScreen: FORM, actions, reads: [], carried: [] }
    const rendered = renderStepRecord(record)

    const lines = rendered.actions.split('\n')
    expect(lines.filter((line) => /^\d+\. /.test(line))).toHaveLength(40)
    expect(lines.filter((line) => line === '… 20 actions omitted …')).toHaveLength(1)
    expect(lines.slice(0, 5).map((line) => line.split('.')[0])).toEqual(['1', '2', '3', '4', '5'])
    expect(lines[6]!.startsWith('26. ')).toBe(true)
    expect(lines.at(-1)!.startsWith('60. ')).toBe(true)
    expect(rendered.operationEvidence).toContain('action 7: Download "report-07.csv"')
    expect(rendered.operationEvidence).toContain('action 50: Download "report-50.csv"')
    const all = [rendered.actions, rendered.operationEvidence].join('\n').split('\n')
    expect(all.every((line) => line.length <= RECORD_LINE_CHAR_CAP)).toBe(true)
  })

  it("the start screen is the step's first settled observation", async () => {
    const first = screen('https://shop.test/a', [el('e1', 'button', 'Next', 120)])
    const second = screen('https://shop.test/b', [el('e1', 'button', 'Finish', 120)])
    const befores: ScreenState[] = []
    const verifier: Verifier = {
      async verify(step, before, after, action) {
        befores.push(before)
        return { verification: scriptedVerification({ step, after, action, pass: true, reasoning: 'Done' }) }
      },
    }
    const result = await executeStep(
      'Go through the wizard',
      {
        adapter: sequenceAdapter([first, second], [{ success: true }, { success: true }]),
        planner: scriptedPlanner([
          makeActionPlan({ reasoning: 'Next', action: { type: 'click', ref: 'e1' }, stepComplete: false }),
          makeActionPlan({ reasoning: 'Finish', action: { type: 'click', ref: 'e1' }, stepComplete: true }),
        ]),
        verifier,
      },
      makeStepContext({ stepInstruction: 'Go through the wizard' }),
    )

    expect(result.status).toBe('passed')
    expect(befores).toHaveLength(1)
    expect(befores[0]!.url).toBe('https://shop.test/a')
  })
})
