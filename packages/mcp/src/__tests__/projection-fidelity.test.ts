// Compares the wire `tools/list` against the function layer's own projection from another package.

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createMcpHandler } from '@modelcontextprotocol/server'
import {
  createFunctionRegistry,
  type FunctionDeclaration,
  type FunctionDeps,
  type FunctionRegistry,
} from '@vostride/agent-qa-agent'
import type { FunctionCaller } from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it } from 'vitest'

import { buildAgentQaMcpServer } from '../catalog.js'
// The normalisations live in `conformance-support.ts` so the cli conformance suite shares one lens.
import {
  armWithoutDiscriminant,
  foldArmFindings,
  type JsonDocument,
  withoutDialect,
  withoutLegacyResultWrap,
} from '../conformance-support.js'
import { APP_RESOURCE_URI_TEMPLATE } from '../app-resource.js'
import {
  advertisedContracts,
  AGENT_QA_OP_CONTRACTS,
  AGENT_QA_TOOL_PROJECTIONS,
  compositionOf,
  DEGRADED_OUTPUT_CONTRACTS,
} from '../mapping.js'
import type { ToolProjection } from '../mapping.js'
import { toRegisterToolConfig } from '../projection.js'
import type { ProjectedOpSpec, RegisterToolConfig } from '../projection.js'

interface AdvertisedTool {
  readonly name: string
  readonly description?: string
  readonly inputSchema?: unknown
  readonly outputSchema?: unknown
  readonly annotations?: Record<string, unknown>
}

/** Empty deps: a listing reads deps only for each op's binding status, not for which ops exist. */
function builtInRegistry(): FunctionRegistry {
  return createFunctionRegistry({ deps: {} as unknown as FunctionDeps })
}

function callerWith(grantedScopes: readonly string[]): FunctionCaller {
  return { surface: 'mcp', grantedScopes, safeMode: false, origin: 'agent' } as FunctionCaller
}

// The retired scope names are spelled by hand and cast past the type; nothing reads them.
const EVERY_SCOPE: readonly string[] = [
  'read', 'run', 'config-write', 'knowledge-write', 'approval-write', 'test-write',
]

const openClients: Client[] = []

afterEach(async () => {
  for (const client of openClients.splice(0)) await client.close().catch(() => {})
})

// Builds a server for one caller and reads its `tools/list` through the in-process driver.
async function advertise(
  grantedScopes: readonly string[] = EVERY_SCOPE,
): Promise<readonly AdvertisedTool[]> {
  const handler = createMcpHandler(() =>
    buildAgentQaMcpServer({
      registry: builtInRegistry(),
      caller: callerWith(grantedScopes),
      // Identity: this file's subject is the advertised contract, and the masking claim has its own
      // cells elsewhere. Named rather than defaulted, because a masker that can be omitted is a
      // masker that will be.
      maskText: (text: string) => text,
    }),
  )
  const client = new Client({ name: 'agent-qa-396-04-fidelity', version: '0.0.0' })
  openClients.push(client)
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://fidelity.local/mcp'), {
      fetch: ((url: URL | string, init?: RequestInit) =>
        handler.fetch(new Request(url, init))) as typeof fetch,
    }),
  )
  const listed = await client.listTools()
  return listed.tools as unknown as readonly AdvertisedTool[]
}

function declarations(): ReadonlyMap<string, FunctionDeclaration> {
  return new Map(
    builtInRegistry()
      .list(callerWith(EVERY_SCOPE))
      .map((declaration) => [declaration.id, declaration]),
  )
}

describe('the advertised catalogue is what the mapping declares', () => {
  it('advertises every declared tool, in the declared order, on a real build', async () => {
    const advertised = await advertise()
    expect(advertised.map((tool) => tool.name)).toEqual(
      AGENT_QA_TOOL_PROJECTIONS.map((projection) => projection.name),
    )
  })

  it('advertises every declared tool to a caller granted only read, as to every caller', async () => {
    const advertised = await advertise(['read'])
    expect(advertised.map((tool) => tool.name)).toEqual(
      AGENT_QA_TOOL_PROJECTIONS.map((projection) => projection.name),
    )
    expect(JSON.stringify(advertised)).toBe(JSON.stringify(await advertise()))
  })
})

describe('the advertised schema equals the function layer\'s own projection', () => {
  // ALL FOURTEEN, ranged over the mapping rather than sampled. A subset here would be a cell that
  // holds for the tools somebody happened to think about.
  it('matches the registry projection for every tool, on both sides', async () => {
    const advertised = new Map((await advertise()).map((tool) => [tool.name, tool]))
    const declared = declarations()
    let checked = 0

    for (const projection of AGENT_QA_TOOL_PROJECTIONS) {
      const tool = advertised.get(projection.name)
      expect(tool, projection.name).toBeDefined()

      // Every tool's input and output is its op's own contract.
      const composition = compositionOf(projection)
      const inputComparable = true

      if (inputComparable && composition !== 'union') {
        const armDeclaration = declared.get(projection.ops[0]!)!
        expect(withoutDialect(tool!.inputSchema), `${projection.name} input`).toEqual(
          withoutDialect(armDeclaration.input),
        )
        checked += 1
      }

      // A fold lists one object, so each arm is checked in the listing and in the composed union.
      if (inputComparable && composition === 'union') {
        const listed = withoutDialect(tool!.inputSchema)
        const composed = advertisedContracts(projection)!.input['~standard'].jsonSchema.input({
          target: 'draft-2020-12',
        })
        const arms = (withoutDialect(composed).oneOf ?? []) as readonly JsonDocument[]
        expect(arms.length, `${projection.name} arms`).toBe(projection.ops.length)
        projection.ops.forEach((opId, at) => {
          const own = withoutDialect(declared.get(opId)!.input)
          expect(
            foldArmFindings(listed, projection.discriminant!, opId, own),
            `${projection.name} listing for ${opId}`,
          ).toEqual([])
          expect(
            armWithoutDiscriminant(arms[at]!, projection.discriminant!),
            `${projection.name} arm ${opId}`,
          ).toEqual(own)
          checked += 1
        })
      }

      if (tool!.outputSchema !== undefined) {
        // A union fold whose arms answer one shape advertises that shape; the one fold whose arms
        // differ advertises an `anyOf`. Either way every member is an arm's own projection.
        //
        // The PIPELINE is compared against its FIRST op alone, which is the claim rather than an
        // exemption: `entities.get` runs inside the resolved arm and contributes no shape of its
        // own, so a document carrying anything of its own here would mean the tool had invented a
        // result envelope — the one thing a pure projection may not do.
        const advertisedOutput = withoutDialect(withoutLegacyResultWrap(tool!.outputSchema))
        const outputOps = composition === 'union' ? projection.ops : [projection.ops[0]!]
        const armOutputs = outputOps.map((opId) => withoutDialect(declared.get(opId)!.output))
        const distinct = armOutputs.filter(
          (document, at) =>
            armOutputs.findIndex((other) => JSON.stringify(other) === JSON.stringify(document)) === at,
        )
        if (distinct.length === 1) {
          expect(advertisedOutput, `${projection.name} output`).toEqual(distinct[0])
          checked += 1
        } else {
          expect(advertisedOutput.anyOf, `${projection.name} output union`).toEqual(distinct)
          checked += 1
        }
      }
    }

    // One input per non-fold tool and per fold arm, plus one output per tool not degraded.
    expect(checked).toBe(48)
  })

  // Two contracts can agree today and drift tomorrow, so the pipeline is held to object identity.
  it('advertises the op\'s OWN contract object, not one that merely agrees with it', () => {
    let checked = 0
    for (const projection of AGENT_QA_TOOL_PROJECTIONS) {
      if (compositionOf(projection) === 'union') continue
      const advertised = advertisedContracts(projection)
      expect(advertised, projection.name).toBeDefined()
      const own = AGENT_QA_OP_CONTRACTS[projection.ops[0]!]!

      // The mark door is held to identity like every other single tool.
      expect(advertised!.input, `${projection.name} input identity`).toBe(own.input)
      expect(advertised!.output, `${projection.name} output identity`).toBe(own.output)
      checked += 2
    }
    // One input and one output per non-union tool.
    expect(checked).toBe(32)
  })

  // A field description must survive the extend, the union, the SDK converter and the wire.
  it('carries a field description from the zod contract all the way to the wire', async () => {
    const advertised = new Map((await advertise()).map((tool) => [tool.name, tool]))
    // The fold lists one object, so the prose rides its `action` field.
    const fold = withoutDialect(advertised.get('agent_qa_change_config')!.inputSchema)
    const discriminant = (fold.properties as JsonDocument).action as JsonDocument

    expect((discriminant.enum as readonly string[])[0]).toBe('config.field.set')
    expect(discriminant.description).toContain('Which registry operation this call is for')

    // The knowledge change fold carries the same prose.
    const knowledge = withoutDialect(advertised.get('agent_qa_change_knowledge')!.inputSchema)
    const knowledgeDiscriminant = (knowledge.properties as JsonDocument).action as JsonDocument
    expect((knowledgeDiscriminant.enum as readonly string[])[0]).toBe('knowledge.accept')
    expect(knowledgeDiscriminant.description).toContain('Which registry operation this call is for')
  })
})

describe('degradation is explicit, never a silently narrowed document', () => {
  it('advertises no outputSchema for exactly the declared degradations, and says so', async () => {
    const advertised = await advertise()
    const withoutOutput = advertised
      .filter((tool) => tool.outputSchema === undefined)
      .map((tool) => tool.name)

    expect(withoutOutput.sort()).toEqual(DEGRADED_OUTPUT_CONTRACTS.map((e) => e.tool).sort())

    for (const entry of DEGRADED_OUTPUT_CONTRACTS) {
      const tool = advertised.find((candidate) => candidate.name === entry.tool)!
      expect(tool.description, entry.tool).toContain('advertises no outputSchema')
      expect(tool.description, entry.tool).toContain(entry.schema)
    }
  })

  it('advertises a real outputSchema for every other tool', async () => {
    const advertised = await advertise()
    const degraded = new Set(DEGRADED_OUTPUT_CONTRACTS.map((entry) => entry.tool))
    const advertising = advertised.filter((tool) => !degraded.has(tool.name))
    expect(advertising.length).toBe(AGENT_QA_TOOL_PROJECTIONS.length - degraded.size)
    for (const tool of advertising) {
      expect(tool.outputSchema, tool.name).toBeDefined()
    }
  })

  // Runs the conversion `tools/list` runs, so a changed or vanished refusal fails here, by name.
  it('re-measures the converter refusal each entry records', () => {
    expect(DEGRADED_OUTPUT_CONTRACTS.length).toBeGreaterThan(0)
    for (const entry of DEGRADED_OUTPUT_CONTRACTS) {
      const contracts = AGENT_QA_OP_CONTRACTS[entry.opId]
      expect(contracts, entry.opId).toBeDefined()
      let thrown: string | undefined
      try {
        contracts!.output['~standard'].jsonSchema.output({ target: 'draft-2020-12' })
      } catch (err) {
        thrown = err instanceof Error ? err.message : String(err)
      }
      expect(thrown, `${entry.opId} converts cleanly — the degradation entry is stale`).toBe(
        entry.measured,
      )
    }
  })
})

describe('the build is deterministic (idempotency)', () => {
  it('advertises deep-equal documents across two independent builds', async () => {
    const first = await advertise()
    const second = await advertise()
    expect(second).toEqual(first)
  })

  it('advertises the same order across two independent builds', async () => {
    const first = (await advertise()).map((tool) => tool.name)
    const second = (await advertise()).map((tool) => tool.name)
    expect(second).toEqual(first)
    // The order is the MAPPING's declaration order — grouped by workflow, not alphabetised — and it
    // is asserted as such rather than sorted, because a sort here would be a second ordering
    // nothing derives from.
    expect(first).toEqual(AGENT_QA_TOOL_PROJECTIONS.map((projection) => projection.name))
  })

  it('derives annotations from the ops rather than from the tool name', async () => {
    const advertised = new Map((await advertise()).map((tool) => [tool.name, tool]))
    expect(advertised.get('agent_qa_get_run_marks')!.annotations?.readOnlyHint).toBe(true)
    expect(advertised.get('agent_qa_get_run_marks')!.annotations?.idempotentHint).toBe(true)
    // A fold containing six writes is not read-only, and its idempotence follows.
    expect(advertised.get('agent_qa_change_config')!.annotations?.readOnlyHint).toBe(false)
    expect(advertised.get('agent_qa_change_config')!.annotations?.idempotentHint).toBe(false)
    // The knowledge changes write in the call, so the same derivation marks them.
    expect(advertised.get('agent_qa_change_knowledge')!.annotations?.readOnlyHint).toBe(false)
    expect(advertised.get('agent_qa_change_knowledge')!.annotations?.idempotentHint).toBe(false)
  })
})

// ---- The App carrier census: enumerated from the projection table, compared with the wire ----

describe('the App carrier declaration is registry data', () => {
  /** The `ProjectedOpSpec` `catalog.ts` builds for one op, assembled the same way it does. */
  function specsFor(projection: ToolProjection): readonly ProjectedOpSpec[] {
    const declared = declarations()
    return projection.ops.map((opId) => {
      const declaration = declared.get(opId)!
      const contracts = AGENT_QA_OP_CONTRACTS[opId]!
      return {
        id: declaration.id,
        summary: declaration.summary,
        risk: declaration.risk,
        input: contracts.input,
        output: contracts.output,
      }
    })
  }

  function configFor(name: string): RegisterToolConfig {
    const projection = AGENT_QA_TOOL_PROJECTIONS.find((entry) => entry.name === name)!
    return toRegisterToolConfig(
      projection,
      specsFor(projection),
      advertisedContracts(projection)!,
      (text: string) => text,
    )
  }

  // THE BAR: a derivation that attached `_meta` unconditionally, or one that spelled the resource
  // URI as a second literal, reds here.
  it('derives _meta.ui.resourceUri for a carrier and NO _meta at all for a non-carrier', () => {
    expect(configFor('agent_qa_start_run')._meta).toEqual({
      ui: { resourceUri: APP_RESOURCE_URI_TEMPLATE },
    })
    expect(configFor('agent_qa_get_run_digest')._meta).toEqual({
      ui: { resourceUri: APP_RESOURCE_URI_TEMPLATE },
    })
    // ABSENT, never present-and-undefined: the house rule, and the difference a host sees is
    // between a tool with no App and a tool advertising an App reference of `undefined`.
    const plain = configFor('agent_qa_get_run_marks')
    expect('_meta' in plain).toBe(false)
  })

  it('carries the App reference through to the advertised document, on a real build', async () => {
    const advertised = new Map(
      (await advertise()).map((tool) => [tool.name, tool as { _meta?: { ui?: unknown } }]),
    )
    for (const projection of AGENT_QA_TOOL_PROJECTIONS) {
      const listed = advertised.get(projection.name)!
      const expectedUi =
        projection.ui === undefined ? undefined : { resourceUri: APP_RESOURCE_URI_TEMPLATE }
      expect(listed._meta?.ui, projection.name).toEqual(expectedUi)
    }
  })

  // THE CENSUS. Derived from the table on one side, pinned on the other — a third carrier reds.
  it('declares exactly two carriers, enumerated FROM the projection table', () => {
    const carriers = AGENT_QA_TOOL_PROJECTIONS.filter(
      (projection) => projection.ui !== undefined,
    ).map((projection) => projection.name)
    expect([...carriers].sort()).toEqual(['agent_qa_get_run_digest', 'agent_qa_start_run'])
  })

  // The per-call reference reads this datum, so a swapped pair points at a run nobody asked about.
  it('names where each carrier\'s concrete runId lives', () => {
    const uiOf = (name: string) =>
      AGENT_QA_TOOL_PROJECTIONS.find((projection) => projection.name === name)!.ui
    expect(uiOf('agent_qa_start_run')).toEqual({ resource: 'live-run', runIdFrom: 'output' })
    expect(uiOf('agent_qa_get_run_digest')).toEqual({ resource: 'live-run', runIdFrom: 'input' })
  })
})
