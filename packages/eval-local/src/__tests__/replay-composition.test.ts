import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { JUDGE_CONFIG, buildEvalReport, extractRunCassettes } from '@vostride/agent-qa-eval'
import type { ArtifactSource, Cassette, DecisionScore, LeafReplayResult } from '@vostride/agent-qa-eval'
import { createModel } from '@vostride/agent-qa-model'
import type { ModelProfile, ResolvedModelAuth } from '@vostride/agent-qa-model'
import {
  asRecordId,
  asRef,
  sha256hex,
  SERVED_BRIEF_PROOF_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type { CompletedRunHandoff } from '@vostride/agent-qa-schema'
import { SecretRedactor, SecretStore } from '@vostride/agent-qa-runner'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FsCassetteStore } from '../cassette-store.js'
import { loadCassetteBundle } from '../cassette-loader.js'
import { runCassetteReplay } from '../replay-composition.js'
import type { RunCassetteReplayInput } from '../replay-composition.js'
import { FsReplayRecordStore, REPLAY_RECORD_FILE } from '../replay-record-store.js'
import { FsScoreStore, SCORE_FILE } from '../score-store.js'
import type { ScoreRecord } from '../score-store.js'
import {
  LOCAL_FIXTURE_BLOB_BYTES,
  LOCAL_FIXTURE_BLOB_SHA,
  makeLocalV2Handoff,
} from './fixtures/local-handoff-fixture.js'
import {
  capturingStub as keyedCapturingStub,
  familyStubProfile,
  judgeGenerateResult,
  throwingStub as keyedThrowingStub,
} from './fixtures/replay-fixtures.js'

type StubLanguageModel = ReturnType<typeof createModel>
type CapturedCallOptions = Parameters<StubLanguageModel['doGenerate']>[0]
type StubGenerateResult = Awaited<ReturnType<StubLanguageModel['doGenerate']>>

const noneAuth: ResolvedModelAuth = { kind: 'none' }
const STUB_MODEL_ID = 'replay-composition-stub'

function stubProfile(): ModelProfile {
  return {
    provider: 'openai-compatible',
    model: STUB_MODEL_ID,
    baseURL: 'http://localhost:11434/v1',
    auth: { mode: 'none' },
  }
}

function actionGenerateResult(ref = 'e-continue'): StubGenerateResult {
  return {
    content: [
      {
        type: 'tool-call',
        toolCallId: 'replay-action',
        toolName: 'web_click',
        input: JSON.stringify({
          ref,
          reasoning: 'Click the recorded Continue button',
          confidence: 0.95,
          stepComplete: true,
          doesActionAdvanceUsTowardsGoal: true,
        }),
      },
    ],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 2, text: 0, reasoning: 0 },
    },
    warnings: [],
  }
}

function nonActionGenerateResult(toolName: string): StubGenerateResult {
  return {
    content: [
      {
        type: 'tool-call',
        toolCallId: 'replay-lookup',
        toolName,
        input: JSON.stringify({}),
      },
    ],
    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
    usage: {
      inputTokens: { total: 8, noCache: 8, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 0, reasoning: 0 },
    },
    warnings: [],
  }
}

interface CapturingStub {
  captured: CapturedCallOptions[]
  languageModels: Record<string, StubLanguageModel>
}

// A scripted capturing stub injected through createModel's `overrides.languageModels`, so every
// doGenerate params object is captured POST the pinned-last mask/guardrail middleware — the exact
// provider boundary. `script` maps the zero-based call index to the response for that round.
function capturingStub(script: (call: number) => StubGenerateResult): CapturingStub {
  const captured: CapturedCallOptions[] = []
  const stub: StubLanguageModel = {
    specificationVersion: 'v3',
    provider: 'replay-composition-stub',
    modelId: STUB_MODEL_ID,
    supportedUrls: {},
    async doGenerate(params) {
      const call = captured.length
      captured.push(params)
      return script(call)
    },
    async doStream() {
      return { stream: new ReadableStream() }
    },
  }
  return { captured, languageModels: { [STUB_MODEL_ID]: stub } }
}

function memArtifacts(): ArtifactSource {
  return {
    getBlob: (sha) => (sha === LOCAL_FIXTURE_BLOB_SHA ? LOCAL_FIXTURE_BLOB_BYTES : undefined),
  }
}

function extractLeaf(handoff: CompletedRunHandoff): { cassette: Cassette; artifacts: ArtifactSource } {
  const artifacts = memArtifacts()
  const { cassettes } = extractRunCassettes({ handoff, artifacts })
  const leaf = cassettes.find((entry) => entry.cassette.granularity === 'leaf')
  if (leaf === undefined) throw new Error('expected a leaf cassette from the local fixture')
  return { cassette: leaf.cassette, artifacts }
}

function findReplayRecords(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name === 'replay.json')
    .map((entry) => join(entry.parentPath, entry.name))
}

describe('runCassetteReplay — sanctioned composition', () => {
  const tempRoots: string[] = []

  async function tempRoot(prefix: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), prefix))
    tempRoots.push(root)
    return root
  }

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('replays a loaded leaf cassette to a decision at temperature 0 through the pinned middleware', async () => {
    const { cassette, artifacts } = extractLeaf(makeLocalV2Handoff())
    const stub = capturingStub(() => actionGenerateResult())

    const outcome = await runCassetteReplay({
      mask: (text: string) => text,
      cassette,
      artifacts,
      profile: stubProfile(),
      auth: noneAuth,
      modelOverrides: { languageModels: stub.languageModels },
    })

    if (!('granularity' in outcome)) throw new Error('expected a replay result, got a refusal')
    expect(outcome.granularity).toBe('leaf')
    const leaf = outcome as LeafReplayResult
    expect(leaf.samples).toHaveLength(1)
    const sample = leaf.samples[0]!
    expect(sample.outcome.kind).toBe('decision')
    if (sample.outcome.kind !== 'decision') throw new Error('expected a decision sample')
    expect(sample.outcome.identity.opClass).toBe('click')
    expect(sample.outcome.identity.target?.nameNormalized).toBe('continue')

    // The 366 sampling seam applied: the captured provider-boundary request pins temperature 0.
    expect(stub.captured).toHaveLength(1)
    expect(stub.captured[0]!.temperature).toBe(0)
  })

  it('persists briefSource proof with verbatim L0 and L2 in the captured system prompt', async () => {
    const { cassette, artifacts } = extractLeaf(makeLocalV2Handoff())
    if (cassette.granularity !== 'leaf') throw new Error('expected a leaf fixture')
    const policyL0 = '  replay-proof-marker-L0\n'
    const learnedL2 = '\nreplay-proof-marker-L2  '
    cassette.input.servedBrief = {
      ...cassette.input.servedBrief,
      channel1: [{
        id: asRecordId('proof-observation'),
        kind: 'fact',
        summary: 'channel summary must not replace the proof',
        trust: 1,
        status: 'active',
        servedAsCanary: false,
        tier: 'L2',
      }],
      proof: {
        schemaVersion: SERVED_BRIEF_PROOF_SCHEMA_VERSION,
        completeness: 'lossless',
        recordCap: 10,
        combinedBudget: 100,
        admissionEvents: [],
        promptTurns: [{
          ordinal: 0,
          turnOrdinal: cassette.input.decisionOrdinal,
          runDate: '2026-09-05',
          policyL0,
          learnedL1: '',
          learnedL2,
          contextTier: '',
          volatileTier: '',
          policyDigest: sha256hex(policyL0),
          contextTierDigest: sha256hex(''),
          volatileTierDigest: sha256hex(''),
        }],
      },
    }
    const stub = capturingStub(() => actionGenerateResult())
    const replayDir = await tempRoot('replay-comp-proof-')
    const outcome = await runCassetteReplay({
      mask: (text: string) => text,
      cassette,
      artifacts,
      profile: stubProfile(),
      auth: noneAuth,
      modelOverrides: { languageModels: stub.languageModels },
      recordStore: new FsReplayRecordStore({ root: replayDir }),
    })

    expect(outcome).toMatchObject({ granularity: 'leaf', briefSource: 'proof', turnMatch: 'exact' })
    expect(stub.captured).toHaveLength(1)
    const system = stub.captured[0]!.prompt
      .filter(message => message.role === 'system')
      .map(message => message.content)
      .join('\n')
    expect(system).toContain(policyL0)
    expect(system).toContain(learnedL2)
    expect(system).toContain('replay-proof-marker-L0')
    expect(system).toContain('replay-proof-marker-L2')
    expect(system).not.toContain('channel summary must not replace the proof')
    const records = findReplayRecords(replayDir)
    expect(records).toHaveLength(1)
    expect(JSON.parse(readFileSync(records[0]!, 'utf8'))).toMatchObject({
      granularity: 'leaf', briefSource: 'proof', turnMatch: 'exact',
    })
  })

  it('persists unsupported seed evidence from the provider boundary through the report', async () => {
    const { cassette, artifacts } = extractLeaf(makeLocalV2Handoff())
    const stub = capturingStub(() => ({
      ...actionGenerateResult(),
      warnings: [{ type: 'unsupported', feature: 'seed' }],
    }))
    const replayDir = await tempRoot('replay-comp-seed-warning-')

    const outcome = await runCassetteReplay({
      mask: (text: string) => text,
      cassette,
      artifacts,
      profile: stubProfile(),
      auth: noneAuth,
      seed: 11,
      modelOverrides: { languageModels: stub.languageModels },
      recordStore: new FsReplayRecordStore({ root: replayDir }),
    })

    if (!('granularity' in outcome) || outcome.granularity !== 'leaf') {
      throw new Error('expected a leaf replay result')
    }
    expect(outcome.samples).toHaveLength(1)
    expect(outcome.samples[0]!.outcome.kind).toBe('decision')
    expect(stub.captured).toHaveLength(1)
    expect(stub.captured[0]!.seed).toBe(11)
    expect(outcome.samples[0]!.unsupportedFeatures).toEqual(['seed'])
    const records = findReplayRecords(replayDir)
    expect(records).toHaveLength(1)
    const persisted = JSON.parse(readFileSync(records[0]!, 'utf8')) as LeafReplayResult
    expect(persisted.samples[0]!.unsupportedFeatures).toEqual(['seed'])
    const report = buildEvalReport([
      { cassetteId: cassette.id, outcome: persisted },
    ], undefined, undefined, { declaredSeed: 11 })
    expect(report.seedHonored).toBe(false)
  })

  it('stamps recorded and replayed model ids; a mismatch is data, not an error', async () => {
    const { cassette, artifacts } = extractLeaf(makeLocalV2Handoff())
    const stub = capturingStub(() => actionGenerateResult())

    const outcome = (await runCassetteReplay({
      mask: (text: string) => text,
      cassette,
      artifacts,
      profile: stubProfile(),
      auth: noneAuth,
      modelOverrides: { languageModels: stub.languageModels },
    })) as LeafReplayResult

    // The replayed id derives only from the caller profile, never the recorded id.
    expect(outcome.replayedModel).toEqual({ provider: 'openai-compatible', modelId: STUB_MODEL_ID })
    // The recorded id is stamped from the receipt and differs — a visible mismatch, never enforced.
    expect(outcome.recordedModel).toBeDefined()
    expect(outcome.recordedModel!.modelId).not.toBe(outcome.replayedModel.modelId)
  })

  it('constructs a fresh planner + accounting per sample under a forced k=3 escalation', async () => {
    const { cassette, artifacts } = extractLeaf(makeLocalV2Handoff())
    const stub = capturingStub(() => actionGenerateResult())

    const outcome = (await runCassetteReplay({
      mask: (text: string) => text,
      cassette,
      artifacts,
      profile: stubProfile(),
      auth: noneAuth,
      modelOverrides: { languageModels: stub.languageModels },
      k: 3,
      escalationPredicate: () => true,
    })) as LeafReplayResult

    // Three independent samples ⇒ three create() cycles ⇒ three provider-boundary calls, each a
    // grounded decision with its own token accounting (no cross-sample bleed).
    expect(outcome.samples).toHaveLength(3)
    expect(stub.captured).toHaveLength(3)
    for (const sample of outcome.samples) {
      expect(sample.outcome.kind).toBe('decision')
      expect(sample.tokenUsage).toBeDefined()
    }
    expect(outcome.agreement.k).toBe(3)
  })

  it('persists the outcome only when a record store is supplied', async () => {
    const { cassette, artifacts } = extractLeaf(makeLocalV2Handoff())

    const withStoreRoot = await tempRoot('replay-comp-store-')
    const persistedOutcome = await runCassetteReplay({
      mask: (text: string) => text,
      cassette,
      artifacts,
      profile: stubProfile(),
      auth: noneAuth,
      modelOverrides: { languageModels: capturingStub(() => actionGenerateResult()).languageModels },
      recordStore: new FsReplayRecordStore({ root: withStoreRoot }),
    })

    const records = findReplayRecords(join(withStoreRoot, 'eval', 'replays'))
    expect(records).toHaveLength(1)
    expect(JSON.parse(readFileSync(records[0]!, 'utf8'))).toEqual(
      JSON.parse(JSON.stringify(persistedOutcome)),
    )

    const noStoreRoot = await tempRoot('replay-comp-nostore-')
    await runCassetteReplay({
      mask: (text: string) => text,
      cassette,
      artifacts,
      profile: stubProfile(),
      auth: noneAuth,
      modelOverrides: { languageModels: capturingStub(() => actionGenerateResult()).languageModels },
    })
    expect(findReplayRecords(noStoreRoot)).toHaveLength(0)
  })
})

// End-to-end composition over the production round trip.

const RECORDED_LOOKUP_MARKER = 'RECORDED-LOOKUP-RESULT-XYZ'

function extractStoreLoad(
  handoff: CompletedRunHandoff,
  artifacts: ArtifactSource,
  bundleRoot: string,
): ReturnType<typeof loadCassetteBundle> {
  const { cassettes } = extractRunCassettes({ handoff, artifacts })
  const extracted = cassettes.find((entry) => entry.cassette.granularity === 'leaf')
  if (extracted === undefined) throw new Error('expected a leaf cassette from the local fixture')
  const written = new FsCassetteStore({ root: bundleRoot }).write(extracted)
  return loadCassetteBundle(written.dir)
}

describe('runCassetteReplay — production round-trip spine', () => {
  const tempRoots: string[] = []

  async function tempRoot(prefix: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), prefix))
    tempRoots.push(root)
    return root
  }

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('extract → store → load → replay → persist, all on temp dirs with a captured stub', async () => {
    const bundleRoot = await tempRoot('replay-e2e-bundles-')
    const storeRoot = await tempRoot('replay-e2e-store-')

    const load = extractStoreLoad(makeLocalV2Handoff(), memArtifacts(), bundleRoot)
    expect(load.kind).toBe('loaded')
    if (load.kind !== 'loaded') throw new Error('expected a loaded bundle')

    const stub = capturingStub(() => actionGenerateResult())
    const outcome = await runCassetteReplay({
      mask: (text: string) => text,
      cassette: load.cassette,
      artifacts: load.artifacts,
      profile: stubProfile(),
      auth: noneAuth,
      modelOverrides: { languageModels: stub.languageModels },
      recordStore: new FsReplayRecordStore({ root: storeRoot }),
    })

    if (!('granularity' in outcome)) throw new Error('expected a replay result, got a refusal')
    expect(outcome.granularity).toBe('leaf')
    const leaf = outcome as LeafReplayResult
    const sample = leaf.samples[0]!
    expect(sample.outcome.kind).toBe('decision')
    if (sample.outcome.kind !== 'decision') throw new Error('expected a decision sample')
    // Identity resolves against the recorded elements (grounded ref → role/nameNormalized/ordinal).
    expect(sample.outcome.identity.target?.nameNormalized).toBe('continue')
    // Same build recorded and replayed ⇒ no drift (the canonical input-leg hash matches the receipt).
    expect(leaf.promptDrift.drift).toBe(false)

    // The persisted record is deep-equal to the returned outcome.
    const records = findReplayRecords(join(storeRoot, 'eval', 'replays'))
    expect(records).toHaveLength(1)
    expect(JSON.parse(readFileSync(records[0]!, 'utf8'))).toEqual(JSON.parse(JSON.stringify(outcome)))
  })

  it('flows an evidence-incomplete cassette into a persisted refusal without invoking the planner', async () => {
    const bundleRoot = await tempRoot('replay-e2e-incomplete-bundles-')
    const storeRoot = await tempRoot('replay-e2e-incomplete-store-')

    // No blob bytes available at extraction ⇒ the full-capture leaf is evidence-incomplete.
    const emptyArtifacts: ArtifactSource = { getBlob: () => undefined }
    const load = extractStoreLoad(makeLocalV2Handoff(), emptyArtifacts, bundleRoot)
    expect(load.kind).toBe('loaded')
    if (load.kind !== 'loaded') throw new Error('expected a loaded bundle')

    // A throwing stub proves no sample runs: a completeness refusal is filtered first.
    let doGenerateCalls = 0
    const throwingStub: StubLanguageModel = {
      specificationVersion: 'v3',
      provider: 'replay-composition-stub',
      modelId: STUB_MODEL_ID,
      supportedUrls: {},
      async doGenerate() {
        doGenerateCalls++
        throw new Error('planner must not be invoked for an incomplete cassette')
      },
      async doStream() {
        return { stream: new ReadableStream() }
      },
    }

    const outcome = await runCassetteReplay({
      mask: (text: string) => text,
      cassette: load.cassette,
      artifacts: load.artifacts,
      profile: stubProfile(),
      auth: noneAuth,
      modelOverrides: { languageModels: { [STUB_MODEL_ID]: throwingStub } },
      recordStore: new FsReplayRecordStore({ root: storeRoot }),
    })

    expect('kind' in outcome && outcome.kind === 'integrity-refusal').toBe(true)
    if (!('kind' in outcome)) throw new Error('expected a refusal')
    expect(outcome.reason).toBe('completeness')
    expect(doGenerateCalls).toBe(0)

    // The refusal is persisted too — refusals are never silent.
    const records = findReplayRecords(join(storeRoot, 'eval', 'replays'))
    expect(records).toHaveLength(1)
    expect(JSON.parse(readFileSync(records[0]!, 'utf8'))).toEqual(JSON.parse(JSON.stringify(outcome)))
  })

  it('serves a recorded exchange through the real plan() tool-loop and the exchange server', async () => {
    const bundleRoot = await tempRoot('replay-e2e-exchange-bundles-')

    // Extend the recorded live decision with a non-action exchange (opaque evidence data).
    const handoff = makeLocalV2Handoff()
    const live = handoff.tests[0]!.steps[0]!.subActions[0]! as {
      exchanges?: { tool: string; args: Record<string, unknown>; result: unknown }[]
    }
    live.exchanges = [
      { tool: 'recorded_lookup', args: {}, result: { note: RECORDED_LOOKUP_MARKER } },
    ]

    const load = extractStoreLoad(handoff, memArtifacts(), bundleRoot)
    expect(load.kind).toBe('loaded')
    if (load.kind !== 'loaded') throw new Error('expected a loaded bundle')

    // Two-round scripted stub: round 1 requests the recorded non-action tool, round 2 grounds.
    const stub = capturingStub((call) =>
      call === 0 ? nonActionGenerateResult('recorded_lookup') : actionGenerateResult(),
    )

    const outcome = await runCassetteReplay({
      mask: (text: string) => text,
      cassette: load.cassette,
      artifacts: load.artifacts,
      profile: stubProfile(),
      auth: noneAuth,
      modelOverrides: { languageModels: stub.languageModels },
    })

    if (!('granularity' in outcome)) throw new Error('expected a replay result, got a refusal')
    const leaf = outcome as LeafReplayResult
    expect(leaf.samples[0]!.outcome.kind).toBe('decision')

    // The second request carries the served exchange result back to the model.
    expect(stub.captured).toHaveLength(2)
    expect(JSON.stringify(stub.captured[1]!)).toContain(RECORDED_LOOKUP_MARKER)
    // No recorded exchange left unconsumed.
    expect(leaf.unconsumedExchanges).toHaveLength(0)
  })
})

// Optional score persistence through the sanctioned composition.

describe('runCassetteReplay — optional score persistence', () => {
  const tempRoots: string[] = []

  async function tempRoot(prefix: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), prefix))
    tempRoots.push(root)
    return root
  }

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('scores the replay in eval core and persists score.json beside replay.json (record first)', async () => {
    const { cassette, artifacts } = extractLeaf(makeLocalV2Handoff())
    const storeRoot = await tempRoot('replay-comp-scored-')

    const outcome = await runCassetteReplay({
      mask: (text: string) => text,
      cassette,
      artifacts,
      profile: stubProfile(),
      auth: noneAuth,
      modelOverrides: { languageModels: capturingStub(() => actionGenerateResult()).languageModels },
      recordStore: new FsReplayRecordStore({ root: storeRoot }),
      scoreStore: new FsScoreStore({ root: storeRoot }),
    })

    if (!('granularity' in outcome)) throw new Error('expected a replay result, got a refusal')

    // Record-then-score: the record dir is recreated before the file-scoped score write.
    const records = findReplayRecords(join(storeRoot, 'eval', 'replays'))
    expect(records).toHaveLength(1)
    const scoreFile = join(dirname(records[0]!), SCORE_FILE)
    expect(existsSync(scoreFile)).toBe(true)

    const persisted = JSON.parse(readFileSync(scoreFile, 'utf8')) as ScoreRecord
    expect(persisted.cassetteId).toBe(cassette.id)
    expect(typeof persisted.matcherVersion).toBe('number')
    expect(persisted.score.kind).toBe('leaf')
    // The grounded click on the recorded ref settles to a scored diff with a resolved gold identity.
    expect(persisted.diffs).toHaveLength(1)
    expect(persisted.diffs[0]!.kind).toBe('scored')
    expect(persisted.diffs[0]!.goldIdentity).toBeDefined()
    expect(persisted.diffs[0]!.matcherVersion).toBe(persisted.matcherVersion)
  })

  it('never scores a refusal: replay.json persists, no score.json is written', async () => {
    const bundleRoot = await tempRoot('replay-comp-refusal-bundles-')
    const storeRoot = await tempRoot('replay-comp-refusal-store-')

    // No blob bytes at extraction ⇒ evidence-incomplete cassette ⇒ completeness refusal.
    const emptyArtifacts: ArtifactSource = { getBlob: () => undefined }
    const load = extractStoreLoad(makeLocalV2Handoff(), emptyArtifacts, bundleRoot)
    expect(load.kind).toBe('loaded')
    if (load.kind !== 'loaded') throw new Error('expected a loaded bundle')

    const outcome = await runCassetteReplay({
      mask: (text: string) => text,
      cassette: load.cassette,
      artifacts: load.artifacts,
      profile: stubProfile(),
      auth: noneAuth,
      modelOverrides: { languageModels: capturingStub(() => actionGenerateResult()).languageModels },
      recordStore: new FsReplayRecordStore({ root: storeRoot }),
      scoreStore: new FsScoreStore({ root: storeRoot }),
    })

    expect('kind' in outcome && outcome.kind === 'integrity-refusal').toBe(true)

    // The refusal record persists (refusals are never silent), but no score.json exists anywhere —
    // refusals are counted in reports, never scored.
    const records = findReplayRecords(join(storeRoot, 'eval', 'replays'))
    expect(records).toHaveLength(1)
    const scoreFiles = readdirSync(storeRoot, { recursive: true, withFileTypes: true }).filter(
      (entry) => entry.isFile() && entry.name === SCORE_FILE,
    )
    expect(scoreFiles).toHaveLength(0)
  })
})

// The judge leg through the sanctioned composition.

// Default stub ids resolve to no judge family, so the judge leg needs explicit families.
const REPLAY_MODEL_ID = 'gpt-replay-stub' // openai family
const JUDGE_MODEL_ID = 'claude-judge-stub' // claude family — disjoint from replay AND recorded
const SAME_FAMILY_JUDGE_MODEL_ID = 'gpt-judge-stub' // openai family — same as the replay profile
const RECORDED_MODEL_ID = 'gemini-recorded-fixture' // recorded-side family, set explicitly

const GOLD_FILL_TEXT = 'hello world foo'
// Shares 2 of 3 gold tokens ⇒ token-F1 = 2/3, inside the mid band [0.4, 0.9) on a full
// element-identity match ⇒ the deterministic matcher mints unresolved-tie{value-mid-band}.
const CANDIDATE_FILL_TEXT = 'hello world bar'

// A fill on the same ref with different text produces a value-mid-band tie.
function midBandHandoff(stepText = 'Fill the checkout note field'): CompletedRunHandoff {
  const handoff = makeLocalV2Handoff()
  const step = handoff.tests[0]!.steps[0]!
  step.stepText = stepText
  step.modelProfile!.modelId = RECORDED_MODEL_ID
  step.subActions[0]!.plannedAction = {
    type: 'fill',
    ref: asRef('e-continue'),
    text: GOLD_FILL_TEXT,
    clearMode: 'replace',
    submit: false,
  }
  return handoff
}

/** A grounded web_fill tool-call on the recorded ref carrying the candidate value. */
function fillGenerateResult(text: string): StubGenerateResult {
  return {
    content: [
      {
        type: 'tool-call',
        toolCallId: 'replay-action',
        toolName: 'web_fill',
        input: JSON.stringify({
          ref: 'e-continue',
          text,
          reasoning: 'Fill the recorded field with the candidate value',
          confidence: 0.95,
          stepComplete: true,
          doesActionAdvanceUsTowardsGoal: true,
        }),
      },
    ],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 2, text: 0, reasoning: 0 },
    },
    warnings: [],
  }
}

/** Narrow the persisted record to its single leaf decision score. */
function leafDecisionScore(record: ScoreRecord): DecisionScore {
  if (record.score.kind !== 'leaf') throw new Error('expected a leaf cassette score')
  const entry = record.score.entry
  if (entry.kind !== 'decision') throw new Error('expected a decision score entry')
  return entry.score
}

describe('runCassetteReplay — tier-4 judge leg', () => {
  const tempRoots: string[] = []

  async function tempRoot(prefix: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), prefix))
    tempRoots.push(root)
    return root
  }

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  interface MidBandRun {
    replayStub: ReturnType<typeof keyedCapturingStub>
    scoreFiles: string[]
    persisted: ScoreRecord
  }

  /** One offline mid-band replay through the sanctioned helper, judge bag optional. */
  async function runMidBandReplay(
    options: { stepText?: string; judge?: RunCassetteReplayInput['judge'] } = {},
  ): Promise<MidBandRun> {
    const storeRoot = await tempRoot('replay-judge-store-')
    const { cassette, artifacts } = extractLeaf(midBandHandoff(options.stepText))
    const replayStub = keyedCapturingStub(
      () => fillGenerateResult(CANDIDATE_FILL_TEXT),
      REPLAY_MODEL_ID,
    )

    const outcome = await runCassetteReplay({
      mask: (text: string) => text,
      cassette,
      artifacts,
      profile: familyStubProfile(REPLAY_MODEL_ID),
      auth: noneAuth,
      modelOverrides: { languageModels: replayStub.languageModels },
      recordStore: new FsReplayRecordStore({ root: storeRoot }),
      scoreStore: new FsScoreStore({ root: storeRoot }),
      ...(options.judge !== undefined ? { judge: options.judge } : {}),
    })
    if (!('granularity' in outcome)) throw new Error('expected a replay result, got a refusal')

    const scoreFiles = readdirSync(storeRoot, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name === SCORE_FILE)
      .map((entry) => join(entry.parentPath, entry.name))
    if (scoreFiles.length === 0) throw new Error('expected a persisted score.json')
    const persisted = JSON.parse(readFileSync(scoreFiles[0]!, 'utf8')) as ScoreRecord
    return { replayStub, scoreFiles, persisted }
  }

  it('stamps ties not-invoked{no-judge-configured} on the no-judge path and changes nothing else', async () => {
    const { persisted, replayStub } = await runMidBandReplay()

    const score = leafDecisionScore(persisted)
    if (score.kind !== 'unresolved-tie') throw new Error('expected an unresolved tie')
    expect(score.cause).toBe('value-mid-band')
    // The staged fill landed in the mid band: token-F1 2/3 within [0.4, 0.9).
    expect(score.partial?.axes.value).toMatchObject({ kind: 'scored', band: 'mid' })
    if (score.partial?.axes.value.kind === 'scored') {
      expect(score.partial.axes.value.f1).toBeCloseTo(2 / 3, 5)
    }
    // The ONLY 370 delta on the no-judge path: the honest not-invoked stamp.
    expect(score.judgeOutcome).toEqual({ kind: 'not-invoked', reason: 'no-judge-configured' })
    // No judge walk ran ⇒ no identity block key on the persisted record (369 byte-compatible).
    expect('judge' in persisted).toBe(false)
    // The replay planner leg is untouched: one provider-boundary call, exactly as in 369.
    expect(replayStub.captured).toHaveLength(1)
  })

  it('never binds an ineligible same-family judge: not-invoked{no-eligible-judge} carries the family resolutions', async () => {
    const judgeStub = keyedThrowingStub(SAME_FAMILY_JUDGE_MODEL_ID)
    const { persisted } = await runMidBandReplay({
      judge: {
        profile: familyStubProfile(SAME_FAMILY_JUDGE_MODEL_ID),
        auth: noneAuth,
        modelOverrides: { languageModels: judgeStub.languageModels },
      },
    })

    // Soft-but-loud: the run completed normally and the judge model was NEVER invoked.
    expect(judgeStub.calls()).toBe(0)
    const score = leafDecisionScore(persisted)
    if (score.kind !== 'unresolved-tie') throw new Error('expected an unresolved tie')
    expect(score.judgeOutcome).toEqual({
      kind: 'not-invoked',
      reason: 'no-eligible-judge',
      families: { judge: 'openai', replayed: 'openai', recorded: 'gemini' },
    })
    expect('judge' in persisted).toBe(false)
  })

  it('threads allowSameFamily to the eligibility law: the opted-in same-family judge runs and the identity block discloses the override', async () => {
    const judgeStub = keyedCapturingStub(
      () => judgeGenerateResult('equivalent', 'high'),
      SAME_FAMILY_JUDGE_MODEL_ID,
    )
    const { persisted } = await runMidBandReplay({
      judge: {
        profile: familyStubProfile(SAME_FAMILY_JUDGE_MODEL_ID),
        auth: noneAuth,
        modelOverrides: { languageModels: judgeStub.languageModels },
        allowSameFamily: true,
      },
    })

    // The override lifted the known-same-family refusal, so the judge ran.
    expect(judgeStub.captured).toHaveLength(2)
    const score = leafDecisionScore(persisted)
    if (score.kind !== 'scored') throw new Error('expected a judge-settled scored decision')
    expect(score.judgeSettled).toMatchObject({ judgeId: SAME_FAMILY_JUDGE_MODEL_ID })
    // The persisted identity block carries the override marker.
    expect(persisted.judge).toEqual({
      judgeModelId: SAME_FAMILY_JUDGE_MODEL_ID,
      judgeFamily: 'openai',
      judgeVersion: JUDGE_CONFIG.judgeVersion,
      confidenceThreshold: JUDGE_CONFIG.confidenceThreshold,
      familyOverride: 'same-family-allowed',
    })
  })

  it('settles the mid-band tie end-to-end: judgeSettled stamp and the judge identity block read from disk', async () => {
    const judgeStub = keyedCapturingStub(
      () => judgeGenerateResult('equivalent', 'high'),
      JUDGE_MODEL_ID,
    )
    const { persisted } = await runMidBandReplay({
      judge: {
        profile: familyStubProfile(JUDGE_MODEL_ID),
        auth: noneAuth,
        modelOverrides: { languageModels: judgeStub.languageModels },
      },
    })

    const score = leafDecisionScore(persisted)
    if (score.kind !== 'scored') throw new Error('expected a judge-settled scored decision')
    expect(score.judgeSettled).toEqual({
      axis: 'value',
      resolution: 'equivalent',
      cause: 'value-mid-band',
      judgeId: JUDGE_MODEL_ID,
      judgeVersion: JUDGE_CONFIG.judgeVersion,
      confidence: 'high',
      usage: { calls: 2, inputTokens: 20, outputTokens: 4 },
    })
    // The persisted reproducibility receipt of the scored decision.
    expect(persisted.judge).toEqual({
      judgeModelId: JUDGE_MODEL_ID,
      judgeFamily: 'claude',
      judgeVersion: JUDGE_CONFIG.judgeVersion,
      confidenceThreshold: 'high',
    })
    // One call per order, each pinned to temperature 0.
    expect(judgeStub.captured).toHaveLength(2)
    for (const captured of judgeStub.captured) {
      expect(captured.temperature).toBe(0)
    }
  })

  it('persists exactly ONE adjudicated score.json with the replay record beside it', async () => {
    const judgeStub = keyedCapturingStub(
      () => judgeGenerateResult('equivalent', 'high'),
      JUDGE_MODEL_ID,
    )
    const { persisted, scoreFiles } = await runMidBandReplay({
      judge: {
        profile: familyStubProfile(JUDGE_MODEL_ID),
        auth: noneAuth,
        modelOverrides: { languageModels: judgeStub.languageModels },
      },
    })

    // One write, and its content IS the adjudicated score: the settled entry persists as
    // 'scored' — no deterministic-only intermediate is observable on disk.
    expect(scoreFiles).toHaveLength(1)
    expect(leafDecisionScore(persisted).kind).toBe('scored')
    // Record-then-score held: replay.json sits beside the one score.json.
    expect(existsSync(join(dirname(scoreFiles[0]!), REPLAY_RECORD_FILE))).toBe(true)
  })

  it('survives judge infra failure: the tie stands with judge-error{provider-error}, score persisted once', async () => {
    const judgeStub = keyedThrowingStub(JUDGE_MODEL_ID)
    const { persisted, scoreFiles } = await runMidBandReplay({
      judge: {
        profile: familyStubProfile(JUDGE_MODEL_ID),
        auth: noneAuth,
        modelOverrides: { languageModels: judgeStub.languageModels },
      },
    })

    expect(scoreFiles).toHaveLength(1)
    const score = leafDecisionScore(persisted)
    if (score.kind !== 'unresolved-tie') throw new Error('expected the tie to survive')
    expect(score.judgeOutcome).toMatchObject({
      kind: 'judge-error',
      reason: 'provider-error',
      judgeId: JUDGE_MODEL_ID,
      judgeVersion: JUDGE_CONFIG.judgeVersion,
      usage: { calls: 2 },
    })
    // The eligible walk ran, so the identity block rides the record.
    expect(persisted.judge).toEqual({
      judgeModelId: JUDGE_MODEL_ID,
      judgeFamily: 'claude',
      judgeVersion: JUDGE_CONFIG.judgeVersion,
      confidenceThreshold: 'high',
    })
  })
})

// A declared fake secret embedded in the recorded step text.
const FAKE_REPLAY_SECRET = 'raw-fake-replay-secret-9001'

describe('runCassetteReplay — declared mask', () => {
  function secretHandoff(): CompletedRunHandoff {
    const handoff = makeLocalV2Handoff()
    handoff.tests[0]!.steps[0]!.stepText =
      `Use the token ${FAKE_REPLAY_SECRET} then click Continue`
    return handoff
  }

  it('masks a declared secret to its named marker in the replay egress', async () => {
    const { cassette, artifacts } = extractLeaf(secretHandoff())
    const stub = capturingStub(() => actionGenerateResult())
    const redactor = new SecretRedactor(SecretStore.fromEnvContent(`REPLAY_TOKEN=${FAKE_REPLAY_SECRET}`))

    await runCassetteReplay({
      cassette,
      artifacts,
      profile: stubProfile(),
      auth: noneAuth,
      modelOverrides: { languageModels: stub.languageModels },
      mask: (text) => redactor.redactString(text),
    })

    // Captured POST the pinned-last mask middleware: the declared secret reaches the provider
    // boundary as its named marker, never as raw bytes.
    expect(stub.captured).toHaveLength(1)
    const boundaryPayload = JSON.stringify(stub.captured[0]!)
    expect(boundaryPayload).toContain('[secret:REPLAY_TOKEN]')
    expect(boundaryPayload).not.toContain(FAKE_REPLAY_SECRET)
  })
})

describe('replay egress masks declared values', () => {
  const tempRoots: string[] = []
  const declared = new SecretRedactor(SecretStore.fromEnvContent('PW_KEY=Hunter-42-zz'))
  const mask = (text: string) => declared.redactString(text)

  async function tempRoot(prefix: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), prefix))
    tempRoots.push(root)
    return root
  }

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  function pageTextHandoff(): CompletedRunHandoff {
    const handoff = makeLocalV2Handoff()
    for (const step of handoff.tests[0]!.steps) {
      for (const subAction of step.subActions) {
        subAction.stateBefore = {
          ...subAction.stateBefore,
          tree: 'text Signed in as qa@example.com with password Hunter-42-zz\nbutton Continue',
        }
      }
    }
    return handoff
  }

  it('replayed planner requests mask a declared value and keep an email', async () => {
    const { cassette, artifacts } = extractLeaf(pageTextHandoff())
    const stub = capturingStub(() => actionGenerateResult())

    await runCassetteReplay({
      cassette,
      artifacts,
      profile: stubProfile(),
      auth: noneAuth,
      modelOverrides: { languageModels: stub.languageModels },
      mask,
    })

    expect(stub.captured).toHaveLength(1)
    const recorded = JSON.stringify(stub.captured[0]!)
    expect(recorded).toContain('[secret:PW_KEY]')
    expect(recorded).toContain('qa@example.com')
    expect(recorded).not.toContain('Hunter-42-zz')
  })

  it('judge requests are masked with the same mask', async () => {
    const storeRoot = await tempRoot('egress-judge-store-')
    const { cassette, artifacts } = extractLeaf(
      midBandHandoff('Fill the note for qa@example.com with Hunter-42-zz'),
    )
    const replayStub = keyedCapturingStub(() => fillGenerateResult(CANDIDATE_FILL_TEXT), REPLAY_MODEL_ID)
    const judgeStub = keyedCapturingStub(() => judgeGenerateResult('equivalent', 'high'), JUDGE_MODEL_ID)

    await runCassetteReplay({
      cassette,
      artifacts,
      profile: familyStubProfile(REPLAY_MODEL_ID),
      auth: noneAuth,
      modelOverrides: { languageModels: replayStub.languageModels },
      scoreStore: new FsScoreStore({ root: storeRoot }),
      judge: {
        profile: familyStubProfile(JUDGE_MODEL_ID),
        auth: noneAuth,
        modelOverrides: { languageModels: judgeStub.languageModels },
      },
      mask,
    })

    expect(judgeStub.captured).toHaveLength(2)
    const recorded = JSON.stringify(judgeStub.captured)
    expect(recorded).toContain('[secret:PW_KEY]')
    expect(recorded).toContain('qa@example.com')
    expect(recorded).not.toContain('Hunter-42-zz')
  })
})

describe('replay writes no guardrail audit file', () => {
  const tempRoots: string[] = []

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('an eval replay and its adjudication write no guardrail audit file', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'eval-audit-'))
    tempRoots.push(storeRoot)
    const auditFile = ['guardrail', 'audit.jsonl'].join('_')
    const cwdAudit = join(process.cwd(), '.agent-qa', auditFile)
    const cwdBefore = existsSync(cwdAudit) ? readFileSync(cwdAudit, 'utf8') : undefined
    const { cassette, artifacts } = extractLeaf(midBandHandoff())
    const replayStub = keyedCapturingStub(() => fillGenerateResult(CANDIDATE_FILL_TEXT), REPLAY_MODEL_ID)
    const judgeStub = keyedCapturingStub(() => judgeGenerateResult('equivalent', 'high'), JUDGE_MODEL_ID)

    const outcome = await runCassetteReplay({
      cassette,
      artifacts,
      profile: familyStubProfile(REPLAY_MODEL_ID),
      auth: noneAuth,
      modelOverrides: { languageModels: replayStub.languageModels },
      recordStore: new FsReplayRecordStore({ root: storeRoot }),
      scoreStore: new FsScoreStore({ root: storeRoot }),
      judge: {
        profile: familyStubProfile(JUDGE_MODEL_ID),
        auth: noneAuth,
        modelOverrides: { languageModels: judgeStub.languageModels },
      },
      mask: (text: string) => text,
    })

    if (!('granularity' in outcome)) throw new Error('expected a replay result, got a refusal')
    expect(replayStub.captured).toHaveLength(1)
    expect(judgeStub.captured).toHaveLength(2)
    const files = readdirSync(storeRoot, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
    expect(files).toContain(REPLAY_RECORD_FILE)
    expect(files).toContain(SCORE_FILE)
    expect(files).not.toContain(auditFile)
    const scoreFile = readdirSync(storeRoot, { recursive: true, withFileTypes: true })
      .find((entry) => entry.isFile() && entry.name === SCORE_FILE)!
    const persisted = JSON.parse(readFileSync(join(scoreFile.parentPath, scoreFile.name), 'utf8')) as ScoreRecord
    expect(leafDecisionScore(persisted).kind).toBe('scored')
    expect(existsSync(cwdAudit) ? readFileSync(cwdAudit, 'utf8') : undefined).toBe(cwdBefore)
  })
})

export {
  STUB_MODEL_ID,
  actionGenerateResult,
  capturingStub,
  memArtifacts,
  nonActionGenerateResult,
  noneAuth,
  stubProfile,
}
export type { CapturingStub, StubGenerateResult }
