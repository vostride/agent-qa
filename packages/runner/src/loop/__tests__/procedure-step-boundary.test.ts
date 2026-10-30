// The fixture navigates on submit; a non-navigating fixture would prove the wrong mechanism.
import { describe, expect, it } from 'vitest'
import {
  PROCEDURE_BODY_SCHEMA_VERSION,
  asRecordId,
  asRef,
  serializeProcedureBody,
} from '@vostride/agent-qa-schema'
import type {
  Anchor,
  BriefBlock,
  ProcedureBodyPayload,
  ProcedureMatch,
  ScreenState,
} from '@vostride/agent-qa-schema'
import type { KnowledgeHintReader } from '../../knowledge-hint-reader.js'
import type { Action, ActionResult, PlatformAdapter } from '../../platform.js'
import { executeStep } from '../index.js'
import type { LoopPorts, ProcedureFlowCarry } from '../ports.js'
import type { ActionPlan, Planner, StepContext, Verifier } from '../types.js'
import { makeActionPlan, makeStepContext, makeVerifier } from './loop-harness.js'
import { scriptedVerification } from '../../testing/condition-verdicts.js'
import { noCautions, servedBrief, servedCautions } from './fixtures/served-trace.js'

const FORM_ROUTE = 'http://127.0.0.1:8931/form.html'
const RECEIVED_ROUTE = 'http://127.0.0.1:8931/received.html'
const PROBE_EMAIL = 'qa.user+381@example.com'

const flowAnchor: Anchor = { t: 'flow', name: 'local-form' }
const PROCEDURE_ID = asRecordId('procedure-flow-local-form')

const emptyBrief: BriefBlock = {
  tiers: { L0: '', L1: '', L2: '' },
  lines: [],
  truncation: '',
  admissions: [],
}

/** The committed ladder-shaped form screen: a labelled Username textbox + a Submit button. */
function formScreen(): ScreenState {
  const usernameRef = asRef('e1')
  const submitRef = asRef('e2')
  const usernameBounds = { x: 20, y: 120, width: 350, height: 44 }
  const submitBounds = { x: 20, y: 200, width: 350, height: 44 }
  return {
    platform: 'web',
    tree: [
      '[Viewport: 390x844] [2 elements]',
      '- textbox "Username" [ref=e1] @(20,120 350x44)',
      '- button "Submit" [ref=e2] @(20,200 350x44)',
    ].join('\n'),
    elements: [
      {
        ref: usernameRef,
        role: 'textbox',
        name: 'Username',
        nameNormalized: 'username',
        bounds: usernameBounds,
        center: { x: 195, y: 142 },
        state: { enabled: true, focused: false, visible: true },
        labels: { placeholder: 'Username' },
        attributes: {},
      },
      {
        ref: submitRef,
        role: 'button',
        name: 'Submit',
        nameNormalized: 'submit',
        bounds: submitBounds,
        center: { x: 195, y: 222 },
        state: { enabled: true, focused: false, visible: true },
        labels: { ariaLabel: 'Submit' },
        attributes: {},
      },
    ],
    refMap: {
      [usernameRef]: { bounds: usernameBounds, center: { x: 195, y: 142 } },
      [submitRef]: { bounds: submitBounds, center: { x: 195, y: 222 } },
    },
    url: FORM_ROUTE,
    timestamp: 1700000000000,
    metadata: {
      captureMode: 'textOnly',
      coordSpace: 'viewport',
      viewportWidth: 390,
      viewportHeight: 844,
      scroll: { offsetX: 0, offsetY: 0, contentWidth: 390, contentHeight: 844 },
    },
  }
}

/**
 * The form-less received page on a DIFFERENT route — only the confirmation heading and a
 * back link, mirroring the committed serve-local-form.mjs RECEIVED_HTML. Neither the
 * username textbox nor the submit button exists here.
 */
function receivedScreen(): ScreenState {
  const headingRef = asRef('e1')
  const backRef = asRef('e2')
  const headingBounds = { x: 20, y: 80, width: 350, height: 40 }
  const backBounds = { x: 20, y: 160, width: 200, height: 24 }
  return {
    platform: 'web',
    tree: [
      '[Viewport: 390x844] [2 elements]',
      '- heading "Received!" [ref=e1] @(20,80 350x40)',
      '- link "Back to the form" [ref=e2] @(20,160 200x24)',
    ].join('\n'),
    elements: [
      {
        ref: headingRef,
        role: 'heading',
        name: 'Received!',
        nameNormalized: 'received!',
        bounds: headingBounds,
        center: { x: 195, y: 100 },
        state: { enabled: true, focused: false, visible: true },
        labels: {},
        attributes: {},
      },
      {
        ref: backRef,
        role: 'link',
        name: 'Back to the form',
        nameNormalized: 'back to the form',
        bounds: backBounds,
        center: { x: 120, y: 172 },
        state: { enabled: true, focused: false, visible: true },
        labels: {},
        attributes: {},
      },
    ],
    refMap: {
      [headingRef]: { bounds: headingBounds, center: { x: 195, y: 100 } },
      [backRef]: { bounds: backBounds, center: { x: 120, y: 172 } },
    },
    url: RECEIVED_ROUTE,
    timestamp: 1700000000000,
    metadata: {
      captureMode: 'textOnly',
      coordSpace: 'viewport',
      viewportWidth: 390,
      viewportHeight: 844,
      scroll: { offsetX: 0, offsetY: 0, contentWidth: 390, contentHeight: 844 },
    },
  }
}

interface NavigatingHarness {
  adapter: PlatformAdapter
  executed: Action[]
  /** The screen a fresh observation would return RIGHT NOW. */
  currentScreen: () => ScreenState
}

/**
 * The navigate-on-submit adapter: observations serve the form screen until a click-shaped
 * action has EXECUTED, after which every observation serves the form-less received screen —
 * exactly the committed ladder page's behavior. `navigateOn`/`failClicks` let rows script
 * early navigation (drift) and execution failures without changing the shape.
 */
function navigatingAdapter(options?: {
  navigateOn?: 'click' | 'fill'
  /** The first N click executions fail (no navigation) before clicks succeed again. */
  failClicks?: number
}): NavigatingHarness {
  const executed: Action[] = []
  const navigateOn = options?.navigateOn ?? 'click'
  let remainingClickFailures = options?.failClicks ?? 0
  let navigated = false
  const currentScreen = (): ScreenState => (navigated ? receivedScreen() : formScreen())
  const adapter: PlatformAdapter = {
    platform: 'web',
    async setup() {},
    async cleanup() {},
    async observe() {
      return currentScreen()
    },
    async execute(action): Promise<ActionResult> {
      executed.push(action)
      if (action.type === 'click' && remainingClickFailures > 0) {
        remainingClickFailures--
        return { success: false, error: 'simulated click execution failure' }
      }
      if (action.type === navigateOn) navigated = true
      return { success: true }
    },
  }
  return { adapter, executed, currentScreen }
}

/** The committed 2-step flow body: fill the username, then click submit (form-anchored). */
function flowPayload(): ProcedureBodyPayload {
  return {
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
          pageAnchor: { t: 'page', route: FORM_ROUTE },
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
          pageAnchor: { t: 'page', route: FORM_ROUTE },
        },
      },
    ],
    successAssertion: 'The form was submitted',
  }
}

function makeFlowMatch(): ProcedureMatch {
  return {
    id: PROCEDURE_ID,
    flowAnchor,
    confidence: 0.9,
    authoringModelTier: 'full',
    parameterSchema: [{ name: 'PROBE_USER', type: 'string', required: true }],
    replayRecommendation: 'replay',
  }
}

interface FlowReader {
  reader: KnowledgeHintReader
  consultCount: () => number
}

/**
 * A form-anchored reader: the consult matches ONLY on the form route. Post-navigation the
 * flow anchor no longer matches the received page, so the consult returns undefined —
 * the healthy fail-closed behavior the live run exhibited (planSource absent at step 1).
 */
function makeFlowReader(): FlowReader {
  let consults = 0
  const reader: KnowledgeHintReader = {
    getRunBrief() {
      return servedBrief(emptyBrief)
    },
    search() {
      return []
    },
    read(id) {
      return {
        id,
        title: 'Local form procedure',
        body: serializeProcedureBody(flowPayload()),
        anchors: [flowAnchor],
        evidenceDigest: 'digest',
        relations: [],
      }
    },
    getCautions() {
      return noCautions()
    },
    getProcedure(_intent, screenState) {
      consults++
      return screenState.url === FORM_ROUTE ? makeFlowMatch() : undefined
    },
    emitCanaryOutcome() {},
  }
  return { reader, consultCount: () => consults }
}

interface PlannerSpy {
  planner: Planner
  /** Volatile-tier learned slots snapshotted at each live planning call. */
  calls: { l1?: string; l2?: string }[]
}

function capturingPlanner(plans: ActionPlan[]): PlannerSpy {
  const calls: { l1?: string; l2?: string }[] = []
  const planner: Planner = {
    async plan(_step, _screen, context) {
      calls.push({ l1: context.knowledgeBriefL1, l2: context.knowledgeBriefL2 })
      const idx = Math.min(calls.length - 1, plans.length - 1)
      return { plan: plans[idx] }
    },
  }
  return { planner, calls }
}

function context(overrides: Partial<StepContext> = {}): StepContext {
  return makeStepContext({
    testName: 'local-form ladder',
    variables: { PROBE_USER: PROBE_EMAIL },
    ...overrides,
  })
}

function ports(overrides: Partial<LoopPorts> & Pick<LoopPorts, 'adapter' | 'planner'>): LoopPorts {
  return { ...overrides }
}

const STEP_0_TEXT = `Type "${PROBE_EMAIL}" into the Username field`

describe('procedure step boundary', () => {
  it('harness fidelity: the stored click navigates to a form-less received page on a different route', async () => {
    // Check the navigate-on-submit shape before any row leans on it.
    const { adapter } = navigatingAdapter()
    const before = await adapter.observe()
    expect(before.url).toBe(FORM_ROUTE)
    expect(before.elements.some(
      (el) => el.role === 'textbox' && el.nameNormalized === 'username',
    )).toBe(true)
    expect(before.elements.some(
      (el) => el.role === 'button' && el.nameNormalized === 'submit',
    )).toBe(true)

    await adapter.execute({ type: 'click', ref: 'e2' } as unknown as Action)

    const after = await adapter.observe()
    expect(after.url).toBe(RECEIVED_ROUTE)
    expect(after.url).not.toBe(before.url)
    expect(after.elements.some((el) => el.role === 'textbox')).toBe(false)
    expect(after.elements.some(
      (el) => el.role === 'button' && el.nameNormalized === 'submit',
    )).toBe(false)
  })

  it('test step 0 dispatches exactly ONE stored action — the fill', async () => {
    const { adapter, executed } = navigatingAdapter()
    const { reader } = makeFlowReader()
    const planner = capturingPlanner([makeActionPlan()])

    const result = await executeStep(
      STEP_0_TEXT,
      ports({ adapter, planner: planner.planner, knowledgeReader: reader }),
      context(),
    )

    expect(result.status).toBe('passed')
    // A replay match drives that step's actions: only the body step at the cursor.
    expect(executed).toHaveLength(1)
    expect(executed[0]).toMatchObject({ type: 'fill' })
    expect(result.evidence?.subActions).toHaveLength(1)
  })

  it('step 0 records a per-step-complete guard fold, not the whole-body fold', async () => {
    const { adapter } = navigatingAdapter()
    const { reader } = makeFlowReader()
    const planner = capturingPlanner([makeActionPlan()])

    const result = await executeStep(
      STEP_0_TEXT,
      ports({ adapter, planner: planner.planner, knowledgeReader: reader }),
      context(),
    )

    expect(result.status).toBe('passed')
    const planSource = result.evidence?.planSource
    expect(planSource?.kind).toBe('procedure-replay')
    if (planSource?.kind !== 'procedure-replay') {
      throw new Error('expected a procedure-replay planSource')
    }
    // The fold is per step: the total counts stored actions attempted within this test step.
    expect(planSource.guard.checksPassed).toBe(1)
    expect(planSource.guard.total).toBe(1)
    expect(planSource.guard.miss).toBeUndefined()
  })

  it('the stored click is NOT dispatched during test step 0 — the harness stays on the form screen', async () => {
    const { adapter, executed, currentScreen } = navigatingAdapter()
    const { reader } = makeFlowReader()
    const planner = capturingPlanner([makeActionPlan()])

    const result = await executeStep(
      STEP_0_TEXT,
      ports({ adapter, planner: planner.planner, knowledgeReader: reader }),
      context(),
    )

    expect(result.status).toBe('passed')
    // Replay is bounded by the step: body step 1's click belongs to test step 1.
    expect(executed.filter((action) => action.type === 'click')).toHaveLength(0)
    expect(currentScreen().url).toBe(FORM_ROUTE)
  })
})

// Cross-step carry: the member-scoped carry cell is the only channel across a step boundary.

describe('cross-step flow carry', () => {
  it('the carry drives body step 1 at test step 1 — fill at step 0, click at step 1, live at step 2', async () => {
    const flowCell: { carry?: ProcedureFlowCarry } = {}
    const { adapter, executed, currentScreen } = navigatingAdapter()
    const { reader, consultCount } = makeFlowReader()
    const planner = capturingPlanner([makeActionPlan()])
    let verifies = 0
    const verifier: Verifier = {
      async verify(step, _before, after, action) {
        verifies++
        return { verification: scriptedVerification({ step, after, action, pass: true, reasoning: 'accepted' }) }
      },
    }
    const sharedPorts = (): LoopPorts => ports({
      adapter,
      planner: planner.planner,
      verifier,
      knowledgeReader: reader,
      procedureFlow: flowCell,
    })

    // Test step 0: the fresh consult earns replay; the step consumes body step 0 (fill).
    const step0 = await executeStep(STEP_0_TEXT, sharedPorts(), context())
    expect(step0.status).toBe('passed')
    expect(step0.evidence?.planSource).toEqual({
      kind: 'procedure-replay',
      procedureId: PROCEDURE_ID,
      guard: { checksPassed: 1, total: 1 },
      flow: { cursor: 0, length: 2 },
    })
    expect(executed.map((action) => action.type)).toEqual(['fill'])
    expect(currentScreen().url).toBe(FORM_ROUTE)
    // The re-armed carry transports match + payload + cursor only — never a resolved ref.
    expect(flowCell.carry?.nextIndex).toBe(1)
    expect(flowCell.carry?.payload.steps).toHaveLength(2)
    expect(verifies).toBe(1)

    // Test step 1: the carry substitutes the consult (ZERO matcher call) and drives body
    // step 1 (click) under fresh guards on ITS OWN pre-action screen; the click navigates.
    const step1 = await executeStep('Click the Submit button', sharedPorts(), context())
    expect(step1.status).toBe('passed')
    expect(consultCount()).toBe(1)
    expect(step1.evidence?.planSource).toEqual({
      kind: 'procedure-replay',
      procedureId: PROCEDURE_ID,
      guard: { checksPassed: 1, total: 1 },
      flow: { cursor: 1, length: 2 },
    })
    expect(executed.map((action) => action.type)).toEqual(['fill', 'click'])
    expect(currentScreen().url).toBe(RECEIVED_ROUTE)
    // Guards stay pre-action while the evidence records the honest post-action navigation.
    const completing = step1.evidence!.subActions.at(-1)!
    expect(completing.stateBefore.url).toBe(FORM_ROUTE)
    expect(completing.stateAfter?.url).toBe(RECEIVED_ROUTE)
    // Exhaustion: the last body step's test step leaves NO carry.
    expect(flowCell.carry).toBeUndefined()
    expect(verifies).toBe(2)

    // Test step 2: no carry — the fresh consult mismatches the received page (healthy
    // fail-closed behavior) and the step plans live with planSource absent.
    const step2 = await executeStep('Verify the page says "Received!"', sharedPorts(), context())
    expect(step2.status).toBe('passed')
    expect(consultCount()).toBe(2)
    expect(step2.evidence?.planSource).toBeUndefined()
    expect(step2.evidence).toBeDefined()
    expect(Object.hasOwn(step2.evidence!, 'planSource')).toBe(false)
    expect(planner.calls).toHaveLength(1)
    expect(flowCell.carry).toBeUndefined()
  })

  it('a carried guard miss aborts one-shot, projects structural recovery, and leaves no carry', async () => {
    const flowCell: { carry?: ProcedureFlowCarry } = {}
    // Drift shape: the FILL navigates (the form disappears before the carried click's own
    // test step), so the carried body step's guards meet a screen they cannot pass on.
    const { adapter, executed } = navigatingAdapter({ navigateOn: 'fill' })
    const { reader } = makeFlowReader()
    const planner = capturingPlanner([makeActionPlan()])
    const sharedPorts = (): LoopPorts => ports({
      adapter,
      planner: planner.planner,
      knowledgeReader: reader,
      procedureFlow: flowCell,
    })

    const step0 = await executeStep(STEP_0_TEXT, sharedPorts(), context())
    expect(step0.status).toBe('passed')
    expect(flowCell.carry?.nextIndex).toBe(1)

    const step1 = await executeStep('Click the Submit button', sharedPorts(), context())
    expect(step1.status).toBe('passed')
    // The carried step re-runs the guard ladder on the fresh screen, misses and dispatches nothing.
    expect(executed.filter((action) => action.type === 'click')).toHaveLength(1)
    expect(step1.evidence?.planSource).toEqual({
      kind: 'procedure-replay',
      procedureId: PROCEDURE_ID,
      guard: {
        checksPassed: 0,
        total: 1,
        miss: { procedureStepIndex: 1, reason: 'descriptor-missing' },
      },
      flow: { cursor: 1, length: 2 },
    })
    // One-shot: the take at step start empties the cell and the miss never re-arms it.
    expect(planner.calls).toHaveLength(1)
    const learned = `${planner.calls[0].l1 ?? ''}\n${planner.calls[0].l2 ?? ''}`
    expect(learned).toContain('Guarded replay recovery evidence for procedure step 2')
    expect(learned).toContain('miss location: action-target lane=ref')
    expect(learned).toContain('role=button; name=Submit')
    expect(learned).toContain('fresh same-role candidates:\n- none')
    expect(learned).not.toContain('Click the Submit button')
    expect(flowCell.carry).toBeUndefined()
  })

  it('an execution failure at a carried step aborts the flow and leaves no carry', async () => {
    const flowCell: { carry?: ProcedureFlowCarry } = {}
    const { adapter, executed } = navigatingAdapter({ failClicks: 1 })
    const { reader } = makeFlowReader()
    const planner = capturingPlanner([makeActionPlan()])
    const sharedPorts = (): LoopPorts => ports({
      adapter,
      planner: planner.planner,
      knowledgeReader: reader,
      procedureFlow: flowCell,
    })

    const step0 = await executeStep(STEP_0_TEXT, sharedPorts(), context())
    expect(step0.status).toBe('passed')
    expect(flowCell.carry?.nextIndex).toBe(1)

    const step1 = await executeStep('Click the Submit button', sharedPorts(), context())
    expect(step1.status).toBe('passed')
    // The carried click passed its guards, the adapter failed it, and live planning
    // recovered — the flow itself is over with no carry.
    expect(executed.filter((action) => action.type === 'click')).toHaveLength(2)
    expect(step1.evidence?.planSource).toEqual({
      kind: 'procedure-replay',
      procedureId: PROCEDURE_ID,
      guard: {
        checksPassed: 0,
        total: 1,
        executionFailure: { procedureStepIndex: 1 },
      },
      flow: { cursor: 1, length: 2 },
    })
    expect(planner.calls).toHaveLength(1)
    expect(flowCell.carry).toBeUndefined()
  })

  it('a verifier rejection at a carried step aborts the flow and leaves no carry', async () => {
    const flowCell: { carry?: ProcedureFlowCarry } = {}
    const { adapter } = navigatingAdapter()
    const { reader } = makeFlowReader()
    const planner = capturingPlanner([makeActionPlan()])
    const verifier = makeVerifier([
      { success: true, reasoning: 'fill accepted', isAppError: false },
      { success: false, reasoning: 'the submission did not register', isAppError: false },
      { success: true, reasoning: 'live recovery accepted', isAppError: false },
    ])
    const sharedPorts = (): LoopPorts => ports({
      adapter,
      planner: planner.planner,
      verifier,
      knowledgeReader: reader,
      procedureFlow: flowCell,
    })

    const step0 = await executeStep(STEP_0_TEXT, sharedPorts(), context())
    expect(step0.status).toBe('passed')
    expect(flowCell.carry?.nextIndex).toBe(1)

    const step1 = await executeStep('Click the Submit button', sharedPorts(), context())
    expect(step1.status).toBe('passed')
    expect(step1.evidence?.planSource).toEqual({
      kind: 'procedure-replay',
      procedureId: PROCEDURE_ID,
      guard: {
        checksPassed: 1,
        total: 1,
        verifierRejection: { procedureStepIndex: 1 },
      },
      flow: { cursor: 1, length: 2 },
    })
    // Rejection aborts the flow, not just replay re-entry within the step.
    expect(planner.calls).toHaveLength(1)
    const learned = `${planner.calls[0].l1 ?? ''}\n${planner.calls[0].l2 ?? ''}`
    expect(learned).toContain('Guarded replay verifier rejected procedure step 2')
    expect(flowCell.carry).toBeUndefined()
  })

  it('a failed step never propagates a carry', async () => {
    const flowCell: { carry?: ProcedureFlowCarry } = {}
    const { adapter } = navigatingAdapter()
    const { reader } = makeFlowReader()
    const planner = capturingPlanner([
      makeActionPlan({ stepFailed: true, stepComplete: false }),
    ])
    const verifier = makeVerifier([
      { success: false, reasoning: 'the fill did not accomplish the step', isAppError: false },
    ])

    const result = await executeStep(
      STEP_0_TEXT,
      ports({
        adapter,
        planner: planner.planner,
        verifier,
        knowledgeReader: reader,
        procedureFlow: flowCell,
      }),
      context(),
    )

    expect(result.status).toBe('failed')
    expect(result.evidence?.planSource).toEqual({
      kind: 'procedure-replay',
      procedureId: PROCEDURE_ID,
      guard: {
        checksPassed: 1,
        total: 1,
        verifierRejection: { procedureStepIndex: 0 },
      },
      flow: { cursor: 0, length: 2 },
    })
    expect(flowCell.carry).toBeUndefined()
  })
})

// The guard-miss context names stored and fresh candidates by role and name, never by position.

function okayScreen(): ScreenState {
  const base = formScreen()
  const okay = (ref: string, y: number) => ({
    ...base.elements[1]!,
    ref: asRef(ref),
    name: 'Okay',
    nameNormalized: 'okay',
    bounds: { x: 20, y, width: 350, height: 44 },
    center: { x: 195, y: y + 22 },
  })
  const elements = [okay('e1', 120), okay('e2', 200)]
  return {
    ...base,
    tree: '- button "Okay" [ref=e1]\n- button "Okay" [ref=e2]',
    elements,
    refMap: Object.fromEntries(
      elements.map((element) => [element.ref, { bounds: element.bounds, center: element.center }]),
    ),
  }
}

async function recoveryBlockFor(target: ProcedureBodyPayload['steps'][number]['guard']['target']) {
  const payload: ProcedureBodyPayload = {
    schemaVersion: PROCEDURE_BODY_SCHEMA_VERSION,
    parameters: [],
    steps: [{
      instruction: 'Confirm the dialog',
      action: { type: 'click', targets: { ref: target }, values: {} },
      guard: { target, pageAnchor: { t: 'page', route: FORM_ROUTE } },
    }],
    successAssertion: 'The dialog is confirmed',
  }
  const reader: KnowledgeHintReader = {
    getRunBrief: () => servedBrief(emptyBrief),
    search: () => [],
    read: (id) => ({
      id,
      title: 'Confirm procedure',
      body: serializeProcedureBody(payload),
      anchors: [flowAnchor],
      evidenceDigest: 'digest',
      relations: [],
    }),
    getCautions: () => noCautions(),
    getProcedure: () => ({ ...makeFlowMatch(), parameterSchema: [] }),
    emitCanaryOutcome: () => {},
  }
  const screen = okayScreen()
  const adapter: PlatformAdapter = {
    platform: 'web',
    async setup() {},
    async cleanup() {},
    async observe() {
      return screen
    },
    async execute(): Promise<ActionResult> {
      return { success: true }
    },
  }
  const planner = capturingPlanner([
    makeActionPlan({ action: { type: 'click', ref: 'e1' }, stepComplete: true }),
  ])
  const result = await executeStep(
    'Confirm the dialog',
    ports({ adapter, planner: planner.planner, knowledgeReader: reader }),
    context(),
  )
  expect(result.status).toBe('passed')
  expect(planner.calls).toHaveLength(1)
  const learned = `${planner.calls[0].l1 ?? ''}\n${planner.calls[0].l2 ?? ''}`
  return learned.slice(learned.indexOf('Guarded replay recovery evidence'))
}

describe('structural recovery names role and name, never a position', () => {
  it('an ambiguous body target is recovered by role and name, with no position', async () => {
    const block = await recoveryBlockFor({ role: 'button', nameNormalized: 'okay', name: 'Okay' })

    expect(block).toContain('miss reason: descriptor-ambiguous')
    expect(block).toContain('- ref: role=button; name=Okay\n')
    expect(block).toContain('declared guard target: role=button; name=Okay\n')
    expect(block).toContain(
      'fresh same-role candidates:\n- role=button; name=Okay\n- role=button; name=Okay',
    )
    expect(block).not.toMatch(/ordinal/i)
  })

  it('a stored row is named, and a legacy body falls back to its normalized name', async () => {
    const withRow = await recoveryBlockFor({
      role: 'button',
      nameNormalized: 'okay',
      name: 'Okay',
      row: '7 Elm Street',
    })
    expect(withRow).toContain('miss reason: descriptor-missing')
    expect(withRow).toContain('declared guard target: role=button; name=Okay; row=7 Elm Street\n')
    expect(withRow).not.toMatch(/ordinal/i)

    const legacy = await recoveryBlockFor({ role: 'button', nameNormalized: 'okay', ordinal: 1 })
    expect(legacy).toContain('miss reason: descriptor-missing')
    expect(legacy).toContain('declared guard target: role=button; name=okay\n')
    expect(legacy).not.toMatch(/ordinal/i)
  })
})
