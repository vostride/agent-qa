import { describe, expect, it } from 'vitest'

import { CURRENT_DRAFT_RECEIPT_SCHEMA_VERSION, DraftReceiptSchema } from '../draft-receipt'
import type { DraftReceipt } from '../draft-receipt'

/** The subject, resolved per cell. Absent it, each cell reds by NAME rather than the file. */
async function loadFunnel(): Promise<typeof import('../funnel')> {
  return await import('../funnel')
}

interface ReceiptFixture {
  readonly digest: string
  readonly executesDefinitive?: boolean
  readonly stableVerdict?: boolean
  readonly addsValue?: boolean
  readonly falsifiableAssertion?: boolean
  readonly sessionRef?: string
  readonly evaluatedAt?: number
  /** Overrides the all-passed default; `unverified` and `proposal-only` set the run counts that earn them. */
  readonly disposition?: 'keep-eligible' | 'proposal-only' | 'rejected' | 'unverified'
}

// The gate booleans are set independently because all four gates are always evaluated.
function receipt(fixture: ReceiptFixture): DraftReceipt {
  const executesDefinitive = fixture.executesDefinitive ?? true
  const stableVerdict = fixture.stableVerdict ?? true
  const addsValue = fixture.addsValue ?? true
  const falsifiableAssertion = fixture.falsifiableAssertion ?? true
  const allPassed = executesDefinitive && stableVerdict && addsValue && falsifiableAssertion
  const disposition = fixture.disposition ?? (allPassed ? 'keep-eligible' : 'rejected')

  return DraftReceiptSchema.parse({
    schemaVersion: CURRENT_DRAFT_RECEIPT_SCHEMA_VERSION,
    draftRef: {
      filePath: `tests/.agent-qa-drafts/${fixture.digest}.yaml`,
      testId: `t_${fixture.digest}`,
      testName: `draft ${fixture.digest}`,
      contentDigest: fixture.digest,
    },
    gates: {
      executesDefinitive: { pass: executesDefinitive, runRefs: ['run-1'], indefinitiveRunRefs: [] },
      stableVerdict: {
        pass: stableVerdict,
        runRefs: ['run-1'],
        distinctOutcomes: stableVerdict ? ['passed'] : ['passed', 'failed'],
        earlyStopped: !stableVerdict,
      },
      addsValue: { pass: addsValue, novelElementCount: addsValue ? 1 : 0, comparedTestCount: 3 },
      falsifiableAssertion: {
        pass: falsifiableAssertion,
        assertionStepCount: 1,
        falsifiableAssertionCount: falsifiableAssertion ? 1 : 0,
      },
    },
    stepTable: [],
    gateRuns: [{ runId: 'run-1', memberOutcome: 'passed', definitive: true, healed: false }],
    addsValueFinding: { novelElements: addsValue ? ['el:button:Save'] : [], comparedTests: [] },
    stabilityRunsRequested: disposition === 'unverified' ? 1 : 3,
    stabilityRunsCompleted: disposition === 'unverified' ? 1 : disposition === 'proposal-only' ? 2 : 3,
    disposition,
    evaluatedAt: fixture.evaluatedAt ?? 1_700_000_000_000,
    ...(fixture.sessionRef === undefined ? {} : { sessionRef: fixture.sessionRef }),
  })
}

// Gate 4 is not a stage, so the split moves only `writeEligible`.
function corpus(count: number, kept: number): { receipts: readonly DraftReceipt[] } {
  const receipts = Array.from({ length: count }, (_unused, index) => receipt({
    digest: `d${String(index).padStart(3, '0')}`,
    ...(index < kept ? {} : { falsifiableAssertion: false }),
  }))
  return { receipts }
}

const NO_SIDE_COUNTERS = {} as const

describe('the frozen four-stage funnel', () => {
  it('counts one `built` per receipt', async () => {
    const { computeAuthoringFunnel } = await loadFunnel()
    const funnel = computeAuthoringFunnel({
      receipts: [receipt({ digest: 'a' }), receipt({ digest: 'b' }), receipt({ digest: 'c' })],
      sideCounters: NO_SIDE_COUNTERS,
    })

    expect(funnel.stages.built).toBe(3)
  })

  it('counts `passedStably` only where gate 1 AND gate 2 both passed', async () => {
    const { computeAuthoringFunnel } = await loadFunnel()
    const funnel = computeAuthoringFunnel({
      receipts: [
        receipt({ digest: 'both' }),
        receipt({ digest: 'no-gate-1', executesDefinitive: false }),
        receipt({ digest: 'no-gate-2', stableVerdict: false }),
        receipt({ digest: 'neither', executesDefinitive: false, stableVerdict: false }),
      ],
      sideCounters: NO_SIDE_COUNTERS,
    })

    expect(funnel.stages.built).toBe(4)
    expect(funnel.stages.passedStably).toBe(1)
  })

  it('counts `addedValue` off gate 3 alone, independently of gates 1-2', async () => {
    const { computeAuthoringFunnel } = await loadFunnel()
    const funnel = computeAuthoringFunnel({
      receipts: [
        // Gate 3 passed and gate 1 did not: every gate is evaluated, so stages count apart.
        receipt({ digest: 'value-no-stability', executesDefinitive: false }),
        receipt({ digest: 'no-value', addsValue: false }),
      ],
      sideCounters: NO_SIDE_COUNTERS,
    })

    expect(funnel.stages.addedValue).toBe(1)
    expect(funnel.stages.passedStably).toBe(1)
  })

  it('counts every disposition that writes a draft, and never `rejected`', async () => {
    const { computeAuthoringFunnel } = await loadFunnel()
    const funnel = computeAuthoringFunnel({
      receipts: [
        receipt({ digest: 'keep', disposition: 'keep-eligible' }),
        receipt({ digest: 'short', disposition: 'proposal-only' }),
        receipt({ digest: 'draft-mode', disposition: 'unverified' }),
        receipt({ digest: 'gate-four', falsifiableAssertion: false }),
      ],
      sideCounters: NO_SIDE_COUNTERS,
    })

    expect(funnel.stages).toEqual({ built: 4, passedStably: 4, addedValue: 4, writeEligible: 3 })
    expect(funnel.line).toContain('· 3 write-eligible.')
  })

  it('reads the STORED disposition, not one recomputed from the gates', async () => {
    const { computeAuthoringFunnel } = await loadFunnel()
    // All four gates passed and the stored answer is `rejected`: the stored value is the answer
    // that was given, and the loop's write decision read it.
    const funnel = computeAuthoringFunnel({
      receipts: [receipt({ digest: 'stored-rejected', disposition: 'rejected' })],
      sideCounters: NO_SIDE_COUNTERS,
    })

    expect(funnel.stages.writeEligible).toBe(0)
    expect(funnel.stages.passedStably).toBe(1)
  })

  it('does not make gate 4 a stage — four gates and four stages are not the same four', async () => {
    const { AUTHORING_FUNNEL_STAGES, computeAuthoringFunnel } = await loadFunnel()

    expect([...AUTHORING_FUNNEL_STAGES]).toEqual([
      'built',
      'passedStably',
      'addedValue',
      'writeEligible',
    ])
    expect(AUTHORING_FUNNEL_STAGES).not.toContain('falsifiableAssertion')

    // A draft rejected on gate 4 ALONE still counts at every stage the funnel has, because
    // none of them is gate 4. Folding it in would silently move the denominator.
    const funnel = computeAuthoringFunnel({
      receipts: [receipt({ digest: 'weak-assertion', falsifiableAssertion: false })],
      sideCounters: NO_SIDE_COUNTERS,
    })
    expect(funnel.stages.passedStably).toBe(1)
    expect(funnel.stages.addedValue).toBe(1)
  })

  it('reports the dedup-refusal counter BESIDE the stages, never folded into one', async () => {
    const { computeAuthoringFunnel } = await loadFunnel()
    const { receipts } = corpus(4, 1)
    const funnel = computeAuthoringFunnel({
      receipts,
      sideCounters: { dedupRefusals: 7 },
    })

    expect(funnel.sideCounters).toEqual({ dedupRefusals: 7 })
    // The stages are exactly the four receipts: the seven refusals authored nothing at all, so
    // not one of them moves a stage count.
    expect(funnel.stages).toEqual({ built: 4, passedStably: 4, addedValue: 4, writeEligible: 1 })
    expect(funnel.line).toContain('Beside the funnel: 7 dedup refusals.')
  })

  it('reports an ABSENT dedup-refusal counter rather than 0 when nothing records one', async () => {
    const { computeAuthoringFunnel } = await loadFunnel()
    const funnel = computeAuthoringFunnel({
      receipts: [receipt({ digest: 'a' })],
      sideCounters: {},
    })

    expect(funnel.sideCounters.dedupRefusals).toBeUndefined()
    // The empty object is a VALID input and a valid output: nothing else sits beside the funnel,
    // and the one counter nothing records is said in words rather than printed as a 0.
    expect(funnel.sideCounters).toEqual({})
    expect(funnel.line).toContain('Beside the funnel: dedup refusals not recorded on this host.')
  })
})

describe('the acceptance-failure flag', () => {
  it('FIRES on the seeded high-keep corpus and says the loop is not filtering', async () => {
    const { computeAuthoringFunnel } = await loadFunnel()
    // 22 of 23 is 95.65%, which displays as 96%.
    const { receipts } = corpus(23, 22)
    const funnel = computeAuthoringFunnel({ receipts, sideCounters: NO_SIDE_COUNTERS })

    expect(funnel.acceptanceFailure).toBe(true)
    expect(funnel.smallSample).toBe(false)
    expect(funnel.line).toContain('ACCEPTANCE FAILURE')
    expect(funnel.line).toContain('keep rate 96% over 23 drafts')
    expect(funnel.line).toContain('the loop is not filtering')
  })

  it('does NOT fire at a rate exactly equal to the ceiling — the comparison is strictly greater', async () => {
    const { computeAuthoringFunnel, KEEP_RATE_CEILING } = await loadFunnel()
    // 18/20 is exactly 9/10.
    const { receipts } = corpus(20, 18)
    const funnel = computeAuthoringFunnel({ receipts, sideCounters: NO_SIDE_COUNTERS })

    expect(funnel.stages.writeEligible * KEEP_RATE_CEILING.den)
      .toBe(KEEP_RATE_CEILING.num * funnel.stages.built)
    expect(funnel.acceptanceFailure).toBe(false)
    expect(funnel.line).not.toContain('ACCEPTANCE FAILURE')
  })

  it('fires one step ABOVE the ceiling', async () => {
    const { computeAuthoringFunnel } = await loadFunnel()
    // 19/20 = 0.95 — the smallest integer numerator above 9/10 at this denominator.
    const { receipts } = corpus(20, 19)
    const funnel = computeAuthoringFunnel({ receipts, sideCounters: NO_SIDE_COUNTERS })

    expect(funnel.acceptanceFailure).toBe(true)
  })

  it('stays silent one step BELOW the ceiling', async () => {
    const { computeAuthoringFunnel } = await loadFunnel()
    // 17/20 = 0.85 — the largest integer numerator below 9/10 at this denominator.
    const { receipts } = corpus(20, 17)
    const funnel = computeAuthoringFunnel({ receipts, sideCounters: NO_SIDE_COUNTERS })

    expect(funnel.acceptanceFailure).toBe(false)
    expect(funnel.smallSample).toBe(false)
    expect(funnel.line).toContain('keep rate 85% over 20 drafts')
  })

  it('ADMITS the flag at a draft count exactly equal to the floor — the comparison is greater-or-equal', async () => {
    const { FUNNEL_MIN_DRAFTS_FLOOR, computeAuthoringFunnel } = await loadFunnel()
    const { receipts } = corpus(FUNNEL_MIN_DRAFTS_FLOOR, FUNNEL_MIN_DRAFTS_FLOOR)
    const funnel = computeAuthoringFunnel({ receipts, sideCounters: NO_SIDE_COUNTERS })

    expect(funnel.stages.built).toBe(FUNNEL_MIN_DRAFTS_FLOOR)
    expect(funnel.smallSample).toBe(false)
    expect(funnel.acceptanceFailure).toBe(true)
  })

  it('refuses the flag one below the floor, and says so with the small-sample caveat', async () => {
    const { FUNNEL_MIN_DRAFTS_FLOOR, computeAuthoringFunnel } = await loadFunnel()
    const below = FUNNEL_MIN_DRAFTS_FLOOR - 1
    const { receipts } = corpus(below, below)
    const funnel = computeAuthoringFunnel({ receipts, sideCounters: NO_SIDE_COUNTERS })

    // A 100% keep rate — the most flag-worthy rate there is — and it still does not flag.
    expect(funnel.stages.writeEligible).toBe(below)
    expect(funnel.acceptanceFailure).toBe(false)
    expect(funnel.smallSample).toBe(true)
    expect(funnel.line).toContain('too few drafts')
    expect(funnel.line).not.toContain('ACCEPTANCE FAILURE')
  })

  it('admits the flag one above the floor', async () => {
    const { FUNNEL_MIN_DRAFTS_FLOOR, computeAuthoringFunnel } = await loadFunnel()
    const above = FUNNEL_MIN_DRAFTS_FLOOR + 1
    const { receipts } = corpus(above, above)
    const funnel = computeAuthoringFunnel({ receipts, sideCounters: NO_SIDE_COUNTERS })

    expect(funnel.smallSample).toBe(false)
    expect(funnel.acceptanceFailure).toBe(true)
  })

  it('flags a rate that DISPLAYS as 90% and is actually 90.4%', async () => {
    const { computeAuthoringFunnel } = await loadFunnel()
    // 113/125 = 0.904 → renders "90%", and 1130 > 1125 on the integers.
    const { receipts } = corpus(125, 113)
    const funnel = computeAuthoringFunnel({ receipts, sideCounters: NO_SIDE_COUNTERS })

    expect(funnel.line).toContain('keep rate 90% over 125 drafts')
    expect(funnel.acceptanceFailure).toBe(true)
  })

  it('does NOT flag a rate that displays as 90% and is actually 89.6%', async () => {
    const { computeAuthoringFunnel } = await loadFunnel()
    // 112/125 = 0.896 → also renders "90%", and 1120 < 1125 on the integers.
    const { receipts } = corpus(125, 112)
    const funnel = computeAuthoringFunnel({ receipts, sideCounters: NO_SIDE_COUNTERS })

    expect(funnel.line).toContain('keep rate 90% over 125 drafts')
    expect(funnel.acceptanceFailure).toBe(false)
  })
})

describe('the zero-receipts posture', () => {
  it('reports every stage 0, the caveat, no flag, and an ABSENT keep rate rather than 0%', async () => {
    const { computeAuthoringFunnel } = await loadFunnel()
    const funnel = computeAuthoringFunnel({
      receipts: [],
      sideCounters: NO_SIDE_COUNTERS,
    })

    expect(funnel.stages).toEqual({ built: 0, passedStably: 0, addedValue: 0, writeEligible: 0 })
    expect(funnel.keepRate).toBeUndefined()
    expect(funnel.smallSample).toBe(true)
    expect(funnel.acceptanceFailure).toBe(false)
    // `0/0` rendered as `0%` would report a loop that filtered perfectly when nothing happened.
    expect(funnel.line).not.toContain('0%')
    expect(funnel.line).toContain('no keep rate to report')
  })
})

describe('the no-success-framing prohibition', () => {
  it('never frames a high keep rate as an achievement, in any of the pinned cells', async () => {
    const { computeAuthoringFunnel, successFramingViolations } = await loadFunnel()

    const cells: readonly (readonly [number, number])[] = [
      [23, 22], [20, 18], [20, 17], [10, 10], [9, 9], [0, 0], [125, 113],
    ]
    for (const [built, kept] of cells) {
      const { receipts } = corpus(built, kept)
      const funnel = computeAuthoringFunnel({
        receipts,
        sideCounters: { dedupRefusals: 1 },
      })
      expect(successFramingViolations(funnel.line), `${built}/${kept}`).toEqual([])
    }
  })

  it('is not a vacuous check — it names the framing in a string that carries one', async () => {
    const { successFramingViolations } = await loadFunnel()

    expect(successFramingViolations('keep rate 96% — great success, 96% complete ✅'))
      .toEqual(expect.arrayContaining(['great', 'success', 'complete', '✅']))
    expect(successFramingViolations('keep rate 96% over 23 drafts in this window')).toEqual([])
  })

  it('checks the SHIPPED wording table, not a paraphrase of it', async () => {
    const { FUNNEL_PHRASES, successFramingViolations } = await loadFunnel()

    // Every phrase every render composes from. This is what makes the prohibition mechanical:
    // a later editor changes the wording HERE, and the render refuses a framed one at
    // construction rather than a reviewer having to notice it.
    const phrases = Object.values(FUNNEL_PHRASES)
    expect(phrases.length).toBeGreaterThan(0)
    for (const phrase of phrases) {
      expect(successFramingViolations(phrase), phrase).toEqual([])
    }
  })

  it('exports the refusal a framed render raises, so the guard is a value and not a comment', async () => {
    const { FunnelSuccessFramingError } = await loadFunnel()

    expect(FunnelSuccessFramingError).toBeTypeOf('function')
    expect(new FunnelSuccessFramingError(['success']).name).toBe('FunnelSuccessFramingError')
  })
})

describe('the funnel does not count a rejected draft-mode draft', () => {
  it('counts a draft-mode draft whose gate 4 said no as not write-eligible', async () => {
    const { computeAuthoringFunnel } = await loadFunnel()
    const { computeDraftDisposition } = await import('../disposition')
    const disposition = computeDraftDisposition({
      gates: {
        executesDefinitive: true,
        stableVerdict: true,
        addsValue: true,
        falsifiableAssertion: false,
      },
      stabilityRunsRequested: 1,
      stabilityRunsCompleted: 1,
    })
    const funnel = computeAuthoringFunnel({
      receipts: [
        receipt({ digest: 'draft-mode-weak', falsifiableAssertion: false, disposition }),
        receipt({ digest: 'draft-mode-good', disposition: 'unverified' }),
      ],
      sideCounters: NO_SIDE_COUNTERS,
    })
    expect(funnel.stages.writeEligible).toBe(1)
  })
})
