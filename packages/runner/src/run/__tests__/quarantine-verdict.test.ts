// RED-first pins for FLAK-02's whole promise (Phase 390 D-14/D-16): a quarantined test still RUNS,
// its failure does not fail the run — and the disposition is LOUD, never a rewritten outcome.
//
// The quarantined set arrives on RunConfig as PLAIN DATA (D-16): the runner gains zero ports and
// stays storageNeutral; the CLI folds the committed ledger once at run start.
//
// Both directions are pinned in one suite (the two-sided-contract law): a quarantined failing member
// aggregates 'passed' / exit 0, and a non-quarantined failing sibling still aggregates 'failed'.
//
// Runner package convention: `.js`-suffixed relative import specifiers.
import { describe, expect, it } from 'vitest'

import { startRun } from '../shell.js'
import type {
  MemberTestExecutor,
  MemberTestRunContext,
  RunConfig,
  RunMemberDescriptor,
} from '../shell.js'
import type { HandoffStorePort } from '../ports.js'
import { deriveAggregateVerdict, mapVerdictToExitCode } from '../verdict.js'
import { createTimeoutAbortReason } from '../../loop/abort.js'
import type { StepResult, TestResult } from '../../result.js'
import type { CompletedRunHandoff, MemberTestOutcome, RunSession } from '@vostride/agent-qa-schema'

// ---- Fixtures ------------------------------------------------------------

function step(overrides: Partial<StepResult> = {}): StepResult {
  return { name: 'a step', status: 'passed', duration: 1, ...overrides }
}

function passResult(name: string): TestResult {
  return { name, filePath: `${name}.test.ts`, status: 'passed', steps: [step()], duration: 1 }
}

function failResult(name: string): TestResult {
  return {
    name,
    filePath: `${name}.test.ts`,
    status: 'failed',
    steps: [step({ status: 'failed', error: 'assertion failed' })],
    duration: 1,
  }
}

function makeFakeHandoffStore(): HandoffStorePort & { saved: CompletedRunHandoff[] } {
  const saved: CompletedRunHandoff[] = []
  return {
    saved,
    save(handoff: CompletedRunHandoff) {
      saved.push(handoff)
    },
  }
}

function scriptedExecutor(script: Record<string, TestResult>): MemberTestExecutor {
  return async (member: RunMemberDescriptor, ctx: MemberTestRunContext) => {
    void ctx
    return script[member.testId] ?? passResult(member.testId)
  }
}

/**
 * The same scripted executor, recording WHICH members it was invoked for.
 *
 * The recording is the point: a member the shell skipped never reaches the executor, so `executed`
 * is the only direct evidence of "this test actually ran" — the half of FLAK-02 that lives in the
 * member loop rather than in the verdict rule.
 */
function trackingExecutor(
  script: Record<string, TestResult>,
  executed: string[],
): MemberTestExecutor {
  return async (member: RunMemberDescriptor, ctx: MemberTestRunContext) => {
    void ctx
    executed.push(member.testId)
    return script[member.testId] ?? passResult(member.testId)
  }
}

const FLAKY: RunMemberDescriptor = {
  testId: 'flaky',
  name: 'checkout completes',
  filePath: 'tests/checkout.test.yaml',
}
const HEALTHY: RunMemberDescriptor = {
  testId: 'healthy',
  name: 'login works',
  filePath: 'tests/login.test.yaml',
}
const REGRESSION: RunMemberDescriptor = {
  testId: 'regression',
  name: 'search returns hits',
  filePath: 'tests/search.test.yaml',
}

const QUARANTINED_FLAKY = {
  product: 'checkout',
  filePath: FLAKY.filePath,
  testName: FLAKY.name,
  expiresAt: '2026-09-04T10:00:00.000Z',
} as const

const QUARANTINED_HEALTHY = {
  product: 'checkout',
  filePath: HEALTHY.filePath,
  testName: HEALTHY.name,
  expiresAt: '2026-09-04T10:00:00.000Z',
} as const

/**
 * THE PRODUCTION DESCRIPTOR SHAPE, replicated exactly (`cli/src/commands/run.ts:1961`).
 *
 * Every member of every suite is constructed with `failFastGroup: prepared.suiteKey` —
 * unconditionally, one shared group per suite file. That single producer is why the descriptors in
 * the rest of this file (which omit the field entirely) were drawn from OUTSIDE the shape any real
 * suite run has: the pins below only reach the fail-fast decision because they carry it.
 */
const SUITE_GROUP = 'tests/checkout.suite.yaml'

function inSuite(member: RunMemberDescriptor): RunMemberDescriptor {
  return { ...member, failFastGroup: SUITE_GROUP }
}

function baseConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    runId: 'run-1' as RunConfig['runId'],
    scope: { tier: 'product', key: 'checkout' },
    executionContext: 'local-headless',
    buildOrdinal: 7,
    configDigests: { suiteConfigDigest: 'suite-d', testConfigDigest: 'test-d' },
    members: [FLAKY, HEALTHY],
    executor: scriptedExecutor({ flaky: failResult('flaky') }),
    ports: { handoffStore: makeFakeHandoffStore() },
    ...overrides,
  }
}

function done(session: RunSession): Promise<{ verdict: string; handoff: CompletedRunHandoff }> {
  return (session as unknown as { done: Promise<{ verdict: string; handoff: CompletedRunHandoff }> }).done
}

// ---- The end-to-end disposition path ------------------------------------

describe('quarantine-aware run (D-14/D-16)', () => {
  it('a quarantined failing member leaves the run passed at exit 0, outcome still failed', async () => {
    const session = startRun(baseConfig({ quarantined: [QUARANTINED_FLAKY] }))
    const { verdict, handoff } = await done(session)

    expect(verdict).toBe('passed')
    expect(mapVerdictToExitCode(handoff.aggregateVerdict)).toBe(0)

    // The member outcome stays TRUTHFUL — the projection window and the M-passes exit keep
    // seeing reality (D-14). 'failed' stays 'failed'.
    const member = handoff.tests.find((test) => test.testId === 'flaky')
    expect(member?.outcome).toBe('failed')
    expect(member?.quarantined).toBe(true)

    // The disposition lives BESIDE the outcome, and the run records which entries applied.
    expect(handoff.quarantineApplied).toEqual([QUARANTINED_FLAKY])

    const healthy = handoff.tests.find((test) => test.testId === 'healthy')
    expect(healthy?.outcome).toBe('passed')
    expect('quarantined' in (healthy ?? {})).toBe(false)
  })

  it('CONTROL: a non-quarantined failing sibling still fails the run', async () => {
    const session = startRun(
      baseConfig({
        members: [FLAKY, HEALTHY, REGRESSION],
        executor: scriptedExecutor({
          flaky: failResult('flaky'),
          regression: failResult('regression'),
        }),
        quarantined: [QUARANTINED_FLAKY],
      }),
    )
    const { verdict, handoff } = await done(session)

    expect(verdict).toBe('failed')
    expect(mapVerdictToExitCode(handoff.aggregateVerdict)).toBe(1)
    expect(handoff.tests.find((test) => test.testId === 'flaky')?.quarantined).toBe(true)
    expect('quarantined' in (handoff.tests.find((test) => test.testId === 'regression') ?? {})).toBe(
      false,
    )
  })

  it('an absent quarantined set reproduces pre-390 behavior byte-identically', async () => {
    const session = startRun(baseConfig())
    const { verdict, handoff } = await done(session)

    expect(verdict).toBe('failed')
    expect(handoff.quarantineApplied).toBeUndefined()
    for (const test of handoff.tests) expect('quarantined' in test).toBe(false)
  })

  it('an empty quarantined set is byte-identical to an absent one', async () => {
    const session = startRun(baseConfig({ quarantined: [] }))
    const { verdict, handoff } = await done(session)

    expect(verdict).toBe('failed')
    expect(handoff.quarantineApplied).toBeUndefined()
  })

  it('matches members on (filePath, testName) — never testId', async () => {
    const session = startRun(
      baseConfig({
        quarantined: [{ ...QUARANTINED_FLAKY, filePath: 'tests/OTHER.test.yaml' }],
      }),
    )
    const { verdict } = await done(session)
    expect(verdict).toBe('failed')
  })

  it('suppresses a quarantined member that TIMES OUT, the same A3 phenomenon', async () => {
    const timeoutResult: TestResult = {
      name: 'flaky',
      filePath: 'flaky.test.ts',
      status: 'failed',
      steps: [step({ status: 'failed', error: createTimeoutAbortReason('test', 30_000).message })],
      duration: 1,
    }
    const session = startRun(
      baseConfig({
        executor: scriptedExecutor({ flaky: timeoutResult }),
        quarantined: [QUARANTINED_FLAKY],
      }),
    )
    const { verdict, handoff } = await done(session)
    const member = handoff.tests.find((test) => test.testId === 'flaky')
    expect(member?.outcome).toBe('timeout')
    expect(member?.quarantined).toBe(true)
    expect(verdict).toBe('passed')
  })
})

// ---- The fail-fast gate, in the production descriptor shape (CR-01) -----------------------------
//
// FLAK-02's promise is that a quarantined test still RUNS. The aggregate rule above delivers half of
// it; the other half lives in the shell's member loop, where a failing member POISONS its
// `failFastGroup` and every later same-group member is skipped without ever reaching the executor.
//
// Measured 2026-08-05 (phase 390 verification, CR-01): with production-shape descriptors, a
// quarantined failing member poisoned its group, its NON-quarantined failing sibling never executed,
// the skip was neutral in the aggregate, and the run answered 'passed' / exit 0 where pre-390 it
// exited 1. Every fixture in the suite above omits `failFastGroup`, so the CONTROL pin at :128 —
// "a non-quarantined failing sibling still fails the run" — could not red on it.
//
// These four pins are the corpus that can. They assert the ANTI-SILENCING direction (the aggregate
// and the exit code), not merely that the sibling executed: a build that runs the sibling and then
// swallows its failure would pass an execution-only pin.

/**
 * The verifier's probe output, as a value: which members the executor was reached for, the
 * aggregate, the exit code a CI gate reads, and every member's (outcome, disposition) pair.
 *
 * Kept as ONE object so a failure prints all four legs in a single diff. Execution alone is not the
 * property at risk — the property at risk is that an un-quarantined failure survives to the exit
 * code — so the pins below never assert one leg without the others.
 */
function probeShape(
  executed: readonly string[],
  verdict: string,
  handoff: CompletedRunHandoff,
): {
  executed: readonly string[]
  verdict: string
  exitCode: number
  outcomes: Array<[string, string, boolean | null]>
} {
  return {
    executed,
    verdict,
    exitCode: mapVerdictToExitCode(handoff.aggregateVerdict),
    outcomes: handoff.tests.map((test) => [test.testId, test.outcome, test.quarantined ?? null]),
  }
}

describe('fail-fast poisoning is disposition-aware (CR-01, D-14)', () => {
  it('a quarantined failure does not skip its siblings — a failing sibling still reds the run at exit 1', async () => {
    const executed: string[] = []
    const session = startRun(
      baseConfig({
        members: [FLAKY, REGRESSION, HEALTHY].map(inSuite),
        executor: trackingExecutor(
          { flaky: failResult('flaky'), regression: failResult('regression') },
          executed,
        ),
        quarantined: [QUARANTINED_FLAKY],
      }),
    )
    const { verdict, handoff } = await done(session)

    // Asserted as ONE shape, mirroring the verifier's probe output, because the facts are only
    // meaningful together: a diff showing just "the sibling was skipped" invites a fix that runs
    // the sibling and still swallows its failure.
    //
    // This ONE fixture shows both directions of the guard, in member order. `flaky`'s LICENSED
    // failure does not poison, so `regression` executes. `regression`'s UN-licensed failure then
    // poisons exactly as pre-390, so `healthy` behind it is skipped — the guard removed one route
    // to a skip and left the other untouched. Pre-fix this whole shape read
    // `executed: ['flaky'] / verdict 'passed' / exitCode 0`, the verifier's measurement.
    expect(probeShape(executed, verdict, handoff)).toEqual({
      executed: ['flaky', 'regression'],
      verdict: 'failed',
      exitCode: 1,
      outcomes: [
        ['flaky', 'failed', true],
        ['regression', 'failed', null],
        ['healthy', 'skipped', null],
      ],
    })
  })

  it('CONTROL in the production shape: a NON-quarantined failure still poisons its group', async () => {
    const executed: string[] = []
    const session = startRun(
      baseConfig({
        members: [FLAKY, REGRESSION, HEALTHY].map(inSuite),
        executor: trackingExecutor(
          { flaky: failResult('flaky'), regression: failResult('regression') },
          executed,
        ),
        quarantined: [],
      }),
    )
    const { verdict, handoff } = await done(session)

    // pre-390 within-suite fail-fast (D-15) is preserved EXACTLY where no disposition applies —
    // this is the corpus case the guard must REJECT
    expect(probeShape(executed, verdict, handoff)).toEqual({
      executed: ['flaky'],
      verdict: 'failed',
      exitCode: 1,
      outcomes: [
        ['flaky', 'failed', null],
        ['regression', 'skipped', null],
        ['healthy', 'skipped', null],
      ],
    })
  })

  it('the guard covers the TIMEOUT arm too — the same two outcomes the aggregate rule skips', async () => {
    const timeoutResult: TestResult = {
      name: 'flaky',
      filePath: 'flaky.test.ts',
      status: 'failed',
      steps: [step({ status: 'failed', error: createTimeoutAbortReason('test', 30_000).message })],
      duration: 1,
    }
    const executed: string[] = []
    const session = startRun(
      baseConfig({
        members: [FLAKY, HEALTHY, REGRESSION].map(inSuite),
        executor: trackingExecutor({ flaky: timeoutResult }, executed),
        quarantined: [QUARANTINED_FLAKY],
      }),
    )
    const { verdict, handoff } = await done(session)

    // with the siblings executed and passing, the licensed timeout is the only failure left
    expect(probeShape(executed, verdict, handoff)).toEqual({
      executed: ['flaky', 'healthy', 'regression'],
      verdict: 'passed',
      exitCode: 0,
      outcomes: [
        ['flaky', 'timeout', true],
        ['healthy', 'passed', null],
        ['regression', 'passed', null],
      ],
    })
  })

  it('a quarantined member skipped BY a non-quarantined predecessor still carries its disposition', async () => {
    const executed: string[] = []
    const session = startRun(
      baseConfig({
        members: [FLAKY, HEALTHY].map(inSuite),
        executor: trackingExecutor({ flaky: failResult('flaky') }, executed),
        quarantined: [QUARANTINED_HEALTHY],
      }),
    )
    const { verdict, handoff } = await done(session)

    expect(executed).toEqual(['flaky'])
    const healthy = handoff.tests.find((test) => test.testId === 'healthy')
    // the skip path stamps the marker in lockstep with the outcome push — the guard change must not
    // regress it
    expect(healthy?.outcome).toBe('skipped')
    expect(healthy?.quarantined).toBe(true)
    expect(verdict).toBe('failed')
    expect(mapVerdictToExitCode(handoff.aggregateVerdict)).toBe(1)
  })
})

// ---- The rule itself (D-14: the skip is EXPLICIT in deriveAggregateVerdict) ----

describe('deriveAggregateVerdict quarantine skip', () => {
  const base = { runCancelled: false }

  it('skips quarantined failed AND timeout members', () => {
    for (const outcome of ['failed', 'timeout'] as MemberTestOutcome[]) {
      expect(
        deriveAggregateVerdict({ ...base, outcomes: [outcome], quarantined: [true] }),
      ).toBe('passed')
      expect(
        deriveAggregateVerdict({ ...base, outcomes: [outcome], quarantined: [false] }),
      ).toBe('failed')
    }
  })

  it('only skips the flagged positions', () => {
    expect(
      deriveAggregateVerdict({
        ...base,
        outcomes: ['failed', 'failed'],
        quarantined: [true, false],
      }),
    ).toBe('failed')
    expect(
      deriveAggregateVerdict({
        ...base,
        outcomes: ['failed', 'failed'],
        quarantined: [true, true],
      }),
    ).toBe('passed')
  })

  it('leaves every other branch untouched — the run-level cancel wins regardless', () => {
    expect(
      deriveAggregateVerdict({
        runCancelled: true,
        outcomes: ['failed'],
        quarantined: [true],
      }),
    ).toBe('cancelled')
    // A quarantined member never suppresses a sibling 'cancelled' or 'healed' signal.
    expect(
      deriveAggregateVerdict({
        ...base,
        outcomes: ['failed', 'cancelled'],
        quarantined: [true, false],
      }),
    ).toBe('cancelled')
    expect(
      deriveAggregateVerdict({
        ...base,
        outcomes: ['failed', 'healed'],
        quarantined: [true, false],
      }),
    ).toBe('healed')
  })

  it('an absent flags array is the pre-390 rule', () => {
    expect(deriveAggregateVerdict({ ...base, outcomes: ['failed'] })).toBe('failed')
    expect(deriveAggregateVerdict({ ...base, outcomes: ['timeout'] })).toBe('failed')
    expect(deriveAggregateVerdict({ ...base, outcomes: ['passed'] })).toBe('passed')
  })

  it('a short flags array never reads as quarantined by accident', () => {
    expect(
      deriveAggregateVerdict({ ...base, outcomes: ['passed', 'failed'], quarantined: [true] }),
    ).toBe('failed')
  })
})
