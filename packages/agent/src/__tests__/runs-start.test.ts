// Declared but unbound here is observable: `fakeDeps()` supplies no `runInvocation` port.

import { CURRENT_HANDOFF_SCHEMA_VERSION, MASKED_RESOLVED_CONFIG_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type { CompletedRunHandoff, FunctionCaller, RunId, RunStartAcknowledgement } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { FunctionNotBoundError, UnknownFunctionError, invokeFunction } from '../functions/invoke.js'
import { runsEventsSpec } from '../functions/ops/runs-events.js'
import { RUNS_START_FUNCTION_ID, runsStartSpec } from '../functions/ops/runs-start.js'
import { runsListSpec } from '../functions/ops/runs-list.js'
import { createRegistryFromSpecs } from '../functions/registry.js'
import type { FunctionDeps } from '../functions/spec.js'

function fakeDeps(): FunctionDeps {
  return {
    secretMask: (text: string) => text,
    runs: {
      list: () => Promise.resolve([]),
      get: () => Promise.resolve(undefined),
      readEvents: () => Promise.resolve([]),
      readStepEvidence: () => Promise.resolve({ kind: 'run-not-recorded' } as const),
    },
    knowledge: {
      listBundles: () => Promise.resolve([]),
      inspectRecords: () => Promise.resolve([]),
      diffSince: () => Promise.resolve([]),
      showRecord: ({ recordId }) => Promise.resolve({ kind: 'not-found', schemaVersion: 2, recordId } as const),
    },
    // A required read port, stubbed to answer: nothing in this file mints an address.
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
  }
}

// Attribution only: a surface and an origin, no grant.
const RUN_CALLER: FunctionCaller = {
  surface: 'test',
  origin: 'agent',
}

function registryWithRunsStart() {
  return createRegistryFromSpecs([runsListSpec, runsEventsSpec, runsStartSpec], {
    deps: fakeDeps(),
  })
}

describe('runs.start declaration', () => {
  it('declares its FULL contract and states what a composition must supply to run it', () => {
    expect(runsStartSpec.id).toBe(RUNS_START_FUNCTION_ID)
    expect(runsStartSpec.id).toBe('runs.start')
    expect(runsStartSpec).not.toHaveProperty('requiredScopes')
    expect(runsStartSpec.resultKind).toBe('unary')
    // The spec names a need; the composition's answer to it is what a declaration reports.
    expect(runsStartSpec.boundThrough).toBe('runInvocation')
  })

  it('carries no static binding claim at all — a spec cannot answer for a composition', () => {
    // No `bindingStatus` literal: binding is a fact about the composition, not the spec.
    expect(Object.keys(runsStartSpec)).not.toContain('bindingStatus')
    expect((runsStartSpec as unknown as Record<string, unknown>)['bindingStatus'])
      .toBeUndefined()
  })

  it('carries the gateRun marker on its declared input', () => {
    expect(runsStartSpec.input.safeParse({ gateRun: true }).success).toBe(true)
    expect(runsStartSpec.input.safeParse({ gateRun: false }).success).toBe(false)
    expect(runsStartSpec.input.safeParse({}).success).toBe(true)
  })

  it('declares an acknowledgment output naming the run a caller can then address', () => {
    const acknowledgement = {
      runId: 'run-alpha',
      scope: { tier: 'product', key: 'shop' },
      executionContext: 'ci',
      buildOrdinal: 12,
      startedAt: 1_700_000_000_000,
      testCount: 3,
    }

    expect(runsStartSpec.output.safeParse(acknowledgement).success).toBe(true)
    expect(runsStartSpec.output.safeParse({ runId: 'run-alpha' }).success).toBe(false)
  })
})

// The acknowledgement carries the limits the run recorded, never the request's.
describe('runs.start acknowledgement', () => {
  const plannerLimits = {
    maxActions: 30,
    maxPlanningTurns: 30,
    perTest: [{ testName: 'Bulk archive', filePath: 'tests/bulk.yaml', maxActions: 60, maxPlanningTurns: 30 }],
  }

  function recorded(withLimits: boolean): CompletedRunHandoff {
    return {
      schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
      runId: 'run-limits' as RunId,
      scope: { tier: 'product', key: 'shop' },
      buildOrdinal: 4,
      executionContext: 'local-headless',
      aggregateVerdict: 'passed',
      configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
      startedAt: 1_700_000_000_000,
      endedAt: 1_700_000_001_000,
      tests: [],
      ...(withLimits ? { plannerLimits } : {}),
    }
  }

  async function acknowledge(document: CompletedRunHandoff): Promise<RunStartAcknowledgement> {
    const base = fakeDeps()
    return runsStartSpec.invoke({}, {
      ...base,
      runs: { ...base.runs, get: () => Promise.resolve(document) },
      runInvocation: { start: () => Promise.resolve({ runId: document.runId }) },
    }) as Promise<RunStartAcknowledgement>
  }

  it('toAcknowledgement carries limits from the record', async () => {
    const acknowledgement = await acknowledge(recorded(true))
    expect(acknowledgement.limits).toEqual(plannerLimits)
    expect(runsStartSpec.output.parse(acknowledgement)).toEqual(acknowledgement)

    const without = await acknowledge(recorded(false))
    expect(without).not.toHaveProperty('limits')
    expect(JSON.parse(JSON.stringify(without))).not.toHaveProperty('limits')
  })

  it('RunStartAcknowledgementSchema accepts limits and still rejects unknown keys', () => {
    const acknowledgement = {
      runId: 'run-alpha',
      scope: { tier: 'product', key: 'shop' },
      executionContext: 'ci',
      buildOrdinal: 12,
      startedAt: 1_700_000_000_000,
      testCount: 3,
    }
    expect(runsStartSpec.output.safeParse({ ...acknowledgement, limits: plannerLimits }).success).toBe(true)
    expect(runsStartSpec.output.safeParse({ ...acknowledgement, limits: { maxActions: 30, maxPlanningTurns: 30 } }).success)
      .toBe(true)
    expect(runsStartSpec.output.safeParse({ ...acknowledgement, plannerLimits }).success).toBe(false)
    expect(runsStartSpec.output.safeParse({ ...acknowledgement, limits: { ...plannerLimits, extra: 1 } }).success)
      .toBe(false)
    expect(runsStartSpec.output.safeParse({
      ...acknowledgement,
      limits: { maxActions: 30, maxPlanningTurns: 30, perTest: [{ ...plannerLimits.perTest[0], extra: 1 }] },
    }).success).toBe(false)
    expect(runsStartSpec.output.safeParse({ ...acknowledgement, limits: { maxActions: 0, maxPlanningTurns: 30 } }).success)
      .toBe(false)
    expect(runsStartSpec.input.safeParse({ limits: plannerLimits }).success).toBe(false)
    expect(runsStartSpec.input.safeParse({ maxActions: 60 }).success).toBe(false)
  })
})

describe('runs.start is visibly unbound, never silently missing', () => {
  it('lists with bindingStatus unbound alongside the bound capabilities', () => {
    const declarations = registryWithRunsStart().list(RUN_CALLER)

    expect(Object.fromEntries(declarations.map((declaration) => [
      declaration.id,
      declaration.bindingStatus,
    ]))).toEqual({
      'runs.events': 'bound',
      'runs.list': 'bound',
      'runs.start': 'unbound',
    })
  })

  it('refuses invocation with a named error that says it is not bound HERE', async () => {
    const thrown = await invokeFunction(registryWithRunsStart(), 'runs.start', {}, RUN_CALLER)
      .catch((error: unknown) => error)

    expect(thrown).toBeInstanceOf(FunctionNotBoundError)
    expect((thrown as FunctionNotBoundError).name).toBe('FunctionNotBoundError')
    expect((thrown as FunctionNotBoundError).functionId).toBe('runs.start')
    expect((thrown as Error).message).toContain('runs.start')
    expect((thrown as Error).message).toContain('not bound in this composition')
  })

  it('is a DIFFERENT refusal from an id the registry never heard of', async () => {
    const registry = registryWithRunsStart()

    const unbound = await invokeFunction(registry, 'runs.start', {}, RUN_CALLER)
      .catch((error: unknown) => error)
    const unknown = await invokeFunction(registry, 'runs.stop', {}, RUN_CALLER)
      .catch((error: unknown) => error)

    expect(unbound).toBeInstanceOf(FunctionNotBoundError)
    expect(unknown).toBeInstanceOf(UnknownFunctionError)
    expect(unbound).not.toBeInstanceOf(UnknownFunctionError)
  })

  it('an unbound attempt refuses by name and records no decision row', async () => {
    const thrown = await invokeFunction(registryWithRunsStart(), 'runs.start', {}, RUN_CALLER)
      .catch((error: unknown) => error)

    expect(thrown).toBeInstanceOf(FunctionNotBoundError)
  })

  it('serves a caller lacking the run scope up to the same binding check', async () => {
    const readOnlyCaller: FunctionCaller = {
      surface: 'mcp',
      origin: 'human',
    }

    const thrown = await invokeFunction(
      registryWithRunsStart(),
      'runs.start',
      {},
      readOnlyCaller,
    ).catch((error: unknown) => error)

    expect(thrown).toBeInstanceOf(FunctionNotBoundError)
    expect((thrown as Error).name).not.toBe('FunctionScopeError')
  })

  // Callers differing in every field meet the same binding refusal, never a permission error.
  it('a retried unbound start refuses by binding alone for every caller', async () => {
    const registry = registryWithRunsStart()
    const callers: readonly FunctionCaller[] = [
      RUN_CALLER,
      { surface: 'cli', origin: 'human' },
      { surface: 'mcp', origin: 'agent' },
    ]

    const names: string[] = []
    for (const caller of callers) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const thrown = await invokeFunction(registry, 'runs.start', {}, caller)
          .catch((error: unknown) => error)
        expect(thrown).toBeInstanceOf(FunctionNotBoundError)
        names.push((thrown as Error).name)
      }
    }
    expect(names).toEqual(Array.from({ length: 6 }, () => 'FunctionNotBoundError'))

    const declared = callers.map((caller) => registry.list(caller)
      .map((declaration) => [declaration.id, declaration.bindingStatus]))
    expect(declared[0]).toEqual([
      ['runs.events', 'bound'],
      ['runs.list', 'bound'],
      ['runs.start', 'unbound'],
    ])
    expect(declared[1]).toEqual(declared[0])
    expect(declared[2]).toEqual(declared[0])
  })

  // The bound read beside the unbound start is served alike to the same three callers.
  it('a retried bound runs.list is served alike to every caller', async () => {
    const deps = fakeDeps()
    let listCalls = 0
    const registry = createRegistryFromSpecs([runsListSpec, runsEventsSpec, runsStartSpec], {
      deps: {
        ...deps,
        runs: { ...deps.runs, list: () => { listCalls += 1; return Promise.resolve([]) } },
      },
    })
    const callers: readonly FunctionCaller[] = [
      RUN_CALLER,
      { surface: 'cli', origin: 'human' },
      { surface: 'mcp', origin: 'agent' },
    ]

    const answers: unknown[] = []
    for (const caller of callers) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        answers.push(await invokeFunction(registry, 'runs.list', {}, caller))
      }
    }
    expect(answers).toEqual(Array.from({ length: 6 }, () => []))
    expect(listCalls).toBe(6)
  })

  it('refuses a DIRECT spec dispatch too, so no in-layer caller can slip past it', async () => {
    await expect(runsStartSpec.invoke({}, fakeDeps())).rejects.toBeInstanceOf(FunctionNotBoundError)
  })
})
