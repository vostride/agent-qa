// The adapter changes page at the first dispatch, because the loop's settle needs two equal reads.
import { describe, expect, it } from 'vitest'
import { vi } from 'vitest'
import { exercisedAnchors, type ScreenState } from '@vostride/agent-qa-schema'
import type { Action, ActionResult, PlatformAdapter } from '../../platform.js'
import type { KnowledgeHintReader } from '../../knowledge-hint-reader.js'
import type { StepResult } from '../../result.js'
import { rowTextOf } from '../../grounding/row-text.js'
import { buildScreenState, type InterimNode } from '../../screen-builder.js'
import { executeStep } from '../index.js'
import { SecretRedactor, SecretStore } from '../secrets.js'
import type { ActionPlan, Planner, StepContext, Verifier } from '../types.js'
import { renderStepRecord, type VerifierStepRecord } from '../step-record.js'
import { makeStepContext } from './loop-harness.js'
import { scriptedVerification } from '../../testing/condition-verdicts.js'
import { servedBrief, servedCautions } from './fixtures/served-trace.js'

// Every node gets bounds so its ref is in the refMap and the committed-ref lane grounds it.
function screenOf(nodes: InterimNode[]): ScreenState {
  return buildScreenState({
    platform: 'android',
    nodes: nodes.map((node, i) => ({
      bounds: { x: 0, y: i * 60, width: 400, height: 50 },
      ...node,
    })),
    viewport: { width: 400, height: 800 },
    scroll: { offsetX: 0, offsetY: 0, contentWidth: 400, contentHeight: 800 },
    coordSpace: 'viewport',
    timestamp: 0,
  }).state
}

function refNamed(screen: ScreenState, name: string): string {
  const element = screen.elements.find((candidate) => candidate.name === name)
  if (element === undefined) throw new Error(`no element named ${name}`)
  return element.ref
}

type RecordingAdapter = PlatformAdapter & { executed: Action[] }

function adapter(
  prior: ScreenState,
  fresh: ScreenState,
  results: ActionResult[],
): RecordingAdapter {
  const executed: Action[] = []
  return {
    executed,
    platform: 'android',
    async setup() {},
    async cleanup() {},
    async observe() {
      return executed.length === 0 ? prior : fresh
    },
    async execute(action: Action) {
      const result = results[Math.min(executed.length, results.length - 1)]!
      executed.push(action)
      return result
    },
  }
}

function plan(action: ActionPlan['action']): ActionPlan {
  return { reasoning: 'scripted', action, confidence: 0.9, stepComplete: true, stepFailed: false }
}

const GIVE_UP: ActionPlan = {
  reasoning: 'giving up',
  action: { type: 'delay', ms: 0 },
  confidence: 0.9,
  stepComplete: false,
  stepFailed: true,
}

function scriptedPlanner(
  turns: Array<ActionPlan | ((context: StepContext) => ActionPlan)>,
): Planner & { calls: number } {
  const planner = {
    calls: 0,
    async plan(_step: string, _screen: ScreenState, context: StepContext) {
      const turn = turns[Math.min(planner.calls, turns.length - 1)]
      planner.calls++
      return { plan: typeof turn === 'function' ? turn(context) : turn }
    },
  }
  return planner
}

const limits = (maxActions: number, maxPlanningTurns: number) => ({
  maxActions,
  maxPlanningTurns,
  previousStepCount: 0,
})

function metadataOf(
  result: StepResult,
  key: string,
  index = 0,
): Record<string, unknown> | undefined {
  return result.evidence?.subActions[index]?.result.metadata?.[key] as
    | Record<string, unknown>
    | undefined
}

const CARD = { role: 'button', name: 'Card' }
const DROP_A = { role: 'button', name: 'Drop A' }

const BINDING_LOST_TO_REF: ActionResult = {
  success: false,
  error: 'binding-lost: ref e2 — the observed element is no longer on the page; nothing was sent',
  metadata: { binding: { outcome: 'binding-lost', ref: 'e2', inputSent: false } },
}
const UNKNOWN_TO_REF: ActionResult = {
  success: false,
  error: 'Unknown ref "e2". Available refs: e1',
}

const PRIOR = screenOf([
  { role: 'button', name: 'Card' },
  { role: 'button', name: 'Drop A' },
])

// One element is inserted ahead of both lanes, and a second ahead of the drop target, so the
// fresh 'e2' is "Card" and "Drop A" sits at 'e4'.
const FRESH = screenOf([
  { role: 'button', name: 'Banner' },
  { role: 'button', name: 'Card' },
  { role: 'button', name: 'Promo' },
  { role: 'button', name: 'Drop A' },
])

function dragCardOntoDropA(toTarget: Record<string, string> = DROP_A): ActionPlan['action'] {
  return { type: 'drag', fromRef: 'e1', fromTarget: CARD, toRef: 'e2', toTarget }
}

async function runDrag(
  prior: ScreenState,
  fresh: ScreenState,
  firstResult: ActionResult,
  action: ActionPlan['action'] = dragCardOntoDropA(),
) {
  const a = adapter(prior, fresh, [firstResult, { success: true }])
  const planner = scriptedPlanner([plan(action), GIVE_UP])
  const result = await executeStep(
    'Drag Card onto Drop A',
    { adapter: a, planner, plannerConfig: limits(10, 10) },
    makeStepContext(),
  )
  return { a, planner, result }
}

describe('a heal re-finds each lane and refuses an unproven match', () => {
  it('a drag whose toRef binding is lost re-finds both lanes and drops on the re-found target', async () => {
    const { a, planner, result } = await runDrag(PRIOR, FRESH, BINDING_LOST_TO_REF)

    expect(a.executed).toHaveLength(2)
    expect(a.executed[1]).toEqual({
      type: 'drag',
      fromRef: refNamed(FRESH, 'Card'),
      toRef: refNamed(FRESH, 'Drop A'),
    })
    expect((a.executed[1] as { toRef?: unknown }).toRef).not.toBe('e2')
    expect(result.status).toBe('passed')
    expect(planner.calls).toBe(1)
  })

  it('a drag whose toRef is an unknown ref re-finds both lanes the same way', async () => {
    const { a, planner, result } = await runDrag(PRIOR, FRESH, UNKNOWN_TO_REF)

    expect(a.executed).toHaveLength(2)
    expect(a.executed[1]).toEqual({
      type: 'drag',
      fromRef: refNamed(FRESH, 'Card'),
      toRef: refNamed(FRESH, 'Drop A'),
    })
    expect((a.executed[1] as { toRef?: unknown }).toRef).not.toBe('e2')
    expect(result.status).toBe('passed')
    expect(planner.calls).toBe(1)
  })

  it('a stated toTarget that contradicts the re-found drop target is refused on the heal path', async () => {
    const fresh = screenOf([
      { role: 'button', name: 'Banner' },
      { role: 'button', name: 'Card' },
      { role: 'listitem', text: 'Lane 2' },
      { role: 'button', name: 'Drop A', parentIndex: 2 },
    ])
    const { a, result } = await runDrag(
      PRIOR,
      fresh,
      BINDING_LOST_TO_REF,
      dragCardOntoDropA({ role: 'button', name: 'Drop A', row: 'Lane 1' }),
    )

    expect(a.executed).toHaveLength(1)
    expect(metadataOf(result, 'targetRefusal')).toMatchObject({
      kind: 'target-mismatch',
      lane: 'toRef',
      path: 'heal',
      reasons: ['row'],
      rowStated: true,
      inputSent: false,
    })
    expect(result.evidence?.limitUsage).toMatchObject({ actionsUsed: 1 })
  })

  it('a drop target that is not provably the same refuses the heal and nothing is re-dispatched', async () => {
    const fresh = screenOf([
      { role: 'button', name: 'Banner' },
      { role: 'button', name: 'Card' },
      { role: 'button', name: 'Drop A' },
      { role: 'button', name: 'Drop A' },
    ])
    const { a, result } = await runDrag(PRIOR, fresh, BINDING_LOST_TO_REF)

    expect(a.executed).toHaveLength(1)
    expect(metadataOf(result, 'binding')).toMatchObject({ heal: 'not-unique' })
  })

  it('two lanes that re-find one element refuse the heal', async () => {
    const tile = { role: 'button', name: 'Tile' }
    const prior = screenOf([
      { role: 'button', name: 'Tile' },
      { role: 'button', name: 'Tile' },
    ])
    const fresh = screenOf([
      { role: 'button', name: 'Banner' },
      { role: 'button', name: 'Tile' },
    ])
    const { a, result } = await runDrag(prior, fresh, BINDING_LOST_TO_REF, {
      type: 'drag',
      fromRef: 'e1',
      fromTarget: tile,
      toRef: 'e2',
      toTarget: tile,
    })

    expect(a.executed).toHaveLength(1)
    expect(metadataOf(result, 'binding')).toMatchObject({ heal: 'not-unique' })
  })

  it("a nested treeitem whose binding is lost heals onto the same parent's item", async () => {
    const tree: InterimNode[] = [
      { role: 'treeitem', name: '2024' },
      { role: 'treeitem', name: 'Invoices', parentIndex: 0 },
      { role: 'treeitem', name: '2025' },
      { role: 'treeitem', name: 'Invoices', parentIndex: 2 },
    ]
    const prior = screenOf(tree)
    // A banner is inserted first, so 2025's Invoices moves from e4 to e5.
    const fresh = screenOf([
      { role: 'button', name: 'Banner' },
      ...tree.map((node) =>
        node.parentIndex === undefined ? node : { ...node, parentIndex: node.parentIndex + 1 },
      ),
    ])
    const bindingLost: ActionResult = {
      success: false,
      error: 'binding-lost: ref e4 — the observed element is no longer on the page; nothing was sent',
      metadata: { binding: { outcome: 'binding-lost', ref: 'e4', inputSent: false } },
    }
    const a = adapter(prior, fresh, [bindingLost, { success: true }])
    const result = await executeStep(
      'Open the 2025 invoices',
      {
        adapter: a,
        planner: scriptedPlanner([
          plan({ type: 'click', ref: 'e4', target: { role: 'treeitem', name: 'Invoices' } }),
          GIVE_UP,
        ]),
        plannerConfig: limits(10, 10),
      },
      makeStepContext(),
    )

    expect(a.executed).toHaveLength(2)
    expect(a.executed[1]).toEqual({ type: 'click', ref: 'e5' })
    expect(result.status).toBe('passed')
  })
})

const SECRET = 'zz-secret-label'
const MASKED = 'zz-masked-word'
const PAY = `Pay ${SECRET} ${MASKED}`

async function runClickHeal(rowText: string, ports: Record<string, unknown> = {}) {
  const prior = screenOf([
    { role: 'listitem', text: rowText },
    { role: 'button', name: PAY, parentIndex: 0 },
  ])
  const fresh = screenOf([
    { role: 'button', name: 'Banner' },
    { role: 'listitem', text: rowText },
    { role: 'button', name: PAY, parentIndex: 1 },
  ])
  const a = adapter(prior, fresh, [UNKNOWN_TO_REF, { success: true }])
  const result = await executeStep(
    'Pay',
    {
      adapter: a,
      planner: scriptedPlanner([plan({ type: 'click', ref: 'e2' }), GIVE_UP]),
      plannerConfig: limits(10, 10),
      ...ports,
    },
    makeStepContext(),
  )
  return { a, prior, result }
}

describe('the heal grounding block', () => {
  it('the heal grounding block is masked like the live block', async () => {
    const { a, result } = await runClickHeal(`Order 12 ${MASKED}`, {
      secretRedactor: new SecretRedactor(new SecretStore({ PAY_LABEL: SECRET, ROW_WORD: MASKED })),
    })

    expect(a.executed).toHaveLength(2)
    expect(a.executed[1]).toEqual({ type: 'click', ref: 'e3' })
    const grounding = result.evidence?.subActions[0]?.grounding
    expect(grounding?.attempts).toContainEqual({
      stage: 'tree-search',
      outcome: 'resolved',
      resolvedRef: 'e3',
    })
    expect(grounding?.descriptor.name).toBe('Pay [secret:PAY_LABEL] [secret:ROW_WORD]')
    expect(grounding?.descriptor.row).toContain('[secret:ROW_WORD]')
    const recorded = JSON.stringify(grounding)
    expect(recorded).not.toContain(SECRET)
    expect(recorded).not.toContain(MASKED)
  })

  it('the heal grounding block caps the prior row text at 200 characters', async () => {
    const longRow = `Order ${'abcdefghi '.repeat(30)}`.trim()
    const { a, prior, result } = await runClickHeal(longRow)

    expect(a.executed).toHaveLength(2)
    const priorRow = rowTextOf(prior.elements[1]!, prior.elements)!
    expect(priorRow.length).toBeGreaterThan(300)
    const row = result.evidence?.subActions[0]?.grounding?.descriptor.row
    expect(row).toBeDefined()
    expect(row!.length).toBeLessThanOrEqual(200)
    expect(row).toBe(priorRow.slice(0, 200))
  })
})

const SAVE_PRIOR = screenOf([
  { role: 'button', name: 'Delete' },
  { role: 'button', name: 'Save' },
  { role: 'button', name: 'Cancel' },
])
// One element is inserted ahead, so the fresh "Save" sits at the prior "Cancel"'s ref.
const SAVE_FRESH = screenOf([
  { role: 'button', name: 'Banner' },
  { role: 'button', name: 'Delete' },
  { role: 'button', name: 'Save' },
  { role: 'button', name: 'Cancel' },
])
const clickSave: ActionPlan['action'] = {
  type: 'click',
  ref: 'e2',
  target: { role: 'button', name: 'Save' },
}

function nameAt(state: ScreenState | undefined, ref: unknown): string | undefined {
  return state?.elements.find((element) => element.ref === ref)?.name
}

async function runSave(
  fresh: ScreenState,
  results: ActionResult[],
  ports: Record<string, unknown> = {},
  withScreenshot = false,
) {
  const a = adapter(SAVE_PRIOR, fresh, results)
  if (withScreenshot) a.screenshot = async () => Buffer.from('png')
  const result = await executeStep(
    'Click Save',
    {
      adapter: a,
      planner: scriptedPlanner([plan(clickSave), GIVE_UP]),
      plannerConfig: limits(10, 10),
      ...ports,
    },
    makeStepContext(),
  )
  return { a, result }
}

// A healed dispatch is recorded against the heal's fresh observation, not the planner's.
describe('which observation a healed action is recorded against', () => {
  it('a healed click is recorded against the fresh observation it was sent to', async () => {
    const { a, result } = await runSave(SAVE_FRESH, [BINDING_LOST_TO_REF, { success: true }])

    expect(a.executed).toEqual([
      { type: 'click', ref: 'e2' },
      { type: 'click', ref: 'e3' },
    ])
    expect(result.status).toBe('passed')
    const dispatched = result.evidence?.subActions.at(-1)?.healedDispatch
    expect(dispatched?.action).toEqual({ type: 'click', ref: 'e3' })
    expect(nameAt(dispatched?.stateBefore, 'e3')).toBe('Save')
  })

  it('a healed drag is recorded against the fresh observation on both lanes', async () => {
    const { result } = await runDrag(PRIOR, FRESH, BINDING_LOST_TO_REF)

    expect(result.status).toBe('passed')
    const dispatched = result.evidence?.subActions.at(-1)?.healedDispatch
    const action = (dispatched?.action ?? {}) as unknown as Record<string, unknown>
    expect(nameAt(dispatched?.stateBefore, action['fromRef'])).toBe('Card')
    expect(nameAt(dispatched?.stateBefore, action['toRef'])).toBe('Drop A')
  })

  it('a healed sub-action is recorded against the fresh observation with the planner call\'s capture stamp', async () => {
    const { result } = await runSave(
      SAVE_FRESH,
      [BINDING_LOST_TO_REF, { success: true }],
      {},
      true,
    )

    const dispatched = result.evidence?.subActions.at(-1)?.healedDispatch
    expect(nameAt(dispatched?.stateBefore, 'e3')).toBe('Save')
    expect(dispatched?.stateBefore.metadata).toMatchObject({
      captureMode: 'full',
      imageWidth: 400,
      imageHeight: 800,
    })
  })

  it('a heal that sends nothing is recorded against the pre-heal observation', async () => {
    const fresh = screenOf([
      { role: 'button', name: 'Banner' },
      { role: 'button', name: 'Save' },
      { role: 'button', name: 'Save' },
      { role: 'button', name: 'Cancel' },
    ])
    const { a, result } = await runSave(fresh, [BINDING_LOST_TO_REF, { success: true }])

    expect(a.executed).toHaveLength(1)
    expect(metadataOf(result, 'binding')).toMatchObject({ heal: 'not-unique' })
    const recorded = result.evidence?.subActions[0]
    expect(recorded?.plannedAction).toEqual({ type: 'click', ref: 'e2' })
    expect(nameAt(recorded?.stateBefore, 'e2')).toBe('Save')
    expect(recorded?.stateBefore).toEqual(expect.objectContaining({ elements: SAVE_PRIOR.elements }))
    expect(recorded).not.toHaveProperty('healedDispatch')
  })
  const NOT_INTERACTABLE: ActionResult = { success: false, error: 'element is not interactable' }

  it('a healed click whose re-dispatch fails is recorded against the fresh observation', async () => {
    const { a, result } = await runSave(SAVE_FRESH, [BINDING_LOST_TO_REF, NOT_INTERACTABLE])

    expect(a.executed).toEqual([
      { type: 'click', ref: 'e2' },
      { type: 'click', ref: 'e3' },
    ])
    const dispatched = result.evidence?.subActions[0]?.healedDispatch
    expect(dispatched?.action).toEqual({ type: 'click', ref: 'e3' })
    expect(nameAt(dispatched?.stateBefore, 'e3')).toBe('Save')
  })

  it('a healed click whose re-dispatch fails anchors its caution to the element acted on', async () => {
    const getCautions = vi.fn((_anchors: unknown, _budget?: unknown) =>
      servedCautions({ cautions: [], budgetUsed: 0, admissions: [] }),
    )
    const knowledgeReader: KnowledgeHintReader = {
      getRunBrief: () =>
        servedBrief({ tiers: { L0: '', L1: '', L2: '' }, lines: [], truncation: '', admissions: [] }),
      search: () => [],
      read: () => {
        throw new Error('not used')
      },
      getCautions,
      getProcedure: () => undefined,
      emitCanaryOutcome: () => {},
    }
    await runSave(SAVE_FRESH, [BINDING_LOST_TO_REF, NOT_INTERACTABLE], {
      knowledgeReader,
      knowledgeBudgets: { brief: 64, searchResults: 64, caution: 24, readBody: 64, recordCap: 8 },
    })

    expect(getCautions).toHaveBeenCalled()
    const anchors = getCautions.mock.calls[0]![0] as Array<Record<string, unknown>>
    expect(anchors).toContainEqual(
      expect.objectContaining({ t: 'el', role: 'button', name: 'save' }),
    )
    expect(anchors.filter((anchor) => anchor['t'] === 'el' && anchor['name'] === 'cancel'))
      .toEqual([])
  })

  it('the verifier of a healed click reads the action against the fresh observation', async () => {
    const calls: Array<{ action: Action; record: VerifierStepRecord }> = []
    const verifier = {
      async verify(...args: Parameters<Verifier['verify']>) {
        const [step, , after, action] = args
        calls.push({ action, record: args[10]! })
        return { verification: scriptedVerification({ step, after, action, pass: true, reasoning: 'accepted' }) }
      },
    }
    const { result } = await runSave(SAVE_FRESH, [BINDING_LOST_TO_REF, { success: true }], {
      verifier,
    })

    expect(result.status).toBe('passed')
    expect(calls).toHaveLength(1)
    const ref = (calls[0]!.action as { ref?: unknown }).ref
    expect(ref).toBe('e3')
    // The record names the element each action acted on, from that action's observation.
    expect(calls[0]!.record.actions.at(-1)?.element).toEqual({ role: 'button', name: 'Save' })
    expect(renderStepRecord(calls[0]!.record).actions).toContain('click on ref="e3" (button "Save")')
  })
})

// `plannedAction` and `stateBefore` stay what the planner chose and saw.
describe('a heal records the dispatch pair beside the planner pair', () => {
  it('a healed click keeps the planner pair and records the dispatch pair beside it', async () => {
    const { a, result } = await runSave(SAVE_FRESH, [BINDING_LOST_TO_REF, { success: true }])

    expect(a.executed).toEqual([
      { type: 'click', ref: 'e2' },
      { type: 'click', ref: 'e3' },
    ])
    expect(result.status).toBe('passed')
    const recorded = result.evidence?.subActions.at(-1)
    expect(recorded?.plannedAction).toEqual({ type: 'click', ref: 'e2' })
    expect(recorded?.stateBefore.elements).toEqual(SAVE_PRIOR.elements)
    expect(recorded?.healedDispatch).toEqual({
      action: { type: 'click', ref: 'e3' },
      stateBefore: expect.objectContaining({ elements: SAVE_FRESH.elements }),
    })
    expect(nameAt(recorded?.healedDispatch?.stateBefore, 'e3')).toBe('Save')
    // The heal's grounding refs index the dispatch tree, so a planner-pair reader must not use them.
    expect(exercisedAnchors(result.evidence!)).toEqual([
      { t: 'el', role: 'button', name: 'save', ordinal: 0 },
    ])
  })
})
