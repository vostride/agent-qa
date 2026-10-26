import { join } from 'node:path'
import { asRef } from '@vostride/agent-qa-schema'
import {
  adjudicateCassetteScore, assessPanelEligibility, computeDecisionIdentity,
  createPanelIdentity, createScoringContext, extractRunCassettes, scoreCassetteReplay,
  type JudgePort, type LeafReplayResult,
} from '@vostride/agent-qa-eval'
import { DEFAULT_EVAL_CASSETTES_SUBDIR, FsCassetteStore } from '../../cassette-store.js'
import { DEFAULT_EVAL_REPLAYS_SUBDIR, FsReplayRecordStore } from '../../replay-record-store.js'
import { FsScoreStore } from '../../score-store.js'
import { makeLocalV2Handoff } from './local-handoff-fixture.js'
import { memArtifacts } from './replay-fixtures.js'

export async function panelScoreFixture(root: string, verdicts = ['different', 'different'], noConsensus = false) {
  const extracted = extractRunCassettes({ handoff: makeLocalV2Handoff(), artifacts: memArtifacts() })
    .cassettes.find(item => item.cassette.granularity === 'leaf')!
  if (extracted.cassette.granularity !== 'leaf') throw new Error('leaf required')
  const cassette = extracted.cassette
  const action = { type: 'click' as const, ref: asRef('e-continue') }
  const identity = computeDecisionIdentity(action, cassette.input.stateBefore.elements)
  const samples = Array.from({ length: noConsensus ? 3 : 1 }, (_, index) => ({
    sampleIndex: index, durationMs: 0,
    outcome: { kind: 'decision' as const, action,
      identity: { ...identity, target: { role: 'button', nameNormalized: `candidate ${index}`, ordinal: 0 } } },
  }))
  const outcome: LeafReplayResult = { granularity: 'leaf', cassetteId: cassette.id,
    briefSource: 'empty', samples,
    agreement: { k: samples.length, agreementRate: noConsensus ? 1 / 3 : 1,
      modal: { identity: samples[0].outcome.identity, count: 1 }, noConsensus, harnessErrorCount: 0 },
    modalDecision: samples[0].outcome.identity,
    promptDrift: { drift: false, harnessDrift: false, recordedHash: cassette.receipt.promptInputHash,
      recomputedHash: cassette.receipt.promptInputHash },
    replayedModel: { provider: 'fixture', modelId: 'gpt-5' },
    unconsumedExchanges: [], totalDurationMs: 0 }
  const memberIds = ['claude-sonnet-4-5', 'gemini-2.5-pro', 'llama-3.3'].slice(0, verdicts.length)
  const judge = createPanelIdentity(memberIds)
  const ports: JudgePort[] = memberIds.map((judgeModelId, index) => ({ judgeModelId, async call() {
    return verdicts[index] === 'error'
      ? { kind: 'call-error', reason: 'provider-error', detail: 'fixture failure', usage: { calls: 1 } }
      : { kind: 'verdict', verdict: verdicts[index] as 'different' | 'equivalent' | 'unsure',
        confidence: 'high', rationale: 'fixture', usage: { calls: 1, inputTokens: 10, outputTokens: 5 } }
  } }))
  const adjudicated = await adjudicateCassetteScore({ cassette, outcome,
    score: scoreCassetteReplay(cassette, outcome),
    eligibility: assessPanelEligibility({ memberModelIds: memberIds, replayedModelId: 'gpt-5' }),
    port: ports.length === 1 ? ports[0] : { judgeModelId: judge.judgeModelId, members: ports } })
  const judgeRequest = { judgeModelId: judge.judgeModelId, allowSameFamily: false }
  const record = { cassetteId: cassette.id, matcherVersion: 1, diffs: [], ...adjudicated,
    scoringContext: createScoringContext({ cassette, outcome, ...adjudicated, judgeRequest }) }
  const cassettesRoot = join(root, DEFAULT_EVAL_CASSETTES_SUBDIR)
  const replaysRoot = join(root, DEFAULT_EVAL_REPLAYS_SUBDIR)
  new FsCassetteStore({ root }).write(extracted)
  new FsReplayRecordStore({ root }).save(outcome)
  const written = new FsScoreStore({ root }).save(record)
  return { cassette, outcome, record, written, cassettesRoot, replaysRoot, judgeRequest }
}
