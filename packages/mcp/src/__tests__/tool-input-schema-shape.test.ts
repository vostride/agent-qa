// 2026-10-20 (446-11, D-25 · F-446-11-8): Claude Code 2.1.304 silently dropped the four fold
// tools, whose listed input was a top-level oneOf with no properties. These cells read tools/list
// off the wire and hold every listed input to one plain object, while a fold call is still refused
// exactly as its strict union refuses it.

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { createFunctionRegistry, type FunctionDeps } from '@vostride/agent-qa-agent'
import type { FunctionCaller } from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it } from 'vitest'

import { buildAgentQaMcpServer } from '../catalog.js'
import {
  AGENT_QA_COMPOSED_CONTRACTS,
  AGENT_QA_TOOL_PROJECTIONS,
  compositionOf,
} from '../mapping.js'

type Json = Record<string, unknown>

interface ListedTool {
  readonly name: string
  readonly inputSchema: Json
}

interface CallOutcome {
  readonly isError: boolean
  readonly text: string
}

const FOLDS = [
  'agent_qa_refine_test',
  'agent_qa_change_config',
  'agent_qa_change_knowledge',
  'agent_qa_get_run_evidence',
] as const

const ARM_INVALID_CALLS: readonly { readonly tool: string; readonly args: Json }[] = [
  {
    tool: 'agent_qa_refine_test',
    args: {
      action: 'authoring.draft.edit',
      testRef: 't_x',
      intent: 'tighten it',
      draftPath: 'd.yaml',
    },
  },
  { tool: 'agent_qa_refine_test', args: { action: 'authoring.draft.verify', testRef: 't_x' } },
  {
    tool: 'agent_qa_change_config',
    args: { action: 'config.field.set', path: 'use.timeout.step', name: 'shop' },
  },
  {
    tool: 'agent_qa_change_knowledge',
    args: {
      action: 'knowledge.accept',
      target: { grain: 'record', recordId: 'rec-1' },
      reason: 'only reject takes a reason',
    },
  },
  {
    tool: 'agent_qa_get_run_evidence',
    args: { action: 'runs.artifact', runId: 'r_x', sha: 'a'.repeat(64), kind: 'aria' },
  },
]

const openClients: Client[] = []

afterEach(async () => {
  for (const client of openClients.splice(0)) await client.close().catch(() => {})
})

async function connect(build: () => McpServer): Promise<Client> {
  const handler = createMcpHandler(build)
  const client = new Client({ name: 'agent-qa-tool-input-schema-shape', version: '0.0.0' })
  openClients.push(client)
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://tool-schema.local/mcp'), {
      fetch: ((url: URL | string, init?: RequestInit) =>
        handler.fetch(new Request(url, init))) as typeof fetch,
    }),
  )
  return client
}

function shippedServer(): McpServer {
  return buildAgentQaMcpServer({
    registry: createFunctionRegistry({ deps: {} as unknown as FunctionDeps }),
    caller: {
      surface: 'mcp',
      grantedScopes: [],
      safeMode: false,
      origin: 'agent',
    } as unknown as FunctionCaller,
    maskText: (text: string) => text,
  })
}

// The fold's strict union registered as-is, with a handler that must never run.
function strictUnionServer(tool: string): McpServer {
  const server = new McpServer(
    { name: 'strict-union', version: '0.0.0' },
    { capabilities: { tools: {} } },
  )
  server.registerTool(tool, { inputSchema: AGENT_QA_COMPOSED_CONTRACTS[tool]!.input }, () => {
    throw new Error('the strict union admitted an arm-invalid call')
  })
  return server
}

async function listed(): Promise<readonly ListedTool[]> {
  const client = await connect(shippedServer)
  return (await client.listTools()).tools as unknown as readonly ListedTool[]
}

async function outcome(client: Client, tool: string, args: Json): Promise<CallOutcome> {
  const result = await client.callTool({ name: tool, arguments: args })
  const content = (result.content ?? []) as readonly { type: string; text?: string }[]
  return {
    isError: result.isError === true,
    text: content.map((part) => part.text ?? '').join('\n'),
  }
}

function strictArms(tool: string): readonly Json[] {
  const document = AGENT_QA_COMPOSED_CONTRACTS[tool]!.input['~standard'].jsonSchema.input({
    target: 'draft-2020-12',
  })
  return (document.oneOf ?? []) as readonly Json[]
}

function withoutDescription(schema: unknown): Json {
  const { description: _description, ...rest } = (schema ?? {}) as Json
  return rest
}

describe('C446-TOOL-SCHEMA', () => {
  it('every listed tool input is one plain object with properties and no top-level union', async () => {
    const tools = await listed()
    expect(tools.length).toBe(AGENT_QA_TOOL_PROJECTIONS.length)
    expect(tools.length).toBeGreaterThan(0)

    const offenders = tools
      .filter((tool) => {
        const schema = tool.inputSchema ?? {}
        const plain = schema.type === 'object'
          && typeof schema.properties === 'object'
          && schema.properties !== null
        const union = ['oneOf', 'anyOf', 'allOf'].some((key) => schema[key] !== undefined)
        return !plain || union
      })
      .map((tool) => tool.name)
    expect(offenders).toEqual([])
  })

  it('a fold lists its action values and every field its arms take, requiring only what every arm requires', async () => {
    const tools = new Map((await listed()).map((tool) => [tool.name, tool.inputSchema]))
    const folds = AGENT_QA_TOOL_PROJECTIONS.filter(
      (projection) => compositionOf(projection) === 'union',
    )
    expect(folds.map((fold) => fold.name)).toEqual([...FOLDS])

    for (const fold of folds) {
      const key = fold.discriminant!
      const schema = tools.get(fold.name) ?? {}
      const properties = (schema.properties ?? {}) as Record<string, Json>
      const arms = strictArms(fold.name)
      expect(arms.length, fold.name).toBe(fold.ops.length)

      expect(properties[key]?.type, `${fold.name} ${key}`).toBe('string')
      expect(properties[key]?.enum, `${fold.name} ${key}`).toEqual([...fold.ops])

      const fields = new Map<string, Json[]>()
      for (const arm of arms) {
        const armProperties = (arm.properties ?? {}) as Record<string, Json>
        for (const [name, field] of Object.entries(armProperties)) {
          if (name === key) continue
          const seen = fields.get(name) ?? []
          seen.push(field)
          fields.set(name, seen)
        }
      }
      expect(Object.keys(properties).sort(), fold.name).toEqual([key, ...fields.keys()].sort())

      for (const [name, armFields] of fields) {
        const shapes = armFields.map(withoutDescription)
        const distinct = shapes.filter(
          (field, at) =>
            shapes.findIndex((other) => JSON.stringify(other) === JSON.stringify(field)) === at,
        )
        const expected = distinct.length === 1 ? distinct[0] : { anyOf: distinct }
        expect(withoutDescription(properties[name]), `${fold.name}.${name}`).toEqual(expected)
        for (const own of armFields) {
          if (typeof own.description === 'string') {
            expect(properties[name]!.description, `${fold.name}.${name}`).toContain(own.description)
          }
        }
      }

      for (const [name, field] of Object.entries(properties)) {
        const described = typeof field.description === 'string' && field.description.length > 0
        expect(described, `${fold.name}.${name} description`).toBe(true)
      }

      const requiredByEvery = arms
        .map((arm) => (arm.required ?? []) as readonly string[])
        .reduce((common, required) => common.filter((name) => required.includes(name)))
      expect([...((schema.required ?? []) as readonly string[])].sort(), `${fold.name} required`)
        .toEqual([...requiredByEvery].sort())
      expect(schema.additionalProperties, `${fold.name} additionalProperties`).toBe(false)
    }
  })

  it('an arm-invalid fold call is refused exactly as the strict fold union refuses it', async () => {
    const shipped = await connect(shippedServer)
    expect(new Set(ARM_INVALID_CALLS.map((call) => call.tool))).toEqual(new Set(FOLDS))

    for (const call of ARM_INVALID_CALLS) {
      const reference = await connect(() => strictUnionServer(call.tool))
      const strict = await outcome(reference, call.tool, call.args)
      expect(strict.isError, `${call.tool} strict`).toBe(true)
      expect(strict.text, `${call.tool} strict`).toContain('Input validation error')

      const answer = await outcome(shipped, call.tool, call.args)
      expect(answer, `${call.tool} ${JSON.stringify(call.args)}`).toEqual(strict)
    }
  })
})
