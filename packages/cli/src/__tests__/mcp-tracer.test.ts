// The one path, end to end, on the v2 SDK (Phase 396 plan 01 — the phase's tracer).
//
// WHAT THIS PROVES, and why it is one cell rather than four. Every layer of the re-derived server
// has its own unit cells over in `packages/mcp`; none of them can answer the only question that
// matters before any expansion happens, which is whether the ARCHITECTURE works: a real MCP client
// asks a per-caller server built from a REAL composed registry for its tool list, calls the one
// projected tool, and gets back `structuredContent` that parses under the op's own contract. If
// that round trip holds, the remaining twelve projected tools are data entries. If it does not, no
// amount of mapping would have helped.
//
// PRODUCED, NOT LITERAL, ON BOTH SIDES. The server is built by the shipped factory over the
// production `composeCliLocalAgent` against a real temp project on disk — no stubbed registry, no
// hand-assembled declaration. The client is the real `@modelcontextprotocol/client` speaking the
// real wire; the only thing replaced is the socket, because `handler.fetch` is the SDK's own
// documented in-process driver. A cell that asserted against a hand-built response would be
// measuring this file's idea of the protocol rather than the protocol.
//
// The assertion on the output side is `KnowledgeRecordsInspectOutputSchema.parse` — the op's OWN contract,
// imported rather than restated. That is what makes it a D-16 claim: the schema the server
// advertised, the schema `invokeFunction` validated with, and the schema asserted here are one
// object, so the cell cannot pass over a server advertising something the op does not honour.

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
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-396-01-tracer-'))
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
  // the tracer tool was `agent_qa_list_proposals`, which left the catalogue
  // with the proposal round. The same claims are carried over the knowledge inspect read, a 1:1
  // read tool with an object-rooted output contract.
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
    const client = new Client({ name: 'agent-qa-396-tracer', version: '0.0.0' })

    try {
      await client.connect(transport)

      const listed = await client.listTools()
      const tool = listed.tools.find((entry) => entry.name === 'agent_qa_inspect_knowledge_records')
      expect(tool, `tools/list carried: ${listed.tools.map((t) => t.name).join(', ')}`).toBeDefined()

      // The annotation is DERIVED from the op — `knowledge.records.inspect` declares `readOnly` and asks for
      // nothing beyond `read` — so this asserts the derivation reached the wire, not a literal.
      expect(tool!.annotations?.readOnlyHint).toBe(true)

      // D-16's advertised half: a real object-typed output schema, converted by the SDK from the
      // op's own zod contract. `records` is the contract's own property name.
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

      // D-16's enforced half, and the whole point of the cell: the result parses under the op's own
      // output contract. An empty store is a RESULT — a project with no records reads exactly like
      // one that has never learned anything, because those are the same fact.
      const parsed = KnowledgeRecordsInspectOutputSchema.parse(called.structuredContent)
      expect(parsed.records).toEqual([])
    } finally {
      await client.close().catch(() => {})
      await handler.close().catch(() => {})
      await host.close().catch(() => {})
    }
  })

  // The SAME catalog over a REAL loopback socket. It exists because plan 07's conformance job
  // cannot spawn a stdio command — `conformance server` takes a URL — so the shipped artifact it
  // points at is this handler, and a handler nothing has ever driven is not an artifact anybody
  // should point a conformance suite at. It also pins the prohibition the deleted v1 bridge
  // violated: no wildcard CORS header reaches the wire from this surface.
  it('serves the same catalog over a real loopback socket, with no wildcard CORS header', async () => {
    const where = workspace()
    const host = composeCliLocalAgent({
      agentQaRoot: where.agentQaRoot,
      configPath: where.configPath,
    })
    // the handler takes a per-request deps RESOLVER, because the HTTP face varies by
    // caller. A host with one fixed caller passes the degenerate resolver.
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

    const client = new Client({ name: 'agent-qa-396-tracer-http', version: '0.0.0' })
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
