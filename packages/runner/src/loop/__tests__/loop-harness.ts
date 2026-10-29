// Shared fakes for the runner loop test suite. Framework-free helpers: the
// test files supply the it()/expect wrappers. Models a fake PlatformAdapter and a scripted
// Planner/Verifier.
import type { LanguageModel, LanguageModelUsage, ModelMessage } from 'ai'
import type { ScreenState } from '@vostride/agent-qa-schema'
import type { PlatformAdapter, Action, ActionResult } from '../../platform.js'
import { makeScreenState } from '../../testing/screen-fixtures.js'
import type {
  TokenAccounting,
  RunnerDegradeOptions,
  RunnerDegradeOutcome,
} from '../ports.js'
import type { ActionPlan, PlanResult, Planner, StepContext, Verifier } from '../types.js'
import { toVerificationResult } from '../../testing/condition-verdicts.js'
import type { ScriptedVerdict } from '../../testing/condition-verdicts.js'

export const fakeModel = {} as unknown as LanguageModel

export function makeStepContext(overrides?: Partial<StepContext>): StepContext {
  return {
    stepInstruction: 'Click the Log in button',
    testName: 'Login test',
    previousSteps: [],
    plannerModel: fakeModel,
    verifierModel: fakeModel,
    ...overrides,
  }
}

export function makeActionPlan(overrides?: Partial<ActionPlan>): ActionPlan {
  return {
    reasoning: 'Clicking the Log in button to submit the form',
    action: { type: 'click', ref: 'e2' },
    confidence: 0.95,
    stepComplete: true,
    stepFailed: false,
    ...overrides,
  }
}

export interface FakeAdapterOptions {
  observeResults?: ScreenState[]
  executeResult?: ActionResult
  executeResults?: ActionResult[]
  screenshot?: () => Promise<Buffer | undefined>
}

export function makeAdapter(options?: FakeAdapterOptions): PlatformAdapter {
  let observeCall = 0
  let executeCall = 0
  const observeResults = options?.observeResults ?? [makeScreenState()]
  const executeResults = options?.executeResults
  const singleExecute = options?.executeResult ?? { success: true }

  const adapter: PlatformAdapter = {
    platform: 'web',
    async setup() {},
    async cleanup() {},
    async observe() {
      const idx = Math.min(observeCall, observeResults.length - 1)
      observeCall++
      return observeResults[idx]
    },
    async execute(_action: Action) {
      if (executeResults) {
        const idx = Math.min(executeCall, executeResults.length - 1)
        executeCall++
        return executeResults[idx]
      }
      executeCall++
      return singleExecute
    },
  }
  if (options?.screenshot) adapter.screenshot = options.screenshot
  return adapter
}

export function makePlanner(plans?: ActionPlan[]): Planner {
  let call = 0
  const list = plans ?? [makeActionPlan()]
  return {
    async plan(): Promise<PlanResult> {
      const idx = Math.min(call, list.length - 1)
      call++
      return { plan: list[idx] }
    },
  }
}

/** Scripted verdicts in order (the last repeats); a `{ success }` entry becomes per-condition output. */
export function makeVerifier(results?: ScriptedVerdict[]): Verifier {
  let call = 0
  const list: ScriptedVerdict[] = results ?? [{ success: true, reasoning: 'Step completed', isAppError: false }]
  return {
    async verify(step, _before, after, action) {
      const idx = Math.min(call, list.length - 1)
      call++
      return { verification: toVerificationResult(list[idx], { step, after, action }) }
    },
  }
}

// ---------------------------------------------------------------------------
// Fake TokenAccounting port. A structural implementation
// of the runner `TokenAccounting` port (ports.ts:118-123), typed against the
// imported interface so any drift from the real port surface is a compile error.
// Framework-free: recordUsage / degrade invocations are captured into plain arrays
// the test files inspect with their own expect() wrappers. Scriptable ceilings,
// estimate, and degrade behavior (including the structured cannot-fit outcome).
// ---------------------------------------------------------------------------

export interface FakeTokenAccountingOptions {
  /** Model context window `C` surfaced via getCeilings(). Default 200_000. */
  contextWindow?: number
  /** Resolved model `maxOutput` (the clamp `default`) surfaced via getCeilings(). Default 8_192. */
  maxOutput?: number
  /** estimate() return — a fixed number, or a function of the messages (default: chars/4 of JSON). */
  estimate?: number | ((messages: ModelMessage[]) => number)
  /** degrade() behavior — defaults to echoing the messages back as an `ok:true` outcome. */
  degrade?: (messages: ModelMessage[], options: RunnerDegradeOptions) => RunnerDegradeOutcome
}

export interface FakeTokenAccounting extends TokenAccounting {
  /** One push per recordUsage() call — the spy surface for the D-10 feed point. */
  recordUsageCalls: { usage: LanguageModelUsage; messages: ModelMessage[] }[]
  /** One push per degrade() call — inspect the pin predicate / budget the caller passed. */
  degradeCalls: { messages: ModelMessage[]; options: RunnerDegradeOptions }[]
  /** Re-script the ceilings mid-test (e.g. simulate a mid-run overflow window shrink). */
  setCeilings(ceilings: { contextWindow: number; maxOutput: number }): void
  /** Re-script the estimate return mid-test. */
  setEstimate(estimate: number | ((messages: ModelMessage[]) => number)): void
}

export function makeFakeTokenAccounting(overrides?: FakeTokenAccountingOptions): FakeTokenAccounting {
  let ceilings = {
    contextWindow: overrides?.contextWindow ?? 200_000,
    maxOutput: overrides?.maxOutput ?? 8_192,
  }
  let estimateImpl: number | ((messages: ModelMessage[]) => number) =
    overrides?.estimate ?? ((messages) => Math.ceil(JSON.stringify(messages).length / 4))
  const degradeImpl =
    overrides?.degrade ?? ((messages: ModelMessage[]): RunnerDegradeOutcome => ({ ok: true, messages }))

  const fake: FakeTokenAccounting = {
    recordUsageCalls: [],
    degradeCalls: [],
    estimate(messages) {
      return typeof estimateImpl === 'function' ? estimateImpl(messages) : estimateImpl
    },
    recordUsage(usage, messages) {
      fake.recordUsageCalls.push({ usage, messages })
    },
    getCeilings() {
      return { ...ceilings }
    },
    degrade(messages, options) {
      fake.degradeCalls.push({ messages, options })
      return degradeImpl(messages, options)
    },
    setCeilings(next) {
      ceilings = { ...next }
    },
    setEstimate(next) {
      estimateImpl = next
    },
  }
  return fake
}
