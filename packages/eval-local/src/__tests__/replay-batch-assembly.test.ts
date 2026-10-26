import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildEvalReport, extractRunCassettes, JUDGE_CONFIG, resolveProductPartition,
} from '@vostride/agent-qa-eval'
import type { JudgeIdentityBlock, LeafReplayResult } from '@vostride/agent-qa-eval'
import { afterEach, describe, expect, it } from 'vitest'

import * as evalLocal from '../index.js'
import type { ScoreRecord } from '../score-store.js'
import { makeLocalV2Handoff } from './fixtures/local-handoff-fixture.js'
import { memArtifacts } from './fixtures/replay-fixtures.js'

const tempRoots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'replay-batch-assembly-'))
  tempRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function leafFixture() {
  const leaf = extractRunCassettes({
    handoff: makeLocalV2Handoff(),
    artifacts: memArtifacts(),
  }).cassettes.find(entry => entry.cassette.granularity === 'leaf')
  if (leaf === undefined || leaf.cassette.granularity !== 'leaf') {
    throw new Error('expected a fixture leaf')
  }
  return { ...leaf, cassette: leaf.cassette }
}

function leafOutcome(cassetteId: string): LeafReplayResult {
  return {
    granularity: 'leaf',
    briefSource: 'empty',
    cassetteId,
    samples: [],
    agreement: { k: 0, agreementRate: 0, noConsensus: true, harnessErrorCount: 0 },
    promptDrift: { drift: false, harnessDrift: false, recordedHash: 'a'.repeat(64), recomputedHash: 'a'.repeat(64) },
    replayedModel: { provider: 'null', modelId: 'null-adapter' },
    unconsumedExchanges: [],
    totalDurationMs: 0,
  }
}

describe('assembleScoredBatch', () => {
  it('reads historical unstamped replays without inventing brief provenance or NaN counters', async () => {
    const root = await tempRoot()
    const replaysRoot = join(root, 'replays')
    const store = new evalLocal.FsReplayRecordStore({ root, outputDir: replaysRoot })
    const legacy = leafOutcome('legacy-leaf')
    legacy.promptDrift.drift = true
    const written = store.save(legacy)
    const { briefSource, ...unstamped } = legacy
    Reflect.deleteProperty(unstamped.promptDrift, 'harnessDrift')
    expect(briefSource).toBe('empty')
    writeFileSync(written.file, JSON.stringify(unstamped))
    const current = leafOutcome('current-leaf')
    current.promptDrift.drift = true
    store.save(current)
    for (const cassetteId of [legacy.cassetteId, current.cassetteId]) {
      new evalLocal.FsScoreStore({ root, outputDir: replaysRoot }).save({
        cassetteId, matcherVersion: 1, diffs: [],
        score: { kind: 'leaf', cassetteId, entry: { kind: 'decision', decisionOrdinal: 0,
          score: { kind: 'miss-by-failure', reason: 'no action', matcherVersion: 1 } } },
      })
    }
    store.save({
      kind: 'integrity-refusal', cassetteId: 'historical-refusal',
      reason: 'unsupported-brief', detail: 'recorded before brief rendering',
    })
    const batch = evalLocal.assembleScoredBatch({
      replaysRoot, cassettesRoot: join(root, 'cassettes'),
    })
    const report = buildEvalReport(batch.entries)
    expect(batch.entries.find(entry => entry.cassetteId === legacy.cassetteId)!.outcome)
      .not.toHaveProperty('briefSource')
    expect(report.briefSourceCounts).toEqual({ proof: 0, rendered: 0, empty: 1 })
    expect(report.headline.perDecisionCost.decisionCount).toBe(2)
    expect(report.honesty.refusalCounts['unsupported-brief']).toBe(1)
    expect(report.promptDriftRate).toEqual({ numerator: 1, denominator: 2, rate: 0.5 })
    expect(report.headline.firstAttemptDecisionAccuracy).toEqual({ numerator: 0, denominator: 2, rate: 0 })
  })

  it('joins labels and persisted scores while retaining a corrupt replay as a refusal entry', async () => {
    expect(evalLocal.assembleScoredBatch).toBeTypeOf('function')
    const root = await tempRoot()
    const replaysRoot = join(root, 'repeat', 'replays')
    const cassettesRoot = join(root, 'corpus', 'cassettes')
    const leaf = leafFixture()
    new evalLocal.FsCassetteStore({ root, outputDir: cassettesRoot }).write(leaf)
    const recordStore = new evalLocal.FsReplayRecordStore({ root, outputDir: replaysRoot })
    const scoredOutcome = leafOutcome(leaf.cassette.id)
    const unscoredOutcome = leafOutcome('unbundled/leaf')
    recordStore.save(scoredOutcome)
    recordStore.save(unscoredOutcome)
    const judge: JudgeIdentityBlock = {
      judgeModelId: 'claude-judge-stub',
      judgeFamily: 'claude',
      judgeVersion: JUDGE_CONFIG.judgeVersion,
      confidenceThreshold: 'high',
    }
    const record: ScoreRecord = {
      cassetteId: leaf.cassette.id,
      matcherVersion: 1,
      score: {
        kind: 'leaf',
        cassetteId: leaf.cassette.id,
        entry: {
          kind: 'decision',
          decisionOrdinal: 0,
          score: { kind: 'miss-by-failure', reason: 'no-decision-sample', matcherVersion: 1 },
        },
      },
      diffs: [],
      judge,
    }
    new evalLocal.FsScoreStore({ root, outputDir: replaysRoot }).save(record)
    const corruptDir = join(replaysRoot, 'corrupt')
    mkdirSync(corruptDir)
    writeFileSync(join(corruptDir, evalLocal.REPLAY_RECORD_FILE), '{invalid')

    const result = evalLocal.assembleScoredBatch({ replaysRoot, cassettesRoot })

    expect(result.entries).toHaveLength(3)
    expect(result.entries.find(entry => entry.cassetteId === leaf.cassette.id)).toEqual({
      cassetteId: leaf.cassette.id,
      outcome: scoredOutcome,
      score: record.score,
      label: leaf.cassette.label,
      product: resolveProductPartition(leaf.cassette.input.servedBrief.scope),
    })
    expect(result.entries.find(entry => entry.cassetteId === unscoredOutcome.cassetteId)).toEqual({
      cassetteId: unscoredOutcome.cassetteId,
      outcome: unscoredOutcome,
    })
    expect(result.entries.find(entry => entry.cassetteId === 'corrupt')).toEqual({
      cassetteId: 'corrupt',
      outcome: expect.objectContaining({ kind: 'integrity-refusal', reason: 'parse-failed' }),
    })
    expect(result.judgeBlocks).toEqual([judge])
    expect(result.partitionsById).toEqual(
      new Map([[leaf.cassette.id, resolveProductPartition(leaf.cassette.input.servedBrief.scope)]]),
    )
    expect(result.missingBundleCount).toBe(2)
    expect(result.notices).toEqual([
      expect.stringContaining(`replay record read refused under ${corruptDir}:`),
    ])
  })

  it('reports refused bundle and score reads without discarding the replay outcome', async () => {
    expect(evalLocal.assembleScoredBatch).toBeTypeOf('function')
    const root = await tempRoot()
    const cassettesRoot = join(root, 'cassettes')
    mkdirSync(cassettesRoot)
    writeFileSync(join(cassettesRoot, evalLocal.CASSETTE_FILE), '{invalid')
    const replaysRoot = join(root, 'replays')
    const outcome = leafOutcome('unbundled/leaf')
    const written = new evalLocal.FsReplayRecordStore({ root, outputDir: replaysRoot }).save(outcome)
    writeFileSync(join(written.dir, evalLocal.SCORE_FILE), '{invalid')

    const result = evalLocal.assembleScoredBatch({ replaysRoot, cassettesRoot })

    expect(result.entries).toEqual([{ cassetteId: outcome.cassetteId, outcome }])
    expect(result.judgeBlocks).toEqual([])
    expect(result.partitionsById.size).toBe(0)
    expect(result.missingBundleCount).toBe(1)
    expect(result.notices).toEqual([
      expect.stringContaining(`staged bundle read refused under ${cassettesRoot}:`),
      expect.stringContaining(`score read refused under ${written.dir}:`),
    ])
  })

  it('retains a persisted replay refusal when neither a score nor a bundle exists', async () => {
    expect(evalLocal.assembleScoredBatch).toBeTypeOf('function')
    const root = await tempRoot()
    const outcome = {
      kind: 'integrity-refusal' as const,
      cassetteId: 'refused/leaf',
      reason: 'missing-blob' as const,
      detail: 'Missing fixture blob',
    }
    new evalLocal.FsReplayRecordStore({ root, outputDir: root }).save(outcome)

    const result = evalLocal.assembleScoredBatch({
      replaysRoot: root,
      cassettesRoot: join(root, 'absent'),
    })

    expect(result.entries).toEqual([{ cassetteId: outcome.cassetteId, outcome }])
    expect(result.missingBundleCount).toBe(1)
    expect(result.notices).toEqual([])
  })
})

describe('cassetteProductPartition', () => {
  it('uses the canonical product partition of the leaf served-brief scope', () => {
    expect(evalLocal.cassetteProductPartition).toBeTypeOf('function')
    const leaf = leafFixture().cassette
    leaf.input.servedBrief.scope = { tier: 'product', key: 'fixture-shop' }

    expect(evalLocal.cassetteProductPartition(leaf)).toBe(
      resolveProductPartition(leaf.input.servedBrief.scope),
    )
    expect(evalLocal.cassetteProductPartition(leaf)).toBe('fixture-shop')
  })

  it('reads the first decision in a procedure and defaults when no decision exists', () => {
    expect(evalLocal.cassetteProductPartition).toBeTypeOf('function')
    const procedure = extractRunCassettes({
      handoff: makeLocalV2Handoff(),
      artifacts: memArtifacts(),
    }).cassettes.find(entry => entry.cassette.granularity === 'procedure')?.cassette
    if (procedure === undefined || procedure.granularity !== 'procedure') {
      throw new Error('expected a fixture procedure')
    }
    const first = procedure.steps.find(step => step.kind === 'decision')
    if (first === undefined || first.kind !== 'decision') throw new Error('expected a decision')
    first.record.input.servedBrief.scope = { tier: 'product', key: 'procedure-shop' }

    expect(evalLocal.cassetteProductPartition(procedure)).toBe('procedure-shop')
    expect(evalLocal.cassetteProductPartition({ ...procedure, steps: [] })).toBe('default')
  })
})
