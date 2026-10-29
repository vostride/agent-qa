// Gates 1-2, the D-17 behavior table (393-06, Task 2).
//
// The table below is what 393-01 MEASURED, not what the outcome enum suggests. Its finding F1 is
// the whole reason this file is longer than "check the outcome": a draft referencing controls the
// target does not have comes back with member outcome `failed` — a definitive value — while its
// step evidence records an infeasible termination, and 19 of 21 failed members in the demo run
// store carry one. A gate 1 implemented over the enum alone passes the corpus's gate-1 rejector
// and the corpus proves nothing. F3 is the mirror hazard in the other direction: the accept
// control's definitive pass arrives as `healed`, so a gate 1 strict about the enum fails the one
// draft the corpus exists to accept.

import { DRAFT_STABILITY_RUNS_N } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import {
  ACCEPT_CONTROL_DRAFT,
  ACCEPT_CONTROL_SUBACTIONS,
  acceptControlMember,
  fakeRunPort,
} from './evidence-fixtures.js'
import type { MemberFixture } from './evidence-fixtures.js'
import { GateRunNotFlaggedError, runStabilityGates } from '../stability-gates.js'
import type { StabilityGatesResult } from '../stability-gates.js'

const DRAFT = ACCEPT_CONTROL_DRAFT

function member(overrides: Partial<MemberFixture> = {}): MemberFixture {
  return {
    filePath: DRAFT.filePath,
    testName: DRAFT.testName,
    outcome: 'passed',
    steps: ACCEPT_CONTROL_SUBACTIONS,
    ...overrides,
  }
}

async function gates(
  runs: readonly (readonly MemberFixture[] | undefined)[],
  runsRequested = DRAFT_STABILITY_RUNS_N,
): Promise<{ result: StabilityGatesResult; startCount: number }> {
  const runPort = fakeRunPort({ runs })
  const result = await runStabilityGates({ draft: DRAFT, runPort, runsRequested })
  return { result, startCount: runPort.startInputs.length }
}

describe('runStabilityGates — the consecutive-run gates', () => {
  it('three consecutive passes: gate 1 true, gate 2 true, three runs completed', async () => {
    const { result, startCount } = await gates([[member()], [member()], [member()]])

    expect(result.executesDefinitive).toBe(true)
    expect(result.stableVerdict).toBe(true)
    expect(result.runsCompleted).toBe(DRAFT_STABILITY_RUNS_N)
    expect(result.earlyStopped).toBe(false)
    expect(startCount).toBe(DRAFT_STABILITY_RUNS_N)
  })

  it('a pass then a fail early-stops after run 2 — the flip is already proven', async () => {
    const { result, startCount } = await gates([
      [member({ outcome: 'passed' })],
      [member({ outcome: 'failed' })],
      [member({ outcome: 'passed' })],
    ])

    expect(result.executesDefinitive).toBe(true)
    expect(result.stableVerdict).toBe(false)
    expect(result.runsCompleted).toBe(2)
    expect(result.earlyStopped).toBe(true)
    expect(result.distinctOutcomes).toEqual(['passed', 'failed'])
    // Early-stop skips RUNS, never a GATE (D-04). Exactly two runs were taken.
    expect(startCount).toBe(2)
  })

  it('every gate is still answered after an early stop — no gate is skipped', async () => {
    const { result } = await gates([
      [member({ outcome: 'passed' })],
      [member({ outcome: 'failed' })],
      [member({ outcome: 'passed' })],
    ])

    expect(typeof result.executesDefinitive).toBe('boolean')
    expect(typeof result.stableVerdict).toBe('boolean')
    expect(result.gateRuns).toHaveLength(2)
    expect(result.gateRuns.every((row) => typeof row.reason === 'string' && row.reason.length > 0))
      .toBe(true)
  })

  it('an infeasible termination is indefinitive even though the enum reads `failed`', async () => {
    const { result } = await gates([
      [member({ outcome: 'failed', infeasibleSteps: [0] })],
      [member({ outcome: 'failed', infeasibleSteps: [0] })],
      [member({ outcome: 'failed', infeasibleSteps: [0] })],
    ])

    // This is the corpus's gate-1 rejector shape: three agreeing runs, so gate 2 holds, and gate 1
    // is the only catcher — exactly the vector expectations.json freezes for it.
    expect(result.executesDefinitive).toBe(false)
    expect(result.stableVerdict).toBe(true)
    expect(result.gateRuns.every((row) => row.memberOutcome === 'failed')).toBe(true)
    expect(result.gateRuns.every((row) => !row.definitive)).toBe(true)
    expect(result.gateRuns[0]?.reason).toContain('infeasible')
  })

  it('a clean failure with no termination block IS definitive', async () => {
    // The other half of F1. If every `failed` read indefinitive, gate 1 would be a synonym for
    // "the draft passed" and gate 2 would have nothing left to say.
    const { result } = await gates([
      [member({ outcome: 'failed' })],
      [member({ outcome: 'failed' })],
      [member({ outcome: 'failed' })],
    ])

    expect(result.executesDefinitive).toBe(true)
    expect(result.stableVerdict).toBe(true)
  })

  it('a structural planning failure is indefinitive', async () => {
    const { result } = await gates([
      [member({ outcome: 'failed', planningFailureSteps: [0] })],
      [member({ outcome: 'failed' })],
      [member({ outcome: 'failed' })],
    ])

    expect(result.executesDefinitive).toBe(false)
    expect(result.gateRuns[0]?.definitive).toBe(false)
    expect(result.gateRuns[0]?.reason).toContain('planning')
    // The lane flake 393-01 measured on page-loaded-only run 1 is this shape; the OTHER two runs
    // stay definitive, so the receipt says which run was the problem.
    expect(result.gateRuns[1]?.definitive).toBe(true)
  })

  // Historical reader: only pre-436 handoffs carry a cycle block (436 Open Question 3).
  it('a flagged cycle is indefinitive', async () => {
    const { result } = await gates([[member({ outcome: 'failed', cycleSteps: [1] })]], 1)

    expect(result.executesDefinitive).toBe(false)
    expect(result.gateRuns[0]?.reason).toContain('cycle')
  })

  it(
    'a limit-stopped member is not definitive and the reason names the limit and its usage',
    async () => {
      const { result } = await gates([
        [member({
          outcome: 'failed',
          limitStopSteps: [{ stepIndex: 1, limit: 'actions', configured: 30, used: 30 }],
        })],
        [member({
          outcome: 'failed',
          limitStopSteps: [{ stepIndex: 0, limit: 'planning-turns', configured: 12, used: 12 }],
        })],
      ], 2)

      expect(result.executesDefinitive).toBe(false)
      expect(result.gateRuns.every((row) => !row.definitive)).toBe(true)
      expect(result.gateRuns[0]?.reason).toBe(
        'step 1 stopped at its actions limit (30 of 30 used): the run ran out of limit, '
          + 'not into an answer (D-12)',
      )
      expect(result.gateRuns[1]?.reason).toContain('step 0 stopped at its planning-turns limit')
      expect(result.gateRuns[1]?.reason).toContain('12 of 12 used')
    },
  )

  it('timeout and cancelled member outcomes are indefinitive', async () => {
    for (const outcome of ['timeout', 'cancelled', 'skipped'] as const) {
      const { result } = await gates([[member({ outcome })]], 1)
      expect({ outcome, definitive: result.executesDefinitive })
        .toEqual({ outcome, definitive: false })
    }
  })

  it('a healed pass counts as a pass AND the row records the heal', async () => {
    const { result } = await gates([
      [acceptControlMember('healed')],
      [acceptControlMember('healed')],
      [acceptControlMember('healed')],
    ])

    expect(result.executesDefinitive).toBe(true)
    expect(result.stableVerdict).toBe(true)
    expect(result.gateRuns.every((row) => row.definitive)).toBe(true)
    expect(result.gateRuns.every((row) => row.healed)).toBe(true)
    // The raw enum survives on the row; only the COMPARISON folds healed into passed.
    expect(result.gateRuns.map((row) => row.memberOutcome)).toEqual(['healed', 'healed', 'healed'])
    expect(result.distinctOutcomes).toEqual(['passed'])
  })

  it('a heal beside a pass is not a verdict flip', async () => {
    // 393-01's F2 measured heals arriving from seeded procedure replay on 5 of 8 corpus drafts.
    // If `healed` and `passed` compared as different verdicts, that contamination would read as
    // instability and deny good drafts for a reason that is about the knowledge store.
    const { result, startCount } = await gates([
      [member({ outcome: 'passed' })],
      [acceptControlMember('healed')],
      [member({ outcome: 'passed' })],
    ])

    expect(result.stableVerdict).toBe(true)
    expect(result.earlyStopped).toBe(false)
    expect(startCount).toBe(DRAFT_STABILITY_RUNS_N)
    expect(result.gateRuns[1]?.healed).toBe(true)
  })

  it('draft mode consumes exactly one run and computes both booleans from it', async () => {
    const { result, startCount } = await gates([[member()], [member()], [member()]], 1)

    expect(startCount).toBe(1)
    expect(result.runsCompleted).toBe(1)
    expect(result.executesDefinitive).toBe(true)
    expect(result.stableVerdict).toBe(true)
  })

  it('compares the DRAFT\'s own member, never another member of the same run', async () => {
    // A gate that read the run's aggregate, or simply the first member, would report the sibling's
    // verdict. The sibling here fails; the draft passes.
    const sibling: MemberFixture = {
      filePath: 'demo/init/tests/uat-381-local-form.yaml',
      testName: 'Sign in on the local account form',
      outcome: 'failed',
      steps: ACCEPT_CONTROL_SUBACTIONS,
      infeasibleSteps: [0],
    }
    const { result } = await gates([
      [sibling, member()],
      [sibling, member()],
      [sibling, member()],
    ])

    expect(result.executesDefinitive).toBe(true)
    expect(result.stableVerdict).toBe(true)
    expect(result.gateRuns.every((row) => row.memberOutcome === 'passed')).toBe(true)
  })

  it('joins on (filePath, testName) — a name match under a different path is not the draft', async () => {
    const impostor: MemberFixture = {
      filePath: 'somewhere/else.yaml',
      testName: DRAFT.testName,
      outcome: 'passed',
      steps: ACCEPT_CONTROL_SUBACTIONS,
    }
    const { result } = await gates([[impostor]], 1)

    expect(result.executesDefinitive).toBe(false)
    expect(result.gateRuns[0]?.memberOutcome).toBe('absent')
  })

  it('an unreadable run record fails gate 1 without reading as a verdict flip', async () => {
    // Missing information is not a different answer. Counting it as a flip would fail gate 2 for
    // an infrastructure hiccup — the direction that costs a user a good test — and would also stop
    // the evaluation early, hiding the runs that could still have said something.
    const { result, startCount } = await gates([[member()], undefined, [member()]])

    expect(result.executesDefinitive).toBe(false)
    expect(result.stableVerdict).toBe(true)
    expect(result.earlyStopped).toBe(false)
    expect(startCount).toBe(DRAFT_STABILITY_RUNS_N)
    expect(result.gateRuns[1]?.memberOutcome).toBe('absent')
    expect(result.distinctOutcomes).toEqual(['passed'])
  })

  it('reports gate 2 FALSE when no run produced a verdict at all', async () => {
    // Zero observed verdicts is not "nothing flipped, so it is stable". D-12's tune-toward-reject
    // applies: a gate with no evidence behind it must not read as a pass.
    const { result } = await gates([undefined, undefined, undefined])

    expect(result.executesDefinitive).toBe(false)
    expect(result.stableVerdict).toBe(false)
    expect(result.distinctOutcomes).toEqual([])
  })

  it('sets both markers on every start input and confirms them off the acknowledgment', async () => {
    const runPort = fakeRunPort({ runs: [[member()], [member()], [member()]] })
    await runStabilityGates({ draft: DRAFT, runPort, runsRequested: DRAFT_STABILITY_RUNS_N })

    expect(runPort.startInputs).toHaveLength(DRAFT_STABILITY_RUNS_N)
    for (const input of runPort.startInputs) {
      expect(input).toEqual({
        patterns: [DRAFT.filePath],
        gateRun: true,
        excludedFromOutcomes: true,
      })
    }
  })

  it('refuses when the host acknowledges a run without the gate-run markers', async () => {
    const runPort = fakeRunPort({ runs: [[member()], [member()], [member()]], dropMarkers: true })

    await expect(runStabilityGates({ draft: DRAFT, runPort, runsRequested: DRAFT_STABILITY_RUNS_N }))
      .rejects.toBeInstanceOf(GateRunNotFlaggedError)
    expect(runPort.startInputs).toHaveLength(1)
  })

  it('uses the pinned N rather than a local 3 when no count is requested', async () => {
    const runPort = fakeRunPort({ runs: [[member()], [member()], [member()], [member()]] })
    const result = await runStabilityGates({ draft: DRAFT, runPort })

    expect(result.runsCompleted).toBe(DRAFT_STABILITY_RUNS_N)
  })

  it('carries the draft members out for gate 3, in run order', async () => {
    const { result } = await gates([[member()], [member()], [member()]])

    expect(result.draftMembers).toHaveLength(DRAFT_STABILITY_RUNS_N)
    expect(result.draftMembers.every((m) => m.testName === DRAFT.testName)).toBe(true)
  })
})
