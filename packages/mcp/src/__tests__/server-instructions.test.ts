// Hosts may skip init's AGENTS.md block, so the initialize result carries the pointer.

import { createServer } from 'node:http'
import type { Server as NodeHttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createMcpHandler } from '@modelcontextprotocol/server'
import {
  createFunctionRegistry,
  type FunctionDeps,
  type FunctionRegistry,
} from '@vostride/agent-qa-agent'
import type { FunctionCaller } from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it } from 'vitest'

import * as barrel from '../index.js'

const CALLER: FunctionCaller = { surface: 'mcp', origin: 'agent' }

function registry(): FunctionRegistry {
  return createFunctionRegistry({ deps: {} as unknown as FunctionDeps })
}

const deps = () => ({ registry: registry(), caller: CALLER, maskText: (text: string) => text })

const openClients: Client[] = []
const openServers: NodeHttpServer[] = []
afterEach(async () => {
  for (const client of openClients.splice(0)) await client.close().catch(() => {})
  for (const server of openServers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
})

async function connect(): Promise<Client> {
  const handler = createMcpHandler(() => barrel.buildAgentQaMcpServer(deps()))
  const client = new Client({ name: 'agent-qa-433-33', version: '0.0.0' })
  openClients.push(client)
  await client.connect(new StreamableHTTPClientTransport(new URL('http://instructions.local/mcp'), {
    fetch: ((url: URL | string, init?: RequestInit) => handler.fetch(new Request(url, init))) as typeof fetch,
  }))
  return client
}

async function connectLoopback(): Promise<Client> {
  const server = createServer(barrel.createAgentQaMcpNodeHandler(() => deps()) as never)
  openServers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`
  const client = new Client({ name: 'agent-qa-433-33-http', version: '0.0.0' })
  openClients.push(client)
  await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  return client
}

const FORBIDDEN = ['.agent-qa/', 'SQLite', 'memory/index/', 'memory/queue/', '.lease', '.epoch'] as const

describe('the MCP server instructions', () => {
  it('the initialize result carries instructions', async () => {
    const instructions = (await connect()).getInstructions()
    expect(typeof instructions).toBe('string')
    expect(instructions!.trim().length).toBeGreaterThan(0)
    expect(instructions).toBe(barrel.AGENT_QA_MCP_INSTRUCTIONS)
    expect(barrel.AGENT_QA_MCP_INSTRUCTIONS.length).toBeLessThanOrEqual(1200)
  })

  it('the loopback HTTP face answers the same instructions', async () => {
    const instructions = (await connectLoopback()).getInstructions()
    expect(typeof instructions).toBe('string')
    expect(instructions).toBe(barrel.AGENT_QA_MCP_INSTRUCTIONS)
  })

  it('they name every path a coding agent must never open', async () => {
    const instructions = (await connect()).getInstructions() ?? ''
    for (const path of FORBIDDEN) expect(instructions, path).toContain(path)
  })

  it('they name the first reads', async () => {
    const instructions = (await connect()).getInstructions() ?? ''
    const list = instructions.indexOf('agent_qa_list_runs')
    const overview = instructions.indexOf('agent_qa_get_run_overview')
    expect(list).toBeGreaterThanOrEqual(0)
    expect(overview).toBeGreaterThan(list)
    expect(instructions).toContain('--json')
    expect(instructions).toContain('agent-qa-knowledge/AGENTS.md')
  })

  it('every tool they name is registered', async () => {
    const client = await connect()
    const instructions = client.getInstructions() ?? ''
    const named = [...new Set([...instructions.matchAll(/agent_qa_[a-z_]+/g)].map((match) => match[0]))]
    expect(named.length).toBeGreaterThan(0)
    const listed = new Set((await client.listTools()).tools.map((tool) => tool.name))
    for (const name of named) expect(listed.has(name), name).toBe(true)
  })
})
