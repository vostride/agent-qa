// 2026-09-15, 423 D-16/D-17: the exact-input consequence preview contract over feedbackReads.
import { describe, expect, it, vi } from 'vitest'
import { SecretRedactor, SecretStore } from '@vostride/agent-qa-runner'
import { RunsMarkInputSchema, RunsMarkOutcomeSchema, RunsMarkPreviewResultSchema, asRunId } from '@vostride/agent-qa-schema'
import type { FunctionCaller, MaskFn, RunsMarkInput } from '@vostride/agent-qa-schema'
import { invokeFunction } from '../invoke.js'
import { runsMarkSpec } from '../ops/runs-mark.js'
import { RUNS_MARK_PREVIEW_FUNCTION_ID, runsMarkPreviewSpec } from '../ops/runs-mark-preview.js'
import { createRegistryFromSpecs } from '../registry.js'
import * as spec from '../spec.js'
import type { FunctionDeps, FunctionSpec } from '../spec.js'

const previewSpec = () => runsMarkPreviewSpec as unknown as FunctionSpec
const resultSchema = () => RunsMarkPreviewResultSchema
const previewModule = { RUNS_MARK_PREVIEW_FUNCTION_ID }

const runId = asRunId('run-423-mark-preview')
const member = { testIndex: 1, testId: 'checkout' }
const input: RunsMarkInput = { runId, testId: 'checkout', kind: 'false-fail', note: 'should have passed' }

function consequences(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'consequences', runId, prospective: true, markKind: 'false-fail', member,
    resolvedStep: { stepIndex: 2, reason: 'failing-step' },
    markedDecisionCount: 1,
    groundTruth: [{ testIndex: 1, stepIndex: 2, verdict: 'pass',
      recordedVerdict: { pass: false, reasoning: 'banner missing' } }],
    labels: [{ testIndex: 1, stepIndex: 2, decisionOrdinal: 0, sourceCassetteId: 'leaf-1-2-0', channel: 'user-mark',
      correction: { verdict: 'pass' } }],
    knowledge: { servedRecordIds: ['record-a'], appendsEvidence: true,
      records: [{ recordId: 'record-a', recordContent: { content: 'banner body', summary: 'banner summary', kind: 'fact',
        applicability: { product: 'storefront', scope: 'product:storefront', anchors: ['el:banner'], openedAtOrdinal: 1 },
        currentStatus: 'active', currentTrust: { confirmations: 1, contradictions: 0, evidenceTokens: ['token-a'], lastEventOrdinal: 2 } },
      served: true, evidence: { kind: 'effects', effects: [{ direction: 'confirm' }] } }],
      evidence: { confirmed: 1, overturned: 0 } },
    draft: { kind: 'knowledge', fix: 'fact', target: { grain: 'record', recordId: 'record-a' } },
    latest: { kind: 'first' },
    basis: { ledgerOrdinal: 0 },
    ...overrides,
  }
}

// 2026-09-30, 432-09 (D-11): a superseding mark replaces the prior gold case and withdraws nothing.
const SUPERSEDING = {
  latest: { kind: 'supersedes', markId: 'mark_00000000000a', ordinal: 3 },
  basis: { ledgerOrdinal: 4, priorMarkOrdinal: 3 },
}

const quarantined = (overrides: Record<string, unknown> = {}) => ({
  kind: 'quarantined', runId, prospective: true, markKind: 'false-fail', member, class: 'flake',
  resolvedStep: { stepIndex: 0, reason: 'failing-step' }, latest: { kind: 'first' }, basis: { ledgerOrdinal: 2 },
  ...overrides,
})

const alreadyMarked = (overrides: Record<string, unknown> = {}) => ({
  kind: 'already-marked', runId,
  prior: { markId: 'mark_00000000000a', ordinal: 3, kind: 'false-fail', testIndex: 1, testId: 'checkout',
    disposition: { kind: 'quarantined', class: 'flake' } },
  basis: { ledgerOrdinal: 4, priorMarkOrdinal: 3 },
  ...overrides,
})

// Hand-spelled from runs.mark's outcome union: the preview answers with exactly these refusal objects.
const REFUSALS = [
  { kind: 'run-not-found', runId },
  { kind: 'member-not-found', runId, testId: 'checkout' },
  { kind: 'step-not-found', runId, testIndex: 1, stepIndex: 9, stepCount: 3 },
  { kind: 'ambiguous-address', runId, candidates: [{ testIndex: 0, testId: 'checkout' }, { testIndex: 1, testId: 'checkout' }] },
] as const

function port(answer: unknown) {
  return { history: vi.fn(async () => { throw new Error('preview must not read history') }),
    preview: vi.fn(async (_input: RunsMarkInput) => answer) }
}

function declaredMask(secrets: Record<string, string>): MaskFn {
  const redactor = new SecretRedactor(new SecretStore(secrets))
  return text => redactor.redactString(text)
}

function deps(feedbackReads?: object, secretMask: MaskFn | null = text => text) {
  const forbidden = vi.fn(() => { throw new Error('preview must not touch runs, config or the mark writer') })
  return {
    forbidden,
    deps: {
      runs: { list: forbidden, get: forbidden, readEvents: forbidden, readStepEvidence: forbidden },
      knowledge: { listBundles: forbidden, inspectRecords: forbidden, diffSince: forbidden, showRecord: forbidden },
      entities: { resolve: forbidden, get: forbidden },
      config: { getMasked: forbidden },
      feedback: { mark: forbidden, marksFor: forbidden },
      ...(feedbackReads === undefined ? {} : { feedbackReads }),
      ...(secretMask === null ? {} : { secretMask }),
    } as unknown as FunctionDeps,
  }
}

async function previewOf(answer: unknown, raw: unknown = input, secretMask?: MaskFn | null) {
  const reads = port(answer)
  const { deps: bound, forbidden } = deps(reads, secretMask)
  const result = await previewSpec().invoke(raw, bound) as Record<string, unknown>
  expect(forbidden).not.toHaveBeenCalled()
  expect(reads.history).not.toHaveBeenCalled()
  return { result, reads }
}

describe('423-37 runs.mark.preview contract (D-16/D-17)', () => {
  it('PREVIEW-INPUT-IDENTICAL: the preview input is RunsMarkInputSchema itself and runs.mark gains no preview field', async () => {
    const op = previewSpec()
    expect(op.id).toBe('runs.mark.preview')
    expect(previewModule.RUNS_MARK_PREVIEW_FUNCTION_ID).toBe('runs.mark.preview')
    expect(op.input).toBe(RunsMarkInputSchema)
    expect(op.input).toBe(runsMarkSpec.input)

    // runs.mark's own contract is unchanged: exact input keys and exact outcome arms, no preview token.
    expect(Object.keys(RunsMarkInputSchema.shape)).toEqual(
      ['runId', 'testId', 'stepIndex', 'kind', 'note'])
    expect(RunsMarkOutcomeSchema.options.map(option => option.shape.kind.value)).toEqual(
      ['marked', 'already-marked', 'run-not-found', 'member-not-found', 'step-not-found', 'ambiguous-address'])
    for (const option of RunsMarkOutcomeSchema.options) {
      expect(Object.keys(option.shape).filter(key => /preview|basis|token|prospective/i.test(key))).toEqual([])
    }
    expect(runsMarkSpec.output).toBe(RunsMarkOutcomeSchema)

    const full: RunsMarkInput = { runId, testId: 'checkout', stepIndex: 2, kind: 'false-pass', note: 'n' }
    const { reads } = await previewOf(consequences({ markKind: 'false-pass' }), full)
    expect(reads.preview).toHaveBeenCalledTimes(1)
    expect(reads.preview.mock.calls[0]![0]).toEqual(RunsMarkInputSchema.parse(full))

    const refused = port(consequences())
    await expect(previewSpec().invoke({ ...input, previewToken: 'basis-3' }, deps(refused).deps)).rejects.toThrow()
    await expect(previewSpec().invoke({ ...input, basis: { priorMarkOrdinal: 3 } }, deps(refused).deps)).rejects.toThrow()
    expect(refused.preview).not.toHaveBeenCalled()
  })

  it('PREVIEW-REFUSAL-PARITY: every runs.mark refusal arm is the preview arm, with the same parse and classification', async () => {
    const byKind = new Map(RunsMarkOutcomeSchema.options.map(option => [option.shape.kind.value, option]))
    const previewOptions = (resultSchema() as unknown as { options: { shape: { kind: { value: string } } }[] }).options
    for (const refusal of REFUSALS) {
      expect(previewOptions.find(option => option.shape.kind.value === refusal.kind)).toBe(byKind.get(refusal.kind))
      const { result } = await previewOf(refusal)
      expect(result).toEqual(refusal)
      expect(RunsMarkOutcomeSchema.parse(result)).toEqual(result)
      expect(resultSchema().parse(result)).toEqual(result)
      expect(previewSpec().classify(result as never)).toEqual(runsMarkSpec.classify(refusal as never))
      expect(previewSpec().classify(result as never).status).toBe('refused')
    }
    // The writer's success arm is never a preview answer.
    expect(previewOptions.map(option => option.shape.kind.value)).not.toContain('marked')
    expect(resultSchema().safeParse({ kind: 'marked', receipt: {} }).success).toBe(false)
  })

  it('PREVIEW-BASIS: the prior mark ordinal is reported when present and must agree with latest-mark-wins', async () => {
    const first = await previewOf(consequences())
    expect(first.result.basis).toEqual({ ledgerOrdinal: 0 })
    expect(first.result.latest).toEqual({ kind: 'first' })

    const superseding = await previewOf(consequences(SUPERSEDING))
    expect(superseding.result.basis).toEqual({ ledgerOrdinal: 4, priorMarkOrdinal: 3 })
    expect(superseding.result.latest).toEqual({ kind: 'supersedes', markId: 'mark_00000000000a', ordinal: 3 })
    expect(superseding.result).not.toHaveProperty('withdraws')

    const repeat = await previewOf(alreadyMarked())
    expect(repeat.result).toEqual(alreadyMarked())
    expect((await previewOf(quarantined())).result.basis).toEqual({ ledgerOrdinal: 2 })

    const parse = (value: unknown) => resultSchema().safeParse(value).success
    expect(parse(consequences({ latest: SUPERSEDING.latest }))).toBe(false)
    expect(parse(consequences({ basis: SUPERSEDING.basis }))).toBe(false)
    expect(parse(consequences({ ...SUPERSEDING, basis: { ledgerOrdinal: 4, priorMarkOrdinal: 2 } }))).toBe(false)
    expect(parse(consequences({ ...SUPERSEDING, basis: { ledgerOrdinal: 2, priorMarkOrdinal: 3 } }))).toBe(false)
    expect(parse(consequences({ basis: { ledgerOrdinal: 0, priorMarkOrdinal: 0 } }))).toBe(false)
    expect(parse(consequences({ ...SUPERSEDING, withdraws: { proposalId: 'proposal-prior', proposalKind: 'knowledge' } })),
      'a preview carries no withdrawal').toBe(false)
    expect(parse(quarantined({ basis: { ledgerOrdinal: 2, priorMarkOrdinal: 1 } }))).toBe(false)
    expect(parse(alreadyMarked({ basis: { ledgerOrdinal: 4 } }))).toBe(false)
    expect(parse(alreadyMarked({ basis: { ledgerOrdinal: 4, priorMarkOrdinal: 2 } }))).toBe(false)
    expect(parse(consequences({ basis: { ledgerOrdinal: 0, previewToken: 'x' } }))).toBe(false)
  })

  it('PREVIEW-PROSPECTIVE: a read-tier op that reports what runs.mark would do, never a write, receipt or minted id', async () => {
    const op = previewSpec()
    // RE-SPELLED 2026-10-01 (432-24, D-12) from `requiredScopes` equal to ['read'].
    expect(op).not.toHaveProperty('requiredScopes')
    expect(op.resultKind).toBe('unary')
    expect(op.risk).toEqual({ name: 'fn:runs.mark.preview', recognized: true, readOnly: true })
    expect(op).not.toHaveProperty('requiresHumanOrigin')
    expect(op.boundThrough).toBe('feedbackReads')

    const falsePass = consequences({ markKind: 'false-pass', resolvedStep: { stepIndex: 2, reason: 'passing-verdict' },
      groundTruth: [{ testIndex: 1, stepIndex: 2, verdict: 'fail', recordedVerdict: { pass: true, reasoning: 'looked fine' } }],
      labels: [
        { testIndex: 1, stepIndex: 2, decisionOrdinal: 0, sourceCassetteId: 'leaf-1-2-0', channel: 'user-mark', correction: { verdict: 'fail' } },
        { testIndex: 1, stepIndex: 2, decisionOrdinal: 0, sourceCassetteId: 'leaf-1-2-0', channel: 'overturned-verdict', correction: { verdict: 'fail' } },
      ],
      draft: { kind: 'no-draftable-fix', checked: { servedRecords: 0, procedureReads: 0, assertionDrift: true } } })
    for (const answer of [consequences(), consequences(SUPERSEDING), falsePass, quarantined(),
      consequences({ markKind: 'confirmed-bug', draft: { kind: 'confirmed-bug' } }),
      consequences({ draft: { kind: 'test-edit', testRef: 'tests/checkout.yaml::checkout' } })]) {
      const { result } = await previewOf(answer)
      expect(result.prospective).toBe(true)
      expect(resultSchema().parse(result)).toEqual(result)
      const wire = JSON.stringify(result)
      for (const key of ['"receipt"', '"markedAt"', '"gold"', '"cassetteId"', '"proposalId":"proposal-new']) {
        expect(wire).not.toContain(key)
      }
      const verdict = op.classify(result as never)
      expect(verdict.status).toBe('executed')
      expect(verdict.outcome).toMatch(/^preview: /)
      expect(verdict.outcome).toMatch(/nothing written/)
      // 432-09 (D-04): a preview speaks of what runs.mark will apply, never of a draft for review.
      expect(verdict.outcome).not.toMatch(/\bdrafts?\b|\breview\b|proposal/)
    }
    const parse = (value: unknown) => resultSchema().safeParse(value).success
    expect(parse(consequences({ prospective: false }))).toBe(false)
    expect(parse(consequences({ markedAt: 1 }))).toBe(false)
    expect(parse(consequences({ receipt: {} }))).toBe(false)
    expect(parse(consequences({ draft: { kind: 'confirmed-bug' } }))).toBe(false)
    expect(parse(consequences({ markKind: 'confirmed-bug' }))).toBe(false)
    expect(parse({ ...falsePass, markKind: 'false-fail' })).toBe(false)
    expect(parse(consequences({ member: { testIndex: 0 } }))).toBe(false)

    const secret = 'synthetic-sensitive-token'
    const mask = declaredMask({ TOKEN_441: secret })
    const sensitive = consequences({ groundTruth: [{ testIndex: 1, stepIndex: 2, verdict: 'pass',
      recordedVerdict: { pass: false, reasoning: `reasoning ${secret}` } }] })
    const masked = await previewOf(sensitive, input, mask)
    expect(JSON.stringify(masked.result)).not.toContain(secret)
    expect(masked.result.groundTruth).toEqual([{ testIndex: 1, stepIndex: 2, verdict: 'pass',
      recordedVerdict: { pass: false, reasoning: mask(`reasoning ${secret}`) } }])
    // 423-19 D-17: reached-record content and overturned evidence tokens cross the same mask; ids stay structural.
    const reached = { ...falsePass, knowledge: { servedRecordIds: ['record-a'], appendsEvidence: true, evidence: { confirmed: 1, overturned: 1 },
      records: [{ recordId: 'record-a', recordContent: { content: `body ${secret}`, summary: `summary ${secret}`, kind: 'fact',
        applicability: { product: 'storefront', scope: 'product:storefront', anchors: [`el:${secret}`], openedAtOrdinal: 1 },
        currentStatus: 'active', currentTrust: { confirmations: 1, contradictions: 0, evidenceTokens: [`token ${secret}`], lastEventOrdinal: 2,
          trustNarrative: `narrative ${secret}` } },
      served: true, evidence: { kind: 'effects', effects: [{ direction: 'confirm' },
        { direction: 'overturn', overturnsEvidenceToken: `prior ${secret}`, overturnsCurationJobId: 'canary-job' }] } }] } }
    const reachedMasked = (await previewOf(reached, input, mask)).result as { knowledge: { records: Record<string, unknown>[] } }
    expect(JSON.stringify(reachedMasked)).not.toContain(secret)
    expect(reachedMasked.knowledge.records[0]).toEqual({ recordId: 'record-a', recordContent: { content: mask(`body ${secret}`),
      summary: mask(`summary ${secret}`), kind: 'fact', applicability: { product: 'storefront', scope: 'product:storefront',
        anchors: [mask(`el:${secret}`)], openedAtOrdinal: 1 }, currentStatus: 'active', currentTrust: { confirmations: 1,
        contradictions: 0, evidenceTokens: [mask(`token ${secret}`)], lastEventOrdinal: 2, trustNarrative: mask(`narrative ${secret}`) } },
    served: true, evidence: { kind: 'effects', effects: [{ direction: 'confirm' },
      { direction: 'overturn', overturnsEvidenceToken: mask(`prior ${secret}`), overturnsCurationJobId: 'canary-job' }] } })
    // A non-false-pass overturn, a missing join arm and miscounted effects are refused at parse time.
    expect(parse({ ...reached, markKind: 'false-fail', labels: [reached.labels[0]] })).toBe(false)
    expect(parse({ ...reached, knowledge: { ...reached.knowledge, evidence: { confirmed: 1, overturned: 0 } } })).toBe(false)
    const { recordContent: _content, ...unjoined } = reached.knowledge.records[0]!
    expect(parse({ ...reached, knowledge: { ...reached.knowledge, records: [unjoined] } })).toBe(false)
    await expect(previewOf(sensitive, input, null)).rejects.toThrow(/no declared-secret mask/)
    const unreadable = () => { throw new Error('synthetic unreadable secrets file') }
    await expect(previewOf(sensitive, input, unreadable)).rejects.toThrow('synthetic unreadable secrets file')

    await expect(previewSpec().invoke(input, deps(port({ kind: 'run-not-found', runId: asRunId('run-other') })).deps))
      .rejects.toThrow(/another run/)

    const reads = port(consequences())
    const { deps: bound, forbidden } = deps(reads)
    const options = { deps: bound }
    const caller: FunctionCaller = { surface: 'mcp', origin: 'agent' }
    const registry = createRegistryFromSpecs([{ ...op }], options)
    expect(registry.list(caller).find(entry => entry.id === 'runs.mark.preview')?.bindingStatus).toBe('bound')
    const viaGate = await invokeFunction(registry, 'runs.mark.preview', input, caller) as Record<string, unknown>
    expect(viaGate.kind).toBe('consequences')
    expect(forbidden).not.toHaveBeenCalled()

    const unbound = createRegistryFromSpecs([{ ...op }], { ...options, deps: deps().deps })
    await expect(invokeFunction(unbound, 'runs.mark.preview', input, caller)).rejects.toBeInstanceOf(spec.FunctionNotBoundError)
    await expect(op.invoke(input, deps({ history: vi.fn() }).deps)).rejects.toBeInstanceOf(spec.FunctionNotBoundError)
  })
})
