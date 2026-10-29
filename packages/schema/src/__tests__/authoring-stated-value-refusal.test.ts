// 2026-10-12 (440-03, D-09): the stated-value refusal's key set, stage vocabulary and output rules,
// read through the barrel callers import. Every expected set is spelled by hand, never derived from
// the module under test.
import { describe, expect, expectTypeOf, it } from 'vitest'

import {
  AUTHORING_STATED_VALUE_STAGES,
  AuthoringDraftWriteOutputSchema,
  AuthoringStatedValueRefusalSchema,
  NO_RUNS_FAN_OUT_BOUND,
  buildFanOutReport,
} from '../index'
import type { AuthoringStatedValueRefusal, AuthoringStatedValueStage } from '../index'

const noRuns = buildFanOutReport({ previewed: NO_RUNS_FAN_OUT_BOUND, runs: [] })

const statedValueRefusal: AuthoringStatedValueRefusal = {
  stage: 'compile',
  missingValues: ['Kitchen Appliances'],
}

const duplicateRefusal = {
  filePath: 'tests/checkout.spec.ts',
  testName: 'adds a product to the cart',
  matchedRef: 'tests/checkout.spec.ts::adds a product to the cart',
  score: 0.91,
  threshold: 0.8,
  sharedTokens: 5,
  comparedTests: 42,
  continuations: ['extend-that-test', 'name-the-differing-assertion'],
}

function refused(reasons: Record<string, unknown>): unknown {
  return { outcome: 'refused', fanOut: noRuns, ...reasons }
}

function drafted(extra: Record<string, unknown>): unknown {
  return {
    outcome: 'drafted',
    draftRef: {
      filePath: 'tests/authored/kitchen.spec.ts',
      testId: 'draft_0001',
      testName: 'filters by Kitchen Appliances',
      contentDigest: 'sha256:2f0c',
    },
    fanOut: noRuns,
    written: {
      file: {
        kind: 'written',
        filePath: 'tests/authored/kitchen.yaml',
        contentDigest: 'sha256:2f0c',
      },
      disposition: 'keep-eligible',
      gates: {
        executesDefinitive: true,
        stableVerdict: true,
        addsValue: true,
        falsifiableAssertion: true,
      },
    },
    ...extra,
  }
}

describe('C440-REFUSAL-FIELD', () => {
  it('the refusal carries exactly stage and missingValues', () => {
    const parsed = AuthoringDraftWriteOutputSchema.parse(refused({ statedValueRefusal }))
    expect(Object.keys(parsed.statedValueRefusal ?? {}).sort()).toEqual(['missingValues', 'stage'])
    expect(parsed.statedValueRefusal).toEqual({
      stage: 'compile',
      missingValues: ['Kitchen Appliances'],
    })
  })

  it('the stage is exactly compile or keep', () => {
    expect([...AUTHORING_STATED_VALUE_STAGES]).toEqual(['compile', 'keep'])
    expectTypeOf<AuthoringStatedValueStage>().toEqualTypeOf<'compile' | 'keep'>()
    expect(
      AuthoringStatedValueRefusalSchema.safeParse({ stage: 'refine', missingValues: ['5'] })
        .success,
    ).toBe(false)
  })

  it('a refusal with no missing value or an unknown key is rejected', () => {
    expect(
      AuthoringStatedValueRefusalSchema.safeParse({ stage: 'compile', missingValues: [] }).success,
    ).toBe(false)
    expect(
      AuthoringStatedValueRefusalSchema.safeParse({ stage: 'keep', missingValues: [''] }).success,
    ).toBe(false)
    expect(
      AuthoringStatedValueRefusalSchema.safeParse({ ...statedValueRefusal, step: 'Open the shop' })
        .success,
    ).toBe(false)
    expect(AuthoringStatedValueRefusalSchema.safeParse(statedValueRefusal).success).toBe(true)
  })

  it('the refusal is accepted only on a refused outcome', () => {
    expect(AuthoringDraftWriteOutputSchema.safeParse(drafted({})).success).toBe(true)
    expect(AuthoringDraftWriteOutputSchema.safeParse(drafted({ statedValueRefusal })).success).toBe(
      false,
    )
    expect(AuthoringDraftWriteOutputSchema.safeParse(refused({ statedValueRefusal })).success).toBe(
      true,
    )
  })

  it('the refusal never rides beside a duplicate refusal', () => {
    const both = AuthoringDraftWriteOutputSchema.safeParse(
      refused({ statedValueRefusal, refusal: duplicateRefusal }),
    )
    expect(both.success).toBe(false)
  })

  it('a refused outcome carries exactly one reason', () => {
    expect(AuthoringDraftWriteOutputSchema.safeParse(refused({})).success).toBe(false)
    expect(
      AuthoringDraftWriteOutputSchema.safeParse(
        refused({ statedValueRefusal, refusal: duplicateRefusal }),
      ).success,
    ).toBe(false)
    expect(AuthoringDraftWriteOutputSchema.safeParse(refused({ statedValueRefusal })).success).toBe(
      true,
    )
    expect(
      AuthoringDraftWriteOutputSchema.safeParse(refused({ refusal: duplicateRefusal })).success,
    ).toBe(true)
  })
})
