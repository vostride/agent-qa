// One completed run read through every door that exists; each door composes its own host over it.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { composeDashboardAgentHost } from '../../commands/dashboard.js'
import { createRunServiceRoutes, type RunServicePorts } from '@vostride/agent-qa-dashboard'
import {
  AGENT_QA_OP_CONTRACTS,
  AGENT_QA_TOOL_PROJECTIONS,
  withoutLegacyResultWrap,
} from '@vostride/agent-qa-mcp'
import { RunsOverviewInputSchema } from '@vostride/agent-qa-schema'
import { Command, CommanderError } from 'commander'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { createFnCommand } from '../../commands/fn.js'
import { createKnowledgeCommand } from '../../commands/knowledge.js'
import { composeMcpMasking, createMcpHttpRequestListener } from '../../commands/mcp.js'
import { createRunsCommand } from '../../commands/runs.js'
import { composeCliLocalAgent } from '../../composition/local-agent-host.js'
import {
  chatSurfaceAdapter,
  fnSurfaceAdapter,
  mcpSurfaceAdapter,
  registryDeclarations,
  RUN_SERVICE_ROUTE_BINDINGS,
  runServiceSurfaceAdapter,
} from './adapters.js'
import { discoveryRunFixtureProject, type DiscoveryRunFixture } from './populated-run-fixture.js'
import { OP_INPUT_CONTRACTS, scenarioRowFor } from './scenario-table.js'
import { driveChatLines } from './surface-dispatch.js'

// The overview, the discovery reads and the list every map starts from.
const DISCOVERY_OPS = [
  'knowledge.brief.why',
  'knowledge.bundles.list',
  'knowledge.record.show',
  'knowledge.records.diff',
  'knowledge.records.inspect',
  'runs.artifact',
  'runs.evidence',
  'runs.knowledge',
  'runs.list',
  'runs.overview',
] as const

const READER_TOKEN = 'zz-discovery-reader-7d02c4'

function toolFor(opId: string) {
  return AGENT_QA_TOOL_PROJECTIONS.find((projection) => projection.ops.includes(opId))
}

function mcpArgumentsFor(opId: string, input: Record<string, unknown>): Record<string, unknown> {
  const discriminant = toolFor(opId)?.discriminant
  return discriminant === undefined ? input : { [discriminant]: opId, ...input }
}

// ---- Doors ------------------------------------------------------------------------------------------

interface Invocation {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

function allCommands(command: Command): Command[] {
  return [command, ...command.commands.flatMap(allCommands)]
}

async function cli(configPath: string, args: readonly string[]): Promise<Invocation> {
  const stdout: string[] = []
  const stderr: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
    stdout.push(values.map(String).join(' '))
  })
  const error = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
    stderr.push(values.map(String).join(' '))
  })
  const previousExitCode = process.exitCode
  process.exitCode = undefined
  const program = new Command()
    .option('--config <path>', 'config file path')
    .addCommand(createFnCommand())
    .addCommand(createRunsCommand())
    .addCommand(createKnowledgeCommand())
  for (const command of allCommands(program)) {
    command.exitOverride().configureOutput({
      writeOut: (text) => { stdout.push(text) },
      writeErr: (text) => { stderr.push(text) },
    })
  }
  let exitCode: number
  try {
    await program.parseAsync(['node', 'agent-qa', '--config', configPath, ...args])
    exitCode = Number(process.exitCode ?? 0)
  } catch (thrown) {
    if (!(thrown instanceof CommanderError)) throw thrown
    exitCode = thrown.exitCode
  } finally {
    log.mockRestore()
    error.mockRestore()
    process.exitCode = previousExitCode
  }
  return { stdout: stdout.join('\n'), stderr: stderr.join('\n'), exitCode }
}

function jsonOf(invocation: Invocation): unknown {
  expect(invocation.exitCode, invocation.stderr).toBe(0)
  return JSON.parse(invocation.stdout) as unknown
}

async function viaFn(p: DiscoveryRunFixture, opId: string, input: unknown): Promise<unknown> {
  return jsonOf(await cli(p.configPath, ['fn', opId, '--input', JSON.stringify(input), '--json']))
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((listening, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', listening)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server bound no port')
  return address.port
}

interface McpAnswer {
  readonly structured: unknown
  readonly images: readonly { data: string; mimeType: string }[]
}

interface McpDoor {
  call(opId: string, input: Record<string, unknown>): Promise<McpAnswer>
  close(): Promise<void>
}

// The shipped `agent-qa mcp` HTTP listener; the client's legacy bearer is read by nothing.
async function openMcpDoor(p: DiscoveryRunFixture): Promise<McpDoor> {
  const composed = composeCliLocalAgent({ configPath: p.configPath, agentQaRoot: p.agentQaRoot })
  const masking = composeMcpMasking({ configPath: p.configPath })
  const server = createServer(createMcpHttpRequestListener({
    registry: composed.registry, maskText: (text) => masking.mask(text),
  }))
  const port = await listen(server)
  const client = new Client({ name: 'agent-qa', version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${String(port)}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${READER_TOKEN}` } },
  }))
  const outputSchemas = new Map(
    (await client.listTools()).tools.map((tool) => [tool.name, tool.outputSchema as unknown]),
  )
  return {
    async call(opId, input) {
      const tool = toolFor(opId)
      expect(tool, `${opId} has no MCP tool`).toBeDefined()
      const result = await client.callTool({ name: tool!.name, arguments: mcpArgumentsFor(opId, input) }) as {
        content: { type: string; text?: string; data?: string; mimeType?: string }[]
        structuredContent?: unknown
        isError?: boolean
      }
      const text = result.content.map((block) => block.text ?? '').join('\n')
      expect(result.isError ?? false, `${tool!.name}: ${text.slice(0, 400)}`).toBe(false)
      const advertised = outputSchemas.get(tool!.name)
      const wrapped = withoutLegacyResultWrap(advertised) !== advertised
      const structured = wrapped ? (result.structuredContent as { result: unknown }).result : result.structuredContent
      const images = result.content
        .filter((block) => block.type === 'image')
        .map((block) => ({ data: String(block.data), mimeType: String(block.mimeType) }))
      return { structured, images }
    },
    async close() {
      await client.close().catch(() => undefined)
      await new Promise<void>((closed) => server.close(() => closed()))
      composed.close()
    },
  }
}

interface RunServiceDoor {
  get(path: string): Promise<{ status: number; bytes: Buffer; json: unknown }>
  close(): Promise<void>
}

// The run-service router over the project's own composition, as the dashboard mounts it, tokenless.
async function openRunServiceDoor(p: DiscoveryRunFixture): Promise<RunServiceDoor> {
  const composed = composeCliLocalAgent({ configPath: p.configPath, agentQaRoot: p.agentQaRoot })
  const agentHost = composeDashboardAgentHost(composed)
  const server = createServer(createRunServiceRoutes({ agentHost } as unknown as RunServicePorts))
  const port = await listen(server)
  return {
    async get(path) {
      const response = await fetch(`http://127.0.0.1:${String(port)}/run${path}`)
      const bytes = Buffer.from(await response.arrayBuffer())
      let json: unknown
      try { json = JSON.parse(bytes.toString('utf8')) } catch { json = undefined }
      return { status: response.status, bytes, json }
    },
    async close() {
      await new Promise<void>((closed) => server.close(() => closed()))
      await composed.close()
    },
  }
}

// ---- The populated scenarios ------------------------------------------------------------------------

interface DiscoveryScenario {
  readonly name: string
  readonly opId: (typeof DISCOVERY_OPS)[number]
  input(p: DiscoveryRunFixture): Record<string, unknown>
  /** What makes the answer a meaningful populated read rather than an empty or refused one. */
  meaningful(result: unknown, p: DiscoveryRunFixture): void
}

const SCENARIOS: readonly DiscoveryScenario[] = [
  {
    name: 'runs.list names the populated run and its two members',
    opId: 'runs.list',
    input: () => ({}),
    meaningful(result, p) {
      expect(result).toMatchObject([{ runId: p.runId, tests: [{ testId: p.firstTestId }, { testId: p.secondTestId }] }])
    },
  },
  {
    name: 'runs.overview maps both members, the screenshot, the recording and the served record',
    opId: 'runs.overview',
    input: (p) => ({ runId: p.runId }),
    meaningful(result, p) {
      expect(result).toMatchObject({
        runId: p.runId,
        tests: [
          { testIndex: 0, testId: p.firstTestId,
            recording: { state: 'present', address: { runId: p.runId, sha: p.recordingSha } },
            steps: [{ stepIndex: 0, capture: { state: 'recorded', screenshots: [{ sha: p.screenshotSha }] } }] },
          { testIndex: 1, testId: p.secondTestId },
        ],
      })
      expect(JSON.stringify(result)).toContain(p.recordId)
    },
  },
  {
    name: 'runs.knowledge answers the ready projection for both members',
    opId: 'runs.knowledge',
    input: (p) => ({ runId: p.runId }),
    meaningful(result, p) {
      expect(result).toMatchObject({ kind: 'ready', runId: p.runId })
      expect((result as { steps: unknown[] }).steps).toHaveLength(2)
    },
  },
  {
    name: 'runs.evidence reads the console document',
    opId: 'runs.evidence',
    input: (p) => ({ runId: p.runId, testIndex: 0, stepIndex: 0, kind: 'console' }),
    meaningful(result) {
      expect(result).toMatchObject({ outcome: 'ready', evidence: { kind: 'console', state: 'present' },
        document: { kind: 'console', records: [{ level: 'error' }, { level: 'warning' }] } })
    },
  },
  {
    name: 'runs.evidence reads the sub-action ARIA document',
    opId: 'runs.evidence',
    input: (p) => ({ runId: p.runId, testIndex: 0, stepIndex: 0, subActionIndex: 0, kind: 'aria' }),
    meaningful(result) {
      expect(result).toMatchObject({ outcome: 'ready', document: { kind: 'aria', tree: '- button "Payer ✓"' } })
    },
  },
  {
    name: 'runs.artifact reads the screenshot bytes',
    opId: 'runs.artifact',
    input: (p) => ({ runId: p.runId, sha: p.screenshotSha }),
    meaningful(result, p) {
      expect(result).toMatchObject({ runId: p.runId, sha: p.screenshotSha, contentType: 'image/png' })
      expect((result as { byteLength: number }).byteLength).toBeGreaterThan(0)
    },
  },
  {
    name: 'knowledge.bundles.list lists the published bundle',
    opId: 'knowledge.bundles.list',
    input: () => ({}),
    meaningful(result) {
      expect(Array.isArray(result) && result.length > 0, JSON.stringify(result).slice(0, 200)).toBe(true)
    },
  },
  {
    name: 'knowledge.records.inspect lists the served record',
    opId: 'knowledge.records.inspect',
    input: () => ({ filter: {} }),
    meaningful(result, p) {
      expect(JSON.stringify((result as { records: unknown }).records)).toContain(p.recordId)
    },
  },
  {
    name: 'knowledge.records.diff answers the first-ever diff',
    opId: 'knowledge.records.diff',
    input: () => ({ sinceOrdinal: 0 }),
    meaningful(result, p) {
      expect(result).toMatchObject({ sinceOrdinal: 0 })
      expect(JSON.stringify((result as { changes: unknown }).changes)).toContain(p.recordId)
    },
  },
  {
    name: 'knowledge.record.show finds the served record',
    opId: 'knowledge.record.show',
    input: (p) => ({ recordId: p.recordId }),
    meaningful(result, p) {
      expect(result).toMatchObject({ kind: 'found', record: { recordId: p.recordId } })
    },
  },
  {
    name: 'knowledge.brief.why answers the first member\'s served brief',
    opId: 'knowledge.brief.why',
    input: (p) => ({ runId: p.runId, stepIndex: 0, testId: p.firstTestId }),
    meaningful(result, p) {
      expect(result).toMatchObject({ kind: 'answered', trace: { servedLines: [{ recordId: p.recordId, leg: 'lexical' }] } })
    },
  },
]

describe('DISCOVERY-FOUR-DOOR: the discovery reads on the four rostered doors', () => {
  let p: DiscoveryRunFixture
  let mcp: McpDoor
  let service: RunServiceDoor
  const answers = new Map<string, unknown>()
  let chatResults: readonly { functionId: string; payload: unknown }[] = []
  let chatStdout = ''

  beforeAll(async () => {
    p = await discoveryRunFixtureProject()
    mcp = await openMcpDoor(p)
    service = await openRunServiceDoor(p)
    for (const scenario of SCENARIOS) answers.set(scenario.name, await viaFn(p, scenario.opId, scenario.input(p)))
    // One session, one clause per scenario, so each result is read back by its clause's position.
    const chat = await driveChatLines(
      SCENARIOS.map((scenario) => `/fn ${scenario.opId} ${JSON.stringify(scenario.input(p))}`), undefined, p)
    chatResults = chat.results
    chatStdout = chat.stdout
  }, 120_000)

  afterAll(async () => {
    await mcp?.close()
    await service?.close()
    p?.close()
  })

  it('pairs every discovery op with the input singleton its declaration and MCP contract use', () => {
    expect(OP_INPUT_CONTRACTS['runs.overview']).toBe(RunsOverviewInputSchema)
    const declarations = registryDeclarations()
    for (const opId of DISCOVERY_OPS) {
      const contract = (OP_INPUT_CONTRACTS as Record<string, unknown>)[opId]
      expect(contract, `${opId} has no OP_INPUT_CONTRACTS entry`).toBeDefined()
      expect(AGENT_QA_OP_CONTRACTS[opId]?.input, opId).toBe(contract)
      const declaration = declarations.find((entry) => entry.id === opId)
      expect(declaration, `${opId} is not declared`).toBeDefined()
      expect(declaration!.risk.readOnly, opId).toBe(true)
      const row = scenarioRowFor(opId)
      expect(row, `${opId} has no scenario row`).toBeDefined()
      expect(row!.perSurface, opId).toEqual({
        chat: { reachable: true }, mcp: { reachable: { tool: toolFor(opId)!.name } }, fn: { reachable: true },
      })
      expect((contract as { safeParse(value: unknown): { success: boolean } }).safeParse(row!.input).success, opId).toBe(true)
    }
  })

  it('reaches every discovery op on chat, mcp and fn; the run service reaches its routed reads and declares the rest', async () => {
    for (const adapter of [chatSurfaceAdapter, mcpSurfaceAdapter, fnSurfaceAdapter]) {
      const reach = await adapter.enumerateOpIds()
      expect(reach.strays, adapter.id).toEqual([])
      for (const opId of DISCOVERY_OPS) expect(reach.opIds.has(opId), `${adapter.id} reaches ${opId}`).toBe(true)
    }
    const routed = new Set(RUN_SERVICE_ROUTE_BINDINGS.flatMap((binding) => ('opId' in binding ? [binding.opId] : [])))
    expect(DISCOVERY_OPS.filter((opId) => routed.has(opId))).toEqual(['runs.artifact', 'runs.evidence'])
    const declaredOut = runServiceSurfaceAdapter.notApplicable.find((entry) => entry.capability.startsWith('every OTHER read op'))
    expect(declaredOut, 'the run service no longer declares the reads it has no route for').toBeDefined()
  }, 120_000)

  it('answers every scenario clause on the chat door, in order', () => {
    expect(chatResults.map((entry) => entry.functionId), chatStdout.slice(-600))
      .toEqual(SCENARIOS.map((scenario) => scenario.opId))
  })

  SCENARIOS.forEach((scenario, position) => {
    it(`${scenario.name}: fn, MCP and chat agree on the populated answer`, async () => {
      const input = scenario.input(p)
      const fnAnswer = answers.get(scenario.name)
      scenario.meaningful(fnAnswer, p)

      const viaMcp = await mcp.call(scenario.opId, input)
      expect(viaMcp.structured).toEqual(fnAnswer)
      if (scenario.opId === 'runs.artifact') {
        expect(viaMcp.images).toEqual([{ data: (fnAnswer as { bytesBase64: string }).bytesBase64, mimeType: 'image/png' }])
      }

      expect(chatResults[position]?.functionId).toBe(scenario.opId)
      expect(chatResults[position]?.payload).toEqual(fnAnswer)
    }, 120_000)
  })

  it('runs.evidence and runs.artifact answer the same populated reads on the run service', async () => {
    for (const scenario of SCENARIOS.filter((entry) => entry.opId === 'runs.evidence')) {
      const input = scenario.input(p)
      const query = new URLSearchParams(Object.fromEntries(
        Object.entries(input).filter(([key]) => key !== 'runId').map(([key, value]) => [key, String(value)])))
      const answered = await service.get(`/${p.runId}/evidence?${query.toString()}`)
      expect(answered.status, answered.bytes.toString('utf8').slice(0, 300)).toBe(200)
      expect(answered.json).toEqual(answers.get(scenario.name))
    }
    const artifact = SCENARIOS.find((entry) => entry.opId === 'runs.artifact')!
    const bytes = await service.get(`/${p.runId}/artifacts/${p.screenshotSha}`)
    expect(bytes.status).toBe(200)
    expect(bytes.bytes.toString('base64')).toBe((answers.get(artifact.name) as { bytesBase64: string }).bytesBase64)
  }, 120_000)
})

describe('DEDICATED-CLI-PARITY: the six dedicated verbs are sugar over their ops', () => {
  let p: DiscoveryRunFixture
  let mcp: McpDoor

  beforeAll(async () => {
    p = await discoveryRunFixtureProject()
    mcp = await openMcpDoor(p)
  }, 120_000)

  afterAll(async () => {
    await mcp?.close()
    p?.close()
  })

  const JSON_VERBS: readonly {
    verb: string
    args(p: DiscoveryRunFixture): string[]
    opId: (typeof DISCOVERY_OPS)[number]
    input(p: DiscoveryRunFixture): Record<string, unknown>
  }[] = [
    { verb: 'runs list', args: () => ['runs', 'list', '--json'], opId: 'runs.list', input: () => ({}) },
    { verb: 'runs overview', args: (f) => ['runs', 'overview', f.runId, '--json'], opId: 'runs.overview', input: (f) => ({ runId: f.runId }) },
    { verb: 'runs knowledge', args: (f) => ['runs', 'knowledge', f.runId, '--json'], opId: 'runs.knowledge', input: (f) => ({ runId: f.runId }) },
    {
      verb: 'runs evidence',
      args: (f) => ['runs', 'evidence', f.runId, '--test', '0', '--step', '0', '--kind', 'network', '--json'],
      opId: 'runs.evidence',
      input: (f) => ({ runId: f.runId, testIndex: 0, stepIndex: 0, kind: 'network' }),
    },
    { verb: 'knowledge show', args: (f) => ['knowledge', 'show', f.recordId, '--json'], opId: 'knowledge.record.show', input: (f) => ({ recordId: f.recordId }) },
    {
      verb: 'knowledge brief-why',
      args: (f) => ['knowledge', 'brief-why', f.runId, '--step', '0', '--test', f.secondTestId, '--json'],
      opId: 'knowledge.brief.why',
      input: (f) => ({ runId: f.runId, stepIndex: 0, testId: f.secondTestId }),
    },
  ]

  for (const entry of JSON_VERBS) {
    it(`agent-qa ${entry.verb} --json equals its MCP tool and its fn door`, async () => {
      const printed = jsonOf(await cli(p.configPath, entry.args(p)))
      const input = entry.input(p)
      expect(printed).toEqual((await mcp.call(entry.opId, input)).structured)
      expect(printed).toEqual(await viaFn(p, entry.opId, input))
    }, 120_000)
  }

  it('agent-qa runs evidence --screenshot writes the bytes fn and MCP answer for runs.artifact', async () => {
    const out = mkdtempSync(join(tmpdir(), 'agent-qa-export-'))
    try {
      const target = join(out, 'shot.png')
      const exported = await cli(p.configPath, ['runs', 'evidence', p.runId, '--screenshot', p.screenshotSha, '--out', target])
      expect(exported.exitCode, exported.stderr).toBe(0)
      const input = { runId: p.runId, sha: p.screenshotSha }
      const fnAnswer = await viaFn(p, 'runs.artifact', input) as { bytesBase64: string }
      expect(readFileSync(target).toString('base64')).toBe(fnAnswer.bytesBase64)
      expect((await mcp.call('runs.artifact', input)).structured).toEqual(fnAnswer)
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  }, 120_000)

  it('KNOWLEDGE-LIST-JSON: agent-qa knowledge inspect and diff --json print the records and changes of their MCP answers', async () => {
    const records = jsonOf(await cli(p.configPath, ['knowledge', 'inspect', '--json']))
    const inspected = (await mcp.call('knowledge.records.inspect', { filter: {} })).structured as { records: unknown[] }
    expect(records).toEqual(inspected.records)
    expect(inspected.records.length).toBeGreaterThan(0)
    expect(JSON.stringify(records)).toContain(p.recordId)

    const changes = jsonOf(await cli(p.configPath, ['knowledge', 'diff', '0', '--json']))
    const diffed = (await mcp.call('knowledge.records.diff', { sinceOrdinal: 0 })).structured as { changes: unknown[] }
    expect(changes).toEqual(diffed.changes)
    expect(diffed.changes.length).toBeGreaterThan(0)
    expect(JSON.stringify(changes)).toContain(p.recordId)
  }, 120_000)
})
