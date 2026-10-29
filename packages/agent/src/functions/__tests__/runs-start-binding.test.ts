// `bindingStatus` is computed per composition, and `invokeFunction` refuses on the listed answer.

import {
  CURRENT_HANDOFF_SCHEMA_VERSION,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type {
  CompletedRunHandoff,
  ExecutionContext,
  FunctionCaller,
  RunId,
  RunStartAcknowledgement,
  RunsStartInput,
} from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { FunctionNotBoundError, invokeFunction } from '../invoke.js'
import { RUNS_START_FUNCTION_ID, RunNotRecordedError, runsStartSpec } from '../ops/runs-start.js'
import { createFunctionRegistry, createRegistryFromSpecs, resolveBindingStatus } from '../registry.js'
import type { FunctionDeps, FunctionSpec, RunInvocationPort } from '../spec.js'

// Every context a capability call can be made in; none refuses a call.
const EVERY_CONTEXT: readonly ExecutionContext[] = [
  'local-interactive',
  'local-headless',
  'ci',
  'cloud',
]

// `origin` stays `human` as attribution only.
const RUN_CALLER: FunctionCaller = {
  surface: 'test',
  origin: 'human',
}

// Input validation precedes the binding check, so each id needs an input that parses.
const BINDING_PARITY_INPUTS: Readonly<Record<string, unknown>> = {
  'agent.ask': { message: 'proposals' },
  'agent.explain': { query: 'what can you do' },
  'analysis.get': { runId: 'run-alpha' },
  // The path needs a test-file extension, or a pure refusal fires before the binding check.
  'authoring.draft.verify': { draftPath: 'tests/nothing-in-this-fixture.yaml' },
  'authoring.draft.write': {
    intent: 'nothing in this fixture can author this',
    scope: { tier: 'product', key: 'nothing-in-this-fixture' },
  },
  // The exact-address ref skips the entity resolver, which would refuse free text first.
  'authoring.draft.edit': {
    testRef: 'tests/nothing-in-this-fixture.yaml::Nothing In This Fixture',
    intent: 'nothing in this fixture can edit this',
  },
  'authoring.funnel.get': { window: { scope: 'all-time' } },
  'runs.get': { runId: 'run-alpha' },
  'runs.events': { runId: 'run-alpha' },
  'runs.liveurl': { runId: 'run-alpha' },
  'editor.liveurl': { sessionId: 's1' },
  'runs.mark': { runId: 'run-alpha', kind: 'false-fail' },
  'runs.mark.preview': { runId: 'run-alpha', kind: 'false-fail' },
  'runs.marks.history': { runId: 'run-alpha' },
  'runs.postprocessing': { runId: 'run-alpha' },
  'runs.detail': { runId: 'run-alpha' },
  'runs.overview': { runId: 'run-alpha' },
  'runs.evidence': { runId: 'run-alpha', testIndex: 0, stepIndex: 0, kind: 'console' },
  // The sha must be 64 lowercase hex characters to parse.
  'runs.artifact': { runId: 'run-alpha', sha: 'a'.repeat(64) },
  'runs.digest': { runId: 'run-alpha' },
  'knowledge.accept': { target: { grain: 'record', recordId: 'rec-x' } },
  'knowledge.reject': { target: { grain: 'record', recordId: 'rec-x' }, reason: 'no' },
  'knowledge.forget': { target: { grain: 'record', recordId: 'rec-x' } },
  'knowledge.proposal.apply': { proposalId: 'prop_0123456789ab' },
  'quarantine.release': {
    product: 'shop',
    filePath: 'tests/checkout.test.yaml',
    testName: 'checkout completes',
  },
  'quarantine.add': {
    product: 'shop',
    filePath: 'tests/checkout.test.yaml',
    testName: 'checkout completes',
  },
  'proposals.show': { proposalId: 'prop_0123456789ab' },
  'proposals.reject': { proposalId: 'prop_0123456789ab' },
  'proposals.accept': { proposalId: 'prop_0123456789ab' },
  'config.auth.set': { target: 'shop', pluginPackage: '@acme/auth' },
  'config.field.set': { path: 'use.timeout', value: '45s' },
  'config.hook.add': { name: 'seed', runtime: 'node', file: 'scripts/seed.mjs' },
  'config.target.create': { name: 'shop', platform: 'web', url: 'https://shop.example.com' },
  'config.target.edit': { name: 'shop', changes: { url: 'https://shop.example.com/basket' } },
  'config.undo.propose': {},
  'config.project.scaffold': { domain: 'shop.example.com' },
  'config.proposal.apply': { proposalId: 'prop_0123456789ab' },
}

/**
 * The recorded run, with values that appear NOWHERE in any request below.
 *
 * Deliberate: an acknowledgment assembled from the request, or from a plausible default,
 * cannot produce `product/checkout`, ordinal 41, or two member tests. Only reading the run's
 * own record can.
 */
function recordedRun(runId: string): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: runId as RunId,
    scope: { tier: 'product', key: 'checkout' },
    buildOrdinal: 41,
    executionContext: 'local-headless',
    aggregateVerdict: 'failed',
    configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
    startedAt: 1_700_000_000_123,
    endedAt: 1_700_000_009_876,
    gateRun: true,
    tests: [
      {
        testId: 'test-1',
        testName: 'checks out',
        filePath: 'tests/checkout.yaml',
        testIndex: 0,
        outcome: 'failed',
        steps: [],
      },
      {
        testId: 'test-2',
        testName: 'reorders',
        filePath: 'tests/reorder.yaml',
        testIndex: 1,
        outcome: 'passed',
        steps: [],
      },
    ] as CompletedRunHandoff['tests'],
  }
}

/** A well-formed acknowledgment, for the spec whose body must never be reached. */
function toRunStartAcknowledgement(): RunStartAcknowledgement {
  const document = recordedRun('run-alpha')
  return {
    runId: document.runId,
    scope: document.scope,
    executionContext: document.executionContext,
    buildOrdinal: document.buildOrdinal,
    startedAt: document.startedAt,
    testCount: document.tests.length,
  }
}

interface Recorder {
  port: RunInvocationPort
  requests: () => readonly RunsStartInput[]
}

/** A run executor that records what it was asked for and reports the run it "started". */
function recordingInvocation(runIds: readonly string[] = ['run-alpha']): Recorder {
  const requests: RunsStartInput[] = []
  let index = 0
  return {
    port: {
      start(request) {
        requests.push(request)
        const runId = runIds[Math.min(index, runIds.length - 1)]!
        index += 1
        return Promise.resolve({ runId: runId as RunId })
      },
    },
    requests: () => requests,
  }
}

function deps(overrides: Partial<FunctionDeps> = {}): FunctionDeps {
  const documents = [recordedRun('run-alpha')]
  return {
    runs: {
      list: () => Promise.resolve(documents),
      get: (runId) => Promise.resolve(documents.find((document) => document.runId === runId)),
      readEvents: () => Promise.resolve([]),
      readStepEvidence: () => Promise.resolve({ kind: 'run-not-recorded' } as const),
    },
    knowledge: {
      listBundles: () => Promise.resolve([]),
      inspectRecords: () => Promise.resolve([]),
      diffSince: () => Promise.resolve([]),
      showRecord: ({ recordId }) => Promise.resolve({ kind: 'not-found', schemaVersion: 2, recordId } as const),
    },
    // `entities` is required; an answering stub, because nothing in this file mints an address.
    entities: {
      resolve: () => Promise.resolve({ kind: 'none' as const, reason: 'no-match' as const }),
      get: () => Promise.resolve(undefined),
    },
    config: {
      getMasked: () => Promise.resolve({
        schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
        configPath: 'agent-qa.config.yaml',
        entries: [],
      }),
    },
    ...overrides,
  }
}

// With no op gate, an ask-tier capability reaches the binding check directly.

function registryWith(runInvocation: RunInvocationPort | undefined) {
  return createFunctionRegistry({
    deps: deps(runInvocation === undefined ? {} : { runInvocation }),
  })
}

function statusOf(registry: ReturnType<typeof registryWith>, id: string): string | undefined {
  return registry.list(RUN_CALLER).find((declaration) => declaration.id === id)?.bindingStatus
}

describe('bindingStatus is a fact about a COMPOSITION, computed', () => {
  it('reads bound and unbound off ONE spec, from two registries in one process', () => {
    const bound = registryWith(recordingInvocation().port)
    const unbound = registryWith(undefined)

    expect(statusOf(bound, RUNS_START_FUNCTION_ID)).toBe('bound')
    expect(statusOf(unbound, RUNS_START_FUNCTION_ID)).toBe('unbound')
    // Same module-level singleton behind both listings: there is nothing per-registry on the
    // spec that could have been mutated to produce the difference.
    expect(runsStartSpec.boundThrough).toBe('runInvocation')
  })

  it('refuses in the composition that reports unbound and dispatches in the one that does not', async () => {
    await expect(invokeFunction(registryWith(undefined), RUNS_START_FUNCTION_ID, {}, RUN_CALLER))
      .rejects.toBeInstanceOf(FunctionNotBoundError)

    const acknowledgement = await invokeFunction(
      registryWith(recordingInvocation().port),
      RUNS_START_FUNCTION_ID,
      {},
      RUN_CALLER,
    ) as RunStartAcknowledgement
    expect(acknowledgement.runId).toBe('run-alpha')
  })

  it('never lets a listing and the gate disagree, for EVERY registered capability', async () => {
    // Registry-driven rather than id-keyed: a capability added later is covered by this case
    // on the day it is registered. The property is the one a caller depends on — what the
    // catalog says about a host is what the host does.
    for (const runInvocation of [recordingInvocation().port, undefined]) {
      const registry = registryWith(runInvocation)
      for (const declaration of registry.list(RUN_CALLER)) {
        const outcome = await invokeFunction(
          registry,
          declaration.id,
          BINDING_PARITY_INPUTS[declaration.id] ?? {},
          RUN_CALLER,
        ).then(() => 'dispatched', (error: unknown) => (
          error instanceof FunctionNotBoundError ? 'refused-unbound' : 'dispatched'
        ))

        expect(outcome, `${declaration.id} @ ${declaration.bindingStatus}`)
          .toBe(declaration.bindingStatus === 'bound' ? 'dispatched' : 'refused-unbound')
      }
    }
  })

  it('refuses on the DECLARATION, whatever the implementation would have done', async () => {
    // This spec ignores its deps and succeeds, so only the declaration check can stop it running.
    let ran = 0
    const eagerlyBound: FunctionSpec = {
      ...(runsStartSpec as FunctionSpec),
      id: 'runs.start',
      invoke: () => {
        ran += 1
        return Promise.resolve(toRunStartAcknowledgement())
      },
    }
    const registry = createRegistryFromSpecs([eagerlyBound], {
      deps: deps(),
    })

    await expect(invokeFunction(registry, RUNS_START_FUNCTION_ID, {}, RUN_CALLER))
      .rejects.toBeInstanceOf(FunctionNotBoundError)
    expect(ran).toBe(0)
  })

  it('resolves every OTHER op bound in both compositions — the difference is one capability', () => {
    const bound = registryWith(recordingInvocation().port)
    const unbound = registryWith(undefined)
    const differing = bound.list(RUN_CALLER).filter((declaration) => (
      declaration.bindingStatus !== statusOf(unbound, declaration.id)
    ))

    expect(differing.map((declaration) => declaration.id)).toEqual([RUNS_START_FUNCTION_ID])
  })
})

// Neither cell hands the registry a context: dispatch takes no execution context at all, and
// "every context" holds because there is no context input left to refuse on. Each context still
// gets its own dispatch and recorder below.
describe('runs.start, proven through a dispatch', () => {
  it('allows AND runs in every execution context, fail-closed ones included', async () => {
    for (const context of EVERY_CONTEXT) {
      const recorder = recordingInvocation()

      const acknowledgement = await invokeFunction(
        registryWith(recorder.port),
        RUNS_START_FUNCTION_ID,
        {},
        RUN_CALLER,
      ) as RunStartAcknowledgement

      expect(recorder.requests(), context).toHaveLength(1)
      expect(acknowledgement.runId, context).toBe('run-alpha')
    }
  })

  it('keeps the dispatch even on a destructive descriptor', async () => {
    const recorder = recordingInvocation()
    const destructive: FunctionSpec = {
      ...(runsStartSpec as FunctionSpec),
      risk: { ...runsStartSpec.risk, destructive: true },
    }
    const registry = createRegistryFromSpecs([destructive], {
      deps: deps({ runInvocation: recorder.port }),
    })

    await expect(invokeFunction(registry, RUNS_START_FUNCTION_ID, {}, RUN_CALLER))
      .resolves.toMatchObject({ runId: 'run-alpha' })
    expect(recorder.requests()).toHaveLength(1)
  })
})

describe('the acknowledgment describes the RUN, not the request', () => {
  it('reads every field off the run own record, through the same reader runs.get answers from', async () => {
    const acknowledgement = await invokeFunction(
      registryWith(recordingInvocation().port),
      RUNS_START_FUNCTION_ID,
      // A request that agrees with the recorded run about nothing at all.
      { patterns: ['tests/unrelated.yaml'] },
      RUN_CALLER,
    ) as RunStartAcknowledgement

    expect(acknowledgement).toEqual({
      runId: 'run-alpha',
      scope: { tier: 'product', key: 'checkout' },
      executionContext: 'local-headless',
      buildOrdinal: 41,
      startedAt: 1_700_000_000_123,
      testCount: 2,
      // Copied from the RECORD. The request set no marker, so an echo of the request would
      // have produced no marker at all — which is precisely the "assume the request survived
      // resolution" failure the contract warns about.
      gateRun: true,
    })
  })

  it('refuses a host that reports a run it did not record — the anti-fabrication control', async () => {
    const invented = recordingInvocation(['run-that-never-ran'])

    const thrown = await invokeFunction(
      registryWith(invented.port),
      RUNS_START_FUNCTION_ID,
      {},
      RUN_CALLER,
    ).catch((error: unknown) => error)

    expect(thrown).toBeInstanceOf(RunNotRecordedError)
    expect((thrown as RunNotRecordedError).runId).toBe('run-that-never-ran')
    // Named distinctly from the unbound refusal: the capability IS bound here, and what
    // failed is the host's claim that a run happened.
    expect(thrown).not.toBeInstanceOf(FunctionNotBoundError)
  })

  it('hands the executor the VALIDATED request, not the raw input', async () => {
    const recorder = recordingInvocation()

    await invokeFunction(
      registryWith(recorder.port),
      RUNS_START_FUNCTION_ID,
      { patterns: ['tests/checkout.yaml'] },
      RUN_CALLER,
    )

    expect(recorder.requests()).toEqual([{ patterns: ['tests/checkout.yaml'] }])
  })
})

describe('resolveBindingStatus is the one decision, and it is total', () => {
  it('answers bound for a spec that needs nothing optional, whatever the deps carry', () => {
    const alwaysBound = { ...(runsStartSpec as FunctionSpec), boundThrough: undefined }

    expect(resolveBindingStatus(alwaysBound, deps())).toBe('bound')
    expect(resolveBindingStatus(runsStartSpec as FunctionSpec, deps())).toBe('unbound')
    expect(resolveBindingStatus(
      runsStartSpec as FunctionSpec,
      deps({ runInvocation: recordingInvocation().port }),
    )).toBe('bound')
  })
})
