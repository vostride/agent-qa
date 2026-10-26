import { asRef } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import type { LeafReplayResult, ReplaySample } from '../../replay/result'
import { MATCHER_CONFIG } from '../config'
import { buildEvalReport } from '../metrics'
import type { ScoredBatchEntry } from '../metrics'
import type {
  DecisionPartialBreakdown,
  DecisionScore,
  JudgeIdentityBlock,
  JudgeOutcome,
  JudgeSettled,
  TieCause,
  ValueAxisVerdict,
} from '../score'

const identity = {
  opClass: 'click',
  target: { role: 'button', nameNormalized: 'log in', ordinal: 0 },
} as const
const action = { type: 'click', ref: asRef('e2') } as const

const midValue: ValueAxisVerdict = { kind: 'scored', f1: 0.6, band: 'mid' }

function sample(
  sampleIndex: number,
  durationMs: number,
  tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number },
): ReplaySample {
  return {
    sampleIndex,
    outcome: { kind: 'decision', action, identity },
    durationMs,
    ...(tokenUsage === undefined ? {} : { tokenUsage }),
  }
}

function leafOutcome(cassetteId: string, samples?: ReplaySample[]): LeafReplayResult {
  const resolved = samples ?? [sample(0, 10)]
  return {
    granularity: 'leaf',
    briefSource: 'empty',
    cassetteId,
    samples: resolved,
    agreement: {
      k: resolved.length,
      agreementRate: 1,
      noConsensus: false,
      harnessErrorCount: 0,
    },
    promptDrift: {
      drift: false,
      harnessDrift: false,
      recordedHash: 'recorded-hash',
      recomputedHash: 'recorded-hash',
    },
    replayedModel: { provider: 'test', modelId: 'model-1' },
    unconsumedExchanges: [],
    totalDurationMs: resolved.reduce((total, item) => total + item.durationMs, 0),
  }
}

function breakdown(value: ValueAxisVerdict = { kind: 'not-applicable' }): DecisionPartialBreakdown {
  return {
    axes: {
      elementIdentity: { kind: 'scored', level: 'full', numeric: 1, tier: 2 },
      opClass: { kind: 'match', opClass: 'activate' },
      value,
    },
    loop: { kind: 'none' },
    tierReached: 2,
  }
}

function stamp(overrides: Partial<JudgeSettled> = {}): JudgeSettled {
  return {
    axis: 'value',
    resolution: 'equivalent',
    cause: 'value-mid-band',
    judgeId: 'fam-x:1',
    judgeVersion: 1,
    confidence: 'high',
    ...overrides,
  }
}

function settledScore(value?: ValueAxisVerdict): DecisionScore {
  return {
    kind: 'scored',
    ...breakdown(value),
    matcherVersion: MATCHER_CONFIG.matcherVersion,
  }
}

function judgeSettledScore(judgeSettled: JudgeSettled, value: ValueAxisVerdict = midValue): DecisionScore {
  return {
    kind: 'scored',
    judgeSettled,
    ...breakdown(value),
    matcherVersion: MATCHER_CONFIG.matcherVersion,
  }
}

function tieScore(cause: TieCause, judgeOutcome?: JudgeOutcome): DecisionScore {
  return {
    kind: 'unresolved-tie',
    cause,
    partial: breakdown(),
    ...(judgeOutcome === undefined ? {} : { judgeOutcome }),
    matcherVersion: MATCHER_CONFIG.matcherVersion,
  }
}

function scoredEntry(
  cassetteId: string,
  score: DecisionScore,
  samples?: ReplaySample[],
): ScoredBatchEntry {
  return {
    cassetteId,
    outcome: leafOutcome(cassetteId, samples),
    score: {
      kind: 'leaf',
      cassetteId,
      entry: { kind: 'decision', decisionOrdinal: 0, score },
    },
  }
}

const zeroTieCauseCounts = {
  'partial-identity': 0,
  'value-mid-band': 0,
  'no-consensus': 0,
} as const

describe('buildEvalReport judge honesty surface', () => {
  it('folds panel cost only from top-level usage and preserves decision-grain counters', () => {
    const members = [
      { judgeModelId: 'claude-judge', judgeFamily: 'claude', outcome: { kind: 'error', reason: 'provider-error', detail: 'failed' }, usage: { calls: 2 } },
      { judgeModelId: 'gemini-judge', judgeFamily: 'gemini', outcome: { kind: 'abstained', cause: 'unsure-verdict' }, usage: { calls: 2, inputTokens: 10 } },
    ] as const
    const report = buildEvalReport([scoredEntry('panel-tie', tieScore('partial-identity', {
      kind: 'abstained', cause: 'below-quorum', judgeId: 'panel:claude+gemini', judgeVersion: 2,
      members, usage: { calls: 4, inputTokens: 10 },
    }))])
    expect(report.honesty.judge.invoked['partial-identity']).toBe(1)
    expect(report.honesty.judge.abstained['partial-identity']).toBe(1)
    expect(report.honesty.judge.errors['partial-identity']).toBe(0)
    expect(report.honesty.judge.cost).toEqual({ calls: 4, inputTokens: 10, outputTokens: 0, outcomesMissingUsage: 0 })
    const zero = buildEvalReport([scoredEntry('no-tie', settledScore())])
    expect(zero.honesty.judge.invoked).toEqual(zeroTieCauseCounts)
    expect(zero.honesty.judge.cost).toEqual({ calls: 0, inputTokens: 0, outputTokens: 0, outcomesMissingUsage: 0 })
  })
  it('counts every judge disposition per cause and not-invoked per reason', () => {
    const report = buildEvalReport([
      scoredEntry('settled', judgeSettledScore(stamp())),
      scoredEntry(
        'abstained',
        tieScore('partial-identity', {
          kind: 'abstained',
          cause: 'residual-tie',
          judgeId: 'fam-x:1',
          judgeVersion: 1,
        }),
      ),
      scoredEntry(
        'errored',
        tieScore('no-consensus', {
          kind: 'judge-error',
          reason: 'provider-error',
          detail: 'transport failed',
          judgeId: 'fam-x:1',
          judgeVersion: 1,
        }),
      ),
      scoredEntry(
        'gap',
        tieScore('value-mid-band', {
          kind: 'not-invoked',
          reason: 'no-eligible-judge',
          families: { judge: 'fam-x', replayed: 'fam-y' },
        }),
      ),
      scoredEntry('plain-tie', tieScore('partial-identity')),
    ])

    expect(report.honesty.judge.settled).toEqual({
      'partial-identity': 0,
      'value-mid-band': 1,
      'no-consensus': 0,
    })
    expect(report.honesty.judge.abstained).toEqual({
      'partial-identity': 1,
      'value-mid-band': 0,
      'no-consensus': 0,
    })
    expect(report.honesty.judge.errors).toEqual({
      'partial-identity': 0,
      'value-mid-band': 0,
      'no-consensus': 1,
    })
    expect(report.honesty.judge.invoked).toEqual({
      'partial-identity': 1,
      'value-mid-band': 1,
      'no-consensus': 1,
    })
    expect(report.honesty.judge.notInvoked).toEqual({
      'no-judge-configured': 0,
      'no-eligible-judge': 1,
    })
    expect(report.honesty.tieCounts).toEqual({
      'partial-identity': 2,
      'value-mid-band': 1,
      'no-consensus': 1,
    })
    expect(report.honesty.judge.cost).toEqual({
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      outcomesMissingUsage: 3,
    })
  })

  it('keeps one headline: settled-equivalent enters the numerator, different only the denominator', () => {
    const report = buildEvalReport([
      scoredEntry('settled-equivalent', judgeSettledScore(stamp())),
      scoredEntry('settled-different', judgeSettledScore(stamp({ resolution: 'different' }))),
      scoredEntry('plain-full', settledScore()),
      scoredEntry('surviving-tie', tieScore('value-mid-band')),
    ])

    expect(report.headline.firstAttemptDecisionAccuracy).toEqual({
      numerator: 2,
      denominator: 3,
      rate: 2 / 3,
    })
  })

  it('aggregates judge usage as a distinct cost component folded into per-decision cost', () => {
    const report = buildEvalReport([
      scoredEntry(
        'settled',
        judgeSettledScore(stamp({ usage: { calls: 2, inputTokens: 100, outputTokens: 20 } })),
        [sample(0, 10, { promptTokens: 10, completionTokens: 5, totalTokens: 15 })],
      ),
      scoredEntry(
        'abstained',
        tieScore('partial-identity', {
          kind: 'abstained',
          cause: 'below-threshold',
          judgeId: 'fam-x:1',
          judgeVersion: 1,
          usage: { calls: 2, inputTokens: 80, outputTokens: 10 },
        }),
        [sample(0, 10, { promptTokens: 20, completionTokens: 5, totalTokens: 25 })],
      ),
    ])

    expect(report.honesty.judge.cost).toEqual({
      calls: 4,
      inputTokens: 180,
      outputTokens: 30,
      outcomesMissingUsage: 0,
    })
    expect(report.totalCost.promptTokens).toBe(30)
    expect(report.totalCost.completionTokens).toBe(10)
    expect(report.totalCost.totalTokens).toBe(40)
    expect(report.headline.perDecisionCost).toEqual({
      decisionCount: 2,
      promptTokens: (30 + 180) / 2,
      completionTokens: (10 + 30) / 2,
      totalTokens: (40 + 180 + 30) / 2,
      durationMs: 10,
    })
  })

  it('never fabricates usage: absent usage counts as missing and contributes zero tokens', () => {
    const report = buildEvalReport([
      scoredEntry(
        'no-usage-settled',
        judgeSettledScore(stamp()),
        [sample(0, 12, { promptTokens: 10, completionTokens: 5, totalTokens: 15 })],
      ),
      scoredEntry(
        'no-usage-abstained',
        tieScore('partial-identity', {
          kind: 'abstained',
          cause: 'unsure-verdict',
          judgeId: 'fam-x:1',
          judgeVersion: 1,
        }),
      ),
      scoredEntry('calls-only', judgeSettledScore(stamp({ usage: { calls: 3 } }))),
    ])

    expect(report.honesty.judge.cost).toEqual({
      calls: 3,
      inputTokens: 0,
      outputTokens: 0,
      outcomesMissingUsage: 2,
    })
    expect(report.headline.perDecisionCost.promptTokens).toBe(10 / 3)
    expect(report.headline.perDecisionCost.completionTokens).toBe(5 / 3)
    expect(report.headline.perDecisionCost.totalTokens).toBe(15 / 3)
  })

  it('surfaces the judge identity block verbatim exactly when supplied', () => {
    const block: JudgeIdentityBlock = {
      judgeModelId: 'model-x',
      judgeFamily: 'fam-x',
      judgeVersion: 1,
      confidenceThreshold: 'high',
    }
    const entries = [scoredEntry('one', settledScore())]

    const withBlock = buildEvalReport(entries, block)
    expect(withBlock.judge).toEqual(block)

    const withoutBlock = buildEvalReport(entries)
    expect(Object.hasOwn(withoutBlock, 'judge')).toBe(false)
  })

  it('produces a shape-uniform report with zeroed judge surface for zero-judge batches', () => {
    const report = buildEvalReport([
      scoredEntry('full', settledScore()),
      scoredEntry('tie', tieScore('partial-identity')),
    ])

    expect(report.honesty.judge).toEqual({
      invoked: zeroTieCauseCounts,
      settled: zeroTieCauseCounts,
      abstained: zeroTieCauseCounts,
      errors: zeroTieCauseCounts,
      notInvoked: { 'no-judge-configured': 0, 'no-eligible-judge': 0 },
      cost: { calls: 0, inputTokens: 0, outputTokens: 0, outcomesMissingUsage: 0 },
    })
    expect(Object.hasOwn(report, 'judge')).toBe(false)
    expect(report.honesty.tieCounts).toEqual({
      'partial-identity': 1,
      'value-mid-band': 0,
      'no-consensus': 0,
    })
    expect(report.axisDistributions.elementIdentity.full).toBe(2)
    expect(report.headline.firstAttemptDecisionAccuracy).toEqual({
      numerator: 1,
      denominator: 1,
      rate: 1,
    })
  })
})
