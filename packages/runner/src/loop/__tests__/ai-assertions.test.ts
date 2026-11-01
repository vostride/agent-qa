// assertAI and extractAI make one judgment or extraction per attempt through the verifier's model
// lane. A true claim continues and a false one goes back to the planner; a judgment or extraction
// the model could not make ends the step unresolved. AI steps never write the cache.
import { describe, it, expect } from 'vitest'
import type { LanguageModel } from 'ai'
import type { ScreenState, WorkingMemoryEntry } from '@vostride/agent-qa-schema'
import { stepOutcomeUnproven } from '@vostride/agent-qa-schema'
import type { PlatformAdapter, Action, ActionResult } from '../../platform.js'
import type { LoopPorts, WorkingMemoryPort } from '../ports.js'
import type { AiExtraction, AiJudgment, Planner, Verifier, VerifyResult } from '../types.js'
import { scriptedVerification } from '../../testing/condition-verdicts.js'
import type { ActionPlanCache } from '../../cache/port.js'
import { executeStep } from '../index.js'
import { makeScreenState } from '../../testing/screen-fixtures.js'
import {
  makeStepContext,
  makePlanner,
  makeActionPlan,
  makeFakeTokenAccounting,
} from './loop-harness.js'
import { readAiJudgmentMeta } from '../../compound/metadata.js'
import { LLMVerifier } from '../verifier.js'
import { SecretRedactor, SecretStore } from '../secrets.js'
import type { VerifierStepRecord } from '../step-record.js'

// ---------------------------------------------------------------------------
// Local harness helpers
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

interface FakeJudgeVerifier extends Verifier {
  judgeClaim(claim: string, screen: ScreenState, opts?: Record<string, unknown>): Promise<AiJudgment>
  extractData(...args: Parameters<NonNullable<Verifier['extractData']>>): Promise<AiExtraction>
  judgeClaimCalls: { claim: string; opts?: Record<string, unknown> }[]
  extractDataCalls: { query: string; opts: Parameters<NonNullable<Verifier['extractData']>>[2] }[]
}

function makeJudgeVerifier(opts?: {
  judgment?: AiJudgment
  extracted?: Record<string, unknown>
  verify?: VerifyResult
}): FakeJudgeVerifier {
  const judgeClaimCalls: FakeJudgeVerifier['judgeClaimCalls'] = []
  const extractDataCalls: FakeJudgeVerifier['extractDataCalls'] = []
  return {
    judgeClaimCalls,
    extractDataCalls,
    async verify(step, _before, after, action) {
      return opts?.verify ?? { verification: scriptedVerification({ step, after, action, pass: true, reasoning: 'ok' }) }
    },
    async judgeClaim(claim, _screen, o) {
      judgeClaimCalls.push({ claim, opts: o })
      return opts?.judgment ?? { outcome: 'judged', verdict: true, rationale: 'looks right' }
    },
    async extractData(query, _screen, o) {
      extractDataCalls.push({ query, opts: o })
      return { outcome: 'extracted', fields: opts?.extracted ?? {} }
    },
  }
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

function countingPlanner(plans: Parameters<typeof makePlanner>[0]): Planner & { calls: number } {
  const inner = makePlanner(plans)
  const planner = {
    calls: 0,
    async plan(...args: Parameters<Planner['plan']>) {
      planner.calls++
      return inner.plan(...args)
    },
  }
  return planner
}

type V4Model = Extract<LanguageModel, { specificationVersion: 'v4' }>

/** A model that throws the given error or answers with the given text, counting its calls. */
function syntheticModel(answer: { error: Error } | { text: string }): V4Model & { calls: number } {
  const model = {
    calls: 0,
    specificationVersion: 'v4' as const,
    provider: 'synthetic',
    modelId: 'synthetic-judge',
    supportedUrls: {},
    async doGenerate() {
      model.calls++
      if ('error' in answer) throw answer.error
      return {
        content: [{ type: 'text' as const, text: answer.text }],
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 2, text: 2, reasoning: 0 },
        },
        warnings: [],
      }
    },
    async doStream(): Promise<never> {
      throw new Error('streaming is not used by the judge lane')
    },
  }
  return model
}

/** The real LLMVerifier's judge and extract lanes beside a scripted, counting step verifier. */
function realJudgeVerifier(
  model: LanguageModel,
): Verifier & { verifyCalls: number; records: (VerifierStepRecord | undefined)[] } {
  const real = new LLMVerifier(model, makeFakeTokenAccounting())
  const verifier = {
    verifyCalls: 0,
    records: [] as (VerifierStepRecord | undefined)[],
    async verify(...args: Parameters<Verifier['verify']>): Promise<VerifyResult> {
      verifier.verifyCalls++
      verifier.records.push(args[10])
      const [step, , after, action] = args
      return {
        verification: scriptedVerification({ step, after, action, pass: true, reasoning: 'ok' }),
      }
    },
    judgeClaim: (...args: Parameters<LLMVerifier['judgeClaim']>) => real.judgeClaim(...args),
    extractData: (...args: Parameters<LLMVerifier['extractData']>) => real.extractData(...args),
  }
  return verifier
}

const cfg = { maxActions: 4, maxPlanningTurns: 4, previousStepCount: 0 }

// ---------------------------------------------------------------------------
// assertAI
// ---------------------------------------------------------------------------
describe('assertAI executes through the verifier model lane — one judgment, never the adapter', () => {
  it('routes through ports.verifier.judgeClaim exactly once and never calls adapter.execute (single-model law)', async () => {
    const calls: Action[] = []
    const adapter = recordingAdapter(makeScreenState(), calls)
    const verifier = makeJudgeVerifier({ judgment: { outcome: 'judged', verdict: true, rationale: 'the banner reads Welcome' } })
    const plan = makeActionPlan({
      action: { type: 'assertAI', claim: 'the welcome banner is visible', mode: 'multimodal' },
      stepComplete: true,
    })

    await executeStep(
      'Assert the welcome banner',
      ports({ adapter, planner: makePlanner([plan]), verifier, plannerConfig: cfg }),
      makeStepContext(),
    )

    expect(verifier.judgeClaimCalls.length).toBe(1)
    expect(calls.length).toBe(0)
  })

  it('a true judgment yields success with a metadata.aiJudgment block and StepEvidence.aiJudgment carrying verdict + rationale', async () => {
    const calls: Action[] = []
    const adapter = recordingAdapter(makeScreenState(), calls)
    const verifier = makeJudgeVerifier({ judgment: { outcome: 'judged', verdict: true, rationale: 'the banner reads Welcome' } })
    const plan = makeActionPlan({
      action: { type: 'assertAI', claim: 'the welcome banner is visible', mode: 'multimodal' },
      stepComplete: true,
    })

    const result = await executeStep(
      'Assert the welcome banner',
      ports({ adapter, planner: makePlanner([plan]), verifier, plannerConfig: cfg }),
      makeStepContext(),
    )

    expect(result.status).toBe('passed')
    const meta = readAiJudgmentMeta(subs(result)[0]?.result) as { verdict?: boolean } | undefined
    expect(meta).toBeDefined()
    const judgment = (result.evidence as { aiJudgment?: { verdict?: boolean; rationale?: string } }).aiJudgment
    expect(judgment?.verdict).toBe(true)
    expect(judgment?.rationale ?? '').toContain('Welcome')
  })

  it('a false claim is success:false with a self-correcting error carrying the model rationale, and the planner takes another turn', async () => {
    const calls: Action[] = []
    const adapter = recordingAdapter(makeScreenState(), calls)
    const verifier = makeJudgeVerifier({ judgment: { outcome: 'judged', verdict: false, rationale: 'no banner is present' } })
    const assertTurn = makeActionPlan({
      action: { type: 'assertAI', claim: 'the welcome banner is visible', mode: 'multimodal' },
      stepComplete: true,
    })
    const bailTurn = makeActionPlan({ action: { type: 'reportValue', value: 'n/a' }, stepComplete: false, stepFailed: true })
    const planner = countingPlanner([assertTurn, bailTurn])

    const result = await executeStep(
      'Assert the welcome banner',
      ports({ adapter, planner, verifier, plannerConfig: cfg }),
      makeStepContext(),
    )

    const sub = subs(result)[0]
    expect(sub?.result?.success).toBe(false)
    const err = sub?.result?.error ?? ''
    expect(err).toContain('no banner is present')
    expect(err.toLowerCase()).toMatch(/re-observe|step failed|declare/)
    expect(planner.calls).toBe(2)
  })
})

describe('an assertAI judgment the model could not make ends the step', () => {
  const step = 'Assert the welcome banner'
  const claimPlan = () =>
    makeActionPlan({
      action: { type: 'assertAI', claim: 'the welcome banner is visible', mode: 'multimodal' },
      stepComplete: true,
    })

  async function run(model: V4Model & { calls: number }, extra: Partial<LoopPorts> = {}) {
    const planner = countingPlanner([claimPlan()])
    const verifier = realJudgeVerifier(model)
    const result = await executeStep(
      step,
      ports({
        adapter: recordingAdapter(makeScreenState(), []),
        planner,
        verifier,
        plannerConfig: cfg,
        ...extra,
      }),
      makeStepContext(),
    )
    return { result, planner, verifier }
  }

  it('a failed model call ends the step at once, unresolved', async () => {
    const model = syntheticModel({ error: new Error('Overloaded') })
    const { result, planner, verifier } = await run(model)
    const sentence =
      'assertAI could not judge "the welcome banner is visible": the model call failed: Overloaded'

    expect(result.status).toBe('failed')
    expect(result.error).toBe(sentence)
    expect(result.evidence?.conditionVerdicts).toEqual({
      ending: 'unresolved',
      conditions: [{ quote: step, verdict: 'unverified', reason: sentence, citations: [] }],
    })
    expect(result.evidence?.aiJudgment).toEqual({ verb: 'assertAI', unresolved: sentence })
    expect(readAiJudgmentMeta(subs(result)[0]?.result)).toEqual({ verb: 'assertAI', unresolved: true })
    expect(stepOutcomeUnproven(result.evidence!)).toBe(true)
    expect(planner.calls).toBe(1)
    expect(verifier.verifyCalls).toBe(0)
    expect(model.calls).toBe(1)
    expect(result.evidence?.limitUsage?.judgeCalls).toBe(1)
    expect(JSON.stringify(result.evidence)).not.toContain('judged false')
  })

  it('an answer that is not a valid verdict ends the step at once, unresolved', async () => {
    const model = syntheticModel({ text: '{"verdict":"yes"}' })
    const { result, planner, verifier } = await run(model)
    const sentence =
      'assertAI could not judge "the welcome banner is visible": the model\'s answer was not a valid verdict'

    expect(result.status).toBe('failed')
    expect(result.error).toBe(sentence)
    expect(result.evidence?.conditionVerdicts).toEqual({
      ending: 'unresolved',
      conditions: [{ quote: step, verdict: 'unverified', reason: sentence, citations: [] }],
    })
    expect(result.evidence?.aiJudgment).toEqual({ verb: 'assertAI', unresolved: sentence })
    expect(stepOutcomeUnproven(result.evidence!)).toBe(true)
    expect(planner.calls).toBe(1)
    expect(verifier.verifyCalls).toBe(0)
    expect(model.calls).toBe(1)
    expect(JSON.stringify(result.evidence)).not.toContain('judged false')
  })

  it("the provider's message is masked before record", async () => {
    const model = syntheticModel({ error: new Error('401 for key sk-live-supersecret') })
    const secretStore = new SecretStore({ TOKEN: 'sk-live-supersecret' })
    const { result } = await run(model, { secretStore, secretRedactor: new SecretRedactor(secretStore) })

    expect(JSON.stringify(result)).not.toContain('supersecret')
    expect(result.evidence?.conditionVerdicts?.conditions[0]?.reason).toContain('[secret:TOKEN]')
  })
})

// ---------------------------------------------------------------------------
// extractAI
// ---------------------------------------------------------------------------
describe("assertAI's mode decides what the judge sees", () => {
  const step = 'Assert the banner'

  function screenshotAdapter(): PlatformAdapter {
    return { ...recordingAdapter(makeScreenState(), []), screenshot: async () => Buffer.from('png') }
  }

  async function run(
    mode: 'multimodal' | 'visual' | 'text',
    adapter: PlatformAdapter,
    verifier: FakeJudgeVerifier,
  ) {
    const plan = makeActionPlan({
      action: { type: 'assertAI', claim: 'the banner is green', mode },
      stepComplete: true,
    })
    return executeStep(
      step,
      ports({ adapter, planner: makePlanner([plan]), verifier, plannerConfig: cfg }),
      makeStepContext(),
    )
  }

  it('text sends the judge no image even when the gate attaches one', async () => {
    const verifier = makeJudgeVerifier()
    await run('text', screenshotAdapter(), verifier)

    expect(verifier.judgeClaimCalls).toHaveLength(1)
    expect(verifier.judgeClaimCalls[0]?.opts?.mode).toBe('text')
    expect(verifier.judgeClaimCalls[0]?.opts).not.toHaveProperty('screenshot')
  })

  it("multimodal sends the judge the planner turn's screenshot", async () => {
    const verifier = makeJudgeVerifier()
    await run('multimodal', screenshotAdapter(), verifier)

    expect(verifier.judgeClaimCalls).toHaveLength(1)
    expect(verifier.judgeClaimCalls[0]?.opts?.mode).toBe('multimodal')
    expect(verifier.judgeClaimCalls[0]?.opts?.screenshot).toEqual(Buffer.from('png'))
  })

  it('a visual claim with no screenshot ends the step without a judge call', async () => {
    const verifier = makeJudgeVerifier()
    const result = await run('visual', recordingAdapter(makeScreenState(), []), verifier)
    const sentence = 'assertAI could not judge "the banner is green": no screenshot to judge a visual claim'

    expect(verifier.judgeClaimCalls).toHaveLength(0)
    expect(result.evidence?.limitUsage?.judgeCalls).toBe(0)
    expect(result.status).toBe('failed')
    expect(result.error).toBe(sentence)
    expect(result.evidence?.conditionVerdicts).toEqual({
      ending: 'unresolved',
      conditions: [{ quote: step, verdict: 'unverified', reason: sentence, citations: [] }],
    })
  })
})

describe('extractAI extracts through the judge lane and captures run-scoped working memory', () => {
  it('extracted fields are in the result and in run-scoped working memory', async () => {
    const calls: Action[] = []
    const adapter = recordingAdapter(makeScreenState(), calls)
    const wm = recordingWorkingMemory()
    const verifier = makeJudgeVerifier({ extracted: { orderId: 'ORD-9', total: 12.5 } })
    const plan = makeActionPlan({
      action: {
        type: 'extractAI',
        query: 'extract the order id',
        schema: [
          { name: 'orderId', type: 'string', description: 'the order id shown on the receipt' },
          { name: 'total', type: 'number', description: 'the order total' },
        ],
      },
      stepComplete: true,
    })

    const result = await executeStep(
      'Extract the order id',
      ports({ adapter, planner: makePlanner([plan]), verifier, workingMemory: wm, plannerConfig: cfg }),
      makeStepContext(),
    )

    expect(result.status).toBe('passed')
    expect(verifier.extractDataCalls.length).toBe(1)
    expect(subs(result)[0]?.result?.metadata?.extracted).toEqual({ orderId: 'ORD-9', total: 12.5 })
    expect(wm.calls.length).toBe(1)
    expect(wm.calls[0]?.entries.map((entry) => [entry.key, entry.value])).toEqual([
      ['orderId', 'ORD-9'],
      ['total', '12.5'],
    ])
    const entry = wm.calls[0]?.entries[0]
    expect(entry?.kind).toBe('extracted-value')
    expect(entry?.provenance).toBe('toolResult')
  })
})

describe('extractAI returns its declared types', () => {
  const step = 'Read the order'
  const query = 'read the order'
  const orderFields = [
    { name: 'orderNumber', type: 'string', description: 'the order number' },
    { name: 'total', type: 'number', description: 'the order total' },
    { name: 'giftWrap', type: 'boolean', description: 'whether gift wrap is on' },
    { name: 'items', type: 'array', description: 'the item names', item: { type: 'string' } },
    { name: 'address', type: 'object', description: 'the delivery address' },
    { name: 'notes', type: 'string', description: 'the delivery notes' },
  ]

  async function run(model: V4Model & { calls: number }, extra: Partial<LoopPorts> = {}) {
    const planner = countingPlanner([
      makeActionPlan({
        action: { type: 'extractAI', query, schema: orderFields },
        stepComplete: true,
      }),
    ])
    const verifier = realJudgeVerifier(model)
    const workingMemory = recordingWorkingMemory()
    const result = await executeStep(
      step,
      ports({
        adapter: recordingAdapter(makeScreenState(), []),
        planner,
        verifier,
        workingMemory,
        plannerConfig: cfg,
        ...extra,
      }),
      makeStepContext(),
    )
    return { result, verifier, workingMemory }
  }

  it('typed values and nulls reach working memory and the read line as JSON text', async () => {
    const model = syntheticModel({
      text: '{"orderNumber":"A-1042","total":59.9,"giftWrap":true,"items":["Mug","Tea, loose leaf"],"address":"{\\"city\\":\\"Pune\\",\\"pin\\":\\"411001\\"}","notes":null}',
    })
    const { result, verifier, workingMemory } = await run(model)

    expect(result.status).toBe('passed')
    expect(workingMemory.calls).toHaveLength(1)
    const lines = workingMemory.calls[0]?.entries.map((entry) => `${entry.key} = ${entry.value}`)
    expect(lines).toEqual([
      'orderNumber = A-1042',
      'total = 59.9',
      'giftWrap = true',
      'items = ["Mug","Tea, loose leaf"]',
      'address = {"city":"Pune","pin":"411001"}',
      'notes = null',
    ])
    const read = verifier.records[0]?.reads.find((entry) => entry.kind === 'extractAI')
    expect(read?.text).toBe(
      '"read the order": orderNumber = A-1042, total = 59.9, giftWrap = true, items = ["Mug","Tea, loose leaf"], address = {"city":"Pune","pin":"411001"}, notes = null',
    )
    expect(subs(result)[0]?.result?.metadata?.extracted).toEqual({
      orderNumber: 'A-1042',
      total: 59.9,
      giftWrap: true,
      items: ['Mug', 'Tea, loose leaf'],
      address: { city: 'Pune', pin: '411001' },
      notes: null,
    })
  })

  it('a secret inside an extracted object is masked before record', async () => {
    const model = syntheticModel({
      text: '{"orderNumber":"A-1042","total":59.9,"giftWrap":true,"items":[],"address":"{\\"city\\":\\"sk-live-supersecret\\"}","notes":null}',
    })
    const secretStore = new SecretStore({ TOKEN: 'sk-live-supersecret' })
    const { result, workingMemory } = await run(model, {
      secretStore,
      secretRedactor: new SecretRedactor(secretStore),
    })

    expect(result.status).toBe('passed')
    const extracted = subs(result)[0]?.result?.metadata?.extracted as Record<string, unknown>
    expect(extracted.address).toEqual({ city: '[secret:TOKEN]' })
    const address = workingMemory.calls[0]?.entries.find((entry) => entry.key === 'address')
    expect(address?.value).toBe('{"city":"[secret:TOKEN]"}')
    expect(JSON.stringify(result)).not.toContain('supersecret')
  })

  it('a secret in a number field or an object key is masked before record', async () => {
    const model = syntheticModel({
      text: '{"orderNumber":"A-1042","total":4321,"giftWrap":true,"items":[],"address":"{\\"sk-live-supersecret\\":\\"Pune\\"}","notes":null}',
    })
    const secretStore = new SecretStore({ PIN: '4321', TOKEN: 'sk-live-supersecret' })
    const { result, verifier, workingMemory } = await run(model, {
      secretStore,
      secretRedactor: new SecretRedactor(secretStore),
    })

    expect(result.status).toBe('passed')
    const extracted = subs(result)[0]?.result?.metadata?.extracted as Record<string, unknown>
    expect(extracted.total).toBe('[secret:PIN]')
    expect(extracted.address).toEqual({ '[secret:TOKEN]': 'Pune' })
    expect(JSON.stringify(extracted)).not.toContain('4321')
    const values = Object.fromEntries(
      workingMemory.calls[0]?.entries.map((entry) => [entry.key, entry.value]) ?? [],
    )
    expect(values.total).toBe('[secret:PIN]')
    expect(values.address).toBe('{"[secret:TOKEN]":"Pune"}')
    const read = verifier.records[0]?.reads.find((entry) => entry.kind === 'extractAI')
    expect(read?.text).toContain('total = [secret:PIN]')
    expect(read?.text).not.toContain('4321')
    expect(JSON.stringify(result)).not.toContain('supersecret')
  })

  it('a wrongly typed extraction ends the step at once', async () => {
    const model = syntheticModel({
      text: '{"orderNumber":"A-1042","total":"59.9","giftWrap":true,"items":[],"address":null,"notes":null}',
    })
    const { result, workingMemory } = await run(model)

    expect(result.status).toBe('failed')
    expect(result.evidence?.conditionVerdicts?.ending).toBe('unresolved')
    expect(result.error).toBe(
      'extractAI could not extract "read the order": the model\'s answer did not match the declared fields',
    )
    expect(workingMemory.calls).toHaveLength(0)
  })
})

describe('an extractAI extraction the model could not make ends the step', () => {
  const step = 'Extract the order id'
  const extractPlan = () =>
    makeActionPlan({
      action: {
        type: 'extractAI',
        query: 'extract the order id',
        schema: [{ name: 'orderId', type: 'string', description: 'the order id' }],
      },
      stepComplete: true,
    })

  async function run(model: V4Model & { calls: number }) {
    const planner = countingPlanner([extractPlan()])
    const verifier = realJudgeVerifier(model)
    const workingMemory = recordingWorkingMemory()
    const result = await executeStep(
      step,
      ports({
        adapter: recordingAdapter(makeScreenState(), []),
        planner,
        verifier,
        workingMemory,
        plannerConfig: cfg,
      }),
      makeStepContext(),
    )
    return { result, planner, verifier, workingMemory }
  }

  function expectUnresolved(outcome: Awaited<ReturnType<typeof run>>, sentence: string) {
    const { result, planner, verifier, workingMemory } = outcome
    expect(result.status).toBe('failed')
    expect(result.error).toBe(sentence)
    expect(result.evidence?.conditionVerdicts).toEqual({
      ending: 'unresolved',
      conditions: [{ quote: step, verdict: 'unverified', reason: sentence, citations: [] }],
    })
    expect(result.evidence?.aiJudgment).toEqual({ verb: 'extractAI', unresolved: sentence })
    expect(readAiJudgmentMeta(subs(result)[0]?.result)).toEqual({ verb: 'extractAI', unresolved: true })
    expect(workingMemory.calls).toHaveLength(0)
    expect(verifier.verifyCalls).toBe(0)
    expect(planner.calls).toBe(1)
  }

  it('a failed model call ends the step at once and writes nothing', async () => {
    const model = syntheticModel({ error: new Error('Overloaded') })
    expectUnresolved(
      await run(model),
      'extractAI could not extract "extract the order id": the model call failed: Overloaded',
    )
    expect(model.calls).toBe(1)
  })

  it('an answer that does not match the declared fields ends the step at once', async () => {
    const model = syntheticModel({ text: '{"orderId":9}' })
    expectUnresolved(
      await run(model),
      'extractAI could not extract "extract the order id": the model\'s answer did not match the declared fields',
    )
    expect(model.calls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Cache bypass
// ---------------------------------------------------------------------------
describe('AI assertions are cache-bypassed at the write side', () => {
  it('a completing plan containing assertAI is never written (set count 0) and finalizes cacheStatus bypass; a control non-AI plan still writes', async () => {
    // AI-assertion completing plan — never written.
    const aiCache = makeCountingCache()
    const aiVerifier = makeJudgeVerifier({ judgment: { outcome: 'judged', verdict: true, rationale: 'ok' } })
    const aiPlan = makeActionPlan({
      action: { type: 'assertAI', claim: 'ok', mode: 'multimodal' },
      stepComplete: true,
    })
    const aiResult = await executeStep(
      'Assert then complete',
      ports({ adapter: recordingAdapter(makeScreenState(), []), planner: makePlanner([aiPlan]), verifier: aiVerifier, cache: aiCache, plannerConfig: cfg }),
      makeStepContext(),
    )
    expect(aiCache.setCalls).toBe(0)
    expect((aiResult.evidence as { cacheStatus?: string }).cacheStatus).toBe('bypass')

    // Control — a completing non-AI plan writes (the baseline the bypass is measured against).
    const ctlCache = makeCountingCache()
    const ctlPlan = makeActionPlan({ action: { type: 'click', ref: 'e2' }, stepComplete: true })
    await executeStep(
      'Click submit',
      ports({ adapter: recordingAdapter(makeScreenState(), []), planner: makePlanner([ctlPlan]), cache: ctlCache, plannerConfig: cfg }),
      makeStepContext(),
    )
    expect(ctlCache.setCalls).toBeGreaterThanOrEqual(1)
  })
})
