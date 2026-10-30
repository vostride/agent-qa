import { describe, it, expect } from 'vitest'
import type { BriefBlock, RecordedRetrievalRung } from '@vostride/agent-qa-schema'
import type { KnowledgeHintReader } from '../../knowledge-hint-reader.js'
import type { LoopPorts } from '../ports.js'
import type { ActionPlanCache, CacheablePlannedAction, CachedPlanValue } from '../../cache/port.js'
import type { Action } from '../../platform.js'
import type { Planner } from '../types.js'
import { executeStep } from '../index.js'
import { SecretRedactor, SecretStore } from '../secrets.js'
import { makeActionPlan, makeAdapter, makePlanner, makeStepContext, makeVerifier } from './loop-harness.js'
import { makeScreenState } from '../../testing/screen-fixtures.js'
import { noCautions, servedBrief } from './fixtures/served-trace.js'

const EMPTY_BRIEF: BriefBlock = {
  tiers: { L0: '', L1: '', L2: '' },
  lines: [],
  truncation: '',
  admissions: [],
}

function ports(overrides: Partial<LoopPorts> & Pick<LoopPorts, 'adapter' | 'planner'>): LoopPorts {
  return overrides
}

describe('loop evidence matrix', () => {
  it('every recorded sub-action carries stateBefore with non-empty elements and refMap', async () => {
    const result = await executeStep('Click Log in', ports({ adapter: makeAdapter(), planner: makePlanner() }), makeStepContext())
    const sub = result.evidence!.subActions[0]
    expect(sub.stateBefore.elements.length).toBeGreaterThan(0)
    expect(Object.keys(sub.stateBefore.refMap).length).toBeGreaterThan(0)
  })

  it('a verified sub-action gets the verifier re-observation as stateAfter', async () => {
    const before = makeScreenState({ url: 'https://example.test/before' })
    const after = makeScreenState({ url: 'https://example.test/after' })
    // Settle needs two equal reads (url is not part of screen identity), so `before` is fed twice.
    const result = await executeStep(
      'Click Log in',
      ports({ adapter: makeAdapter({ observeResults: [before, before, after] }), planner: makePlanner(), verifier: makeVerifier() }),
      makeStepContext(),
    )
    const sub = result.evidence!.subActions[0]
    expect(sub.stateAfter).toBeDefined()
    expect(sub.stateAfter?.url).toBe('https://example.test/after')
    expect(sub.stateBefore.url).toBe('https://example.test/before')
  })

  it('a failed-then-recovered pair with no saved path shares the boundary observation and records no self-heal', async () => {
    const screen1 = makeScreenState({ url: 'https://example.test/1' })
    const screen2 = makeScreenState({ url: 'https://example.test/2' })
    const adapter = makeAdapter({
      observeResults: [screen1, screen2, screen2],
      executeResults: [{ success: false, error: 'not found' }, { success: true }],
    })
    const planner = makePlanner([
      makeActionPlan({ reasoning: 'wrong', action: { type: 'click', ref: 'e1' } }),
      makeActionPlan({ reasoning: 'right', action: { type: 'click', ref: 'e2' } }),
    ])
    const result = await executeStep('Click Log in', ports({ adapter, planner }), makeStepContext())
    expect(result.status).toBe('passed')
    const [failed, recovering] = result.evidence!.subActions
    // The single boundary observation is BOTH the failed sub-action's stateAfter and the
    // recovering sub-action's stateBefore (identical-state sharing, one capture).
    expect(failed.stateAfter).toEqual(recovering.stateBefore)
    expect(failed.stateAfter?.url).toBe('https://example.test/2')
    expect(result.evidence!.selfHeal).toBeUndefined()
  })

  it('a sub-action at no boundary has no stateAfter', async () => {
    const adapter = makeAdapter({
      observeResults: [makeScreenState(), makeScreenState()],
      executeResults: [{ success: true }, { success: true }],
    })
    const planner = makePlanner([
      makeActionPlan({ action: { type: 'click', ref: 'e1' }, stepComplete: false }),
      makeActionPlan({ action: { type: 'click', ref: 'e2' }, stepComplete: true }),
    ])
    const result = await executeStep('Two steps', ports({ adapter, planner }), makeStepContext())
    expect(result.status).toBe('passed')
    expect(result.evidence!.subActions[0].stateAfter).toBeUndefined()
  })

  it('a [secret:x]-bearing plan never reaches SubActionEvidence unredacted', async () => {
    const store = new SecretStore({ PASSWORD: 'hunter2' })
    const redactor = new SecretRedactor(store)
    const planner = makePlanner([makeActionPlan({ action: { type: 'fill', ref: 'e1', value: '{{secret:PASSWORD}}' }, stepComplete: true })])
    const result = await executeStep(
      'Fill the password',
      ports({ adapter: makeAdapter(), planner, secretStore: store, secretRedactor: redactor }),
      makeStepContext(),
    )
    const stored = result.evidence!.subActions[0].plannedAction as { value?: string }
    expect(stored.value).toBe('[secret:PASSWORD]')
    expect(JSON.stringify(result.evidence)).not.toContain('hunter2')
  })

  it('a cache miss (the planner ran) folds to cacheStatus miss', async () => {
    const cache: ActionPlanCache = {
      async get() { return null },
      async set() {},
      async invalidate() {},
    }
    const planner = makePlanner([makeActionPlan({ action: { type: 'click', ref: 'e2' }, stepComplete: true })])
    const result = await executeStep(
      'One sub-action',
      ports({ adapter: makeAdapter(), planner, cache }),
      makeStepContext(),
    )
    expect(result.status).toBe('passed')
    expect(result.evidence!.cacheStatus).toBe('miss')
  })

  it('an exact-key hit re-grounds and replays — folds to cacheStatus hit, no planner', async () => {
    const cachedLogin: CachedPlanValue = {
      // Descriptor-only value: ref/coords stripped; grounding rides on the locator, which
      // re-grounds to the fresh `log in` button (e2) in the observation.
      plannedActions: [{ type: 'click' } as unknown as CacheablePlannedAction],
      groundedLocator: [{ role: 'button', name: 'Log in' }],
      completesStep: true,
    }
    const cache: ActionPlanCache = {
      async get() { return cachedLogin },
      async set() {},
      async invalidate() {},
    }
    const plannerSpy: Planner = { async plan() { throw new Error('planner must not be called on a hit run') } }
    const result = await executeStep('Click Log in', ports({ adapter: makeAdapter(), planner: plannerSpy, cache }), makeStepContext())
    expect(result.status).toBe('passed')
    expect(result.evidence!.cacheStatus).toBe('hit')
  })

  it('a step with no cache bound records its cache as disabled', async () => {
    const planner = makePlanner([makeActionPlan({ action: { type: 'click', ref: 'e2' }, stepComplete: true })])
    const result = await executeStep('One sub-action', ports({ adapter: makeAdapter(), planner }), makeStepContext())
    expect(result.status).toBe('passed')
    expect(result.evidence!.cacheStatus).toBe('disabled')
  })

  it('a step that would bypass records disabled when no cache is bound', async () => {
    const store = new SecretStore({ PASSWORD: 'hunter2' })
    const instruction = 'Type {{secret:PASSWORD}} into the password field'
    const planner = makePlanner([makeActionPlan({ action: { type: 'click', ref: 'e2' }, stepComplete: true })])
    const result = await executeStep(
      instruction,
      ports({ adapter: makeAdapter(), planner, secretStore: store, secretRedactor: new SecretRedactor(store) }),
      makeStepContext({ stepInstruction: instruction }),
    )
    expect(result.evidence!.cacheStatus).toBe('disabled')
  })
})

// The loop is handed its rung and stamps it into every step's evidence.
describe('loop retrieval rung threading', () => {
  const rung: RecordedRetrievalRung = {
    schemaVersion: 2,
    rung: 'lexical-only',
    reason: 'floor-disabled',
  }

  function knowledgeReader(): KnowledgeHintReader {
    return {
      getRunBrief: () => servedBrief(EMPTY_BRIEF),
      search: () => [],
      read: () => undefined,
      getCautions: () => noCautions(),
      getProcedure: () => undefined,
      emitCanaryOutcome: () => {},
    }
  }

  it('awaits the handed promise and stamps the rung when a reader served the step', async () => {
    const result = await executeStep(
      'Click Log in',
      ports({
        adapter: makeAdapter(),
        planner: makePlanner(),
        knowledgeReader: knowledgeReader(),
        knowledgeRetrievalRung: Promise.resolve(rung),
      }),
      makeStepContext(),
    )
    expect(result.evidence!.retrievalRung).toEqual(rung)
  })

  it('stamps NO rung when no knowledge reader is bound — no reader bound is not a rung', async () => {
    const result = await executeStep(
      'Click Log in',
      ports({
        adapter: makeAdapter(),
        planner: makePlanner(),
        knowledgeRetrievalRung: Promise.resolve(rung),
      }),
      makeStepContext(),
    )
    expect('retrievalRung' in result.evidence!).toBe(false)
  })

  it('a rejected host probe stamps nothing and never fails the step', async () => {
    const result = await executeStep(
      'Click Log in',
      ports({
        adapter: makeAdapter(),
        planner: makePlanner(),
        knowledgeReader: knowledgeReader(),
        knowledgeRetrievalRung: Promise.reject(new Error('probe failed')),
      }),
      makeStepContext(),
    )
    expect(result.status).toBe('passed')
    expect('retrievalRung' in result.evidence!).toBe(false)
  })
})
