// The view carries a deep-frozen JSON-Schema projection, so a write through a listing does nothing.

import type {
  FunctionCaller,
  RiskActionDescriptor,
} from '@vostride/agent-qa-schema'
import {
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
  RunsGetInputSchema,
} from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { FunctionInputError, invokeFunction } from '../functions/invoke.js'
import { configGetSpec } from '../functions/ops/config-get.js'
import {
  createFunctionRegistry,
  createRegistryFromSpecs,
  registryInternals,
} from '../functions/registry.js'
import type {
  FunctionDeclaration,
  FunctionDeps,
  FunctionMetadata,
  FunctionSpec,
} from '../functions/spec.js'
import { CONTRACTS_BY_ID, expectProjectionDerivedFrom } from './projection-relation.js'

// Every port resolves and none reaches a host API, because `FunctionDeps` is non-partial.
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

function buildRegistry() {
  return createFunctionRegistry({
    deps: fakeDeps(),
  })
}

// Both records smuggle retired fields by cast, so the cells show neither is read.
const ZERO_SCOPE_CALLER = {
  surface: 'test',
  grantedScopes: [],
  safeMode: false,
  origin: 'agent',
} as FunctionCaller

const FULLY_GRANTED = {
  surface: 'test',
  grantedScopes: ['read', 'run', 'config-write'],
  safeMode: false,
  origin: 'agent',
} as FunctionCaller

function byId(declarations: readonly FunctionDeclaration[], id: string): FunctionDeclaration {
  const declaration = declarations.find((candidate) => candidate.id === id)
  if (declaration === undefined) throw new Error(`${id} is not registered`)
  return declaration
}

function configGet(declarations: readonly FunctionDeclaration[]): FunctionDeclaration {
  return byId(declarations, 'config.get')
}

// Keys come from each value itself, so a new declaration field is covered; `seen` stops cycles.
function eachReachableNode(
  value: unknown,
  path: string,
  seen: WeakSet<object>,
  visit: (node: unknown, nodePath: string) => void,
): void {
  visit(value, path)
  if (typeof value !== 'object' || value === null) return

  const node = value as Record<string, unknown>
  if (seen.has(node)) return
  seen.add(node)

  for (const [key, nested] of Object.entries(node)) {
    eachReachableNode(nested, `${path}.${key}`, seen, visit)
  }
}

describe('the listed view is inert', () => {
  it('freezes the whole reachable graph of every declaration, naming no field', () => {
    const declarations = buildRegistry().list(FULLY_GRANTED)

    expect(declarations.length).toBeGreaterThan(0)
    for (const declaration of declarations) {
      eachReachableNode(declaration, declaration.id, new WeakSet(), (node, nodePath) => {
        if (typeof node !== 'object' || node === null) return
        expect(Object.isFrozen(node), nodePath).toBe(true)
      })
    }
  })

  it('exposes nothing runnable: no value reachable through a declaration is a function', () => {
    const declarations = buildRegistry().list(FULLY_GRANTED)

    expect(declarations.length).toBeGreaterThan(0)
    for (const declaration of declarations) {
      eachReachableNode(declaration, declaration.id, new WeakSet(), (node, nodePath) => {
        expect(typeof node, nodePath).not.toEqual('function')
      })
    }
  })

  it('de-aliases the shared contract vocabulary: a listing is not a schema-package export', () => {
    const declaration = byId(buildRegistry().list(FULLY_GRANTED), 'runs.get')

    // A listing's input projection is not the validator every firewalled surface imports.
    expect(declaration.input as unknown).not.toBe(RunsGetInputSchema as unknown)
    expect((declaration.input as Record<string, unknown>)['safeParse']).toBeUndefined()
    expect((declaration.output as Record<string, unknown>)['parse']).toBeUndefined()
  })

  it('projects each contract FROM the schema it was declared with, naming no field', () => {
    // A relation, not a shape: each projection's keys are read off the live zod contract.
    const declarations = buildRegistry().list(FULLY_GRANTED)

    expect(declarations.length).toBeGreaterThan(0)
    // The growth seam: a capability with no paired spec reddens here, so a seventh op
    // cannot land with an unchecked projection.
    expect(Object.keys(CONTRACTS_BY_ID).sort())
      .toEqual(declarations.map((declaration) => declaration.id).sort())

    for (const declaration of declarations) {
      const contracts = CONTRACTS_BY_ID[declaration.id]!
      for (const side of ['input', 'output'] as const) {
        const label = `${declaration.id}.${side}`
        // The inertness clauses the case has always carried, kept beside the relation.
        expect(Object.getPrototypeOf(declaration[side]), label).toBe(Object.prototype)
        expectProjectionDerivedFrom(contracts[side], declaration[side], label)
      }
    }
  })

  it('kills the input-poisoning repro: dispatch still validates, in two registries', async () => {
    const attacked = buildRegistry()
    const declaration = byId(attacked.list(FULLY_GRANTED), 'runs.get')

    // The verifier's exploit verbatim. The projection is deep-frozen and carries no
    // validator to replace, so in strict-mode ESM the write THROWS.
    expect(() => {
      ;(declaration.input as Record<string, unknown>)['safeParse'] = () => ({
        success: true,
        data: {},
      })
    }).toThrow(TypeError)

    // Both halves. The throw alone would not prove enforcement survived the attempt.
    await expect(
      invokeFunction(attacked, 'runs.get', { runId: 42 }, FULLY_GRANTED),
    ).rejects.toBeInstanceOf(FunctionInputError)

    // A registry built AFTER the attempt, over the same module-level singleton specs.
    await expect(
      invokeFunction(buildRegistry(), 'runs.get', { runId: 42 }, FULLY_GRANTED),
    ).rejects.toBeInstanceOf(FunctionInputError)

    // And the shared vocabulary itself: the schema package's export still refuses.
    expect(RunsGetInputSchema.safeParse({ runId: 42 }).success).toBe(false)
  })

  it('kills the output-poisoning repro: a unary result is still the validated value', async () => {
    const attacked = buildRegistry()
    const declaration = byId(attacked.list(FULLY_GRANTED), 'runs.list')

    expect(() => {
      ;(declaration.output as Record<string, unknown>)['parse'] = () => 'ATTACKER-CHOSEN'
    }).toThrow(TypeError)

    await expect(invokeFunction(attacked, 'runs.list', {}, FULLY_GRANTED)).resolves.toEqual([])
    await expect(
      invokeFunction(buildRegistry(), 'runs.list', {}, FULLY_GRANTED),
    ).resolves.toEqual([])
  })
})

// The disclose relation, pinned as an absence on both spec and declaration.
describe('the disclose presence flag is projected from the spec', () => {
  function specsOf(registry: ReturnType<typeof buildRegistry>): ReadonlyMap<string, FunctionSpec> {
    const internals = registryInternals(registry)
    if (internals === undefined) throw new Error('the registry exposes no internals')
    return internals.specs
  }

  it('lists discloses: true for exactly the ops whose spec defines disclose', () => {
    const registry = buildRegistry()
    const specs = specsOf(registry)
    const declarations = registry.list(FULLY_GRANTED)

    expect(declarations.length, 'the registry listed nothing — the census is vacuous').toBeGreaterThan(0)
    const definesDisclose = declarations
      .filter((declaration) => typeof (specs.get(declaration.id) as Record<string, unknown> | undefined)?.['disclose'] === 'function')
      .map((declaration) => declaration.id)
    const flagged = declarations
      .filter((declaration) => Object.hasOwn(declaration, 'discloses'))
      .map((declaration) => declaration.id)
    expect(definesDisclose, 'a registered spec defines the retired disclose method').toEqual([])
    expect(flagged, 'a declaration lists the retired discloses flag').toEqual([])
  })

  // A spec smuggling a `disclose` method by cast still yields no `discloses` key.
  it('omits the key entirely for an op with no disclose — absent, never false or undefined', () => {
    const legacy = {
      id: 'synthetic.legacy-disclose',
      summary: 'A spec that still carries the retired per-op disclosure.',
      resultKind: 'unary',
      input: z.object({}).strict(),
      output: z.object({ ok: z.literal(true) }).strict(),
      risk: { name: 'fn:synthetic.legacy-disclose', recognized: true, readOnly: true },
      disclose: () => 'this invocation costs nothing',
      classify: () => ({ status: 'executed' as const, outcome: '' }),
      invoke: () => Promise.resolve({ ok: true as const }),
    } as unknown as FunctionSpec
    const registry = createRegistryFromSpecs([legacy], { deps: fakeDeps() })
    const [declaration] = registry.list(FULLY_GRANTED)
    expect(declaration, 'the legacy spec was not listed').toBeDefined()
    expect(Object.hasOwn(declaration!, 'discloses'), 'the retired flag rode through').toBe(false)
    expect(Object.keys(declaration!).sort()).toEqual([...REQUIRED_DECLARATION_KEYS, 'classifies'].sort())
  })
})

describe('declaration views are deeply frozen', () => {
  it('freezes every listed declaration and its risk descriptor', () => {
    const declarations = buildRegistry().list(FULLY_GRANTED)

    expect(declarations.length).toBeGreaterThan(0)
    for (const declaration of declarations) {
      expect(Object.isFrozen(declaration), declaration.id).toBe(true)
      expect(Object.isFrozen(declaration.risk), `${declaration.id}.risk`).toBe(true)
    }
  })

  it('a write to the listed view throws and there is no requirement to vacate', async () => {
    const registry = buildRegistry()
    const declaration = configGet(registry.list(ZERO_SCOPE_CALLER))

    expect(Object.keys(declaration)).not.toContain('requiredScopes')
    expect(() => {
      ;(declaration as unknown as Record<string, unknown>)['requiredScopes'] = []
    }).toThrow(TypeError)

    await expect(
      invokeFunction(registry, 'config.get', {}, ZERO_SCOPE_CALLER),
    ).resolves.toMatchObject({ configPath: 'agent-qa.config.yaml' })
  })

  it('refuses a forged risk name: the gate classification cannot be rewritten through a listing', () => {
    const declaration = configGet(buildRegistry().list(ZERO_SCOPE_CALLER))

    expect(() => {
      ;(declaration.risk as RiskActionDescriptor).name = 'fn:totally.harmless'
    }).toThrow(TypeError)
    expect(declaration.risk.name).toBe('fn:config.get')
  })

  it('freezes the REGISTERED singleton spec, not only the copied view', () => {
    buildRegistry()

    expect(Object.isFrozen(configGetSpec)).toBe(true)
    expect(Object.isFrozen(configGetSpec.risk)).toBe(true)
    expect(() => {
      ;(configGetSpec as unknown as Record<string, unknown>)['risk'] = { name: 'fn:forged' }
    }).toThrow(TypeError)
  })

  it('contains the attempt to nothing: a second registry lists the same permission-free view', async () => {
    const attacked = buildRegistry()
    const declaration = configGet(attacked.list(ZERO_SCOPE_CALLER))

    expect(() => {
      ;(declaration as unknown as Record<string, unknown>)['requiresHumanOrigin'] = true
    }).toThrow(TypeError)

    const fresh = buildRegistry()
    expect(configGet(fresh.list(ZERO_SCOPE_CALLER))).toEqual(declaration)
    await expect(
      invokeFunction(fresh, 'config.get', {}, ZERO_SCOPE_CALLER),
    ).resolves.toMatchObject({ configPath: 'agent-qa.config.yaml' })
  })
})

// Declaration key sets, pinned at compile time and at runtime.

/** Compile-time half: the declaration TYPE cannot carry either retired key. Checked by typecheck. */
type DeclarationCarries<Key extends string> = Key extends keyof FunctionDeclaration ? true : false
const DECLARATION_TYPE_HAS_SCOPES: DeclarationCarries<'requiredScopes'> = false
const DECLARATION_TYPE_HAS_HUMAN_ORIGIN: DeclarationCarries<'requiresHumanOrigin'> = false

// `ExactKeys` is mutual assignability over `keyof`, so a key added or dropped fails typecheck.
type ExactKeys<T, K extends PropertyKey> = [keyof T] extends [K]
  ? ([K] extends [keyof T] ? true : false)
  : false
const METADATA_KEYS = ['id', 'summary', 'resultKind', 'risk'] as const
const SPEC_KEYS = [
  ...METADATA_KEYS,
  'boundThrough', 'input', 'output', 'outputRepresentation', 'classify', 'renderResult', 'invoke',
] as const
const DECLARATION_TYPE_KEYS = [
  ...METADATA_KEYS,
  'bindingStatus', 'classifies', 'rendersResult', 'input', 'output',
] as const
const METADATA_TYPE_IS_EXACT: ExactKeys<FunctionMetadata, (typeof METADATA_KEYS)[number]> = true
const SPEC_TYPE_IS_EXACT: ExactKeys<FunctionSpec, (typeof SPEC_KEYS)[number]> = true
const DECLARATION_TYPE_IS_EXACT: ExactKeys<
  FunctionDeclaration,
  (typeof DECLARATION_TYPE_KEYS)[number]
> = true

/** Every key a runtime declaration always carries, and the presence-only flags it may carry. */
const REQUIRED_DECLARATION_KEYS = [
  'bindingStatus',
  'id',
  'input',
  'output',
  'resultKind',
  'risk',
  'summary',
] as const
const OPTIONAL_DECLARATION_FLAGS = ['classifies', 'rendersResult'] as const

describe('runtime declarations carry no permission metadata', () => {
  it('pins the exact key set of every real declaration, and no scope or origin key', () => {
    expect(DECLARATION_TYPE_HAS_SCOPES).toBe(false)
    expect(DECLARATION_TYPE_HAS_HUMAN_ORIGIN).toBe(false)
    expect([METADATA_TYPE_IS_EXACT, SPEC_TYPE_IS_EXACT, DECLARATION_TYPE_IS_EXACT])
      .toEqual([true, true, true])
    for (const keys of [METADATA_KEYS, SPEC_KEYS, DECLARATION_TYPE_KEYS] as const) {
      expect(keys as readonly string[]).not.toContain('requiredScopes')
      expect(keys as readonly string[]).not.toContain('requiresHumanOrigin')
    }
    // The runtime set is the type's set: every key a real declaration carries is a declared key.
    expect([...REQUIRED_DECLARATION_KEYS, ...OPTIONAL_DECLARATION_FLAGS].sort())
      .toEqual([...DECLARATION_TYPE_KEYS].sort())

    const declarations = buildRegistry().list(ZERO_SCOPE_CALLER)
    expect(declarations.length).toBeGreaterThan(40)
    for (const declaration of declarations) {
      const keys = Object.keys(declaration).sort()
      const optional = keys.filter((key) => !(REQUIRED_DECLARATION_KEYS as readonly string[]).includes(key))
      expect(keys, declaration.id).toEqual(expect.arrayContaining([...REQUIRED_DECLARATION_KEYS]))
      expect(optional.every((key) => (OPTIONAL_DECLARATION_FLAGS as readonly string[]).includes(key)),
        `${declaration.id} carries ${optional.join(', ')}`).toBe(true)
      expect(keys, declaration.id).not.toContain('requiredScopes')
      expect(keys, declaration.id).not.toContain('requiresHumanOrigin')
    }
  })

  it('omits the retired keys even where the registered spec still spells them', () => {
    // The synthetic spec smuggles both keys by cast; the registry builds the view field by field.
    expect(Object.keys(configGet(buildRegistry().list(FULLY_GRANTED)))).not.toContain('requiredScopes')

    const legacy = {
      id: 'synthetic.legacy-permissions',
      summary: 'A spec that still spells both retired permission keys.',
      requiredScopes: ['config-write'],
      requiresHumanOrigin: true,
      resultKind: 'unary',
      input: z.object({}).strict(),
      output: z.object({ ok: z.literal(true) }).strict(),
      risk: { name: 'fn:synthetic.legacy-permissions', recognized: true, readOnly: true },
      classify: () => ({ status: 'executed' as const, outcome: '' }),
      invoke: () => Promise.resolve({ ok: true as const }),
    } as FunctionSpec<Record<string, never>, { ok: true }>
    const registry = createRegistryFromSpecs([legacy as FunctionSpec], {
      deps: fakeDeps(),
    })
    const [declaration] = registry.list(ZERO_SCOPE_CALLER)
    expect(Object.keys(declaration!).sort())
      .toEqual([...REQUIRED_DECLARATION_KEYS, 'classifies'].sort())
  })

  it('freezes every risk descriptor as a copy, never the spec\'s own object', () => {
    for (const declaration of buildRegistry().list(ZERO_SCOPE_CALLER)) {
      expect(Object.isFrozen(declaration.risk), declaration.id).toBe(true)
    }
    expect(configGet(buildRegistry().list(ZERO_SCOPE_CALLER)).risk).not.toBe(configGetSpec.risk)
    expect(configGet(buildRegistry().list(ZERO_SCOPE_CALLER)).risk).toEqual(configGetSpec.risk)
  })
})
