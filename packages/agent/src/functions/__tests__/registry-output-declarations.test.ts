// A declaration's output projection must come from the very schema `invokeFunction` enforces.

import {
  RunsEvidenceOutputContract,
  RunsListInputSchema,
  RunsListOutputContract,
  RunsListOutputSchema,
  createOutputContract,
} from '@vostride/agent-qa-schema'
import type { FunctionCaller } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { toSchemaProjection } from '../declaration-projection.js'
import { invokeFunction } from '../invoke.js'
import { runsListSpec } from '../ops/runs-list.js'
import { createFunctionRegistry, createRegistryFromSpecs } from '../registry.js'
import type { CreateFunctionRegistryOptions } from '../registry.js'
import type { FunctionDeps, FunctionSpec } from '../spec.js'

const TARGET = { target: 'draft-2020-12' } as const

function options(deps: unknown = {}): CreateFunctionRegistryOptions {
  return {
    deps: { secretMask: (text: string) => text, ...(deps as object) } as FunctionDeps,
  }
}

const reader: FunctionCaller = { surface: 'test', origin: 'agent' }

const handoff = (runId: string, endedAt: number) => ({
  runId,
  scope: { tier: 'suite', key: 'checkout' },
  buildOrdinal: 1,
  executionContext: 'local-headless',
  aggregateVerdict: 'passed',
  startedAt: endedAt - 10,
  endedAt,
  tests: [{ testIndex: 0, testId: 't_one', testName: 'Checkout works' }],
})

function listDeclaration(registry = createFunctionRegistry(options())) {
  return registry.list(reader).find((declaration) => declaration.id === 'runs.list')!
}

function isDeeplyFrozen(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return true
  return Object.isFrozen(value) && Object.values(value).every(isDeeplyFrozen)
}

const numbered = z.strictObject({ count: z.string().transform((value) => Number(value)) })
const numberedSpec: FunctionSpec<Record<string, never>, { count: number }> = {
  id: 'synthetic.numbered',
  summary: 'Synthetic op whose output transform changes the wire type.',
  resultKind: 'unary',
  input: z.strictObject({}),
  output: numbered,
  outputRepresentation: createOutputContract(numbered, {
    type: 'object',
    properties: { count: { type: 'number' } },
    required: ['count'],
    additionalProperties: false,
  }),
  risk: { name: 'fn:synthetic.numbered', recognized: true, readOnly: true },
  classify: () => ({ status: 'executed' as const, outcome: '' }),
  invoke: async () => ({ count: 3 }),
}

describe('OUTPUT-DECLARATION-IDENTITY', () => {
  it('attaches the canonical list companion to the list spec, tied to its enforcing schema', () => {
    expect(runsListSpec.outputRepresentation).toBe(RunsListOutputContract)
    expect(runsListSpec.outputRepresentation!.runtimeSchema).toBe(runsListSpec.output)
    expect(runsListSpec.output).toBe(RunsListOutputSchema)
  })

  it('publishes the companion\'s output document on the registry declaration', () => {
    const declaration = listDeclaration()
    expect(declaration.output).toEqual(RunsListOutputContract['~standard'].jsonSchema.output(TARGET))
    expect(declaration.input).toEqual(toSchemaProjection(RunsListInputSchema))
  })

  it('uses output semantics, not input mode, for a generic companion', () => {
    const registry = createRegistryFromSpecs([numberedSpec as FunctionSpec], options())
    const [declaration] = registry.list(reader)
    expect((declaration!.output.properties as Record<string, unknown>).count).toEqual({ type: 'number' })
    expect((toSchemaProjection(numbered).properties as Record<string, unknown>).count).toEqual({ type: 'string' })
  })

  it('hands out a deeply immutable output declaration, fresh per listing', () => {
    const first = listDeclaration()
    const second = listDeclaration()
    expect(isDeeplyFrozen(first.output)).toBe(true)
    expect(() => { (first.output as Record<string, unknown>).type = 'object' }).toThrow(TypeError)
    expect(second.output).toEqual(first.output)
    expect(RunsListOutputContract['~standard'].jsonSchema.output(TARGET).type).toBe('array')
  })

  it('leaves every op without a companion on its established projection', () => {
    const declared = createFunctionRegistry(options()).list(reader)
    for (const declaration of declared) {
      if (declaration.id === 'runs.list') continue
      expect(declaration.output.$schema, declaration.id).toBe('https://json-schema.org/draft/2020-12/schema')
    }
    expect(declared.length).toBeGreaterThan(40)
  })

  it('refuses a companion tied to another schema, naming the op', () => {
    const drifted: FunctionSpec = {
      ...(runsListSpec as FunctionSpec),
      output: z.array(z.unknown()),
    }
    expect(() => createRegistryFromSpecs([drifted], options())).toThrow(/runs\.list/)

    const borrowed: FunctionSpec = {
      ...(runsListSpec as FunctionSpec),
      outputRepresentation: RunsEvidenceOutputContract as never,
    }
    expect(() => createRegistryFromSpecs([borrowed], options())).toThrow(/runs\.list/)
  })

  it('still enforces the runtime output schema on invocation', async () => {
    const broken: FunctionSpec = {
      ...(runsListSpec as FunctionSpec),
      invoke: async () => [{ ...handoff('../escape', 5), testCount: 1, recordedTargets: { status: 'unknown' } }],
    }
    const registry = createRegistryFromSpecs([broken], options())
    await expect(invokeFunction(registry, 'runs.list', {}, reader)).rejects.toThrow()
  })

  it('still answers a real list invocation, newest first, empty when nothing ran', async () => {
    const registry = createFunctionRegistry(options({
      runs: { list: async () => [handoff('r_older', 100), handoff('r_newer', 200)] },
    }))
    const rows = await invokeFunction(registry, 'runs.list', {}, reader) as { runId: string }[]
    expect(rows.map((row) => row.runId)).toEqual(['r_newer', 'r_older'])

    const empty = createFunctionRegistry(options({ runs: { list: async () => [] } }))
    expect(await invokeFunction(empty, 'runs.list', {}, reader)).toEqual([])
    await expect(invokeFunction(empty, 'runs.list', null, reader)).rejects.toThrow()
  })
})
