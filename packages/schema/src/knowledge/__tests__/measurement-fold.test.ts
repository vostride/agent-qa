import { describe, expect, it } from 'vitest'

import {
  BIMODAL_MIN_MODE_N,
  CUSUM_DECISION_H,
  DRIFT_RELATIVE_THRESHOLD,
  DRIFT_SIGMA_K,
  KIND_DEFAULT_CV,
  MEASUREMENT_MIN_N,
  SHRINKAGE_PSEUDO_N,
  bimodalSplit,
  cusumStep,
  decideMeasurementDrift,
  foldMeasurements,
  measurementBaselineSchema,
  measurementObservationSchema,
  shrunkSigma,
  type MeasurementBaseline,
  type MeasurementObservation,
} from '../measurement-fold'

const baseline: MeasurementBaseline = {
  mu0: 10,
  sigma0: 2,
  n0: 20,
  openedAtOrdinal: 100,
}

function observation(
  value: number,
  index: number,
  buildOrdinal = 101 + index,
): MeasurementObservation {
  return {
    value,
    buildOrdinal,
    evidenceToken: `evidence-${index}`,
    curationJobId: `job-${index}`,
  }
}

describe('measurement line schemas', () => {
  it('round-trips the strict baseline snapshot and rejects extra keys', () => {
    expect(measurementBaselineSchema.parse(baseline)).toEqual(baseline)
    expect(measurementBaselineSchema.safeParse({ ...baseline, detectorState: {} }).success)
      .toBe(false)
  })

  it('round-trips strict finite observation lines and rejects extra keys', () => {
    const line = observation(12.5, 0)

    expect(measurementObservationSchema.parse(line)).toEqual(line)
    expect(measurementObservationSchema.safeParse({ ...line, recordedAt: 'now' }).success)
      .toBe(false)
    expect(measurementObservationSchema.safeParse({
      ...line,
      value: Number.POSITIVE_INFINITY,
    }).success)
      .toBe(false)
  })
})

describe('foldMeasurements deterministic distribution', () => {
  it('seeds EWMA from the baseline and applies the exact one-line recurrence', () => {
    const empty = foldMeasurements(baseline, [])
    const oneLine = foldMeasurements(baseline, [observation(20, 0)])

    expect(empty).toEqual({
      n: 0,
      mean: 0,
      sigma: 0,
      ewma: baseline.mu0,
      p50: undefined,
      p95: undefined,
      bands: [],
      cusumPos: 0,
      cusumNeg: 0,
    })
    expect(oneLine.ewma).toBe(12)
    expect(oneLine.n).toBe(1)
    expect(oneLine.mean).toBe(20)
  })

  it('keeps EWMA order-sensitive while Welford statistics and quantiles are not', () => {
    const lines = [20, 0].map((value, index) => observation(value, index))
    const forward = foldMeasurements(baseline, lines)
    const reverse = foldMeasurements(baseline, [lines[1]!, lines[0]!])

    expect(forward.ewma).toBeCloseTo(9.6, 12)
    expect(reverse.ewma).toBeCloseTo(10.4, 12)
    expect({
      n: forward.n,
      mean: forward.mean,
      sigma: forward.sigma,
      p50: forward.p50,
      p95: forward.p95,
      bands: forward.bands,
    }).toEqual({
      n: reverse.n,
      mean: reverse.mean,
      sigma: reverse.sigma,
      p50: reverse.p50,
      p95: reverse.p95,
      bands: reverse.bands,
    })
  })

  it('derives population Welford sigma and nearest-rank p50/p95 in one fold', () => {
    const lines = [2, 4, 4, 4, 5, 5].map((value, index) => observation(value, index))
    const state = foldMeasurements(baseline, lines)

    expect(state.n).toBe(6)
    expect(state.mean).toBe(4)
    expect(state.sigma).toBe(1)
    // Nearest-rank uses ceil(q * n) - 1: p50 -> index 2, p95 -> index 5.
    expect(state.p50).toBe(4)
    expect(state.p95).toBe(5)
    expect(state.bands).toEqual([{ lo: 2, hi: 5, n: 6, mean: 4 }])
  })

  it(
    'replays byte-equivalent order deterministically and treats permutation as different input',
    () => {
      const lines = [13, 7].map((value, index) => observation(value, index))
      const first = foldMeasurements(baseline, lines)

      expect(foldMeasurements(baseline, lines)).toEqual(first)
      expect(foldMeasurements(baseline, [lines[1]!, lines[0]!]))
        .not.toEqual(first)
    },
  )
})

describe('fixed-baseline two-sided CUSUM', () => {
  it('accumulates the exact positive and negative fixed-reference equations', () => {
    expect(cusumStep({ pos: 0, neg: 0 }, 13, 10, 2)).toEqual({
      pos: 2,
      neg: 0,
      tripped: false,
    })
    expect(cusumStep({ pos: 0, neg: 0 }, 7, 10, 2)).toEqual({
      pos: 0,
      neg: 2,
      tripped: false,
    })
  })

  it('trips on a bounded +1 sigma walk while centered noise stays below the guard', () => {
    let walk = { pos: 0, neg: 0 }
    let tripAt: number | undefined

    for (let step = 1; step <= 12; step += 1) {
      const next = cusumStep(walk, 12, 10, 2)
      walk = next
      if (next.tripped) {
        tripAt = step
        break
      }
    }

    expect(CUSUM_DECISION_H).toBe(5)
    expect(tripAt).toBe(11)

    let noise = { pos: 0, neg: 0 }
    for (const value of [10.5, 9.5, 10.25, 9.75, 10.4, 9.6, 10, 10]) {
      const next = cusumStep(noise, value, 10, 2)
      expect(next.tripped).toBe(false)
      noise = next
    }
  })
})

describe('weighted largest-gap bimodality', () => {
  it('splits a clearly separated two-band sample with enough observations per mode', () => {
    expect(bimodalSplit([9, 10, 11, 99, 100, 101])).toEqual({
      splitIndex: 3,
      bands: [
        { lo: 9, hi: 11, n: 3, mean: 10 },
        { lo: 99, hi: 101, n: 3, mean: 100 },
      ],
    })
  })

  it('rejects unimodal samples and samples smaller than two complete modes', () => {
    expect(bimodalSplit([1, 2, 3, 4, 5, 6])).toBeUndefined()
    expect(bimodalSplit(Array.from({ length: 2 * BIMODAL_MIN_MODE_N - 1 }, (_, i) => i)))
      .toBeUndefined()
  })
})

describe('locked measurement drift decision tree', () => {
  function decision(
    decisionBaseline: MeasurementBaseline,
    values: readonly number[],
    buildOrdinals = values.map((_, index) => 101 + index),
  ) {
    const observations = values.map((value, index) =>
      observation(value, index, buildOrdinals[index]),
    )

    return decideMeasurementDrift({
      baseline: decisionBaseline,
      state: foldMeasurements(decisionBaseline, observations),
      windowBuilds: { observations, trailingBuilds: 5 },
    })
  }

  it('runs the locked minimum-n gate before every supersession arm', () => {
    expect(MEASUREMENT_MIN_N).toBe(5)
    expect(decision(baseline, [100, 100, 100, 100])).toEqual({
      decision: 'widen',
      reason: 'below-min-n',
    })
  })

  it('does not let descriptive EWMA influence drift disposition', () => {
    const observations = Array.from({ length: MEASUREMENT_MIN_N }, (_, index) =>
      observation(30, index),
    )
    const state = foldMeasurements(baseline, observations)
    const verdict = decideMeasurementDrift({ baseline, state })

    expect(Number.isFinite(state.ewma)).toBe(true)
    expect(decideMeasurementDrift({
      baseline,
      state: { ...state, ewma: state.ewma - 10_000 },
    })).toEqual(verdict)
  })

  it('shrinks low-n variance toward the exact CV pseudo-count prior', () => {
    expect(KIND_DEFAULT_CV).toBe(0.3)
    expect(SHRINKAGE_PSEUDO_N).toBe(5)
    expect(shrunkSigma(0, 1, 10)).toBeCloseTo(Math.sqrt(7.5), 12)
    expect(shrunkSigma(2, 5, 10)).toBeCloseTo(Math.sqrt(6.5), 12)
  })

  it('widens on CI overlap before a tiny-baseline relative trigger can fire', () => {
    const tinyBaseline: MeasurementBaseline = {
      mu0: 0.01,
      sigma0: 1,
      n0: 5,
      openedAtOrdinal: 100,
    }

    expect(0.02 - tinyBaseline.mu0).toBeGreaterThan(
      DRIFT_RELATIVE_THRESHOLD * Math.abs(tinyBaseline.mu0),
    )
    expect(decision(tinyBaseline, [0.02, 0.02, 0.02, 0.02, 0.02])).toEqual({
      decision: 'widen',
      reason: 'ci-overlap',
    })
  })

  it('supersedes on the locked 3-sigma arm in both directions', () => {
    const thresholdBaseline: MeasurementBaseline = {
      mu0: 100,
      sigma0: 5,
      n0: 100,
      openedAtOrdinal: 100,
    }

    expect(DRIFT_SIGMA_K).toBe(3)
    expect(decision(thresholdBaseline, [130, 130, 130, 130, 130])).toEqual({
      decision: 'supersede',
      reason: 'threshold',
    })
    expect(decision(thresholdBaseline, [70, 70, 70, 70, 70])).toEqual({
      decision: 'supersede',
      reason: 'threshold',
    })
  })

  it('supersedes on the locked relative arm in both directions independently of sigma', () => {
    const relativeBaseline: MeasurementBaseline = {
      mu0: 100,
      sigma0: 50,
      n0: 100,
      openedAtOrdinal: 100,
    }

    expect(DRIFT_RELATIVE_THRESHOLD).toBe(0.5)
    expect(decision(relativeBaseline, [160, 160, 160, 160, 160])).toEqual({
      decision: 'supersede',
      reason: 'relative',
    })
    expect(decision(relativeBaseline, [40, 40, 40, 40, 40])).toEqual({
      decision: 'supersede',
      reason: 'relative',
    })
  })

  it('lets fixed-baseline CUSUM catch a sustained shift below both window thresholds', () => {
    const cusumBaseline: MeasurementBaseline = {
      mu0: 100,
      sigma0: 2,
      n0: 100,
      openedAtOrdinal: 100,
    }

    expect(decision(cusumBaseline, Array.from({ length: 50 }, () => 108))).toEqual({
      decision: 'supersede',
      reason: 'cusum',
    })
  })

  it('widens revisited modes but supersedes a walk that abandons the old band', () => {
    const multimodalBaseline: MeasurementBaseline = {
      mu0: 10,
      sigma0: 5,
      n0: 100,
      openedAtOrdinal: 100,
    }

    expect(decision(
      multimodalBaseline,
      [10, 100, 11, 101, 9, 99],
      [101, 102, 103, 104, 105, 106],
    )).toEqual({
      decision: 'widen',
      reason: 'stable-multimodal',
    })

    expect(decision(
      multimodalBaseline,
      [9, 10, 11, 99, 100, 101],
      [100, 101, 102, 110, 111, 112],
    )).toEqual({
      decision: 'supersede',
      reason: 'regime-walk',
    })
  })
})
