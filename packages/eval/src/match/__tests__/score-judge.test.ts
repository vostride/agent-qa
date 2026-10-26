import { describe, expect, it } from 'vitest'

import { MATCHER_CONFIG } from '../config'
import { isDecisionFullMatch } from '../score'
import type {
  DecisionAxes,
  DecisionPartialBreakdown,
  DecisionScore,
  JudgeAbstentionCause,
  JudgeErrorReason,
  JudgeNotInvokedReason,
  JudgeOutcome,
  JudgeSettled,
} from '../score'

function breakdown(axes?: Partial<DecisionAxes>): DecisionPartialBreakdown {
  return {
    axes: {
      elementIdentity: { kind: 'scored', level: 'full', numeric: 1, tier: 2 },
      opClass: { kind: 'match', opClass: 'activate' },
      value: { kind: 'scored', f1: 1, band: 'full' },
      ...axes,
    },
    loop: { kind: 'not-applicable' },
    tierReached: 2,
  }
}

function scored(
  partial: DecisionPartialBreakdown,
  judgeSettled?: JudgeSettled,
): Extract<DecisionScore, { kind: 'scored' }> {
  return {
    kind: 'scored',
    ...partial,
    matcherVersion: MATCHER_CONFIG.matcherVersion,
    ...(judgeSettled === undefined ? {} : { judgeSettled }),
  }
}

const valueStamp: JudgeSettled = {
  axis: 'value',
  resolution: 'equivalent',
  cause: 'value-mid-band',
  judgeId: 'stub-judge-model',
  judgeVersion: 1,
  confidence: 'high',
}

describe('isDecisionFullMatch judge-stamp overlay', () => {
  it('upgrades a mid-band value to full match when a value-equivalent stamp is present', () => {
    const score = scored(
      breakdown({ value: { kind: 'scored', f1: 0.6, band: 'mid' } }),
      valueStamp,
    )
    expect(isDecisionFullMatch(score)).toBe(true)
  })

  it('fails the base rule for the same mid-band decision without a stamp', () => {
    const score = scored(breakdown({ value: { kind: 'scored', f1: 0.6, band: 'mid' } }))
    expect(isDecisionFullMatch(score)).toBe(false)
  })

  it('never upgrades on a resolution of different', () => {
    const score = scored(
      breakdown({ value: { kind: 'scored', f1: 0.6, band: 'mid' } }),
      { ...valueStamp, resolution: 'different' },
    )
    expect(isDecisionFullMatch(score)).toBe(false)
  })

  it('upgrades exactly the stamped axis, never a sibling axis', () => {
    const identityPartial = scored(
      breakdown({
        elementIdentity: {
          kind: 'scored',
          level: 'ordinal-only-differs',
          numeric: 0.75,
          tier: 2,
        },
      }),
      valueStamp,
    )
    expect(isDecisionFullMatch(identityPartial)).toBe(false)
  })

  it('upgrades a partial identity level with an element-identity stamp while the axis verdict stays untouched', () => {
    const identityStamp: JudgeSettled = {
      axis: 'element-identity',
      resolution: 'equivalent',
      cause: 'partial-identity',
      judgeId: 'stub-judge-model',
      judgeVersion: 1,
      confidence: 'high',
    }
    const score = scored(
      breakdown({
        elementIdentity: {
          kind: 'scored',
          level: 'ordinal-only-differs',
          numeric: 0.75,
          tier: 2,
        },
      }),
      identityStamp,
    )
    expect(isDecisionFullMatch(score)).toBe(true)
    expect(score.axes.elementIdentity).toEqual({
      kind: 'scored',
      level: 'ordinal-only-differs',
      numeric: 0.75,
      tier: 2,
    })
  })
})

function judgeOutcomeLabel(outcome: JudgeOutcome): string {
  switch (outcome.kind) {
    case 'abstained':
      return `abstained:${outcome.cause}`
    case 'judge-error':
      return `judge-error:${outcome.reason}`
    case 'not-invoked':
      return `not-invoked:${outcome.reason}`
  }
}

describe('JudgeOutcome closed union', () => {
  it('constructs every abstention cause', () => {
    const causes: readonly JudgeAbstentionCause[] = [
      'unsure-verdict',
      'below-threshold',
      'swap-disagreement',
      'candidate-overflow',
      'missing-evidence',
      'residual-tie',
    ]
    for (const cause of causes) {
      const outcome: JudgeOutcome = {
        kind: 'abstained',
        cause,
        confidence: 'low',
        judgeId: 'stub-judge-model',
        judgeVersion: 1,
      }
      expect(judgeOutcomeLabel(outcome)).toBe(`abstained:${cause}`)
    }
  })

  it('constructs every judge-error reason distinct from abstention', () => {
    const reasons: readonly JudgeErrorReason[] = ['provider-error', 'unparseable-output']
    for (const reason of reasons) {
      const outcome: JudgeOutcome = {
        kind: 'judge-error',
        reason,
        detail: 'stubbed failure evidence',
        judgeId: 'stub-judge-model',
        judgeVersion: 1,
      }
      expect(judgeOutcomeLabel(outcome)).toBe(`judge-error:${reason}`)
    }
  })

  it('constructs every not-invoked reason, carrying optional plain-string families', () => {
    const reasons: readonly JudgeNotInvokedReason[] = [
      'no-judge-configured',
      'no-eligible-judge',
    ]
    for (const reason of reasons) {
      const outcome: JudgeOutcome = { kind: 'not-invoked', reason }
      expect(judgeOutcomeLabel(outcome)).toBe(`not-invoked:${reason}`)
    }
    const withFamilies: JudgeOutcome = {
      kind: 'not-invoked',
      reason: 'no-eligible-judge',
      families: { judge: 'openai', replayed: 'openai', recorded: 'claude' },
    }
    expect(judgeOutcomeLabel(withFamilies)).toBe('not-invoked:no-eligible-judge')
  })
})

describe('unresolved-tie shape invariance', () => {
  it('remains constructible exactly as 369 shaped it, with no judgeOutcome field', () => {
    const tie: DecisionScore = {
      kind: 'unresolved-tie',
      cause: 'value-mid-band',
      partial: breakdown({ value: { kind: 'scored', f1: 0.6, band: 'mid' } }),
      matcherVersion: MATCHER_CONFIG.matcherVersion,
    }
    expect(tie.kind).toBe('unresolved-tie')
    expect('judgeOutcome' in tie).toBe(false)
    expect(isDecisionFullMatch(tie)).toBe(false)
  })

  it('optionally carries a typed judgeOutcome stamp', () => {
    const tie: DecisionScore = {
      kind: 'unresolved-tie',
      cause: 'partial-identity',
      matcherVersion: MATCHER_CONFIG.matcherVersion,
      judgeOutcome: {
        kind: 'abstained',
        cause: 'swap-disagreement',
        judgeId: 'stub-judge-model',
        judgeVersion: 1,
      },
    }
    expect(tie.judgeOutcome?.kind).toBe('abstained')
  })
})
