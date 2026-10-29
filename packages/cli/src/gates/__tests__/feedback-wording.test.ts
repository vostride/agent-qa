import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LOCAL_CURATION_CAPABILITIES } from '@vostride/agent-qa-agent-local'
import type { createModel } from '@vostride/agent-qa-model'
import { SecretRedactor, SecretStore } from '@vostride/agent-qa-runner'
import type { ImprovementPlan } from '@vostride/agent-qa-schema'
import { IMPROVEMENT_PLAN_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import { generateText } from 'ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../../config.js'
import * as llm from '../../llm-utils.js'
import { assertSameStructure, wordImprovementPlan, WORDING_MAX_OUTPUT_TOKENS, WORDING_TIMEOUT_MS, type WordingInput } from '../feedback-wording.js'
import { createFeedbackPortForHost } from '../feedback-host.js'
import { markFixture } from './feedback-fixture.js'

vi.mock('ai', async original => ({ ...await original<typeof import('ai')>(), generateText: vi.fn() }))

const declared = new SecretRedactor(SecretStore.fromEnvContent('PW_441=Hunter-42-zz'))
const declaredMask = (text: string) => declared.redactString(text)

describe('419 bounded feedback wording', () => {
  let root: string
  let input: WordingInput
  let model: ReturnType<typeof vi.fn<typeof createModel>>
  beforeEach(async () => {
    const f = markFixture(); root = f.root
    const member = f.handoff.tests[0]!
    const facts = LOCAL_CURATION_CAPABILITIES.readFeedbackRecord({ knowledgeRoot: f.knowledgeRoot,
      recordId: f.published.id, evidenceRef: member.steps[0]!.subActions[0]!.decisionScreenshotRef })
    if (!facts) throw new Error('fixture facts required')
    const plan = LOCAL_CURATION_CAPABILITIES.applyFeedback({ mark: { markId: 'mark_0123456789ab',
      runId: f.handoff.runId, runSlug: 'fixture', testIndex: 0, kind: 'false-fail' },
      handoff: f.handoff, resolvedStepIndex: 0, served: [facts] })
    const config = await resolveConfig({ configPath: f.configPath, loadAuthPlugins: false })
    config.registry = { llms: [{ name: 'fixture', provider: 'openai-compatible', model: 'fixture-model', vision: false, baseURL: 'http://127.0.0.1:1/v1' }] }
    config.use = { ...config.use, llm: 'fixture' }
    model = vi.fn<typeof createModel>(() => ({}) as ReturnType<typeof createModel>)
    input = { plan, config, executionContext: 'ci', mask: declaredMask,
      createModelForTest: model }
    vi.spyOn(llm, 'resolveModelAuth').mockResolvedValue({ kind: 'unauthenticated', credentialKey: 'fixture', provider: 'openai-compatible', optional: true, message: 'controlled fixture' })
    vi.mocked(generateText).mockReset()
  })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })

  it('no model config returns floor immediately with zero model, auth and masking calls', async () => {
    const mask = vi.fn(declaredMask)
    const started = performance.now()
    expect(await wordImprovementPlan({ ...input, config: undefined, mask })).toEqual(input.plan)
    const elapsed = performance.now() - started
    expect(elapsed).toBeLessThan(100)
    expect(model).not.toHaveBeenCalled()
    expect(llm.resolveModelAuth).not.toHaveBeenCalled()
    expect(mask).not.toHaveBeenCalled()
  })

  it('valid text uses one model inside the safety scope with fixed token/retry/timeout bounds', async () => {
    vi.mocked(generateText).mockImplementation(async options => {
      expect(model.mock.calls[0]![2]('pw Hunter-42-zz')).toBe('pw [secret:PW_441]')
      expect(options).toMatchObject({ maxOutputTokens: WORDING_MAX_OUTPUT_TOKENS, maxRetries: 0, temperature: 0 })
      expect(options.abortSignal).toBeInstanceOf(AbortSignal)
      return { text: JSON.stringify({ summary: 'Clarified record', body: 'Clarified evidence only.' }) } as Awaited<ReturnType<typeof generateText>>
    })
    const result = await wordImprovementPlan(input)
    expect(result).toMatchObject({ wording: 'model' })
    assertSameStructure(input.plan, result)
    expect(model).toHaveBeenCalledOnce()
    expect(generateText).toHaveBeenCalledOnce()
  })

  it.each([
    { kind: 'caution', summary: 'Changed kind', body: 'Untrusted shape' },
    { summary: 's'.repeat(161), body: 'Too long' },
    { summary: 'Fine', body: 'b'.repeat(1201) },
  ])('structural or length violation returns the original floor', async payload => {
    vi.mocked(generateText).mockResolvedValue({ text: JSON.stringify(payload) } as Awaited<ReturnType<typeof generateText>>)
    expect(await wordImprovementPlan(input)).toEqual(input.plan)
    expect(model).toHaveBeenCalledOnce()
  })

  it('model failure returns floor and does not retry', async () => {
    vi.mocked(generateText).mockRejectedValue(new Error('controlled provider failure'))
    expect(await wordImprovementPlan(input)).toEqual(input.plan)
    expect(generateText).toHaveBeenCalledOnce()
  })

  it('missing credentials or a model-construction failure preserve floor without generation', async () => {
    vi.mocked(llm.resolveModelAuth).mockResolvedValueOnce({ kind: 'missing', credentialKey: 'fixture', provider: 'openai-compatible', required: true, message: 'No fixture credential' })
    expect(await wordImprovementPlan(input)).toEqual(input.plan)
    expect(model).not.toHaveBeenCalled()
    model.mockImplementation(() => { throw new Error('controlled construction failure') })
    expect(await wordImprovementPlan(input)).toEqual(input.plan)
    expect(model).toHaveBeenCalledOnce()
    expect(generateText).not.toHaveBeenCalled()
  })

  it('a model that ignores abort still returns floor at 8 seconds', async () => {
    vi.useFakeTimers()
    vi.mocked(generateText).mockImplementation(() => new Promise(() => {}))
    const pending = wordImprovementPlan(input)
    await vi.advanceTimersByTimeAsync(WORDING_TIMEOUT_MS)
    expect(await pending).toEqual(input.plan)
    expect(vi.mocked(generateText).mock.calls[0]![0].abortSignal!.aborted).toBe(true)
  })

  it('assertSameStructure rejects target, anchor, origin and delta-count drift', () => {
    if (input.plan.kind !== 'knowledge') throw new Error('knowledge fixture required')
    const changed = structuredClone(input.plan)
    changed.target = { grain: 'record', recordId: 'foreign' }
    expect(() => assertSameStructure(input.plan, changed)).toThrow()
    const deltas = structuredClone(input.plan)
    deltas.deltas.push(deltas.deltas[0]!)
    expect(() => assertSameStructure(input.plan, deltas)).toThrow()
    const origin = structuredClone(input.plan)
    origin.deltas[0]!.origin = 'agent'
    expect(() => assertSameStructure(input.plan, origin)).toThrow()
    const anchors = structuredClone(input.plan)
    const delta = anchors.deltas[0]!
    if (delta.kind !== 'Supersede') throw new Error('supersede fixture required')
    delta.newBundle.anchors = []
    expect(() => assertSameStructure(input.plan, anchors)).toThrow()
  })

  it('words only test-edit intent and returns no-draftable-fix untouched', async () => {
    const { plan } = input
    const base = { schemaVersion: IMPROVEMENT_PLAN_SCHEMA_VERSION as typeof IMPROVEMENT_PLAN_SCHEMA_VERSION, markId: plan.markId, feedbackSource: plan.feedbackSource, runTraceRef: plan.runTraceRef }
    const edit: ImprovementPlan = { ...base, kind: 'test-edit', fix: 'test-edit', testRef: 'test.yaml::Checkout', intent: 'Fix expectation', wording: 'floor' }
    vi.mocked(generateText).mockResolvedValue({ text: '{"intent":"Correct the recorded expectation"}' } as Awaited<ReturnType<typeof generateText>>)
    const result = await wordImprovementPlan({ ...input, plan: edit })
    expect(result).toMatchObject({ intent: 'Correct the recorded expectation', wording: 'model' })
    assertSameStructure(edit, result)
    const empty: ImprovementPlan = { ...base, kind: 'no-draftable-fix', checked: { servedRecords: 0, procedureReads: 0, assertionDrift: false } }
    expect(await wordImprovementPlan({ ...input, plan: empty })).toBe(empty)
    expect(model).toHaveBeenCalledOnce()
  })
})

describe('C441-EGRESS', () => {
  let root: string | undefined
  afterEach(() => { vi.restoreAllMocks(); if (root) rmSync(root, { recursive: true, force: true }) })

  it('feedback wording sends a declared value as its named marker', async () => {
    const f = markFixture(); root = f.root
    writeFileSync(f.configPath, ['workspace:', '  testMatch: [tests/**/*.yaml]', '  suiteMatch: [suites/**/*.suite.yaml]',
      '  hooksFile: hooks.yaml', '  envFile: .env', '  secretsFile: .env.secrets.local', 'registry:', '  llms:',
      '    - name: fixture', '      provider: openai-compatible', '      model: fixture-model', '      vision: false',
      '      baseURL: http://127.0.0.1:1/v1', 'use:', '  llm: fixture', '  mobile:', '    appState: preserve', ''].join('\n'))
    writeFileSync(join(f.root, '.env.secrets.local'), 'PW_441=Hunter-42-zz\n')
    vi.spyOn(llm, 'resolveModelAuth').mockResolvedValue({ kind: 'unauthenticated', credentialKey: 'fixture', provider: 'openai-compatible', optional: true, message: 'controlled fixture' })
    const sent: string[] = []
    let modelMask: ((text: string) => string) | undefined
    const recorder = vi.fn<typeof createModel>((_profile, _auth, mask) => { modelMask = mask; return {} as ReturnType<typeof createModel> })
    vi.mocked(generateText).mockReset().mockImplementation(async options => {
      sent.push(modelMask!(String(options.prompt)))
      return { text: JSON.stringify({ summary: 'Clarified record', body: 'Clarified evidence only.' }) } as Awaited<ReturnType<typeof generateText>>
    })
    const word = vi.fn<typeof wordImprovementPlan>(async wording => {
      const plan = structuredClone(wording.plan)
      if (plan.kind === 'knowledge') for (const delta of plan.deltas) {
        const bundle = delta.kind === 'Supersede' ? delta.newBundle : delta.kind === 'Add' ? delta.bundle : undefined
        if (bundle) bundle.body = `${bundle.body} Log in with Hunter-42-zz.`
      }
      return await wordImprovementPlan({ ...wording, plan, createModelForTest: recorder })
    })
    const result = await createFeedbackPortForHost({ ...f.deps, word }).mark({ runId: f.handoff.runId, kind: 'false-fail' })

    expect(result).toMatchObject({ kind: 'marked' })
    expect(recorder).toHaveBeenCalledOnce()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('[secret:PW_441]')
    expect(sent[0]).not.toContain('Hunter-42-zz')
  })
})
