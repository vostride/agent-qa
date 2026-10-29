// a completed download and the latest app clipboard write carry to later
// steps of the same test through the member-scoped cell, labelled with the step and action that
// produced them, and are citable as source 'carried'. Screens, reads, unfinished downloads and
// anything without a cell never carry. The verifier is the real LLMVerifier over a mocked model, so
// each cell reads the exact turn the model would see.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { asRef } from '@vostride/agent-qa-schema'
import type { DownloadEvidence, ElementInfo, ScreenState } from '@vostride/agent-qa-schema'
import type { Action, ActionResult, PlatformAdapter } from '../../platform.js'
import { makeScreenState } from '../../testing/screen-fixtures.js'
import { executeStep } from '../index.js'
import { LLMVerifier } from '../verifier.js'
import type { CarriedArtifacts, LoopPorts } from '../ports.js'
import type { ActionPlan, Planner } from '../types.js'
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

function screen(heading: string): ScreenState {
  const elements = [el('e1', 'heading', heading, 80), el('e2', 'button', 'Continue', 200)]
  const refMap: ScreenState['refMap'] = {}
  for (const element of elements) refMap[element.ref] = { bounds: element.bounds!, center: element.center! }
  return makeScreenState({
    url: 'https://shop.test/orders',
    tree: elements.map((element) => `- ${element.role} "${element.name}" [ref=${element.ref}]`).join('\n'),
    elements,
    refMap,
  })
}

function adapter(state: ScreenState, results: ActionResult[]): PlatformAdapter {
  let executed = 0
  return {
    platform: 'web',
    async setup() {},
    async cleanup() {},
    async observe() {
      return state
    },
    async execute(_action: Action): Promise<ActionResult> {
      const result = results[Math.min(executed, results.length - 1)]!
      executed++
      return result
    },
  }
}

function planner(plans: ActionPlan[]): Planner {
  let call = 0
  return {
    async plan() {
      const plan = plans[Math.min(call, plans.length - 1)]!
      call++
      return { plan }
    },
  }
}

function download(name: string, state: DownloadEvidence['state'] = 'completed'): DownloadEvidence {
  return {
    suggestedFilename: name,
    extension: '.csv',
    ...(state === 'completed' ? { size: 42, sha256: 'd'.repeat(64) } : {}),
    state,
  }
}

function clipboard(text: string) {
  return { source: 'writeText', text, readBack: 'matched' }
}

/** Each verifier turn answers one met condition quoting the whole step with this citation. */
async function verifierModel(citations: { source: string; quote: string }[]): Promise<string[]> {
  const { generateText } = await import('ai')
  const turns: string[] = []
  vi.mocked(generateText).mockImplementation(async (args: { messages?: unknown }) => {
    const messages = (args.messages ?? []) as Array<{ content: Array<{ type: string; text?: string }> }>
    const turn = messages.flatMap((message) => message.content).map((part) => part.text ?? '').join('\n')
    const goal = /Step goal: "([^"]*)"/.exec(turn)?.[1] ?? ''
    const citation = citations[Math.min(turns.length, citations.length - 1)]!
    turns.push(turn)
    return {
      output: {
        conditions: [{ quote: goal, verdict: 'met', needs: 'none', controlRef: '', file: NO_FILE, citations: [citation], reasoning: 'Shown' }],
        dialogs: [],
        isAppError: false,
        reasoning: 'Shown',
      },
      usage: USAGE,
    } as never
  })
  return turns
}

const CLICK = makeActionPlan({ reasoning: 'Continue', action: { type: 'click', ref: 'e2' }, stepComplete: true })
const ON_SCREEN = { source: 'final-screen', quote: 'button "Continue"' }

async function step(
  stepNumber: number,
  instruction: string,
  results: ActionResult[],
  carried?: CarriedArtifacts,
  plans: ActionPlan[] = [CLICK],
  heading = 'Orders',
) {
  const ports: LoopPorts = {
    adapter: adapter(screen(heading), results),
    planner: planner(plans),
    verifier: new LLMVerifier({} as never, makeFakeTokenAccounting()),
    ...(carried !== undefined ? { carriedArtifacts: carried } : {}),
  }
  return executeStep(instruction, ports, makeStepContext({ stepInstruction: instruction, stepNumber, stepCount: 3 }))
}

describe('what an earlier step carries to a later one', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("a later step cites the earlier step's download by its label", async () => {
    const turns = await verifierModel([ON_SCREEN, { source: 'carried', quote: 'invoice-1042.csv' }])
    const cell: CarriedArtifacts = { downloads: [] }

    const first = await step(1, 'Export the invoice', [{ success: true, metadata: { download: [download('invoice-1042.csv')] } }], cell)
    const second = await step(2, 'Check the invoice was exported', [{ success: true }], cell)

    expect(first.status).toBe('passed')
    expect(turns[0]).not.toContain('Carried from earlier steps in this test:')
    expect(turns[1]).toContain('Carried from earlier steps in this test:')
    expect(turns[1]).toContain('carried from step 1, action 1: Download "invoice-1042.csv" (.csv): completed')
    expect(second.status).toBe('passed')
    const recorded = second.evidence!.conditionVerdicts!.conditions[0]!
    expect(recorded.verdict).toBe('met')
    expect(recorded.citations[0]).toEqual({ source: 'carried', quote: 'invoice-1042.csv', found: true })
    expect(cell.downloads.map((entry) => [entry.stepNumber, entry.actionIndex])).toEqual([[1, 1]])
  })

  it('only the latest clipboard write carries', async () => {
    const turns = await verifierModel([ON_SCREEN])
    const cell: CarriedArtifacts = { downloads: [] }

    await step(1, 'Copy the coupon code', [{ success: true, metadata: { clipboard: [clipboard('ALPHA-1')] } }], cell)
    await step(2, 'Copy the order number', [{ success: true, metadata: { clipboard: [clipboard('BRAVO-2')] } }], cell)
    await step(3, 'Paste the order number', [{ success: true }], cell)

    expect(turns[1]).toContain('carried from step 1, action 1: Clipboard write (writeText): "ALPHA-1"')
    expect(turns[2]).toContain('carried from step 2, action 1: Clipboard write (writeText): "BRAVO-2"')
    expect(turns[2]).not.toContain('ALPHA-1')
    expect(cell.clipboard).toMatchObject({ stepNumber: 2, actionIndex: 1, evidence: { text: 'BRAVO-2' } })
  })

  it('screens, reads and unfinished downloads never carry', async () => {
    const turns = await verifierModel([ON_SCREEN])
    const cell: CarriedArtifacts = { downloads: [] }
    const readThenExport = [
      makeActionPlan({
        reasoning: 'Check the page',
        action: { type: 'assertValue', source: 'url', op: 'contains', expected: 'zz-read-marker' },
        stepComplete: false,
      }),
      CLICK,
    ]

    await step(
      1,
      'Export the report',
      [
        { success: true, data: 'https://shop.test/orders?zz-read-marker' },
        { success: true, metadata: { download: [download('partial.csv', 'unfinished'), download('broken.csv', 'failed')] } },
      ],
      cell,
      readThenExport,
      'zz-step-one-heading',
    )
    await step(2, 'Open the summary', [{ success: true }], cell)

    expect(turns[0]).toContain('zz-read-marker')
    expect(turns[0]).toContain('zz-step-one-heading')
    expect(turns[1]).not.toContain('zz-read-marker')
    expect(turns[1]).not.toContain('zz-step-one-heading')
    expect(turns[1]).not.toContain('partial.csv')
    expect(turns[1]).not.toContain('broken.csv')
    expect(turns[1]).not.toContain('carried from step')
    expect(cell).toEqual({ downloads: [] })
  })

  it('without a cell nothing carries', async () => {
    const turns = await verifierModel([ON_SCREEN])

    await step(1, 'Export the invoice', [{ success: true, metadata: { download: [download('invoice-1042.csv')] } }])
    await step(2, 'Check the invoice was exported', [{ success: true }])

    expect(turns[1]).not.toContain('Carried from earlier steps in this test:')
    expect(turns[1]).not.toContain('invoice-1042.csv')
  })
})
