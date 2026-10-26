import { resolveProductPartition, resolveScoringContext } from '@vostride/agent-qa-eval'
import type {
  Cassette,
  CassetteLabelLeg,
  CassetteScore,
  JudgeIdentityBlock,
  ScoredBatchEntry,
} from '@vostride/agent-qa-eval'

import { loadCassetteBundle } from './cassette-loader.js'
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
 * from staged cassette bundles. Scores and judge blocks come only from persisted records; every
 * replay remains an entry, including a record that can only be read as a typed refusal.
 */
export function assembleScoredBatch(input: {
  replaysRoot: string
  cassettesRoot: string
  /** Fresh-run callers supply only completed writes; absence retains the generic disk sweep. */
  recordDirs?: readonly string[]
}): {
  entries: ScoredBatchEntry[]
  judgeBlocks: JudgeIdentityBlock[]
  partitionsById: Map<string, string>
  missingBundleCount: number
  notices: string[]
} {
  const { replaysRoot, cassettesRoot } = input
  const notices: string[] = []

  // Only leaf cassettes carry a label leg; procedures join with partition only.
  const labelsById = new Map<string, CassetteLabelLeg>()
  const cassettesById = new Map<string, Cassette>()
  const partitionsById = new Map<string, string>()
  for (const bundleDir of listCassetteBundleDirs(cassettesRoot)) {
    const load = loadCassetteBundle(bundleDir)
    if (load.kind === 'refused') {
      notices.push(`staged bundle read refused under ${bundleDir}: ${load.refusal.detail}`)
      continue
    }
    if (load.cassette.granularity === 'leaf') {
      labelsById.set(load.cassette.id, load.cassette.label)
    }
    cassettesById.set(load.cassette.id, load.cassette)
    partitionsById.set(load.cassette.id, cassetteProductPartition(load.cassette))
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

    let score: CassetteScore | undefined
    const scoreLoad = loadScoreRecord(recordDir)
    if (scoreLoad.kind === 'loaded') {
      score = scoreLoad.record.score
    } else if (scoreLoad.kind === 'refused') {
      notices.push(`score read refused under ${recordDir}: ${scoreLoad.refusal.detail}`)
    }

    const label = labelsById.get(cassetteId)
    const cassette = cassettesById.get(cassetteId)
    const resolved = cassette === undefined ? undefined : resolveScoringContext({ cassette, outcome,
      record: scoreLoad.kind === 'loaded' ? scoreLoad.record : undefined })
    if (resolved !== undefined) score = resolved.score
    if (scoreLoad.kind === 'loaded' && resolved?.compatible !== false && scoreLoad.record.judge !== undefined) {
      judgeBlocks.push(scoreLoad.record.judge)
    }
    const product = partitionsById.get(cassetteId)
    if (product === undefined) missingBundleCount++
    const incurredJudgeScore = resolved?.incurredJudgeScore

    entries.push({
      cassetteId,
      logicalSourceId: cassetteId,
      outcome,
      ...(score !== undefined ? { score } : {}),
      ...(incurredJudgeScore === undefined ? {} : { incurredJudgeScore }),
      ...(label !== undefined ? { label } : {}),
      ...(product !== undefined ? { product } : {}),
    })
  }

  return { entries, judgeBlocks, partitionsById, missingBundleCount, notices }
}
