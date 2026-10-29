// The advertised contract IS the enforced contract (Phase 396 plan 04, D-16 · MCPS-02).
//
// WHY THIS FILE READS OFF A SERVER AND NOT OFF THE MAPPING. `projection-layers.test.ts` drives the
// derivation directly; that is the right shape for the derivation's edge cases and the wrong shape
// for this claim, because a derivation that is never registered proves nothing about what a caller
// receives. Every cell below builds a real `McpServer` through the shipped factory, drives a real
// `@modelcontextprotocol/client` over the SDK's own in-process handler, and asserts against the
// `tools/list` document that came back off the wire.
//
// WHAT MAKES THE DRIFT CELL A DETECTOR RATHER THAN A TAUTOLOGY. Comparing the advertised schema
// against a conversion of the SAME object would be comparing a thing to itself: D-16 makes them one
// object on purpose, so that comparison cannot fail and cannot detect. The independent side is the
// FUNCTION LAYER'S OWN inert projection — `declaration.input` / `declaration.output`, produced by
// `packages/agent`'s `toSchemaProjection` from the spec it dispatches with, by a different code path
// in a different package. Two derivations, two packages, one document. What that catches is the
// failure that can actually happen here: the mapping table naming the WRONG contract for an op, at
// which point the tool advertises one capability's shape and validates with another's.
//
// MUTATION LEGS — the acceptance bar, measured by the phase's mutation driver (since removed).
// Applied to `packages/mcp/src/mapping.ts`, suite re-run, subject restored from a sha-256-proven
// byte snapshot. Observed 2026-08-16:
//
//   P1  `runs.digest`'s contract entry re-pointed at the proposals-list contracts   -> RED (1 cell)
//       (2026-09-30, 432-12: the proposals-list contract left the table; the leg's analog is any
//       other read contract, and the 432-45 mutation owner re-points it.)
//   P2  the pipeline's advertised input swapped for its SECOND arm's contract       -> RED (1 cell)
//   P3  `agent_qa_start_run` removed from `DEGRADED_OUTPUT_CONTRACTS`               -> RED (8 cells)
//   P4  the config fold's advertised input swapped for the knowledge fold's         -> RED (2 cells)
//
// P2 WAS MEASURED GREEN FIRST, and the cell that now catches it was written because of that. See
// the identity cell below for what a document comparison cannot see.
//
// P3 IS THE OTHER ONE TO READ. Removing one entry from a declared degradation list does not break a
// schema — it makes `buildAgentQaMcpServer` refuse, which is the point: left to the SDK the same
// contract throws inside `tools/list` and takes the entire listing down for every caller, with
// nothing in the exception naming the tool that caused it.

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
// 2026-08-16 (Phase 397 D-06): the three normalisations this file authored now live beside the
// package's other source, because 397's conformance suite compares the same two sides from
// `packages/cli` and may not reach into another package's tests. They are consumed here rather
// than kept here so exactly ONE lens exists — the copy that drifts looser is the copy that passes
// over real drift, and nothing would have compared two copies to each other. Their docstrings
// travelled with them; read those before widening any of the three.
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
  // 432-21 (D-12): no credential rides the caller; the scope set is retired and unread (432-20).
  return { surface: 'mcp', grantedScopes, safeMode: false, origin: 'agent' } as FunctionCaller
}

// 2026-10-02 (432-39, D-10/D-12): the scope union is deleted, so the retired names are spelled by
// hand here and handed to the caller as a smuggle, cast past the deleted field; nothing reads them.
const EVERY_SCOPE: readonly string[] = [
  'read', 'run', 'config-write', 'knowledge-write', 'approval-write', 'test-write',
]

const openClients: Client[] = []

afterEach(async () => {
  for (const client of openClients.splice(0)) await client.close().catch(() => {})
})

/**
 * Build a server for one caller and read its `tools/list` off the wire.
 *
 * The SDK's own in-process `handler.fetch` driver, exactly as the phase tracer uses it: the only
 * thing replaced is the socket. A cell asserting against a hand-assembled listing would be
 * measuring this file's idea of the protocol rather than the protocol.
 */
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

  // RE-SPELLED 2026-10-01 (432-20, D-12) from 'advertises only the read tools to a caller granted
  // only read'. The D-05 visibility law is deleted, so a read-only caller receives every declared
  // tool, in the declared order — the same listing a caller granted everything receives.
  it('advertises every declared tool to a caller granted only read, as to every caller', async () => {
    const advertised = await advertise(['read'])
    expect(advertised.map((tool) => tool.name)).toEqual(
      AGENT_QA_TOOL_PROJECTIONS.map((projection) => projection.name),
    )
    expect(JSON.stringify(advertised)).toBe(JSON.stringify(await advertise()))
  })
})

describe('the advertised schema equals the function layer\'s own projection (D-16)', () => {
  // ALL FOURTEEN, ranged over the mapping rather than sampled. A subset here would be a cell that
  // holds for the tools somebody happened to think about.
  it('matches the registry projection for every tool, on both sides', async () => {
    const advertised = new Map((await advertise()).map((tool) => [tool.name, tool]))
    const declared = declarations()
    let checked = 0

    for (const projection of AGENT_QA_TOOL_PROJECTIONS) {
      const tool = advertised.get(projection.name)
      expect(tool, projection.name).toBeDefined()

      // 432-12 (D-05/D-14): the D-11 apply doors are gone, so every tool's input is its op's own
      // contract. 2026-10-01 (432-21, D-12): the mark door's `op outcome OR credential refusal`
      // output (419 D-20) left with the bearer credential, so its output is its op's own too.
      const composition = compositionOf(projection)
      const inputComparable = true

      if (inputComparable && composition !== 'union') {
        const armDeclaration = declared.get(projection.ops[0]!)!
        expect(withoutDialect(tool!.inputSchema), `${projection.name} input`).toEqual(
          withoutDialect(armDeclaration.input),
        )
        checked += 1
      }

      // 2026-10-20 (446-11, D-25): a fold lists one object, so each arm is checked twice — the
      // listing covers it, and the composed union the call is validated with carries it whole.
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

    // Integrity: the loop above would pass vacuously over an empty advertisement, and a cell that
    // can pass by checking nothing is the cell most likely to. The arithmetic, so a future reader
    // can tell a real change from a broken loop:
    //   inputs  — 11 single/pipeline/mark tools + 12 fold arms (2 + 7 + 3) = 23
    //   outputs — 16 tools less the 2 declared degradations               = 14
    // 2026-09-15 (423-21 D-18): the two feedback read tools add one input and one output each.
    // 2026-09-28 (431-03): `agent_qa_list_runs` leaves the degradation list and its output is
    // compared too, through the 2025-11-25 codec's `{ result }` wrap around its array root.
    // 2026-09-28 (431-04 D-04/D-07): seven single reads add one input and one output each (14), and
    // the evidence fold adds two arm inputs and one output (3).
    // 2026-09-30 (432-12 D-05): the two proposal reads leave (-2 inputs, -2 outputs), the two apply
    // doors leave (-2 outputs; their authored inputs were never compared), and the config fold loses
    // its undo arm (-1 input): 16 single/pipeline/mark inputs + 13 fold arms + 19 outputs = 48.
    expect(checked).toBe(48)
  })

  // IDENTITY, NOT AGREEMENT — and this cell exists because the one above it was measured BLIND to
  // the case it covers. Leg P2 re-points the pipeline's advertised input at its SECOND arm's
  // contract; `entities.resolve` and `entities.get` both take `{ ref: string }`, so the two
  // documents are byte-identical and the drift cell stayed GREEN under a tool advertising one
  // object while `invokeFunction` validated with another. Two contracts that agree TODAY are
  // exactly the pair D-16 refuses to rely on: the day `entities.get` gains a field, the tool
  // advertises it and the op it actually calls refuses it.
  //
  // Union folds are excluded and the exclusion is structural rather than a gap: a composed union is
  // a NEW object by construction, so identity cannot hold for one. What stands in for it there is
  // the pair of produced checks that bracket it — `tool-input-schema-shape.test.ts` reads the arm
  // literals back out of the listed fold schema, and the drift cell above compares each advertised
  // arm against that arm op's own projection.
  it('advertises the op\'s OWN contract object, not one that merely agrees with it', () => {
    let checked = 0
    for (const projection of AGENT_QA_TOOL_PROJECTIONS) {
      if (compositionOf(projection) === 'union') continue
      const advertised = advertisedContracts(projection)
      expect(advertised, projection.name).toBeDefined()
      const own = AGENT_QA_OP_CONTRACTS[projection.ops[0]!]!

      // 2026-10-01 (432-21, D-12): the mark door no longer advertises a composed `anyOf` with a
      // credential-refusal arm, so it is held to identity like every other single tool.
      expect(advertised!.input, `${projection.name} input identity`).toBe(own.input)
      expect(advertised!.output, `${projection.name} output identity`).toBe(own.output)
      checked += 2
    }
    // 10 non-union, non-apply tools contributing both sides (423-21 D-18 adds the two feedback reads).
    // 2026-09-28 (431-04 D-04): the seven single discovery reads make it 17.
    // 2026-09-30 (432-12 D-05): the two proposal reads leave, so 15.
    // 2026-10-01 (432-21 D-12): the mark door joins, its composed refusal arm gone, so 16.
    expect(checked).toBe(32)
  })

  // Pitfall 3, and the field-level half of D-16's "descriptions live on the zod schemas" clause.
  // Prose attached to a contract in `@vostride/agent-qa-schema` has to survive the extend, the
  // discriminated union, the SDK's converter and the wire; each of those is a place it could be
  // dropped without any shape changing.
  it('carries a field description from the zod contract all the way to the wire', async () => {
    const advertised = new Map((await advertise()).map((tool) => [tool.name, tool]))
    // 2026-10-20 (446-11, D-25): the fold lists one object, so the prose rides its `action` field.
    const fold = withoutDialect(advertised.get('agent_qa_change_config')!.inputSchema)
    const discriminant = (fold.properties as JsonDocument).action as JsonDocument

    expect((discriminant.enum as readonly string[])[0]).toBe('config.field.set')
    expect(discriminant.description).toContain('Which registry operation this call is for')

    // 2026-09-30 (432-12 D-05): the apply doors' authored envelope is gone with them, so the second
    // conversion route has no tool on it. The knowledge change fold carries the same prose.
    const knowledge = withoutDialect(advertised.get('agent_qa_change_knowledge')!.inputSchema)
    const knowledgeDiscriminant = (knowledge.properties as JsonDocument).action as JsonDocument
    expect((knowledgeDiscriminant.enum as readonly string[])[0]).toBe('knowledge.accept')
    expect(knowledgeDiscriminant.description).toContain('Which registry operation this call is for')
  })
})

describe('degradation is explicit, never a silently narrowed document (D-16)', () => {
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

  // THE RECORD IS RE-MEASURED, NOT TRUSTED. `DEGRADED_OUTPUT_CONTRACTS.measured` claims to hold the
  // converter's own words as observed on 2026-08-16. This runs the same conversion the SDK runs
  // inside `tools/list` and compares what it actually throws — so a converter that starts refusing
  // for a DIFFERENT reason, or stops refusing, reds here instead of leaving a stale sentence in the
  // description a caller reads.
  //
  // It is also the only place the throw itself is observed. Left to the SDK it happens inside a
  // protocol response, uncaught, taking the whole listing down with nothing naming the cause.
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
    // 432-12: the knowledge changes write in the call, so the same derivation marks them.
    expect(advertised.get('agent_qa_change_knowledge')!.annotations?.readOnlyHint).toBe(false)
    expect(advertised.get('agent_qa_change_knowledge')!.annotations?.idempotentHint).toBe(false)
  })
})

// ---- THE APP CARRIER CENSUS (2026-08-31, Phase 408 plan 01 · D-05 / MCPA-01) --------------------
//
// WHY THESE CELLS JOINED THIS FILE AND NOT A NEW ONE. Which tools carry the App is exactly the same
// KIND of claim as everything above: a property derived from `AGENT_QA_TOOL_PROJECTIONS` and
// delivered on the advertised document, where the failure that can actually happen is the mapping
// and the derivation disagreeing. So the pair is asserted the way this file asserts every other
// pair — the derivation driven directly for the shape it produces, and the real `tools/list` read
// off the wire for the shape a caller receives.
//
// THE 399.1 LESSON, RESTATED (D-05). The carrier set is ENUMERATED from the projection table, never
// spelled as a pair beside it. A cell that hard-coded two names would agree with a mapping that had
// silently grown a third carrier — and a third tool quietly advertising a live-view App is a third
// door onto a credential channel, which is the one thing this phase may not let happen quietly.
// What IS spelled out here is the expectation the census is compared against, which is the pin.

describe('the App carrier declaration is registry data (408 D-05)', () => {
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

  // Plan 03's per-call reference reads this datum to find the concrete runId, so a swapped pair
  // would decorate a result with a reference to a run nobody asked about.
  it('names where each carrier\'s concrete runId lives', () => {
    const uiOf = (name: string) =>
      AGENT_QA_TOOL_PROJECTIONS.find((projection) => projection.name === name)!.ui
    expect(uiOf('agent_qa_start_run')).toEqual({ resource: 'live-run', runIdFrom: 'output' })
    expect(uiOf('agent_qa_get_run_digest')).toEqual({ resource: 'live-run', runIdFrom: 'input' })
  })
})
