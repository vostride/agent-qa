// Cache hits and procedure replays skip planning but are still judged on a fresh observation.

import { describe, expect, it } from 'vitest'
import {
  PROCEDURE_BODY_SCHEMA_VERSION,
  asRecordId,
  asRef,
  serializeProcedureBody,
} from '@vostride/agent-qa-schema'
import type {
  Anchor,
  CacheKey,
  ElementInfo,
  ProcedureBodyPayload,
  ProcedureMatch,
  ScreenState,
} from '@vostride/agent-qa-schema'
import type { Action, ActionResult, PlatformAdapter } from '../../platform.js'
import type { ActionPlanCache, CachedPlanValue } from '../../cache/port.js'
import type { KnowledgeHintReader } from '../../knowledge-hint-reader.js'
import { executeStep } from '../index.js'
import type { LoopPorts, ProcedureFlowCarry } from '../ports.js'
import type { ActionPlan, Planner, PlanResult, VerificationResult, Verifier } from '../types.js'
import { makeScreenState } from '../../testing/screen-fixtures.js'
import { scriptedVerification } from '../../testing/condition-verdicts.js'
import { makeActionPlan, makeStepContext } from './loop-harness.js'
import { noCautions, servedBrief } from './fixtures/served-trace.js'

const STEP = 'Click Continue'

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
  for (const element of elements) refMap[element.ref] = { bounds: element.bounds!, center: element.center! }
  return makeScreenState({
    url,
    tree: elements.map((element) => `- ${element.role} "${element.name}" [ref=${element.ref}]`).join('\n'),
    elements,
    refMap,
  })
}

const CHECKOUT = screen('https://shop.test/checkout', [el('e1', 'heading', 'Checkout', 80), el('e2', 'button', 'Continue', 200)])

function fixedAdapter(state: ScreenState): PlatformAdapter & { executed: Action[] } {
  const executed: Action[] = []
  return {
    platform: 'web',
    executed,
    async setup() {},
    async cleanup() {},
    async observe() {
      return state
    },
    async execute(action: Action): Promise<ActionResult> {
      executed.push(action)
      return { success: true }
    },
  }
}

interface CountingPlanner extends Planner {
  calls: number
}

function planner(plans: ActionPlan[]): CountingPlanner {
  const counting: CountingPlanner = {
    calls: 0,
    async plan(): Promise<PlanResult> {
      const plan = plans[Math.min(counting.calls, plans.length - 1)]
      counting.calls++
      return { plan }
    },
  }
  return counting
}

type Judgment = 'met-cited' | 'met-uncited' | 'not-met'

interface CountingVerifier extends Verifier {
  calls: number
}

/** Each call takes the next judgment; past the end the last one repeats. */
function verifier(judgments: Judgment[], events?: string[]): CountingVerifier {
  const counting: CountingVerifier = {
    calls: 0,
    async verify(step, _before, after, action): Promise<{ verification: VerificationResult }> {
      const judgment = judgments[Math.min(counting.calls, judgments.length - 1)]
      counting.calls++
      events?.push('verify')
      if (judgment === 'met-cited') {
        return { verification: scriptedVerification({ step, after, action, pass: true, reasoning: 'Continued' }) }
      }
      if (judgment === 'not-met') {
        return { verification: scriptedVerification({ step, pass: false, reasoning: 'Nothing moved on' }) }
      }
      return {
        verification: {
          conditions: [{
            quote: step,
            verdict: 'met',
            needs: 'none',
            controlRef: '',
            file: { name: '', match: 'none', text: '' },
            citations: [{ source: 'final-screen', quote: 'Order confirmed' }],
            reasoning: 'The order is confirmed',
          }],
          dialogs: [],
          isAppError: false,
          reasoning: 'The order is confirmed',
        },
      }
    },
  }
  return counting
}

interface RecordingCache extends ActionPlanCache {
  store: Map<string, CachedPlanValue>
  gets: { key: string; hit: boolean }[]
  sets: string[]
  invalidated: string[]
}

function recordingCache(events?: string[]): RecordingCache {
  const store = new Map<string, CachedPlanValue>()
  const gets: { key: string; hit: boolean }[] = []
  const sets: string[] = []
  const invalidated: string[] = []
  return {
    store,
    gets,
    sets,
    invalidated,
    async get(key: CacheKey) {
      const value = store.get(key) ?? null
      gets.push({ key, hit: value !== null })
      return value
    },
    async set(key: CacheKey, value: CachedPlanValue) {
      sets.push(key)
      events?.push('set')
      store.set(key, value)
    },
    async invalidate(key: CacheKey) {
      invalidated.push(key)
      store.delete(key)
    },
  }
}

const CLICK_CONTINUE = makeActionPlan({ reasoning: 'Continue', action: { type: 'click', ref: 'e2' }, stepComplete: true })
const GIVE_UP = makeActionPlan({
  reasoning: 'Continuing did not take me anywhere',
  action: { type: 'delay', ms: 0 },
  stepComplete: false,
  stepFailed: true,
})

/** A live run whose accepted completion writes the step key; the counters are then reset. */
async function seededCache(): Promise<RecordingCache> {
  const cache = recordingCache()
  const seed = await executeStep(
    STEP,
    { adapter: fixedAdapter(CHECKOUT), planner: planner([CLICK_CONTINUE]), verifier: verifier(['met-cited']), cache },
    makeStepContext({ stepInstruction: STEP }),
  )
  expect(seed.status).toBe('passed')
  expect(cache.sets).toHaveLength(1)
  expect(cache.store.get(cache.sets[0])?.completesStep).toBe(true)
  cache.gets.length = 0
  cache.sets.length = 0
  return cache
}

// The procedure replay fixture: a form whose Submit click navigates to a form-less page.
const FORM = 'http://127.0.0.1:8931/form.html'
const RECEIVED = 'http://127.0.0.1:8931/received.html'
const flowAnchor: Anchor = { t: 'flow', name: 'local-form' }
const PROCEDURE_ID = asRecordId('procedure-flow-439-replay')
const formScreen = screen(FORM, [el('e1', 'textbox', 'Username', 120), el('e2', 'button', 'Submit', 200)])
const receivedScreen = screen(RECEIVED, [el('e1', 'heading', 'Received!', 80)])

function navigatingAdapter(): PlatformAdapter & { executed: Action[] } {
  const executed: Action[] = []
  let navigated = false
  return {
    platform: 'web',
    executed,
    async setup() {},
    async cleanup() {},
    async observe() {
      return navigated ? receivedScreen : formScreen
    },
    async execute(action: Action): Promise<ActionResult> {
      executed.push(action)
      if (action.type === 'click') navigated = true
      return { success: true }
    },
  }
}

const payload: ProcedureBodyPayload = {
  schemaVersion: PROCEDURE_BODY_SCHEMA_VERSION,
  parameters: [{ name: 'PROBE_USER', type: 'string', required: true }],
  steps: [
    {
      instruction: 'Type the probe email into the Username field',
      action: {
        type: 'fill',
        targets: { ref: { role: 'textbox', nameNormalized: 'username', name: 'Username' } },
        values: { text: { param: 'PROBE_USER' } },
      },
      guard: {
        target: { role: 'textbox', nameNormalized: 'username', name: 'Username' },
        pageAnchor: { t: 'page', route: FORM },
      },
    },
    {
      instruction: 'Click the Submit button',
      action: {
        type: 'click',
        targets: { ref: { role: 'button', nameNormalized: 'submit', name: 'Submit' } },
        values: {},
      },
      guard: {
        target: { role: 'button', nameNormalized: 'submit', name: 'Submit' },
        pageAnchor: { t: 'page', route: FORM },
      },
    },
  ],
  successAssertion: 'The form was submitted',
}

const match: ProcedureMatch = {
  id: PROCEDURE_ID,
  flowAnchor,
  confidence: 0.9,
  authoringModelTier: 'full',
  parameterSchema: [{ name: 'PROBE_USER', type: 'string', required: true }],
  replayRecommendation: 'replay',
}

const reader: KnowledgeHintReader = {
  getRunBrief() {
    return servedBrief({ tiers: { L0: '', L1: '', L2: '' }, lines: [], truncation: '', admissions: [] })
  },
  search() {
    return []
  },
  read(id) {
    return {
      id,
      title: 'Local form procedure',
      body: serializeProcedureBody(payload),
      anchors: [flowAnchor],
      evidenceDigest: 'digest',
      relations: [],
    }
  },
  getCautions() {
    return noCautions()
  },
  getProcedure(_intent, state) {
    return state.url === FORM ? match : undefined
  },
  emitCanaryOutcome() {},
}

const STEP_0 = 'Type "qa.user+439@example.com" into the Username field'
const STEP_1 = 'Click the Submit button'
const context = () => makeStepContext({ testName: 'local-form', variables: { PROBE_USER: 'qa.user+439@example.com' } })

function ports(
  adapter: PlatformAdapter,
  live: Planner,
  judge: Verifier,
  flow: { carry?: ProcedureFlowCarry },
): LoopPorts {
  return { adapter, planner: live, verifier: judge, knowledgeReader: reader, procedureFlow: flow }
}

describe('cache and procedure replays are re-verified', () => {
  it('a cache hit replays without planning and is re-verified', async () => {
    const cache = await seededCache()
    const live = planner([GIVE_UP])
    const judge = verifier(['met-cited'])
    const adapter = fixedAdapter(CHECKOUT)

    const result = await executeStep(STEP, { adapter, planner: live, verifier: judge, cache }, makeStepContext({ stepInstruction: STEP }))

    expect(result.status).toBe('passed')
    expect(live.calls).toBe(0)
    expect(judge.calls).toBe(1)
    expect(cache.gets).toEqual([{ key: cache.gets[0].key, hit: true }])
    expect(adapter.executed).toEqual([{ type: 'click', ref: 'e2' }])
    expect(result.evidence!.cacheStatus).toBe('hit')
    expect(result.evidence!.conditionVerdicts!.conditions[0].verdict).toBe('met')
  })

  it('a hit whose verdict is unproven is not a pass, and its saved turn is invalidated and not re-cached', async () => {
    const cache = await seededCache()
    const live = planner([GIVE_UP])
    const judge = verifier(['met-uncited', 'not-met'])

    const result = await executeStep(STEP, { adapter: fixedAdapter(CHECKOUT), planner: live, verifier: judge, cache }, makeStepContext({ stepInstruction: STEP }))

    expect(cache.gets[0].hit).toBe(true)
    expect(result.status).toBe('failed')
    expect(result.evidence!.subActions[0].plan).toBe('Replayed from cache')
    expect(live.calls).toBe(1)
    expect(cache.invalidated).toEqual([cache.gets[0].key])
    expect(cache.sets).toEqual([])
  })

  it('the cached outcome never decides the verdict, and a rejected replay is invalidated', async () => {
    const cache = await seededCache()
    const live = planner([GIVE_UP])
    const judge = verifier(['not-met'])

    const result = await executeStep(STEP, { adapter: fixedAdapter(CHECKOUT), planner: live, verifier: judge, cache }, makeStepContext({ stepInstruction: STEP }))

    expect(cache.gets[0].hit).toBe(true)
    expect(result.status).not.toBe('passed')
    expect(result.evidence!.verifierVerdict.pass).toBe(false)
    expect(cache.invalidated).toEqual([cache.gets[0].key])
    expect(cache.sets).toEqual([])
  })

  it('every saved turn is written only after a computed pass', async () => {
    const events: string[] = []
    const cache = recordingCache(events)
    const live = planner([CLICK_CONTINUE])
    const judge = verifier(['met-uncited', 'met-cited'], events)

    const result = await executeStep(STEP, { adapter: fixedAdapter(CHECKOUT), planner: live, verifier: judge, cache }, makeStepContext({ stepInstruction: STEP }))

    expect(result.status).toBe('passed')
    expect(judge.calls).toBe(2)
    expect(events).toEqual(['verify', 'verify', 'set', 'set'])
    expect(cache.sets).toEqual(cache.gets.map((get) => get.key))
    expect(cache.sets.map((key) => cache.store.get(key)?.completesStep)).toEqual([false, true])
  })

  it('procedure replay re-verifies each replayed step', async () => {
    const flow: { carry?: ProcedureFlowCarry } = {}
    const adapter = navigatingAdapter()
    const live = planner([makeActionPlan()])
    const judge = verifier(['met-cited'])

    const step0 = await executeStep(STEP_0, ports(adapter, live, judge, flow), context())
    expect(step0.status).toBe('passed')
    expect(judge.calls).toBe(1)
    expect(flow.carry?.nextIndex).toBe(1)

    const step1 = await executeStep(STEP_1, ports(adapter, live, judge, flow), context())
    expect(step1.status).toBe('passed')
    expect(judge.calls).toBe(2)
    expect(live.calls).toBe(0)
    expect(adapter.executed.map((action) => action.type)).toEqual(['fill', 'click'])
    expect(step1.evidence?.planSource).toMatchObject({ kind: 'procedure-replay', flow: { cursor: 1, length: 2 } })

    const flowRejected: { carry?: ProcedureFlowCarry } = {}
    const rejectedAdapter = navigatingAdapter()
    const recovering = planner([makeActionPlan({ action: { type: 'fill', ref: 'e1', text: 'qa.user+439@example.com' } })])
    const unproven = verifier(['met-uncited', 'met-cited'])

    const rejected = await executeStep(STEP_0, ports(rejectedAdapter, recovering, unproven, flowRejected), context())

    expect(rejected.evidence?.planSource).toEqual({
      kind: 'procedure-replay',
      procedureId: PROCEDURE_ID,
      guard: { checksPassed: 1, total: 1, verifierRejection: { procedureStepIndex: 0 } },
      flow: { cursor: 0, length: 2 },
    })
    expect(recovering.calls).toBe(1)
    expect(unproven.calls).toBe(2)
    expect(flowRejected.carry).toBeUndefined()
  })
})
