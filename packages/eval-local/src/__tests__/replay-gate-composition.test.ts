import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  GateReceiptSchema,
  receiptDigestOf,
  slugBranch,
  asRef,
  sha256hex,
  type BriefLine,
  type CompletedRunHandoff,
} from '@vostride/agent-qa-schema'
import {
  composeBaselineProfileKey,
  JUDGE_CONFIG,
  deriveSampleSeeds,
  requiredAgreement,
  computeDecisionIdentity,
  canonicalizeInputLeg,
  LABEL_RECORD_SCHEMA_VERSION,
  type StandaloneLabelRecord,
} from '@vostride/agent-qa-eval'
import { afterEach, describe, expect, it } from 'vitest'
import * as evalLocal from '../index.js'
import { resolveActiveRecordRemoval } from '../replay-gate-composition.js'
import {
  gate1Responder,
  warmGateRoot,
  writeGate1Fixture,
  judgeStub,
} from './fixtures/gate1-fixtures.js'
import {
  actionGenerateResult,
  familyStubProfile,
  judgeGenerateResult,
  respondingStub,
  noneAuth,
  stubProfile,
  type CapturedCallOptions,
} from './fixtures/replay-fixtures.js'
import { incrementingClock } from './fixtures/floor-fixtures.js'

const roots: string[] = []
function fixture(options?: Parameters<typeof writeGate1Fixture>[1]) {
  const root = mkdtempSync(join(tmpdir(), 'gate1-'))
  roots.push(root)
  return writeGate1Fixture(root, options)
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function cacheInput(f: ReturnType<typeof fixture>) {
  return {
    agentQaRoot: f.agentQaRoot,
    ...f.identity,
    gateRootSeed: 11,
    gateRootSeedSource: 'floor',
    cassettes: f.selected.map((row) => ({
      id: row.cassette.id,
      promptInputHash: row.cassette.receipt.promptInputHash,
    })),
  }
}

describe('leaf candidate earns a Gate-1 receipt', () => {
  it('exports the gate and removal cross-check composition', () => {
    expect(Reflect.get(evalLocal, 'runReplayGate')).toBeTypeOf('function')
    expect(Reflect.get(evalLocal, 'removalFlipsOutcome')).toBeTypeOf('function')
  })
  async function warm(
    options?: Parameters<typeof writeGate1Fixture>[1],
    allCorrect = false,
    baselineMisses: readonly string[] = [],
  ) {
    const f = fixture(options)
    const baseline = respondingStub((call) =>
      baselineMisses.some((key) => JSON.stringify(call.prompt).includes(key))
        ? actionGenerateResult('web', 'e-other')
        : allCorrect || JSON.stringify(call.prompt).includes('gate1-target-sibling-1')
          ? actionGenerateResult()
          : gate1Responder(f)(call),
    )
    await warmGateRoot(f, baseline)
    const stub = respondingStub(gate1Responder(f))
    const input: evalLocal.RunReplayGateInput = {
      mask: (text: string) => text,
      injection: f.injection,
      committedRoot: f.committedRoot,
      agentQaRoot: f.agentQaRoot,
      identity: f.identity,
      planner: {
        profile: stubProfile(),
        modelOverrides: { languageModels: stub.languageModels },
        resolveAuth: async () => noneAuth,
      },
      judgeOverrideConfigured: false,
      k: 3,
      kSource: 'default',
      maxScreens: 64,
      baselineSeed: { floorSeeds: [11] },
      producedBy: { opId: 'eval.replay-gate' },
      clock: incrementingClock(),
    }
    return { f, baseline, stub, input }
  }

  async function warmJudge(
    options: {
      modelId?: string
      warmWithoutJudge?: boolean
      targetTie?: boolean
      correctedTie?: boolean
      verdict?: 'equivalent' | 'different' | 'unsure'
    } = {},
  ) {
    const { f, input } = await warm()
    const profile = familyStubProfile('gpt-fixture')
    const judgeProfile = familyStubProfile(options.modelId ?? 'claude-fixture')
    const labels = new Map<string, StandaloneLabelRecord>()
    for (const { cassette } of f.selected) {
      cassette.receipt.model.declared!.modelId = 'gemini-recorded-fixture'
      if (options.targetTie && cassette.id === f.targetId) {
        const twin = {
          ...structuredClone(cassette.input.stateBefore.elements[0]!),
          ref: asRef('e-twin'),
        }
        cassette.input.stateBefore.elements.push(twin)
        cassette.input.stateBefore.refMap[asRef('e-twin')] = structuredClone(
          cassette.input.stateBefore.refMap[asRef('e-continue')]!,
        )
      }
      new evalLocal.FsCassetteStore({ root: f.root, outputDir: f.cassettesRoot }).write({
        cassette,
        blobs: [],
      })
      if (options.correctedTie && cassette.id === f.targetId) {
        const label: StandaloneLabelRecord = { schemaVersion: LABEL_RECORD_SCHEMA_VERSION, cassetteId: cassette.id,
          label: { ...cassette.label, tier: 'gold', sourceChannel: 'user-mark' },
          provenance: { runId: cassette.runId, runSlug: slugBranch(cassette.runId), capturedAtOrdinal: 1,
            receiptDigest: sha256hex(JSON.stringify(cassette.receipt)) },
          correction: { markId: 'mark_0123456789ab', verdict: 'fail',
            overturnedVerdict: { pass: true, reasoning: 'Recorded Continue click' },
            correctedExpectation: 'Corrected fill expectation stays out of planner input',
            correctedAction: { type: 'fill', ref: asRef('e-continue'), text: 'alpha beta gamma delta',
              clearMode: 'replace', submit: false } } }
        labels.set(cassette.id, label)
        new evalLocal.FsCommittedRootStore({ committedRoot: f.committedRoot })
          .writeText(evalLocal.committedLabelPath('alpha', cassette.id), JSON.stringify(label))
      }
    }
    const respond = (call: CapturedCallOptions) => {
      const text = JSON.stringify(call.prompt)
      if (options.correctedTie && text.includes('gate1-target-run')) {
        return { ...actionGenerateResult(), content: [{ type: 'tool-call' as const, toolCallId: 'replay-action',
          toolName: 'web_fill', input: JSON.stringify({ ref: 'e-continue', text: 'alpha beta epsilon zeta',
            reasoning: 'Scripted candidate fill', confidence: 0.95, stepComplete: true,
            doesActionAdvanceUsTowardsGoal: true }) }] }
      }
      return options.targetTie &&
        text.includes('gate1-target-run') &&
        !text.includes(f.injection.renderedLine)
        ? actionGenerateResult('web', 'e-twin')
        : gate1Responder(f)(call)
    }
    const baseline = respondingStub(respond, profile.model)
    const planner = respondingStub(respond, profile.model)
    let warmed = false
    const judge = judgeStub(judgeProfile.model, () =>
      !warmed && options.correctedTie ? 'equivalent'
        : !warmed && options.verdict === 'unsure' ? 'different' : (options.verdict ?? 'equivalent'),
    )
    const fingerprint = evalLocal.computeReplayProfileFingerprintFor({
      profile,
      modelOverrides: { languageModels: planner.languageModels },
      seedPolicy: 'declared',
    })
    const identity = {
      ...f.identity,
      plannerModelId: profile.model,
      judgeModelId: judgeProfile.model,
      judgeVersion: JUDGE_CONFIG.judgeVersion,
      fingerprint,
    }
    identity.profileKey = composeBaselineProfileKey(identity)
    const gateRoot = join(f.agentQaRoot, 'eval/gate', slugBranch(identity.profileKey))
    expect(
      evalLocal.writeNoiseFloorArtefact({
        artefact: { ...f.artefact, ...identity },
        committedRoot: f.committedRoot,
      }).kind,
    ).toBe('written')
    await evalLocal.replayCorpusOnce({
      selected: f.selected,
      labelRecords: labels,
      cassettesRoot: f.cassettesRoot,
      agentQaRoot: f.agentQaRoot,
      runRoot: gateRoot,
      profile,
      auth: noneAuth,
      modelOverrides: { languageModels: baseline.languageModels },
      ...(options.warmWithoutJudge
        ? {}
        : {
            judge: {
              profile: judgeProfile,
              auth: noneAuth,
              modelOverrides: { languageModels: judge.languageModels },
            },
          }),
      seed: 11,
      k: 1,
      mask: (text: string) => text,
      source: 'committed',
      corpusDigest: f.corpusDigest,
      clock: incrementingClock(),
    })
    const baselineJudgeCalls = judge.captured.length
    warmed = true
    judge.captured.length = 0
    input.identity = identity
    input.planner = {
      profile,
      resolveAuth: async () => noneAuth,
      modelOverrides: { languageModels: planner.languageModels },
    }
    input.judge = {
      profile: judgeProfile,
      resolveAuth: async () => noneAuth,
      modelOverrides: { languageModels: judge.languageModels },
    }
    return { f, input, planner, judge, baselineJudgeCalls }
  }
  it.each(['equivalent', 'different'] as const)('Gate1 retains corrected baseline and %s candidate judge results', async verdict => {
    const { f, input, planner, judge, baselineJudgeCalls } = await warmJudge({ correctedTie: true, verdict })
    const original = JSON.stringify(f.selected.find(item => item.cassette.id === f.targetId)!.cassette)
    const result = await evalLocal.runReplayGate(input)
    if (result.kind !== 'receipt') throw new Error(JSON.stringify(result))
    expect(baselineJudgeCalls).toBe(2)
    expect(judge.captured.length).toBe(2)
    const candidateRoot = join(f.agentQaRoot, evalLocal.GATE1_AUDIT_SUBDIR, slugBranch(f.injection.candidateId), 'candidate-arm', 'replays')
    const score = evalLocal.loadScoreRecord(join(candidateRoot, ...f.targetId.split('/').map(slugBranch)))
    expect(score).toMatchObject({ kind: 'loaded', record: { score: { entry: { score: {
      kind: 'scored', judgeSettled: { cause: 'value-mid-band', resolution: verdict, usage: { calls: 2 } } } } } } })
    if (verdict === 'different') {
      expect(result.receipt.verdict).toBe('fail')
      expect(result.receipt.harmed).toEqual(expect.arrayContaining([expect.objectContaining({ cassetteId: f.targetId })]))
    } else {
      expect(result.receipt.harmed ?? []).toEqual([])
      expect(result.receipt.reasons).not.toContain('collateral-unscorable')
    }
    expect(JSON.stringify(planner.captured)).not.toContain('Corrected fill expectation')
    expect(JSON.stringify(planner.captured)).not.toContain('alpha beta gamma delta')
    expect(JSON.stringify(judge.captured)).toContain('alpha beta gamma delta')
    expect(JSON.stringify(f.selected.find(item => item.cassette.id === f.targetId)!.cassette)).toBe(original)
  })
  it('formats the key-only judge identity', async () => {
    const module = await import('../replay-gate-composition.js')
    expect(Reflect.get(module, 'judgeIdOf')).toBeTypeOf('function')
    expect(
      Reflect.get(
        module,
        'judgeIdOf',
      )({ judgeModelId: 'claude-fixture', judgeFamily: 'claude', judgeVersion: 1 }),
    ).toBe('claude-fixture|family=claude|judgeVersion=1')
  })
  it.each(['different', 'unsure'] as const)(
    'ATTR-02 confirms a flip even when the target judge says %s',
    async (verdict) => {
      const { f, input, judge, planner, baselineJudgeCalls } = await warmJudge({
        targetTie: true,
        verdict,
      })
      expect(baselineJudgeCalls).toBe(2)
      const got = receipt(await evalLocal.runReplayGate(input))
      expect(got).toMatchObject({
        verdict: 'pass',
        crossCheck: 'flipped',
        judgeId: `claude-fixture|family=claude|judgeVersion=${JUDGE_CONFIG.judgeVersion}`,
        judge: { eligibility: 'eligible' },
      })
      expect(got.degradation).toBeUndefined()
      expect(judge.captured).toHaveLength(4)
      expect(got.spend!.modelCalls).toBe(planner.captured.length + judge.captured.length)
      const scorePath = join(
        f.agentQaRoot,
        'eval/gate1',
        slugBranch(f.injection.candidateId),
        'cross-check/without/sample-1/replays',
        f.targetId,
        'score.json',
      )
      const scoreText = readFileSync(scorePath, 'utf8')
      expect(scoreText).toContain(verdict === 'different' ? 'different' : 'unresolved-tie')
      expect(
        got.samples.detail?.filter((row) => !row.withRecord).every((row) => !row.matchesGold),
      ).toBe(true)
    },
  )
  it.each([
    { modelId: 'gpt-judge', overrideConfigured: true },
    { modelId: 'gpt-judge', overrideConfigured: false },
    { modelId: 'mystery-1', overrideConfigured: true },
  ])(
    'refuses $modelId with override=$overrideConfigured without judge calls',
    async ({ modelId, overrideConfigured }) => {
      const { input, judge } = await warmJudge({ modelId })
      input.judgeOverrideConfigured = overrideConfigured
      const got = receipt(await evalLocal.runReplayGate(input))
      expect(got).toMatchObject({
        verdict: 'pass',
        degradation: 'replay-diff',
        judge: { eligibility: 'no-eligible-judge', overrideConfigured },
      })
      if (overrideConfigured) expect(got.reasons).toEqual(['same-family-refused'])
      else expect(got.reasons).toEqual([])
      expect(judge.captured).toHaveLength(0)
    },
  )
  it('refuses every baseline row warmed without the eligible judge identity', async () => {
    const { f, input, planner, judge } = await warmJudge({ warmWithoutJudge: true })
    const result = await evalLocal.runReplayGate(input)
    expect(receipt(result)).toMatchObject({ verdict: 'abstain', reasons: ['baseline-uncached'] })
    for (const { cassette } of f.selected) expect(result.notices.join('\n')).toContain(cassette.id)
    expect(planner.captured).toHaveLength(0)
    expect(judge.captured).toHaveLength(0)
  })
  it('serializes measured generalization from held-out collateral only after three target fixes', async () => {
    const { f, input } = await warm({ targetDecisions: 3 }, false, [
      'gate1-target-sibling',
      'gate1-collateral-0',
      'gate1-collateral-1',
    ])
    const stub = respondingStub((call) => {
      const text = JSON.stringify(call.prompt)
      return actionGenerateResult(
        'web',
        text.includes('gate1-target') && !text.includes(f.injection.renderedLine)
          ? 'e-other'
          : 'e-continue',
      )
    })
    input.planner.modelOverrides = { languageModels: stub.languageModels }
    const got = receipt(await evalLocal.runReplayGate(input))
    expect(got.verdict).toBe('pass')
    expect(got.generalization).toEqual({
      liftDecisions: 3,
      minimumLiftDecisions: 3,
      ratio: 1 / 3,
      ci: [0, 1],
    })
    expect(got.productFloor?.axes).toHaveLength(6)
    expect(got.productFloor?.axes.find((axis) => axis.axis === 'loop')).toEqual({
      axis: 'loop',
      floor: null,
      n: 0,
    })
    const serialized = evalLocal.serializeReplayGateReceipt(got)
    expect(GateReceiptSchema.parse(JSON.parse(serialized))).toEqual(got)
    expect(got).not.toHaveProperty('lifts')
    expect(got).not.toHaveProperty('regressions')
    expect(got.generalization!.ci!.every(Number.isFinite)).toBe(true)
    expect(got.spend?.screens).toBe(20)
  })
  it.each(['ride-along', 'harm'])(
    'retains first samples when %s prevents cross-check',
    async (mode) => {
      const { f, input } = await warm(undefined, mode === 'ride-along')
      const stub = respondingStub((call) =>
        JSON.stringify(call.prompt).includes('gate1-collateral-0') && mode === 'harm'
          ? actionGenerateResult('web', 'e-other')
          : gate1Responder(f)(call),
      )
      input.planner.modelOverrides = { languageModels: stub.languageModels }
      const got = receipt(await evalLocal.runReplayGate(input))
      expect(got.crossCheck).toBe('not-run')
      expect(got.samples.detail).toHaveLength(2)
      expect(got.spend?.screens).toBe(6)
    },
  )
  it('holds at k=5 when four fresh without-record samples overcome the cached miss', async () => {
    const { input } = await warm()
    input.k = 5
    input.planner.modelOverrides = {
      languageModels: respondingStub(() => actionGenerateResult()).languageModels,
    }
    const got = receipt(await evalLocal.runReplayGate(input))
    expect(got).toMatchObject({
      crossCheck: 'held',
      verdict: 'fail',
      reasons: ['target-not-reproduced'],
    })
    expect(got.samples.detail).toHaveLength(10)
    expect(got.samples.detail?.filter((row) => !row.withRecord && !row.matchesGold)).toHaveLength(1)
  })
  it('discloses a harness-error cross-check sample without claiming a flip', async () => {
    const { f, input } = await warm()
    let withCalls = 0
    const stub = respondingStub((call) => {
      const text = JSON.stringify(call.prompt)
      if (
        text.includes('gate1-target-run') &&
        text.includes(f.injection.renderedLine) &&
        ++withCalls === 2
      )
        throw new Error('fixture infrastructure failure')
      return gate1Responder(f)(call)
    })
    input.planner.modelOverrides = { languageModels: stub.languageModels }
    const got = receipt(await evalLocal.runReplayGate(input))
    expect(got).toMatchObject({ crossCheck: 'inconclusive', verdict: 'abstain' })
    expect(got.samples.detail).toContainEqual(expect.objectContaining({ kind: 'harness-error' }))
  })
  it('pairs distinct seeds with the inherited samples on both arms', async () => {
    const { baseline, stub, input } = await warm()
    const got = receipt(await evalLocal.runReplayGate(input))
    const seeds = [11, ...deriveSampleSeeds(11, 3)]
    expect(got.samples.seeds).toEqual(seeds)
    const target = [...baseline.captured, ...stub.captured].filter((call) =>
      JSON.stringify(call.prompt).includes('gate1-target-run'),
    )
    expect(target.map((call) => call.seed).sort()).toEqual([...seeds, ...seeds].sort())
    expect(new Set(seeds).size).toBe(3)
  })
  it('accepts four gold of five and spends exactly eight fresh cross-check screens', async () => {
    const { f, input } = await warm()
    let withCalls = 0
    const stub = respondingStub((call) => {
      const text = JSON.stringify(call.prompt)
      if (
        text.includes('gate1-target-run') &&
        text.includes(f.injection.renderedLine) &&
        ++withCalls === 5
      )
        return actionGenerateResult('web', 'e-other')
      return gate1Responder(f)(call)
    })
    const got = receipt(
      await evalLocal.runReplayGate({
        ...input,
        k: 5,
        planner: { ...input.planner, modelOverrides: { languageModels: stub.languageModels } },
      }),
    )
    expect(requiredAgreement(5)).toBe(4)
    expect(got).toMatchObject({
      crossCheck: 'flipped',
      verdict: 'pass',
      spend: {
        screens: 14,
        modelCalls: 14,
        promptTokens: 140,
        completionTokens: 28,
        wallClockMs: 570,
      },
    })
    expect(got.samples.detail).toHaveLength(10)
  })
  it('discloses provider seed rejection as repeat variance', async () => {
    const { f, input } = await warm()
    const stub = respondingStub((call) => ({
      ...gate1Responder(f)(call),
      warnings: [{ type: 'unsupported', feature: 'seed' }],
    }))
    input.planner.modelOverrides = { languageModels: stub.languageModels }
    const result = await evalLocal.runReplayGate(input)
    expect(receipt(result).samples.seedHonored).toBe(false)
    expect(result.notices).toContain(
      'seedHonored=false: samples collapse to repeat variance on this provider',
    )
  })
  it.each(['present', 'uniform', 'missing', 'canary', 'canary-ordinary', 'unflagged', 'active-canary', 'retired-canary'])(
    'removes an active-record proof line: %s',
    async (mode) => {
      const f = fixture({ proofBrief: true })
      const target = f.selected.find((row) => row.cassette.id === f.targetId)!
      const line = target.cassette.input.servedBrief.channel1[0]!
      if (['canary', 'canary-ordinary', 'unflagged'].includes(mode)) line.status = 'candidate'
      if (mode === 'retired-canary') line.status = 'deprecated'
      if (['canary', 'canary-ordinary', 'active-canary', 'retired-canary'].includes(mode)) line.servedAsCanary = true
      const admitted = ['present', 'uniform', 'canary', 'active-canary'].includes(mode)
      target.cassette.receipt.promptInputHash = sha256hex(canonicalizeInputLeg(target.cassette.input))
      if (mode === 'uniform') {
        const brief = target.cassette.input.servedBrief
        // Retain another line so removal still has to rebuild a populated proof.
        brief.channel1.push(f.injection.line)
        const first = { ...brief.proof!.promptTurns[0]!, turnOrdinal: 0 }
        first.learnedL2 += '\n' + f.injection.renderedLine
        brief.proof!.promptTurns = [first, { ...first, turnOrdinal: 1 }]
        target.cassette.decisionOrdinal = 9
        target.cassette.input.decisionOrdinal = 9
        target.cassette.receipt.promptInputHash = sha256hex(
          canonicalizeInputLeg(target.cassette.input),
        )
      }
      const stub = respondingStub((call) =>
        actionGenerateResult(
          'web',
          JSON.stringify(call.prompt).includes(line.summary.replaceAll('"', '\\"'))
            ? 'e-continue'
            : 'e-other',
        ),
      )
      const sample = (ref: string) => {
        const action = { type: 'click' as const, ref: asRef(ref) }
        return {
          sampleIndex: 0,
          durationMs: 0,
          outcome: {
            kind: 'decision' as const,
            action,
            identity: computeDecisionIdentity(action, target.cassette.input.stateBefore.elements),
          },
        }
      }
      const got = await evalLocal.removalFlipsOutcome({
        recordId: mode !== 'missing' ? line.id : 'unknown-record',
        mode: { kind: 'active-record', ...(['canary', 'unflagged', 'active-canary', 'retired-canary'].includes(mode) ? { servedCanary: true as const } : {}) },
        cassettes: [target],
        k: 3,
        baseSeed: 11,
        existing: { withRecord: sample('e-continue'), withoutRecord: sample('e-other') },
        replay: {
          profile: stubProfile(),
          auth: noneAuth,
          modelOverrides: { languageModels: stub.languageModels },
          mask: (text: string) => text,
        },
        gate1Dir: join(f.agentQaRoot, 'active-removal'),
      })
      expect(got.crossCheck).toBe(admitted ? 'flipped' : 'inconclusive')
      if (admitted) {
        expect(got.screens).toBe(4)
        expect(got.detail).toHaveLength(6)
        expect(stub.captured).toHaveLength(4)
        if (mode === 'uniform') {
          expect(target.cassette.decisionOrdinal).toBe(9)
          for (const row of readdirSync(join(f.agentQaRoot, 'active-removal'), {
            recursive: true,
            withFileTypes: true,
          })) {
            if (row.name === 'replay.json') {
              const replay = JSON.parse(readFileSync(join(row.parentPath, row.name), 'utf8'))
              expect(replay.promptDrift.harnessDrift).toBe(false)
              expect(replay.turnMatch).toBe('uniform')
            }
          }
        }
      } else {
        expect(got.notices.join('\n')).toContain('brief-line-not-found')
        expect(stub.captured).toHaveLength(0)
      }
    },
  )
  it('replays candidate injection through a uniform two-turn proof at decision ordinal nine', async () => {
    const { f, stub, input, baseline } = await warm({ proofBrief: true })
    for (const target of f.selected.filter((row) => row.cassette.id === f.targetId)) {
      const first = { ...target.cassette.input.servedBrief.proof!.promptTurns[0]!, turnOrdinal: 0 }
      target.cassette.input.servedBrief.proof!.promptTurns = [first, { ...first, turnOrdinal: 1 }]
      target.cassette.decisionOrdinal = 9
      target.cassette.input.decisionOrdinal = 9
      target.cassette.receipt.promptInputHash = sha256hex(
        canonicalizeInputLeg(target.cassette.input),
      )
      new evalLocal.FsCassetteStore({ root: f.root, outputDir: f.cassettesRoot }).write({
        cassette: target.cassette,
        blobs: [],
      })
    }
    await warmGateRoot(f, baseline)
    const got = receipt(await evalLocal.runReplayGate(input))
    expect(got.verdict).toBe('pass')
    expect(got.targets?.[0]?.decisionOrdinal).toBe(9)
    expect(stub.captured).toHaveLength(10)
    const audit = join(f.agentQaRoot, 'eval/gate1', slugBranch(f.injection.candidateId))
    for (const row of readdirSync(audit, { recursive: true, withFileTypes: true })) {
      if (row.name === 'replay.json') {
        const replay = JSON.parse(readFileSync(join(row.parentPath, row.name), 'utf8'))
        expect(replay.promptDrift.harnessDrift).toBe(false)
        if (replay.cassetteId === f.targetId) expect(replay.turnMatch).toBe('uniform')
      }
    }
  })
  it('extracts a local target only into its audit directory and abstains baseline-uncached without warming', async () => {
    const { f, stub, input } = await warm({ targetInCorpus: false, handoffForTarget: true })
    const before = digestTree(f.committedRoot)
    input.planner.resolveAuth = async () => {
      throw new Error('no auth before cache')
    }
    const result = await evalLocal.runReplayGate(input)
    expect(receipt(result)).toMatchObject({ verdict: 'abstain', reasons: ['baseline-uncached'] })
    expect(receipt(result).targets).toBeUndefined()
    expect(result.notices.join('\n')).toContain(f.targetId)
    expect(result.notices.join('\n')).toContain('seed the run into the corpus')
    expect(
      existsSync(
        join(
          f.agentQaRoot,
          'eval/gate1',
          slugBranch(f.injection.candidateId),
          'target/cassettes',
          f.targetId,
          'cassette.json',
        ),
      ),
    ).toBe(true)
    expect(existsSync(join(f.agentQaRoot, 'eval/cassettes'))).toBe(false)
    expect(digestTree(f.committedRoot)).toEqual(before)
    expect(stub.captured).toHaveLength(0)
  })
  it.each(['absent', 'version', 'identity', 'step', 'test'])(
    'names an unavailable target from a %s handoff',
    async (mode) => {
      const { f, stub, input } = await warm({
        targetInCorpus: false,
        handoffForTarget: mode !== 'absent',
      })
      const path = join(
        f.agentQaRoot,
        'runs',
        slugBranch(f.injection.target!.runId),
        'handoff.json',
      )
      if (mode === 'version') {
        const handoff = JSON.parse(readFileSync(path, 'utf8'))
        handoff.schemaVersion = 999
        writeFileSync(path, JSON.stringify(handoff))
      }
      if (mode === 'identity') {
        // Slug location is not identity: the canonical loaded run differs from this DATA reference.
        input.injection = {
          ...f.injection,
          target: { ...f.injection.target!, runId: f.injection.target!.runId.replace('-', '/') },
        }
      }
      if (mode === 'step')
        input.injection = { ...f.injection, target: { ...f.injection.target!, stepIndex: 99 } }
      if (mode === 'test')
        input.injection = {
          ...f.injection,
          target: { ...f.injection.target!, testId: 'different-test' },
        }
      input.planner.resolveAuth = async () => {
        throw new Error('no auth before target')
      }
      const result = await evalLocal.runReplayGate(input)
      expect(receipt(result).reasons).toEqual(['target-unavailable'])
      expect(result.notices.join('\n')).toContain(
        mode === 'absent' ? 'corpusEntriesForRun=0 handoffPresent=false' : 'handoffPresent=true',
      )
      if (mode === 'version' || mode === 'identity')
        expect(result.notices.join('\n')).toContain('reason=')
      expect(stub.captured).toHaveLength(0)
    },
  )
  it('uses partition version zero for an unseen gamma product', async () => {
    const { input, stub } = await warm()
    input.injection = { ...input.injection, product: 'gamma' }
    expect(receipt(await evalLocal.runReplayGate(input))).toMatchObject({
      reasons: ['empty-gate-set'],
      corpusVersion: { partitionVersion: 0, gateSetSize: 0 },
    })
    expect(stub.captured).toHaveLength(0)
  })
  it.each(['pass', 'harm', 'all-correct'])(
    'judges every target-step decision: %s',
    async (mode) => {
      const { f, input } = await warm({ targetDecisions: 2 }, mode === 'all-correct')
      const stub = respondingStub((call) => {
        const text = JSON.stringify(call.prompt)
        if (text.includes('gate1-target-sibling-1'))
          return actionGenerateResult('web', mode === 'harm' ? 'e-other' : 'e-continue')
        return gate1Responder(f)(call)
      })
      input.planner.modelOverrides = { languageModels: stub.languageModels }
      input.maxScreens = 11
      const got = receipt(await evalLocal.runReplayGate(input))
      expect(got.targets).toHaveLength(2)
      expect(got.verdict).toBe(mode === 'pass' ? 'pass' : 'fail')
      expect(got.reasons).toEqual(
        mode === 'pass' ? [] : mode === 'harm' ? ['collateral-harm'] : ['no-positive-value'],
      )
      expect(got.spend?.screens).toBe(mode === 'pass' ? 11 : 7)
      if (mode === 'harm') {
        expect(got.harmed?.[0]?.origin).toBe('target-step')
        expect(got.crossCheck).toBe('not-run')
      }
    },
  )
  function receipt(result: evalLocal.RunReplayGateResult) {
    expect(result.kind).toBe('receipt')
    if (result.kind !== 'receipt') throw new Error(JSON.stringify(result))
    return result.receipt
  }
  function digestTree(root: string) {
    return readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((row) => row.isFile())
      .map((row) => {
        const file = join(row.parentPath, row.name)
        return [
          file.slice(root.length),
          createHash('sha256').update(readFileSync(file)).digest('hex'),
        ]
      })
      .sort()
  }
  it('passes with a zero-call baseline, one call per check, paired evidence and immutable source roots', async () => {
    const { f, baseline, stub, input } = await warm()
    const beforeBaseline = digestTree(f.gateRoot)
    const beforeCommitted = digestTree(f.committedRoot)
    const result = await evalLocal.runReplayGate(input)
    const got = receipt(result)
    expect(got).toMatchObject({
      verdict: 'pass',
      crossCheck: 'flipped',
      reasons: [],
      degradation: 'replay-diff',
      harmed: [],
      population: { rendered: 6, renderedExcluded: 0 },
      samples: { k: 3, seeds: [11, 1938274511, 1319274378] },
      spend: {
        screens: 10,
        modelCalls: 10,
        promptTokens: 100,
        completionTokens: 20,
        wallClockMs: 410,
      },
    })
    expect(got.targets?.[0]).toMatchObject({
      source: 'committed',
      baselineCorrect: false,
      candidateCorrect: true,
      baselineBriefSource: 'empty',
      candidateBriefSource: 'rendered',
    })
    expect(got.samples.detail).toHaveLength(6)
    expect(GateReceiptSchema.parse(got)).toEqual(got)
    expect(got.generalization).toEqual({ liftDecisions: 1, minimumLiftDecisions: 3 })
    expect(got.generalization).not.toHaveProperty('ratio')
    expect(got.generalization).not.toHaveProperty('ci')
    expect(receiptDigestOf(got)).toBe(got.receiptDigest)
    expect(stub.captured.length).toBe(got.spend?.screens)
    for (let i = 0; i < 5; i++) {
      const key = `gate1-collateral-${i}`
      const before = baseline.captured.find((call) => JSON.stringify(call.prompt).includes(key))!
      const candidates = stub.captured.filter((call) => JSON.stringify(call.prompt).includes(key))
      expect(candidates).toHaveLength(1)
      const candidate = JSON.stringify(candidates[0]!.prompt)
      expect(candidate).toContain(f.injection.renderedLine)
      // The prompt builder adds a served-brief section around the one observation.
      const base = JSON.stringify(before.prompt)
      const commonPrefix = Array.from(base).findIndex((char, index) => candidate[index] !== char)
      let suffix = 0
      while (
        base.at(-1 - suffix) === candidate.at(-1 - suffix) &&
        suffix < base.length - commonPrefix
      )
        suffix++
      expect(base.slice(commonPrefix, base.length - suffix)).toBe('')
      expect(candidate.slice(commonPrefix, candidate.length - suffix)).toContain(
        f.injection.renderedLine,
      )
    }
    expect(digestTree(f.gateRoot)).toEqual(beforeBaseline)
    expect(got.baselineSource).toEqual({
      runRoot: f.gateRoot,
      seed: 11,
      seedSource: 'run-publication',
    })
    expect(
      digestTree(join(f.agentQaRoot, 'eval/gate1', slugBranch(f.injection.candidateId))).filter(
        ([path]) => path!.startsWith('/cross-check/'),
      ).length,
    ).toBeGreaterThan(0)
    expect(digestTree(f.committedRoot)).toEqual(beforeCommitted)
    expect(
      digestTree(join(f.agentQaRoot, 'eval/gate1', slugBranch(f.injection.candidateId))).length,
    ).toBeGreaterThan(0)
    expect(result.kind === 'receipt' && result.lines[0]).toBe(
      'gate 1 · pass · replay-diff · crossCheck flipped · k=3 · 10/64 screens · 10 calls',
    )
  })
  it.each([11, 29])(
    'uses the persisted seed %i for both first-pair samples and receipt provenance',
    async (seed) => {
      const { f, baseline, stub, input } = await warm()
      baseline.captured.length = 0
      await warmGateRoot(f, baseline, seed)
      input.baselineSeed = { seed: seed === 11 ? 29 : 11, source: 'config' }
      const got = receipt(await evalLocal.runReplayGate(input))
      expect(got.verdict).toBe('pass')
      expect(baseline.captured.every((call) => call.seed === seed)).toBe(true)
      expect(stub.captured.slice(0, f.selected.length).every((call) => call.seed === seed)).toBe(
        true,
      )
      expect(got.baselineSource).toEqual({
        runRoot: f.gateRoot,
        seed,
        seedSource: 'run-publication',
      })
      expect(
        got.samples.detail
          ?.filter((row) => row.seed === seed)
          .map((row) => row.withRecord)
          .sort(),
      ).toEqual([false, true])
      expect(got.samples.seeds).toEqual([seed, ...deriveSampleSeeds(seed, 3)])
    },
  )
  it('inherits a different floor seed for each target first pair without changing other rows', async () => {
    const { f, stub, input } = await warm({ targetDecisions: 2 })
    const target = f.selected.find((row) =>
      row.cassette.input.stateBefore.tree.includes('gate1-target-sibling-1'),
    )!
    const floorRoot = join(f.agentQaRoot, 'eval/floor', slugBranch(f.profileKey), 'r0-seed29')
    const baseline = respondingStub(gate1Responder(f))
    await warmGateRoot({ ...f, selected: [target], gateRoot: floorRoot }, baseline, 29)
    rmSync(join(f.gateRoot, 'replays', target.cassette.id), { recursive: true })
    input.baselineSeed = { seed: 37, source: 'config' }
    const got = receipt(await evalLocal.runReplayGate(input))
    expect(got.verdict).toBe('pass')
    const matching = stub.captured.filter((call) =>
      JSON.stringify(call.prompt).includes('gate1-target-sibling-1'),
    )
    expect(matching[0]?.seed).toBe(29)
    expect(baseline.captured[0]?.seed).toBe(29)
    expect(
      got.samples.detail
        ?.filter((row) => row.seed === 29)
        .map((row) => row.withRecord)
        .sort(),
    ).toEqual([false, true])
    expect(
      got.samples.detail
        ?.filter((row) => row.seed === 11)
        .map((row) => row.withRecord)
        .sort(),
    ).toEqual([false, true])
  })
  it.each([
    'procedure',
    'unknown',
    'target-unavailable',
    'baseline-uncached',
    'collateral-unscorable',
    'cap-exceeded',
    'unprovenanced-candidate',
    'empty-gate-set',
  ])('abstains %s before auth and all model calls', async (mode) => {
    const { f, stub, input } = await warm()
    let authCalls = 0
    input.planner.resolveAuth = async () => {
      authCalls++
      return noneAuth
    }
    input.mask = () => {
      throw new Error('preflight must not mask')
    }
    if (mode === 'procedure' || mode === 'unknown') input.injection = { ...f.injection, kind: mode }
    if (mode === 'target-unavailable') input.injection = { ...f.injection, target: undefined }
    if (mode === 'baseline-uncached') input.agentQaRoot = join(f.root, 'cold')
    if (mode === 'cap-exceeded') input.maxScreens = 1
    if (mode === 'collateral-unscorable') {
      const store = new evalLocal.FsReplayRecordStore({
        root: f.agentQaRoot,
        outputDir: join(f.gateRoot, 'replays'),
      })
      for (const cassetteId of f.collateralIds)
        store.save({
          kind: 'integrity-refusal',
          cassetteId,
          reason: 'missing-blob',
          detail: 'fixture unavailable blob',
        })
    }
    if (mode === 'unprovenanced-candidate')
      input.injection = {
        ...f.injection,
        provenance: { runIds: [], receiptDigests: [], capturedAtOrdinals: [] },
      }
    if (mode === 'empty-gate-set') input.injection = { ...f.injection, product: 'missing' }
    const result = await evalLocal.runReplayGate(input)
    const got = receipt(result)
    const expected = mode === 'procedure' || mode === 'unknown' ? 'tier-not-implemented' : mode
    expect(got).toMatchObject({
      verdict: 'abstain',
      reasons: [expected],
      crossCheck: 'not-run',
      spend: { modelCalls: 0, screens: 0 },
    })
    if (expected === 'tier-not-implemented') expect(got.degradation).toBe('tier-not-implemented')
    expect(stub.captured.length).toBe(0)
    expect(authCalls).toBe(0)
    if (mode === 'baseline-uncached')
      expect(result.kind === 'receipt' && result.lines).toContain('agent-qa eval gate --seed 11')
  })
  it('names every stale cassette in corpus order with the warm-up line', async () => {
    const { f, input, stub } = await warm()
    const ids = evalLocal
      .readCommittedCorpus(f.committedRoot)
      .snapshot.entries.filter((entry) => f.collateralIds.includes(entry.cassetteId))
      .slice(0, 2)
      .map((entry) => entry.cassetteId)
    for (const id of ids) {
      const path = join(f.gateRoot, 'replays', id, 'replay.json')
      const record = JSON.parse(readFileSync(path, 'utf8'))
      record.promptDrift.recordedHash = 'f'.repeat(64)
      writeFileSync(path, JSON.stringify(record))
    }
    const result = await evalLocal.runReplayGate(input)
    expect(receipt(result).reasons).toEqual(['baseline-uncached'])
    expect(result.notices).toContain(`uncached: ${ids.join(', ')}`)
    expect(result.kind === 'receipt' && result.lines).toContain('agent-qa eval gate --seed 11')
    expect(stub.captured).toHaveLength(0)
  })
  it.each(['replay', 'score'])(
    'abstains on malformed %s cache data before auth or provider calls',
    async (leg) => {
      const { f, input, stub } = await warm()
      const id = f.collateralIds[0]!
      writeFileSync(join(f.gateRoot, 'replays', id, `${leg}.json`), 'null')
      let authCalls = 0
      input.planner.resolveAuth = async () => {
        authCalls++
        throw new Error('cache admission must precede auth')
      }
      const result = await evalLocal.runReplayGate(input)
      expect(receipt(result)).toMatchObject({
        verdict: 'abstain',
        reasons: ['baseline-uncached'],
        crossCheck: 'not-run',
        spend: { modelCalls: 0, screens: 0 },
      })
      expect(result.notices).toContain(`uncached: ${id}`)
      expect(authCalls).toBe(0)
      expect(stub.captured).toHaveLength(0)
    },
  )
  it.each(['baseline', 'candidate'])(
    'abstains when every %s collateral arm errors',
    async (mode) => {
      const { f, input } = await warm()
      const failing = respondingStub((call) => {
        if (JSON.stringify(call.prompt).includes('gate1-collateral-'))
          throw new Error('fixture-only infrastructure failure')
        return gate1Responder(f)(call)
      })
      const candidate = mode === 'candidate' ? failing : respondingStub(gate1Responder(f))
      if (mode === 'baseline') await warmGateRoot(f, failing)
      input.planner.modelOverrides = { languageModels: candidate.languageModels }
      let authCalls = 0
      input.planner.resolveAuth = async () => {
        authCalls++
        return noneAuth
      }
      const got = receipt(await evalLocal.runReplayGate(input))
      expect(got).toMatchObject({
        verdict: 'abstain',
        reasons: ['collateral-unscorable'],
        crossCheck: 'not-run',
        spend: { screens: mode === 'baseline' ? 0 : 6 },
      })
      expect(authCalls).toBe(mode === 'baseline' ? 0 : 1)
      expect(got.spend?.modelCalls).toBe(candidate.captured.length)
      if (mode === 'baseline') expect(candidate.captured).toHaveLength(0)
      else expect(candidate.captured.length).toBeGreaterThanOrEqual(6)
    },
  )
  it('compares scored collateral and discloses refused rows without replaying them', async () => {
    const { f, input, stub } = await warm()
    const refused = f.collateralIds.slice(0, 2)
    const store = new evalLocal.FsReplayRecordStore({
      root: f.agentQaRoot,
      outputDir: join(f.gateRoot, 'replays'),
    })
    for (const cassetteId of refused)
      store.save({
        kind: 'integrity-refusal',
        cassetteId,
        reason: 'missing-blob',
        detail: 'offline refusal',
      })
    const got = receipt(await evalLocal.runReplayGate(input))
    expect(got.verdict).toBe('pass')
    const population = got.population!
    expect(population.refused).toBe(2)
    expect(got.spend?.screens).toBe(8)
    for (const id of refused) {
      const text = f.selected.find(({ cassette }) => cassette.id === id)!.cassette.input.stepText
      expect(stub.captured.some((call) => JSON.stringify(call.prompt).includes(text))).toBe(false)
    }
  })
  it.each([10, 9])(
    'checks the inclusive cap %i before auth and reports exact spend',
    async (maxScreens) => {
      const { f, input, stub } = await warm({ collateral: 5 })
      const lines: string[] = []
      input.maxScreens = maxScreens
      input.onProgress = (line) => lines.push(line)
      if (maxScreens === 9)
        input.planner.resolveAuth = async () => {
          throw new Error('cap must precede auth')
        }
      const result = await evalLocal.runReplayGate(input)
      const got = receipt(result)
      expect(got.cap).toEqual({ maxScreens })
      expect(got.spend).toEqual(
        maxScreens === 10
          ? {
              screens: 10,
              modelCalls: 10,
              promptTokens: 100,
              completionTokens: 20,
              wallClockMs: 410,
            }
          : { screens: 0, modelCalls: 0, promptTokens: 0, completionTokens: 0, wallClockMs: 10 },
      )
      if (maxScreens === 9) {
        expect(got.reasons).toEqual(['cap-exceeded'])
        expect(result.notices.join('\n')).toContain('planned=10 maxScreens=9')
        expect(stub.captured).toHaveLength(0)
      } else {
        expect(got.verdict).toBe('pass')
        expect(lines).toEqual([
          `gate1 candidate=${f.injection.candidateId}: screens=10 modelCalls=10 promptTokens=100 completionTokens=20 wallClock=410ms seedHonored=true`,
        ])
        expect(Number.isInteger(got.spend!.promptTokens)).toBe(true)
        expect(Number.isInteger(got.spend!.completionTokens)).toBe(true)
      }
    },
  )
  it.each([1, 5])(
    'bounds spend while retaining %i collateral rows with non-headline comparisons',
    async (count) => {
      const { f, input, stub } = await warm()
      for (const id of f.collateralIds.slice(0, count)) {
        const { cassette } = f.selected.find((row) => row.cassette.id === id)!
        cassette.label!.pairing = { relation: 'contrastive-negative', pairedCassetteId: f.targetId }
        new evalLocal.FsCassetteStore({ root: f.root, outputDir: f.cassettesRoot }).write({
          cassette,
          blobs: [],
        })
      }
      let authCalls = 0
      input.planner.resolveAuth = async () => {
        authCalls++
        return noneAuth
      }
      input.maxScreens = 9
      expect(receipt(await evalLocal.runReplayGate(input))).toMatchObject({
        verdict: 'abstain',
        reasons: ['cap-exceeded'],
        spend: { modelCalls: 0, screens: 0 },
      })
      expect(authCalls).toBe(0)
      expect(stub.captured).toHaveLength(0)
      input.maxScreens = 10
      expect(receipt(await evalLocal.runReplayGate(input))).toMatchObject({
        verdict: 'pass',
        spend: { modelCalls: 10, screens: 10 },
        perAxisScore: { elementIdentity: { n: 6 } },
        population: { refused: 0 },
      })
      expect(authCalls).toBe(1)
    },
  )
  it('counts planner retries as provider calls without inflating screens', async () => {
    const { f, input } = await warm()
    const stub = respondingStub((call, index) =>
      index === 0 ? actionGenerateResult('web', 'missing-ref') : gate1Responder(f)(call),
    )
    input.planner.modelOverrides = { languageModels: stub.languageModels }
    const got = receipt(await evalLocal.runReplayGate(input))
    expect(got.verdict).toBe('pass')
    expect(stub.captured).toHaveLength(11)
    expect(got.spend).toMatchObject({
      screens: 10,
      modelCalls: 11,
      promptTokens: 110,
      completionTokens: 22,
    })
  })
  it('counts both order-swapped eligible judge calls for one tie without adding screens', async () => {
    const { f, input } = await warm()
    const profile = familyStubProfile('gpt-fixture')
    const judgeProfile = familyStubProfile('claude-fixture')
    const tied = f.selected.find(({ cassette }) => cassette.id === f.collateralIds[0])!
    const tieText = tied.cassette.input.stepText
    const goldText = 'hello world foo'
    tied.cassette.sidecar.goldAction = {
      type: 'fill',
      ref: asRef('e-continue'),
      text: goldText,
      clearMode: 'replace',
      submit: false,
    }
    tied.cassette.sidecar.opClass = 'fill'
    tied.cassette.sidecar.goldValue = goldText
    for (const { cassette } of f.selected) {
      cassette.receipt.model.declared!.modelId = 'gemini-recorded-fixture'
      new evalLocal.FsCassetteStore({ root: f.root, outputDir: f.cassettesRoot }).write({
        cassette,
        blobs: [],
      })
    }
    const fill = (text: string) => ({
      ...actionGenerateResult(),
      content: [
        {
          type: 'tool-call' as const,
          toolCallId: 'fill-action',
          toolName: 'web_fill',
          input: JSON.stringify({
            ref: 'e-continue',
            text,
            reasoning: 'fill the recorded control',
            confidence: 0.95,
            stepComplete: true,
            doesActionAdvanceUsTowardsGoal: true,
          }),
        },
      ],
    })
    const baseline = respondingStub(
      (call) =>
        JSON.stringify(call.prompt).includes(tieText)
          ? fill('hello world baz')
          : gate1Responder(f)(call),
      profile.model,
    )
    const planner = respondingStub(
      (call) =>
        JSON.stringify(call.prompt).includes(tieText)
          ? fill('hello world bar')
          : gate1Responder(f)(call),
      profile.model,
    )
    const judge = respondingStub(
      () => judgeGenerateResult('equivalent', 'high'),
      judgeProfile.model,
    )
    const fingerprint = evalLocal.computeReplayProfileFingerprintFor({
      profile,
      modelOverrides: { languageModels: planner.languageModels },
      seedPolicy: 'declared',
    })
    const identity = {
      ...f.identity,
      plannerModelId: profile.model,
      judgeModelId: judgeProfile.model,
      judgeVersion: JUDGE_CONFIG.judgeVersion,
      fingerprint,
    }
    identity.profileKey = composeBaselineProfileKey(identity)
    const gateRoot = join(f.agentQaRoot, 'eval/gate', slugBranch(identity.profileKey))
    const written = evalLocal.writeNoiseFloorArtefact({
      artefact: { ...f.artefact, ...identity },
      committedRoot: f.committedRoot,
    })
    expect(written.kind).toBe('written')
    await evalLocal.replayCorpusOnce({
      selected: f.selected,
      cassettesRoot: f.cassettesRoot,
      agentQaRoot: f.agentQaRoot,
      runRoot: gateRoot,
      profile,
      auth: noneAuth,
      modelOverrides: { languageModels: baseline.languageModels },
      judge: {
        profile: judgeProfile,
        auth: noneAuth,
        modelOverrides: { languageModels: judge.languageModels },
      },
      seed: 11,
      k: 1,
      mask: (text: string) => text,
      source: 'committed',
      corpusDigest: f.corpusDigest,
      clock: incrementingClock(),
    })
    expect(judge.captured).toHaveLength(2)
    judge.captured.length = 0
    input.identity = identity
    input.planner = {
      profile,
      resolveAuth: async () => noneAuth,
      modelOverrides: { languageModels: planner.languageModels },
    }
    input.judge = {
      profile: judgeProfile,
      resolveAuth: async () => noneAuth,
      modelOverrides: { languageModels: judge.languageModels },
    }
    const got = receipt(await evalLocal.runReplayGate(input))
    expect(got.verdict).toBe('pass')
    expect(got.judge?.eligibility).toBe('eligible')
    expect(got.judgeId).toBe(`claude-fixture|family=claude|judgeVersion=${JUDGE_CONFIG.judgeVersion}`)
    expect(got.degradation).toBeUndefined()
    expect(judge.captured).toHaveLength(2)
    expect(got.spend).toMatchObject({
      screens: 10,
      modelCalls: 12,
      promptTokens: 120,
      completionTokens: 24,
    })
    expect(got.spend!.modelCalls).toBe(planner.captured.length + judge.captured.length)
  })
  it('discloses split target samples as inconclusive', async () => {
    const { f, input } = await warm()
    let targetWith = 0
    const stub = respondingStub((call) => {
      const text = JSON.stringify(call.prompt)
      if (
        text.includes('gate1-target-run') &&
        text.includes(f.injection.renderedLine) &&
        ++targetWith > 1
      )
        return actionGenerateResult('web', 'e-other')
      return gate1Responder(f)(call)
    })
    input.planner.modelOverrides = { languageModels: stub.languageModels }
    const got = receipt(await evalLocal.runReplayGate(input))
    expect(got).toMatchObject({
      verdict: 'abstain',
      crossCheck: 'inconclusive',
      reasons: ['inconclusive'],
    })
    expect(got.samples.detail).toHaveLength(6)
  })
})

describe('gate-1 fixture and the profile-keyed baseline cache', () => {
  it('exports the cache resolution and root discovery operations', () => {
    expect(Reflect.get(evalLocal, 'resolveBaselineCache')).toBeTypeOf('function')
    expect(Reflect.get(evalLocal, 'listBaselineRunRoots')).toBeTypeOf('function')
  })
  it('lists the gate root first, sorted floor roots with seeds, and no cold roots', async () => {
    const f = fixture()
    await warmGateRoot(f, respondingStub(gate1Responder(f)))
    const floor = join(f.agentQaRoot, 'eval', 'floor', slugBranch(f.profileKey), 'r0-seed7')
    mkdirSync(floor, { recursive: true })
    expect(evalLocal.listBaselineRunRoots(f.agentQaRoot, f.profileKey)).toEqual([
      { root: f.gateRoot, kind: 'gate' },
      { root: floor, kind: 'floor', seed: 7 },
    ])
    expect(evalLocal.listBaselineRunRoots(join(f.root, 'cold'), f.profileKey)).toEqual([])
  })
  it('resolves every warm row cached with seedSource and no new provider call', async () => {
    const f = fixture()
    const stub = respondingStub(gate1Responder(f))
    const warmed = await warmGateRoot(f, stub)
    const calls = stub.captured.length
    const result = evalLocal.resolveBaselineCache(cacheInput(f))
    expect(result.rows).toHaveLength(6)
    for (const row of result.rows)
      expect(row).toMatchObject({
        kind: 'cached',
        seed: 11,
        seedSource: 'run-publication',
        seedHonored: warmed.report.seedHonored,
      })
    expect(result.roots).toEqual([f.gateRoot])
    expect(stub.captured.length).toBe(calls)
  })
  it('names missing replay records on a cold root and fingerprint mismatch on a foreign root', async () => {
    const f = fixture()
    const cold = evalLocal.resolveBaselineCache(cacheInput(f))
    expect(
      cold.rows.every((row) => row.kind === 'uncached' && row.reason.includes('replay record')),
    ).toBe(true)
    await warmGateRoot(f, respondingStub(gate1Responder(f)))
    const foreign = evalLocal.resolveBaselineCache({
      ...cacheInput(f),
      fingerprint: 'f'.repeat(64),
    })
    expect(
      foreign.rows.every((row) => row.kind === 'uncached' && row.reason.includes('fingerprint')),
    ).toBe(true)
  })
  it('responds with gold except for a target missing the renderedLine', () => {
    const f = fixture()
    const respond = gate1Responder(f)
    const call = (text: string) =>
      ({ prompt: [{ role: 'user', content: [{ type: 'text', text }] }] }) as CapturedCallOptions
    expect(respond(call('gate1-collateral-0'))).toEqual(actionGenerateResult())
    expect(respond(call('gate1-target-run'))).toEqual(actionGenerateResult('web', 'e-other'))
    expect(respond(call('gate1-target-run ' + f.injection.renderedLine))).toEqual(
      actionGenerateResult(),
    )
  })
})

describe('the active and served-canary admission rules', () => {
  function target(mutate: (line: BriefLine) => void) {
    const f = fixture({ proofBrief: true })
    const row = f.selected.find((entry) => entry.cassette.id === f.targetId)!
    const line = row.cassette.input.servedBrief.channel1[0]!
    mutate(line)
    row.cassette.receipt.promptInputHash = sha256hex(canonicalizeInputLeg(row.cassette.input))
    return { f, cassette: row.cassette, line }
  }

  it('removes an ordinary ACTIVE record', () => {
    const { cassette, line } = target((row) => {
      row.status = 'active'
      row.servedAsCanary = false
    })
    const removal = resolveActiveRecordRemoval({ cassette, recordId: line.id })
    expect(removal.kind).toBe('removed')
  })

  it('removes a SERVED CANARY candidate only under the opt-in flag', () => {
    const { cassette, line } = target((row) => {
      row.status = 'candidate'
      row.servedAsCanary = true
    })
    expect(resolveActiveRecordRemoval({ cassette, recordId: line.id, servedCanary: true }).kind)
      .toBe('removed')
    expect(resolveActiveRecordRemoval({ cassette, recordId: line.id }).kind).toBe('unavailable')
  })

  it('does not let the canary flag promote an unflagged candidate', () => {
    const { cassette, line } = target((row) => {
      row.status = 'candidate'
      row.servedAsCanary = false
    })
    const removal = resolveActiveRecordRemoval({ cassette, recordId: line.id, servedCanary: true })
    expect(removal).toEqual({
      kind: 'unavailable',
      reason: 'active record brief line unavailable',
    })
  })
})
