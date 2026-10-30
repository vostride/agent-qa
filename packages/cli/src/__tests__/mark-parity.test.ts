// Each shipped door marks a byte-identical scratch run with its own ledger, and none asks.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { invokeFunction, RUNS_MARK_FUNCTION_ID } from '@vostride/agent-qa-agent'
import { AgentQaConfigSchema, resolveWorkspacePaths } from '@vostride/agent-qa-core'
import { DashboardDatabase, startServer } from '@vostride/agent-qa-dashboard'
import { slugBranch } from '@vostride/agent-qa-runner-local'
import { MarkReceiptSchema, RunsMarkOutcomeSchema, type MarkReceipt } from '@vostride/agent-qa-schema'
import { Command } from 'commander'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { composeDashboardDoor } from '../commands/dashboard.js'
import { composeMcpMasking, createMcpHttpRequestListener } from '../commands/mcp.js'
import { createRunsCommand } from '../commands/runs.js'
import * as host from '../composition/local-agent-host.js'
import { markFixture } from '../gates/__tests__/feedback-fixture.js'

export const MARK_RECEIPT_EQUIVALENCE_KEYS = [
  'runId', 'testIndex', 'stepIndex', 'kind', 'origin',
] as const

/** Receipts agree modulo markId, ordinal, markedAt and the surface's response wrapper. */
function equivalenceOf(receipt: MarkReceipt) {
  return {
    ...Object.fromEntries(MARK_RECEIPT_EQUIVALENCE_KEYS.map(key => [key, receipt[key]])),
    disposition: receipt.disposition.kind,
    evidence: receipt.evidence,
  }
}

const closers: Array<() => void | Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  process.exitCode = 0
  for (const close of closers.splice(0).reverse()) await close()
})

function scratch(template: ReturnType<typeof markFixture>) {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-mark-parity-'))
  closers.push(() => rmSync(root, { recursive: true, force: true }))
  cpSync(template.root, root, { recursive: true })
  const configPath = join(root, 'agent-qa.config.yaml')
  const config = AgentQaConfigSchema.parse(parse(readFileSync(configPath, 'utf8')))
  writeFileSync(configPath, JSON.stringify(config))
  // The MCP masker reads this project's declared secrets.
  writeFileSync(join(root, '.env.secrets.local'), '')
  const agentQaRoot = join(root, '.agent-qa')
  const ledger = join(agentQaRoot, 'runs', slugBranch(template.handoff.runId), 'marks.jsonl')
  expect(existsSync(ledger)).toBe(false)
  return { root, configPath, config, agentQaRoot, ledger }
}
type Scratch = ReturnType<typeof scratch>

// The port records any ask and arrives as an excess field, so no ask is a measurement, not a given.
function terminalConfirmation() {
  let prompt = ''
  return {
    smuggled: {
      confirm: { surface: 'tty-prompt', ask: (action: { name: string }) => { prompt += action.name; return true } },
    } as object,
    prompt: () => prompt,
  }
}

function receiptOf(value: unknown): MarkReceipt {
  const outcome = RunsMarkOutcomeSchema.parse(value)
  expect(outcome.kind).toBe('marked')
  if (outcome.kind !== 'marked') throw new Error('the door did not persist a new mark')
  return outcome.receipt
}

async function mcpDoor(scene: Scratch) {
  // The MCP door is tokenless; one client presents a legacy bearer to show it changes nothing.
  const token = 'agent-qa-parity-fixture-writer'
  writeFileSync(scene.configPath, JSON.stringify(scene.config))
  const composed = host.composeCliLocalAgent({ configPath: scene.configPath, agentQaRoot: scene.agentQaRoot,
    resolveExecutionContext: () => 'local-headless' })
  closers.push(() => composed.close())
  const masking = composeMcpMasking({ configPath: scene.configPath })
  const server = createServer(createMcpHttpRequestListener({ registry: composed.registry,
    maskText: text => masking.mask(text) }))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  closers.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('MCP did not bind')
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`)
  async function connect(authenticated: boolean) {
    const client = new Client({ name: 'agent-qa-mark-parity', version: '0.0.0' })
    closers.push(() => client.close())
    await client.connect(new StreamableHTTPClientTransport(url, {
      fetch: (async (input: URL | string, init?: RequestInit) => {
        const headers = new Headers(init?.headers)
        if (authenticated) headers.set('authorization', `Bearer ${token}`)
        return fetch(input, { ...init, headers })
      }) as typeof fetch,
    }))
    return client
  }
  return { writer: await connect(true), anonymous: await connect(false) }
}

/** The production HTTP door, posted to with no confirmation channel open. */
async function dashboardDoor(scene: Scratch, input: { runId: string; kind: 'false-fail' | 'confirmed-bug' }) {
  const db = new DashboardDatabase({ dbPath: ':memory:' })
  const door = composeDashboardDoor({ ...scene, boundOrigin: () => undefined })
  const server = await startServer({ declaredSecretMask: (text) => text, db, port: 0, configPath: scene.configPath,
    workspacePaths: resolveWorkspacePaths({ config: scene.config, configPath: scene.configPath }),
    agentHost: door.agentHost })
  closers.push(async () => { server.close(); await door.host.close() })
  const address = server.server.address()
  if (!address || typeof address === 'string') throw new Error('dashboard did not bind')
  const origin = `http://127.0.0.1:${address.port}`
  const marked = await fetch(`${origin}/api/runs/${encodeURIComponent(input.runId)}/mark`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: input.kind }),
  })
  expect(marked.status).toBe(200)
  return receiptOf(await marked.json())
}

describe('mark receipt parity across the four sovereign doors', () => {
  it.each(['false-fail', 'confirmed-bug'] as const)('%s receipts agree across fn, CLI, declared MCP and HTTP, none of them asked', async kind => {
    const template = markFixture()
    closers.push(() => rmSync(template.root, { recursive: true, force: true }))
    const scenes = [scratch(template), scratch(template), scratch(template), scratch(template)] as const
    const input = { runId: template.handoff.runId, kind }
    const tty = terminalConfirmation()
    const fnHost = host.composeCliLocalAgent({ configPath: scenes[0].configPath, agentQaRoot: scenes[0].agentQaRoot, ...tty.smuggled,
      resolveExecutionContext: () => 'local-interactive' })
    closers.push(() => fnHost.close())
    const fn = receiptOf(await invokeFunction(fnHost.registry, RUNS_MARK_FUNCTION_ID, input, host.CLI_FUNCTION_CALLER))
    expect(tty.prompt()).toBe('')

    const cliTty = terminalConfirmation()
    const compose = host.composeCliLocalAgent
    const spy = vi.spyOn(host, 'composeCliLocalAgent').mockImplementation(options => compose({ ...options,
      ...cliTty.smuggled, resolveExecutionContext: () => 'local-interactive' }))
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    let cli: MarkReceipt
    try {
      const program = new Command().exitOverride().option('--config <path>').addCommand(createRunsCommand())
      await program.parseAsync(['--config', scenes[1].configPath, 'runs', 'mark', input.runId, '--kind', kind, '--json'], { from: 'user' })
      expect(errors.mock.calls).toEqual([])
      expect(cliTty.prompt()).toBe('')
      cli = receiptOf(JSON.parse(String(output.mock.calls.at(-1)?.[0])))
    } finally { spy.mockRestore(); output.mockRestore(); errors.mockRestore() }

    const mcp = await mcpDoor(scenes[2])
    // The mark tool is served to every caller; a client with a legacy bearer gets the same repeat.
    expect((await mcp.anonymous.listTools()).tools.map(tool => tool.name)).toContain('agent_qa_mark_run')
    expect(existsSync(scenes[2].ledger)).toBe(false)
    const called = await mcp.anonymous.callTool({ name: 'agent_qa_mark_run', arguments: input })
    expect(called.isError).not.toBe(true)
    const bearer = receiptOf(called.structuredContent)
    const repeated = RunsMarkOutcomeSchema.parse((await mcp.writer.callTool({ name: 'agent_qa_mark_run', arguments: input })).structuredContent)
    expect(repeated.kind).toBe('already-marked')
    const api = await dashboardDoor(scenes[3], input)
    const receipts = [fn, cli!, bearer, api]
    for (const [index, receipt] of receipts.entries()) {
      expect(equivalenceOf(receipt)).toEqual(equivalenceOf(fn))
      const lines = readFileSync(scenes[index]!.ledger, 'utf8').trim().split('\n')
      expect(lines).toHaveLength(1)
      const durable = MarkReceiptSchema.parse(JSON.parse(lines[0]!))
      expect(durable).toEqual(receipt)
      expect(durable.origin).toBe('user')
      expect(durable.ordinal).toBe(1)
      expect(durable.evidence.confirmed).toBe(1)
      expect(durable.disposition.kind).toBe(kind === 'false-fail' ? 'applied' : 'confirmed-bug')
    }
  }, 60_000)
})
