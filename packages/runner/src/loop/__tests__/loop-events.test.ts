// D-02 live emission + D-20 digest threading (Plan 361-08). Harness-driven pins for the
// two loop-side chokepoints: `stepFinalized` fires exactly once per step in finish() with
// the SAME evidence object attached to the StepResult; `subActionRecorded` fires once per
// recorded sub-action with the recorder's monotonic indices. Degrade-when-absent: with
// `events` unset the loop is byte-identical (no throw). D-20: `configDigests` threads into
// the cache-key material — a present digest pair changes the key the loop keys the cache on
// (proven by captured CacheKeys, not by grep).
import { describe, it, expect } from 'vitest'
import type { CacheKey, StepEvidence, SubActionEvidence } from '@vostride/agent-qa-schema'
import type { LoopPorts, LoopEventEmitPort } from '../ports.js'
import type { ActionPlanCache, CacheablePlannedAction, CachedPlanValue } from '../../cache/port.js'
import type { PlanResult, Planner } from '../types.js'
import { executeStep } from '../index.js'
import { makeActionPlan, makeAdapter, makePlanner, makeStepContext, makeVerifier } from './loop-harness.js'
import { makeScreenState } from '../../testing/screen-fixtures.js'

function ports(overrides: Partial<LoopPorts> & Pick<LoopPorts, 'adapter' | 'planner'>): LoopPorts {
  return overrides
}

type StepFinalizedExtra = Parameters<LoopEventEmitPort['stepFinalized']>[1]

function makeEventsPort(): {
  port: LoopEventEmitPort
  stepFinalized: StepEvidence[]
  extras: (StepFinalizedExtra | undefined)[]
  subActions: { evidence: SubActionEvidence; index: number }[]
} {
  const stepFinalized: StepEvidence[] = []
  const extras: (StepFinalizedExtra | undefined)[] = []
  const subActions: { evidence: SubActionEvidence; index: number }[] = []
  const port: LoopEventEmitPort = {
    stepFinalized(evidence, extra) {
      stepFinalized.push(evidence)
      extras.push(extra)
    },
    subActionRecorded(evidence, index) {
      subActions.push({ evidence, index })
    },
  }
  return { port, stepFinalized, extras, subActions }
}

// A two-sub-action scenario: the first plan does not complete the step, the second does.
function twoSubActionPorts(events?: LoopEventEmitPort): LoopPorts {
  const adapter = makeAdapter({
    observeResults: [makeScreenState(), makeScreenState(), makeScreenState()],
    executeResults: [{ success: true }, { success: true }],
  })
  const planner = makePlanner([
    makeActionPlan({ action: { type: 'click', ref: 'e1' }, stepComplete: false }),
    makeActionPlan({ action: { type: 'click', ref: 'e2' }, stepComplete: true }),
  ])
  return ports(events ? { adapter, planner, events } : { adapter, planner })
}

describe('loop live emission', () => {
  it('(a) fires exactly one stepFinalized carrying the StepResult evidence, and one subActionRecorded per sub-action with monotonic indices', async () => {
    const spy = makeEventsPort()
    const result = await executeStep('Click Log in', twoSubActionPorts(spy.port), makeStepContext())

    expect(result.status).toBe('passed')
    // stepFinalized: exactly once, with the same evidence object attached to the StepResult.
    expect(spy.stepFinalized).toHaveLength(1)
    expect(spy.stepFinalized[0]).toBe(result.evidence)

    // subActionRecorded: once per recorded sub-action, monotonic indices from 0.
    expect(spy.subActions).toHaveLength(result.evidence!.subActions.length)
    expect(spy.subActions.map(c => c.index)).toEqual([0, 1])
    for (const call of spy.subActions) {
      expect(call.evidence).toBe(result.evidence!.subActions[call.index])
    }
  })

  it('(b) with events unset the StepResult is unchanged and nothing throws (degrade-when-absent)', async () => {
    const spy = makeEventsPort()
    const withPort = await executeStep('Click Log in', twoSubActionPorts(spy.port), makeStepContext())
    const withoutPort = await executeStep('Click Log in', twoSubActionPorts(), makeStepContext())

    expect(withoutPort.status).toBe(withPort.status)
    expect(withoutPort.name).toBe(withPort.name)
    expect(withoutPort.evidence!.subActions.length).toBe(withPort.evidence!.subActions.length)
    expect(withoutPort.evidence!.stepText).toBe(withPort.evidence!.stepText)
    expect(withoutPort.evidence!.cacheStatus).toBe(withPort.evidence!.cacheStatus)
  })
})

describe('loop cache-key digest threading', () => {
  function capturingCache(): { cache: ActionPlanCache; keys: CacheKey[] } {
    const keys: CacheKey[] = []
    const cache: ActionPlanCache = {
      async get(key) {
        keys.push(key)
        return null
      },
      async set() {},
      async invalidate() {},
    }
    return { cache, keys }
  }

  // One single-sub-action step ⇒ exactly one cache.get ⇒ one captured key per run.
  async function keyFor(configDigests?: LoopPorts['configDigests']): Promise<CacheKey> {
    const { cache, keys } = capturingCache()
    const base: LoopPorts = ports({
      adapter: makeAdapter(),
      planner: makePlanner(),
      verifier: makeVerifier(),
      cache,
    })
    await executeStep('Click Log in', configDigests ? { ...base, configDigests } : base, makeStepContext())
    expect(keys).toHaveLength(1)
    return keys[0]
  }

  it('(c) a present configDigests pair changes the cache key the loop keys on; suite and test digests are each load-bearing', async () => {
    const baseline = await keyFor(undefined)
    const suiteOnly = await keyFor({ suiteConfigDigest: 'sd-1', testConfigDigest: '' })
    const testOnly = await keyFor({ suiteConfigDigest: '', testConfigDigest: 'td-1' })
    const both = await keyFor({ suiteConfigDigest: 'sd-1', testConfigDigest: 'td-1' })

    // Absent-port digests are empty strings — identical to today's key material.
    const empties = await keyFor({ suiteConfigDigest: '', testConfigDigest: '' })
    expect(empties).toBe(baseline)

    // Each digest independently perturbs the key ⇒ both thread through the mint.
    expect(both).not.toBe(baseline)
    expect(suiteOnly).not.toBe(baseline)
    expect(testOnly).not.toBe(baseline)
    expect(suiteOnly).not.toBe(testOnly)
    expect(both).not.toBe(suiteOnly)
    expect(both).not.toBe(testOnly)
  })
})

// ---- 405 D-05: the step's measured token usage rides the stepFinalized extra ------------

describe('loop tokenUsage on stepFinalized (absent is not zero)', () => {
  it('(d) a step whose planner reported usage emits tokenUsage summing prompt + completion', async () => {
    const spy = makeEventsPort()
    const planner: Planner = {
      async plan(): Promise<PlanResult> {
        return {
          plan: makeActionPlan({ action: { type: 'click', ref: 'e2' }, stepComplete: true }),
          tokenUsage: { promptTokens: 120, completionTokens: 30, totalTokens: 150 },
        }
      },
    }
    const result = await executeStep(
      'Click Log in',
      ports({ adapter: makeAdapter(), planner, events: spy.port }),
      makeStepContext(),
    )

    expect(result.status).toBe('passed')
    expect(spy.extras).toHaveLength(1)
    const usage = spy.extras[0]?.tokenUsage
    expect(usage).toBeDefined()
    expect(usage!.promptTokens).toBe(120)
    expect(usage!.completionTokens).toBe(30)
    expect(usage!.totalTokens).toBe(usage!.promptTokens + usage!.completionTokens)
  })

  it('(e) a cache-hit step made no model call, so the extra carries NO tokenUsage — never a zero triple', async () => {
    const spy = makeEventsPort()
    const cachedLogin: CachedPlanValue = {
      plannedActions: [{ type: 'click' } as unknown as CacheablePlannedAction],
      groundedLocator: [{ role: 'button', name: 'Log in' }],
      completesStep: true,
    }
    const cache: ActionPlanCache = {
      async get() { return cachedLogin },
      async set() {},
      async invalidate() {},
    }
    const plannerSpy: Planner = {
      async plan() { throw new Error('planner must not be called on a hit run') },
    }
    const result = await executeStep(
      'Click Log in',
      ports({ adapter: makeAdapter(), planner: plannerSpy, cache, events: spy.port }),
      makeStepContext(),
    )

    expect(result.status).toBe('passed')
    expect(result.evidence!.cacheStatus).toBe('hit')
    expect(spy.extras).toHaveLength(1)
    expect(spy.extras[0]).toBeDefined()
    expect(spy.extras[0]!.tokenUsage).toBeUndefined()
  })
})
