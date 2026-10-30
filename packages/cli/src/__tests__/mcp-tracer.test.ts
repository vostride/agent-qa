// One real MCP round trip over the shipped factory, parsed under the op's own output contract.

import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMcpHandler } from '@modelcontextprotocol/server'
import { Client } from '@modelcontextprotocol/client'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { buildAgentQaMcpServer, createAgentQaMcpNodeHandler } from '@vostride/agent-qa-mcp'
import { KnowledgeRecordsInspectOutputSchema } from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it } from 'vitest'

import { MCP_FUNCTION_CALLER } from '../commands/mcp.js'
import { composeCliLocalAgent } from '../composition/local-agent-host.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A real project on disk, of the shape `agent-qa init` produces. */
function workspace(): { configPath: string; agentQaRoot: string } {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-tracer-'))
  roots.push(root)
  const configPath = join(root, 'agent-qa.config.yaml')
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        workspace: {
          testMatch: ['tests/**/*.yaml'],
          testPathIgnore: [],
          suiteMatch: ['suites/**/*.suite.yaml'],
          hooksFile: 'hooks.yaml',
          envFile: '.env',
          secretsFile: '.env.secrets.local',
        },
        use: { mobile: { appState: 'preserve' } },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  const agentQaRoot = join(root, '.agent-qa')
  mkdirSync(agentQaRoot, { recursive: true })
  return { configPath, agentQaRoot }
}

describe('the MCP tracer: one projected tool, end to end on the v2 SDK', () => {
  // The knowledge inspect read is a 1:1 read tool with an object-rooted output contract.
  it('lists agent_qa_inspect_knowledge_records and answers a call with contract-valid structuredContent', async () => {
    const where = workspace()
    const host = composeCliLocalAgent({
      agentQaRoot: where.agentQaRoot,
      configPath: where.configPath,
    })

    // The masker is the required dep; identity here because this cell is about the round trip and
    // the masking claim has its own cells. Named rather than defaulted, because a masker that can
    // be omitted is a masker that will be.
    const handler = createMcpHandler(() =>
      buildAgentQaMcpServer({
        registry: host.registry,
        caller: MCP_FUNCTION_CALLER,
        maskText: (text: string) => text,
      }),
    )
    const transport = new StreamableHTTPClientTransport(new URL('http://tracer.local/mcp'), {
      fetch: ((url: URL | string, init?: RequestInit) =>
        handler.fetch(new Request(url, init))) as typeof fetch,
    })
    const client = new Client({ name: 'agent-qa-tracer', version: '0.0.0' })

    try {
      await client.connect(transport)

      const listed = await client.listTools()
      const tool = listed.tools.find((entry) => entry.name === 'agent_qa_inspect_knowledge_records')
      expect(tool, `tools/list carried: ${listed.tools.map((t) => t.name).join(', ')}`).toBeDefined()

      // The annotation is DERIVED from the op — `knowledge.records.inspect` declares `readOnly` and asks for
      // nothing beyond `read` — so this asserts the derivation reached the wire, not a literal.
      expect(tool!.annotations?.readOnlyHint).toBe(true)

      // A real object-typed output schema, converted by the SDK from the op's own zod contract.
      expect(tool!.outputSchema).toBeDefined()
      expect((tool!.outputSchema as { type?: string }).type).toBe('object')
      expect(
        Object.keys((tool!.outputSchema as { properties?: Record<string, unknown> }).properties ?? {}),
      ).toContain('records')

      const called = await client.callTool({
        name: 'agent_qa_inspect_knowledge_records',
        arguments: { filter: {} },
      })
      expect(called.isError ?? false, JSON.stringify(called.content)).toBe(false)

      // The result parses under the op's own output contract; an empty store is a result.
      const parsed = KnowledgeRecordsInspectOutputSchema.parse(called.structuredContent)
      expect(parsed.records).toEqual([])
    } finally {
      await client.close().catch(() => {})
      await handler.close().catch(() => {})
      await host.close().catch(() => {})
    }
  })

  // The same catalog over a real loopback socket, which a URL-driven conformance suite can reach.
  it('serves the same catalog over a real loopback socket, with no wildcard CORS header', async () => {
    const where = workspace()
    const host = composeCliLocalAgent({
      agentQaRoot: where.agentQaRoot,
      configPath: where.configPath,
    })
    // The handler takes a per-request deps resolver; a host with one caller passes a constant one.
    const nodeHandler = createAgentQaMcpNodeHandler(() => ({
      registry: host.registry,
      caller: MCP_FUNCTION_CALLER,
      maskText: (text: string) => text,
    }))
    const server = createServer((req, res) => {
      void nodeHandler(req, res)
    })
    await new Promise<void>((listening) => server.listen(0, '127.0.0.1', () => listening()))
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0

    const client = new Client({ name: 'agent-qa-tracer-http', version: '0.0.0' })
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
    )
    try {
      await client.connect(transport)
      const listed = await client.listTools()
      expect(listed.tools.map((entry) => entry.name)).toContain('agent_qa_inspect_knowledge_records')

      // Asserted on a raw response rather than through the client, because the client would not
      // report a header it does not read — and the header is the whole claim.
      const raw = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'OPTIONS',
      })
      expect(raw.headers.get('access-control-allow-origin')).toBeNull()
    } finally {
      await client.close().catch(() => {})
      await new Promise<void>((closed) => server.close(() => closed()))
      await host.close().catch(() => {})
    }
  })
})
