// OUTPUT-WIRE-PROOF and FOLD-REFINEMENT (431-03 task 3 · D-07 · EDGE-05/06/07).
//
// Every cell drives a real `McpServer` through the SDK's in-process handler and a real
// `@modelcontextprotocol/client`, whose `callTool` validates `structuredContent` against the
// advertised `outputSchema` with its own JSON Schema validator. So a passing call proves three
// things at once: the server's runtime validation, the advertised document, and the bytes between.
//
// The evidence fold is registered here on a probe tool rather than in the catalogue: the tool
// itself lands in 431-04. Its config still comes from the shipped derivation (`toRegisterToolConfig`)
// and its result from the shipped masked serializer (`maskedToolResult`).

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import type { CallToolResult } from '@modelcontextprotocol/server'
import {
  createFunctionRegistry,
  type FunctionDeps,
  type FunctionRegistry,
} from '@vostride/agent-qa-agent'
import { RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import * as schema from '@vostride/agent-qa-schema'
import type { CompletedRunHandoff, FunctionCaller } from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it } from 'vitest'

import { buildAgentQaMcpServer } from '../catalog.js'
import { withoutDialect, withoutLegacyResultWrap } from '../conformance-support.js'
import { AGENT_QA_OP_CONTRACTS, DEGRADED_OUTPUT_CONTRACTS } from '../mapping.js'
import type { ToolOpContracts, ToolProjection } from '../mapping.js'
import { maskedToolResult } from '../masked-result.js'
import { toRegisterToolConfig } from '../projection.js'
import type { ProjectedOpSpec } from '../projection.js'

type Json = Record<string, unknown>

const TARGET = { target: 'draft-2020-12' } as const
const caller: FunctionCaller = {
  surface: 'mcp', origin: 'agent',
  // 432-21 (D-12): no credential; the mark tool's handler reads none.
  // 2026-10-01 (432-34, D-12): no `grantedScopes` or `safeMode` either; nothing reads them (432-20).
}

function handoff(runId: string, endedAt: number): CompletedRunHandoff {
  return {
    schemaVersion: schema.CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: schema.asRunId(runId),
    scope: { tier: 'product', key: 'wire' },
    buildOrdinal: 1,
    executionContext: 'local-headless',
    aggregateVerdict: 'passed',
    configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
    startedAt: endedAt - 1,
    endedAt,
    tests: [{ testId: 't_wire', testName: 'wire member', filePath: 'tests/wire.yaml', testIndex: 0, outcome: 'passed', steps: [] }],
  }
}

function registryOver(recorded: readonly CompletedRunHandoff[]): FunctionRegistry {
  const deps = { runs: { list: () => Promise.resolve([...recorded]) }, secretMask: (text: string) => text } as unknown as FunctionDeps
  return createFunctionRegistry({ deps })
}

const openClients: Client[] = []
afterEach(async () => {
  for (const client of openClients.splice(0)) await client.close().catch(() => {})
})

async function connect(build: () => McpServer): Promise<Client> {
  const handler = createMcpHandler(build)
  const client = new Client({ name: 'agent-qa-431-03-wire', version: '0.0.0' })
  openClients.push(client)
  await client.connect(new StreamableHTTPClientTransport(new URL('http://wire.local/mcp'), {
    fetch: ((url: URL | string, init?: RequestInit) => handler.fetch(new Request(url, init))) as typeof fetch,
  }))
  return client
}

function catalogClient(recorded: readonly CompletedRunHandoff[] = []): Promise<Client> {
  return connect(() => buildAgentQaMcpServer({
    registry: registryOver(recorded),
    caller,
    maskText: (text: string) => text,
  }))
}

/** The list's rows, whichever protocol era the client negotiated: 2025-11-25 wraps an array root. */
function rowsOf(structuredContent: unknown): unknown[] {
  if (Array.isArray(structuredContent)) return structuredContent
  const wrapped = structuredContent as Json
  expect(Object.keys(wrapped)).toEqual(['result'])
  return wrapped.result as unknown[]
}

// ---- the evidence fold, on a probe tool ---------------------------------------------------------

const SECRET = 'sk-431-03-secret'
const sha = 'b'.repeat(64)
const runId = 'r_wire-evidence'

function variablesRecords(): Json {
  return JSON.parse(
    `{"__proto__":{"value":"token=${SECRET}","source":"capture"},"plain":{"value":"v","source":"inline"}}`,
  ) as Json
}

function evidenceAnswer(address: Json): unknown {
  if (address.kind === 'variables') {
    return {
      address, outcome: 'ready',
      evidence: { kind: 'variables', state: 'present', counts: { count: 2 } },
      document: { schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'variables', records: variablesRecords() },
    }
  }
  if (address.kind === 'console') {
    return {
      address, outcome: 'ready',
      evidence: { kind: 'console', state: 'present', ref: { id: `console-evidence:${sha}`, sha }, counts: { total: 0, errors: 0, warnings: 0 } },
      document: { schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'console', records: [] },
    }
  }
  return { address, outcome: 'read-error', code: 'address-not-found' }
}

function artifactAnswer(input: Json): unknown {
  return { runId: input.runId, sha: input.sha, contentType: 'image/png', byteLength: 0, bytesBase64: '' }
}

const PROBE: ToolProjection = Object.freeze({
  name: 'agent_qa_probe_run_evidence',
  ops: Object.freeze(['runs.evidence', 'runs.artifact']),
  kind: 'read',
  discriminant: schema.TOOL_FOLD_DISCRIMINANT,
}) as ToolProjection

function probeSpecs(): readonly ProjectedOpSpec[] {
  const declared = new Map(registryOver([]).list(caller).map((declaration) => [declaration.id, declaration]))
  return PROBE.ops.map((opId) => {
    const declaration = declared.get(opId)!
    return {
      id: declaration.id,
      summary: declaration.summary,
      risk: declaration.risk,
      input: schema.RunsEvidenceFoldInputSchema,
      output: schema.RunsEvidenceFoldOutputContract,
    }
  })
}

function probeClient(
  maskText: (text: string) => string = (text) => text,
  handled: unknown[] = [],
): Promise<Client> {
  const advertised: ToolOpContracts = {
    input: schema.RunsEvidenceFoldInputSchema,
    output: schema.RunsEvidenceFoldOutputContract,
  }
  return connect(() => {
    const server = new McpServer({ name: 'agent-qa-probe', version: '0.0.0' }, { capabilities: { tools: {} } })
    const config = toRegisterToolConfig(PROBE, probeSpecs(), advertised, maskText)
    server.registerTool(PROBE.name, config, async (args: unknown): Promise<CallToolResult> => {
      handled.push(args)
      const { [schema.TOOL_FOLD_DISCRIMINANT]: action, ...input } = args as Json
      const answer = action === 'runs.evidence'
        ? schema.RunsEvidenceResultSchema.parse(evidenceAnswer(input))
        : schema.RunsArtifactResultSchema.parse(artifactAnswer(input))
      return maskedToolResult(answer, maskText)
    })
    return server
  })
}

// ---- cells --------------------------------------------------------------------------------------

describe('OUTPUT-WIRE-PROOF', () => {
  it('advertises the list output on a real tools/list, with the degradation row gone', async () => {
    const client = await catalogClient()
    const tool = (await client.listTools()).tools.find((entry) => entry.name === 'agent_qa_list_runs')!
    expect(tool.outputSchema).toBeDefined()
    expect(withoutDialect(withoutLegacyResultWrap(tool.outputSchema))).toEqual(
      withoutDialect(schema.RunsListOutputContract['~standard'].jsonSchema.output(TARGET)),
    )
    expect(tool.description).not.toContain('advertises no outputSchema')
    expect(DEGRADED_OUTPUT_CONTRACTS.map((entry) => entry.tool)).not.toContain('agent_qa_list_runs')
    expect(AGENT_QA_OP_CONTRACTS['runs.list']!.output).toBe(schema.RunsListOutputContract)
    expect(schema.RunsListOutputContract.runtimeSchema).toBe(schema.RunsListOutputSchema)
  })

  it('matches the function layer\'s own declaration of the list and evidence outputs', () => {
    const declared = new Map(registryOver([]).list(caller).map((declaration) => [declaration.id, declaration]))
    expect(withoutDialect(declared.get('runs.list')!.output)).toEqual(
      withoutDialect(schema.RunsListOutputContract['~standard'].jsonSchema.output(TARGET)),
    )
    expect(withoutDialect(declared.get('runs.evidence')!.output)).toEqual(
      withoutDialect(schema.RunsEvidenceOutputContract['~standard'].jsonSchema.output(TARGET)),
    )
  })

  it('returns an empty list in its canonical shape and a populated one in a fixed order', async () => {
    const empty = await (await catalogClient()).callTool({ name: 'agent_qa_list_runs', arguments: {} })
    expect(empty.isError ?? false).toBe(false)
    expect(rowsOf(empty.structuredContent)).toEqual([])

    const client = await catalogClient([handoff('r_wire-older', 100), handoff('r_wire-newer', 200)])
    const first = await client.callTool({ name: 'agent_qa_list_runs', arguments: {} })
    const second = await client.callTool({ name: 'agent_qa_list_runs', arguments: {} })
    expect(first.isError ?? false, JSON.stringify(first.content)).toBe(false)
    expect((rowsOf(first.structuredContent) as { runId: string }[]).map((row) => row.runId))
      .toEqual(['r_wire-newer', 'r_wire-older'])
    expect(second.structuredContent).toEqual(first.structuredContent)
  })

  it('refuses a null filter on the list rather than treating it as absent', async () => {
    const client = await catalogClient([handoff('r_wire-one', 100)])
    for (const argumentsValue of [{ limit: null }, { verdict: null }, { limit: 0 }]) {
      const result = await client.callTool({ name: 'agent_qa_list_runs', arguments: argumentsValue as Json })
        .catch((err: unknown) => ({ isError: true, content: [{ type: 'text', text: String(err) }] }))
      expect(result.isError, JSON.stringify(argumentsValue)).toBe(true)
    }
  })

  it('registers the evidence fold with an output schema composed from the canonical contracts', async () => {
    const client = await probeClient()
    const tool = (await client.listTools()).tools.find((entry) => entry.name === PROBE.name)!
    expect(tool.outputSchema).toBeDefined()
    expect((withoutDialect(tool.outputSchema).anyOf as unknown[])).toEqual([
      withoutDialect(schema.RunsEvidenceOutputContract['~standard'].jsonSchema.output(TARGET)),
      withoutDialect(schema.RunsArtifactOutputContract['~standard'].jsonSchema.output(TARGET)),
    ])
  })

  it('carries own __proto__ variables through runtime validation, masking and the wire', async () => {
    const client = await probeClient((text) => text.split(SECRET).join('<SECRET_0>'))
    const result = await client.callTool({
      name: PROBE.name,
      arguments: { action: 'runs.evidence', runId, testIndex: 0, stepIndex: 0, kind: 'variables' },
    })
    expect(result.isError ?? false, JSON.stringify(result.content)).toBe(false)
    const records = ((result.structuredContent as Json).document as Json).records as Json
    expect(Object.keys(records).sort()).toEqual(['__proto__', 'plain'])
    expect(Object.getOwnPropertyDescriptor(records, '__proto__')?.value)
      .toEqual({ value: 'token=<SECRET_0>', source: 'capture' })
    expect(JSON.stringify(result)).not.toContain(SECRET)
  })

  it('dispatches each full operation id to its own arm and answers an empty collection', async () => {
    const handled: unknown[] = []
    const client = await probeClient(undefined, handled)
    const evidence = await client.callTool({
      name: PROBE.name,
      arguments: { action: 'runs.evidence', runId, testIndex: 0, stepIndex: 0, kind: 'console' },
    })
    expect(((evidence.structuredContent as Json).document as Json).records).toEqual([])
    const artifact = await client.callTool({ name: PROBE.name, arguments: { action: 'runs.artifact', runId, sha } })
    expect((artifact.structuredContent as Json).contentType).toBe('image/png')
    expect(handled.map((args) => (args as Json).action)).toEqual(['runs.evidence', 'runs.artifact'])
  })
})

describe('FOLD-REFINEMENT', () => {
  const accepts = (value: unknown) => schema.RunsEvidenceFoldInputSchema.safeParse(value).success
  const evidence = { action: 'runs.evidence', runId, testIndex: 0, stepIndex: 1 }

  it('names exactly the two full operation ids as its arms', () => {
    const arms = schema.RunsEvidenceFoldInputSchema.options.map(
      (arm) => arm.shape[schema.TOOL_FOLD_DISCRIMINANT].value,
    )
    expect(arms).toEqual(['runs.evidence', 'runs.artifact'])
  })

  it('keeps the evidence ARIA-only sub-action rule', () => {
    expect(accepts({ ...evidence, kind: 'aria', subActionIndex: 2 })).toBe(true)
    expect(accepts({ ...evidence, kind: 'console', subActionIndex: 2 })).toBe(false)
    expect(accepts({ ...evidence, kind: 'variables', subActionIndex: 0 })).toBe(false)
  })

  it('keeps both arms strict and refuses missing, null, unknown or crossed actions', () => {
    expect(accepts({ ...evidence, kind: 'console' })).toBe(true)
    expect(accepts({ action: 'runs.artifact', runId, sha })).toBe(true)
    expect(accepts({ ...evidence, kind: 'console', bogus: 1 })).toBe(false)
    expect(accepts({ runId, testIndex: 0, stepIndex: 1, kind: 'console' })).toBe(false)
    expect(accepts({ ...evidence, kind: 'console', action: null })).toBe(false)
    expect(accepts({ ...evidence, kind: 'console', action: 'runs.list' })).toBe(false)
    expect(accepts({ ...evidence, kind: 'console', action: 'evidence' })).toBe(false)
    expect(accepts({ action: 'runs.artifact', runId, testIndex: 0, stepIndex: 1, kind: 'console' })).toBe(false)
    expect(accepts({ action: 'runs.evidence', runId, sha })).toBe(false)
    expect(accepts(null)).toBe(false)
  })

  it('refuses a refined sub-action over the real wire, before the handler runs', async () => {
    const handled: unknown[] = []
    const client = await probeClient(undefined, handled)
    const result = await client.callTool({
      name: PROBE.name,
      arguments: { action: 'runs.evidence', runId, testIndex: 0, stepIndex: 0, kind: 'console', subActionIndex: 1 },
    }).catch((err: unknown) => ({ isError: true, content: [{ type: 'text', text: String(err) }] }))
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('Only ARIA evidence addresses a sub-action')
    expect(handled).toEqual([])
  })

  it('validates fold output through the exact runtime schemas of its arms', () => {
    const union = schema.RunsEvidenceFoldOutputContract.runtimeSchema as unknown as { options: readonly unknown[] }
    expect(union.options).toEqual([schema.RunsEvidenceResultSchema, schema.RunsArtifactResultSchema])
    expect(union.options[0]).toBe(schema.RunsEvidenceResultSchema)
    expect(union.options[1]).toBe(schema.RunsArtifactResultSchema)
    const invalid = schema.RunsEvidenceFoldOutputContract['~standard'].validate({ outcome: 'ready' }) as { issues?: unknown[] }
    expect(invalid.issues?.length).toBeGreaterThan(0)
  })
})
