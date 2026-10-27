// HARN-02 / 436 D-01, D-07, D-10..D-13: a step execution runs under a monotonic action limit and
// stops honestly, with a typed limit block, when the limit refuses the next dispatch.
import { describe, expect, it } from 'vitest'
import {
  PROCEDURE_BODY_SCHEMA_VERSION,
  asRecordId,
  DEFAULT_PLANNER_LIMITS,
  formatLimitStopReason,
  resolvePlannerLimits,
  serializeProcedureBody,
} from '@vostride/agent-qa-schema'
import type { ProcedureBodyPayload, ScreenState, StepLimitUsage } from '@vostride/agent-qa-schema'
import type { ActionPlanCache, CacheablePlannedAction, CachedPlanValue } from '../../cache/port.js'
import type { KnowledgeHintReader } from '../../knowledge-hint-reader.js'
import type { Action, ActionResult, PlatformAdapter } from '../../platform.js'
import { makeScreenState } from '../../testing/screen-fixtures.js'
import { createTimeoutAbortReason } from '../abort.js'
import { executeStep } from '../index.js'
import { formatUnprovenReason } from '../requested-conditions.js'
import { SecretRedactor, SecretStore } from '../secrets.js'
import type { LoopPorts } from '../ports.js'
import type { StepLimitMeter } from '../step-limits.js'
import type { ActionPlan, Planner, Verifier } from '../types.js'
import { scriptedVerification, toVerificationResult } from '../../testing/condition-verdicts.js'
import type { ScriptedVerdict } from '../../testing/condition-verdicts.js'
import { noCautions, servedBrief } from './fixtures/served-trace.js'
import { makeActionPlan, makeAdapter, makeStepContext } from './loop-harness.js'

function ports(overrides: Partial<LoopPorts> & Pick<LoopPorts, 'adapter' | 'planner'>): LoopPorts {
  return overrides
}

function scriptedPlanner(plans: ActionPlan[]): Planner & { calls: number } {
  const planner = {
    calls: 0,
    async plan() {
      const plan = plans[Math.min(planner.calls, plans.length - 1)]
      planner.calls++
      return { plan }
    },
  }
  return planner
}

function countingAdapter(result: ActionResult = { success: true }): PlatformAdapter & { executed: Action[] } {
  const executed: Action[] = []
  return {
    executed,
    platform: 'web',
    async setup() {},
    async cleanup() {},
    async observe() { return makeScreenState() },
    async execute(action: Action) {
      executed.push(action)
      return result
    },
  }
}

function scriptedVerifier(results: ScriptedVerdict[]): Verifier & { calls: number } {
  const verifier = {
    calls: 0,
    async verify(step: string, _before: ScreenState, after: ScreenState, action: Action) {
      const verdict = results[Math.min(verifier.calls, results.length - 1)]
      verifier.calls++
      return { verification: toVerificationResult(verdict, { step, after, action }) }
    },
  }
  return verifier
}

const limits = (maxActions: number) => ({ maxActions, maxPlanningTurns: maxActions, previousStepCount: 0 })

describe('C436-STEP-LIMITS', () => {
  it('a live step stops at its action limit with a typed limit block', async () => {
    const adapter = countingAdapter()
    const planner = scriptedPlanner([makeActionPlan({ reasoning: '', stepComplete: false })])
    const result = await executeStep(
      'Press the dead button until something happens',
      ports({ adapter, planner, plannerConfig: limits(3) }),
      makeStepContext(),
    )
    const reason = 'Stopped: action limit reached — 3 of 3 actions used'
    expect(adapter.executed).toHaveLength(3)
    expect(planner.calls).toBe(3)
    expect(result.status).toBe('failed')
    expect(result.error).toBe(reason)
    expect(result.evidence?.limitStop).toEqual({
      limit: 'actions',
      configured: 3,
      used: 3,
      requestedOutcome: 'unverified',
      reason,
    })
    expect(result.evidence?.planningFailure).toBeUndefined()
    expect(result.evidence?.termination).toBeUndefined()
    expect(result.evidence?.verdictSource).toBeUndefined()
    expect(result.evidence?.limitUsage).toMatchObject({ limits: { maxActions: 3, maxPlanningTurns: 3 }, actionsUsed: 3 })
  })

  it("the Nth action's completion claim is verified and can pass", async () => {
    const adapter = countingAdapter()
    const planner = scriptedPlanner([
      makeActionPlan({ stepComplete: false }),
      makeActionPlan({ stepComplete: false }),
      makeActionPlan({ stepComplete: true }),
    ])
    const verifier = scriptedVerifier([{ success: true, reasoning: 'Logged in', isAppError: false }])
    const result = await executeStep('Log in', ports({ adapter, planner, verifier, plannerConfig: limits(3) }), makeStepContext())
    expect(result.status).toBe('passed')
    expect(verifier.calls).toBe(1)
    expect(adapter.executed).toHaveLength(3)
    expect(result.evidence?.limitStop).toBeUndefined()
    expect(result.evidence?.limitUsage?.actionsUsed).toBe(3)
  })

  it('the N-1 case completes normally', async () => {
    const adapter = countingAdapter()
    const planner = scriptedPlanner([makeActionPlan({ stepComplete: false }), makeActionPlan({ stepComplete: true })])
    const verifier = scriptedVerifier([{ success: true, reasoning: 'Logged in', isAppError: false }])
    const result = await executeStep('Log in', ports({ adapter, planner, verifier, plannerConfig: limits(3) }), makeStepContext())
    expect(result.status).toBe('passed')
    expect(result.evidence?.limitStop).toBeUndefined()
    expect(result.evidence?.limitUsage?.actionsUsed).toBe(2)
  })

  it("the limit block carries the last verifier rejection and the planner's last reasoning", async () => {
    const secretRedactor = new SecretRedactor(new SecretStore({ FORM_SECRET: 'hunter2-secret' }))
    const adapter = countingAdapter()
    const planner = scriptedPlanner([
      makeActionPlan({ reasoning: 'First try with hunter2-secret', stepComplete: true }),
      makeActionPlan({ reasoning: 'Second try with hunter2-secret', stepComplete: true }),
      makeActionPlan({ reasoning: 'Third try with hunter2-secret', stepComplete: true }),
    ])
    const verifier = scriptedVerifier([
      { success: false, reasoning: 'Saved banner absent (1)', isAppError: false },
      { success: false, reasoning: 'Saved banner absent (2)', isAppError: false },
      { success: false, reasoning: 'Saved banner absent for hunter2-secret', isAppError: false },
    ])
    const result = await executeStep('Save the form', ports({ adapter, planner, verifier, secretRedactor, plannerConfig: limits(3) }), makeStepContext())
    expect(result.status).toBe('failed')
    expect(adapter.executed).toHaveLength(3)
    // Three rejected completions, then the stop's own judgment (439 D-08).
    expect(verifier.calls).toBe(4)
    expect(result.evidence?.conditionVerdicts?.ending).toBe('limit-stop')
    const stop = result.evidence?.limitStop
    expect(stop?.lastVerifierRejection).toBe(
      'Not met: "Save the form" (Saved banner absent for [secret:FORM_SECRET])',
    )
    expect(stop?.lastPlannerReasoning).toBe('Third try with [secret:FORM_SECRET]')
    expect(stop?.lastVerifierRejection).not.toContain('hunter2-secret')
    expect(stop?.lastPlannerReasoning).not.toContain('hunter2-secret')
    expect(result.evidence?.verdictSource).toBeUndefined()
  })

  it('screen changes never refill the counter', async () => {
    const screens = Array.from({ length: 200 }, (_, i) => makeScreenState({
      tree: `[Viewport: 390x844] [2 elements]\n- textbox "Email" [ref=e1]\n- button "Log in" [ref=e2]\n- text "tick ${i}"`,
    }))
    let executes = 0
    const base = makeAdapter({ observeResults: screens })
    const adapter: PlatformAdapter = { ...base, async execute(action) { executes++; return base.execute(action) } }
    const planner = scriptedPlanner([makeActionPlan({ stepComplete: false })])
    const result = await executeStep('Keep pressing', ports({ adapter, planner, plannerConfig: limits(4) }), makeStepContext())
    expect(executes).toBe(4)
    expect(result.status).toBe('failed')
    expect(result.evidence?.limitStop).toMatchObject({ limit: 'actions', configured: 4, used: 4 })
  })

  it('without plannerConfig the schema defaults apply', async () => {
    const result = await executeStep(
      'Click Log in',
      ports({ adapter: countingAdapter(), planner: scriptedPlanner([makeActionPlan()]) }),
      makeStepContext(),
    )
    expect(result.status).toBe('passed')
    expect(result.evidence?.limitUsage?.limits).toEqual(DEFAULT_PLANNER_LIMITS)
    expect(result.evidence?.limitUsage?.actionsUsed).toBe(1)
  })

  describe('resolvePlannerLimits takes the last positive integer per key', () => {
    it('no blocks, absent planner and empty planner resolve the defaults', () => {
      expect(resolvePlannerLimits()).toEqual({ maxActions: 30, maxPlanningTurns: 30 })
      expect(resolvePlannerLimits(undefined, null, {}, { planner: {} })).toEqual(DEFAULT_PLANNER_LIMITS)
    })

    it('one key set leaves the other at its default', () => {
      expect(resolvePlannerLimits({ planner: { maxActions: 7 } })).toEqual({ maxActions: 7, maxPlanningTurns: 30 })
    })

    it('a later block overrides an earlier one per key', () => {
      expect(resolvePlannerLimits(
        { planner: { maxActions: 40, maxPlanningTurns: 45 } },
        { planner: { maxActions: 60 } },
        undefined,
      )).toEqual({ maxActions: 60, maxPlanningTurns: 45 })
    })

    it('0, -1, 2.5 and a string are ignored', () => {
      for (const bad of [0, -1, 2.5, '7', Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
        expect(resolvePlannerLimits({ planner: { maxActions: 12 } }, { planner: { maxActions: bad, maxPlanningTurns: bad } }))
          .toEqual({ maxActions: 12, maxPlanningTurns: 30 })
      }
    })

    it('the reason formatter spells both limits', () => {
      expect(formatLimitStopReason('actions', 30, 30)).toBe('Stopped: action limit reached — 30 of 30 actions used')
      expect(formatLimitStopReason('planning-turns', 30, 30)).toBe('Stopped: planning-turn limit reached — 30 of 30 planner calls used')
    })
  })
})

const UNKNOWN_REF = 'Unknown ref "e9". Available refs: e1, e2'
const REJECT: ScriptedVerdict = { success: false, reasoning: 'Not done yet', isAppError: false }
const ACCEPT: ScriptedVerdict = { success: true, reasoning: 'Done', isAppError: false }
const CACHED_LOGIN: CachedPlanValue = {
  plannedActions: [{ type: 'click' } as unknown as CacheablePlannedAction],
  groundedLocator: [{ role: 'button', name: 'Log in' }],
  verificationOutcome: 'passed',
}

function scriptedAdapter(
  results: ActionResult[],
  screen: () => ScreenState = () => makeScreenState(),
): PlatformAdapter & { executed: Action[] } {
  const executed: Action[] = []
  return {
    executed,
    platform: 'web',
    async setup() {},
    async cleanup() {},
    async observe() { return screen() },
    async execute(action: Action) {
      executed.push(action)
      return results[Math.min(executed.length - 1, results.length - 1)]
    },
  }
}

function judgingVerifier(): Verifier & { verifyCalls: number; judgeCalls: number } {
  const verifier = {
    verifyCalls: 0,
    judgeCalls: 0,
    async verify(step: string, _before: ScreenState, after: ScreenState, action: Action) {
      verifier.verifyCalls++
      return { verification: toVerificationResult(REJECT, { step, after, action }) }
    },
    async judgeClaim() {
      verifier.judgeCalls++
      return { outcome: 'judged' as const, verdict: true, rationale: 'Visible' }
    },
    async extractData() {
      verifier.judgeCalls++
      return { outcome: 'extracted' as const, fields: { title: 'Home' } }
    },
  }
  return verifier
}

function alwaysCache(value: CachedPlanValue): ActionPlanCache {
  return { async get() { return value }, async set() {}, async invalidate() {} }
}

function procedureReader(): KnowledgeHintReader {
  const id = asRecordId('proc-login')
  const flowAnchor = { t: 'flow', name: 'login' } as const
  const logIn = { role: 'button', nameNormalized: 'log in', name: 'Log in' }
  const payload: ProcedureBodyPayload = {
    schemaVersion: PROCEDURE_BODY_SCHEMA_VERSION,
    parameters: [],
    steps: [{
      instruction: 'Click the Log in button',
      action: { type: 'click', targets: { ref: logIn }, values: {} },
      guard: { target: logIn, pageAnchor: { t: 'page', route: 'https://example.test/login' } },
    }],
    successAssertion: 'Logged in',
  }
  return {
    getRunBrief: () => servedBrief({ tiers: { L0: '', L1: '', L2: '' }, lines: [], truncation: '', admissions: [] }),
    search: () => [],
    read: (recordId) => ({
      id: recordId,
      title: 'Login procedure',
      body: serializeProcedureBody(payload),
      anchors: [flowAnchor],
      evidenceDigest: 'digest',
      relations: [],
    }),
    getCautions: () => noCautions(),
    getProcedure: () => ({
      id,
      flowAnchor,
      confidence: 0.9,
      authoringModelTier: 'full',
      parameterSchema: [],
      replayRecommendation: 'replay',
    }),
    emitCanaryOutcome: () => {},
  }
}

function expectActionStop(result: Awaited<ReturnType<typeof executeStep>>, n: number): void {
  const reason = formatLimitStopReason('actions', n, n)
  // 439 D-08: with a verifier bound the stop is judged and the unproven conditions follow.
  const judged = result.evidence?.conditionVerdicts
  const unproven = judged === undefined ? '' : formatUnprovenReason(judged.conditions)
  expect(result.status).toBe('failed')
  expect(result.error).toBe(unproven === '' ? reason : `${reason} — ${unproven}`)
  if (judged !== undefined) expect(judged.ending).toBe('limit-stop')
  expect(result.evidence?.limitStop).toMatchObject({ limit: 'actions', configured: n, used: n, reason })
  expect(result.evidence?.limitUsage?.actionsUsed).toBe(n)
  expect(result.evidence?.subActions).toHaveLength(n)
}

describe('C436-ACTION-PATHS', () => {
  it('live', async () => {
    const adapter = scriptedAdapter([{ success: true }])
    const planner = scriptedPlanner([makeActionPlan({ stepComplete: false })])
    const result = await executeStep('Keep clicking', ports({ adapter, planner, plannerConfig: limits(3) }), makeStepContext())
    expectActionStop(result, 3)
    expect(adapter.executed).toHaveLength(3)
  })

  it('retry after an execution failure', async () => {
    const adapter = scriptedAdapter([{ success: false, error: 'Element is not interactable' }])
    const planner = scriptedPlanner([makeActionPlan({ stepComplete: true })])
    const result = await executeStep('Click Log in', ports({ adapter, planner, plannerConfig: limits(3) }), makeStepContext())
    expectActionStop(result, 3)
    expect(adapter.executed).toHaveLength(3)
  })

  it('recovery after a verifier rejection', async () => {
    const adapter = scriptedAdapter([{ success: true }])
    const planner = scriptedPlanner([makeActionPlan({ stepComplete: true })])
    const verifier = scriptedVerifier([REJECT])
    const result = await executeStep('Log in', ports({ adapter, planner, verifier, plannerConfig: limits(3) }), makeStepContext())
    expectActionStop(result, 3)
    expect(result.error).toBe(`${formatLimitStopReason('actions', 3, 3)} — Not met: "Log in" (Not done yet)`)
    expect(verifier.calls).toBe(4)
  })

  it('cached hits (zero planner calls)', async () => {
    const adapter = scriptedAdapter([{ success: true }])
    const planner = scriptedPlanner([makeActionPlan()])
    const result = await executeStep(
      'Click Log in',
      ports({ adapter, planner, verifier: scriptedVerifier([REJECT]), cache: alwaysCache(CACHED_LOGIN), plannerConfig: limits(3) }),
      makeStepContext(),
    )
    expectActionStop(result, 3)
    expect(planner.calls).toBe(0)
    expect(result.evidence?.limitUsage?.planningCallsUsed).toBe(0)
  })

  it('procedure replay (zero planner calls)', async () => {
    const adapter = scriptedAdapter([{ success: true }])
    const planner = scriptedPlanner([makeActionPlan()])
    const result = await executeStep(
      'Log in as the saved user',
      ports({ adapter, planner, verifier: scriptedVerifier([REJECT]), knowledgeReader: procedureReader(), plannerConfig: limits(1) }),
      makeStepContext({ testName: 'login' }),
    )
    expectActionStop(result, 1)
    expect(planner.calls).toBe(0)
    expect(result.evidence?.planSource).toMatchObject({ kind: 'procedure-replay' })
  })

  it('reportValue and uniqueValue mints', async () => {
    for (const action of [{ type: 'reportValue', value: '42' }, { type: 'uniqueValue', prefix: 'user' }]) {
      const adapter = scriptedAdapter([{ success: true }])
      const planner = scriptedPlanner([makeActionPlan({ action, stepComplete: false })])
      const result = await executeStep('Report it', ports({ adapter, planner, plannerConfig: limits(2) }), makeStepContext())
      expectActionStop(result, 2)
      expect(adapter.executed).toHaveLength(0)
    }
  })

  it('assertAI and extractAI judges', async () => {
    for (const action of [
      { type: 'assertAI', claim: 'the banner is visible', mode: 'multimodal', effort: 'medium', consensus: 1 },
      { type: 'extractAI', query: 'the page title' },
    ]) {
      const verifier = judgingVerifier()
      const planner = scriptedPlanner([makeActionPlan({ action, stepComplete: false })])
      const result = await executeStep('Judge it', ports({ adapter: scriptedAdapter([{ success: true }]), planner, verifier, plannerConfig: limits(2) }), makeStepContext())
      expectActionStop(result, 2)
      expect(verifier.judgeCalls).toBe(2)
    }
  })

  it('assertValue', async () => {
    const adapter = scriptedAdapter([{ success: true, data: 'https://example.test/home' }])
    const planner = scriptedPlanner([makeActionPlan({ action: { type: 'assertValue', source: 'url', op: 'contains', expected: 'home' }, stepComplete: false })])
    const result = await executeStep('Check the url', ports({ adapter, planner, plannerConfig: limits(2) }), makeStepContext())
    expectActionStop(result, 2)
    expect(adapter.executed).toHaveLength(2)
  })

  it('storageState', async () => {
    const adapter = scriptedAdapter([{ success: true, data: { cookies: [] } }])
    const saved: string[] = []
    const storageState = {
      async save(name: string) { saved.push(name); return { name, fingerprint: 'fp' } },
      async load() { return undefined },
    }
    const planner = scriptedPlanner([makeActionPlan({ action: { type: 'storageState', op: 'save', name: 'authed' }, stepComplete: false })])
    const result = await executeStep('Save the session', ports({ adapter, planner, storageState, plannerConfig: limits(2) }), makeStepContext())
    expectActionStop(result, 2)
    expect(saved).toEqual(['authed', 'authed'])
  })

  it('setVariable', async () => {
    const set: string[] = []
    const planner = scriptedPlanner([makeActionPlan({ action: { type: 'setVariable', name: 'ORDER_ID', value: '7' }, stepComplete: false })])
    const result = await executeStep(
      'Remember the order',
      ports({ adapter: scriptedAdapter([{ success: true }]), planner, onSetVariable: (name) => { set.push(name) }, plannerConfig: limits(2) }),
      makeStepContext(),
    )
    expectActionStop(result, 2)
    expect(set).toEqual(['ORDER_ID', 'ORDER_ID'])
  })

  it('the idempotent no-op', async () => {
    const base = makeScreenState()
    const checked = (): ScreenState => ({
      ...base,
      elements: base.elements.map((el) => el.ref === 'e1' ? { ...el, role: 'checkbox', state: { ...el.state, checked: true } } : el),
    })
    const adapter = scriptedAdapter([{ success: true }], checked)
    const planner = scriptedPlanner([makeActionPlan({ action: { type: 'tap', ref: 'e1', desiredState: 'checked' }, stepComplete: false })])
    const result = await executeStep('Ensure it is on', ports({ adapter, planner, plannerConfig: limits(2) }), makeStepContext())
    expectActionStop(result, 2)
    expect(adapter.executed).toHaveLength(0)
    const noop = result.evidence?.subActions[0]?.result
    expect(noop?.success).toBe(false)
    expect(noop?.error).toBeUndefined()
    expect(noop?.metadata?.['idempotentNoop']).toEqual({
      currentState: 'checked',
      inputSent: false,
    })
  })

  it('heal re-execution is a second debit in the same iteration', async () => {
    const adapter = scriptedAdapter([{ success: false, error: UNKNOWN_REF }, { success: true }])
    const planner = scriptedPlanner([makeActionPlan({ stepComplete: true })])
    const result = await executeStep('Click Log in', ports({ adapter, planner, plannerConfig: limits(5) }), makeStepContext())
    expect(result.status).toBe('passed')
    expect(planner.calls).toBe(1)
    expect(adapter.executed).toHaveLength(2)
    expect(result.evidence?.limitUsage).toMatchObject({ actionsUsed: 2, planningCallsUsed: 1 })
  })

  it('a heal the limit refuses is skipped and the step stops at the next loop top', async () => {
    const adapter = scriptedAdapter([{ success: false, error: UNKNOWN_REF }, { success: true }])
    const planner = scriptedPlanner([makeActionPlan({ stepComplete: true })])
    const result = await executeStep('Click Log in', ports({ adapter, planner, plannerConfig: limits(1) }), makeStepContext())
    expect(adapter.executed).toHaveLength(1)
    expect(planner.calls).toBe(1)
    expectActionStop(result, 1)
    expect(result.evidence?.subActions[0]?.result.success).toBe(false)
  })

  it('a gate-forced cache error is not debited', async () => {
    const noRefMap = (): ScreenState => ({ ...makeScreenState(), refMap: {} })
    const adapter = scriptedAdapter([{ success: true }], noRefMap)
    const planner = scriptedPlanner([makeActionPlan()])
    const result = await executeStep(
      'Click Log in',
      ports({ adapter, planner, cache: alwaysCache(CACHED_LOGIN), plannerConfig: limits(5) }),
      makeStepContext(),
    )
    expect(result.status).toBe('passed')
    expect(planner.calls).toBe(0)
    expect(adapter.executed).toHaveLength(1)
    expect(result.evidence?.limitUsage?.actionsUsed).toBe(adapter.executed.length)
  })

  it('verifier and judge calls are recorded and not debited', async () => {
    const verifier = judgingVerifier()
    let turn = 0
    const planner: Planner = {
      async plan() {
        turn++
        if (turn === 1) return { plan: makeActionPlan({ action: { type: 'assertAI', claim: 'banner', mode: 'multimodal', effort: 'medium', consensus: 1 }, stepComplete: false }) }
        if (turn === 2) return { plan: makeActionPlan({ action: { type: 'extractAI', query: 'title' }, stepComplete: false }) }
        return { plan: makeActionPlan({ stepComplete: true }) }
      },
    }
    const result = await executeStep('Check and log in', ports({ adapter: scriptedAdapter([{ success: true }]), planner, verifier, plannerConfig: limits(4) }), makeStepContext())
    // Two rejected completions, then the limit stop's own judgment (439 D-08).
    expect(verifier.verifyCalls).toBe(3)
    expect(verifier.judgeCalls).toBe(2)
    expect(result.evidence?.limitUsage).toMatchObject({
      actionsUsed: 4,
      planningCallsUsed: 4,
      verifierCalls: 3,
      judgeCalls: 2,
    })
  })

  it('compound inputs are recorded per sub-action', async () => {
    const adapter = scriptedAdapter([
      { success: true, metadata: { scrollUntilVisible: { swipes: 4, reversedOnce: false, outcome: 'found' } } },
      { success: true, metadata: { fillReread: { expected: 'a@b.test', actual: 'a@b.test' } } },
    ])
    const planner = scriptedPlanner([
      makeActionPlan({ action: { type: 'scroll', direction: 'down' }, stepComplete: false }),
      makeActionPlan({ action: { type: 'fill', ref: 'e1', value: 'a@b.test' }, stepComplete: true }),
    ])
    const result = await executeStep('Scroll and fill', ports({ adapter, planner, plannerConfig: limits(5) }), makeStepContext())
    expect(result.status).toBe('passed')
    expect(result.evidence?.limitUsage?.actionsUsed).toBe(2)
    expect(result.evidence?.limitUsage?.compoundInputs).toEqual([
      { subActionIndex: 0, kind: 'scroll', count: 4 },
      { subActionIndex: 1, kind: 'fill', count: 1 },
    ])
  })

  it('usage is monotonic across heal, cache and recovery', async () => {
    const snapshots: StepLimitUsage[] = []
    let gets = 0
    const cache: ActionPlanCache = {
      async get() { return gets++ === 0 ? CACHED_LOGIN : null },
      async set() {},
      async invalidate() {},
    }
    const adapter = scriptedAdapter([{ success: true }, { success: false, error: UNKNOWN_REF }, { success: true }])
    let turn = 0
    const planner: Planner = {
      async plan(_step, _screen, context) {
        snapshots.push((context.planningCallGate as StepLimitMeter).snapshot())
        turn++
        return { plan: makeActionPlan({ stepComplete: turn > 1 }) }
      },
    }
    const verifier = scriptedVerifier([REJECT, ACCEPT])
    const result = await executeStep('Log in', ports({ adapter, planner, verifier, cache, plannerConfig: limits(10) }), makeStepContext())
    expect(result.status).toBe('passed')
    snapshots.push(result.evidence!.limitUsage!)
    expect(snapshots.map((s) => s.actionsUsed)).toEqual([1, 3, 4])
    for (let i = 1; i < snapshots.length; i++) {
      for (const key of ['actionsUsed', 'planningCallsUsed', 'verifierCalls', 'judgeCalls'] as const) {
        expect(snapshots[i][key]).toBeGreaterThanOrEqual(snapshots[i - 1][key])
      }
    }
  })
})

const ROWS = 55

function bulkScreen(marked: ReadonlySet<string>): ScreenState {
  const base = makeScreenState()
  const elements = Array.from({ length: ROWS }, (_, i) => ({
    ...base.elements[1],
    ref: `r${i + 1}` as ScreenState['elements'][number]['ref'],
    role: 'checkbox',
    name: `Row ${i + 1}`,
    nameNormalized: `row ${i + 1}`,
    labels: {},
    state: { ...base.elements[1].state, checked: marked.has(`r${i + 1}`) },
  }))
  const refMap: ScreenState['refMap'] = {}
  for (const el of elements) refMap[el.ref] = { bounds: el.bounds!, center: el.center! }
  return {
    ...base,
    tree: [
      `[Viewport: 390x844] [${ROWS} elements]`,
      `- text "Marked: ${marked.size} of ${ROWS}"`,
      ...elements.map((el) => `- checkbox "${el.name}" [ref=${el.ref}] ${el.state.checked ? '(checked)' : ''}`),
    ].join('\n'),
    elements,
    refMap,
  }
}

function bulkTask(): { adapter: PlatformAdapter & { executed: Action[] }; planner: Planner & { calls: number }; verifier: Verifier & { calls: number } } {
  const marked = new Set<string>()
  const executed: Action[] = []
  const adapter: PlatformAdapter & { executed: Action[] } = {
    executed,
    platform: 'web',
    async setup() {},
    async cleanup() {},
    async observe() { return bulkScreen(marked) },
    async execute(action: Action) {
      executed.push(action)
      marked.add(String((action as { ref?: string }).ref))
      return { success: true }
    },
  }
  const planner = {
    calls: 0,
    async plan(_step: string, screen: ScreenState) {
      planner.calls++
      const open = screen.elements.filter((el) => el.state.checked !== true)
      return { plan: makeActionPlan({ reasoning: '', action: { type: 'click', ref: open[0].ref }, stepComplete: open.length === 1 }) }
    },
  }
  const verifier = {
    calls: 0,
    async verify(step: string, _before: ScreenState, after: ScreenState) {
      verifier.calls++
      const done = after.elements.every((el) => el.state.checked === true)
      const reasoning = done ? 'Every row is marked' : 'Rows remain'
      return { verification: scriptedVerification({ step, after, pass: done, reasoning }) }
    },
  }
  return { adapter, planner, verifier }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function slowAdapter(ms: number): PlatformAdapter & { executed: Action[] } {
  const executed: Action[] = []
  return {
    executed,
    platform: 'web',
    async setup() {},
    async cleanup() {},
    async observe() { return makeScreenState() },
    async execute(action: Action) {
      executed.push(action)
      await delay(ms)
      return { success: true }
    },
  }
}

const LARGE = { maxActions: 1000, maxPlanningTurns: 1000, previousStepCount: 0 }

describe('C436-BULK-AND-BOUNDS', () => {
  it('a 55-action bulk task completes at maxActions 60', async () => {
    const { adapter, planner, verifier } = bulkTask()
    const result = await executeStep(
      'Mark every row in the list',
      ports({ adapter, planner, verifier, plannerConfig: { maxActions: 60, maxPlanningTurns: 60, previousStepCount: 0 } }),
      makeStepContext(),
    )
    expect(result.status).toBe('passed')
    expect(adapter.executed).toHaveLength(55)
    expect(verifier.calls).toBe(1)
    expect(result.evidence?.limitStop).toBeUndefined()
    expect(result.evidence?.limitUsage).toMatchObject({
      limits: { maxActions: 60, maxPlanningTurns: 60 },
      actionsUsed: 55,
      planningCallsUsed: 55,
      verifierCalls: 1,
    })
  })

  it('the same task stops honestly at maxActions 30', async () => {
    const { adapter, planner, verifier } = bulkTask()
    const result = await executeStep(
      'Mark every row in the list',
      ports({ adapter, planner, verifier, plannerConfig: { maxActions: 30, maxPlanningTurns: 60, previousStepCount: 0 } }),
      makeStepContext(),
    )
    const reason = 'Stopped: action limit reached — 30 of 30 actions used'
    expect(result.status).toBe('failed')
    expect(adapter.executed).toHaveLength(30)
    expect(planner.calls).toBe(30)
    // The stop is judged once (439 D-08) and never counted against the limits.
    expect(verifier.calls).toBe(1)
    expect(result.evidence?.limitStop).toEqual({ limit: 'actions', configured: 30, used: 30, reason, requestedOutcome: 'unverified' })
    expect(result.evidence?.planningFailure).toBeUndefined()
    expect(result.evidence?.termination).toBeUndefined()
    expect(result.evidence?.verdictSource).toBeUndefined()
    expect(result.evidence?.conditionVerdicts?.ending).toBe('limit-stop')
    expect(result.error).toBe(`${reason} — Not met: "Mark every row in the list" (Rows remain)`)
    expect(result.error).not.toMatch(/Application error|Step failed|infeasible/)
  })

  it('when both limits are spent together the actions limit is reported', async () => {
    const adapter = scriptedAdapter([{ success: true }])
    const planner = scriptedPlanner([makeActionPlan({ stepComplete: false })])
    const result = await executeStep('Keep going', ports({ adapter, planner, plannerConfig: limits(2) }), makeStepContext())
    expect(result.evidence?.limitUsage).toMatchObject({ actionsUsed: 2, planningCallsUsed: 2 })
    expect(result.evidence?.limitStop).toMatchObject({ limit: 'actions', configured: 2, used: 2 })
    expect(result.error).toBe('Stopped: action limit reached — 2 of 2 actions used')
  })

  it('a step timeout still stops a step with a large limit', async () => {
    const planner = scriptedPlanner([makeActionPlan({ stepComplete: false })])
    const result = await executeStep(
      'Keep going',
      ports({ adapter: slowAdapter(5), planner, stepTimeout: 40, plannerConfig: LARGE }),
      makeStepContext(),
    )
    expect(result.status).toBe('failed')
    expect(result.error).toBe('Step timed out after 40ms')
    expect(result.evidence?.limitStop).toBeUndefined()
    expect(result.evidence?.limitUsage?.actionsUsed).toBeLessThan(1000)
  })

  it('a test-timeout abort and a user cancel still stop it', async () => {
    const testTimeout = new AbortController()
    setTimeout(() => testTimeout.abort(createTimeoutAbortReason('test', 30)), 30)
    const timedOut = await executeStep(
      'Keep going',
      ports({ adapter: slowAdapter(2), planner: scriptedPlanner([makeActionPlan({ stepComplete: false })]), abortSignal: testTimeout.signal, plannerConfig: LARGE }),
      makeStepContext(),
    )
    expect(timedOut.status).toBe('failed')
    expect(timedOut.error).toBe(createTimeoutAbortReason('test', 30).message)
    expect(timedOut.evidence?.limitStop).toBeUndefined()

    const cancel = new AbortController()
    setTimeout(() => cancel.abort(new Error('User cancelled')), 30)
    const cancelled = await executeStep(
      'Keep going',
      ports({ adapter: slowAdapter(2), planner: scriptedPlanner([makeActionPlan({ stepComplete: false })]), abortSignal: cancel.signal, plannerConfig: LARGE }),
      makeStepContext(),
    )
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.error).toBe('The run was cancelled before this step finished.')
    expect(cancelled.evidence?.limitStop).toBeUndefined()
  })

  it('two concurrent executeStep calls keep separate meters', async () => {
    const first = slowAdapter(1)
    const second = slowAdapter(1)
    const [a, b] = await Promise.all([
      executeStep('Keep going', ports({ adapter: first, planner: scriptedPlanner([makeActionPlan({ stepComplete: false })]), plannerConfig: limits(3) }), makeStepContext()),
      executeStep('Keep going', ports({ adapter: second, planner: scriptedPlanner([makeActionPlan({ stepComplete: false })]), plannerConfig: limits(5) }), makeStepContext()),
    ])
    expect(first.executed).toHaveLength(3)
    expect(second.executed).toHaveLength(5)
    expect(a.evidence?.limitUsage).toMatchObject({ limits: { maxActions: 3 }, actionsUsed: 3, planningCallsUsed: 3 })
    expect(b.evidence?.limitUsage).toMatchObject({ limits: { maxActions: 5 }, actionsUsed: 5, planningCallsUsed: 5 })
    expect(a.evidence?.limitStop).toMatchObject({ configured: 3, used: 3 })
    expect(b.evidence?.limitStop).toMatchObject({ configured: 5, used: 5 })
  })
})
