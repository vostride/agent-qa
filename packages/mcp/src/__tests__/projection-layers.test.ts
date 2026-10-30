// Driven directly, across the cases the CLI tracer's working fixture cannot reach.

import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { createFunctionRegistry } from '@vostride/agent-qa-agent'
import type { FunctionDeps, FunctionRegistry } from '@vostride/agent-qa-agent'
import type { FunctionCaller } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import {
  advertisedContracts,
  AGENT_QA_OP_CONTRACTS,
  AGENT_QA_TOOL_PROJECTIONS,
  compositionOf,
} from '../mapping.js'
import type { ToolOpContracts, ToolProjection } from '../mapping.js'
import { buildAgentQaMcpServer } from '../catalog.js'
import { McpProjectionError, toRegisterToolConfig } from '../projection.js'
import type { ProjectedOpSpec } from '../projection.js'

const READ_PROJECTION: ToolProjection = {
  name: 'agent_qa_get_run_marks',
  ops: ['runs.marks.history'],
  kind: 'read',
}

function spec(overrides: Partial<ProjectedOpSpec> = {}): ProjectedOpSpec {
  return {
    id: 'runs.marks.history',
    summary: 'Read the marks recorded against one run, and what each applied.',
    risk: { name: 'fn:runs.marks.history', recognized: true, readOnly: true },
    input: AGENT_QA_OP_CONTRACTS['runs.marks.history']!.input,
    output: AGENT_QA_OP_CONTRACTS['runs.marks.history']!.output,
    ...overrides,
  }
}

// ---- The tokenless catalog ----

/** A real registry over every built-in op, with a knowledge reader that answers an empty list. */
function realRegistry(): FunctionRegistry {
  return createFunctionRegistry({
    deps: {
      knowledge: { listBundles: () => Promise.resolve([]) },
    } as unknown as FunctionDeps,
  })
}

// Door callers and records with retired grants; an identical answer for all of them is the claim.
const DOOR_CALLERS: Readonly<Record<string, FunctionCaller>> = {
  'tokenless stdio': { surface: 'mcp', origin: 'agent' },
  'tokenless http': { surface: 'mcp', origin: 'agent' },
  // Old records still carry the retired fields, cast past the type here; nothing reads them.
  'legacy every-scope': {
    surface: 'mcp',
    origin: 'agent',
    grantedScopes: ['read', 'run', 'config-write', 'knowledge-write', 'approval-write', 'test-write'],
    safeMode: false,
  } as FunctionCaller,
  'legacy nothing, safe mode': {
    surface: 'mcp', origin: 'agent', grantedScopes: [], safeMode: true,
  } as FunctionCaller,
}

async function withClient<Answer>(
  caller: FunctionCaller,
  body: (client: Client) => Promise<Answer>,
): Promise<Answer> {
  const server = buildAgentQaMcpServer({ registry: realRegistry(), caller, maskText: (text) => text })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'tokenless', version: '0.0.0' })
  await client.connect(clientTransport)
  try {
    return await body(client)
  } finally {
    await client.close()
    await server.close()
  }
}

/** Everything discovery tells a caller: tools (name, schemas, annotations) and resource templates. */
async function discovery(caller: FunctionCaller): Promise<string> {
  return withClient(caller, async (client) => JSON.stringify({
    tools: (await client.listTools()).tools,
    templates: (await client.listResourceTemplates()).resourceTemplates,
  }))
}

describe('identical discovery and dispatch for every caller', () => {
  it('lists the same tools and resource templates to every door caller', async () => {
    const answers = await Promise.all(Object.values(DOOR_CALLERS).map(discovery))
    const parsed = JSON.parse(answers[0]!) as { tools: { name: string }[]; templates: unknown[] }
    // Non-vacuity: the catalogue is the full projected set this composition registers.
    expect(parsed.tools.length).toBeGreaterThan(10)
    expect(parsed.templates.length).toBeGreaterThan(0)
    for (const [label, answer] of Object.entries(DOOR_CALLERS).map(
      ([name], index) => [name, answers[index]!] as const,
    )) {
      expect(answer, label).toBe(answers[0])
    }
  })

  it('lists every projected tool whose ops the composition registers, to a tokenless caller', async () => {
    const listed = await withClient(DOOR_CALLERS['tokenless stdio']!, async (client) =>
      (await client.listTools()).tools.map((tool) => tool.name))
    const registered = new Set(realRegistry().list(DOOR_CALLERS['tokenless stdio']!).map((row) => row.id))
    const servable = AGENT_QA_TOOL_PROJECTIONS
      .filter((projection) => projection.ops.every((op) => registered.has(op)))
      .map((projection) => projection.name)
    expect([...listed].sort()).toEqual([...servable].sort())
  })

  it('dispatches a read identically for every door caller', async () => {
    const answers = await Promise.all(Object.values(DOOR_CALLERS).map((caller) =>
      withClient(caller, async (client) => JSON.stringify(
        await client.callTool({ name: 'agent_qa_list_knowledge_bundles', arguments: {} }),
      ))))
    expect(JSON.parse(answers[0]!)).not.toHaveProperty('isError', true)
    for (const answer of answers) expect(answer).toBe(answers[0])
  })

  it('refuses a malformed request through the ordinary schema, identically for every caller', async () => {
    const answers = await Promise.all(Object.values(DOOR_CALLERS).map((caller) =>
      withClient(caller, async (client) => {
        try {
          return JSON.stringify(await client.callTool({
            name: 'agent_qa_list_knowledge_bundles',
            arguments: { unexpected: true },
          }))
        } catch (error: unknown) {
          return JSON.stringify({ thrown: (error as Error).message })
        }
      })))
    expect(answers[0]).toMatch(/unexpected|Unrecognized|Invalid/i)
    expect(answers[0]).not.toMatch(/scope|credential|not found/i)
    for (const answer of answers) expect(answer).toBe(answers[0])
  })
})

/**
 * The contract a 1:1 tool advertises IS its op's, so the fixture reads it back the same way
 * `catalog.ts` does rather than restating it — a helper that hand-picked the schemas would pass
 * over a mapping whose join is broken.
 */
function advertised(projection: ToolProjection): ToolOpContracts {
  const contracts = advertisedContracts(projection)
  if (contracts === undefined) throw new Error(`no advertised contract for ${projection.name}`)
  return contracts
}

describe('toRegisterToolConfig', () => {
  const identity = (text: string): string => text

  it('derives the description from the op summary and advertises the op contracts', () => {
    const config = toRegisterToolConfig(READ_PROJECTION, [spec()], advertised(READ_PROJECTION), identity)

    expect(config.title).toBe('agent_qa_get_run_marks')
    expect(config.description).toBe(spec().summary)
    // Identity, not equal values: the advertised schema is the object the op validates with.
    expect(config.inputSchema).toBe(AGENT_QA_OP_CONTRACTS['runs.marks.history']!.input)
    expect(config.outputSchema).toBe(AGENT_QA_OP_CONTRACTS['runs.marks.history']!.output)
  })

  it('derives readOnlyHint and idempotentHint for a read op', () => {
    const config = toRegisterToolConfig(READ_PROJECTION, [spec()], advertised(READ_PROJECTION), identity)
    expect(config.annotations.readOnlyHint).toBe(true)
    expect(config.annotations.idempotentHint).toBe(true)
    expect(config.annotations.destructiveHint).toBe(false)
  })

  // Catches a hard-coded `readOnlyHint: true`; the op's own `readOnly` is the only signal.
  it('refuses readOnlyHint for an op that writes, and carries its destructive declaration', () => {
    const writing = spec({
      id: 'config.field.set',
      risk: { name: 'fn:config.field.set', recognized: true, destructive: true },
    })
    const projection: ToolProjection = {
      name: 'agent_qa_set_config_field',
      ops: ['config.field.set'],
      kind: 'workflow',
    }
    const config = toRegisterToolConfig(
      projection,
      [writing],
      AGENT_QA_OP_CONTRACTS['config.field.set']!,
      identity,
    )
    expect(config.annotations.readOnlyHint).toBe(false)
    expect(config.annotations.idempotentHint).toBe(false)
    expect(config.annotations.destructiveHint).toBe(true)
  })

  // The masker is a REQUIRED dep and this is what makes that load-bearing rather than ceremonial.
  // The absence assertion is windowed at 8 characters, because a partial disclosure is a
  // disclosure; it is paired with an integrity assertion, because `not.toContain` over a channel
  // the value never entered passes for the wrong reason.
  it('routes the derived description through the masker', () => {
    const planted = 'sk-live-9f3a1c0b7d2e4f6a'
    const masked = toRegisterToolConfig(
      READ_PROJECTION,
      [spec({ summary: `Lists marks for ${planted}.` })],
      advertised(READ_PROJECTION),
      (text: string) => text.split(planted).join('[SECRET_0]'),
    )

    for (let at = 0; at + 8 <= planted.length; at += 1) {
      expect(masked.description).not.toContain(planted.slice(at, at + 8))
    }
    // Integrity: the masker demonstrably saw and rewrote these exact bytes, so the absence above
    // is a redaction rather than an empty channel.
    expect(masked.description).toBe('Lists marks for [SECRET_0].')
  })

  it('refuses a projection with no arms', () => {
    expect(() =>
      toRegisterToolConfig(READ_PROJECTION, [], advertised(READ_PROJECTION), identity),
    ).toThrow(McpProjectionError)
  })

  // A fold derived from fewer arms than it declares would refuse valid input for a missing arm.
  it('refuses a fold derived from a subset of its declared arms', () => {
    const projection: ToolProjection = {
      name: 'agent_qa_change_config',
      ops: ['config.field.set', 'config.hook.add', 'config.auth.set'],
      kind: 'workflow',
      discriminant: 'action',
    }
    expect(() =>
      toRegisterToolConfig(
        projection,
        [spec({ id: 'config.field.set' }), spec({ id: 'config.hook.add' })],
        advertised({ ...projection, name: 'agent_qa_change_config' }),
        identity,
      ),
    ).toThrow(/declares 3 ops but was derived from 2/u)
  })

  // THE BAR for the degradation clause: an implementation that advertised the output regardless
  // would pass every cell above (the read contracts all convert) and red here, because
  // `RunStartAcknowledgementSchema` is built over a branded run id and its output-mode conversion
  // throws. Left unhandled, that throw happens inside `tools/list` and takes the LISTING down.
  it('omits the outputSchema for a declared degradation and says so in the description', () => {
    const projection: ToolProjection = {
      name: 'agent_qa_start_run',
      ops: ['runs.start'],
      kind: 'workflow',
    }
    const config = toRegisterToolConfig(
      projection,
      [spec({ id: 'runs.start', risk: { name: 'fn:runs.start', recognized: true } })],
      advertised(projection),
      identity,
    )
    expect(config.outputSchema).toBeUndefined()
    expect(config.description).toContain('advertises no outputSchema')
    expect(config.description).toContain('RunStartAcknowledgementSchema')
  })

  // The other side of the same two-sided declaration: an entry for a contract that converts fine is
  // a tool withholding a schema it could publish, so it refuses rather than rots.
  it('refuses a degradation entry whose contract converts cleanly', () => {
    const projection: ToolProjection = {
      name: 'agent_qa_start_run',
      ops: ['runs.marks.history'],
      kind: 'read',
    }
    expect(() =>
      toRegisterToolConfig(
        projection,
        [spec()],
        AGENT_QA_OP_CONTRACTS['runs.marks.history']!,
        identity,
      ),
    ).toThrow(/converts cleanly in output mode/u)
  })

  // The undeclared case. This is the cell that stands between a new op contract and a dead
  // `tools/list`: the failure is named here, at build time, with the tool and the converter's own
  // message, instead of surfacing as an unattributed exception in a protocol response.
  it('refuses an undeclared unrepresentable output contract, naming the tool', () => {
    const projection: ToolProjection = {
      name: 'agent_qa_get_run_marks',
      ops: ['runs.marks.history'],
      kind: 'read',
    }
    expect(() =>
      toRegisterToolConfig(
        projection,
        [spec()],
        AGENT_QA_OP_CONTRACTS['runs.start']!,
        identity,
      ),
    ).toThrow(/agent_qa_get_run_marks advertises an output contract JSON Schema cannot represent/u)
  })
})

describe('compositionOf — derived, never restated', () => {
  it('reads single, union and pipeline off the entry', () => {
    expect(compositionOf({ name: 't', ops: ['a'], kind: 'read' })).toBe('single')
    expect(compositionOf({ name: 't', ops: ['a', 'b'], kind: 'read' })).toBe('pipeline')
    expect(
      compositionOf({ name: 't', ops: ['a', 'b'], kind: 'read', discriminant: 'action' }),
    ).toBe('union')
  })
})

describe('the mapping table', () => {
  // The two tables are separate because they come from different places; this is what stops them
  // drifting. `catalog.ts` throws on the same condition at build time — the cell states it as a
  // property of the shipped data rather than of one code path reaching it.
  it('names no op that is missing from the contract table', () => {
    for (const projection of AGENT_QA_TOOL_PROJECTIONS) {
      for (const opId of projection.ops) {
        expect(AGENT_QA_OP_CONTRACTS[opId], `${projection.name} -> ${opId}`).toBeDefined()
      }
    }
  })

  it('declares no duplicate tool name', () => {
    const names = AGENT_QA_TOOL_PROJECTIONS.map((projection) => projection.name)
    expect(new Set(names).size).toBe(names.length)
  })
})
