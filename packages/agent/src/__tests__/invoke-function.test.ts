// Retired caller and metadata fields are smuggled by cast where a cell proves them unread.

import {
  CURRENT_HANDOFF_SCHEMA_VERSION,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type {
  CompletedRunHandoff,
  FunctionCaller,
  RunSummary,
} from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  FunctionInputError,
  FunctionNotBoundError,
  UnknownFunctionError,
  invokeFunction,
} from '../functions/invoke.js'
import { runsListSpec } from '../functions/ops/runs-list.js'
import {
  DuplicateFunctionIdError,
  createRegistryFromSpecs,
} from '../functions/registry.js'
import type { CreateFunctionRegistryOptions } from '../functions/registry.js'
import type { FunctionDeps, FunctionSpec } from '../functions/spec.js'

function handoff(runId: string, buildOrdinal: number): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: runId as CompletedRunHandoff['runId'],
    scope: { tier: 'product', key: 'shop' },
    buildOrdinal,
    executionContext: 'local-headless',
    aggregateVerdict: 'passed',
    configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
    startedAt: 1_000,
    endedAt: 2_000,
    tests: [],
  }
}

interface SpyDeps {
  deps: FunctionDeps
  listCalls: () => number
}

function spyDeps(documents: readonly CompletedRunHandoff[] = []): SpyDeps {
  let listCalls = 0
  return {
    deps: {
      secretMask: (text: string) => text,
      runs: {
        list: () => {
          listCalls += 1
          return Promise.resolve(documents)
        },
        get: (runId) => Promise.resolve(
          documents.find((document) => document.runId === runId),
        ),
        // `FunctionDeps` is non-partial, so an unbound port is a compile error, not a silent gap.
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
    },
    listCalls: () => listCalls,
  }
}

// A caller smuggling a retired scope set and safe-mode flag past the type; neither is read.
function caller(grantedScopes: readonly string[], safeMode = false): FunctionCaller {
  return { surface: 'test', grantedScopes, safeMode, origin: 'agent' } as FunctionCaller
}

/**
 * A second synthetic capability so ordering and safe-mode filtering are observable.
 *
 * Deliberately a NON-REGISTERED id: `config.get` is a real read-only capability now, so
 * reusing that id here would have this file assert a false thing about a shipped op.
 */
const configSetSpec = {
  id: 'config.set',
  summary: 'Synthetic non-read capability used to exercise the listing filter.',
  requiredScopes: ['config-write'],
  resultKind: 'unary',
  input: z.object({}).strict(),
  output: z.object({ ok: z.literal(true) }).strict(),
  risk: { name: 'fn:config.set', recognized: true },
  // `classify` is required; a single-arm shape needs no discrimination.
  classify: () => ({ status: 'executed' as const, outcome: '' }),
  invoke: () => Promise.resolve({ ok: true as const }),
} as FunctionSpec<Record<string, never>, { ok: true }>

// A synthetic multi-scope capability under an unregistered id, asserting nothing about real ops.
const authoringDraftWriteSpec = {
  id: 'authoring.draft.write.synthetic',
  summary: 'Synthetic test-write capability used to exercise the scope refusal by name.',
  requiredScopes: ['test-write', 'run', 'read'],
  resultKind: 'unary',
  input: z.object({}).strict(),
  output: z.object({ ok: z.literal(true) }).strict(),
  risk: { name: 'fn:authoring.draft.write.synthetic', recognized: true },
  // `classify` is required; a single-arm shape needs no discrimination.
  classify: () => ({ status: 'executed' as const, outcome: '' }),
  invoke: () => Promise.resolve({ ok: true as const }),
} as FunctionSpec<Record<string, never>, { ok: true }>

function registryOptions(
  overrides: Partial<CreateFunctionRegistryOptions> = {},
): CreateFunctionRegistryOptions {
  return {
    deps: spyDeps().deps,
    ...overrides,
  }
}

describe('invokeFunction pipeline', () => {
  it('rejects an unknown id before any dependency is touched', async () => {
    const deps = spyDeps()
    const registry = createRegistryFromSpecs([runsListSpec], registryOptions({ deps: deps.deps }))

    await expect(
      invokeFunction(registry, 'runs.nope', {}, caller(['read'])),
    ).rejects.toBeInstanceOf(UnknownFunctionError)
    expect(deps.listCalls()).toBe(0)
  })

  it('rejects input that violates the declared contract before dispatch', async () => {
    const deps = spyDeps()
    const registry = createRegistryFromSpecs([runsListSpec], registryOptions({ deps: deps.deps }))

    await expect(
      invokeFunction(registry, 'runs.list', { unexpected: true }, caller(['read'])),
    ).rejects.toBeInstanceOf(FunctionInputError)
    expect(deps.listCalls()).toBe(0)
  })

  it('serves a caller whose grants do not cover the declared scopes, dispatching once', async () => {
    const deps = spyDeps()
    const registry = createRegistryFromSpecs([runsListSpec], registryOptions({ deps: deps.deps }))

    await expect(invokeFunction(registry, 'runs.list', {}, caller([]))).resolves.toEqual([])
    expect(deps.listCalls()).toBe(1)
  })

  it('serves a run+read caller at a test-write op — the declared scopes are not read', async () => {
    const deps = spyDeps()
    const registry = createRegistryFromSpecs(
      [authoringDraftWriteSpec as FunctionSpec],
      registryOptions({ deps: deps.deps }),
    )

    await expect(invokeFunction(
      registry,
      'authoring.draft.write.synthetic',
      {},
      caller(['run', 'read']),
    )).resolves.toEqual({ ok: true })
  })

  it('lets a caller holding test-write through the same op', async () => {
    // The other half of the differential. Without it the case above would also pass for a gate
    // that refused every caller, which measures nothing about `test-write` in particular.
    const registry = createRegistryFromSpecs(
      [authoringDraftWriteSpec as FunctionSpec],
      registryOptions(),
    )

    await expect(
      invokeFunction(
        registry,
        'authoring.draft.write.synthetic',
        {},
        caller(['test-write', 'run', 'read']),
      ),
    ).resolves.toEqual({ ok: true })
  })

  it('a read dispatches exactly once and writes no execution-audit row', async () => {
    const deps = spyDeps([handoff('run-beta', 12), handoff('run-alpha', 11)])
    const registry = createRegistryFromSpecs([runsListSpec], registryOptions({ deps: deps.deps }))

    const result = (await invokeFunction(registry, 'runs.list', {}, caller(['read']))) as RunSummary[]

    expect(result.map((summary) => summary.runId)).toEqual(['run-beta', 'run-alpha'])
    expect(deps.listCalls()).toBe(1)
  })

  it('yields an empty list when the injected reader has no runs', async () => {
    const deps = spyDeps([])
    const registry = createRegistryFromSpecs([runsListSpec], registryOptions({ deps: deps.deps }))

    await expect(invokeFunction(registry, 'runs.list', {}, caller(['read']))).resolves.toEqual([])
  })
})

function markLikeSpec(invocations: { count: number }): FunctionSpec<{ runId: string }, { ok: true }> {
  // A retired scope declaration smuggled past the type; nothing reads it.
  return {
    id: 'runs.mark.synthetic',
    summary: 'Synthetic mutating capability used to prove the op gate is gone.',
    requiredScopes: ['run'],
    resultKind: 'unary',
    input: z.object({ runId: z.string().min(1) }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
    risk: { name: 'fn:runs.mark.synthetic', recognized: true, readOnly: false },
    classify: () => ({ status: 'executed' as const, outcome: '' }),
    invoke: () => {
      invocations.count += 1
      return Promise.resolve({ ok: true as const })
    },
  } as FunctionSpec<{ runId: string }, { ok: true }>
}

describe('invokeFunction dispatches with no gate', () => {
  it.each(['ci', 'local-headless', 'local-interactive'] as const)(
    'a mutating op in %s returns once with no confirm port and no audit row',
    async (context) => {
      const invocations = { count: 0 }
      const registry = createRegistryFromSpecs([markLikeSpec(invocations) as FunctionSpec], {
        ...registryOptions(),
        // A deleted context option smuggled past the type; nothing reads a context.
        resolveExecutionContext: () => context,
      } as CreateFunctionRegistryOptions)

      await expect(
        invokeFunction(registry, 'runs.mark.synthetic', { runId: 'run-1' }, caller(['run'])),
      ).resolves.toEqual({ ok: true })

      expect(invocations.count).toBe(1)
    },
  )

  it('invalid input and a missing binding still refuse by name, dispatching nothing', async () => {
    const invocations = { count: 0 }
    const registry = createRegistryFromSpecs(
      [
        markLikeSpec(invocations) as FunctionSpec,
        { ...markLikeSpec(invocations), id: 'runs.mark.unbound', boundThrough: 'liveView' } as FunctionSpec,
      ],
      { ...registryOptions(), resolveExecutionContext: () => 'ci' } as CreateFunctionRegistryOptions,
    )

    await expect(
      invokeFunction(registry, 'runs.mark.synthetic', { runId: '' }, caller(['run'])),
    ).rejects.toBeInstanceOf(FunctionInputError)
    await expect(
      invokeFunction(registry, 'runs.mark.unbound', { runId: 'run-1' }, caller(['run'])),
    ).rejects.toBeInstanceOf(FunctionNotBoundError)
    await expect(
      invokeFunction(registry, 'runs.mark.unbound', { runId: 'run-1' }, caller(['run'])),
    ).rejects.toThrow(/runs\.mark\.unbound/)
    expect(invocations.count).toBe(0)
  })
})

describe('retry and refusal order with no permission check', () => {
  it('a retry after an input refusal dispatches exactly once, for a grantless caller', async () => {
    const deps = spyDeps()
    const registry = createRegistryFromSpecs([runsListSpec], registryOptions({ deps: deps.deps }))
    const grantless: FunctionCaller = { surface: 'test', origin: 'agent' }

    await expect(invokeFunction(registry, 'runs.list', { unexpected: true }, grantless))
      .rejects.toBeInstanceOf(FunctionInputError)
    expect(deps.listCalls()).toBe(0)
    await expect(invokeFunction(registry, 'runs.list', {}, grantless)).resolves.toEqual([])
    await expect(invokeFunction(registry, 'runs.list', {}, grantless)).resolves.toEqual([])
    expect(deps.listCalls()).toBe(2)
  })

  it('refuses an unknown id before input, and input before binding, for every caller shape', async () => {
    const registry = createRegistryFromSpecs([runsListSpec], registryOptions())
    for (const who of [caller([]), caller(['read'], true), { surface: 'test', origin: 'human' } as FunctionCaller]) {
      await expect(invokeFunction(registry, 'runs.nope', null, who)).rejects.toBeInstanceOf(UnknownFunctionError)
      await expect(invokeFunction(registry, 'runs.list', null, who)).rejects.toBeInstanceOf(FunctionInputError)
    }
  })
})

describe('createRegistryFromSpecs', () => {
  it('rejects two declarations sharing an id', () => {
    expect(() => createRegistryFromSpecs([runsListSpec, runsListSpec], registryOptions()))
      .toThrow(DuplicateFunctionIdError)
  })

  it('lists declarations sorted by id and never exposes an implementation', () => {
    const registry = createRegistryFromSpecs([runsListSpec, configSetSpec], registryOptions())

    const declarations = registry.list(caller(['read', 'config-write']))

    expect(declarations.map((declaration) => declaration.id)).toEqual(['config.set', 'runs.list'])
    for (const declaration of declarations) {
      expect(declaration).not.toHaveProperty('invoke')
    }
  })

  it('constructs normally for every compliant composition', () => {
    expect(() => createRegistryFromSpecs([runsListSpec], registryOptions())).not.toThrow()
  })

  it('lists every capability to a safe-mode caller and serves it like any other', async () => {
    const deps = spyDeps()
    const registry = createRegistryFromSpecs(
      [runsListSpec, configSetSpec],
      registryOptions({ deps: deps.deps }),
    )

    const safeModeCaller = caller(['read'], true)
    expect(registry.list(safeModeCaller).map((declaration) => declaration.id))
      .toEqual(['config.set', 'runs.list'])
    expect(registry.list(safeModeCaller)).toEqual(registry.list(caller([])))

    await expect(invokeFunction(registry, 'config.set', {}, safeModeCaller))
      .resolves.toEqual({ ok: true })
  })
})
