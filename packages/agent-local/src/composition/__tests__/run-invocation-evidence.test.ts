// THE ANTI-FABRICATION PAIR, OVER THE CORE (Phase 401 plan 05 — RESEARCH Pitfall 5, T-401-13).
//
// `runs.start` is the one op whose answer names facts about the world: a run id, a scope, a build
// ordinal, how many member tests were admitted. Two mechanisms make that answer worth reading, and
// they were built against a wire that no longer exists — the host spawned `agent-qa run` and the
// composition read the child's leavings back off disk. This phase replaced the spawn with an
// in-process core. Both mechanisms survive UNCHANGED by decision, so this file is the regression
// net that says so over the NEW wire:
//
//   `RunProducedNoEventsError` — the composition refuses a host that reports a run id without a
//   run behind it. Its arm is a port that returns a plausible id and writes nothing.
//
//   `RunNotRecordedError` — the op refuses to build an acknowledgment when the completed-run
//   record is missing. Its arm is a host that starts a run whose record never lands.
//
// THE TRIPWIRE, AND WHY IT IS THE POINT OF THIS FILE. The evidence check reads
// `buildRunPorts({ configDir: dirname(agentQaRoot) })`. If the core wrote its events under any
// other root, EVERY `runs.start` would raise `RunProducedNoEventsError` for a run that really
// happened — and the tempting repair is to delete the check. So the positive cell reads through
// that same construction rather than a path it composes, and the cell below it shows the check is
// SENSITIVE to the root: the identical run, verified against a different root, is refused.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { invokeFunction } from '@vostride/agent-qa-agent'
import { MASKED_RESOLVED_CONFIG_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type {
  CompletedRunHandoff,
  FunctionCaller,
  MaskedResolvedConfig,
  ModelCapabilities,
  RecordedRetrievalRung,
  RunStartAcknowledgement,
  RunsStartInput,
} from '@vostride/agent-qa-schema'
import { makeScreenState, metVerification, runMemberTest } from '@vostride/agent-qa-runner'
import type { MemberRunConfig, PlatformAdapter } from '@vostride/agent-qa-runner'

import {
  RunProducedNoEventsError,
  composeLocalAgent,
  createLocalRunInvocation,
} from '../compose-local-agent.js'
import type { LocalAgentHost, RunExecutionPort } from '../compose-local-agent.js'
import {
  buildMemberRunConfig,
  buildRunPorts,
  openRunKnowledgeComposition,
} from '../run-composition.js'
import { createRunInvocationCore } from '../run-invocation-core.js'
import type { RunAssemblyContext, RunConfig } from '../run-invocation-core.js'

const CALLER: FunctionCaller = {
  surface: 'cli',
  origin: 'agent',
}

const MASKED_CONFIG: MaskedResolvedConfig = {
  schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
  configPath: '/fixture/agent-qa.config.yaml',
  entries: [{ key: 'use.llm', value: 'default', source: 'config-file', masked: false }],
}

let projectDir: string
let agentQaRoot: string
let hosts: LocalAgentHost[]

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'run-evidence-'))
  agentQaRoot = join(projectDir, '.agent-qa')
  hosts = []
})

afterEach(() => {
  for (const host of hosts) host.close()
  rmSync(projectDir, { recursive: true, force: true })
})

/**
 * A real one-member `RunConfig` whose executor is the only double.
 *
 * THE PORTS ARE THE CORE'S OWN, handed straight through. Substituting them here would leave the
 * persistence ROOTING — the thing Pitfall 5 is about — untested at exactly the seam that has to
 * hold, and this file's whole subject is that rooting.
 */
function assembleFixtureRun(
  context: RunAssemblyContext,
  stamped: { excludedFromOutcomes?: true } = {},
): RunConfig {
  return {
    ...stamped,
    runId: context.runId as RunConfig['runId'],
    scope: { tier: 'product', key: 'evidence-product' },
    executionContext: context.executionContext,
    buildOrdinal: 7,
    configDigests: { suiteConfigDigest: 'suite-d', testConfigDigest: 'test-d' },
    members: [{ testId: 't1', name: 'the only member', filePath: 'tests/one.yaml' }],
    executor: (member) => Promise.resolve({
      name: member.name,
      filePath: member.filePath,
      status: 'passed',
      steps: [{ name: 'a step', status: 'passed', duration: 1 }],
      duration: 1,
    }),
    ports: context.ports,
  }
}

/** The REAL gated core, as the `RunExecutionPort` a composition binds `runs.start` over. */
function coreExecution(
  mintRunId: () => string,
  stamped: { excludedFromOutcomes?: true } = {},
): RunExecutionPort {
  return createRunInvocationCore({
    configPath: join(projectDir, 'agent-qa.config.yaml'),
    agentQaRoot,
    // This file is about EVIDENCE. The core's own refusals are measured next door, in
    // `run-invocation-core.test.ts` and in the cli door's `runs-start-gate.test.ts`.
    executionContext: 'ci',
    mintRunId,
    // 401-20: the injected shape predicate. This file's runs are minted by the core, so the
    // predicate is never consulted; it is required, so it is supplied.
    isMintedRunId: (value: string): boolean => /^run_[a-z_]+$/.test(value),
    assembleRun: (context) => assembleFixtureRun(context, stamped),
  }) as RunExecutionPort
}

function compose(runExecution: RunExecutionPort): LocalAgentHost {
  const host = composeLocalAgent({
    mask: (text) => text,
    mintQuarantineIdentityPath: (filePath: string) => filePath,
    agentQaRoot,
    config: { getMasked: () => Promise.resolve(MASKED_CONFIG) },
    knowledgeRoot: () => join(projectDir, 'knowledge'),
    // Required by the composition and never reached here: nothing in this file opens the queue, and
    // a factory that threw would say so louder than one that quietly returns an unusable handle.
    model: () => { throw new Error('this fixture composes no model; nothing here should ask for one') },
    runExecution,
  })
  hosts.push(host)
  return host
}

/** Read the run's events back through the SAME construction the composition's check uses. */
function eventsUnderRoot(root: string, runId: string): string[] {
  return [...buildRunPorts({ configDir: dirname(root), runId }).eventLog.read(0)]
    .map((event) => event.type)
}

describe('the evidence pair holds over the in-process core', () => {
  it('A REAL CORE-DRIVEN RUN ACKS, and its log is under the composition’s OWN root', async () => {
    const invocation = createLocalRunInvocation({
      agentQaRoot,
      execution: coreExecution(() => 'run_core_drove_this'),
    })

    const started = await invocation.start({ patterns: ['tests/one.yaml'] })

    expect(String(started.runId)).toBe('run_core_drove_this')
    // THE READ-BACK, through `buildRunPorts` and not through a path this cell composes — which is
    // the difference between measuring the rooting and re-deriving it. A run that began at all
    // writes `runStarted` first.
    const types = eventsUnderRoot(agentQaRoot, String(started.runId))
    expect(types.length).toBeGreaterThan(0)
    expect(types[0]).toBe('runStarted')
    expect(types).toContain('runFinished')
    // …and it is the same directory the run's durable record went to.
    expect(existsSync(join(agentQaRoot, 'runs', 'run_core_drove_this', 'handoff.json'))).toBe(true)
  })

  it('THE TRIPWIRE IS LIVE — the same run, verified against a DIFFERENT root, is refused', async () => {
    // Pitfall 5 stated as a measurement rather than a warning. The run below really happens and
    // really leaves a full record; the only thing changed is the root the composition verifies
    // against. If a future edit moved the core's writes, THIS is the failure every `runs.start`
    // would produce — and the reason to fix the root rather than delete the check.
    const elsewhere = join(projectDir, 'somewhere-else', '.agent-qa')
    const invocation = createLocalRunInvocation({
      agentQaRoot: elsewhere,
      execution: coreExecution(() => 'run_written_under_the_real_root'),
    })

    await expect(invocation.start({ patterns: ['tests/one.yaml'] }))
      .rejects.toBeInstanceOf(RunProducedNoEventsError)

    // The run DID happen — this is not a run that failed, it is a check looking in the wrong place.
    expect(eventsUnderRoot(agentQaRoot, 'run_written_under_the_real_root')).toContain('runStarted')
    expect(eventsUnderRoot(elsewhere, 'run_written_under_the_real_root')).toEqual([])
  })

  it('THE NEGATIVE ARM STILL HAS TEETH — a port that reports an id and writes nothing is refused', async () => {
    // ONE ARGUMENT APART from the cell above, and that is the point: the same composition, the same
    // root, the same request. What changes is whether a run happened. The error class is asserted
    // — not a log line, not a soft fallback — and it carries the id it refused to believe in.
    const invocation = createLocalRunInvocation({
      agentQaRoot,
      execution: { execute: () => Promise.resolve({ runId: 'run_never_happened' as never }) },
    })

    let refusal: unknown
    try {
      await invocation.start({ patterns: ['tests/one.yaml'] })
    } catch (error) {
      refusal = error
    }

    expect(refusal).toBeInstanceOf(RunProducedNoEventsError)
    expect((refusal as RunProducedNoEventsError).runId).toBe('run_never_happened')
    expect(existsSync(join(agentQaRoot, 'runs', 'run_never_happened'))).toBe(false)
  })
})

describe('the runs.start ack is read off the durable record, over the core', () => {
  async function startThroughTheOp(
    request: RunsStartInput,
    mintRunId: () => string,
    stamped: { excludedFromOutcomes?: true } = {},
  ): Promise<RunStartAcknowledgement> {
    const host = compose(coreExecution(mintRunId, stamped))
    return await invokeFunction(
      host.registry,
      'runs.start',
      request,
      CALLER,
    ) as RunStartAcknowledgement
  }

  it('THE MARKERS ARE ECHOED OFF THE HANDOFF, never off the request', async () => {
    const ack = await startThroughTheOp(
      { patterns: ['tests/one.yaml'], gateRun: true },
      () => 'run_marked_gate',
    )

    expect(ack.runId).toBe('run_marked_gate')
    expect(ack.gateRun).toBe(true)
    // `excludedFromOutcomes` was not asked for, so it must be ABSENT rather than `false`: the
    // acknowledgment describes the run that started, and a marker nobody asserted is not a marker
    // set to no.
    expect(ack.excludedFromOutcomes).toBeUndefined()

    // THE SOURCE OF THAT `true`. Read off the run's own handoff, which is what makes the echo a
    // projection rather than a repetition: a request field copied straight into the answer would
    // agree with this assertion only by accident.
    const handoff = JSON.parse(readFileSync(
      join(agentQaRoot, 'runs', 'run_marked_gate', 'handoff.json'),
      'utf8',
    )) as CompletedRunHandoff
    expect(handoff.gateRun).toBe(true)
    expect(ack.buildOrdinal).toBe(handoff.buildOrdinal)
    expect(ack.scope).toEqual(handoff.scope)
    expect(ack.executionContext).toBe(handoff.executionContext)
    expect(ack.testCount).toBe(handoff.tests.length)
  })

  it('AN UNMARKED RUN ECHOES NEITHER MARKER — the absence is carried, not defaulted', async () => {
    const ack = await startThroughTheOp({ patterns: ['tests/one.yaml'] }, () => 'run_unmarked')

    expect(ack.runId).toBe('run_unmarked')
    expect(ack.gateRun).toBeUndefined()
    expect(ack.excludedFromOutcomes).toBeUndefined()
    expect(ack.testCount).toBe(1)
  })

  it('THE RECORD WINS WHERE THEY DISAGREE — a marker the request never asked for is still echoed', async () => {
    // THE DISCRIMINATING CASE, and the only one there is.
    //
    // The core rides the request's markers onto the `RunConfig`, so for a marker a caller ASKED for
    // the request and the record agree by construction and no assertion can tell which one the ack
    // was built from. The spread only ever ADDS, though — so an assembler that stamps a marker the
    // request is silent about creates the one disagreement available, and the ack has to follow the
    // RECORD. An acknowledgment assembled from the request would report `undefined` here.
    const ack = await startThroughTheOp(
      { patterns: ['tests/one.yaml'] },
      () => 'run_stamped_by_assembly',
      { excludedFromOutcomes: true },
    )

    const handoff = JSON.parse(readFileSync(
      join(agentQaRoot, 'runs', 'run_stamped_by_assembly', 'handoff.json'),
      'utf8',
    )) as CompletedRunHandoff
    expect(handoff.excludedFromOutcomes).toBe(true)
    expect(ack.excludedFromOutcomes).toBe(true)
    expect(ack.gateRun).toBeUndefined()
  })

  it('A FABRICATING PORT NEVER REACHES THE ACK — the op’s two refusals compose', async () => {
    const host = compose({
      execute: () => Promise.resolve({ runId: 'run_fabricated' as never }),
    })

    await expect(invokeFunction(host.registry, 'runs.start', {}, CALLER))
      .rejects.toMatchObject({ name: 'RunProducedNoEventsError' })
  })
})

// ---------------------------------------------------------------------------------------------
// 407-07 · D-13/D-16/D-17 — THE RUNG THREAD, FROM THE COMPOSITION ROOT TO A STEP'S EVIDENCE.
//
// The banner 407-10 paints reads a value recorded by the run that was served. Nothing else can be
// honest: a header that probed the host at render time would relabel a degraded run the moment
// the machine was fixed. So the rung is resolved ONCE here — where the knowledge root and the
// `.agent-qa` root are both known — and carried, never re-derived.
//
// The cells below pin the three joints that thread can come apart at, in order:
//   1. the composition CALLS the one resolver, once, with both roots;
//   2. `buildMemberRunConfig` carries the SAME promise object through (not a copy, not a re-await);
//   3. a real member run, through the REAL loop, lands that rung on every step's evidence.
// Joint 3 is what makes 1 and 2 more than plumbing assertions.
// ---------------------------------------------------------------------------------------------

const FIXTURE_RUNG: RecordedRetrievalRung = {
  schemaVersion: 2,
  rung: 'bundle-scan',
  reason: 'index-unavailable',
}

function fixtureAccounting() {
  return {
    getCeilings: () => ({ contextWindow: 32_768, maxOutput: 4_096 }),
    estimate: () => 32,
  }
}

function fixtureCapabilities(): ModelCapabilities {
  return {
    text: true,
    vision: true,
    visionToolMessages: true,
    toolCalling: true,
    structuredOutput: true,
    streaming: true,
    contextWindow: 32_768,
    maxOutput: 4_096,
  }
}

describe('the retrieval rung is resolved once at the composition root', () => {
  it('calls THE resolver exactly once, with both roots, and returns what it resolved', async () => {
    const knowledgeRoot = mkdtempSync(join(tmpdir(), 'rung-composition-'))
    try {
      const calls: Array<{ knowledgeRoot: string; agentQaRoot?: string }> = []
      const composition = openRunKnowledgeComposition({
        knowledgeRoot,
        product: 'shop',
        scope: { tier: 'test', key: 'checkout' },
        asOfBuild: 7,
        capabilities: fixtureCapabilities(),
        accounting: fixtureAccounting(),
        qaRulesText: 'rules',
        workingContextText: 'checkout context',
        agentQaRoot: join(knowledgeRoot, '..', '.agent-qa'),
        resolveRetrievalRung: (options) => {
          calls.push({ knowledgeRoot: options.knowledgeRoot, agentQaRoot: options.agentQaRoot })
          return Promise.resolve(FIXTURE_RUNG)
        },
      })

      await expect(composition.retrievalRung).resolves.toEqual(FIXTURE_RUNG)
      // ONCE. A per-step probe would make the recorded value a fact about render time rather than
      // about serve time, which is exactly the lie D-13 exists to prevent.
      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual({
        knowledgeRoot,
        agentQaRoot: join(knowledgeRoot, '..', '.agent-qa'),
      })
    } finally {
      rmSync(knowledgeRoot, { recursive: true, force: true })
    }
  })

  it('omits agentQaRoot entirely when the caller has none — never an undefined key', async () => {
    const knowledgeRoot = mkdtempSync(join(tmpdir(), 'rung-composition-noroot-'))
    try {
      const calls: Array<Record<string, unknown>> = []
      const composition = openRunKnowledgeComposition({
        knowledgeRoot,
        scope: { tier: 'test', key: 'checkout' },
        asOfBuild: 7,
        capabilities: fixtureCapabilities(),
        accounting: fixtureAccounting(),
        qaRulesText: 'rules',
        workingContextText: 'checkout context',
        resolveRetrievalRung: (options) => {
          calls.push({ ...options })
          return Promise.resolve(FIXTURE_RUNG)
        },
      })

      await composition.retrievalRung
      expect(calls).toHaveLength(1)
      expect('agentQaRoot' in calls[0]!).toBe(false)
    } finally {
      rmSync(knowledgeRoot, { recursive: true, force: true })
    }
  })
})

describe('buildMemberRunConfig carries the rung promise through', () => {
  it('threads the SAME promise object onto the member run config', () => {
    const promise = Promise.resolve(FIXTURE_RUNG)
    const config = buildMemberRunConfig({
      ...memberRunConfigFixtureInput(),
      knowledgeRetrievalRung: promise,
    })
    expect(config.knowledgeRetrievalRung).toBe(promise)
  })

  it('leaves the key absent when the caller passes none', () => {
    const config = buildMemberRunConfig(memberRunConfigFixtureInput())
    expect(config.knowledgeRetrievalRung).toBeUndefined()
  })
})

/** The minimum `buildMemberRunConfig` input — every slot this plan does not measure is a stub. */
function memberRunConfigFixtureInput(): Parameters<typeof buildMemberRunConfig>[0] {
  return {
    adapter: fixtureAdapter(),
    planner: { plan: () => { throw new Error('no planning in this cell') } },
    verifier: { verify: () => { throw new Error('no verification in this cell') } },
    plannerModel: {} as never,
    verifierModel: {} as never,
    sink: fixtureSink(),
    testIndex: 0,
    abortSignal: new AbortController().signal,
    filePath: 'tests/one.yaml',
  }
}

function fixtureAdapter(): PlatformAdapter {
  return {
    platform: 'web',
    setup: () => Promise.resolve(),
    cleanup: () => Promise.resolve(),
    observe: () => Promise.resolve(makeScreenState()),
    execute: () => Promise.resolve({ success: true }),
  } as unknown as PlatformAdapter
}

function fixtureSink(): MemberRunConfig['sink'] {
  return {
    stepStarted: () => {},
    loopEmitFor: () => ({ stepFinalized: () => {}, subActionRecorded: () => {} }),
    hookStarted: () => {},
    hookFinished: () => {},
    testRetryScheduled: () => {},
  } as unknown as MemberRunConfig['sink']
}

describe('THE THREAD END TO END — a real member run stamps the composed rung', () => {
  it('lands the composed rung on EVERY step of a run served by a bound reader', async () => {
    const knowledgeRoot = mkdtempSync(join(tmpdir(), 'rung-thread-'))
    try {
      const composition = openRunKnowledgeComposition({
        knowledgeRoot,
        product: 'shop',
        scope: { tier: 'test', key: 'checkout' },
        asOfBuild: 7,
        capabilities: fixtureCapabilities(),
        accounting: fixtureAccounting(),
        qaRulesText: 'rules',
        workingContextText: 'checkout context',
        agentQaRoot: join(knowledgeRoot, '.agent-qa'),
        resolveRetrievalRung: () => Promise.resolve(FIXTURE_RUNG),
      })

      const config = buildMemberRunConfig({
        ...memberRunConfigFixtureInput(),
        planner: {
          plan: () => Promise.resolve({
            plan: {
              reasoning: 'clicking the log in button',
              action: { type: 'click', ref: 'e2' },
              confidence: 0.9,
              stepComplete: true,
              stepFailed: false,
            },
          }),
        } as never,
        // 439 D-12: every member run binds a verifier; this one accepts each step.
        verifier: {
          verify: async (step, _before, after, action) => ({
            verification: metVerification({ step, after, action }),
          }),
        },
        knowledgeReader: composition.reader,
        knowledgeBudgets: composition.budgets,
        knowledgeAsOfBuild: 7,
        recordLedger: composition.recordLedger,
        knowledgeRetrievalRung: composition.retrievalRung,
      })

      const result = await runMemberTest(
        {
          testId: 't1',
          name: 'the only member',
          filePath: 'tests/one.yaml',
          steps: ['Click Log in', 'Click Log in again'],
        },
        config,
      )

      expect(result.steps).toHaveLength(2)
      for (const step of result.steps) {
        expect(step.evidence?.retrievalRung).toEqual(FIXTURE_RUNG)
      }
    } finally {
      rmSync(knowledgeRoot, { recursive: true, force: true })
    }
  })

  it('stamps NO rung when no reader is bound, even with a rung in hand', async () => {
    const config = buildMemberRunConfig({
      ...memberRunConfigFixtureInput(),
      planner: {
        plan: () => Promise.resolve({
          plan: {
            reasoning: 'clicking the log in button',
            action: { type: 'click', ref: 'e2' },
            confidence: 0.9,
            stepComplete: true,
            stepFailed: false,
          },
        }),
      } as never,
      knowledgeRetrievalRung: Promise.resolve(FIXTURE_RUNG),
    })

    const result = await runMemberTest(
      { testId: 't1', name: 'the only member', filePath: 'tests/one.yaml', steps: ['Click Log in'] },
      config,
    )

    expect(result.steps).toHaveLength(1)
    expect('retrievalRung' in result.steps[0]!.evidence!).toBe(false)
  })
})
