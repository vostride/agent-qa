import { describe, expect, it } from 'vitest'
import {
  PROCEDURE_BODY_SCHEMA_VERSION,
  asRecordId,
  asRef,
  serializeProcedureBody,
} from '@vostride/agent-qa-schema'
import type {
  ElementInfo,
  ProcedureBodyPayload,
  ProcedureGuardTarget,
  ProcedureMatch,
  ScreenState,
} from '@vostride/agent-qa-schema'
import type { CachedPlanValue } from '../../cache/port.js'
import type { KnowledgeHintReader } from '../../knowledge-hint-reader.js'
import type { StepResult, TestResult } from '../../result.js'
import { deriveMemberOutcome } from '../../run/verdict.js'
import { makeScreenState } from '../../testing/screen-fixtures.js'
import { executeStep } from '../index.js'
import { makeActionPlan, makeStepContext, makeVerifier } from './loop-harness.js'
import { noCautions, servedBrief } from './fixtures/served-trace.js'
import {
  CLICK_SAVE,
  FILL_EMAIL,
  FILL_NAME,
  el,
  forgetCalls,
  formScreens,
  recordingCache,
  runStep,
  screen,
  scriptedPlanner,
} from './fixtures/saved-path.js'
import type { RecordingCache } from './fixtures/saved-path.js'

function outcomeOf(step: StepResult) {
  const test: TestResult = {
    name: 'save a contact',
    filePath: 'save-a-contact.test.yaml',
    status: step.status === 'passed' ? 'passed' : 'failed',
    steps: [step],
    duration: 1,
  }
  return deriveMemberOutcome(test)
}

const CONFIRM_SAVED = makeActionPlan({
  reasoning: 'Open the saved contact',
  action: { type: 'click', ref: 'e1' },
  stepComplete: true,
})

function rejectOnceVerifier() {
  return makeVerifier([
    { success: false, reasoning: 'The saved contact is not shown' },
    { success: true, reasoning: 'The contact is saved' },
  ])
}

// The screen identity hashes nameNormalized and the strict re-find compares the name, so a
// renamed element whose nameNormalized is kept leaves the cache key unchanged.
function renamed(element: ElementInfo, name: string): ElementInfo {
  return { ...element, name }
}

function draftScreens(buttons: ElementInfo[]): ScreenState[] {
  return [
    screen('https://notes.test/draft', [el('e1', 'textbox', 'Title', 120, 'Plan'), ...buttons]),
    screen('https://notes.test/saved', [el('e1', 'heading', 'Draft saved', 80)]),
  ]
}

const CLICK_SECOND = makeActionPlan({
  reasoning: 'Save the draft',
  action: { type: 'click', ref: 'e2' },
  stepComplete: true,
})

async function savedOneTurnPath(
  screens: ScreenState[],
): Promise<{ cache: RecordingCache; key: string }> {
  const cache = recordingCache()
  const first = await runStep({ cache, screens, planner: scriptedPlanner([CLICK_SECOND]) })
  expect(first.status).toBe('passed')
  expect(cache.sets).toHaveLength(1)
  const key = cache.sets[0]
  forgetCalls(cache)
  return { cache, key }
}

async function savedThreeTurnPath(): Promise<{ cache: RecordingCache; keys: string[] }> {
  const cache = recordingCache()
  const first = await runStep({
    cache,
    planner: scriptedPlanner([FILL_NAME, FILL_EMAIL, CLICK_SAVE]),
  })
  expect(first.status).toBe('passed')
  const keys = [...cache.sets]
  expect(new Set(keys).size).toBe(3)
  forgetCalls(cache)
  return { cache, keys }
}

describe('healed means a saved path failed and was repaired', () => {
  it('a replayed cached action that fails and is repaired ends healed', async () => {
    const { cache, keys } = await savedThreeTurnPath()

    const step = await runStep({
      cache,
      planner: scriptedPlanner([FILL_NAME]),
      results: [{ success: false, error: 'The field did not take the text' }],
    })

    expect(step.status).toBe('passed')
    expect(step.evidence!.subActions[0].plan).toBe('Replayed from cache')
    expect(step.evidence!.subActions[0].result.success).toBe(false)
    expect(step.evidence!.selfHeal).toBeDefined()
    expect(outcomeOf(step)).toBe('healed')
    expect(cache.invalidated).toEqual([keys[0]])
  })

  it('a cached entry that can never replay is a plain miss that ends passed', async () => {
    const { cache, keys } = await savedThreeTurnPath()
    cache.store.set(keys[0], {
      plannedActions: [{ type: 'tapCoordinate', x: 195, y: 142 }],
      groundedLocator: [],
      completesStep: false,
    } as unknown as CachedPlanValue)

    const step = await runStep({ cache, planner: scriptedPlanner([FILL_NAME]) })

    expect(step.status).toBe('passed')
    expect(step.evidence!.cacheStatus).toBe('miss')
    expect(step.evidence!.cacheMiss?.reason).toBe('non-replayable')
    expect(step.evidence!.selfHeal).toBeUndefined()
    expect(outcomeOf(step)).toBe('passed')
  })

  it('a cached replay the verifier rejects is invalidated, every replayed turn with it, and the repaired step reads healed', async () => {
    const { cache, keys } = await savedThreeTurnPath()

    const step = await runStep({
      cache,
      planner: scriptedPlanner([CONFIRM_SAVED]),
      verifier: rejectOnceVerifier(),
    })

    expect(step.status).toBe('passed')
    expect(cache.gets.map((get) => get.hit)).toEqual([true, true, true, false])
    expect(cache.invalidated).toEqual(keys)
    expect(step.evidence!.selfHeal).toBeDefined()
    expect(outcomeOf(step)).toBe('healed')
    const liveKey = cache.gets[3].key
    expect(new Set(cache.sets)).toEqual(new Set([...keys, liveKey]))
    expect(cache.store.get(liveKey)!.completesStep).toBe(true)
    expect(keys.map((key) => cache.store.get(key)!.completesStep)).toEqual([false, false, false])
  })

  it('a claim a live turn makes after replayed turns is not a saved-path failure', async () => {
    const { cache } = await savedThreeTurnPath()

    const step = await runStep({
      cache,
      screens: formScreens(true),
      planner: scriptedPlanner([CLICK_SAVE, CONFIRM_SAVED]),
      verifier: rejectOnceVerifier(),
    })

    expect(step.status).toBe('passed')
    expect(cache.gets.slice(0, 3).map((get) => get.hit)).toEqual([true, true, false])
    expect(cache.invalidated).toEqual([])
    expect(step.evidence!.selfHeal).toBeUndefined()
  })

  it('a cached target that is gone from the page makes the repair read healed', async () => {
    const saveDraft = el('e2', 'button', 'Save draft', 240)
    const { cache, key } = await savedOneTurnPath(draftScreens([saveDraft]))
    const planner = scriptedPlanner([CLICK_SECOND])

    const step = await runStep({
      cache,
      screens: draftScreens([renamed(saveDraft, 'Save Draft')]),
      planner,
    })

    expect(cache.gets[0]).toEqual({ key, hit: true })
    expect(step.evidence!.cacheMiss?.reason).toBe('strict-absent')
    expect(cache.invalidated[0]).toBe(key)
    expect(planner.calls).toBe(1)
    expect(step.status).toBe('passed')
    expect(step.evidence!.selfHeal).toBeDefined()
    expect(step.evidence!.selfHeal!.failedDecision.plan).toBe('Replayed from cache')
    expect(step.evidence!.selfHeal!.failedDecision.result.success).toBe(false)
    expect(outcomeOf(step)).toBe('healed')
  })

  it('a cached target that is no longer unique makes the repair read healed', async () => {
    const save = el('e2', 'button', 'Save', 240)
    const saveAs = el('e3', 'button', 'Save as', 300)
    const { cache, key } = await savedOneTurnPath(draftScreens([save, saveAs]))

    const step = await runStep({
      cache,
      screens: draftScreens([save, renamed(saveAs, 'Save')]),
      planner: scriptedPlanner([CLICK_SECOND]),
    })

    expect(cache.gets[0]).toEqual({ key, hit: true })
    expect(step.evidence!.cacheMiss?.reason).toBe('strict-not-unique')
    expect(cache.invalidated[0]).toBe(key)
    expect(step.status).toBe('passed')
    expect(step.evidence!.selfHeal).toBeDefined()
    expect(step.evidence!.selfHeal!.failedDecision.plan).toBe('Replayed from cache')
    expect(outcomeOf(step)).toBe('healed')
  })
})

const INVOICES = 'https://billing.test/invoices'
const PROCEDURE_ID = asRecordId('proc-open-invoice')

function link(ref: string, name: string): ElementInfo {
  return {
    ref: asRef(ref),
    role: 'link',
    name,
    nameNormalized: 'invoice',
    bounds: { x: 10, y: 10, width: 100, height: 40 },
    center: { x: 60, y: 30 },
    state: { enabled: true, focused: false, visible: true },
    labels: {},
    attributes: {},
  }
}

function invoiceScreen(elements: ElementInfo[]): ScreenState {
  const refMap: ScreenState['refMap'] = {}
  for (const element of elements) {
    refMap[element.ref] = { bounds: element.bounds!, center: element.center! }
  }
  return makeScreenState({ url: INVOICES, elements, refMap })
}

const invoice947: ProcedureGuardTarget = {
  role: 'link',
  nameNormalized: 'invoice',
  name: 'Invoice 947',
}

function openInvoiceBody(route = INVOICES): ProcedureBodyPayload {
  return {
    schemaVersion: PROCEDURE_BODY_SCHEMA_VERSION,
    parameters: [],
    steps: [{
      instruction: 'Open invoice 947',
      action: { type: 'click', targets: { ref: invoice947 }, values: {} },
      guard: { target: invoice947, pageAnchor: { t: 'page', route } },
    }],
    successAssertion: 'Invoice 947 is open',
  }
}

function procedureReader(payload: ProcedureBodyPayload): KnowledgeHintReader {
  const match: ProcedureMatch = {
    id: PROCEDURE_ID,
    flowAnchor: { t: 'flow', name: 'open-invoice' },
    confidence: 0.9,
    authoringModelTier: 'full',
    parameterSchema: [],
    replayRecommendation: 'replay',
  }
  return {
    getRunBrief: () =>
      servedBrief({ tiers: { L0: '', L1: '', L2: '' }, lines: [], truncation: '', admissions: [] }),
    search: () => [],
    read: (id) => ({
      id,
      title: 'Open an invoice',
      body: serializeProcedureBody(payload),
      anchors: [{ t: 'flow', name: 'open-invoice' }],
      evidenceDigest: 'digest',
      relations: [],
    }),
    getCautions: () => noCautions(),
    getProcedure: () => match,
    emitCanaryOutcome: () => {},
  }
}

async function runProcedureStep(payload: ProcedureBodyPayload, page: ScreenState, liveRef: string) {
  const planner = scriptedPlanner([
    makeActionPlan({ action: { type: 'click', ref: liveRef }, stepComplete: true }),
  ])
  const step = await executeStep(
    'Open invoice 947',
    {
      adapter: {
        platform: 'web',
        async setup() {},
        async cleanup() {},
        async observe() {
          return page
        },
        async execute() {
          return { success: true }
        },
      },
      planner,
      verifier: makeVerifier(),
      knowledgeReader: procedureReader(payload),
    },
    makeStepContext({ stepInstruction: 'Open invoice 947', testName: 'open an invoice' }),
  )
  return { step, planner }
}

function guardMissOf(step: StepResult) {
  const source = step.evidence!.planSource
  return source?.kind === 'procedure-replay' ? source.guard.miss?.reason : undefined
}

describe('healed means a saved procedure failed and was repaired', () => {
  it('a procedure target that is gone makes the repair read healed', async () => {
    const page = invoiceScreen([link('e1', 'Invoice 946')])

    const { step, planner } = await runProcedureStep(openInvoiceBody(), page, 'e1')

    expect(guardMissOf(step)).toBe('descriptor-missing')
    expect(planner.calls).toBe(1)
    expect(step.status).toBe('passed')
    expect(step.evidence!.selfHeal).toBeDefined()
    expect(step.evidence!.selfHeal!.failedDecision.plan).toBe('Replayed from a saved procedure')
    expect(step.evidence!.selfHeal!.failedDecision.result.success).toBe(false)
    expect(outcomeOf(step)).toBe('healed')
  })

  it('a procedure target that is no longer unique makes the repair read healed', async () => {
    const page = invoiceScreen([link('e1', 'Invoice 947'), link('e2', 'Invoice 947')])

    const { step, planner } = await runProcedureStep(openInvoiceBody(), page, 'e2')

    expect(guardMissOf(step)).toBe('descriptor-ambiguous')
    expect(planner.calls).toBe(1)
    expect(step.status).toBe('passed')
    expect(step.evidence!.selfHeal).toBeDefined()
    expect(step.evidence!.selfHeal!.failedDecision.plan).toBe('Replayed from a saved procedure')
    expect(outcomeOf(step)).toBe('healed')
  })

  it('a procedure target stored with no name is a plain miss that ends passed', async () => {
    const unnamed: ProcedureGuardTarget = { role: 'link', nameNormalized: 'invoice' }
    const body = openInvoiceBody()
    const payload: ProcedureBodyPayload = {
      ...body,
      steps: body.steps.map((step) => ({
        ...step,
        action: { ...step.action, targets: { ref: unnamed } },
        guard: { ...step.guard, target: unnamed },
      })),
    }
    const page = invoiceScreen([link('e1', 'Invoice 947')])

    const { step, planner } = await runProcedureStep(payload, page, 'e1')

    expect(guardMissOf(step)).toBe('descriptor-missing')
    expect(planner.calls).toBe(1)
    expect(step.status).toBe('passed')
    expect(step.evidence!.selfHeal).toBeUndefined()
    expect(outcomeOf(step)).toBe('passed')
  })

  it('a procedure matched to another page is a plain miss', async () => {
    const page = invoiceScreen([link('e1', 'Invoice 946'), link('e2', 'Invoice 947')])

    const { step, planner } = await runProcedureStep(
      openInvoiceBody('https://billing.test/receipts'),
      page,
      'e2',
    )

    expect(guardMissOf(step)).toBe('page-anchor-mismatch')
    expect(planner.calls).toBe(1)
    expect(step.status).toBe('passed')
    expect(step.evidence!.selfHeal).toBeUndefined()
    expect(outcomeOf(step)).toBe('passed')
  })
})
