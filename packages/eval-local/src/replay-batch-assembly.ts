import { buildEvalReport, canonicalJson, decisionCorrectnessVectors, judgeIdentitySchema, resolveProductPartition, resolveScoringContext } from '@vostride/agent-qa-eval'
import type {
  Cassette,
  CassetteLabelLeg,
  CassetteScore,
  JudgeIdentityBlock,
  ScoredBatchEntry,
  StandaloneLabelRecord,
  ScoringJudgeRequest,
  CorpusEntry,
  EvalBatchReport,
} from '@vostride/agent-qa-eval'

import { loadCassetteBundle } from './cassette-loader.js'
import { sha256hex } from '@vostride/agent-qa-schema'
import { loadStagedReport, type ReplayGeneration } from './report-store.js'
import {
  listCassetteBundleDirs,
  listReplayRecordDirs,
  loadReplayRecord,
  loadScoreRecord,
} from './replay-read.js'

/**
 * Resolve the product partition from the recorded served-brief scope. Procedures read their
 * first decision record; a cassette with no decision maps to the typed 'default' partition.
 */
export function cassetteProductPartition(cassette: Cassette): string {
  if (cassette.granularity === 'leaf') {
    return resolveProductPartition(cassette.input.servedBrief.scope)
  }
  for (const step of cassette.steps) {
    if (step.kind === 'decision') {
      return resolveProductPartition(step.record.input.servedBrief.scope)
    }
  }
  return 'default'
}

/**
 * Assemble report inputs from the caller's replay root, joining labels and product partitions
 * from cassette bundles. Scores and judge blocks come only from persisted records; every
 * replay remains an entry, including a record that can only be read as a typed refusal.
 */
export function assembleScoredBatch(input: {
  replaysRoot: string
  cassettesRoot: string
  source: string
  /** Fresh-run callers supply only completed writes; absence retains the generic disk sweep. */
  recordDirs?: readonly string[]
  /** Committed-corpus ownership is authoritative; generic callers retain scope semantics. */
  productByCassetteId?: ReadonlyMap<string, string>
  /** Latest committed mark generations only; historical bundles remain on disk. */
  eligibleCassetteIds?: ReadonlySet<string>
  labelRecords?: ReadonlyMap<string, StandaloneLabelRecord>
  corpusEntriesById?: ReadonlyMap<string, CorpusEntry>
  excludedLabelIds?: ReadonlySet<string>
  calibration?: EvalBatchReport['calibration']
  expectedJudgeRequest?: ScoringJudgeRequest
}): {
  entries: ScoredBatchEntry[]
  judgeBlocks: JudgeIdentityBlock[]
  partitionsById: Map<string, string>
  missingBundleCount: number
  notices: string[]
  calibration?: EvalBatchReport['calibration']
} {
  const { replaysRoot, cassettesRoot, source } = input
  const notices: string[] = []

  // Only leaf cassettes carry a label leg; procedures join with partition only.
  const labelsById = new Map<string, CassetteLabelLeg>()
  const cassettesById = new Map<string, Cassette>()
  const partitionsById = new Map<string, string>()
  for (const bundleDir of listCassetteBundleDirs(cassettesRoot)) {
    const load = loadCassetteBundle(bundleDir)
    if (load.kind === 'refused') {
      notices.push(`${source} bundle read refused under ${bundleDir}: ${load.refusal.detail}`)
      continue
    }
    if (input.eligibleCassetteIds !== undefined && !input.eligibleCassetteIds.has(load.cassette.id)
      && !input.excludedLabelIds?.has(load.cassette.id)) continue
    if (load.cassette.granularity === 'leaf') {
      labelsById.set(load.cassette.id, input.labelRecords?.get(load.cassette.id)?.label ?? load.cassette.label)
    }
    cassettesById.set(load.cassette.id, load.cassette)
    const product = input.corpusEntriesById?.get(load.cassette.id)?.product ?? (input.productByCassetteId === undefined
      ? cassetteProductPartition(load.cassette)
      : input.productByCassetteId.get(load.cassette.id))
    if (product === undefined && !input.excludedLabelIds?.has(load.cassette.id)) throw new TypeError(`committed product absent for ${load.cassette.id}`)
    if (product !== undefined) partitionsById.set(load.cassette.id, product)
  }

  const entries: ScoredBatchEntry[] = []
  const judgeBlocks: JudgeIdentityBlock[] = []
  let missingBundleCount = 0
  for (const recordDir of input.recordDirs ?? listReplayRecordDirs(replaysRoot)) {
    const load = loadReplayRecord(recordDir)
    const outcome = load.kind === 'loaded' ? load.outcome : load.refusal
    if (load.kind === 'refused') {
      notices.push(`replay record read refused under ${recordDir}: ${load.refusal.detail}`)
    }
    const cassetteId = outcome.cassetteId
    if (input.eligibleCassetteIds !== undefined && !input.eligibleCassetteIds.has(cassetteId)
      && !input.excludedLabelIds?.has(cassetteId)) continue

    let score: CassetteScore | undefined
    const scoreLoad = loadScoreRecord(recordDir)
    if (scoreLoad.kind === 'loaded') {
      score = scoreLoad.record.score
    } else if (scoreLoad.kind === 'refused') {
      notices.push(`score read refused under ${recordDir}: ${scoreLoad.refusal.detail}`)
    }

    const label = labelsById.get(cassetteId)
    const authoritative = input.labelRecords?.get(cassetteId)
    const scoringExcluded = input.excludedLabelIds?.has(cassetteId) === true
      || authoritative?.quarantine !== undefined
    const corpusEntry = input.corpusEntriesById?.get(cassetteId)
    const cassette = cassettesById.get(cassetteId)
    const resolved = cassette === undefined ? undefined : resolveScoringContext({ cassette, outcome,
      labelRecord: authoritative, scoringExcluded, expectedJudgeRequest: input.expectedJudgeRequest,
      record: scoreLoad.kind === 'loaded' ? scoreLoad.record : undefined })
    if (resolved !== undefined) score = resolved.score
    if (scoringExcluded) score = undefined
    if (!scoringExcluded && scoreLoad.kind === 'loaded' && resolved?.compatible !== false && scoreLoad.record.judge !== undefined) {
      judgeBlocks.push(scoreLoad.record.judge)
    }
    const product = partitionsById.get(cassetteId)
    if (!partitionsById.has(cassetteId)) missingBundleCount++
    const incurredJudgeScore = resolved?.incurredJudgeScore
      ?? (scoringExcluded && scoreLoad.kind === 'loaded' ? scoreLoad.record.score : undefined)

    entries.push({
      cassetteId,
      logicalSourceId: authoritative?.provenance.sourceCassetteId ?? cassetteId,
      ...(authoritative?.weight === undefined ? {} : { softWeight: authoritative.weight }),
      ...(scoringExcluded ? { scoringExcluded: true } : {}),
      ...(corpusEntry === undefined ? {} : { split: corpusEntry.split,
        ...(corpusEntry.split !== 'held-out' ? {} : { heldOutVisibility: corpusEntry.heldOutVisibility }),
        // 2026-09-12, 422 D-05/D-11: the generator stamp travels with the split it belongs to,
        // read off the SAME committed entry. An entry this assembler could not resolve carries
        // neither, so the report discloses its generation as unavailable rather than absent.
        ...(corpusEntry.split !== 'adversarial' ? {} : { generator: corpusEntry.generator }) }),
      outcome,
      ...(score !== undefined ? { score } : {}),
      ...(incurredJudgeScore === undefined ? {} : { incurredJudgeScore }),
      ...(label !== undefined ? { label } : {}),
      ...(product !== undefined ? { product } : {}),
    })
  }

  return { entries, judgeBlocks, partitionsById, missingBundleCount, notices, calibration: input.calibration }
}

/** The same report/vector projection serves fresh replay and guarded measured-run recovery. */
export function projectAssembledBatch(
  batch: ReturnType<typeof assembleScoredBatch>,
  options: Parameters<typeof buildEvalReport>[3],
) {
  const { entries, partitionsById } = batch
  // Compare only the score identity contract. Later report disclosure (such as copied
  // calibration) is not part of the identity that produced these decisions.
  const judgeBlocks = batch.judgeBlocks.map(block => judgeIdentitySchema.strip().parse(block))
  if (entries.some(entry => entry.split === undefined)) {
    batch.notices.push('corpus split ownership unknown; entries without corpus metadata are unassigned')
  }
  entries.sort((a, b) => a.cassetteId < b.cassetteId ? -1 : a.cassetteId > b.cassetteId ? 1 : 0)
  let judge: JudgeIdentityBlock | undefined
  let identity: { judgeIdentity: 'mixed'; judgeModelIds: readonly string[] } | undefined
  if (judgeBlocks.length === 0) {
    batch.notices.push('no judge identity on any persisted score record — the report carries no judge block')
  } else if (judgeBlocks.every(block => canonicalJson(block) === canonicalJson(judgeBlocks[0]))) {
    judge = judgeBlocks[0]
  } else {
    identity = { judgeIdentity: 'mixed',
      judgeModelIds: [...new Set(judgeBlocks.map(block => block.judgeModelId))].sort() }
    batch.notices.push('mixed judge identities across persisted score records — the report carries no judge block')
  }
  return {
    report: buildEvalReport(entries, judge, identity, { ...options, calibration: options?.calibration ?? batch.calibration }),
    vectors: decisionCorrectnessVectors(entries, partitionsById),
    notices: batch.notices,
  }
}

/** Existing producer publication must bind the full profile to these exact saved inputs. */
export function readReportProfileProof(input: {
  agentQaRoot: string
  replaysRoot: string
  report: EvalBatchReport
  entries: readonly ScoredBatchEntry[]
  fingerprint: string
  corpusDigest: string
  seed?: number
}): { runIdentity: NonNullable<EvalBatchReport['runIdentity']>; replayGeneration: ReplayGeneration } | undefined {
  // Legacy standalone replays have no full-profile publication. A model ID is insufficient.
  if (input.seed === undefined || input.entries.length === 0) return undefined
  const loaded = loadStagedReport(input.agentQaRoot, input.report.batchKey)
  if (loaded.kind !== 'loaded' || !loaded.replayGeneration) return undefined
  const { report, replayGeneration } = loaded
  if (report.runIdentity?.fingerprint !== input.fingerprint
    || report.runIdentity.corpusDigest !== input.corpusDigest
    || report.matcherVersion !== input.report.matcherVersion
    || report.judgeIdentity === 'mixed'
    || canonicalJson(report.judge && judgeIdentitySchema.strip().parse(report.judge))
      !== canonicalJson(input.report.judge)
    || replayGeneration.seed !== input.seed
    || replayGeneration.records.length !== input.entries.length) return undefined
  const records = listReplayRecordDirs(input.replaysRoot).map(dir => ({
    replay: loadReplayRecord(dir), score: loadScoreRecord(dir),
  }))
  for (const entry of input.entries) {
    const refs = replayGeneration.records.filter(ref => ref.cassetteId === entry.cassetteId)
    const matching = records.filter(row => row.replay.kind === 'loaded' && row.replay.outcome.cassetteId === entry.cassetteId)
    if (refs.length !== 1 || matching.length !== 1) return undefined
    const row = matching[0]!, ref = refs[0]!
    if (row.replay.kind !== 'loaded' || row.score.kind !== 'loaded'
      || canonicalJson(row.replay.outcome) !== canonicalJson(entry.outcome)
      || Reflect.get(row.replay.outcome, 'executionSeed') !== input.seed
      || sha256hex(canonicalJson(row.replay.outcome)) !== ref.replayDigest
      || sha256hex(canonicalJson(row.score.record)) !== ref.scoreDigest) return undefined
  }
  return { runIdentity: report.runIdentity, replayGeneration }
}
