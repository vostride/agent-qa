// A server with no project to serve lists every tool and answers each call with what to run.

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createMcpHandler } from '@modelcontextprotocol/server'
import {
  createFunctionRegistry,
  type FunctionDeps,
  type FunctionRegistry,
} from '@vostride/agent-qa-agent'
import type { FunctionCaller } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as barrel from '../index.js'
import type { AgentQaMcpPosture } from '../index.js'

const invoked = vi.hoisted(() => [] as string[])

vi.mock('@vostride/agent-qa-agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@vostride/agent-qa-agent')>()
  return {
    ...actual,
    invokeFunction: async (
      registry: FunctionRegistry,
      id: string,
      input: unknown,
      caller: FunctionCaller,
    ) => {
      invoked.push(id)
      return await actual.invokeFunction(registry, id, input, caller)
    },
  }
})

const CALLER: FunctionCaller = { surface: 'mcp', origin: 'agent' }
const CONFIG_PATH = '/p/agent-qa.config.yaml'
const NOT_INITIALIZED: AgentQaMcpPosture = { state: 'not-initialized', configPath: CONFIG_PATH }

const registry = createFunctionRegistry({ deps: {} as unknown as FunctionDeps })

const openClients: Client[] = []
beforeEach(() => {
  invoked.length = 0
})
afterEach(async () => {
  for (const client of openClients.splice(0)) await client.close().catch(() => {})
})

async function connect(
  posture?: AgentQaMcpPosture,
  era: 'legacy' | 'auto' = 'legacy',
): Promise<Client> {
  const handler = createMcpHandler(() => barrel.buildAgentQaMcpServer({
    registry,
    caller: CALLER,
    maskText: (text: string) => text,
    version: '0.0.0-test',
    ...(posture === undefined ? {} : { posture }),
  }))
  const client = new Client(
    { name: 'agent-qa-posture', version: '0.0.0' },
    era === 'auto' ? { versionNegotiation: { mode: 'auto' as const } } : {},
  )
  openClients.push(client)
  await client.connect(new StreamableHTTPClientTransport(new URL('http://posture.local/mcp'), {
    fetch: ((url: URL | string, init?: RequestInit) =>
      handler.fetch(new Request(url, init))) as typeof fetch,
  }))
  return client
}

async function toolNames(client: Client): Promise<string[]> {
  return (await client.listTools()).tools.map((tool) => tool.name).sort()
}

describe('the MCP server with no project to serve', () => {
  it('lists the same tools as a server with a project', async () => {
    const served = await toolNames(await connect())
    const posture = await toolNames(await connect(NOT_INITIALIZED))
    expect(posture.length).toBeGreaterThan(0)
    expect(posture).toEqual(served)
  })

  it('answers a call with not initialized, npx agent-qa init and a restart', async () => {
    const expected = {
      status: 'not_initialized',
      configPath: CONFIG_PATH,
      run: 'npx agent-qa init',
      then: 'restart this MCP server (reconnect it in your coding agent)',
    }
    const result = await (await connect(NOT_INITIALIZED, 'auto')).callTool({
      name: 'agent_qa_list_runs',
      arguments: {},
    })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toEqual(expected)

    // The 2025 codec wraps a result in `{ result }` when the tool's output schema is not an object.
    const legacy = await (await connect(NOT_INITIALIZED)).callTool({
      name: 'agent_qa_list_runs',
      arguments: {},
    })
    expect(legacy.isError).toBe(true)
    expect(legacy.structuredContent).toEqual({ result: expected })
    const content = result.content as { type: string; text: string }[]
    expect(content).toHaveLength(1)
    expect(content[0]!.type).toBe('text')
    expect(content[0]!.text).toContain(CONFIG_PATH)
    expect(content[0]!.text).toContain('npx agent-qa init')
    expect(content[0]!.text).toContain('then restart this MCP server')
  })

  it('never invokes a registry function', async () => {
    await (await connect()).callTool({ name: 'agent_qa_list_runs', arguments: {} })
    expect(invoked).toContain('runs.list')

    invoked.length = 0
    await (await connect(NOT_INITIALIZED)).callTool({ name: 'agent_qa_list_runs', arguments: {} })
    expect(invoked).toEqual([])
  })

  it('lists no resources', async () => {
    const listed = await (await connect(NOT_INITIALIZED)).listResources()
    expect(listed.resources).toEqual([])
  })

  it('answers a call with config invalid, its problem, validate and a restart', async () => {
    const posture: AgentQaMcpPosture = {
      state: 'config-invalid',
      configPath: CONFIG_PATH,
      problem: 'workspace: Required',
    }
    const client = await connect(posture, 'auto')
    const result = await client.callTool({ name: 'agent_qa_list_runs', arguments: {} })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toEqual({
      status: 'config_invalid',
      configPath: CONFIG_PATH,
      problem: 'workspace: Required',
      run: 'npx agent-qa validate',
      then: 'restart this MCP server (reconnect it in your coding agent)',
    })
    const content = result.content as { type: string; text: string }[]
    expect(content).toHaveLength(1)
    expect(content[0]!.text).toContain('workspace: Required')
    expect(content[0]!.text).toContain('npx agent-qa validate')
    expect(content[0]!.text).toContain('then restart this MCP server')
    expect(client.getInstructions()).toBe(barrel.agentQaMcpPostureInstructions(posture))
    expect(client.getInstructions()).toContain('npx agent-qa validate')
    expect(client.getInstructions()).toContain('then restart this MCP server')
    expect(invoked).toEqual([])
  })

  it('answers the posture instructions', async () => {
    const instructions = (await connect(NOT_INITIALIZED)).getInstructions()
    expect(instructions).toBe(barrel.agentQaMcpPostureInstructions(NOT_INITIALIZED))
    expect(instructions).toContain('npx agent-qa init')
    expect(instructions).toContain('then restart this MCP server')
    expect(instructions).not.toContain('until you run')
    expect(instructions).toContain(CONFIG_PATH)
  })
})
