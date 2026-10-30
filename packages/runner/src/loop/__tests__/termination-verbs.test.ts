import { describe, it, expect } from 'vitest'
import type { ScreenState, WorkingMemoryEntry } from '@vostride/agent-qa-schema'
import type { PlatformAdapter, Action, ActionResult } from '../../platform.js'
import type { LoopPorts, WorkingMemoryPort } from '../ports.js'
import type { ActionPlan } from '../types.js'
import { executeStep } from '../index.js'
import { makeScreenState } from '../../testing/screen-fixtures.js'
import { makeStepContext, makePlanner, makeActionPlan } from './loop-harness.js'
import { ToolRegistry } from '../../tools/registry.js'
import { registerAllActions } from '../../tools/actions/index.js'
import { toolCallToActionPlan } from '../../tools/builder.js'
import { SecretStore, SecretRedactor } from '../secrets.js'
import { readReportedValueMeta, readUniqueValueMeta } from '../../compound/metadata.js'

// ---------------------------------------------------------------------------
// Local harness helpers (per-file convention, mirrors idempotency.test.ts)
// ---------------------------------------------------------------------------
function ports(overrides: Partial<LoopPorts> & Pick<LoopPorts, 'adapter' | 'planner'>): LoopPorts {
  return overrides
}

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

interface LooseSub {
  result?: { success?: boolean; error?: string; metadata?: Record<string, unknown> }
}

function subs(result: Awaited<ReturnType<typeof executeStep>>): LooseSub[] {
  return (result.evidence as { subActions?: LooseSub[] } | undefined)?.subActions ?? []
}

interface CaptureCall {
  entries: readonly WorkingMemoryEntry[]
  ctx?: { test?: number; step?: number }
}

function recordingWorkingMemory(): WorkingMemoryPort & { calls: CaptureCall[] } {
  const calls: CaptureCall[] = []
  return {
    calls,
    capture(entries, ctx) {
      calls.push({ entries, ctx })
    },
    entries() {
      return []
    },
    dispose() {},
  }
}

async function importDispatchMint(): Promise<Record<string, unknown>> {
  return import(
    '../../compound/dispatch-mint.js'
  )
}

const cfg = { maxActions: 4, maxPlanningTurns: 4, previousStepCount: 0 }

describe('reportValue is a runner mint recorded as first-class evidence', () => {
  it('mints at the ONE chokepoint — zero adapter.execute — and metadata.reportedValue mirrors the emission value', async () => {
    const calls: Action[] = []
    const adapter = recordingAdapter(makeScreenState(), calls)
    const plan = makeActionPlan({ action: { type: 'reportValue', value: 'ORD-12345' }, stepComplete: true })

    const result = await executeStep(
      'Report the order id',
      ports({ adapter, planner: makePlanner([plan]), plannerConfig: cfg }),
      makeStepContext(),
    )

    // A platform-less verb never reaches `adapter.execute`.
    expect(calls.length).toBe(0)
    const sub = subs(result)[0]
    expect(sub?.result?.success).toBe(true)
    const meta = readReportedValueMeta(sub?.result) as { value?: string } | undefined
    expect(meta).toBeDefined()
    expect(meta?.value).toBe('ORD-12345')
  })

  it('the answer lands in StepEvidence.reportedValue masked-before-record — a registered secret never appears raw in serialized evidence', async () => {
    const store = new SecretStore({ TOKEN: 'sk-live-supersecret' })
    const redactor = new SecretRedactor(store)
    const calls: Action[] = []
    const adapter = recordingAdapter(makeScreenState(), calls)
    const plan = makeActionPlan({ action: { type: 'reportValue', value: '{{secret:TOKEN}}' }, stepComplete: true })

    const result = await executeStep(
      'Report the api token',
      ports({ adapter, planner: makePlanner([plan]), secretStore: store, secretRedactor: redactor, plannerConfig: cfg }),
      makeStepContext(),
    )

    const reportedValue = (result.evidence as { reportedValue?: { value?: string } }).reportedValue
    expect(reportedValue).toBeDefined()
    // masked-before-record: the raw secret must never transit evidence.
    expect(JSON.stringify(result.evidence)).not.toContain('supersecret')
    expect(reportedValue?.value ?? '').not.toContain('supersecret')
  })

  it('reportValue is non-terminal: stepComplete:false reports then continues', async () => {
    const calls: Action[] = []
    const adapter = recordingAdapter(makeScreenState(), calls)
    const reportThenContinue = makeActionPlan({ action: { type: 'reportValue', value: 'partial answer' }, stepComplete: false })
    const finish = makeActionPlan({ action: { type: 'reportValue', value: 'final answer' }, stepComplete: true })

    const result = await executeStep(
      'Report a partial value then finish',
      ports({ adapter, planner: makePlanner([reportThenContinue, finish]), plannerConfig: cfg }),
      makeStepContext(),
    )

    expect(result.status).toBe('passed')
    // And neither mint touched the adapter.
    expect(calls.length).toBe(0)
  })
})

describe('uniqueValue mints a prefixed value from an injectable generator', () => {
  it('mintUniqueValue prefixes the value and takes an injectable generator', async () => {
    const mod = await importDispatchMint()
    const mintUniqueValue = mod.mintUniqueValue as (input: { prefix: string }, gen: () => string) => ActionResult
    const res = mintUniqueValue({ prefix: 'user_' }, () => 'ZZZ')
    expect(res.success).toBe(true)
    const meta = res.metadata?.['uniqueValue'] as { value?: string; prefix?: string } | undefined
    expect(meta?.value).toBe('user_ZZZ')
    expect(meta?.value?.startsWith('user_')).toBe(true)
    expect(meta?.prefix).toBe('user_')
  })

  it('defaultUniqueValueGenerator yields distinct non-empty suffixes (uniqueness is the semantic — cache replay re-mints)', async () => {
    const mod = await importDispatchMint()
    const gen = mod.defaultUniqueValueGenerator as () => string
    const a = gen()
    const b = gen()
    expect(typeof a).toBe('string')
    expect(a.length).toBeGreaterThan(0)
    expect(a).not.toBe(b)
  })

  it('a uniqueValue action mints at the seam: zero adapter.execute, metadata.uniqueValue, and a run-scoped WM auto-write keyed by the prefix', async () => {
    const calls: Action[] = []
    const adapter = recordingAdapter(makeScreenState(), calls)
    const wm = recordingWorkingMemory()
    const plan = makeActionPlan({ action: { type: 'uniqueValue', prefix: 'user_' }, stepComplete: true })

    const result = await executeStep(
      'Generate a unique username',
      ports({ adapter, planner: makePlanner([plan]), workingMemory: wm, plannerConfig: cfg }),
      makeStepContext(),
    )

    expect(calls.length).toBe(0)
    const meta = readUniqueValueMeta(subs(result)[0]?.result) as { value?: string; prefix?: string } | undefined
    expect(meta).toBeDefined()
    expect(wm.calls.length).toBe(1)
    const entry = wm.calls[0]?.entries[0]
    expect(entry?.kind).toBe('extracted-value')
    expect(entry?.provenance).toBe('toolResult')
    expect(entry?.key ?? '').toContain('user_')
  })
})

describe('infeasible is a typed terminal outcome on the plan-field envelope', () => {
  it('toolCallToActionPlan surfaces failureKind + failureReason on the plan envelope', () => {
    const registry = new ToolRegistry()
    registerAllActions(registry)
    const plan = toolCallToActionPlan(
      'common_reportValue',
      {
        reasoning: 'The requested screen is absent in this build',
        confidence: 0.9,
        stepComplete: false,
        doesActionAdvanceUsTowardsGoal: false,
        stepFailed: true,
        failureKind: 'infeasible',
        failureReason: 'Settings > Privacy is not present',
        value: 'n/a',
      },
      registry,
    ) as { failureKind?: string; failureReason?: string }
    expect(plan.failureKind).toBe('infeasible')
    expect(plan.failureReason).toBe('Settings > Privacy is not present')
  })

  it('a stepFailed + failureKind turn produces a machine-distinguishable infeasible termination block with sorted keys ["kind","reason"]', async () => {
    const calls: Action[] = []
    const adapter = recordingAdapter(makeScreenState(), calls)
    const infeasible = {
      reasoning: 'The requested screen does not exist in this app',
      action: { type: 'reportValue', value: 'n/a' },
      confidence: 0.9,
      stepComplete: false,
      stepFailed: true,
      failureKind: 'infeasible',
      failureReason: 'Settings > Privacy is not present',
    } as unknown as ActionPlan

    const result = await executeStep(
      'Open Settings > Privacy',
      ports({ adapter, planner: makePlanner([infeasible]), plannerConfig: cfg }),
      makeStepContext(),
    )

    const termination = (result.evidence as { termination?: { kind?: string; reason?: string } }).termination
    expect(termination?.kind).toBe('infeasible')
    expect(termination?.reason).toBe('Settings > Privacy is not present')
    expect(Object.keys(termination ?? {}).sort()).toEqual(['kind', 'reason'])
  })

  it('control: a plain stepFailed with no failureKind keeps today behavior — status failed, no termination block', async () => {
    const calls: Action[] = []
    const adapter = recordingAdapter(makeScreenState(), calls)
    const plainFail = makeActionPlan({ action: { type: 'reportValue', value: 'n/a' }, stepComplete: false, stepFailed: true })

    const result = await executeStep(
      'Attempt an impossible action',
      ports({ adapter, planner: makePlanner([plainFail]), plannerConfig: cfg }),
      makeStepContext(),
    )

    expect(result.status).toBe('failed')
    expect((result.evidence as { termination?: unknown }).termination).toBeUndefined()
  })
})
