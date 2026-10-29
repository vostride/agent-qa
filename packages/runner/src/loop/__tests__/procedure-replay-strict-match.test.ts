// C438-PROCEDURE-STRICT (438 D-11, D-13, SC3): a committed procedure step replays only onto the
// one current element with its role, exact name and (when stored) row words. Anything else is a
// typed guard miss that takes the existing recovery path, and nothing is replayed by position.
// The real loop (executeStep) runs over makeScreenState screens with a stub knowledge reader.
import { describe, expect, it } from 'vitest'
import {
  PROCEDURE_BODY_SCHEMA_VERSION,
  asRecordId,
  asRef,
  parseProcedureBody,
  serializeProcedureBody,
} from '@vostride/agent-qa-schema'
import type {
  ElementInfo,
  ProcedureBodyPayload,
  ProcedureGuardTarget,
  ProcedureMatch,
  ScreenState,
} from '@vostride/agent-qa-schema'
import type { KnowledgeHintReader } from '../../knowledge-hint-reader.js'
import type { Action, PlatformAdapter } from '../../platform.js'
import { executeStep } from '../index.js'
import type { ActionPlan, Planner } from '../types.js'
import { makeScreenState } from '../../testing/screen-fixtures.js'
import { makeActionPlan, makeStepContext } from './loop-harness.js'
import { noCautions, servedBrief } from './fixtures/served-trace.js'

const ROUTE = 'https://example.test/login'
const PROCEDURE_ID = asRecordId('proc-strict')

function el(
  ref: string,
  role: string,
  name: string,
  nameNormalized: string,
  parentRef?: string,
): ElementInfo {
  return {
    ref: asRef(ref),
    role,
    name,
    nameNormalized,
    bounds: { x: 10, y: 10, width: 100, height: 40 },
    center: { x: 60, y: 30 },
    state: { enabled: true, focused: false, visible: true },
    labels: {},
    attributes: {},
    ...(parentRef === undefined ? {} : { hierarchy: { parentRef: asRef(parentRef) } }),
  }
}

function screenWith(elements: ElementInfo[]): ScreenState {
  const refMap: ScreenState['refMap'] = {}
  for (const e of elements) refMap[e.ref] = { bounds: e.bounds!, center: e.center! }
  return makeScreenState({ elements, refMap })
}

function addressRows(): ScreenState {
  return screenWith([
    el('r1', 'listitem', '9 Oak Road', '9 oak road'),
    el('b1', 'button', 'Edit label', 'edit label', 'r1'),
    el('r2', 'listitem', '7 Elm Street', '7 elm street'),
    el('b2', 'button', 'Edit label', 'edit label', 'r2'),
    el('r3', 'listitem', '3 Ash Lane', '3 ash lane'),
    el('b3', 'button', 'Edit label', 'edit label', 'r3'),
  ])
}

function clickBody(target: ProcedureGuardTarget): ProcedureBodyPayload {
  return {
    schemaVersion: PROCEDURE_BODY_SCHEMA_VERSION,
    parameters: [],
    steps: [{
      instruction: 'Click the stored target',
      action: { type: 'click', targets: { ref: target }, values: {} },
      guard: { target, pageAnchor: { t: 'page', route: ROUTE } },
    }],
    successAssertion: 'The stored click completed',
  }
}

function readerOf(payload: ProcedureBodyPayload): KnowledgeHintReader {
  const match: ProcedureMatch = {
    id: PROCEDURE_ID,
    flowAnchor: { t: 'flow', name: 'strict' },
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
      title: 'Strict procedure',
      body: serializeProcedureBody(payload),
      anchors: [{ t: 'flow', name: 'strict' }],
      evidenceDigest: 'digest',
      relations: [],
    }),
    getCautions: () => noCautions(),
    getProcedure: () => match,
    emitCanaryOutcome: () => {},
  }
}

function recordingAdapter(screen: ScreenState): PlatformAdapter & { executed: Action[] } {
  const executed: Action[] = []
  return {
    platform: 'web',
    executed,
    async setup() {},
    async cleanup() {},
    async observe() {
      return screen
    },
    async execute(action: Action) {
      executed.push(action)
      return { success: true }
    },
  }
}

function countingPlanner(plan: ActionPlan): Planner & { calls: number } {
  const planner = {
    calls: 0,
    async plan() {
      planner.calls++
      return { plan }
    },
  }
  return planner
}

async function run(payload: ProcedureBodyPayload, screen: ScreenState, liveRef: string) {
  const adapter = recordingAdapter(screen)
  const planner = countingPlanner(
    makeActionPlan({ action: { type: 'click', ref: liveRef }, stepComplete: true }),
  )
  const result = await executeStep(
    'Click the stored target',
    { adapter, planner, knowledgeReader: readerOf(payload) },
    makeStepContext({ testName: 'strict' }),
  )
  return { result, executed: adapter.executed, planner }
}

function missOf(reason: 'descriptor-missing' | 'descriptor-ambiguous') {
  return {
    kind: 'procedure-replay',
    procedureId: PROCEDURE_ID,
    guard: { checksPassed: 0, total: 1, miss: { procedureStepIndex: 0, reason } },
    flow: { cursor: 0, length: 1 },
  }
}

const replayed = {
  kind: 'procedure-replay',
  procedureId: PROCEDURE_ID,
  guard: { checksPassed: 1, total: 1 },
  flow: { cursor: 0, length: 1 },
}

const invoice947: ProcedureGuardTarget = {
  role: 'link',
  nameNormalized: 'invoice',
  name: 'Invoice 947',
}

describe('C438-PROCEDURE-STRICT', () => {
  it('947 replays onto 947 beside 946', async () => {
    const screen = screenWith([
      el('e1', 'link', 'Invoice 946', 'invoice'),
      el('e2', 'link', 'Invoice 947', 'invoice'),
    ])

    const { result, executed, planner } = await run(clickBody(invoice947), screen, 'e1')

    expect(result.status).toBe('passed')
    expect(planner.calls).toBe(0)
    expect(executed).toMatchObject([{ type: 'click', ref: 'e2' }])
    expect(executed).toHaveLength(1)
    expect(result.evidence?.planSource).toEqual(replayed)
  })

  it('947 against 946 alone is a guard miss', async () => {
    const screen = screenWith([el('e1', 'link', 'Invoice 946', 'invoice')])

    const { result, executed, planner } = await run(clickBody(invoice947), screen, 'e1')

    expect(result.status).toBe('passed')
    expect(planner.calls).toBe(1)
    expect(executed).toHaveLength(1)
    expect(result.evidence?.planSource).toEqual(missOf('descriptor-missing'))
  })

  it('row words single out a repeated label', async () => {
    const editLabel = { role: 'button', nameNormalized: 'edit label', name: 'Edit label' }

    const withRow = await run(
      clickBody({ ...editLabel, row: '7 Elm Street' }),
      addressRows(),
      'b1',
    )
    expect(withRow.result.status).toBe('passed')
    expect(withRow.planner.calls).toBe(0)
    expect(withRow.executed).toMatchObject([{ type: 'click', ref: 'b2' }])
    expect(withRow.result.evidence?.planSource).toEqual(replayed)

    const withoutRow = await run(clickBody(editLabel), addressRows(), 'b1')
    expect(withoutRow.planner.calls).toBe(1)
    expect(withoutRow.executed).toMatchObject([{ type: 'click', ref: 'b1' }])
    expect(withoutRow.executed).toHaveLength(1)
    expect(withoutRow.result.evidence?.planSource).toEqual(missOf('descriptor-ambiguous'))
  })

  it('a legacy body still parses and misses', async () => {
    const legacy = clickBody({ role: 'button', nameNormalized: 'log in', ordinal: 0 })
    expect(parseProcedureBody(serializeProcedureBody(legacy))).toEqual(legacy)

    // The default screen holds exactly one 'log in' button, at position 0.
    const { result, executed, planner } = await run(legacy, makeScreenState(), 'e1')

    expect(planner.calls).toBe(1)
    expect(executed).toMatchObject([{ type: 'click', ref: 'e1' }])
    expect(executed).toHaveLength(1)
    expect(result.evidence?.planSource).toEqual(missOf('descriptor-missing'))
  })
})
