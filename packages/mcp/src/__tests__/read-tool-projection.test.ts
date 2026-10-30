// `CANONICAL_CONTRACTS` is the one restated table; every cell compares it with a producer.

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

describe('the canonical contract table', () => {
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
      // A declaration carries no scope or origin key; the read claim is the risk's.
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

// ---- The read tools on the projection path ----

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

// The caller type declares no scope set; the one passed here is extra data that nothing reads.
function callerWith(grantedScopes: readonly string[]): FunctionCaller {
  return { surface: 'mcp', origin: 'agent', grantedScopes } as FunctionCaller
}

async function connect(registry: FunctionRegistry, caller: FunctionCaller): Promise<Client> {
  const handler = createMcpHandler(() => buildAgentQaMcpServer({ registry, caller, maskText: (text: string) => text }))
  const client = new Client({ name: 'agent-qa-read-projection', version: '0.0.0' })
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

describe('MCP-TOOLS-EXACT', () => {
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
      // The `2025-11-25` codec wraps an array root in `{ result }`; the lens undoes only that wrap.
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

// ---- Dispatch: each bound op's first port read names the op the call reached ----
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

describe('MCP-DISPATCH', () => {
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

// ---- Run knowledge answers the op's whole projection ----

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

describe('RUN-KNOWLEDGE-WHOLE', () => {
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

describe('unprojected reads', () => {
  it('leaves runs.detail unprojected', () => {
    expect(UNPROJECTED_OPS.map((entry) => entry.opId)).toContain('runs.detail')
    expect(AGENT_QA_TOOL_PROJECTIONS.flatMap((projection) => [...projection.ops])).not.toContain('runs.detail')
  })
})
