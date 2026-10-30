import { executeStep, scriptedVerification } from '@vostride/agent-qa-runner'
import type {
  Action,
  ActionPlan,
  ActionPlanCache,
  CachedPlanValue,
  CarriedArtifacts,
  ConditionJudgment,
  ExecuteOptions,
  LoopPorts,
  PlannerConfig,
  Planner,
  PlanResult,
  PlatformAdapter,
  StepContext,
  StepResult,
  Verifier,
  VerifierStepRecord,
  VerifyResult,
} from '@vostride/agent-qa-runner'
import type {
  CacheKey,
  CitationSource,
  ConditionVerdict,
  OperationEvidence,
  Ref,
  ScreenState,
} from '@vostride/agent-qa-schema'

/** The ref of the nth element with this role and accessible name, or a thrown error. */
export function refFor(screen: ScreenState, role: string, name: string, nth = 0): Ref {
  const matches = screen.elements.filter((element) => element.role === role && element.name === name)
  const element = matches[nth]
  if (element === undefined) {
    throw new Error(`No ${role} "${name}" #${String(nth)} on the screen (found ${String(matches.length)})`)
  }
  return element.ref
}

/** One scripted planning turn: a plan computed from the screen the loop observed. */
export type ScriptedTurn = (screen: ScreenState, context: StepContext) => ActionPlan

export interface ScriptedPlanner extends Planner {
  /** Planner calls made. */
  readonly calls: number
  /** Every plan returned, in order. */
  readonly planned: readonly ActionPlan[]
  /** Plans that ask the loop to execute an action (stepFailed plans execute nothing). */
  readonly plannedActions: number
}

/** Turns are taken in order; past the end, the last turn repeats (a planner that keeps trying). */
export function scriptedPlanner(turns: readonly ScriptedTurn[]): ScriptedPlanner {
  const planned: ActionPlan[] = []
  let calls = 0
  return {
    get calls() { return calls },
    get planned() { return planned },
    get plannedActions() { return planned.filter((plan) => plan.stepFailed !== true).length },
    async plan(_step: string, screen: ScreenState, context: StepContext): Promise<PlanResult> {
      const turn = turns[Math.min(calls, turns.length - 1)]
      calls++
      const plan = turn(screen, context)
      planned.push(plan)
      return { plan }
    },
  }
}

export function act(action: ActionPlan['action'], stepComplete: boolean, reasoning: string): ActionPlan {
  return { reasoning, action, confidence: 0.9, stepComplete, stepFailed: false }
}

/** A stepFailed turn naming the missing outcome (prompt Rule 22). Nothing is executed. */
export function giveUp(reasoning: string): ActionPlan {
  return { reasoning, action: { type: 'delay', ms: 0 }, confidence: 0.9, stepComplete: false, stepFailed: true }
}

export interface VerifierInput {
  step: string
  before: ScreenState
  after: ScreenState
  action: Action
  operationEvidence?: OperationEvidence
  record?: VerifierStepRecord
}

// With `citations`, `needs`, `file` or `verdict` set, the check is one whole-step condition.
export interface VerifierVerdict {
  pass: boolean
  reason: string
  verdict?: ConditionVerdict
  citations?: { source: CitationSource; quote: string }[]
  needs?: ConditionJudgment['needs']
  file?: ConditionJudgment['file']
}

export interface ScriptedVerifier extends Verifier {
  readonly calls: number
  readonly inputs: readonly VerifierInput[]
}

export function scriptedVerifier(check: (input: VerifierInput) => VerifierVerdict): ScriptedVerifier {
  const inputs: VerifierInput[] = []
  return {
    get calls() { return inputs.length },
    get inputs() { return inputs },
    async verify(
      step, before, after, action, _screenshot, _signal, _note, _predicate, _author, operationEvidence, record,
    ): Promise<VerifyResult> {
      const input: VerifierInput = {
        step,
        before,
        after,
        action,
        ...(operationEvidence ? { operationEvidence } : {}),
        ...(record ? { record } : {}),
      }
      inputs.push(input)
      const verdict = check(input)
      const shaped = verdict.citations !== undefined || verdict.needs !== undefined
        || verdict.file !== undefined || verdict.verdict !== undefined
      if (!shaped) {
        return {
          verification: scriptedVerification({ step, after, action, pass: verdict.pass, reasoning: verdict.reason }),
        }
      }
      const base = scriptedVerification({ step, after, action, pass: verdict.pass, reasoning: verdict.reason })
      const condition = base.conditions[0]!
      return {
        verification: {
          ...base,
          conditions: [{
            ...condition,
            verdict: verdict.verdict ?? (verdict.pass ? 'met' : 'not-met'),
            ...(verdict.citations !== undefined ? { citations: verdict.citations } : {}),
            ...(verdict.needs !== undefined ? { needs: verdict.needs } : {}),
            ...(verdict.file !== undefined ? { file: verdict.file } : {}),
          }],
        },
      }
    },
  }
}

export interface MemoryCache extends ActionPlanCache {
  readonly store: Map<string, CachedPlanValue>
  readonly gets: { key: string; hit: boolean }[]
  readonly sets: string[]
}

export function memoryCache(): MemoryCache {
  const store = new Map<string, CachedPlanValue>()
  const gets: { key: string; hit: boolean }[] = []
  const sets: string[] = []
  return {
    store,
    gets,
    sets,
    async get(key: CacheKey) {
      const value = store.get(key) ?? null
      gets.push({ key, hit: value !== null })
      return value
    },
    async set(key: CacheKey, value: CachedPlanValue) {
      sets.push(key)
      store.set(key, value)
    },
    async invalidate(key: CacheKey) {
      store.delete(key)
    },
  }
}

export interface ScriptedStepRun {
  result: StepResult
  /** Every action that reached the adapter, in order. */
  executed: Action[]
}

/** Counts every adapter dispatch without changing what the adapter does. */
function countingAdapter(adapter: PlatformAdapter, executed: Action[]): PlatformAdapter {
  return new Proxy(adapter, {
    get(target, property) {
      if (property === 'execute') {
        return async (action: Action, options?: ExecuteOptions) => {
          executed.push(action)
          return target.execute(action, options)
        }
      }
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  })
}

export async function runScriptedStep(options: {
  adapter: PlatformAdapter
  instruction: string
  planner: Planner
  verifier: Verifier
  cache?: ActionPlanCache
  plannerConfig: PlannerConfig
  stepTimeout?: number
  abortSignal?: AbortSignal
  visionGate?: LoopPorts['visionGate']
  carriedArtifacts?: CarriedArtifacts
  stepNumber?: number
}): Promise<ScriptedStepRun> {
  const executed: Action[] = []
  const ports: LoopPorts = {
    adapter: countingAdapter(options.adapter, executed),
    planner: options.planner,
    verifier: options.verifier,
    plannerConfig: options.plannerConfig,
    ...(options.cache ? { cache: options.cache } : {}),
    ...(options.stepTimeout !== undefined ? { stepTimeout: options.stepTimeout } : {}),
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    ...(options.visionGate ? { visionGate: options.visionGate } : {}),
    ...(options.carriedArtifacts ? { carriedArtifacts: options.carriedArtifacts } : {}),
  }
  const context: StepContext = {
    stepInstruction: options.instruction,
    testName: 'outcome evidence',
    previousSteps: [],
    ...(options.stepNumber !== undefined ? { stepNumber: options.stepNumber } : {}),
    plannerModel: {} as StepContext['plannerModel'],
    verifierModel: {} as StepContext['verifierModel'],
  }
  const result = await executeStep(options.instruction, ports, context)
  return { result, executed }
}
