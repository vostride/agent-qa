import { describe, expect, it, vi } from 'vitest'
import type { LanguageModel } from 'ai'
import { asRunId, canonicalJson, guardCompletedRunHandoff, screenStateHash, sha256hex } from '@vostride/agent-qa-schema'
import type { CompletedRunHandoff, StepEvidence, RunEventEnvelope } from '@vostride/agent-qa-schema'
import { startRun } from '../shell.js'
import type { RunConfig, RunMemberDescriptor } from '../ports.js'
import { runMemberTest } from '../member-runner.js'
import { assemblePerTestOutcome } from '../handoff-assembly.js'
import { makeEmptyServedBrief } from '../../loop/evidence.js'
import { SecretRedactor, SecretStore } from '../../loop/secrets.js'
import { makeScreenState } from '../../testing/screen-fixtures.js'
import type { TestResult, StepResult } from '../../result.js'

const scope = { tier: 'test', key: 'origin fixture' } as const
const secret = 'fixture-sensitive-value'
const runId = asRunId('origin shell fixture')

function evidence(pass: boolean): StepEvidence {
  const action = {
    plan: `planned ${secret}`,
    plannedAction: { type: 'navigate', to: 'url', url: `https://example.test/${secret}` } as const,
    result: { success: pass, error: pass ? undefined : `failed ${secret}`,
      data: { captured: secret }, metadata: { detail: secret } },
    stateBefore: makeScreenState({ tree: `observed ${secret}`, timestamp: pass ? 2 : 1 }),
    exchanges: [],
  }
  return {
    stepIndex: 0, stepText: `Open ${secret}`, cacheStatus: 'miss',
    servedBrief: makeEmptyServedBrief(scope, 7),
    subActions: [action], verifierVerdict: { pass, reasoning: `verified ${secret}` },
    modelProfile: { provider: 'fixture', modelId: 'fixture-model', vision: false },
    verifierIdentity: { provider: 'fixture', modelId: 'fixture-verifier' },
    toolSchemaDigest: 'a'.repeat(64),
    ...(pass ? { selfHeal: {
      failedDecision: { ...action, result: { success: false } },
      recoveringDecision: { ...action, result: { success: true } },
    } } : {}),
  }
}

async function execute(options: {
  error?: string
  baselineProbe?: RunMemberDescriptor['baselineProbe']
  noEvidence?: boolean
  legacy?: boolean
  finalFailure?: boolean
  secondMember?: boolean
} = {}) {
  const secretRedactor = new SecretRedactor(new SecretStore({ ORIGIN_KEY: secret }))
  const planner = { plan: vi.fn() }
  const adapterExecute = vi.fn(async () => ({ success: true }))
  const events: RunEventEnvelope[] = []
  let saved = ''
  const results: TestResult[] = []
  const member = { testId: 'origin member', name: 'Origin', filePath: 'origin.yaml',
    baselineProbe: options.baselineProbe }
  const config: RunConfig = {
    runId, scope, buildOrdinal: 7, executionContext: 'ci', secretRedactor,
    configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
    members: [member, ...(options.secondMember
      ? [{ ...member, testId: 'healthy member', baselineProbe: { status: 200, elapsedMs: 1 } }]
      : [])],
    ports: { handoffStore: { async save(handoff) { saved = JSON.stringify(handoff) } } },
    executor: async (descriptor, context) => {
      let attempt = 0
      const result = await runMemberTest({ ...descriptor, steps: ['Open'],
        url: 'https://example.test', meta: { retries: 1 } }, {
        adapter: { platform: 'web', setup: async () => {}, cleanup: async () => {},
          observe: async () => makeScreenState(), execute: adapterExecute },
        planner, plannerModel: {} as LanguageModel, verifierModel: {} as LanguageModel,
        sink: context.events, testIndex: context.testIndex, abortSignal: context.abortSignal,
        executeStep: async (): Promise<StepResult> => {
          const pass = attempt++ > 0 && !options.finalFailure
          return { name: 'Open', status: pass ? 'healed' : 'failed', duration: 1,
            ...(pass ? {} : { error: options.error ?? 'an unexplained failure' }),
            ...(options.noEvidence ? {} : { evidence: evidence(pass) }) }
        },
      })
      if (options.legacy) delete result.firstFailedAttempt
      results.push(result)
      return result
    },
  }
  const session = startRun(config)
  session.subscribe(1, event => events.push(event))
  const completion = await session.done
  expect(saved).not.toBe('')
  const loaded = guardCompletedRunHandoff(JSON.parse(saved))
  expect(loaded).toEqual(JSON.parse(JSON.stringify(completion.handoff)))
  return { loaded, completion, events, results, planner, adapterExecute, secretRedactor }
}

describe('original retry handoff', () => {
  it.each([
    ['timeout', 'Test timed out after 100ms', undefined],
    ['environment', 'unexplained', { status: 503, elapsedMs: 8 }],
    ['environment', 'ECONNREFUSED fixture', undefined],
    ['unknown', 'analyze-run says timeout but has no deterministic signal', undefined],
  ] as const)('classifies actual original %s independently of the final flake', async (cls, error, baselineProbe) => {
    const f = await execute({ error, baselineProbe })
    const outcome = f.loaded.tests[0]
    expect(outcome.rerunOrigin?.rootCause?.class).toBe(cls)
    expect(outcome.rerunOrigin).toMatchObject({ attempt: 0,
      outcome: cls === 'timeout' ? 'timeout' : 'failed',
      rootCause: { producer: 'deterministic-classifier', perTest: 0 } })
    expect(outcome).toMatchObject({ outcome: 'healed', isRerun: true, rerunAttempt: 1,
      rootCause: { class: 'flake' } })
    expect(outcome.steps[0].selfHeal).toEqual(f.results[0].steps[0].evidence!.selfHeal)
    expect(f.adapterExecute).toHaveBeenCalledTimes(2)
    expect(f.planner.plan).not.toHaveBeenCalled()
    expect(f.events.filter(event => event.type === 'testStarted')).toHaveLength(1)
    expect(f.events.filter(event => event.type === 'testFinished')).toHaveLength(1)
    expect(f.events.filter(event => event.type === 'testRetryScheduled')).toHaveLength(1)
  })

  it('uses each original member baseline without borrowing another members diagnosis', async () => {
    const f = await execute({ baselineProbe: { error: `probe ${secret}`, elapsedMs: 2 }, secondMember: true })
    expect(f.loaded.tests.map(test => test.rerunOrigin?.rootCause?.class)).toEqual(['environment', 'unknown'])
    expect(f.loaded.tests.map(test => test.rerunOrigin?.rootCause?.perTest)).toEqual([0, 1])
  })

  it('masks original facts before computing truthful decision and origin identities', async () => {
    const f = await execute({ baselineProbe: { error: `probe ${secret}`, elapsedMs: 2 } })
    const origin = f.loaded.tests[0].rerunOrigin
    expect(origin).toBeDefined()
    expect(JSON.stringify(origin)).not.toContain(secret)
    expect(origin!.decisions).toHaveLength(1)
    const decision = origin!.decisions[0]
    expect(decision).toMatchObject({ runId, testId: 'origin member', testIndex: 0,
      stepIndex: 0, decisionOrdinal: 0 })
    expect(decision).not.toHaveProperty('cassetteId')
    expect(decision).not.toHaveProperty('receiptDigest')
    expect(decision.evidence.subActions[0].stateBefore.timestamp).toBe(1)
    expect(decision.screenStateHash).toBe(screenStateHash(decision.evidence.subActions[0].stateBefore))
    const { evidenceDigest, screenStateHash: _hash, ...facts } = decision
    expect(evidenceDigest).toBe(sha256hex(canonicalJson(facts)))
    const { evidenceDigest: originDigest, ...originFacts } = origin!
    expect(originDigest).toBe(sha256hex(canonicalJson(originFacts)))
    const committedOriginal = structuredClone(decision)
    // Full facts establish a join, while a same-address final attempt is different evidence.
    expect(committedOriginal.evidenceDigest).toBe(evidenceDigest)
    const finalFacts = { ...facts, evidence: f.loaded.tests[0].steps[0] }
    expect(sha256hex(canonicalJson(finalFacts))).not.toBe(evidenceDigest)
    const tampered: CompletedRunHandoff = structuredClone(f.loaded)
    tampered.tests[0].rerunOrigin!.decisions[0].decisionOrdinal = 1
    expect(() => guardCompletedRunHandoff(tampered)).toThrow()
  })

  it('retains exhausted original evidence without changing the final failed outcome', async () => {
    const f = await execute({ error: 'ECONNRESET original', finalFailure: true })
    expect(f.loaded.tests[0]).toMatchObject({ outcome: 'failed', rerunAttempt: 1,
      rootCause: { class: 'environment' }, rerunOrigin: { attempt: 0, rootCause: { class: 'environment' } } })
    expect(f.completion.verdict).toBe('failed')
  })

  it('does not synthesize decisions from failure prose or retrofit legacy retry results', async () => {
    const f = await execute({ noEvidence: true })
    expect(f.loaded.tests[0].rerunOrigin?.decisions).toEqual([])
    const legacy = await execute({ legacy: true })
    expect(legacy.loaded.tests[0]).not.toHaveProperty('rerunOrigin')
    expect(legacy.loaded.tests[0].rootCause?.class).toBe('flake')
  })

  it('assembly without shell classification cannot invent an origin verdict', async () => {
    const f = await execute()
    const assembled = assemblePerTestOutcome({ testId: 'origin member', name: 'Origin', filePath: 'origin.yaml' },
      f.results[0], 'healed', { testIndex: 0, scope, buildOrdinal: 7, mask: text => f.secretRedactor.redactString(text) })
    expect(assembled).not.toHaveProperty('rerunOrigin')
  })
})
