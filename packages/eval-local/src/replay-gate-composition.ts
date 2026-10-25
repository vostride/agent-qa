// 2026-09-07, 417: guarded committed reads + the profile cache + pure eval arithmetic.
// All replay calls delegate to the existing safety-scoped composition. Writes are gate-local.
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { HANDOFF_FILE, RUNS_SUBDIR, loadCompletedRunHandoff } from '@vostride/agent-qa-runner-local'
import {
  applyBriefDelta,
  assessJudgeEligibility,
  assessPanelEligibility,
  createPanelIdentity,
  buildEvalReport,
  computeCorpusDigest,
  computeDecisionIdentity,
  decideGate1,
  decisionCorrectnessVectors,
  decisionIdentityKey,
  deriveSampleSeeds,
  extractRunCassettes,
  effectiveGold,
  resolveScoringContext,
  FLOOR_AXES,
  diffArms,
  foldPerAxisScore,
  foldRemovalSamples,
  foldCrossCheckAcrossTargets,
  generalizationDisclosure,
  injectCandidate,
  JUDGE_CONFIG,
  locateBriefLine,
  orderGate1Reasons,
  productFloorRows,
  renderGate1Line,
  selectGateSet,
  toDeclaredBriefDelta,
  type ArmDecision,
  type ScoringJudgeRequest,
  type ArtifactSource,
  type CorpusEntry,
  type DeclaredBriefDelta,
  type DiffedDecision,
  type LeafCassette,
  type ReplayCassetteOutcome,
  type ReplaySample,
  type ReplaySampleOutcome,
  type StandaloneLabelRecord,
} from '@vostride/agent-qa-eval'
import type {
  ModelProfile,
  ModelProviderOverrides,
  ResolvedModelAuth,
} from '@vostride/agent-qa-model'
import {
  GATE_RECEIPT_SCHEMA_VERSION,
  GateReceiptSchema,
  slugBranch,
  stampReceiptDigest,
  type CandidateInjection,
  type CrossCheck,
  type Gate1KSource,
  type Gate1Reason,
  type Gate1Receipt,
} from '@vostride/agent-qa-schema'
import { resolveBaselineCache, type BaselineCacheRow } from './baseline-cache-read.js'
import {
  listNoiseFloorArtefacts,
  readActiveCommittedCorpus,
  readPartitionManifests,
  resolveMinimumGateSet,
  type CommittedReadRefusal,
} from './committed-corpus-source.js'
import { loadCassetteBundles } from './replay-sweep.js'
import { runCassetteReplay, replayJudgeRequest, type RunCassetteReplayInput } from './replay-composition.js'
import { FsReplayRecordStore } from './replay-record-store.js'
import { FsScoreStore, type ScoreRecord } from './score-store.js'
import { loadScoreRecord } from './replay-read.js'
import { loadCassetteBundle } from './cassette-loader.js'
import { FsCassetteStore } from './cassette-store.js'
import { FsRunArtifactSource } from './artifact-source.js'

export const GATE1_AUDIT_SUBDIR = 'eval/gate1'
export const GATE1_TARGET_SUBDIR = 'target'

export function judgeIdOf(input: {
  judgeModelId: string
  judgeFamily: string
  judgeVersion: number
}): string {
  return `${input.judgeModelId}|family=${input.judgeFamily}|judgeVersion=${input.judgeVersion}`
}

/** A slug locates storage; only the loaded run/step/test establishes target identity. */
export async function locateTargetCassettes(input: {
  committedRoot: string
  agentQaRoot: string
  gate1Dir: string
  corpusEntries: readonly CorpusEntry[]
  target: NonNullable<CandidateInjection['target']>
  /** 418 D-02: a live ablation must not substitute a committed/corrected gold record. */
  source?: 'handoff'
}): Promise<
  | { kind: 'committed' | 'extracted'; cassettes: LeafBundle[]; detail: TargetLocationDetail }
  | { kind: 'unavailable'; detail: TargetLocationDetail }
> {
  const { target } = input
  const entries = input.corpusEntries.filter((entry) => entry.run_links.runId === target.runId)
  const handoffPath = join(input.agentQaRoot, RUNS_SUBDIR, slugBranch(target.runId), HANDOFF_FILE)
  const detail: TargetLocationDetail = {
    runId: target.runId,
    stepIndex: target.stepIndex,
    corpusEntriesForRun: entries.length,
    handoffPresent: existsSync(handoffPath),
  }
  const matches = (cassette: LeafCassette) =>
    cassette.runId === target.runId &&
    cassette.stepIndex === target.stepIndex &&
    (target.testId === undefined || cassette.input.testId === target.testId)
  const entryIds = new Set(entries.map((entry) => entry.cassetteId))
  const committed: LeafBundle[] = []
  const committedBundles = input.source === 'handoff'
    ? [] : loadCassetteBundles(join(input.committedRoot, 'cassettes')).loaded
  for (const bundle of committedBundles)
    if (
      entryIds.has(bundle.cassette.id) &&
      bundle.cassette.granularity === 'leaf' &&
      matches(bundle.cassette)
    )
      committed.push({ cassette: bundle.cassette, artifacts: bundle.artifacts })
  if (committed.length) return { kind: 'committed', cassettes: committed, detail }
  if (!detail.handoffPresent) return { kind: 'unavailable', detail }
  let extraction: ReturnType<typeof extractRunCassettes>
  try {
    const handoff = loadCompletedRunHandoff(handoffPath)
    if (handoff.runId !== target.runId)
      return { kind: 'unavailable', detail: { ...detail, reason: 'loaded handoff runId mismatch' } }
    extraction = extractRunCassettes({
      handoff,
      artifacts: new FsRunArtifactSource({ root: input.agentQaRoot, runId: handoff.runId }),
    })
    if (
      input.source === 'handoff' &&
      handoff.tests.some((test) =>
        (target.testId === undefined || test.testId === target.testId) &&
        test.steps.some((step) => step.stepIndex === target.stepIndex),
      ) &&
      !extraction.cassettes.some((row) =>
        row.cassette.granularity === 'leaf' && matches(row.cassette),
      )
    )
      return { kind: 'unavailable', detail: { ...detail, reason: 'no live decision at target' } }
  } catch (error) {
    return {
      kind: 'unavailable',
      detail: { ...detail, reason: error instanceof Error ? error.message : String(error) },
    }
  }
  const store = new FsCassetteStore({
    root: input.agentQaRoot,
    outputDir: join(input.gate1Dir, GATE1_TARGET_SUBDIR, 'cassettes'),
  })
  const cassettes: LeafBundle[] = []
  for (const extracted of extraction.cassettes) {
    if (extracted.cassette.granularity !== 'leaf' || !matches(extracted.cassette)) continue
    const bundle = loadCassetteBundle(store.write(extracted).dir)
    if (
      bundle.kind === 'loaded' &&
      bundle.cassette.granularity === 'leaf' &&
      matches(bundle.cassette)
    )
      cassettes.push({ cassette: bundle.cassette, artifacts: bundle.artifacts })
  }
  return cassettes.length
    ? { kind: 'extracted', cassettes, detail }
    : { kind: 'unavailable', detail }
}
interface TargetLocationDetail {
  runId: string
  stepIndex: number
  corpusEntriesForRun: number
  handoffPresent: boolean
  reason?: string
}

/** The CLI's JSON output uses the same schema-validated DTO as persisted receipts. */
export function serializeReplayGateReceipt(receipt: unknown): string {
  return JSON.stringify(GateReceiptSchema.parse(receipt), null, 2)
}
type Planner = {
  profile: ModelProfile
  modelOverrides?: ModelProviderOverrides
  resolveAuth: () => Promise<ResolvedModelAuth>
}
export interface RunReplayGateInput {
  injection: CandidateInjection
  committedRoot: string
  agentQaRoot: string
  identity: {
    plannerModelId: string
    matcherVersion: number
    judgeModelId?: string
    judgeVersion?: number
    judgeMemberModelIds?: readonly string[]
    fingerprint: string
    profileKey: string
  }
  planner: Planner
  judge?: Planner
  /** Complete explicit lazy declaration; Gate 1 evaluates the raw members as a unit. */
  judgeMembers?: readonly Planner[]
  judgeOverrideConfigured: boolean
  k: number
  kSource: Gate1KSource
  maxScreens: number
  baselineSeed: { seed?: number; source: 'flag' | 'config' } | { floorSeeds: readonly number[] }
  /** Effective CLI selection for a copyable, spend-bearing cache recovery command. */
  baselineWarmup?: { configPath: string; judge?: string; judges?: readonly string[] }
  mask: RunCassetteReplayInput['mask']
  producedBy: { opId: string }
  clock?: () => number
  onProgress?: (line: string) => void
}
export type RunReplayGateResult =
  | {
      kind: 'receipt'
      receipt: Gate1Receipt
      lines: string[]
      notices: string[]
      refusals: readonly CommittedReadRefusal[]
      modelCalls: number
      wallClockMs: number
    }
  | { kind: 'refused'; refusal: CommittedReadRefusal; notices: string[] }
type LeafBundle = { cassette: LeafCassette; artifacts: ArtifactSource }
type Cached = Extract<BaselineCacheRow, { kind: 'cached' }>
export type ReplayBag = Pick<
  RunCassetteReplayInput,
  | 'profile'
  | 'auth'
  | 'modelOverrides'
  | 'judge'
  | 'mask'
  | 'modelCallObservation'
  | 'clock'
>

function firstSample(outcome: ReplayCassetteOutcome): ReplaySample | undefined {
  return 'granularity' in outcome && outcome.granularity === 'leaf' ? outcome.samples[0] : undefined
}
function outcomeOf(sample: ReplaySample | undefined): ReplaySampleOutcome {
  return sample?.outcome ?? { kind: 'harness-error', message: 'replay produced no sample' }
}
function honored(sample: ReplaySample | undefined): boolean {
  return (
    sample !== undefined &&
    !(sample.unsupportedFeatures ?? []).some((feature) => feature.toLowerCase().includes('seed'))
  )
}
function arm(
  cassette: LeafCassette,
  replay: ReplayCassetteOutcome,
  score?: ScoreRecord,
  labelRecord?: StandaloneLabelRecord,
  expectedJudgeRequest?: ScoringJudgeRequest,
): ArmDecision['baseline'] {
  const resolved = resolveScoringContext({ cassette, outcome: replay, record: score, labelRecord, expectedJudgeRequest })
  const vector = decisionCorrectnessVectors([
    { cassetteId: cassette.id, outcome: replay,
      score: resolved.score,
      label: labelRecord?.label ?? cassette.label },
  ])[0]
  return vector === undefined || FLOOR_AXES.every((axis) => vector.axes[axis] === 'not-applicable')
    ? { kind: 'refused', reason: 'no decision vector' }
    : { kind: 'scored', vector, briefSource: vector.briefSource }
}
function harm(row: DiffedDecision): NonNullable<Gate1Receipt['harmed']>[number] {
  const {
    cassetteId,
    stepIndex,
    decisionOrdinal,
    origin,
    labelTier,
    sourceChannel,
    verdictPresent,
    split,
    heldOutVisibility,
    softWeight,
  } = row
  return {
    cassetteId,
    ...(stepIndex === undefined ? {} : { stepIndex }),
    decisionOrdinal,
    origin,
    ...(labelTier === undefined ? {} : { labelTier }),
    ...(sourceChannel === undefined ? {} : { sourceChannel }),
    verdictPresent,
    ...(split === undefined ? {} : { split }),
    ...(heldOutVisibility === undefined ? {} : { heldOutVisibility }),
    ...(softWeight === undefined ? {} : { softWeight }),
    axes: row.flippedWorse,
  }
}

export interface RemovalFlipsOutcomeInput {
  recordId: string
  cassettes: readonly (LeafBundle & {
    labelRecord?: StandaloneLabelRecord
    existing?: { withRecord: ReplaySample; withoutRecord: ReplaySample }
    baseSeed?: number
    seedHonored?: boolean
  })[]
  // 2026-09-07, 418 D-02/reconciliation 8: opt-in served-canary removal only.
  // Ordinary active-record callers retain rule 5; this is not another mode arm.
  mode:
    | { kind: 'injected'; injection: CandidateInjection }
    | { kind: 'active-record'; servedCanary?: true }
  k: number
  baseSeed: number
  existing?: { withRecord: ReplaySample; withoutRecord: ReplaySample }
  replay: ReplayBag
  gate1Dir: string
}
export interface RemovalFlipsOutcomeResult {
  crossCheck: Exclude<CrossCheck, 'not-run'>
  perTarget: { cassetteId: string; crossCheck: Exclude<CrossCheck, 'not-run'> }[]
  seeds: number[]
  seedHonored: boolean
  detail: NonNullable<Gate1Receipt['samples']['detail']>
  modelCalls: number
  screens: number
  promptTokens: number
  completionTokens: number
  notices: string[]
}

/** 418 D-02: share the exact removal proof between sample one and subsequent samples.
 * Internal to eval-local; ordinary callers retain the active-record admission rule.
 */
export function resolveActiveRecordRemoval(input: {
  cassette: LeafCassette
  recordId: string
  servedCanary?: true
}): { kind: 'removed'; delta: DeclaredBriefDelta } | { kind: 'unavailable'; reason: string } {
  const { cassette } = input
  const brief = cassette.input.servedBrief
  const channel1Position = brief.channel1.findIndex((line) => line.id === input.recordId)
  const line = brief.channel1[channel1Position]
  if (
    line === undefined ||
    !(
      line.status === 'active' ||
      (input.servedCanary === true && line.status === 'candidate' && line.servedAsCanary === true)
    ) ||
    (line.tier !== 'L0' && line.tier !== 'L1' && line.tier !== 'L2')
  )
    return { kind: 'unavailable', reason: 'active record brief line unavailable' }
  const turns = brief.proof?.promptTurns ?? []
  const turn =
    turns.find((row) => row.turnOrdinal === cassette.decisionOrdinal) ??
    (turns.every((row) =>
      row.policyL0 === turns[0]?.policyL0 &&
      row.learnedL1 === turns[0]?.learnedL1 &&
      row.learnedL2 === turns[0]?.learnedL2,
    ) ? turns[0] : undefined)
  if (turn === undefined)
    return { kind: 'unavailable', reason: 'active record requires a reproducible proof turn' }
  const text = turn[
    { L0: 'policyL0', L1: 'learnedL1', L2: 'learnedL2' }[line.tier] as
      'policyL0' | 'learnedL1' | 'learnedL2'
  ]
  const located = locateBriefLine(text, line, line.tier)
  if (located.kind !== 'located')
    return { kind: 'unavailable', reason: 'active record rendered line is absent or ambiguous' }
  return {
    kind: 'removed',
    delta: {
      kind: 'removed',
      line,
      tier: line.tier,
      renderedLine: text.split('\n')[located.index]!,
      turnOrdinal: turn.turnOrdinal,
      position: located.index,
      channel1Position,
    },
  }
}

/** Existing samples count as sample one; every additional sample gets a distinct derived seed. */
export async function removalFlipsOutcome(
  input: RemovalFlipsOutcomeInput,
): Promise<RemovalFlipsOutcomeResult> {
  const result: RemovalFlipsOutcomeResult = {
    crossCheck: 'inconclusive',
    perTarget: [],
    seeds: [input.baseSeed, ...deriveSampleSeeds(input.baseSeed, input.k)],
    seedHonored: true,
    detail: [],
    modelCalls: 0,
    screens: 0,
    promptTokens: 0,
    completionTokens: 0,
    notices: [],
  }
  for (const target of input.cassettes) {
    const { cassette, artifacts } = target
    const effective = effectiveGold(cassette, target.labelRecord)
    if (effective.kind === 'refused') {
      result.notices.push(`gold unavailable: ${cassette.id}: ${effective.reason}`)
      result.perTarget.push({ cassetteId: cassette.id, crossCheck: 'inconclusive' })
      continue
    }
    const baseSeed = target.baseSeed ?? input.baseSeed
    const seeds = [baseSeed, ...deriveSampleSeeds(baseSeed, input.k)]
    const existing = target.existing ?? input.existing
    if (existing === undefined) throw new TypeError('cross-check requires both first samples')
    let withCassette = cassette
    let withoutCassette = cassette
    let withDelta: DeclaredBriefDelta | undefined
    let withoutDelta: DeclaredBriefDelta | undefined
    if (input.mode.kind === 'injected') {
      const planned = toDeclaredBriefDelta(input.mode.injection, cassette)
      if (planned.kind !== 'plan') throw new TypeError(planned.detail)
      withDelta = planned.plan.delta
      withCassette = injectCandidate(cassette, planned.plan)
    } else {
      const removal = resolveActiveRecordRemoval({
        cassette,
        recordId: input.recordId,
        servedCanary: input.mode.servedCanary,
      })
      if (removal.kind === 'unavailable') {
        result.notices.push(`brief-line-not-found: ${cassette.id}: ${removal.reason}`)
        result.perTarget.push({ cassetteId: cassette.id, crossCheck: 'inconclusive' })
        continue
      }
      withoutDelta = removal.delta
      withoutCassette = { ...cassette, input: applyBriefDelta(cassette.input, withoutDelta) }
    }
    const gold = computeDecisionIdentity(
      effective.cassette.sidecar.goldAction,
      cassette.input.stateBefore.elements,
    )
    const goldKey = decisionIdentityKey(gold)
    const arms = { withRecord: [existing.withRecord], withoutRecord: [existing.withoutRecord] }
    result.seedHonored &&= target.seedHonored !== false
    for (let index = 1; index < input.k; index++) {
      for (const withRecord of [true, false]) {
        const outputDir = join(
          input.gate1Dir,
          'cross-check',
          withRecord ? 'with' : 'without',
          `sample-${index}`,
          'replays',
        )
        const replay = await runCassetteReplay({
          ...input.replay,
          cassette: withRecord ? withCassette : withoutCassette,
          labelRecord: target.labelRecord,
          artifacts,
          declaredBriefDelta: withRecord ? withDelta : withoutDelta,
          k: 1,
          seed: seeds[index]!,
          modelCallObservation: {
            onProviderCall: () => {
              result.modelCalls++
              input.replay.modelCallObservation?.onProviderCall?.()
            },
          },
          recordStore: new FsReplayRecordStore({ root: input.gate1Dir, outputDir }),
          scoreStore: new FsScoreStore({ root: input.gate1Dir, outputDir }),
        })
        const sample = firstSample(replay) ?? {
          sampleIndex: 0,
          outcome: outcomeOf(undefined),
          durationMs: 0,
        }
        arms[withRecord ? 'withRecord' : 'withoutRecord'].push(sample)
        result.screens++
        result.promptTokens += sample.tokenUsage?.promptTokens ?? 0
        result.completionTokens += sample.tokenUsage?.completionTokens ?? 0
        const score = loadScoreRecord(join(outputDir, ...cassette.id.split('/').map(slugBranch)))
        if (score.kind === 'loaded') {
          const cost = buildEvalReport([
            { cassetteId: cassette.id, outcome: replay, score: score.record.score },
          ]).honesty.judge.cost
          result.promptTokens += cost.inputTokens
          result.completionTokens += cost.outputTokens
        }
      }
    }
    for (const withRecord of [true, false])
      for (const [index, sample] of arms[withRecord ? 'withRecord' : 'withoutRecord'].entries()) {
        result.seedHonored &&= honored(sample)
        result.detail.push({
          withRecord,
          seed: seeds[index]!,
          matchesGold:
            sample.outcome.kind === 'decision' &&
            decisionIdentityKey(sample.outcome.identity) === goldKey,
          kind: sample.outcome.kind,
        })
      }
    result.perTarget.push({
      cassetteId: cassette.id,
      crossCheck: foldRemovalSamples({
        withRecord: arms.withRecord.map((sample) => sample.outcome),
        withoutRecord: arms.withoutRecord.map((sample) => sample.outcome),
        gold,
      }),
    })
  }
  result.crossCheck = foldCrossCheckAcrossTargets(result.perTarget.map((row) => row.crossCheck))
  return result
}

export async function runReplayGate(input: RunReplayGateInput): Promise<RunReplayGateResult> {
  const notices: string[] = []
  try {
    return await compose(input, notices)
  } catch (error) {
    const io = error as NodeJS.ErrnoException
    if (typeof io?.code !== 'string' || typeof io.path !== 'string') throw error
    return {
      kind: 'refused',
      refusal: { path: io.path, reason: `gate staging failed: ${io.message}` },
      notices,
    }
  }
}

async function compose(input: RunReplayGateInput, notices: string[]): Promise<RunReplayGateResult> {
  const { injection, identity } = input
  if (!Number.isSafeInteger(input.k) || input.k < 3 || input.k % 2 === 0)
    throw new TypeError('k must be an odd integer of at least 3')
  if (!Number.isSafeInteger(input.maxScreens) || input.maxScreens < 1)
    throw new TypeError('maxScreens must be a positive safe integer')
  const clock = input.clock ?? Date.now
  const started = clock()
  const corpus = readActiveCommittedCorpus(input.committedRoot, input.agentQaRoot)
  const floors = listNoiseFloorArtefacts(input.committedRoot)
  const partitions = readPartitionManifests(input.committedRoot)
  const refusals = [...corpus.refusals, ...floors.refusals, ...partitions.refusals]
  notices.push(...corpus.notices, ...partitions.notices)
  if (refusals[0]) return { kind: 'refused', refusal: refusals[0], notices }
  const floor = floors.artefacts.find((row) => row.profileKey === identity.profileKey)?.artefact
  const minimum = resolveMinimumGateSet({
    committedRoot: input.committedRoot,
    profileKey: identity.profileKey,
  })
  if (floor === undefined || minimum.kind !== 'resolved')
    return {
      kind: 'refused',
      refusal: { path: input.committedRoot, reason: 'noise floor or minimum gate set unavailable' },
      notices,
    }
  const members = input.judgeMembers ?? (input.judge === undefined ? [] : [input.judge])
  const memberModelIds = members.map(member => member.profile.model)
  const panel = members.length > 1 ? createPanelIdentity(memberModelIds) : undefined
  if (identity.judgeModelId?.startsWith('panel:') && panel === undefined)
    throw new TypeError('Gate 1 composite judge identity requires explicit raw members')
  const declaredJudgeId = members.length === 0 ? identity.judgeModelId
    : createPanelIdentity(memberModelIds).judgeModelId
  if (declaredJudgeId !== identity.judgeModelId ||
    (identity.judgeMemberModelIds !== undefined &&
      JSON.stringify([...identity.judgeMemberModelIds].sort()) !== JSON.stringify([...memberModelIds].sort())))
    throw new TypeError('Gate 1 judge declaration differs from its cache identity')
  const assess = (cassette?: LeafCassette) => {
    const common = { replayedModelId: identity.plannerModelId,
      recordedModelId: cassette?.receipt.model.declared?.modelId ?? cassette?.receipt.model.resolvedModelId }
    return panel === undefined
      ? assessJudgeEligibility({ ...common, judgeModelId: declaredJudgeId })
      : assessPanelEligibility({ ...common, memberModelIds })
  }
  const eligibility = assess()
  let sameFamilyRefused =
    (panel !== undefined || input.judgeOverrideConfigured) &&
    !eligibility.eligible &&
    eligibility.reason === 'no-eligible-judge'
  const emptyFold = foldPerAxisScore([], floor.axes)
  const receipt: Omit<Gate1Receipt, 'receiptDigest'> = {
    schemaVersion: GATE_RECEIPT_SCHEMA_VERSION,
    gate: 1,
    candidateId: injection.candidateId,
    producedAtOrdinal: injection.latestOrdinal,
    producedBy: input.producedBy,
    verdict: 'abstain',
    perAxisScore: emptyFold.perAxisScore,
    floorAbsentAxes: emptyFold.floorAbsentAxes,
    population: emptyFold.population,
    corpusVersion: {
      corpusDigest: computeCorpusDigest(corpus.snapshot.entries),
      partitionVersion:
        partitions.manifests.find((row) => row.product === injection.product)?.partitionVersion ??
        (corpus.snapshot.entries.some((row) => row.product === injection.product)
          ? floor.partitionVersion
          : 0),
      gateSetSize: 0,
      excludedCount: 0,
      minimumGateSet: minimum.minimumGateSet,
    },
    noiseFloorRef: { profileKey: floor.profileKey, corpusDigest: floor.corpusDigest },
    samples: { k: input.k, seeds: [], seedHonored: false, modelCalls: 0 },
    crossCheck: 'not-run',
    kSource: input.kSource,
    cap: { maxScreens: input.maxScreens },
    spend: { screens: 0, modelCalls: 0, promptTokens: 0, completionTokens: 0, wallClockMs: 0 },
    judge: {
      eligibility: eligibility.eligible ? 'eligible' : eligibility.reason,
      overrideConfigured: input.judgeOverrideConfigured,
      ...(panel === undefined ? {} : { panelSize: panel.panelSize, members: [...panel.members!] }),
    },
    ...(eligibility.eligible
      ? {
          judgeId: judgeIdOf({ ...eligibility, judgeVersion: JUDGE_CONFIG.judgeVersion }),
        }
      : { degradation: 'replay-diff' }),
  }
  const finish = (): RunReplayGateResult => {
    const stamped = stampReceiptDigest(receipt)
    GateReceiptSchema.parse(stamped)
    return {
      kind: 'receipt',
      receipt: stamped,
      lines: [renderGate1Line(stamped), ...notices],
      notices,
      refusals,
      modelCalls: receipt.spend!.modelCalls,
      wallClockMs: receipt.spend!.wallClockMs,
    }
  }
  const abstain = (reason: Gate1Reason) => {
    receipt.spend!.wallClockMs = Math.max(0, Math.round(clock() - started))
    receipt.reasons = orderGate1Reasons([
      reason,
      ...(sameFamilyRefused ? ['same-family-refused' as const] : []),
    ])
    if (reason === 'tier-not-implemented') receipt.degradation = 'tier-not-implemented'
    return finish()
  }
  if (injection.kind !== 'fact' && injection.kind !== 'caution')
    return abstain('tier-not-implemented')
  const gate = selectGateSet({
    entries: corpus.snapshot.entries,
    product: injection.product,
    candidate: injection.provenance,
    minimumGateSet: minimum.minimumGateSet,
  })
  if (gate.verdict !== 'ok') return abstain(gate.verdict)
  receipt.corpusVersion.gateSetSize = gate.gateEntries.length
  receipt.corpusVersion.excludedCount = gate.excluded.length
  if (injection.target === undefined) return abstain('target-unavailable')
  const loaded = loadCassetteBundles(join(input.committedRoot, 'cassettes')).loaded
  const bundles = new Map<string, LeafBundle>()
  for (const row of loaded)
    if (row.cassette.granularity === 'leaf') {
      if (bundles.has(row.cassette.id))
        return {
          kind: 'refused',
          refusal: { path: input.committedRoot, reason: 'duplicate cassette identity' },
          notices,
        }
      bundles.set(row.cassette.id, { cassette: row.cassette, artifacts: row.artifacts })
    }
  const gate1Dir = join(input.agentQaRoot, GATE1_AUDIT_SUBDIR, slugBranch(injection.candidateId))
  const located = await locateTargetCassettes({
    committedRoot: input.committedRoot,
    agentQaRoot: input.agentQaRoot,
    gate1Dir,
    corpusEntries: corpus.snapshot.entries.filter((row) => row.product === injection.product),
    target: injection.target,
  })
  if (located.kind === 'unavailable') {
    const d = located.detail
    notices.push(
      `target-unavailable: runId=${d.runId} stepIndex=${d.stepIndex} corpusEntriesForRun=${d.corpusEntriesForRun} handoffPresent=${d.handoffPresent}${d.reason === undefined ? '' : ' reason=' + d.reason}`,
    )
    return abstain('target-unavailable')
  }
  // Explicitly excluded corpus history cannot regain scoring eligibility through
  // a local handoff. Genuinely non-corpus target siblings keep their existing path.
  const targets = located.cassettes.filter(({ cassette }) =>
    !corpus.snapshot.excludedLabelIds?.has(cassette.id) &&
    !corpus.retiredMarkedCassetteIds?.has(cassette.id))
  if (targets.length === 0) return abstain('target-unavailable')
  for (const target of targets) bundles.set(target.cassette.id, target)
  const allIds = [
    ...new Set([
      ...gate.gateEntries.map((row) => row.cassetteId),
      ...targets.map((row) => row.cassette.id),
    ]),
  ]
  if (allIds.some((id) => !bundles.has(id)))
    return {
      kind: 'refused',
      refusal: { path: input.committedRoot, reason: 'gate cassette unavailable' },
      notices,
    }
  const seed =
    'floorSeeds' in input.baselineSeed
      ? (input.baselineSeed.floorSeeds[0] ?? 11)
      : (input.baselineSeed.seed ?? 11)
  const seedSource =
    'floorSeeds' in input.baselineSeed
      ? input.baselineSeed.floorSeeds[0] === undefined
        ? 'default'
        : 'floor'
      : input.baselineSeed.source
  // Each cached score was judged against its own recorded model as well as the
  // actual replay planner. An ineligible row must carry no eligible judge stamp.
  const assessments = new Map(allIds.map(id => [id, assess(bundles.get(id)!.cassette)]))
  if (panel !== undefined && [...assessments.values()].some(row => !row.eligible)) {
    receipt.judge!.eligibility = 'no-eligible-judge'
    receipt.degradation = 'replay-diff'
    sameFamilyRefused = true
    delete receipt.judgeId
  }
  const resolutions = allIds.map(id => {
    const rowEligibility = assessments.get(id)!
    return resolveBaselineCache({
    agentQaRoot: input.agentQaRoot,
    ...identity,
    ...(rowEligibility.eligible
      ? {
          judgeIdentity: {
            judgeModelId: rowEligibility.judgeModelId,
            judgeVersion: JUDGE_CONFIG.judgeVersion,
          },
        }
      : {}),
    gateRootSeed: seed,
    gateRootSeedSource: seedSource,
    cassettes: [{
      id,
      promptInputHash: bundles.get(id)!.cassette.receipt.promptInputHash,
    }],
    })
  })
  const cache = { rows: resolutions.flatMap(result => result.rows) }
  // D-01 + literal D-06: extraction cannot inherit a committed-profile baseline,
  // even when a stale/colliding directory happens to contain an identically slugged id.
  if (located.kind === 'extracted') {
    const extractedIds = new Set(targets.map((target) => target.cassette.id))
    cache.rows = cache.rows.map((row) =>
      extractedIds.has(row.cassetteId)
        ? {
            kind: 'uncached',
            cassetteId: row.cassetteId,
            reason: 'extracted target has no committed-profile baseline',
          }
        : row,
    )
    for (const id of extractedIds)
      notices.push(
        `target ${id} was extracted from the local handoff and has no committed-profile baseline; seed the run into the corpus, re-run eval gate to warm its baseline, then re-run eval replay-gate`,
      )
  }
  const uncached = cache.rows.filter((row) => row.kind === 'uncached')
  if (uncached.length) {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    const config =
      input.baselineWarmup === undefined
        ? ''
        : ` --config ${quote(input.baselineWarmup.configPath)}`
    const judge = (input.baselineWarmup?.judges ??
      (input.baselineWarmup?.judge === undefined ? [] : [input.baselineWarmup.judge]))
      .map(name => ` --judge ${quote(name)}`).join('')
    notices.push(
      `uncached: ${uncached.map((row) => row.cassetteId).join(', ')}`,
      `agent-qa${config} eval gate --seed ${seed}${judge}`,
      'Baseline warm-up spends planner and configured judge calls; then re-run eval replay-gate.',
    )
    return abstain('baseline-uncached')
  }
  const cacheById = new Map(cache.rows.map((row) => [row.cassetteId, row]))
  const baselineJudgeRequest = declaredJudgeId === undefined ? null : {
    judgeModelId: declaredJudgeId, allowSameFamily: false }
  const baselineArms = new Map(
    cache.rows.map((row) => [
      row.cassetteId,
      row.kind === 'cached'
        ? arm(bundles.get(row.cassetteId)!.cassette, row.replay, row.score, corpus.snapshot.labelsById.get(row.cassetteId), baselineJudgeRequest)
        : { kind: 'refused' as const, reason: row.reason },
    ]),
  )
  const scoredCollateral = gate.gateEntries.filter((row) => {
    const baseline = baselineArms.get(row.cassetteId)
    return baseline?.kind === 'scored'
  })
  if (scoredCollateral.length === 0) return abstain('collateral-unscorable')
  const targetsToCrossCheck = targets.filter(({ cassette }) => {
    const cached = cacheById.get(cassette.id)
    if (cached?.kind !== 'cached') return false
    const baseline = arm(cassette, cached.replay, cached.score, corpus.snapshot.labelsById.get(cassette.id), baselineJudgeRequest)
    return baseline.kind === 'scored' && baseline.vector.axes.headline === 'incorrect'
  }).length
  const scoredTargets = targets.filter(
    (target) => cacheById.get(target.cassette.id)?.kind === 'cached',
  ).length
  const planned = scoredCollateral.length + scoredTargets + 2 * (input.k - 1) * targetsToCrossCheck
  if (planned > input.maxScreens) {
    notices.push(`cap-exceeded: planned=${planned} maxScreens=${input.maxScreens}`)
    return abstain('cap-exceeded')
  }
  const spend = receipt.spend!
  if (input.planner.profile.model !== identity.plannerModelId)
    throw new TypeError('Gate 1 replay planner differs from its cache identity')
  const judgeCanRun = [...assessments.values()].some(row => row.eligible)
  const auth = await input.planner.resolveAuth()
  const judgeBindings = []
  for (const member of members) {
    // Refused declarations still stamp no-eligible-judge, without credentials.
    // Replay rechecks the identical planner/recorded IDs before it can bind a port.
    judgeBindings.push({ profile: member.profile, modelOverrides: member.modelOverrides,
      auth: judgeCanRun ? await member.resolveAuth() : { kind: 'none' as const } })
  }
  const replay: ReplayBag = {
    profile: input.planner.profile,
    auth,
    modelOverrides: input.planner.modelOverrides,
    mask: input.mask,
    modelCallObservation: {
      onProviderCall: () => {
        spend.modelCalls++
      },
    },
    ...(input.clock === undefined ? {} : { clock: { now: input.clock } }),
    ...(members.length > 0
      ? {
          judge: { members: judgeBindings },
        }
      : {}),
  }
  const rows: ArmDecision[] = []
  const candidateSamples = new Map<string, ReplaySample>()
  const targetIds = new Set(targets.map((row) => row.cassette.id))
  let seedHonored = true
  for (const id of allIds) {
    const { cassette, artifacts } = bundles.get(id)!
    const baseline = cacheById.get(id)!
    const entry = corpus.snapshot.entries.find((row) => row.cassetteId === id)
    const labelRecord = corpus.snapshot.labelsById.get(cassette.id)
    const row: ArmDecision = {
      cassetteId: id,
      stepIndex: cassette.stepIndex,
      decisionOrdinal: cassette.decisionOrdinal,
      origin: targetIds.has(id) ? 'target-step' : 'gate-set',
      entry,
      label: labelRecord?.label ?? cassette.label,
      ...(labelRecord?.weight === undefined ? {} : { softWeight: labelRecord.weight.value }),
      baseline: baselineArms.get(id)!,
      candidate: { kind: 'refused', reason: 'baseline refused' },
    }
    rows.push(row)
    if (baseline.kind !== 'cached' || row.baseline.kind !== 'scored') continue
    seedHonored &&= baseline.seedHonored
    const plan = toDeclaredBriefDelta(injection, cassette)
    if (plan.kind !== 'plan') {
      row.candidate = { kind: 'refused', reason: plan.detail }
      continue
    }
    const outputDir = join(gate1Dir, 'candidate-arm', 'replays')
    const candidateCassette = injectCandidate(cassette, plan.plan)
    const candidate = await runCassetteReplay({
      ...replay,
      cassette: candidateCassette,
      labelRecord: corpus.snapshot.labelsById.get(cassette.id),
      artifacts,
      k: 1,
      seed: baseline.seed,
      declaredBriefDelta: plan.plan.delta,
      recordStore: new FsReplayRecordStore({ root: input.agentQaRoot, outputDir }),
      scoreStore: new FsScoreStore({ root: input.agentQaRoot, outputDir }),
    })
    spend.screens++
    const sample = firstSample(candidate)
    if (sample) candidateSamples.set(id, sample)
    seedHonored &&= honored(sample)
    const score = loadScoreRecord(join(outputDir, ...id.split('/').map(slugBranch)))
    row.candidate = arm(candidateCassette, candidate, score.kind === 'loaded' ? score.record : undefined,
      corpus.snapshot.labelsById.get(cassette.id), replayJudgeRequest(replay.judge))
    const cost = buildEvalReport([
      {
        cassetteId: id,
        outcome: candidate,
        score: score.kind === 'loaded' ? score.record.score : undefined,
      },
    ])
    spend.promptTokens += cost.totalCost.promptTokens + cost.honesty.judge.cost.inputTokens
    spend.completionTokens += cost.totalCost.completionTokens + cost.honesty.judge.cost.outputTokens
  }
  const diffed = diffArms(rows)
  const decisionInput = {
    kind: injection.kind,
    sameFamilyRefused,
    targets: diffed.filter((row) => row.origin === 'target-step'),
    collateral: diffed.filter((row) => row.origin === 'gate-set'),
  }
  if (
    !rows.some(
      ({ origin, baseline, candidate }) =>
        origin === 'gate-set' &&
        baseline.kind === 'scored' &&
        candidate.kind === 'scored' &&
        FLOOR_AXES.some(
          (axis) =>
            baseline.vector.axes[axis] !== 'not-applicable' &&
            candidate.vector.axes[axis] !== 'not-applicable',
        ),
    )
  ) {
    const fold = foldPerAxisScore(rows, floor.axes)
    receipt.perAxisScore = fold.perAxisScore
    receipt.floorAbsentAxes = fold.floorAbsentAxes
    receipt.population = fold.population
    receipt.samples.seedHonored = seedHonored
    receipt.samples.modelCalls = spend.modelCalls
    return abstain('collateral-unscorable')
  }
  const probe = decideGate1({ ...decisionInput, crossCheck: 'inconclusive' })
  let crossCheck: CrossCheck = 'not-run'
  const firstBaseline = cacheById.get(targets[0]!.cassette.id)
  const base =
    firstBaseline?.kind === 'cached'
      ? firstBaseline
      : cache.rows.find((row): row is Cached => row.kind === 'cached')!
  receipt.baselineSource = { runRoot: base.root, seed: base.seed, seedSource: base.seedSource }
  receipt.samples = { k: input.k, seeds: [base.seed], seedHonored, modelCalls: spend.modelCalls }
  receipt.samples.detail = targets.flatMap(({ cassette }) => {
    const cached = cacheById.get(cassette.id)
    if (cached?.kind !== 'cached') return []
    const effective = effectiveGold(cassette, corpus.snapshot.labelsById.get(cassette.id))
    if (effective.kind === 'refused') return []
    const goldKey = decisionIdentityKey(
      computeDecisionIdentity(effective.cassette.sidecar.goldAction, cassette.input.stateBefore.elements),
    )
    return [true, false].map((withRecord) => {
      const sample = withRecord ? candidateSamples.get(cassette.id) : firstSample(cached.replay)
      const outcome = outcomeOf(sample)
      return {
        withRecord,
        seed: cached.seed,
        kind: outcome.kind,
        matchesGold:
          outcome.kind === 'decision' && decisionIdentityKey(outcome.identity) === goldKey,
      }
    })
  })
  const fixedTargetIds = new Set(
    decisionInput.targets.filter((row) => row.headline === 'fixed').map((row) => row.cassetteId),
  )
  if (probe.verdict !== 'fail' && fixedTargetIds.size > 0) {
    const result = await removalFlipsOutcome({
      recordId: injection.candidateId,
      mode: { kind: 'injected', injection },
      k: input.k,
      baseSeed: base.seed,
      gate1Dir,
      replay,
      cassettes: targets
        .filter((target) => fixedTargetIds.has(target.cassette.id))
        .map((target) => {
          const cached = cacheById.get(target.cassette.id) as Cached
          return {
            ...target,
            labelRecord: corpus.snapshot.labelsById.get(target.cassette.id),
            baseSeed: cached.seed,
            seedHonored: cached.seedHonored,
            existing: {
              withRecord: candidateSamples.get(target.cassette.id)!,
              withoutRecord: firstSample(cached.replay)!,
            },
          }
        }),
    })
    crossCheck = result.crossCheck
    notices.push(...result.notices)
    spend.screens += result.screens
    spend.promptTokens += result.promptTokens
    spend.completionTokens += result.completionTokens
    receipt.samples = {
      k: input.k,
      seeds: result.seeds,
      seedHonored: seedHonored && result.seedHonored,
      modelCalls: spend.modelCalls,
      detail: result.detail,
    }
  }
  const decision = decideGate1({ ...decisionInput, crossCheck })
  const fold = foldPerAxisScore(rows, floor.axes)
  Object.assign(receipt, {
    perAxisScore: fold.perAxisScore,
    floorAbsentAxes: fold.floorAbsentAxes,
    population: fold.population,
    verdict: decision.verdict,
    reasons: decision.reasons,
    crossCheck: decision.crossCheck,
    harmed: decision.harmed.map(harm),
    unverifiedFlips: decision.unverifiedFlips.map(harm),
  })
  receipt.targets = targets.map(({ cassette }) => {
    const row = rows.find((row) => row.cassetteId === cassette.id)!
    return {
      cassetteId: cassette.id,
      runId: cassette.runId,
      stepIndex: cassette.stepIndex,
      decisionOrdinal: cassette.decisionOrdinal,
      source: located.kind,
      baselineCorrect:
        row.baseline.kind === 'scored' && row.baseline.vector.axes.headline === 'correct',
      candidateCorrect:
        row.candidate.kind === 'scored' && row.candidate.vector.axes.headline === 'correct',
      baselineBriefSource: row.baseline.kind === 'scored' ? row.baseline.briefSource : 'refused',
      candidateBriefSource: row.candidate.kind === 'scored' ? row.candidate.briefSource : 'refused',
    }
  })
  const product = productFloorRows(floor, injection.product)
  if (product !== undefined) receipt.productFloor = product
  receipt.generalization = generalizationDisclosure({
    targets: decisionInput.targets,
    heldOut: decisionInput.collateral.filter((row) => row.split === 'held-out'),
  })
  spend.wallClockMs = Math.max(0, Math.round(clock() - started))
  receipt.samples.modelCalls = spend.modelCalls
  if (!receipt.samples.seedHonored)
    notices.push('seedHonored=false: samples collapse to repeat variance on this provider')
  input.onProgress?.(
    `gate1 candidate=${injection.candidateId}: screens=${spend.screens} modelCalls=${spend.modelCalls} promptTokens=${spend.promptTokens} completionTokens=${spend.completionTokens} wallClock=${spend.wallClockMs}ms seedHonored=${receipt.samples.seedHonored}`,
  )
  return finish()
}
