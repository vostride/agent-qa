// actual HTTP MCP listener, catalog and invokeFunction over durable mark fixtures.
// No provider calls. The mark runs local-headless. 2026-10-01: `safety.trustMode`
// is deleted from the config schema, so the former trustMode FALSE/TRUE variants are one case.
// the listing no longer hides the mark tool and the function layer reads
// no scope, so every caller lists every tool and reaches every op.
// RE-SPELLED to tokenless parity. The bearer rung, the declared
// MCP tokens, `credentialForBearer` and the mark handler's credential refusal are deleted, so a
// caller with no `Authorization` header lists and lands a mark directly, and a legacy bearer header
// changes nothing. What the listener still refuses — before any server is built and before any
// body takes effect — is a Host that is not a localhost form and a present
// Origin that is not a localhost form.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { AgentQaConfigSchema } from '@vostride/agent-qa-core'
import { invokeFunction } from '@vostride/agent-qa-agent'
import { KnowledgeGatesListResultSchema, RunsMarkOutcomeSchema } from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it } from 'vitest'

import {
  composeMcpMasking,
  createMcpHttpRequestListener,
  MCP_FUNCTION_CALLER,
  type McpHttpRefusal,
} from '../commands/mcp.js'
import { composeCliLocalAgent } from '../composition/local-agent-host.js'
import { markFixture } from '../gates/__tests__/feedback-fixture.js'

/** A bearer value a pre-432 client might still send. The listener must neither need nor read it. */
const LEGACY_BEARER = 'zz-419-legacy-bearer-value-64bea7'
const MARK_TOOL = 'agent_qa_mark_run'
const GATES_TOOL = 'agent_qa_list_knowledge_gates'
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})

async function harness() {
  const fixture = markFixture()
  cleanups.push(async () => { rmSync(fixture.root, { recursive: true, force: true }) })
  const config = AgentQaConfigSchema.parse({
    workspace: {
      testMatch: ['tests/**/*.yaml'], suiteMatch: ['suites/**/*.suite.yaml'],
      hooksFile: 'hooks.yaml', envFile: '.env', secretsFile: '.env.secrets.local',
    },
    use: { mobile: { appState: 'preserve' } },
  })
  writeFileSync(fixture.configPath, JSON.stringify(config))
  // the MCP masker reads this project's declared secrets.
  writeFileSync(join(fixture.root, '.env.secrets.local'), '')
  const host = composeCliLocalAgent({
    agentQaRoot: fixture.agentQaRoot, configPath: fixture.configPath,
    resolveExecutionContext: () => 'local-headless',
  })
  cleanups.push(() => host.close())
  const mask = composeMcpMasking({ configPath: fixture.configPath })
  const refusals: McpHttpRefusal[] = []
  const server: Server = createServer(createMcpHttpRequestListener({
    registry: host.registry, maskText: text => mask.mask(text),
    onRefusal: refusal => { refusals.push(refusal) },
  }))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing bound address')
  const port = address.port
  const url = new URL(`http://127.0.0.1:${port}/mcp`)
  const frames: string[] = []
  async function connect(extraHeaders: Record<string, string> = {}) {
    const client = new Client({ name: 'agent-qa-419-mark', version: '0.0.0' })
    cleanups.push(() => client.close())
    await client.connect(new StreamableHTTPClientTransport(url, {
      fetch: (async (input: URL | string, init?: RequestInit) => {
        const headers = new Headers(init?.headers)
        for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value)
        const response = await fetch(input, { ...init, headers })
        frames.push(await response.clone().text())
        return response
      }) as typeof fetch,
    }))
    return client
  }
  const ledger = join(fixture.runDir, 'marks.jsonl')
  const ledgerBytes = () => existsSync(ledger) ? readFileSync(ledger, 'utf8') : ''
  const markArgs = { runId: fixture.handoff.runId, kind: 'confirmed-bug' }
  const list = async (client: Client) => (await client.listTools()).tools.map(tool => tool.name)
  const mark = (client: Client) => client.callTool({ name: MARK_TOOL, arguments: markArgs })
  /**
   * A raw JSON-RPC `tools/call` for the mark, over `node:http` so the `Host` header is exactly the
   * one a test names (the platform `fetch` will not send a chosen `Host`).
   */
  function rawMark(headers: { readonly host: string; readonly origin?: string }): Promise<{ status: number; body: string }> {
    const body = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: MARK_TOOL, arguments: markArgs },
    })
    return new Promise((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1', port, path: '/mcp', method: 'POST',
        headers: {
          host: headers.host,
          ...(headers.origin === undefined ? {} : { origin: headers.origin }),
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'content-length': Buffer.byteLength(body),
        },
      }, (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => { text += chunk })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }))
      })
      req.on('error', reject)
      req.end(body)
    })
  }
  return { fixture, connect, frames, list, mark, rawMark, refusals, ledgerBytes, registry: host.registry, port }
}

describe('MCP sovereign mark bearer differential', () => {
  // RE-SPELLED 2026-10-01 from 'anonymous/reader list the mark tool and its handler
  // refuses them when trustMode=%s'. The handler's credential refusal is deleted: a tokenless
  // caller lists the mark tool and lands the mark in the call. 432-22: the trustMode variants are
  // one case, because the key that varied them is deleted.
  it('a tokenless caller lists and lands a mark', async () => {
    const h = await harness()
    const tokenless = await h.connect()
    const names = await h.list(tokenless)
    expect(names).toContain(MARK_TOOL)
    expect(names).toContain('agent_qa_change_knowledge')
    expect(names).toContain(GATES_TOOL)
    const result = await h.mark(tokenless)
    expect(result.isError).not.toBe(true)
    const outcome = RunsMarkOutcomeSchema.parse(result.structuredContent)
    if (outcome.kind !== 'marked') throw new Error(`the tokenless mark did not persist: ${outcome.kind}`)
    expect(outcome.receipt).toMatchObject({ origin: 'user', kind: 'confirmed-bug', ordinal: 1 })
    expect(h.ledgerBytes().trim().split('\n').map(line => JSON.parse(line))).toEqual([outcome.receipt])
    const wire = h.frames.join('\n')
    expect(wire).not.toContain('credential-required')
    expect(wire).not.toMatch(/present a bearer|--trust-session/u)
    const gates = await tokenless.callTool({ name: GATES_TOOL, arguments: { recordId: h.fixture.published.id } })
    expect(KnowledgeGatesListResultSchema.parse(gates.structuredContent).kind).toBe('found')
    expect(h.refusals).toEqual([])
  })

  // RE-SPELLED 2026-10-01 from 'declared writer marks headlessly without trustMode;
  // authority never carries to later or concurrent anonymous requests'. There is no authority to
  // carry: a client sending a legacy bearer and a client sending none are the same caller, their
  // concurrent listings are identical, and two concurrent marks of one address land one receipt.
  it('concurrent tokenless requests share no credential authority, and a legacy bearer changes nothing', async () => {
    const h = await harness()
    const legacy = await h.connect({ authorization: `Bearer ${LEGACY_BEARER}` })
    const tokenless = await h.connect()
    const lists = await Promise.all(Array.from({ length: 8 }, (_, index) => h.list(index % 2 ? legacy : tokenless)))
    lists.forEach((names) => expect(names).toEqual(lists[0]))
    expect(lists[0]).toContain(MARK_TOOL)

    const [first, second] = await Promise.all([h.mark(legacy), h.mark(tokenless)])
    const kinds = [first, second].map(result => RunsMarkOutcomeSchema.parse(result.structuredContent).kind).sort()
    // The ledger serializes the two; the second is the identical repeat of the first.
    expect(kinds).toEqual(['already-marked', 'marked'])
    expect(h.ledgerBytes().trim().split('\n')).toHaveLength(1)
    // Nothing a caller sent rides back on any frame.
    expect(h.frames.join('\n')).not.toContain(LEGACY_BEARER)
    expect(h.refusals).toEqual([])
  })

  // RE-SPELLED 2026-10-01 from 'a knowledge-write-only credential lists and reaches
  // every tool, scopes gating nothing'. No credential exists; the one tokenless caller lists and
  // reaches every tool, and the function layer reads no field of it.
  it('the tokenless caller lists and reaches every tool, nothing gating it', async () => {
    const h = await harness()
    const client = await h.connect()
    const names = await h.list(client)
    for (const name of [MARK_TOOL, 'agent_qa_change_config', 'agent_qa_write_test', 'agent_qa_start_run']) {
      expect(names).toContain(name)
    }
    expect((await h.mark(client)).structuredContent).toMatchObject({ kind: 'marked' })
    const written = h.ledgerBytes()
    await client.callTool({ name: 'agent_qa_change_config', arguments: {
      action: 'config.field.set', path: 'use.timeout.step', value: '45s',
    } }).catch(() => undefined)
    expect(h.frames.at(-1)).not.toContain('not found')
    // Bypass listing: the caller every request runs as carries no scope set, flag or credential.
    expect(Object.keys(MCP_FUNCTION_CALLER).sort()).toEqual(['origin', 'surface'])
    const served = await invokeFunction(h.registry, 'config.field.set', {
      path: 'use.timeout.step', value: '45s',
    }, MCP_FUNCTION_CALLER).then(() => 'served', (error: unknown) => (error as Error).name)
    expect(served).not.toBe('FunctionScopeError')
    expect(h.ledgerBytes()).toBe(written)
  })
})

// the two guards the listener keeps, each measured alone with the other one passing,
// and each before any body takes effect: a refused mark writes nothing to the ledger.
describe('the MCP HTTP listener keeps its Host and Origin guards', () => {
  it('a non-localhost Host is refused before any server is built, with a localhost Origin', async () => {
    const h = await harness()
    const before = h.ledgerBytes()
    const refused = await h.rawMark({ host: 'evil.example', origin: `http://127.0.0.1:${h.port}` })
    expect(refused.status).toBe(403)
    expect(JSON.parse(refused.body)).toEqual({ error: 'forbidden_host' })
    expect(h.refusals).toEqual(['host'])
    expect(h.ledgerBytes()).toBe(before)
    // Positive control: the same request with a localhost Host passes the guard.
    const admitted = await h.rawMark({ host: `127.0.0.1:${h.port}`, origin: `http://127.0.0.1:${h.port}` })
    expect(admitted.status).not.toBe(403)
    expect(h.refusals).toEqual(['host'])
  })

  it('a non-localhost Origin is refused before any server is built, with a localhost Host', async () => {
    const h = await harness()
    const before = h.ledgerBytes()
    const refused = await h.rawMark({ host: `127.0.0.1:${h.port}`, origin: 'https://evil.example' })
    expect(refused.status).toBe(403)
    expect(JSON.parse(refused.body)).toEqual({ error: 'forbidden_origin' })
    expect(h.refusals).toEqual(['origin'])
    expect(h.ledgerBytes()).toBe(before)
    // An absent Origin — the non-browser MCP client — is admitted, and so is a localhost one.
    for (const origin of [undefined, `http://localhost:${h.port}`]) {
      const admitted = await h.rawMark({ host: `localhost:${h.port}`, ...(origin === undefined ? {} : { origin }) })
      expect(admitted.status, String(origin)).not.toBe(403)
    }
    expect(h.refusals).toEqual(['origin'])
  })

  it('a legacy bearer opens neither guard, and the refusal echoes nothing sent', async () => {
    const h = await harness()
    const before = h.ledgerBytes()
    await expect(h.connect({ authorization: `Bearer ${LEGACY_BEARER}`, origin: 'https://evil.example' }))
      .rejects.toThrow()
    expect(h.refusals).toContain('origin')
    expect(h.frames.join('\n')).toContain('forbidden_origin')
    expect(h.frames.join('\n')).not.toContain(LEGACY_BEARER)
    expect(h.frames.join('\n')).not.toContain('evil.example')
    expect(h.ledgerBytes()).toBe(before)
  })
})
