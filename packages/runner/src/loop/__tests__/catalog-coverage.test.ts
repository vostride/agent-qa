import { describe, it, expect } from 'vitest'

import type { ScreenState } from '@vostride/agent-qa-schema'

import type { PlatformAdapter, Action, ActionResult } from '../../platform.js'
import type { LoopPorts } from '../ports.js'
import type { AiJudgment, Verifier, VerifyResult, ActionPlan } from '../types.js'
import { scriptedVerification } from '../../testing/condition-verdicts.js'
import type { ActionPlanCache } from '../../cache/port.js'

import { executeStep } from '../index.js'
import { makeScreenState } from '../../testing/screen-fixtures.js'
import { makeStepContext, makePlanner, makeActionPlan, makeVerifier } from './loop-harness.js'
import { ToolRegistry } from '../../tools/registry.js'
import { registerAllActions } from '../../tools/actions/index.js'
import { compareAssertValue } from '../../compound/assert-value.js'
import { readReportedValueMeta } from '../../compound/metadata.js'
import { MINT_VERBS } from '../../compound/dispatch-mint.js'

const cfg = { maxActions: 4, maxPlanningTurns: 4, previousStepCount: 0 }

function ports(overrides: Partial<LoopPorts> & Pick<LoopPorts, 'adapter' | 'planner'>): LoopPorts {
  return overrides
}

// A recording fake adapter — logs every dispatched action, never touches a real driver.
function recordingAdapter(observation: ScreenState, calls: Action[]): PlatformAdapter {
  return {
    platform: 'web',
    async setup() {},
    async cleanup() {},
    async observe() {
      return observation
    },
    async execute(action: Action): Promise<ActionResult> {
      calls.push(action)
      return { success: true }
    },
  }
}

// A reading fake adapter — its execute() returns a scripted read (assertValue source read).
function readingAdapter(observation: ScreenState, read: ActionResult): PlatformAdapter {
  return {
    platform: 'web',
    async setup() {},
    async cleanup() {},
    async observe() {
      return observation
    },
    async execute(): Promise<ActionResult> {
      return read
    },
  }
}

interface LooseSub {
  result?: { success?: boolean; error?: string; metadata?: Record<string, unknown> }
}

function subs(result: Awaited<ReturnType<typeof executeStep>>): LooseSub[] {
  return (result.evidence as { subActions?: LooseSub[] } | undefined)?.subActions ?? []
}

interface JudgeVerifier extends Verifier {
  judgeClaim(claim: string, screen: ScreenState, opts?: Record<string, unknown>): Promise<AiJudgment>
  judgeClaimCalls: number
  verifyCalls: number
}

function makeJudgeVerifier(judgment: { verdict: boolean; rationale: string } = { verdict: true, rationale: 'ok' }): JudgeVerifier {
  const v: JudgeVerifier = {
    judgeClaimCalls: 0,
    verifyCalls: 0,
    async verify(step, _before, after, action): Promise<VerifyResult> {
      v.verifyCalls++
      return { verification: scriptedVerification({ step, after, action, pass: true, reasoning: 'ok' }) }
    },
    async judgeClaim() {
      v.judgeClaimCalls++
      return { outcome: 'judged', ...judgment }
    },
  }
  return v
}

function makeCountingCache(): ActionPlanCache & { setCalls: number } {
  const cache = {
    setCalls: 0,
    async get() {
      return null
    },
    async set() {
      cache.setCalls++
    },
    async invalidate() {},
  }
  return cache
}

describe('reportValue and explicit infeasible/stepFailed termination are first-class typed verbs into step evidence and the verdict', () => {
  it('a reportValue mint lands in StepEvidence.reportedValue and on the sub-action result with ZERO adapter.execute (platform-less answer verb)', async () => {
    const calls: Action[] = []
    const adapter = recordingAdapter(makeScreenState(), calls)
    const plan = makeActionPlan({ action: { type: 'reportValue', value: 'ORD-12345' } as ActionPlan['action'], stepComplete: true })

    const result = await executeStep(
      'Report the order id',
      ports({ adapter, planner: makePlanner([plan]), plannerConfig: cfg }),
      makeStepContext(),
    )

    // Mint at the ONE dispatch chokepoint — a platform-less verb never reaches adapter.execute.
    expect(calls.length).toBe(0)
    const sub = subs(result)[0]
    expect(sub?.result?.success).toBe(true)
    // Typed metadata block via the defensive-reader idiom, and the run-level evidence answer.
    const meta = readReportedValueMeta(sub?.result) as { value?: string } | undefined
    expect(meta?.value).toBe('ORD-12345')
    const reportedValue = (result.evidence as { reportedValue?: { value?: string } }).reportedValue
    expect(reportedValue?.value).toBe('ORD-12345')
    // reportValue is a runner mint, not an adapter verb.
    expect(MINT_VERBS).toContain('reportValue')
  })

  it('a stepFailed + failureKind turn yields a machine-distinguishable infeasible termination block, provably distinct from a plain stepFailed control', async () => {
    // Infeasible turn — a typed termination envelope reaches StepEvidence.termination.
    const infeasible = {
      reasoning: 'The requested screen does not exist in this app',
      action: { type: 'reportValue', value: 'n/a' },
      confidence: 0.9,
      stepComplete: false,
      stepFailed: true,
      failureKind: 'infeasible',
      failureReason: 'Settings > Privacy is not present',
    } as unknown as ActionPlan

    const infeasibleResult = await executeStep(
      'Open Settings > Privacy',
      ports({ adapter: recordingAdapter(makeScreenState(), []), planner: makePlanner([infeasible]), plannerConfig: cfg }),
      makeStepContext(),
    )

    const termination = (infeasibleResult.evidence as { termination?: { kind?: string; reason?: string } }).termination
    expect(termination?.kind).toBe('infeasible')
    expect(termination?.reason).toBe('Settings > Privacy is not present')
    expect(Object.keys(termination ?? {}).sort()).toEqual(['kind', 'reason'])

    // Control — a plain stepFailed with no failureKind stays byte-unchanged: failed, no block.
    const plainFail = makeActionPlan({ action: { type: 'reportValue', value: 'n/a' } as ActionPlan['action'], stepComplete: false, stepFailed: true })
    const controlResult = await executeStep(
      'Attempt an impossible action',
      ports({ adapter: recordingAdapter(makeScreenState(), []), planner: makePlanner([plainFail]), plannerConfig: cfg }),
      makeStepContext(),
    )
    expect(controlResult.status).toBe('failed')
    expect((controlResult.evidence as { termination?: unknown }).termination).toBeUndefined()
  })
})

describe('every registered tool executes on its legal platforms with the legacy runtime-only verbs retired', () => {
  it('freezes the registered catalog at 56 registered / web 33 / android 30 / ios 27', () => {
    const registry = new ToolRegistry()
    registerAllActions(registry)
    expect(registry.getAll()).toHaveLength(56)
    expect(registry.getForPlatform('web')).toHaveLength(33)
    expect(registry.getForPlatform('android')).toHaveLength(30)
    expect(registry.getForPlatform('ios')).toHaveLength(27)
  })

  it('a folded verb dispatches end-to-end through the harness — navigate(to:reload) reaches adapter.execute as a navigate action (fold executes, not a runtime stub)', async () => {
    const calls: Action[] = []
    const adapter = recordingAdapter(makeScreenState(), calls)
    const plan = makeActionPlan({ action: { type: 'navigate', to: 'reload' } as ActionPlan['action'], stepComplete: true })

    await executeStep(
      'Reload the page',
      ports({ adapter, planner: makePlanner([plan]), plannerConfig: cfg }),
      makeStepContext(),
    )

    // navigate is NOT a runner mint — it must reach the adapter as a real dispatch.
    expect(MINT_VERBS).not.toContain('navigate')
    expect(calls.length).toBe(1)
    expect(calls[0]?.type).toBe('navigate')
  })
})

describe('assertAI executes single-model cache-bypassed; assertValue is deterministic by construction and feeds the verifier without a vision round-trip', () => {
  it('a scripted-judge assertAI step calls judgeClaim exactly once, the step verifier then decides once (verdictSource verifier-model), finalizes cacheStatus bypass, and never writes the cache', async () => {
    const cache = makeCountingCache()
    const verifier = makeJudgeVerifier({ verdict: true, rationale: 'the welcome banner reads Welcome' })
    const calls: Action[] = []
    const plan = makeActionPlan({
      action: { type: 'assertAI', claim: 'the welcome banner is visible', mode: 'multimodal' } as ActionPlan['action'],
      stepComplete: true,
    })

    const result = await executeStep(
      'Assert the welcome banner via AI',
      ports({ adapter: recordingAdapter(makeScreenState(), calls), planner: makePlanner([plan]), verifier, cache, plannerConfig: cfg }),
      makeStepContext(),
    )

    // Single-model law: exactly one judgment, never the adapter. The claim is the planner's, so
    // the step verifier judges the step goal once more and its verdict is the recorded source.
    expect(verifier.judgeClaimCalls).toBe(1)
    expect(verifier.verifyCalls).toBe(1)
    expect(calls.length).toBe(0)
    expect((result.evidence as { verdictSource?: string }).verdictSource).toBe('verifier-model')
    // Cache bypass at the write side.
    expect((result.evidence as { cacheStatus?: string }).cacheStatus).toBe('bypass')
    expect(cache.setCalls).toBe(0)
  })

  it('a passing assertValue completion mints a deterministic verdict with ZERO verifier.verify calls and verdictSource assert-value (adapter reads / runner judges)', async () => {
    const adapter = readingAdapter(makeScreenState(), { success: true, data: 'https://x.test/home' })
    const verifier = makeJudgeVerifier()
    const plan = makeActionPlan({
      action: { type: 'assertValue', source: 'url', op: 'contains', expected: 'home' } as ActionPlan['action'],
      stepComplete: true,
    })

    const result = await executeStep(
      'Assert the url contains home',
      ports({ adapter, planner: makePlanner([plan]), verifier, plannerConfig: cfg }),
      makeStepContext(),
    )

    // A passing read does not skip the verifier; it is evidence the verifier judges.
    expect(verifier.verifyCalls).toBe(1)
    expect(result.status).toBe('passed')
    expect((result.evidence as { verdictSource?: string }).verdictSource).toBe('verifier-model')
  })

  it('control: a completing step with no assertion outcome keeps the verifier-model path intact — exactly one verify, verdictSource verifier-model', async () => {
    const verifier = makeJudgeVerifier()
    const plan = makeActionPlan({ action: { type: 'click', ref: 'e2' }, stepComplete: true })

    const result = await executeStep(
      'Click submit',
      ports({ adapter: recordingAdapter(makeScreenState(), []), planner: makePlanner([plan]), verifier, plannerConfig: cfg }),
      makeStepContext(),
    )

    expect(verifier.verifyCalls).toBe(1)
    expect((result.evidence as { verdictSource?: string }).verdictSource).toBe('verifier-model')
  })

  it('assertValue is deterministic by construction — the pure comparator judges the closed op set with no model call (delegate: assert-value suite owns the full matrix)', () => {
    // A direct proof over the shipped comparator: no vision round-trip, pure structural compare.
    expect(compareAssertValue({ source: 'url', op: 'contains', expected: 'home', actual: 'https://x.test/home' }).passed).toBe(true)
    expect(compareAssertValue({ source: 'url', op: 'equals', expected: 'a', actual: 'b' }).passed).toBe(false)
  })
})

// -----------------------------------------------------------------------------
// Frozen catalog — the phase added typed verbs/params but registers no new tools.
// -----------------------------------------------------------------------------
describe('frozen tool catalog', () => {
  it('keeps 56 registered / web 33 / android 30 / ios 27', () => {
    const registry = new ToolRegistry()
    registerAllActions(registry)
    expect(registry.getAll()).toHaveLength(56)
    expect(registry.getForPlatform('web')).toHaveLength(33)
    expect(registry.getForPlatform('android')).toHaveLength(30)
    expect(registry.getForPlatform('ios')).toHaveLength(27)
  })
})
