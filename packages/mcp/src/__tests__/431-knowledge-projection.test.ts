// The eight 431 read tools (D-01 / D-04 / D-05 / D-07 / D-09 · PXH-AGENT-04/06/07).
//
// CANONICAL_CONTRACTS is the one table this suite restates: each new tool name, the ops it
// projects, and the exact schema objects those ops enforce with. Everything else is read off the
// registry, the mapping or a real server, so a cell here compares the table against a producer.
//
// MUTATION SUBJECTS (observed 2026-09-28 against this file, each subject restored byte for byte
// and its sha-256 re-checked; 431-13 owns the re-runnable harness):
//   O1 the evidence fold's ops swapped to [runs.artifact, runs.evidence]           -> fold arms
//   S1 agent_qa_list_knowledge_bundles renamed agent_qa_search_knowledge_bundles   -> REGISTRY-NO-SEARCH
//   V1 the visibleToCaller filter removed from catalog.ts                          -> READ-SCOPE-ONLY, HIDDEN-NAME-INVOCATION
//      (2026-10-01, 432-20, D-12: V1 is now the shipped behaviour; both blocks are re-spelled to
//      pin that every caller lists and reaches all eight tools.)
//   H1 the evidence tool's maxResultSizeChars removed                              -> the result-hint cell
//   K1 runs.knowledge's advertised input swapped for BriefWhyInputSchema           -> RUN-KNOWLEDGE-WHOLE

import { readFileSync } from 'node:fs'

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createMcpHandler } from '@modelcontextprotocol/server'
import {
  createFunctionRegistry,
  invokeFunction,
  type FunctionDeclaration,
  type FunctionDeps,
  type FunctionRegistry,
} from '@vostride/agent-qa-agent'
import * as schema from '@vostride/agent-qa-schema'
import type {
  CompletedRunHandoff,
  FunctionCaller,
  KnowledgeBundleSummary,
} from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it } from 'vitest'

import { buildAgentQaMcpServer } from '../catalog.js'
import { withoutDialect, withoutLegacyResultWrap } from '../conformance-support.js'
import {
  advertisedContracts,
  AGENT_QA_COMPOSED_CONTRACTS,
  AGENT_QA_OP_CONTRACTS,
  AGENT_QA_TOOL_PROJECTIONS,
  MAX_RESULT_SIZE_META_KEY,
  PROJECTED_RULING_ADDENDA,
  UNPROJECTED_OPS,
} from '../mapping.js'
import type { ToolProjection } from '../mapping.js'
import { toRegisterToolConfig } from '../projection.js'

const TARGET = { target: 'draft-2020-12' } as const

interface CanonicalContract {
  readonly ops: readonly string[]
  readonly input: unknown
  readonly output: unknown
}

const CANONICAL_CONTRACTS: Readonly<Record<string, CanonicalContract>> = {
  agent_qa_list_knowledge_bundles: {
    ops: ['knowledge.bundles.list'],
    input: schema.KnowledgeBundlesListInputSchema,
    output: schema.KnowledgeBundlesListOutputSchema,
  },
  agent_qa_inspect_knowledge_records: {
    ops: ['knowledge.records.inspect'],
    input: schema.KnowledgeRecordsInspectInputSchema,
    output: schema.KnowledgeRecordsInspectOutputSchema,
  },
  agent_qa_diff_knowledge_records: {
    ops: ['knowledge.records.diff'],
    input: schema.KnowledgeRecordsDiffInputSchema,
    output: schema.KnowledgeRecordsDiffOutputSchema,
  },
  agent_qa_show_knowledge_record: {
    ops: ['knowledge.record.show'],
    input: schema.KnowledgeRecordShowInputSchema,
    output: schema.KnowledgeRecordShowResultSchema,
  },
  agent_qa_explain_brief: {
    ops: ['knowledge.brief.why'],
    input: schema.BriefWhyInputSchema,
    output: schema.BriefWhyResultSchema,
  },
  agent_qa_get_run_knowledge: {
    ops: ['runs.knowledge'],
    input: schema.RunsKnowledgeInputSchema,
    output: schema.RunKnowledgeProjectionSchema,
  },
  agent_qa_get_run_overview: {
    ops: ['runs.overview'],
    input: schema.RunsOverviewInputSchema,
    output: schema.RunOverviewProjectionSchema,
  },
  agent_qa_get_run_evidence: {
    ops: ['runs.evidence', 'runs.artifact'],
    input: schema.RunsEvidenceFoldInputSchema,
    output: schema.RunsEvidenceFoldOutputContract,
  },
}

function registryWith(deps: Record<string, unknown> = {}): FunctionRegistry {
  return createFunctionRegistry({
    deps: { secretMask: (text: string) => text, ...deps } as unknown as FunctionDeps,
  })
}

// 2026-10-01 (432-34, D-12): the retired `grantedScopes` and `safeMode` caller fields are dropped;
// nothing reads them (432-20).
const READ_CALLER: FunctionCaller = {
  surface: 'mcp',
  origin: 'agent',
}

function declarationsById(): ReadonlyMap<string, FunctionDeclaration> {
  return new Map(registryWith().list(READ_CALLER).map((declaration) => [declaration.id, declaration]))
}

type StandardLike = {
  readonly '~standard': {
    readonly validate: (value: unknown) => unknown
    readonly jsonSchema: { readonly input: (options: typeof TARGET) => unknown }
  }
}

function inputDocument(contract: unknown): unknown {
  return withoutDialect((contract as StandardLike)['~standard'].jsonSchema.input(TARGET))
}

function bundle(bundleId: string, product = 'shop'): KnowledgeBundleSummary {
  return {
    bundleId,
    product,
    dir: `memory/${product}/${bundleId}`,
    kind: 'fact',
    subtype: 'selector',
    scope: { tier: 'product', key: product },
    status: 'active',
    trust: 0.75,
    counters: { confirmed: 2, contradicted: 0, helpful: 1, harmful: 0 },
    openedAtOrdinal: 3,
    lastConfirmedOrdinal: 5,
    summary: `summary of ${bundleId}`,
    evidenceIncomplete: false,
  }
}

const BUNDLE_OP_SOURCE = new URL(
  '../../../agent/src/functions/ops/knowledge-bundles-list.ts',
  import.meta.url,
)

describe('BUNDLES-OUTPUT-IDENTITY', () => {
  it('publishes KnowledgeBundlesListOutputSchema as an array of the bundle summary schema itself', () => {
    const named = schema.KnowledgeBundlesListOutputSchema as unknown as { element?: unknown } | undefined
    expect(named, 'KnowledgeBundlesListOutputSchema is not exported').toBeDefined()
    expect(named!.element).toBe(schema.KnowledgeBundleSummarySchema)
  })

  it('declares the bundle op output through the named schema, not an inline array', () => {
    const source = readFileSync(BUNDLE_OP_SOURCE, 'utf8')
    expect(source.match(/output: KnowledgeBundlesListOutputSchema,/g) ?? []).toHaveLength(1)
    expect(source).not.toMatch(/z\.array\(/)
    expect(source).not.toMatch(/from 'zod'/)
  })

  it('validates zero, one and many bundles through the named schema and a real invocation', async () => {
    for (const rows of [[], [bundle('b_one')], [bundle('b_two'), bundle('b_one'), bundle('b_one', 'admin')]]) {
      const parsed = schema.KnowledgeBundlesListOutputSchema.safeParse(rows)
      expect(parsed.success, `${rows.length} rows`).toBe(true)
      const registry = registryWith({ knowledge: { listBundles: () => Promise.resolve(rows) } })
      const answered = await invokeFunction(registry, 'knowledge.bundles.list', {}, READ_CALLER)
      expect(schema.KnowledgeBundlesListOutputSchema.safeParse(answered).success).toBe(true)
      expect(answered).toHaveLength(rows.length)
    }
    expect(schema.KnowledgeBundlesListOutputSchema.safeParse([{ bundleId: 'b_bad' }]).success).toBe(false)
  })

  it('matches the registry declaration of knowledge.bundles.list', () => {
    const declaration = declarationsById().get('knowledge.bundles.list')!
    expect(withoutDialect(declaration.output)).toEqual(inputDocument(schema.KnowledgeBundlesListOutputSchema))
  })
})

describe('the canonical contract table (D-04)', () => {
  it('resolves every canonical export from the built schema barrel', () => {
    for (const [tool, contract] of Object.entries(CANONICAL_CONTRACTS)) {
      expect(contract.input, `${tool} input`).toBeDefined()
      expect(contract.output, `${tool} output`).toBeDefined()
    }
    expect(schema.RunsEvidenceFoldOutputContract.runtimeSchema).toBeDefined()
    expect(schema.RunsEvidenceOutputContract.runtimeSchema).toBe(schema.RunsEvidenceResultSchema)
    expect(schema.RunsArtifactOutputContract.runtimeSchema).toBe(schema.RunsArtifactResultSchema)
  })

  it('names eight tools over nine registered read ops', () => {
    const declared = declarationsById()
    const ops = Object.values(CANONICAL_CONTRACTS).flatMap((contract) => [...contract.ops])
    expect(Object.keys(CANONICAL_CONTRACTS)).toHaveLength(8)
    expect(new Set(ops).size).toBe(9)
    for (const opId of ops) {
      const declaration = declared.get(opId)
      expect(declaration, `${opId} is not registered`).toBeDefined()
      // 432-20 (D-10/D-12): no scope or origin key on a declaration; the read claim is the risk's.
      expect(Object.keys(declaration!), opId).not.toContain('requiredScopes')
      expect(declaration!.risk.readOnly, opId).toBe(true)
      expect(Object.keys(declaration!), opId).not.toContain('requiresHumanOrigin')
    }
  })

  it('pairs every single-op tool with the input its op declares', () => {
    const declared = declarationsById()
    for (const [tool, contract] of Object.entries(CANONICAL_CONTRACTS)) {
      if (contract.ops.length !== 1) continue
      const declaration = declared.get(contract.ops[0]!)!
      expect(inputDocument(contract.input), `${tool} input`).toEqual(withoutDialect(declaration.input))
    }
  })
})

// ---- Task 2: the eight tools on the projection path ---------------------------------------------

const RUN_READ_RESULT_SIZE_HINT = 100000
const SIZE_HINTED = new Set(['agent_qa_get_run_knowledge', 'agent_qa_get_run_overview', 'agent_qa_get_run_evidence'])

/** Per-op contracts behind the evidence fold: each arm keeps its own op's canonical pair. */
const FOLD_ARM_CONTRACTS: Readonly<Record<string, { readonly input: unknown; readonly output: unknown }>> = {
  'runs.evidence': { input: schema.RunsEvidenceInputSchema, output: schema.RunsEvidenceOutputContract },
  'runs.artifact': { input: schema.RunsArtifactInputSchema, output: schema.RunsArtifactOutputContract },
}

function projectionNamed(name: string): ToolProjection | undefined {
  return AGENT_QA_TOOL_PROJECTIONS.find((projection) => projection.name === name)
}

const openClients: Client[] = []
afterEach(async () => {
  for (const client of openClients.splice(0)) await client.close().catch(() => {})
})

// 2026-10-01 (432-34, D-12): the retired `safeMode` field is dropped. The scope set stays, smuggled
// past the type on purpose: the READ-SCOPE-ONLY and HIDDEN-NAME-INVOCATION cells below hand this
// helper a read, a no-read and an empty set to prove nothing reads it, and that witness has to
// survive 432-39 deleting the field. 2026-10-02 (432-39): it does — the field is deleted and the set
// is typed as plain strings.
function callerWith(grantedScopes: readonly string[]): FunctionCaller {
  return { surface: 'mcp', origin: 'agent', grantedScopes } as FunctionCaller
}

async function connect(registry: FunctionRegistry, caller: FunctionCaller): Promise<Client> {
  const handler = createMcpHandler(() => buildAgentQaMcpServer({ registry, caller, maskText: (text: string) => text }))
  const client = new Client({ name: 'agent-qa-431-04', version: '0.0.0' })
  openClients.push(client)
  await client.connect(new StreamableHTTPClientTransport(new URL('http://knowledge.local/mcp'), {
    fetch: ((url: URL | string, init?: RequestInit) => handler.fetch(new Request(url, init))) as typeof fetch,
  }))
  return client
}

interface ListedTool {
  readonly name: string
  readonly description?: string
  readonly outputSchema?: unknown
  readonly annotations?: Record<string, unknown>
  readonly _meta?: Record<string, unknown>
}

async function listed(registry: FunctionRegistry, caller: FunctionCaller): Promise<ReadonlyMap<string, ListedTool>> {
  const tools = (await (await connect(registry, caller)).listTools()).tools as unknown as ListedTool[]
  return new Map(tools.map((tool) => [tool.name, tool]))
}

function outputDocument(contract: unknown): unknown {
  const standard = (contract as { '~standard': { jsonSchema: { output: (o: typeof TARGET) => unknown } } })['~standard']
  return withoutDialect(standard.jsonSchema.output(TARGET))
}

describe('MCP-TOOLS-EXACT (D-04 / D-05 / D-07)', () => {
  it('declares each new tool as a plain read over exactly its canonical ops', () => {
    for (const [tool, contract] of Object.entries(CANONICAL_CONTRACTS)) {
      const projection = projectionNamed(tool)
      expect(projection, tool).toBeDefined()
      expect(projection, tool).toEqual({
        name: tool,
        ops: contract.ops,
        kind: 'read',
        ...(contract.ops.length > 1 ? { discriminant: schema.TOOL_FOLD_DISCRIMINANT } : {}),
        ...(SIZE_HINTED.has(tool) ? { maxResultSizeChars: RUN_READ_RESULT_SIZE_HINT } : {}),
      })
    }
  })

  it('advertises the enforcing contract objects themselves', () => {
    for (const [tool, contract] of Object.entries(CANONICAL_CONTRACTS)) {
      const advertised = advertisedContracts(projectionNamed(tool)!)
      expect(advertised?.input, `${tool} input`).toBe(contract.input)
      expect(advertised?.output, `${tool} output`).toBe(contract.output)
      if (contract.ops.length === 1) {
        expect(AGENT_QA_COMPOSED_CONTRACTS[tool], `${tool} inherits its op contract`).toBeUndefined()
        expect(AGENT_QA_OP_CONTRACTS[contract.ops[0]!]).toEqual({ input: contract.input, output: contract.output })
      }
    }
    for (const [opId, arm] of Object.entries(FOLD_ARM_CONTRACTS)) {
      expect(AGENT_QA_OP_CONTRACTS[opId]?.input, `${opId} input`).toBe(arm.input)
      expect(AGENT_QA_OP_CONTRACTS[opId]?.output, `${opId} output`).toBe(arm.output)
    }
    const union = schema.RunsEvidenceFoldOutputContract.runtimeSchema as unknown as { options: readonly unknown[] }
    expect(union.options).toEqual([schema.RunsEvidenceResultSchema, schema.RunsArtifactResultSchema])
    expect(union.options[0]).toBe(schema.RunsEvidenceResultSchema)
    expect(union.options[1]).toBe(schema.RunsArtifactResultSchema)
  })

  it('leaves run knowledge the whole op projection: no step filter on the way in', () => {
    const projection = projectionNamed('agent_qa_get_run_knowledge')!
    expect(advertisedContracts(projection)?.input).toBe(schema.RunsKnowledgeInputSchema)
    const document = inputDocument(schema.RunsKnowledgeInputSchema) as { properties?: Record<string, unknown> }
    expect(Object.keys(document.properties ?? {})).toEqual(['runId'])
  })
})

describe('MCP-TOOLS-ADVERTISED on a real tools/list', () => {
  it('lists all eight to a read caller with output schemas, read annotations and op-summary descriptions', async () => {
    const tools = await listed(registryWith(), callerWith(['read']))
    const declared = declarationsById()
    for (const [name, contract] of Object.entries(CANONICAL_CONTRACTS)) {
      const tool = tools.get(name)
      expect(tool, name).toBeDefined()
      expect(tool!.outputSchema, `${name} outputSchema`).toBeDefined()
      // The 2025-11-25 codec wraps an array root (the bundle list) in `{ result }`; the published
      // lens undoes exactly that wrap and nothing else.
      expect(withoutDialect(withoutLegacyResultWrap(tool!.outputSchema)), `${name} output document`)
        .toEqual(outputDocument(contract.output))
      expect(tool!.annotations, name).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true })
      const summaries = contract.ops.map((opId) => declared.get(opId)!.summary)
      if (contract.ops.length === 1) {
        expect(tool!.description, name).toBe(summaries[0])
      } else {
        contract.ops.forEach((opId, at) => expect(tool!.description).toContain(`${opId}: ${summaries[at]!}`))
      }
    }
  })

  it('carries the 100000-character result hint on run knowledge, overview and evidence only', async () => {
    const tools = await listed(registryWith(), callerWith(['read']))
    for (const [name, tool] of tools) {
      if (SIZE_HINTED.has(name)) {
        expect(tool._meta?.[MAX_RESULT_SIZE_META_KEY], name).toBe(RUN_READ_RESULT_SIZE_HINT)
      } else {
        expect(tool._meta?.[MAX_RESULT_SIZE_META_KEY], name).toBeUndefined()
      }
    }
    expect(MAX_RESULT_SIZE_META_KEY).toBe('anthropic/maxResultSizeChars')
  })

  it('merges the result hint with carrier metadata instead of replacing it', () => {
    const carrier = projectionNamed('agent_qa_get_run_digest')!
    const hinted = { ...carrier, maxResultSizeChars: RUN_READ_RESULT_SIZE_HINT } as ToolProjection
    const declaration = declarationsById().get('runs.digest')!
    const contracts = AGENT_QA_OP_CONTRACTS['runs.digest']!
    const config = toRegisterToolConfig(hinted, [{
      id: 'runs.digest',
      summary: declaration.summary,
      risk: declaration.risk,
      input: contracts.input,
      output: contracts.output,
    }], contracts, (text) => text)
    expect(config._meta?.[MAX_RESULT_SIZE_META_KEY]).toBe(RUN_READ_RESULT_SIZE_HINT)
    expect((config._meta?.ui as { resourceUri?: unknown } | undefined)?.resourceUri).toBeDefined()
  })
})

// ---- dispatch: the op each call reached ---------------------------------------------------------
//
// 432-13 (C432-INVOKE-DIRECT): the witness was the op gate's audit row, which no call writes any
// more. 2026-10-14 (441-16, D-12): the registry's read-scope seam that replaced it is deleted, so the
// witness is the first port each bound op reads — distinct per op, so it still names the op REACHED,
// past every refusal.
const FIRST_PORT: Record<string, readonly ['runs' | 'knowledge', string]> = {
  'knowledge.bundles.list': ['knowledge', 'listBundles'],
  'knowledge.records.inspect': ['knowledge', 'inspectRecords'],
  'knowledge.records.diff': ['knowledge', 'diffSince'],
  'knowledge.record.show': ['knowledge', 'showRecord'],
  'knowledge.brief.why': ['runs', 'readStepEvidence'],
  'runs.knowledge': ['runs', 'get'],
}

function auditedRegistry(audited: string[], deps: Record<string, unknown> = {}): FunctionRegistry {
  const ports: Record<string, Record<string, unknown>> = {
    runs: { ...(deps.runs as Record<string, unknown> | undefined) },
    knowledge: { ...(deps.knowledge as Record<string, unknown> | undefined) },
  }
  for (const [opId, [port, method]] of Object.entries(FIRST_PORT)) {
    const real = ports[port]![method]
    ports[port]![method] = async (...args: unknown[]) => {
      audited.push(`fn:${opId}`)
      if (typeof real !== 'function') throw new Error(`${port}.${method} is not bound in this witness`)
      return await (real as (...values: unknown[]) => unknown)(...args)
    }
  }
  return createFunctionRegistry({
    deps: { ...deps, ...ports } as unknown as FunctionDeps,
  })
}

const SHA = 'c'.repeat(64)

const DISPATCH_CALLS: readonly (readonly [string, Record<string, unknown>, string])[] = [
  ['agent_qa_list_knowledge_bundles', {}, 'knowledge.bundles.list'],
  ['agent_qa_inspect_knowledge_records', { filter: {} }, 'knowledge.records.inspect'],
  ['agent_qa_diff_knowledge_records', { sinceOrdinal: 0 }, 'knowledge.records.diff'],
  ['agent_qa_show_knowledge_record', { recordId: 'rec-1' }, 'knowledge.record.show'],
  ['agent_qa_explain_brief', { runId: 'r_dispatch', stepIndex: 0 }, 'knowledge.brief.why'],
  ['agent_qa_get_run_knowledge', { runId: 'r_dispatch' }, 'runs.knowledge'],
  ['agent_qa_get_run_overview', { runId: 'r_dispatch' }, 'runs.overview'],
  ['agent_qa_get_run_evidence', {
    action: 'runs.evidence', runId: 'r_dispatch', testIndex: 0, stepIndex: 0, kind: 'console',
  }, 'runs.evidence'],
  ['agent_qa_get_run_evidence', { action: 'runs.artifact', runId: 'r_dispatch', sha: SHA }, 'runs.artifact'],
]

describe('MCP-DISPATCH (D-04 / D-07)', () => {
  it('reaches exactly the intended op for every named read and both fold arms', async () => {
    const audited: string[] = []
    const client = await connect(auditedRegistry(audited), callerWith(['read']))
    for (const [tool, args, opId] of DISPATCH_CALLS) {
      audited.length = 0
      const answered = await client.callTool({ name: tool, arguments: args })
      // An op this empty composition does not bind is refused at the binding step, before any port
      // read; its refusal names the op it reached.
      const text = JSON.stringify(answered.content)
      const reached = audited.length > 0 || !text.includes(`${opId} is declared but not bound`)
        ? [...audited]
        : [`fn:${opId}`]
      expect(reached, `${tool} ${JSON.stringify(args)}`).toEqual([`fn:${opId}`])
    }
  })
})

// ---- D-05: run knowledge answers the op's whole projection --------------------------------------

function knowledgeHandoff(): CompletedRunHandoff {
  const step = (stepIndex: number) => ({
    stepIndex,
    stepText: `step ${String(stepIndex)}`,
    cacheStatus: 'miss',
    servedBrief: {
      scope: { tier: 'product', key: 'shop' },
      asOfBuild: 4,
      budget: 400,
      truncation: '',
      channel1: [],
      channel2: [],
      channel3: [],
      briefDigest: `digest-${String(stepIndex)}`,
    },
    subActions: [],
    verifierVerdict: { pass: true, reasoning: 'ok' },
  })
  return {
    schemaVersion: schema.CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: schema.asRunId('r_whole-knowledge'),
    scope: { tier: 'product', key: 'shop' },
    buildOrdinal: 4,
    executionContext: 'local',
    aggregateVerdict: 'passed',
    configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
    startedAt: 1,
    endedAt: 2,
    tests: [
      { testId: 't_a', testName: 'a', filePath: 'tests/a.yaml', testIndex: 0, outcome: 'passed', steps: [step(0), step(1)] },
      { testId: 't_b', testName: 'b', filePath: 'tests/b.yaml', testIndex: 1, outcome: 'passed', steps: [step(0)] },
    ],
  } as unknown as CompletedRunHandoff
}

function knowledgeDeps(): Record<string, unknown> {
  const document = knowledgeHandoff()
  return {
    runs: {
      list: () => Promise.resolve([document]),
      get: () => Promise.resolve(document),
      readEvents: () => Promise.resolve([]),
      readStepEvidence: () => Promise.resolve({ kind: 'run-not-recorded' }),
    },
    knowledge: {
      listBundles: () => Promise.resolve([]),
      inspectRecords: () => Promise.resolve([]),
      diffSince: () => Promise.resolve([]),
      showRecord: ({ recordId }: { recordId: string }) =>
        Promise.resolve({ kind: 'not-found', schemaVersion: 2, recordId }),
    },
  }
}

describe('RUN-KNOWLEDGE-WHOLE (D-05)', () => {
  it('answers exactly what runs.knowledge answers, every step of every test', async () => {
    const registry = registryWith(knowledgeDeps())
    const direct = await invokeFunction(registry, 'runs.knowledge', { runId: 'r_whole-knowledge' }, READ_CALLER)
    const client = await connect(registry, callerWith(['read']))
    const result = await client.callTool({ name: 'agent_qa_get_run_knowledge', arguments: { runId: 'r_whole-knowledge' } })
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
    expect(result.structuredContent).toEqual(JSON.parse(JSON.stringify(direct)))
    const steps = (result.structuredContent as { steps?: readonly unknown[] }).steps
    expect(steps).toHaveLength(3)
  })
})

// ---- D-10: the moved rulings keep their history and gain a dated addendum ------------------------

const MOVED_RULINGS: Readonly<Record<string, string>> = {
  'knowledge.bundles.list': '397',
  'knowledge.records.inspect': '397',
  'knowledge.records.diff': '397',
  'knowledge.record.show': '397',
  'knowledge.brief.why': '397',
  'runs.knowledge': '407',
  'runs.evidence': '423',
  'runs.artifact': '405',
}

describe('RULING-ADDENDA (D-10)', () => {
  it("keeps each moved op's prior ruling verbatim and appends a dated 431 addendum", () => {
    const actual: Record<string, string> = {}
    for (const entry of PROJECTED_RULING_ADDENDA) {
      actual[entry.opId] = entry.ruledBy
      expect(entry.ruling.length, entry.opId).toBeGreaterThan(20)
      expect(entry.addendum, entry.opId).toContain('2026-09-28')
      expect(entry.addendum, entry.opId).toContain('431')
      expect(UNPROJECTED_OPS.some((unprojected) => unprojected.opId === entry.opId), entry.opId).toBe(false)
    }
    expect(actual).toEqual(MOVED_RULINGS)
    expect(PROJECTED_RULING_ADDENDA.find((entry) => entry.opId === 'runs.knowledge')?.ruling).toContain('2026-08-29')
    expect(PROJECTED_RULING_ADDENDA.find((entry) => entry.opId === 'runs.evidence')?.ruling).toContain('2026-09-15')
    expect(PROJECTED_RULING_ADDENDA.find((entry) => entry.opId === 'runs.artifact')?.ruling).toContain('2026-08-27')
    expect(PROJECTED_RULING_ADDENDA.find((entry) => entry.opId === 'runs.knowledge')?.addendum)
      .toContain('agent_qa_get_run_overview')
  })

  it('keeps runs.detail unprojected under its 405 ruling', () => {
    const detail = UNPROJECTED_OPS.find((entry) => entry.opId === 'runs.detail')
    expect(detail).toMatchObject({ adjudication: '405' })
    expect(detail?.reason).toContain('2026-08-27, 405-01')
    expect(AGENT_QA_TOOL_PROJECTIONS.flatMap((projection) => [...projection.ops])).not.toContain('runs.detail')
  })
})

// ---- Task 3: every caller reads the same tools, and the search census (D-03 / D-09 · T-431-08) ---
// (re-spelled 2026-10-02, 432-42: the narrow read authority this section was named for is deleted)

const NEW_TOOL_NAMES = Object.keys(CANONICAL_CONTRACTS)
// 2026-10-02 (432-39, D-10/D-12): the scope union is deleted; the retired names are spelled by hand.
const EVERY_SCOPE: readonly string[] = [
  'read', 'run', 'config-write', 'knowledge-write', 'approval-write', 'test-write',
]
const NO_READ_SCOPES = EVERY_SCOPE.filter((scope) => scope !== 'read')

/** Registry op ids and tool names that name a search capability. */
function searchCensus(opIds: readonly string[], toolNames: readonly string[]): readonly string[] {
  const searchy = (name: string) => /search/i.test(name)
  return [...opIds.filter(searchy), ...toolNames.filter(searchy)].sort()
}

function allDeclarations(registry: FunctionRegistry = registryWith()): readonly FunctionDeclaration[] {
  return registry.list(callerWith(EVERY_SCOPE))
}

describe('REGISTRY-NO-SEARCH (D-09)', () => {
  it('registers no search op and projects no search tool', () => {
    const census = searchCensus(
      allDeclarations().map((declaration) => declaration.id),
      AGENT_QA_TOOL_PROJECTIONS.map((projection) => projection.name),
    )
    expect(census).toEqual([])
    // 2026-10-01 (432-17 D-05): 53 -> 46, the seven proposal-inbox, apply and undo ops deleted.
    // 2026-10-01 (432-18 D-15): 46 -> 44, grants.list and grants.revoke deleted with the ledger.
    expect(allDeclarations()).toHaveLength(44)
  })

  it('flags a planted knowledge.search declaration through the same census', () => {
    const real = allDeclarations()
    const planted = { ...real.find((declaration) => declaration.id === 'knowledge.bundles.list')!, id: 'knowledge.search' }
    const subject: FunctionRegistry = { list: () => [...real, planted] }
    expect(searchCensus(subject.list(callerWith(EVERY_SCOPE)).map((declaration) => declaration.id), []))
      .toEqual(['knowledge.search'])
    expect(searchCensus([], ['agent_qa_search_knowledge'])).toEqual(['agent_qa_search_knowledge'])
  })
})

// RE-SPELLED 2026-10-01 (432-20, D-12) from 'READ-SCOPE-ONLY (T-431-08)'. The read scope gated the
// eight tools until the permission wave; now nothing about the caller does.
describe('READ-SCOPE-ONLY (T-431-08) — retired: every caller sees the eight (432-20)', () => {
  // RE-SPELLED from 'requires exactly the read scope and no credential for every new tool'.
  it('declares every new tool as a plain read over read-only ops, with no credential', () => {
    const declared = new Map(allDeclarations().map((declaration) => [declaration.id, declaration]))
    for (const name of NEW_TOOL_NAMES) {
      const projection = projectionNamed(name)!
      for (const opId of projection.ops) {
        expect(declared.get(opId)!.risk.readOnly, `${name} -> ${opId}`).toBe(true)
        expect(Object.keys(declared.get(opId)!), `${name} -> ${opId}`).not.toContain('requiredScopes')
      }
      expect(Object.hasOwn(projection, 'credential'), name).toBe(false)
      expect(projection.ui, name).toBeUndefined()
      expect(projection.kind, name).toBe('read')
    }
  })

  // RE-SPELLED from 'lists all eight to a read-only caller and none to a caller holding every scope
  // but read'.
  it('lists all eight to a read-only caller, a no-read caller and a caller granted nothing', async () => {
    const readOnly = await listed(registryWith(), callerWith(['read']))
    const noRead = await listed(registryWith(), callerWith(NO_READ_SCOPES))
    const nothing = await listed(registryWith(), callerWith([]))
    for (const name of NEW_TOOL_NAMES) {
      expect(readOnly.has(name), name).toBe(true)
      expect(noRead.has(name), name).toBe(true)
      expect(nothing.has(name), name).toBe(true)
    }
    expect([...noRead.keys()].sort()).toEqual([...readOnly.keys()].sort())
    expect([...nothing.keys()].sort()).toEqual([...readOnly.keys()].sort())
  })
})

// RE-SPELLED 2026-10-01 (432-20, D-12) from 'HIDDEN-NAME-INVOCATION (T-431-08)'. No tool is hidden,
// so the by-name call that used to be refused now reaches its op for every caller.
describe('HIDDEN-NAME-INVOCATION (T-431-08) — retired: no name is hidden (432-20)', () => {
  // RE-SPELLED from 'refuses a no-read caller that calls a hidden tool by name, before any op runs'.
  it('answers a no-read caller that calls each tool by name, reaching each op', async () => {
    const audited: string[] = []
    const rows = [bundle('b_hidden')]
    const registry = auditedRegistry(audited, { knowledge: { listBundles: () => Promise.resolve(rows) } })
    const client = await connect(registry, callerWith(NO_READ_SCOPES))
    const result = await client.callTool({ name: 'agent_qa_list_knowledge_bundles', arguments: {} })
    expect(result.isError).not.toBe(true)
    const structured = result.structuredContent as { result?: unknown } | unknown[]
    expect(Array.isArray(structured) ? structured : (structured as { result?: unknown }).result).toEqual(rows)
    expect(audited).toEqual(['fn:knowledge.bundles.list'])
    for (const [tool, args] of DISPATCH_CALLS) {
      let notFound = false
      try {
        await client.callTool({ name: tool, arguments: args })
      } catch (err) {
        notFound = (err instanceof Error ? err.message : String(err)).includes('not found')
      }
      expect(notFound, `${tool} is hidden from a no-read caller`).toBe(false)
    }
  })

  it('answers the same call for a read caller', async () => {
    const audited: string[] = []
    const rows = [bundle('b_visible')]
    const registry = auditedRegistry(audited, { knowledge: { listBundles: () => Promise.resolve(rows) } })
    const client = await connect(registry, callerWith(['read']))
    const result = await client.callTool({ name: 'agent_qa_list_knowledge_bundles', arguments: {} })
    expect(result.isError).not.toBe(true)
    const structured = result.structuredContent as { result?: unknown } | unknown[]
    expect(Array.isArray(structured) ? structured : (structured as { result?: unknown }).result).toEqual(rows)
    expect(audited).toEqual(['fn:knowledge.bundles.list'])
  })

  // RE-SPELLED from 'refuses the same op at the function layer for a no-read caller, with no audit
  // row'. The function layer serves it, once, and writes no audit row.
  it('serves the same op at the function layer for a no-read caller, with no audit row', async () => {
    const audited: string[] = []
    const registry = auditedRegistry(audited, { knowledge: { listBundles: () => Promise.resolve([]) } })
    await expect(invokeFunction(registry, 'knowledge.bundles.list', {}, callerWith(NO_READ_SCOPES)))
      .resolves.toEqual([])
    expect(audited).toEqual(['fn:knowledge.bundles.list'])
    expect(audited.filter((entry) => entry.startsWith('audit:'))).toEqual([])
  })
})
