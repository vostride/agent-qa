// Absent is not zero: a `?? 0` on the token path would turn an unmeasured run into a free one.

import { describe, expect, it } from 'vitest'
import type {
  RunDetailMember,
  RunDetailProjection,
  RunDetailStep,
  RunDetailSubAction,
  RunModelSummary,
  RunTokenTotals,
} from '@vostride/agent-qa-schema'
import { asRef } from '@vostride/agent-qa-schema'

import { formatTokens } from '@/lib/format'
import { DID_NOT_RUN_NOTE } from '@/lib/run-stream-reducer'
import * as view from '@/lib/run-detail-view'
import {
  DID_NOT_RUN_LABEL,
  MEMBER_FILTER_ALL,
  MODELS_HEADING,
  SCREEN_STATE_CHANGED_LABEL,
  SCREEN_STATE_UNCHANGED_LABEL,
  TOKENS_NOT_MEASURED_LABEL,
  cachedInputLine,
  filterGroups,
  groupRunDetail,
  memberNote,
  parseMemberFilter,
  reranLabel,
  screenStateChangeLabel,
  screenStateChip,
  showMemberChrome,
  tokenPairLine,
  usageCoverageLine,
  usageModelLines,
  usageTotalsLine,
} from '@/lib/run-detail-view'

function member(testIndex: number, extra: Partial<RunDetailMember> = {}): RunDetailMember {
  return { testIndex, attempts: 1, ...extra }
}

function step(testIndex: number, stepIndex: number): RunDetailStep {
  return {
    testIndex,
    stepIndex,
    cacheStatus: 'miss',
    verifierVerdict: { pass: true, reasoning: 'looks right' },
    selfHealOccurred: false,
    briefDigest: `d${String(testIndex)}${String(stepIndex)}`,
  }
}

function subAction(
  testIndex: number,
  stepIndex: number,
  subActionIndex: number,
  extra: Partial<RunDetailSubAction> = {},
): RunDetailSubAction {
  return {
    testIndex,
    stepIndex,
    subActionIndex,
    plan: 'click it',
    plannedAction: { type: 'click', ref: asRef('e1') },
    result: { success: true },
    screenStateHash: 'abcdef0123456789'.repeat(4),
    ...extra,
  }
}

function projection(over: Partial<RunDetailProjection> = {}): RunDetailProjection {
  return {
    runId: 'run_1',
    members: [],
    steps: [],
    subActions: [],
    tokens: { measuredSteps: 0, unmeasuredSteps: 0 },
    ...over,
  }
}

describe('groupRunDetail', () => {
  it('orders members, their steps and their sub-actions, and keeps a stepless member', () => {
    const grouped = groupRunDetail(
      projection({
        // Deliberately out of order on all three axes.
        members: [member(1, { name: 'second' }), member(0, { name: 'first' }), member(2, { name: 'thin' })],
        steps: [step(1, 1), step(0, 1), step(1, 0), step(0, 0)],
        subActions: [subAction(0, 0, 1), subAction(0, 0, 0), subAction(1, 0, 0)],
      }),
    )

    expect(grouped.map((g) => g.member.testIndex)).toEqual([0, 1, 2])
    expect(grouped[0]?.steps.map((s) => s.step.stepIndex)).toEqual([0, 1])
    expect(grouped[1]?.steps.map((s) => s.step.stepIndex)).toEqual([0, 1])
    expect(grouped[0]?.steps[0]?.subActions.map((s) => s.subActionIndex)).toEqual([0, 1])
    expect(grouped[1]?.steps[0]?.subActions.map((s) => s.subActionIndex)).toEqual([0])

    // A member whose stream began with a terminal event is still a group.
    expect(grouped[2]?.member.name).toBe('thin')
    expect(grouped[2]?.steps).toEqual([])
  })

  it("never hands one member's sub-actions to another member's step of the same index", () => {
    const grouped = groupRunDetail(
      projection({
        members: [member(0), member(1)],
        steps: [step(0, 0), step(1, 0)],
        subActions: [subAction(0, 0, 0, { plan: 'zero' }), subAction(1, 0, 0, { plan: 'one' })],
      }),
    )

    expect(grouped[0]?.steps[0]?.subActions.map((s) => s.plan)).toEqual(['zero'])
    expect(grouped[1]?.steps[0]?.subActions.map((s) => s.plan)).toEqual(['one'])
  })
})

describe('the member filter', () => {
  const groups = groupRunDetail(
    projection({ members: [member(0), member(1)], steps: [step(0, 0), step(1, 0)] }),
  )

  it('passes everything through for the default', () => {
    expect(filterGroups(groups, MEMBER_FILTER_ALL)).toHaveLength(2)
    expect(MEMBER_FILTER_ALL).toBe('all')
  })

  it('narrows to exactly one member', () => {
    const narrowed = filterGroups(groups, 1)
    expect(narrowed).toHaveLength(1)
    expect(narrowed[0]?.member.testIndex).toBe(1)
  })

  it('reads the URL param, and answers "all" for anything that is not an index', () => {
    expect(parseMemberFilter('7')).toBe(7)
    expect(parseMemberFilter('0')).toBe(0)
    expect(parseMemberFilter(null)).toBe(MEMBER_FILTER_ALL)
    expect(parseMemberFilter('x')).toBe(MEMBER_FILTER_ALL)
    expect(parseMemberFilter('')).toBe(MEMBER_FILTER_ALL)
    expect(parseMemberFilter('-1')).toBe(MEMBER_FILTER_ALL)
    expect(parseMemberFilter('1.5')).toBe(MEMBER_FILTER_ALL)
  })
})

describe('member copy', () => {
  it('says "did not run" for a stepless member and nothing for one that ran', () => {
    const [ran, thin] = groupRunDetail(
      projection({ members: [member(0), member(1)], steps: [step(0, 0)] }),
    )

    expect(memberNote(thin!.member, thin!)).toBe(DID_NOT_RUN_LABEL)
    expect(memberNote(ran!.member, ran!)).toBeUndefined()
    // The live surface and the durable surface must agree word for word.
    expect(DID_NOT_RUN_LABEL).toBe(DID_NOT_RUN_NOTE)
  })

  it('counts RE-RUNS, not attempts, and stays silent on the first attempt', () => {
    expect(reranLabel(3)).toBe('re-ran after failure ×2')
    expect(reranLabel(2)).toBe('re-ran after failure ×1')
    expect(reranLabel(1)).toBeUndefined()
    expect(reranLabel(0)).toBeUndefined()
  })
})

// Every caveat lives in the card, each line gated on its fact; absent is never printed as zero.
describe('the header token pair', () => {
  it('TOKEN-PAIR-LINE: labels the measured input and output, compactly', () => {
    expect(
      tokenPairLine({
        measuredSteps: 3,
        unmeasuredSteps: 0,
        promptTokens: 103074,
        completionTokens: 456,
        totalTokens: 103530,
      }),
    ).toBe(`${formatTokens(103074)} in · ${formatTokens(456)} out`)
  })

  it('TOKEN-PAIR-LINE: never says "0 in" for a run nobody measured', () => {
    const line = tokenPairLine({ measuredSteps: 0, unmeasuredSteps: 3 })
    expect(line).toBe(TOKENS_NOT_MEASURED_LABEL)
    expect(line).not.toContain('0')
  })

  it('TOKEN-PAIR-LINE: refuses to invent a sum that the projection omitted', () => {
    // measuredSteps > 0 with no sums cannot happen on the shipped op — and if it ever did,
    // the honest answer is still "not measured", never a fabricated zero.
    expect(tokenPairLine({ measuredSteps: 2, unmeasuredSteps: 0 })).toBe(TOKENS_NOT_MEASURED_LABEL)
    expect(
      tokenPairLine({ measuredSteps: 2, unmeasuredSteps: 0, promptTokens: 900 }),
    ).toBe(TOKENS_NOT_MEASURED_LABEL)
  })

  it('TOKEN-PAIR-LINE: reports a genuinely measured zero as a measurement', () => {
    expect(
      tokenPairLine({
        measuredSteps: 1,
        unmeasuredSteps: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      }),
    ).toBe(`${formatTokens(0)} in · ${formatTokens(0)} out`)
  })

  it('TOKEN-PAIR-LINE: carries no coverage clause at all', () => {
    expect(
      tokenPairLine({
        measuredSteps: 2,
        unmeasuredSteps: 1,
        promptTokens: 900,
        completionTokens: 100,
        totalTokens: 1000,
      }),
    ).not.toMatch(/of \d+ steps/)
  })
})

describe('the card totals line', () => {
  it('USAGE-TOTALS-FULL-DIGITS: spells every sum out, grouped', () => {
    expect(
      usageTotalsLine({
        measuredSteps: 3,
        unmeasuredSteps: 0,
        promptTokens: 103074,
        completionTokens: 456,
        totalTokens: 103530,
      }),
    ).toBe('103,530 total · 103,074 in · 456 out')
  })

  it('USAGE-TOTALS-FULL-DIGITS: an unmeasured run reads the label, in the card too', () => {
    expect(usageTotalsLine({ measuredSteps: 0, unmeasuredSteps: 2 })).toBe(TOKENS_NOT_MEASURED_LABEL)
    expect(usageTotalsLine({ measuredSteps: 2, unmeasuredSteps: 0 })).toBe(TOKENS_NOT_MEASURED_LABEL)
  })
})

describe('measurement coverage', () => {
  it('USAGE-COVERAGE-ONLY-WHEN-INCOMPLETE: silent when every step was measured', () => {
    expect(
      usageCoverageLine({
        measuredSteps: 3,
        unmeasuredSteps: 0,
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
      }),
    ).toBeUndefined()
  })

  it('USAGE-COVERAGE-ONLY-WHEN-INCOMPLETE: names the undercount when a step went unmeasured', () => {
    expect(usageCoverageLine({ measuredSteps: 2, unmeasuredSteps: 1 })).toBe(
      'measured 2 of 3 steps — totals are an undercount',
    )
  })

  // The cells above are the negative control; this one is the run nobody measured at all.
  it('USAGE-COVERAGE-ABSENT-IS-NOT-ZERO: says nothing about coverage when no step was measured', () => {
    const failure =
      'a card that says tokens were not measured and then reports how much of the total was missed ' +
      'is describing a number nobody took'
    const unmeasured: RunTokenTotals = { measuredSteps: 0, unmeasuredSteps: 3 }

    expect(usageCoverageLine(unmeasured), failure).toBeUndefined()
    expect(usageCoverageLine({ measuredSteps: 2, unmeasuredSteps: 1 }), failure).toContain('2 of 3')
    expect(
      usageCoverageLine({
        measuredSteps: 3,
        unmeasuredSteps: 0,
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
      }),
      failure,
    ).toBeUndefined()

    // The composition the card reads: the not-measured label is the whole of what it claims.
    expect(usageTotalsLine(unmeasured), failure).toBe(TOKENS_NOT_MEASURED_LABEL)
    expect(cachedInputLine(unmeasured), failure).toBeUndefined()
  })
})

// Execution `cacheStatus` is this product's step cache, never a provider discount on cached input.
describe('provider-reported cached input', () => {
  it('CACHED-ONLY-WHEN-REPORTED: no cachedInputTokens, no line — whatever else is present', () => {
    expect(
      cachedInputLine({
        measuredSteps: 3,
        unmeasuredSteps: 0,
        promptTokens: 103074,
        completionTokens: 456,
        totalTokens: 103530,
        cachedMeasuredSteps: 2,
        cachedInputMeasuredTokens: 90000,
      }),
    ).toBeUndefined()
  })

  it('CACHED-ONLY-WHEN-REPORTED: a cache that covers every measured step states the sum alone', () => {
    expect(
      cachedInputLine({
        measuredSteps: 3,
        unmeasuredSteps: 0,
        cachedInputTokens: 40000,
        cachedMeasuredSteps: 3,
      }),
    ).toBe('cached input 40,000 (provider-reported)')
    expect(
      cachedInputLine({ measuredSteps: 3, unmeasuredSteps: 0, cachedInputTokens: 40000 }),
    ).toBe('cached input 40,000 (provider-reported)')
  })

  it('CACHED-ONLY-WHEN-REPORTED: a narrower window names its own denominator', () => {
    expect(
      cachedInputLine({
        measuredSteps: 3,
        unmeasuredSteps: 0,
        cachedInputTokens: 40000,
        cachedMeasuredSteps: 2,
        cachedInputMeasuredTokens: 90000,
      }),
    ).toBe('cached input 40,000 of 90,000 (provider-reported) over 2 of 3 measured steps')
  })
})

describe('model identity in the card', () => {
  const declaredOne: RunModelSummary = {
    declared: [{ provider: 'openai', modelId: 'gpt-5.6-terra', stepCount: 3 }],
  }

  it('USAGE-MODEL-LINES: a run with no model summary renders no model line', () => {
    expect(usageModelLines(undefined)).toEqual([])
    expect(usageModelLines({})).toEqual([])
  })

  it('USAGE-MODEL-LINES: one declared model is one Model line', () => {
    expect(usageModelLines(declaredOne)).toEqual([
      { kind: 'model', text: 'Model gpt-5.6-terra (openai)' },
    ])
    expect(
      usageModelLines({
        ...declaredOne,
        responding: [{ modelId: 'gpt-5.6-terra', stepCount: 3 }],
      }),
    ).toEqual([{ kind: 'model', text: 'Model gpt-5.6-terra (openai)' }])
  })

  it('USAGE-MODEL-LINES: a responding id that differs is said, and only then', () => {
    expect(
      usageModelLines({
        ...declaredOne,
        responding: [{ modelId: 'gpt-5.6-terra-2026-09-01', stepCount: 3 }],
      }),
    ).toEqual([
      { kind: 'model', text: 'Model gpt-5.6-terra (openai)' },
      { kind: 'responded', text: 'responded as gpt-5.6-terra-2026-09-01' },
    ])
  })

  it('USAGE-MODEL-LINES: a mixed run is a heading and one line per identity', () => {
    expect(
      usageModelLines({
        declared: [
          { provider: 'openai', modelId: 'gpt-5.6-terra', stepCount: 2 },
          { provider: 'anthropic', modelId: 'claude-opus-5', stepCount: 1 },
        ],
        responding: [
          { modelId: 'gpt-5.6-terra', stepCount: 2 },
          { modelId: 'claude-opus-5-20260901', stepCount: 1 },
        ],
      }),
    ).toEqual([
      { kind: 'heading', text: MODELS_HEADING },
      { kind: 'models', text: 'gpt-5.6-terra (openai) × 2 steps' },
      { kind: 'models', text: 'claude-opus-5 (anthropic) × 1 steps' },
      { kind: 'responded', text: 'responded as claude-opus-5-20260901 × 1 steps' },
    ])
  })

  it('USAGE-MODEL-LINES: responding alone still names what answered', () => {
    expect(
      usageModelLines({ responding: [{ modelId: 'gpt-5.6-terra', stepCount: 4 }] }),
    ).toEqual([
      { kind: 'heading', text: MODELS_HEADING },
      { kind: 'responded', text: 'responded as gpt-5.6-terra × 4 steps' },
    ])
  })

  it('USAGE-MODEL-LINES: an identity with no provider omits the parenthesis', () => {
    // `declared` carries a required `provider` on the shipped schema; the cast is what lets this
    // cell state the rule anyway, so a looser producer cannot render `gpt-5.6-terra (undefined)`.
    const providerless = {
      declared: [{ modelId: 'gpt-5.6-terra', stepCount: 3 }],
    } as unknown as RunModelSummary
    expect(usageModelLines(providerless)).toEqual([
      { kind: 'model', text: 'Model gpt-5.6-terra' },
    ])
  })
})

describe('screen context', () => {
  const HASH = 'abcdef0123456789'.repeat(4)

  it('shows the first 12 hex characters of the hash', () => {
    expect(screenStateChip(HASH)).toBe('abcdef012345')
    expect(screenStateChip(HASH)).toHaveLength(12)
  })

  it('reads the pair, not the presence of the field', () => {
    expect(screenStateChangeLabel(subAction(0, 0, 0))).toBe(SCREEN_STATE_UNCHANGED_LABEL)
    expect(
      screenStateChangeLabel(subAction(0, 0, 0, { screenStateHashAfter: HASH })),
    ).toBe(SCREEN_STATE_UNCHANGED_LABEL)
    expect(
      screenStateChangeLabel(subAction(0, 0, 0, { screenStateHashAfter: 'f'.repeat(64) })),
    ).toBe(SCREEN_STATE_CHANGED_LABEL)
  })
})

describe('showMemberChrome', () => {
  it('is silent for a single-member run and grouped for a suite', () => {
    expect(showMemberChrome(projection({ members: [member(0)] }))).toBe(false)
    expect(showMemberChrome(projection({ members: [] }))).toBe(false)
    expect(showMemberChrome(projection({ members: [member(0), member(1)] }))).toBe(true)
  })
})

describe('the copy inventory', () => {
  it('publishes only non-empty text-node sentences', () => {
    const labels = Object.entries(view).filter(([name]) => name.endsWith('_LABEL'))

    expect(labels.length).toBeGreaterThanOrEqual(6)
    for (const [name, value] of labels) {
      expect(typeof value, name).toBe('string')
      expect((value as string).length, name).toBeGreaterThan(0)
      // Text nodes only — nothing here is ever handed to a markup parser.
      expect((value as string).includes('<'), name).toBe(false)
    }
  })
})
