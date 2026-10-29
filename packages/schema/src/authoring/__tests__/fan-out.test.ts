// The two N terms differ only in draft mode, so the cells use it to catch a collapse to `2 * N`.

import { describe, expect, it } from 'vitest'

import { DRAFT_STABILITY_RUNS_N } from '../disposition'

/** The subject, resolved per cell. Absent it, each cell reds by NAME rather than the file. */
async function loadFanOut(): Promise<typeof import('../fan-out')> {
  return await import('../fan-out')
}

/** The repair cap as `packages/agent` pins it (K). Restated here as an INPUT, never imported. */
const K = 3

describe('computeFanOutBound: the three terms and their total', () => {
  it('reports the nominal bound as initial N + K probes + final N', async () => {
    const { computeFanOutBound } = await loadFanOut()

    const bound = computeFanOutBound({
      initialN: DRAFT_STABILITY_RUNS_N,
      probeK: K,
      finalN: DRAFT_STABILITY_RUNS_N,
    })

    expect(bound.initialN).toBe(3)
    expect(bound.probeK).toBe(3)
    expect(bound.finalN).toBe(3)
    expect(bound.total).toBe(9)
  })

  it('is pure — the same inputs answer the same bound, with no clock and no store', async () => {
    const { computeFanOutBound } = await loadFanOut()

    const first = computeFanOutBound({ initialN: 3, probeK: K, finalN: 3 })
    const second = computeFanOutBound({ initialN: 3, probeK: K, finalN: 3 })

    expect(first).toEqual(second)
    // A one-argument signature is the other half of the claim: there is no port, no config and no
    // `Date` to reach for, so a later edit cannot make the bound depend on when it was asked.
    expect(computeFanOutBound.length).toBe(1)
  })

  it('refuses a negative term rather than answering a smaller bound', async () => {
    const { computeFanOutBound } = await loadFanOut()

    // The under-count direction, at the input. A negative term would SUBTRACT from the disclosure,
    // which is the one arithmetic error this number may never make.
    expect(() => computeFanOutBound({ initialN: -1, probeK: K, finalN: 3 }))
      .toThrow(/FanOutBoundError|non-negative/)
    expect(() => computeFanOutBound({ initialN: 3, probeK: -1, finalN: 3 }))
      .toThrow(/FanOutBoundError|non-negative/)
    expect(() => computeFanOutBound({ initialN: 3, probeK: K, finalN: -1 }))
      .toThrow(/FanOutBoundError|non-negative/)
  })
})

describe('the two N terms stay separate — proven where they DIFFER', () => {
  it('keeps initialN and finalN separately readable in DRAFT MODE, where they differ (1 and N)', async () => {
    const { computeFanOutBound } = await loadFanOut()

    // Draft mode is the shipped configuration in which the two terms are genuinely different
    // quantities: the initial gate takes ONE run (the disposition table's rule 1), while the final
    // stability gate runs the pinned N on the repaired candidate. A `2 * N` collapse cannot even
    // express this input, let alone answer it.
    const bound = computeFanOutBound({ initialN: 1, probeK: K, finalN: DRAFT_STABILITY_RUNS_N })

    expect(bound.initialN).toBe(1)
    expect(bound.finalN).toBe(3)
    expect(bound.initialN).not.toBe(bound.finalN)
    expect(bound.total).toBe(7)
  })

  it('keeps both terms present even when they are NUMERICALLY EQUAL — the collapse a total hides', async () => {
    const { computeFanOutBound } = await loadFanOut()

    const bound = computeFanOutBound({ initialN: 3, probeK: K, finalN: 3 })

    // THE CELL THAT SURVIVES THE COLLAPSE MUTATION. A `FanOutBound` carrying only `{doubledN: 6,
    // probeK: 3, total: 9}` would satisfy every assertion about the TOTAL — 9 is 9 — and fail
    // exactly here, which is what makes this an assertion about the terms rather than the sum.
    expect(bound.initialN).toBe(3)
    expect(bound.finalN).toBe(3)
    expect(bound.initialN + bound.probeK + bound.finalN).toBe(bound.total)
    // And the terms are three separate keys, not two: a reader cannot recover `initialN` from a
    // doubled term, because a doubled term cannot say which half was early-stopped.
    expect(Object.keys(bound).sort()).toEqual(['finalN', 'initialN', 'probeK', 'total'])
  })
})

describe('the boundaries: K = 0, and an invocation that never reaches verification', () => {
  it('answers exactly the initial N when K is 0 — no repair, no final gate', async () => {
    const { computeFanOutBound } = await loadFanOut()

    const bound = computeFanOutBound({ initialN: DRAFT_STABILITY_RUNS_N, probeK: 0, finalN: 0 })

    expect(bound.total).toBe(DRAFT_STABILITY_RUNS_N)
    expect(bound.probeK).toBe(0)
    expect(bound.finalN).toBe(0)
  })

  it('admits K = 1 — one step off the K = 0 boundary, so the pin is not "K is ignored"', async () => {
    const { computeFanOutBound } = await loadFanOut()

    // The other side of the K boundary. Without it, an implementation that dropped `probeK` from
    // the sum entirely would pass the K = 0 cell above and every default-valued cell that reads
    // the total against a literal.
    const bound = computeFanOutBound({ initialN: DRAFT_STABILITY_RUNS_N, probeK: 1, finalN: 0 })

    expect(bound.total).toBe(DRAFT_STABILITY_RUNS_N + 1)
  })

  it('answers a total of 0 for an invocation in which no draft reached verification', async () => {
    const { NO_RUNS_FAN_OUT_BOUND, computeFanOutBound } = await loadFanOut()

    expect(NO_RUNS_FAN_OUT_BOUND.total).toBe(0)
    expect(NO_RUNS_FAN_OUT_BOUND).toEqual(computeFanOutBound({ initialN: 0, probeK: 0, finalN: 0 }))
  })
})

describe('FanOutReport: what was previewed, beside what was actually consumed', () => {
  it('lists the consumed runs in COMPLETION ORDER, ties broken by run id', async () => {
    const { buildFanOutReport, computeFanOutBound } = await loadFanOut()

    // Two runs share a completion timestamp — which is the ordinary case for gate runs a fixture
    // or a fast local executor finishes inside the same millisecond, not a contrived one.
    const report = buildFanOutReport({
      previewed: computeFanOutBound({ initialN: 3, probeK: K, finalN: 3 }),
      runs: [
        { runId: 'r_c', purpose: 'gate', completedAt: 20 },
        { runId: 'r_b', purpose: 'probe', completedAt: 10 },
        { runId: 'r_a', purpose: 'gate', completedAt: 10 },
      ],
    })

    expect(report.consumed.map((run) => run.runId)).toEqual(['r_a', 'r_b', 'r_c'])
  })

  it('answers the SAME sequence for the same runs handed to it in a different order', async () => {
    const { buildFanOutReport, computeFanOutBound } = await loadFanOut()

    const previewed = computeFanOutBound({ initialN: 3, probeK: K, finalN: 3 })
    const runs = [
      { runId: 'r_c', purpose: 'gate', completedAt: 20 },
      { runId: 'r_b', purpose: 'probe', completedAt: 10 },
      { runId: 'r_a', purpose: 'gate', completedAt: 10 },
    ] as const

    // "Two renders of the same receipt report the same sequence" is a claim about the ORDERING
    // being total, so the differential is two orderings of one input rather than one input twice.
    const forward = buildFanOutReport({ previewed, runs: [...runs] })
    const reversed = buildFanOutReport({ previewed, runs: [...runs].reverse() })

    expect(forward.consumed).toEqual(reversed.consumed)
  })

  it('places a run with NO known completion time after the timed ones, ordered by id', async () => {
    const { buildFanOutReport, computeFanOutBound } = await loadFanOut()

    const report = buildFanOutReport({
      previewed: computeFanOutBound({ initialN: 3, probeK: K, finalN: 3 }),
      runs: [
        { runId: 'r_z', purpose: 'probe' },
        { runId: 'r_m', purpose: 'gate', completedAt: 99 },
        { runId: 'r_y', purpose: 'probe' },
      ],
    })

    // An absent completion time is not a zero. Sorting it as `0` would put a run nothing timed
    // AHEAD of runs that really did finish first, which is a fabricated sequence.
    expect(report.consumed.map((run) => run.runId)).toEqual(['r_m', 'r_y', 'r_z'])
  })

  it('counts a run that served as BOTH a probe and part of the final gate exactly once', async () => {
    const { buildFanOutReport, computeFanOutBound } = await loadFanOut()

    const report = buildFanOutReport({
      previewed: computeFanOutBound({ initialN: 3, probeK: K, finalN: 3 }),
      runs: [
        { runId: 'r_shared', purpose: 'probe', completedAt: 5 },
        { runId: 'r_shared', purpose: 'gate', completedAt: 5 },
        { runId: 'r_other', purpose: 'gate', completedAt: 6 },
      ],
    })

    expect(report.consumedTotal).toBe(2)
    expect(report.consumed.map((run) => run.runId)).toEqual(['r_shared', 'r_other'])
    // The FIRST role wins, because a run is started once and its purpose is what it was started
    // FOR. Double-counting would inflate the actual figure in the safe-looking direction, which is
    // exactly how a real preview under-count would be masked.
    expect(report.consumed[0]?.purpose).toBe('probe')
  })

  it('counts PROBE runs toward the actual total, not gate runs alone', async () => {
    const { buildFanOutReport, computeFanOutBound } = await loadFanOut()

    const report = buildFanOutReport({
      previewed: computeFanOutBound({ initialN: 3, probeK: K, finalN: 3 }),
      runs: [
        { runId: 'r_g1', purpose: 'gate', completedAt: 1 },
        { runId: 'r_p1', purpose: 'probe', completedAt: 2 },
        { runId: 'r_p2', purpose: 'probe', completedAt: 3 },
      ],
    })

    // A probe is a full child `agent-qa run` process against the user's application, exactly as a
    // gate run is. An actual-runs figure that omitted them would report two thirds of what was
    // spent while calling itself the honest half of the disclosure.
    expect(report.consumedTotal).toBe(3)
  })

  it('DISCLOSES an actual figure that exceeds its own preview rather than clamping it', async () => {
    const { buildFanOutReport, computeFanOutBound } = await loadFanOut()

    const report = buildFanOutReport({
      previewed: computeFanOutBound({ initialN: 1, probeK: 0, finalN: 0 }),
      runs: [
        { runId: 'r_1', purpose: 'gate', completedAt: 1 },
        { runId: 'r_2', purpose: 'gate', completedAt: 2 },
      ],
    })

    // NOT CLAMPED and NOT THROWN. A clamp turns a consent defect into a silent correctness bug —
    // the artifact would report the number the preview promised rather than the number that was
    // spent — and a throw would destroy the very receipt that carries the evidence. The excess is
    // reported as a FLAG, and every path this phase exercises asserts the flag is false.
    expect(report.consumedTotal).toBe(2)
    expect(report.previewed.total).toBe(1)
    expect(report.exceedsPreview).toBe(true)
  })

  it('does NOT raise the excess flag when the actual figure is within the preview', async () => {
    const { buildFanOutReport, computeFanOutBound } = await loadFanOut()

    const report = buildFanOutReport({
      previewed: computeFanOutBound({ initialN: 3, probeK: K, finalN: 3 }),
      runs: [{ runId: 'r_1', purpose: 'gate', completedAt: 1 }],
    })

    // The other side of the discriminator: a flag that was always true would pass the cell above
    // on its own and would say nothing about any real invocation.
    expect(report.exceedsPreview).toBe(false)
  })

  it('does not raise the excess flag when the actual figure EQUALS the preview', async () => {
    const { buildFanOutReport, computeFanOutBound } = await loadFanOut()

    const report = buildFanOutReport({
      previewed: computeFanOutBound({ initialN: 1, probeK: 1, finalN: 0 }),
      runs: [
        { runId: 'r_1', purpose: 'gate', completedAt: 1 },
        { runId: 'r_2', purpose: 'probe', completedAt: 2 },
      ],
    })

    // The boundary itself: consuming exactly what was disclosed is honouring the disclosure, not
    // exceeding it. One step either side is pinned by the two cells above.
    expect(report.consumedTotal).toBe(2)
    expect(report.exceedsPreview).toBe(false)
  })

  it('reports a refused invocation as zero previewed and zero consumed', async () => {
    const { NO_RUNS_FAN_OUT_BOUND, buildFanOutReport } = await loadFanOut()

    const report = buildFanOutReport({ previewed: NO_RUNS_FAN_OUT_BOUND, runs: [] })

    expect(report.previewed.total).toBe(0)
    expect(report.consumedTotal).toBe(0)
    expect(report.consumed).toEqual([])
    expect(report.exceedsPreview).toBe(false)
  })
})

describe('the rendered preview, which is the thing a person actually consents on', () => {
  it('states the total as an UPPER BOUND in runs, and names all three terms', async () => {
    const { computeFanOutBound, renderFanOutPreview } = await loadFanOut()

    const line = renderFanOutPreview(computeFanOutBound({ initialN: 3, probeK: K, finalN: 3 }))

    expect(line).toContain('up to 9 runs')
    expect(line).toMatch(/3 stability runs/)
    expect(line).toMatch(/3 repair probes/)
    // The cost of ONE run is what makes the number load-bearing rather than decorative.
    expect(line).toContain('agent-qa run')
  })

  it('renders the draft-mode bound with its own smaller initial term', async () => {
    const { computeFanOutBound, renderFanOutPreview } = await loadFanOut()

    const line = renderFanOutPreview(computeFanOutBound({ initialN: 1, probeK: K, finalN: 3 }))

    expect(line).toContain('up to 7 runs')
  })

  it('never frames the fan-out as an achievement, in either render', async () => {
    const { buildFanOutReport, computeFanOutBound, renderFanOutReport, renderFanOutPreview } =
      await loadFanOut()
    const { successFramingViolations } = await import('../funnel')

    const previewed = computeFanOutBound({ initialN: 3, probeK: K, finalN: 3 })
    const report = buildFanOutReport({
      previewed,
      runs: [{ runId: 'r_1', purpose: 'gate', completedAt: 1 }],
    })

    expect(successFramingViolations(renderFanOutPreview(previewed))).toEqual([])
    expect(successFramingViolations(renderFanOutReport(report))).toEqual([])
  })

  it('reports the actual figure BESIDE the previewed one, never alone', async () => {
    const { buildFanOutReport, computeFanOutBound, renderFanOutReport } = await loadFanOut()

    const report = buildFanOutReport({
      previewed: computeFanOutBound({ initialN: 3, probeK: K, finalN: 3 }),
      runs: [
        { runId: 'r_1', purpose: 'gate', completedAt: 1 },
        { runId: 'r_2', purpose: 'gate', completedAt: 2 },
      ],
    })

    const line = renderFanOutReport(report)

    // The actual alone cannot be checked, and the preview alone under-reports.
    expect(line).toContain('2')
    expect(line).toContain('9')
    expect(line).toMatch(/previewed/i)
  })

  it('is not a vacuous screen — it names the framing in a render that carries one', async () => {
    const { successFramingViolations } = await import('../funnel')

    // The control for the prohibition cell above. Without it, a screen that always answered `[]`
    // would pass and the prohibition would be a comment with a function name.
    expect(successFramingViolations('the loop kept 96% of its drafts — a great score')).not
      .toEqual([])
  })
})

// Every cell parses a value the shipped function produced, never a hand-typed literal.

describe('the zod mirrors parse what the fan-out functions actually produce', () => {
  it('FanOutReportSchema parses a PRODUCED report, run refs and all', async () => {
    const { FanOutReportSchema, buildFanOutReport, computeFanOutBound } = await loadFanOut()

    const report = buildFanOutReport({
      previewed: computeFanOutBound({ initialN: DRAFT_STABILITY_RUNS_N, probeK: K, finalN: 1 }),
      runs: [
        { runId: 'r_gate-1', purpose: 'gate', completedAt: 2 },
        // No `completedAt` at all: a run whose record could not be read still COUNTS, so the
        // schema has to accept the absence rather than the interface merely permitting it.
        { runId: 'r_probe-1', purpose: 'probe' },
      ],
    })

    const parsed = FanOutReportSchema.parse(report)

    expect(parsed).toEqual(report)
    expect(parsed.consumed.map((run) => run.runId)).toEqual(['r_gate-1', 'r_probe-1'])
    expect(parsed.previewed.total).toBe(DRAFT_STABILITY_RUNS_N + K + 1)
  })

  it('FanOutReportSchema parses the ZERO report a stage-2 refusal answers with', async () => {
    const { FanOutReportSchema, NO_RUNS_FAN_OUT_BOUND, buildFanOutReport } = await loadFanOut()

    const report = buildFanOutReport({ previewed: NO_RUNS_FAN_OUT_BOUND, runs: [] })

    // The cheap arm has to round-trip too: it is the one every dedup refusal carries, and a schema
    // that only accepted reports with runs on them would refuse the most common answer of all.
    expect(FanOutReportSchema.parse(report)).toEqual(report)
    expect(report.consumedTotal).toBe(0)
  })

  it('FanOutBoundSchema parses a PRODUCED bound and refuses a term that subtracts', async () => {
    const { FanOutBoundSchema, computeFanOutBound } = await loadFanOut()

    const bound = computeFanOutBound({ initialN: 1, probeK: K, finalN: DRAFT_STABILITY_RUNS_N })
    expect(FanOutBoundSchema.parse(bound)).toEqual(bound)

    // The one arithmetic error the number may never make is refused at the wire too, so a bound
    // arriving from outside this process cannot say what `computeFanOutBound` would have thrown on.
    expect(FanOutBoundSchema.safeParse({ ...bound, probeK: -1 }).success).toBe(false)
  })

  it('the mirrors are STRICT — an unknown key is refused, not silently stripped', async () => {
    const { FanOutReportSchema, buildFanOutReport, computeFanOutBound } = await loadFanOut()

    const report = buildFanOutReport({
      previewed: computeFanOutBound({ initialN: 1, probeK: 0, finalN: 1 }),
      runs: [{ runId: 'r_1', purpose: 'gate', completedAt: 1 }],
    })

    // The report is rendered onto a surface a person reads. A stripping parse would let a
    // malformed result carry an extra field past validation and leave the render's inputs
    // ambiguous; a refusal is what makes "only these fields reach the renderer" structural.
    expect(FanOutReportSchema.safeParse({ ...report, draftBody: 'steps:\n  - a\n' }).success)
      .toBe(false)
  })
})
