// Pins the run shell: startRun owns the session identity, the bus and its seq, member iteration,
// the aggregate verdict and the handoff; a run-level cancel stops the run; the RunConfig arrives
// fully resolved, with no fs or providers; session.done resolves { verdict, handoff } with the
// handoff persisted exactly once; per-test outcomes are derived from the member results
// (spec/v2/runner.md §2.1/§2.2); and handoff step indices come from array position, never all zero.
//
// Runner package convention: `.js`-suffixed relative import specifiers. Fully-faked
// executor + ports — no real fs, providers, or timers.
import { describe, expect, it, vi } from 'vitest'

import { startRun } from '../shell.js'
import type {
  MemberTestExecutor,
  MemberTestRunContext,
  RunConfig,
  RunMemberDescriptor,
} from '../shell.js'
import type {
  EventLogPort,
  HandoffStorePort,
  PostVerdictPort,
  RunArtifactStorePort,
  RunTimerPort,
} from '../ports.js'
import { POST_VERDICT_STEP_BUDGET_MS } from '../ports.js'
import type { EvidenceArtifactStorePort } from '../../loop/ports.js'
import { SecretRedactor, SecretStore } from '../../loop/secrets.js'
import {
  CURRENT_HANDOFF_SCHEMA_VERSION,
  CURRENT_BUS_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type { RunArtifactStageInput, RunArtifactFinalizeInput } from '@vostride/agent-qa-schema'
import type { StepResult, TestResult } from '../../result.js'
import type {
  CompletedRunHandoff,
  RunEventEnvelope,
  RunSession,
  StepEvidence,
} from '@vostride/agent-qa-schema'

// ---- Fakes ---------------------------------------------------------------

function passResult(name: string, steps: StepResult[] = [defaultStep()]): TestResult {
  return { name, filePath: `${name}.test.ts`, status: 'passed', steps, duration: 1 }
}

function failResult(name: string, error?: string): TestResult {
  return {
    name,
    filePath: `${name}.test.ts`,
    status: 'failed',
    steps: [defaultStep({ status: 'failed', error })],
    duration: 1,
  }
}

function defaultStep(overrides: Partial<StepResult> = {}): StepResult {
  return { name: 'a step', status: 'passed', duration: 1, ...overrides }
}

interface FakeHandoffStore extends HandoffStorePort {
  saved: CompletedRunHandoff[]
  saveCalls: number
}

function makeFakeHandoffStore(options: { fail?: boolean } = {}): FakeHandoffStore {
  const saved: CompletedRunHandoff[] = []
  return {
    saved,
    saveCalls: 0,
    async save(handoff: CompletedRunHandoff) {
      this.saveCalls += 1
      if (options.fail) throw new Error('disk full')
      saved.push(handoff)
    },
  }
}

function makeFakeEventLog(): EventLogPort {
  const store: RunEventEnvelope[] = []
  return {
    append(envelope: RunEventEnvelope) {
      store.push(envelope)
    },
    read(fromSeq: number) {
      return store.filter(event => event.seq >= fromSeq)
    },
  }
}

interface FakeTimer extends RunTimerPort {
  fireLatest(): void
}

function makeFakeTimer(): FakeTimer {
  let scheduled: (() => void) | undefined
  return {
    schedule(_delayMs: number, fn: () => void) {
      scheduled = fn
      return () => {
        if (scheduled === fn) scheduled = undefined
      }
    },
    now: () => 1_700_000_000_000,
    fireLatest() {
      scheduled?.()
    },
  }
}

// An executor that resolves canned results by testId and records call order.
function scriptedExecutor(
  script: Record<string, TestResult>,
  calls: string[],
): MemberTestExecutor {
  return async (member: RunMemberDescriptor, ctx: MemberTestRunContext) => {
    calls.push(member.testId)
    void ctx
    return script[member.testId] ?? passResult(member.testId)
  }
}

// An executor whose active member hangs until its abortSignal fires.
function abortableExecutor(calls: string[]): MemberTestExecutor {
  return (member: RunMemberDescriptor, ctx: MemberTestRunContext) =>
    new Promise<TestResult>(resolve => {
      calls.push(member.testId)
      const cancelled: TestResult = {
        name: member.testId,
        filePath: `${member.testId}.test.ts`,
        status: 'cancelled',
        steps: [],
        duration: 1,
      }
      if (ctx.abortSignal.aborted) return resolve(cancelled)
      ctx.abortSignal.addEventListener('abort', () => resolve(cancelled), { once: true })
    })
}

function baseConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    runId: 'run-1' as RunConfig['runId'],
    scope: { tier: 'suite', key: 'checkout' },
    executionContext: 'local-headless',
    buildOrdinal: 7,
    configDigests: { suiteConfigDigest: 'suite-d', testConfigDigest: 'test-d' },
    members: [
      { testId: 'a', name: 'test a', filePath: 'a.test.ts' },
      { testId: 'b', name: 'test b', filePath: 'b.test.ts' },
    ],
    executor: scriptedExecutor({}, []),
    ports: { handoffStore: makeFakeHandoffStore(), eventLog: makeFakeEventLog() },
    ...overrides,
  }
}

function drain(session: RunSession): RunEventEnvelope[] {
  const received: RunEventEnvelope[] = []
  ;(session as unknown as { subscribe(fromSeq: number, handler: (e: RunEventEnvelope) => void): () => void })
    .subscribe(1, event => received.push(event))
  return received
}

function done(session: RunSession): Promise<{ verdict: string; handoff: CompletedRunHandoff }> {
  return (session as unknown as { done: Promise<{ verdict: string; handoff: CompletedRunHandoff }> }).done
}

function cancel(session: RunSession): void {
  ;(session as unknown as { cancel(): void }).cancel()
}

// ---- Synchronous session identity (SESSION-01, D-01/D-04) ----------------

describe('startRun — synchronous session identity (SESSION-01)', () => {
  it('returns a session synchronously carrying id, running status, executionContext', () => {
    const session = startRun(baseConfig())
    expect(session.id).toBe('run-1')
    expect(session.status).toBe('running')
    expect(session.executionContext).toBe('local-headless')
  })
})

// ---- Run lifecycle + ordering (SESSION-04, spec §2.2) --------------------

describe('run lifecycle emission (SESSION-04, spec §2.2)', () => {
  it('the first event is runStarted at seq 1 with busSchemaVersion + D-04 header fields', async () => {
    const session = startRun(baseConfig())
    const events = drain(session)
    await done(session)

    const first = events[0]
    expect(first.type).toBe('runStarted')
    expect(first.seq).toBe(1)
    const payload = first.payload as Record<string, unknown>
    expect(payload.busSchemaVersion).toBe(CURRENT_BUS_SCHEMA_VERSION)
    expect(payload.scope).toEqual({ tier: 'suite', key: 'checkout' })
    expect(payload.executionContext).toBe('local-headless')
    expect(payload.buildOrdinal).toBe(7)
    expect(payload.configDigests).toEqual({ suiteConfigDigest: 'suite-d', testConfigDigest: 'test-d' })
    expect(payload.memberTestCount).toBe(2)
  })

  it('members execute in order, each bracketed by testStarted/testFinished; testFinished carries an outcome, never steps', async () => {
    const calls: string[] = []
    const session = startRun(baseConfig({ executor: scriptedExecutor({}, calls) }))
    const events = drain(session)
    await done(session)

    expect(calls).toEqual(['a', 'b'])
    const lifecycle = events.filter(e => e.type === 'testStarted' || e.type === 'testFinished')
    expect(lifecycle.map(e => e.type)).toEqual(['testStarted', 'testFinished', 'testStarted', 'testFinished'])
    for (const finished of events.filter(e => e.type === 'testFinished')) {
      const payload = finished.payload as Record<string, unknown>
      expect(payload.outcome).toBeDefined()
      expect(payload).not.toHaveProperty('steps')
    }
  })

  it('a shared failFastGroup skips remaining same-group members while other groups still run', async () => {
    const calls: string[] = []
    const members: RunMemberDescriptor[] = [
      { testId: 'g1-a', name: 'group 1 test a', filePath: 'g1-a.test.ts', failFastGroup: 'g1' },
      { testId: 'g1-b', name: 'group 1 test b', filePath: 'g1-b.test.ts', failFastGroup: 'g1' },
      { testId: 'g2-a', name: 'group 2 test a', filePath: 'g2-a.test.ts', failFastGroup: 'g2' },
    ]
    const session = startRun(
      baseConfig({
        members,
        executor: scriptedExecutor({ 'g1-a': failResult('g1-a') }, calls),
      }),
    )
    const events = drain(session)
    await done(session)

    // g1-b is skipped (executor never invoked); g2-a still runs.
    expect(calls).toEqual(['g1-a', 'g2-a'])
    const skipped = events
      .filter(e => e.type === 'testFinished')
      .map(e => (e.payload as { testId: string; outcome: string }))
    expect(skipped).toContainEqual(expect.objectContaining({ testId: 'g1-b', outcome: 'skipped' }))
  })

  it('publishes verdict exactly once, before runFinished; runFinished is last, once, and with NO postVerdict port composed reads detached, with finalSeq = its own seq', async () => {
    const session = startRun(baseConfig())
    const events = drain(session)
    await done(session)

    const verdicts = events.filter(e => e.type === 'verdict')
    const finishes = events.filter(e => e.type === 'runFinished')
    expect(verdicts).toHaveLength(1)
    expect(finishes).toHaveLength(1)
    const verdictIdx = events.findIndex(e => e.type === 'verdict')
    const finishIdx = events.findIndex(e => e.type === 'runFinished')
    expect(verdictIdx).toBeLessThan(finishIdx)
    expect(finishIdx).toBe(events.length - 1)
    const finishPayload = finishes[0].payload as { disposition: string; finalSeq: number }
    // 404 D-09/D-10: `detached` is no longer a hardcoded literal — it is what the shell decides
    // when NO `ports.postVerdict` step was composed, which is this config. Nothing will be drained
    // from a host that composed no step, and the wire says exactly that (with no warning: nothing
    // was promised). The three decided values are pinned in the port cells below.
    expect(
      finishPayload.disposition,
      'a run with no post-verdict port composed reports detached',
    ).toBe('detached')
    expect(finishPayload.finalSeq).toBe(finishes[0].seq)
  })

  it('a full passing run emits no chip-event types (defined-never-emitted)', async () => {
    const session = startRun(baseConfig())
    const events = drain(session)
    await done(session)
    const chips = new Set([
      'analysisStarted', 'analysisCompleted', 'analysisFailed',
      'curationStarted', 'curationCompleted', 'curationFailed',
    ])
    expect(events.some(e => chips.has(e.type))).toBe(false)
  })
})

// ---- Cancellation ----------------------------------------------------------

describe('run-level cancel', () => {
  it('session.cancel() aborts the active member, skips the rest, aggregates cancelled', async () => {
    const calls: string[] = []
    const session = startRun(baseConfig({ executor: abortableExecutor(calls) }))
    drain(session)
    cancel(session)
    const { verdict } = await done(session)
    expect(verdict).toBe('cancelled')
    // The second member is never started once the run is cancelled.
    expect(calls).toEqual(['a'])
  })
})

// ---- Handoff (SESSION-05, D-13/D-17) -------------------------------------

describe('handoff — exactly one per run (SESSION-05, D-13/D-17)', () => {
  it('session.done resolves the same handoff that is persisted through the store port, exactly once', async () => {
    const store = makeFakeHandoffStore()
    const session = startRun(baseConfig({ ports: { handoffStore: store, eventLog: makeFakeEventLog() } }))
    drain(session)
    const { handoff } = await done(session)
    expect(store.saveCalls).toBe(1)
    expect(store.saved[0]).toBe(handoff)
  })

  it('the handoff carries the §A8 header fields and per-test outcomes', async () => {
    const store = makeFakeHandoffStore()
    const session = startRun(baseConfig({ ports: { handoffStore: store, eventLog: makeFakeEventLog() } }))
    drain(session)
    const { handoff } = await done(session)
    expect(handoff.schemaVersion).toBe(CURRENT_HANDOFF_SCHEMA_VERSION)
    expect(handoff.runId).toBe('run-1')
    expect(handoff.scope).toEqual({ tier: 'suite', key: 'checkout' })
    expect(handoff.buildOrdinal).toBe(7)
    expect(handoff.executionContext).toBe('local-headless')
    expect(handoff.configDigests).toEqual({ suiteConfigDigest: 'suite-d', testConfigDigest: 'test-d' })
    expect(typeof handoff.startedAt).toBe('number')
    expect(typeof handoff.endedAt).toBe('number')
    expect(handoff.tests).toHaveLength(2)
  })

  it('handoff step indices are re-derived from array position (never all-zero — RESEARCH Pitfall 4)', async () => {
    const twoSteps = passResult('a', [
      defaultStep({ name: 's0', evidence: { stepIndex: 0 } as unknown as StepEvidence }),
      defaultStep({ name: 's1', evidence: { stepIndex: 0 } as unknown as StepEvidence }),
    ])
    const session = startRun(
      baseConfig({ members: [{ testId: 'a', name: 'test a', filePath: 'a.test.ts' }], executor: scriptedExecutor({ a: twoSteps }, []) }),
    )
    drain(session)
    const { handoff } = await done(session)
    expect(handoff.tests[0].steps.map(s => s.stepIndex)).toEqual([0, 1])
  })

  it('a step WITHOUT evidence still yields a synthesized minimal StepEvidence (Open Q1: synthesize, do not drop)', async () => {
    const noEvidence = passResult('a', [defaultStep({ name: 's0' })])
    const session = startRun(
      baseConfig({ members: [{ testId: 'a', name: 'test a', filePath: 'a.test.ts' }], executor: scriptedExecutor({ a: noEvidence }, []) }),
    )
    drain(session)
    const { handoff } = await done(session)
    expect(handoff.tests[0].steps).toHaveLength(1)
    expect(handoff.tests[0].steps[0]).toMatchObject({ stepIndex: 0 })
  })

  it('handoff-store save failure publishes runWarning handoff-write-failed and done STILL resolves (verdict independence, D-07)', async () => {
    const store = makeFakeHandoffStore({ fail: true })
    const session = startRun(baseConfig({ ports: { handoffStore: store, eventLog: makeFakeEventLog() } }))
    const events = drain(session)
    const { verdict } = await done(session)
    expect(verdict).toBe('passed')
    const warning = events.find(
      e => e.type === 'runWarning' && (e.payload as { code: string }).code === 'handoff-write-failed',
    )
    expect(warning).toBeDefined()
  })
})

// ---- 363 D-01 parity enrichment (testStarted descriptor fields + testFinished extras) ----
//
// The producer side of the reporter-parity contract: the shell rides the RunMemberDescriptor's
// parity fields onto testStarted and the TestResult's durationMs/retryCount/failureSummary onto
// testFinished, masking the failureSummary at the sink. Absent optionals leave no undefined-hole.

describe('363 D-01 — enriched testStarted / testFinished payloads', () => {
  const SECRET = 'SECRET-42'
  const secretRedactor = new SecretRedactor(new SecretStore({ SECRET_42: SECRET }))

  it('testStarted carries the member descriptor parity fields when present', async () => {
    const members: RunMemberDescriptor[] = [
      {
        testId: 'checkout-happy',
        name: 'Checkout happy path',
        filePath: 'tests/checkout.yaml',
        suiteId: 'checkout-suite',
        suiteName: 'Checkout',
        suiteIndex: 0,
        suiteTotal: 2,
        totalSteps: 4,
      },
    ]
    const session = startRun(baseConfig({ members, executor: scriptedExecutor({}, []) }))
    const events = drain(session)
    await done(session)

    const started = events.find(e => e.type === 'testStarted')
    expect(started).toBeDefined()
    expect(started!.payload).toMatchObject({
      testId: 'checkout-happy',
      testIndex: 0,
      filePath: 'tests/checkout.yaml',
      suiteId: 'checkout-suite',
      suiteName: 'Checkout',
      suiteIndex: 0,
      suiteTotal: 2,
      totalSteps: 4,
    })
  })

  it('a bare member (no optional parity fields) yields a testStarted with no undefined-holes (JSON round-trip)', async () => {
    const session = startRun(baseConfig({ members: [{ testId: 'a', name: 'test a', filePath: 'a.test.ts' }], executor: scriptedExecutor({}, []) }))
    const events = drain(session)
    await done(session)

    const started = events.find(e => e.type === 'testStarted')!
    // filePath is REQUIRED since 381-01 (ABRF-02) — it always rides the payload now.
    expect(started.payload).toHaveProperty('filePath', 'a.test.ts')
    expect(started.payload).not.toHaveProperty('suiteId')
    expect(started.payload).not.toHaveProperty('stepTexts')
    expect(JSON.parse(JSON.stringify(started.payload))).toEqual(started.payload)
  })

  // G-428-2 (owner decision 2026-09-26 (2)): the descriptor's raw step texts ride testStarted in
  // step order, masked by this describe's redactor.
  it('STEP-TEXTS-ON-TESTSTARTED', async () => {
    const members: RunMemberDescriptor[] = [
      {
        testId: 'login',
        name: 'Login',
        filePath: 'tests/login.yaml',
        totalSteps: 3,
        stepTexts: ['Open the login page', `Type ${SECRET} into Password`, 'Submit the form'],
      },
    ]
    const session = startRun(baseConfig({ secretRedactor, members, executor: scriptedExecutor({}, []) }))
    const events = drain(session)
    await done(session)

    const started = events.find(e => e.type === 'testStarted')!
    expect((started.payload as { stepTexts?: readonly string[] }).stepTexts).toEqual([
      'Open the login page',
      'Type [secret:SECRET_42] into Password',
      'Submit the form',
    ])
    expect(JSON.stringify(started.payload)).not.toContain(SECRET)
    expect(JSON.parse(JSON.stringify(started.payload))).toEqual(started.payload)
  })

  it('testFinished carries durationMs + retryCount and a MASKED failureSummary from the TestResult', async () => {
    const result: TestResult = {
      name: 'a',
      filePath: 'a.test.ts',
      status: 'failed',
      steps: [defaultStep({ status: 'failed' })],
      duration: 987,
      retryCount: 2,
      failureSummary: `crashed on ${SECRET}`,
    }
    const session = startRun(
      baseConfig({ secretRedactor, members: [{ testId: 'a', name: 'test a', filePath: 'a.test.ts' }], executor: scriptedExecutor({ a: result }, []) }),
    )
    const events = drain(session)
    await done(session)

    const finished = events.find(e => e.type === 'testFinished')!
    const payload = finished.payload as Record<string, unknown>
    expect(payload.durationMs).toBe(987)
    expect(payload.retryCount).toBe(2)
    expect(payload.failureSummary).toBe('crashed on [secret:SECRET_42]')
    expect(JSON.stringify(payload)).not.toContain(SECRET)
  })

  it('a passing member with no failureSummary/retryCount leaves those testFinished fields absent', async () => {
    const session = startRun(baseConfig({ members: [{ testId: 'a', name: 'test a', filePath: 'a.test.ts' }], executor: scriptedExecutor({}, []) }))
    const events = drain(session)
    await done(session)

    const finished = events.find(e => e.type === 'testFinished')!
    expect(finished.payload).not.toHaveProperty('failureSummary')
    expect(finished.payload).not.toHaveProperty('retryCount')
    expect(JSON.parse(JSON.stringify(finished.payload))).toEqual(finished.payload)
  })
})

// ---- D-08 run-artifact store lifecycle (363-06) --------------------------

interface FakeArtifactStore {
  stage(document: RunArtifactStageInput): void
  finalize(patch: RunArtifactFinalizeInput): void
  stageCalls: RunArtifactStageInput[]
  finalizeCalls: RunArtifactFinalizeInput[]
}

function makeFakeArtifactStore(options: { fail?: boolean } = {}): FakeArtifactStore {
  return {
    stageCalls: [],
    finalizeCalls: [],
    stage(document) {
      this.stageCalls.push(document)
      if (options.fail) throw new Error('artifact disk full')
    },
    finalize(patch) {
      this.finalizeCalls.push(patch)
      if (options.fail) throw new Error('artifact disk full')
    },
  }
}

describe('run-artifact store lifecycle (D-08, 363-06)', () => {
  it('stages the config+source snapshot synchronously after runStarted, before finalize', () => {
    const store = makeFakeArtifactStore()
    const runArtifact: RunArtifactStageInput = {
      config: { rawConfigContent: 'baseUrl: x' },
      source: { kind: 'test', testId: 't-1' },
    }
    const session = startRun(
      baseConfig({
        runArtifact,
        ports: { handoffStore: makeFakeHandoffStore(), eventLog: makeFakeEventLog(), runArtifactStore: store },
      }),
    )
    // startRun is synchronous through runStarted → stage fires during construction; finalize waits
    // for the terminal sequence (await done), proving stage-after-runStarted / finalize-before-runFinished.
    expect(store.stageCalls).toHaveLength(1)
    expect(store.stageCalls[0]).toEqual(runArtifact)
    expect(store.finalizeCalls).toHaveLength(0)
    return done(session).then(() => {
      expect(store.finalizeCalls).toHaveLength(1)
      expect(typeof store.finalizeCalls[0].finalizedAt).toBe('string')
    })
  })

  it('stages an empty document when no runArtifact snapshot is supplied', async () => {
    const store = makeFakeArtifactStore()
    const session = startRun(
      baseConfig({
        ports: { handoffStore: makeFakeHandoffStore(), eventLog: makeFakeEventLog(), runArtifactStore: store },
      }),
    )
    await done(session)
    expect(store.stageCalls).toEqual([{}])
    expect(store.finalizeCalls).toHaveLength(1)
  })

  it('is a silent no-op when no runArtifactStore is present', async () => {
    const session = startRun(
      baseConfig({
        runArtifact: { config: { rawConfigContent: 'x' } },
        ports: { handoffStore: makeFakeHandoffStore(), eventLog: makeFakeEventLog() },
      }),
    )
    await expect(done(session)).resolves.toBeDefined()
  })

  it('a throwing store degrades with runWarnings and never gates the verdict (D-07)', async () => {
    const store = makeFakeArtifactStore({ fail: true })
    const session = startRun(
      baseConfig({
        runArtifact: { config: { rawConfigContent: 'x' } },
        ports: { handoffStore: makeFakeHandoffStore(), eventLog: makeFakeEventLog(), runArtifactStore: store },
      }),
    )
    const events = drain(session)
    const result = await done(session)
    expect(result.verdict).toBeDefined()
    const warnings = events.filter(e => e.type === 'runWarning').map(e => (e.payload as { code: string }).code)
    expect(warnings).toContain('artifact-stage-failed')
    expect(warnings).toContain('artifact-finalize-failed')
  })
})

// ---- CASS-02 run-scoped evidence artifact store threading (Plan 13) ------
//
// The shell holds one run-scoped EvidenceArtifactStorePort on RunPorts (constructed run-scoped at
// the CLI composition root) and must hand THAT EXACT instance to every member context so Plan 12's
// screenshot producer sees a single durable store across the whole run. An absent store stays
// undefined for host-neutral tests and embedders.

function makeFakeEvidenceArtifactStore(): EvidenceArtifactStorePort {
  return {
    persistDecisionScreenshot: () => ({ id: 'decision-screenshot:sha', sha: 'sha' }),
    getBlob: () => undefined,
  }
}

describe('CASS-02 — run-scoped evidence artifact store threading (Plan 13)', () => {
  it('hands the exact config.ports.evidenceArtifacts to every member context (strict identity, multi-member)', async () => {
    const store = makeFakeEvidenceArtifactStore()
    const seen: Array<EvidenceArtifactStorePort | undefined> = []
    const executor: MemberTestExecutor = async (member, ctx) => {
      seen.push(ctx.evidenceArtifacts)
      return passResult(member.testId)
    }
    const session = startRun(
      baseConfig({
        members: [
          { testId: 'a', name: 'test a', filePath: 'a.test.ts' },
          { testId: 'b', name: 'test b', filePath: 'b.test.ts' },
        ],
        executor,
        ports: { handoffStore: makeFakeHandoffStore(), eventLog: makeFakeEventLog(), evidenceArtifacts: store },
      }),
    )
    drain(session)
    await done(session)

    expect(seen).toHaveLength(2)
    expect(seen[0]).toBe(store)
    expect(seen[1]).toBe(store)
  })

  it('leaves the member context store undefined when no run-scoped store is supplied', async () => {
    let seen: EvidenceArtifactStorePort | undefined | 'unset' = 'unset'
    const executor: MemberTestExecutor = async (member, ctx) => {
      seen = ctx.evidenceArtifacts
      return passResult(member.testId)
    }
    const session = startRun(
      baseConfig({
        members: [{ testId: 'a', name: 'test a', filePath: 'a.test.ts' }],
        executor,
        ports: { handoffStore: makeFakeHandoffStore(), eventLog: makeFakeEventLog() },
      }),
    )
    drain(session)
    await done(session)

    expect(seen).toBeUndefined()
  })
})

describe('§A9 root-cause classification at the assembly seam (373-07, D-05/RCC-02)', () => {
  it('persists a producer-stamped deterministic verdict for a failing member (round-trip)', async () => {
    const store = makeFakeHandoffStore()
    const session = startRun(
      baseConfig({
        members: [
          { testId: 'a', name: 'test a', filePath: 'a.test.ts' },
          { testId: 'b', name: 'test b', filePath: 'b.test.ts' },
        ],
        executor: scriptedExecutor({ a: failResult('a', 'assertion mismatch'), b: passResult('b') }, []),
        ports: { handoffStore: store, eventLog: makeFakeEventLog() },
      }),
    )
    await done(session)

    expect(store.saved).toHaveLength(1)
    const rootCause = store.saved[0].tests[0].rootCause
    expect(rootCause?.producer).toBe('deterministic-classifier')
    expect(['timeout', 'environment', 'flake', 'unknown']).toContain(rootCause?.class)
  })

  it('classifies a failed member environment from a 503 baseline probe carried ON THE MEMBER (D-04)', async () => {
    const store = makeFakeHandoffStore()
    const session = startRun(
      baseConfig({
        members: [
          {
            testId: 'a',
            name: 'test a',
            filePath: 'a.test.ts',
            baselineProbe: { status: 503, elapsedMs: 230 },
          },
        ],
        executor: scriptedExecutor({ a: failResult('a', 'assertion mismatch') }, []),
        ports: { handoffStore: store, eventLog: makeFakeEventLog() },
      }),
    )
    const { handoff } = await done(session)

    expect(handoff.tests[0].rootCause?.class).toBe('environment')
    expect(handoff.tests[0].rootCause?.evidence.rationale).toBe('health probe: 503 in 230ms')
    expect(store.saved[0].tests[0].rootCause?.evidence.rationale).toBe('health probe: 503 in 230ms')
  })

  it('each member is classified against its OWN target’s baseline, never a sibling’s (401-19, WR-04)', async () => {
    // The two members name two different web targets. One target is sick, the other is healthy —
    // which is a state a run-level baseline cannot represent at all, and is why a run-level value
    // applied to everyone reports the healthy target's member as an environment failure.
    const store = makeFakeHandoffStore()
    const session = startRun(
      baseConfig({
        members: [
          {
            testId: 'a',
            name: 'test a',
            filePath: 'a.test.ts',
            baselineProbe: { status: 503, elapsedMs: 230 },
          },
          { testId: 'b', name: 'test b', filePath: 'b.test.ts' },
        ],
        executor: scriptedExecutor(
          { a: failResult('a', 'assertion mismatch'), b: failResult('b', 'assertion mismatch') },
          [],
        ),
        ports: { handoffStore: store, eventLog: makeFakeEventLog() },
      }),
    )
    const { handoff } = await done(session)

    // BOTH HALVES. The first is that the member's own baseline is read at all; the second — the one
    // WR-04 is about — is that the sibling with no baseline of its own does not inherit it.
    expect(handoff.tests[0].rootCause?.class).toBe('environment')
    expect(handoff.tests[0].rootCause?.evidence.rationale).toBe('health probe: 503 in 230ms')
    expect(handoff.tests[1].rootCause?.class).not.toBe('environment')
    expect(JSON.stringify(handoff.tests[1].rootCause)).not.toContain('health probe')
  })

  it('leaves an all-passing run rootCause-free everywhere in the serialized handoff (presence rule)', async () => {
    const store = makeFakeHandoffStore()
    const session = startRun(
      baseConfig({
        members: [
          { testId: 'a', name: 'test a', filePath: 'a.test.ts' },
          { testId: 'b', name: 'test b', filePath: 'b.test.ts' },
        ],
        executor: scriptedExecutor({ a: passResult('a'), b: passResult('b') }, []),
        ports: { handoffStore: store, eventLog: makeFakeEventLog() },
      }),
    )
    await done(session)

    expect(store.saved).toHaveLength(1)
    expect(JSON.stringify(store.saved[0])).not.toContain('rootCause')
  })
})

// ---- The post-verdict step (404 D-10/D-11) -------------------------------
//
// THE CONTRACT UNDER TEST IS "DEGRADE, NEVER GATE". The shell delays `runFinished` for exactly one
// host-supplied step, and every way that step can fail to decide must end the same way: the wire
// reads `detached`, a named `runWarning` says why, `done` still resolves, and `runFinished` is
// still last and still once. These cells drive all four ways — warned, thrown, timed out, absent
// (the absent arm is pinned by the ordering cell far above, which composes no port) — plus the two
// deciding answers, plus what the step is actually told.
//
// EVERY CELL BELOW IS ORDER-AWARE. `orderLog` is written by the artifact store and by the port
// itself, so "after finalize, before runFinished" is read off the sequence the shell actually
// executed rather than inferred from the event list alone.

/**
 * A port that IS a `PostVerdictPort` and also a spy.
 *
 * The intersection rather than a bare `{ run: Mock }`: the shell must accept this value through the
 * real port type, so a cell cannot accidentally pin a shape the production seam would reject.
 */
type FakePostVerdictPort = PostVerdictPort & { run: ReturnType<typeof vi.fn> }

function makeOrderingArtifactStore(log: string[]): RunArtifactStorePort {
  return {
    stage(_document: RunArtifactStageInput) {
      log.push('artifact.stage')
    },
    finalize(_patch: RunArtifactFinalizeInput) {
      log.push('artifact.finalize')
    },
  }
}

function warningsOf(events: RunEventEnvelope[], code: string): RunEventEnvelope[] {
  return events.filter(
    e => e.type === 'runWarning' && (e.payload as { code?: string }).code === code,
  )
}

describe('post-verdict step — the degrade-never-gate contract (404 D-10/D-11)', () => {
  it('a port answering handedOff decides the wire, publishes no warning, and ran AFTER finalize and BEFORE runFinished', async () => {
    const orderLog: string[] = []
    let sawRunFinishedDuringStep = true
    let events: RunEventEnvelope[] = []
    const port: FakePostVerdictPort = {
      run: vi.fn(async () => {
        orderLog.push('postVerdict')
        sawRunFinishedDuringStep = events.some(e => e.type === 'runFinished')
        return { disposition: 'handedOff' as const }
      }),
    }
    const session = startRun(
      baseConfig({
        ports: {
          handoffStore: makeFakeHandoffStore(),
          eventLog: makeFakeEventLog(),
          runArtifactStore: makeOrderingArtifactStore(orderLog),
          postVerdict: port,
        },
      }),
    )
    events = drain(session)
    await done(session)

    const finishes = events.filter(e => e.type === 'runFinished')
    expect(finishes, 'runFinished is published exactly once').toHaveLength(1)
    expect(
      (finishes[0].payload as { disposition: string }).disposition,
      'the shell publishes whatever posture the step decided',
    ).toBe('handedOff')
    expect(
      events.filter(e => e.type === 'runWarning'),
      'a step that decided cleanly gives the run nothing to warn about',
    ).toEqual([])
    expect(
      orderLog,
      'the step is awaited AFTER the artifact finalize and before anything else',
    ).toEqual(['artifact.stage', 'artifact.finalize', 'postVerdict'])
    expect(
      sawRunFinishedDuringStep,
      'runFinished had not been published yet while the step was still running',
    ).toBe(false)
  })

  it('a port answering detached WITH a warning publishes exactly that code and message, before runFinished', async () => {
    let events: RunEventEnvelope[] = []
    const port: FakePostVerdictPort = {
      run: vi.fn(async () => ({
        disposition: 'detached' as const,
        warning: { code: 'writer-lease-refused', message: 'corrupt-epoch-state' },
      })),
    }
    const session = startRun(
      baseConfig({
        ports: {
          handoffStore: makeFakeHandoffStore(),
          eventLog: makeFakeEventLog(),
          postVerdict: port,
        },
      }),
    )
    events = drain(session)
    await done(session)

    const refusals = warningsOf(events, 'writer-lease-refused')
    expect(refusals, 'the step\'s own warning is published exactly once').toHaveLength(1)
    expect(
      (refusals[0].payload as { message: string }).message,
      'the shell relays the step\'s message verbatim rather than composing its own',
    ).toBe('corrupt-epoch-state')
    const finish = events.find(e => e.type === 'runFinished')
    expect(finish, 'runFinished is still published').toBeDefined()
    expect(
      refusals[0].seq,
      'the reason lands before the wire that carries the posture it explains',
    ).toBeLessThan(finish!.seq)
    expect((finish!.payload as { disposition: string }).disposition).toBe('detached')
  })

  it('a port that REJECTS degrades to detached with post-verdict-step-failed, and done still resolves', async () => {
    let events: RunEventEnvelope[] = []
    const port: FakePostVerdictPort = {
      run: vi.fn(async () => {
        throw new Error('sqlite is busy')
      }),
    }
    const session = startRun(
      baseConfig({
        ports: {
          handoffStore: makeFakeHandoffStore(),
          eventLog: makeFakeEventLog(),
          postVerdict: port,
        },
      }),
    )
    events = drain(session)
    const { verdict } = await done(session)

    expect(verdict, 'a step that threw cannot change the run\'s verdict').toBe('passed')
    const failures = warningsOf(events, 'post-verdict-step-failed')
    expect(failures, 'the throw is named exactly once').toHaveLength(1)
    expect(
      (failures[0].payload as { message: string }).message,
      'the error\'s own message is what a reader gets',
    ).toBe('sqlite is busy')
    const finishes = events.filter(e => e.type === 'runFinished')
    expect(finishes, 'runFinished is still last and still once').toHaveLength(1)
    expect(events[events.length - 1].type).toBe('runFinished')
    expect((finishes[0].payload as { disposition: string }).disposition).toBe('detached')
  })

  it('a port that NEVER resolves is bounded: done stays pending until the budget fires, then reads detached with post-verdict-step-timeout', async () => {
    const timer = makeFakeTimer()
    let events: RunEventEnvelope[] = []
    const port: FakePostVerdictPort = {
      run: vi.fn(() => new Promise<never>(() => { /* answers never */ })),
    }
    const session = startRun(
      baseConfig({
        ports: {
          handoffStore: makeFakeHandoffStore(),
          eventLog: makeFakeEventLog(),
          timer,
          postVerdict: port,
        },
      }),
    )
    events = drain(session)
    await vi.waitFor(() => {
      expect(port.run).toHaveBeenCalled()
    })

    // THE BOUND IS REAL, NOT A RACE THE FAKE TIMER HAPPENED TO WIN. With the budget NOT fired the
    // run must still be waiting: if `done` resolved here, the timeout cell below would be green for
    // a shell that never armed a bound at all.
    const sentinel = Symbol('still-pending')
    const pending = await Promise.race([
      done(session).then(() => 'resolved' as const),
      new Promise<typeof sentinel>(resolve => { setTimeout(() => resolve(sentinel), 25) }),
    ])
    expect(pending, 'done does not resolve while the step is still inside its budget').toBe(sentinel)

    timer.fireLatest()
    const { verdict } = await done(session)
    expect(verdict, 'a step that hung cannot change the run\'s verdict').toBe('passed')
    const timeouts = warningsOf(events, 'post-verdict-step-timeout')
    expect(timeouts, 'the overrun is named exactly once').toHaveLength(1)
    expect(
      (timeouts[0].payload as { message: string }).message,
      'the warning names the budget the step overran',
    ).toContain(String(POST_VERDICT_STEP_BUDGET_MS))
    const finishes = events.filter(e => e.type === 'runFinished')
    expect(finishes).toHaveLength(1)
    expect((finishes[0].payload as { disposition: string }).disposition).toBe('detached')
    expect(events[events.length - 1].type).toBe('runFinished')
  })

  it('the step is told the runId and the aggregate verdict, and NOTHING the config did not carry', async () => {
    const port: FakePostVerdictPort = {
      run: vi.fn(async () => ({ disposition: 'drained' as const })),
    }
    const session = startRun(
      baseConfig({
        executor: scriptedExecutor({ a: failResult('a') }, []),
        ports: {
          handoffStore: makeFakeHandoffStore(),
          eventLog: makeFakeEventLog(),
          postVerdict: port,
        },
      }),
    )
    drain(session)
    await done(session)

    expect(port.run, 'the step runs exactly once per run').toHaveBeenCalledTimes(1)
    const input = port.run.mock.calls[0][0] as Record<string, unknown>
    expect(input.runId, 'the step is told the run it is deciding for').toBe('run-1')
    expect(input.verdict, 'the step is told the AGGREGATE verdict, not a member outcome').toBe('failed')
    expect(
      Object.keys(input).sort(),
      'absent markers are ABSENT keys — never an undefined a consumer must re-check',
    ).toEqual(['runId', 'verdict'])
  })

  it('the step is told gateRun and excludedFromOutcomes exactly when the config carries them', async () => {
    const port: FakePostVerdictPort = {
      run: vi.fn(async () => ({ disposition: 'drained' as const })),
    }
    const session = startRun(
      baseConfig({
        gateRun: true,
        excludedFromOutcomes: true,
        ports: {
          handoffStore: makeFakeHandoffStore(),
          eventLog: makeFakeEventLog(),
          postVerdict: port,
        },
      }),
    )
    drain(session)
    await done(session)

    const input = port.run.mock.calls[0][0] as Record<string, unknown>
    expect(
      Object.keys(input).sort(),
      'both INVK-06 markers ride the step input when the run carries them',
    ).toEqual(['excludedFromOutcomes', 'gateRun', 'runId', 'verdict'])
    expect(input.gateRun, 'only the literal true carries').toBe(true)
    expect(input.excludedFromOutcomes, 'only the literal true carries').toBe(true)
  })

  it('done resolves only after runFinished AND bus.close() — the 403-03 D-3 invariant, restated over the new step', async () => {
    let events: RunEventEnvelope[] = []
    const port: FakePostVerdictPort = {
      run: vi.fn(async () => ({ disposition: 'drained' as const })),
    }
    const session = startRun(
      baseConfig({
        ports: {
          handoffStore: makeFakeHandoffStore(),
          eventLog: makeFakeEventLog(),
          postVerdict: port,
        },
      }),
    )
    events = drain(session)
    await done(session)

    expect(events[events.length - 1].type, 'runFinished is the last thing the bus published').toBe('runFinished')

    // A LATE SUBSCRIBER SEES A CLOSED BUS. Its replay ends at `runFinished`, and — because a
    // detaching replay makes the bus publish `subscriber-detached`, which a closed bus refuses —
    // a throwing late subscriber raises the closed-bus error instead. That is the observable form
    // of "bus.close() had already run when `done` resolved".
    const late: RunEventEnvelope[] = []
    session.subscribe(1, event => late.push(event))
    expect(late[late.length - 1].type, 'a late subscriber replays to runFinished and no further').toBe('runFinished')
    expect(
      () => session.subscribe(1, () => { throw new Error('late subscriber faults') }),
      'the bus was already closed when done resolved',
    ).toThrow(/after close\(\)/u)
  })
})

// Keep vi referenced (fake-timer discipline utility) so lint does not flag the import.
void vi
