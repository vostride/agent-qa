import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { asRef } from '@vostride/agent-qa-schema'
import {
  adjudicateCassetteScore, buildEvalReport, computeDecisionIdentity,
  extractRunCassettes, scoreCassetteReplay,
  createScoringContext, JUDGE_CONFIG, type LeafReplayResult,
} from '@vostride/agent-qa-eval'
import {
  DEFAULT_EVAL_CASSETTES_SUBDIR, DEFAULT_EVAL_REPLAYS_SUBDIR, FsCassetteStore, FsReplayRecordStore, FsScoreStore,
  assembleScoredBatch, loadScoreRecord,
} from '../index.js'
import { makeLocalV2Handoff } from './fixtures/local-handoff-fixture.js'
import { memArtifacts } from './fixtures/replay-fixtures.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

async function fixture(verdict: 'equivalent' | 'different' | 'unsure' | 'error' | 'not-invoked') {
  const root = mkdtempSync(join(tmpdir(), 'score-context-')); roots.push(root)
  const goldAction = { type: 'fill' as const, ref: asRef('e-continue'),
    text: 'alpha beta gamma delta', clearMode: 'replace' as const, submit: false }
  const handoff = makeLocalV2Handoff()
  handoff.tests[0]!.steps[0]!.subActions[0]!.plannedAction = goldAction
  const extracted = extractRunCassettes({ handoff, artifacts: memArtifacts() })
    .cassettes.find(item => item.cassette.granularity === 'leaf')!
  if (extracted.cassette.granularity !== 'leaf') throw new Error('leaf required')
  const cassette = extracted.cassette
  const action = { ...goldAction, text: 'alpha beta epsilon zeta' }
  const identity = computeDecisionIdentity(action, cassette.input.stateBefore.elements)
  const outcome: LeafReplayResult = { granularity: 'leaf', cassetteId: cassette.id, briefSource: 'empty',
    samples: [{ sampleIndex: 0, outcome: { kind: 'decision', action, identity }, durationMs: 0 }],
    agreement: { k: 1, agreementRate: 1, modal: { identity, count: 1 }, noConsensus: false, harnessErrorCount: 0 },
    modalDecision: identity, promptDrift: { drift: false, harnessDrift: false,
      recordedHash: 'a'.repeat(64), recomputedHash: 'a'.repeat(64) },
    replayedModel: { provider: 'fixture', modelId: 'gpt-5' }, unconsumedExchanges: [], totalDurationMs: 0 }
  const score = scoreCassetteReplay(cassette, outcome)
  expect(score).toMatchObject({ kind: 'leaf', entry: { kind: 'decision', score: { kind: 'unresolved-tie', cause: 'value-mid-band' } } })
  const adjudicated = await adjudicateCassetteScore({ cassette, outcome, score,
    eligibility: verdict === 'not-invoked' ? { eligible: false, reason: 'no-judge-configured' }
      : { eligible: true, judgeModelId: 'claude-sonnet-4-5', judgeFamily: 'claude' },
    ...(verdict === 'not-invoked' ? {} : { port: { judgeModelId: 'claude-sonnet-4-5', async call() {
      return verdict === 'error' ? { kind: 'call-error' as const, reason: 'provider-error' as const, detail: 'scripted failure' }
        : { kind: 'verdict' as const, verdict, confidence: 'high' as const, rationale: 'scripted',
          usage: { calls: 1, inputTokens: 10, outputTokens: 5 } }
    } } }) })
  const cassettesRoot = join(root, DEFAULT_EVAL_CASSETTES_SUBDIR)
  const replaysRoot = join(root, DEFAULT_EVAL_REPLAYS_SUBDIR)
  new FsCassetteStore({ root }).write(extracted)
  new FsReplayRecordStore({ root }).save(outcome)
  const judgeRequest = verdict === 'not-invoked' ? null : { judgeModelId: 'claude-sonnet-4-5', allowSameFamily: false }
  const record = { cassetteId: cassette.id, matcherVersion: 1, diffs: [], ...adjudicated,
    scoringContext: createScoringContext({ cassette, outcome, ...adjudicated, judgeRequest }) }
  new FsScoreStore({ root }).save(record)
  const assemble = () => assembleScoredBatch({ replaysRoot, cassettesRoot })
  return { root, replaysRoot, cassettesRoot, cassette, outcome, record, assemble }
}

it.each(['equivalent', 'different', 'unsure', 'error', 'not-invoked'] as const)(
  'preserves compatible %s adjudication and incurred usage', async verdict => {
    const f = await fixture(verdict)
    const expected = [{ cassetteId: f.cassette.id, outcome: f.outcome, score: f.record.score, label: f.cassette.label }]
    const batch = f.assemble()
    expect(batch.entries[0]!.score).toEqual(f.record.score)
    expect(buildEvalReport(batch.entries).honesty).toEqual(buildEvalReport(expected).honesty)
  })

it.each(['replay', 'matcher', 'judge-version', 'judge-threshold', 'tampered-score'] as const)(
  'refuses %s compatibility while retaining incurred usage without a current settled verdict', async change => {
    const f = await fixture('equivalent')
    const old = structuredClone(f.record)
    if (change === 'replay') {
      const replay = structuredClone(f.outcome); replay.totalDurationMs = 17
      new FsReplayRecordStore({ root: f.root }).save(replay)
    }
    if (change === 'matcher') old.matcherVersion = 2
    if (change === 'judge-version') {
      old.judge!.judgeVersion = JUDGE_CONFIG.judgeVersion + 1
      expect(old.judge!.judgeVersion).not.toBe(JUDGE_CONFIG.judgeVersion)
    }
    if (change === 'judge-threshold') old.judge!.confidenceThreshold = 'medium'
    if (change === 'tampered-score') old.score = scoreCassetteReplay(f.cassette, f.outcome)
    new FsScoreStore({ root: f.root }).save(old)
    const batch = f.assemble()
    expect(batch.entries[0]!.score).toMatchObject({ entry: { kind: 'never-scored', reason: 'stale-scoring-context' } })
    const report = buildEvalReport(batch.entries)
    expect(report.headline.firstAttemptDecisionAccuracy.denominator).toBe(0)
    expect(report.honesty.judge.settled['value-mid-band']).toBe(0)
    expect(report.honesty.judge.cost.calls).toBe(change === 'tampered-score' ? 0 : 2)
    expect(report.honesty.judge.cost.inputTokens).toBe(change === 'tampered-score' ? 0 : 20)
    expect(batch.judgeBlocks).toEqual([])
  })

it('rejects a malformed present scoring context on read', async () => {
  const f = await fixture('equivalent')
  const written = new FsScoreStore({ root: f.root }).save(f.record)
  const raw = JSON.parse(readFileSync(written.file, 'utf8'))
  raw.scoringContext.unrecognized = true
  writeFileSync(written.file, JSON.stringify(raw))
  expect(loadScoreRecord(written.dir)).toMatchObject({ kind: 'refused', refusal: { reason: 'parse-failed' } })
})
