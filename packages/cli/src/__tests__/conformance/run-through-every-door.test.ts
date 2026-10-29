// C443-DOOR-MATRIX.
//
// One single-test run through each door, against one project and one runs.db, with real headless
// Chromium and the stub model. The project's target is declared `environment: production`, so every
// door is shown starting a production-declared run like any other. Every door is driven once in
// `beforeAll`, an in-process door with `process.stdin` refusing every read; each cell asserts on
// what was recorded, so a door whose run is missing fails its cells and never skips.

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import type { ConfigReaderPort, JobModelCapability } from '@vostride/agent-qa-agent'
import { resolveRunOwnerHost } from '@vostride/agent-qa-dashboard'
import { chromium } from 'playwright-core'
import type { Browser } from 'playwright-core'
import { Command } from 'commander'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { createAskCommand } from '../../commands/ask.js'
import { mountCoHostedMcp } from '../../commands/dashboard.js'
import { createFnCommand } from '../../commands/fn.js'
import { composeMcpMasking, createMcpHttpRequestListener } from '../../commands/mcp.js'
import { invokeViaDaemon } from '../../daemon/client.js'
import { runDaemonHost } from '../../daemon/host.js'
import type { DaemonHostOperations } from '../../daemon/host.js'
import {
  openDashboardScene,
  printedRunIds,
  refuseWithoutRecordingTools,
  runStoreEvents,
  spawnCliRun,
  type DashboardScene,
} from './run-doors-fixture.js'
import {
  POPULATED_FAILURE_STEP_MARKER,
  POPULATED_FAILURE_STEP_TEXT,
  POPULATED_SECOND_TEST_PATH,
  POPULATED_TARGET_NAME,
  POPULATED_TEST_PATH,
  populatedRunFixtureProject,
  populatedRunSpawnEnv,
  startStubModelServer,
  startTargetPageServer,
  type FixtureServer,
  type PopulatedRunProject,
  type StubModelServer,
} from './populated-run-fixture.js'
import {
  CLI_ENTRY,
  cleanupTempRoots,
  hermeticEnv,
  reserveEphemeralPort,
  spawnDashboard,
  type SpawnedDashboard,
} from './spawned-chat.js'
import { driveChatLines, genericFnClause } from './surface-dispatch.js'
import { MASKED_RESOLVED_CONFIG_SCHEMA_VERSION } from '@vostride/agent-qa-schema'

const MATRIX_BUDGET_MS = 900_000
const RUN_FINISH_BUDGET_MS = 180_000
const PAGE_BUDGET_MS = 30_000
const PASSING_NAME = 'The populated run conformance probe'
const FAILING_NAME = 'The populated run conformance second probe'
const SCREENSHOT_REF_PREFIX = 'decision-screenshot:'

type Trigger = 'cli' | 'mcp' | 'api' | 'dashboard'
type Outcome = 'passed' | 'failed'

interface DoorRow {
  readonly label: string
  readonly outcome: Outcome
  readonly trigger: Trigger
  readonly owner: 'child' | 'self'
}

const ROWS: readonly DoorRow[] = [
  { label: 'agent-qa run', outcome: 'passed', trigger: 'cli', owner: 'child' },
  { label: 'agent-qa mcp over stdio', outcome: 'passed', trigger: 'mcp', owner: 'child' },
  { label: 'agent-qa mcp over HTTP', outcome: 'passed', trigger: 'mcp', owner: 'child' },
  { label: 'agent-qa fn', outcome: 'failed', trigger: 'cli', owner: 'self' },
  { label: 'agent-qa ask', outcome: 'passed', trigger: 'cli', owner: 'self' },
  { label: 'agent-qa chat', outcome: 'passed', trigger: 'cli', owner: 'self' },
  { label: 'the daemon', outcome: 'passed', trigger: 'cli', owner: 'self' },
  { label: 'dashboard POST /run', outcome: 'failed', trigger: 'api', owner: 'self' },
  { label: 'the co-hosted MCP endpoint', outcome: 'passed', trigger: 'mcp', owner: 'self' },
  { label: 'the dashboard Run control (control row)', outcome: 'passed', trigger: 'dashboard', owner: 'self' },
]
const ROW_LABELS = ROWS.map((row) => row.label)

interface OverviewScreenshot { readonly sha: string }
interface OverviewStep {
  readonly capture: { readonly state: string; readonly screenshots?: readonly OverviewScreenshot[] }
}
interface OverviewDocument {
  readonly runId?: string
  readonly aggregateVerdict?: string
  readonly tests?: ReadonlyArray<{ readonly testId?: string; readonly outcome?: string; readonly steps?: readonly OverviewStep[] }>
}
interface DetailDocument {
  readonly members?: ReadonlyArray<{ readonly testId?: string; readonly outcome?: string }>
  readonly subActions?: ReadonlyArray<{ readonly artifactRefs?: ReadonlyArray<{ readonly id: string; readonly sha: string }> }>
}

interface Read<T> {
  readonly document?: T
  readonly status?: number | null
  readonly error?: string
}

interface DoorRecord {
  readonly row: DoorRow
  runId?: string
  ownerPid?: number
  error?: string
  answer?: string
  finished?: boolean
  lastEventType?: string
  cliOverview?: Read<OverviewDocument>
  mcpOverview?: Read<OverviewDocument>
  apiRun?: Read<{ run?: { status?: string } }>
  apiDetail?: Read<DetailDocument>
  apiLogs?: Read<unknown>
  artifact?: { readonly sha: string; readonly status: number }
  page?: { readonly notFound: boolean; readonly nameShown: boolean; readonly waitFailure?: string; readonly text: string }
}

const records: DoorRecord[] = []
const stdioErrors: string[] = []
let stdioStartParsed = false
let stdioStdoutLog: string | undefined
let project: PopulatedRunProject & { readonly testId: string; readonly secondTestId?: string }
let scene: DashboardScene | undefined
let target: FixtureServer | undefined
let model: StubModelServer | undefined
let pageDashboard: (SpawnedDashboard & { readonly ready: boolean }) | undefined
let browser: Browser | undefined
let setupFailure: string | undefined
const drivenOrder: string[] = []

function testPathOf(row: DoorRow): string {
  return row.outcome === 'passed' ? POPULATED_TEST_PATH : POPULATED_SECOND_TEST_PATH
}

function testIdOf(row: DoorRow): string | undefined {
  return row.outcome === 'passed' ? project.testId : project.secondTestId
}

function nameOf(row: DoorRow): string {
  return row.outcome === 'passed' ? PASSING_NAME : FAILING_NAME
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// post-run digests also name runs earlier doors started.
function onlyRunId(text: string): string {
  const earlier = new Set(records.map((record) => record.runId))
  const ids = printedRunIds(text).filter((runId) => !earlier.has(runId))
  if (ids.length !== 1) throw new Error(`expected one run id in the door's answer, found ${JSON.stringify(ids)}: ${text.slice(0, 2_000)}`)
  return ids[0]!
}

function spawnedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...hermeticEnv(project.root),
    ...populatedRunSpawnEnv(),
    CI: 'true',
    NO_COLOR: '1',
  }
  delete env.AGENT_QA_RUN_ID
  return env
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

async function spawnRunDoor(args: readonly string[]): Promise<{ pid: number | undefined; status: number | null; text: string }> {
  const child = spawn(process.execPath, [CLI_ENTRY, '--config', project.configPath, ...args], {
    cwd: project.root,
    env: spawnedEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let text = ''
  child.stdout.on('data', (chunk: Buffer) => { text += chunk.toString('utf8') })
  child.stderr.on('data', (chunk: Buffer) => { text += chunk.toString('utf8') })
  const budget = setTimeout(() => { child.kill('SIGKILL') }, RUN_FINISH_BUDGET_MS)
  try {
    const status = await new Promise<number | null>((settle, fail) => {
      child.once('error', fail)
      child.once('close', (code) => settle(code))
    })
    return { pid: child.pid, status, text }
  } finally {
    clearTimeout(budget)
  }
}

async function spawnHttpMcp(port: number): Promise<{ pid: number | undefined; stderr: () => string; stop: () => Promise<void> }> {
  const child = spawn(process.execPath, [CLI_ENTRY, '--config', project.configPath, 'mcp', '--http', String(port)], {
    cwd: project.root,
    env: spawnedEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  let exited = false
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
  child.stdout.resume()
  child.once('close', () => { exited = true })
  const deadline = Date.now() + 60_000
  while (!stderr.includes('agent-qa MCP server listening on http://') && !exited && Date.now() < deadline) {
    await new Promise((tick) => setTimeout(tick, 50))
  }
  if (!stderr.includes('agent-qa MCP server listening on http://')) {
    child.kill('SIGKILL')
    throw new Error(`agent-qa mcp --http never said it was listening: ${stderr}`)
  }
  return {
    pid: child.pid,
    stderr: () => stderr,
    stop: () => new Promise<void>((stopped) => {
      if (exited) { stopped(); return }
      child.once('close', () => stopped())
      child.kill('SIGTERM')
      setTimeout(() => { child.kill('SIGKILL') }, 5_000).unref()
    }),
  }
}

function stdioTransport(extraEnv: NodeJS.ProcessEnv = {}): StdioClientTransport {
  return new StdioClientTransport({
    command: process.execPath,
    args: [CLI_ENTRY, '--config', project.configPath, 'mcp'],
    cwd: project.root,
    stderr: 'pipe',
    env: stringEnv({ ...spawnedEnv(), ...extraEnv }),
  })
}

// the MCP client drops stdout lines that are not JSON, so its error
// handler never sees a stray line. A preload in the CLI child (not its children) records every
// byte the server writes to stdout.
function stdoutTeeEnv(): NodeJS.ProcessEnv {
  stdioStdoutLog = join(project.root, 'mcp-stdio-stdout.log')
  const preload = join(project.root, 'mcp-stdio-stdout-tee.cjs')
  writeFileSync(preload, [
    "const { appendFileSync } = require('node:fs')",
    `if (process.ppid === ${String(process.pid)}) {`,
    '  const write = process.stdout.write.bind(process.stdout)',
    '  process.stdout.write = (chunk, ...rest) => {',
    `    appendFileSync(${JSON.stringify(stdioStdoutLog)}, typeof chunk === 'string' ? chunk : Buffer.from(chunk))`,
    '    return write(chunk, ...rest)',
    '  }',
    '}',
    '',
  ].join('\n'), 'utf8')
  return { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ${JSON.stringify(preload)}`.trim() }
}

function isJson(line: string): boolean {
  try {
    JSON.parse(line)
    return true
  } catch {
    return false
  }
}

function toolAnswer(result: unknown): { text: string; isError: boolean; structured: unknown } {
  const answer = result as { content?: ReadonlyArray<{ text?: string }>; isError?: boolean; structuredContent?: unknown }
  return {
    text: (answer.content ?? []).map((entry) => entry.text ?? '').join('\n'),
    isError: answer.isError === true,
    structured: answer.structuredContent,
  }
}

function runIdFromTool(result: unknown): string {
  const answer = toolAnswer(result)
  const structured = answer.structured as { runId?: unknown } | undefined
  if (typeof structured?.runId === 'string') return structured.runId
  return onlyRunId(answer.text)
}

async function inProcess<T>(body: () => Promise<T>): Promise<T> {
  const savedCi = process.env.CI
  const savedBrowsers = process.env.PLAYWRIGHT_BROWSERS_PATH
  const browsers = populatedRunSpawnEnv().PLAYWRIGHT_BROWSERS_PATH
  process.env.CI = 'true'
  if (browsers !== undefined) process.env.PLAYWRIGHT_BROWSERS_PATH = browsers
  try {
    return await body()
  } finally {
    if (savedCi === undefined) delete process.env.CI
    else process.env.CI = savedCi
    if (savedBrowsers === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH
    else process.env.PLAYWRIGHT_BROWSERS_PATH = savedBrowsers
  }
}

const stdinReads: string[] = []

/** Run `body` with `process.stdin` replaced by a stream that records and refuses every read. */
async function refuseStdinReads<T>(door: string, body: () => Promise<T>): Promise<T> {
  const forbidden = new Readable({ read() {} }) as Readable & { isTTY?: boolean }
  forbidden.isTTY = false
  for (const member of ['on', 'once', 'addListener', 'prependListener', 'prependOnceListener', 'resume', 'read', 'setRawMode']) {
    Object.defineProperty(forbidden, member, {
      configurable: true,
      value: (...args: unknown[]): never => {
        stdinReads.push(`${door}: ${member}(${typeof args[0] === 'string' ? args[0] : ''})`)
        throw new Error(`a read reached stdin through ${member}`)
      },
    })
  }
  const realStdin = process.stdin
  Object.defineProperty(process, 'stdin', { value: forbidden, configurable: true })
  try {
    return await body()
  } finally {
    Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true })
  }
}

async function commander(args: readonly string[]): Promise<string> {
  const printed: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => { printed.push(values.map(String).join(' ')) })
  const error = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => { printed.push(values.map(String).join(' ')) })
  process.exitCode = undefined
  const program = new Command()
    .exitOverride()
    .configureOutput({ writeErr: (text) => { printed.push(text) }, writeOut: (text) => { printed.push(text) } })
    .option('--config <path>', 'config file path')
    .addCommand(createFnCommand())
    .addCommand(createAskCommand())
  try {
    await program.parseAsync(['node', 'agent-qa', '--config', project.configPath, ...args])
  } catch (caught) {
    printed.push(String(caught))
  } finally {
    log.mockRestore()
    error.mockRestore()
    process.exitCode = undefined
  }
  return printed.join('\n')
}

async function postJson(path: string, body: unknown): Promise<{ status: number; text: string; json: Record<string, unknown> }> {
  const response = await fetch(`${scene!.origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let json: Record<string, unknown> = {}
  try { json = JSON.parse(text) as Record<string, unknown> } catch { json = {} }
  return { status: response.status, text, json }
}

type Driver = (row: DoorRow, record: DoorRecord) => Promise<void>

const DRIVERS: Readonly<Record<string, Driver>> = {
  'agent-qa run': async (row, record) => {
    const outcome = await spawnRunDoor(['run', testPathOf(row)])
    record.answer = outcome.text
    record.ownerPid = outcome.pid
    record.runId = onlyRunId(outcome.text)
  },
  'agent-qa mcp over stdio': async (row, record) => {
    const transport = stdioTransport(stdoutTeeEnv())
    transport.onerror = (error) => { stdioErrors.push(`transport: ${message(error)}`) }
    const client = new Client({ name: 'agent-qa-443-01-stdio', version: '0.0.0' })
    client.onerror = (error) => { stdioErrors.push(`client: ${message(error)}`) }
    try {
      await client.connect(transport)
      record.ownerPid = transport.pid ?? undefined
      const result = await client.callTool(
        { name: 'agent_qa_start_run', arguments: { patterns: [testPathOf(row)] } },
        { timeout: RUN_FINISH_BUDGET_MS },
      )
      const answer = toolAnswer(result)
      stdioStartParsed = Array.isArray((result as { content?: unknown }).content)
      record.answer = answer.text
      record.runId = runIdFromTool(result)
      await waitForRunFinished(record)
    } finally {
      await client.close().catch(() => undefined)
      await transport.close().catch(() => undefined)
    }
  },
  'agent-qa mcp over HTTP': async (row, record) => {
    const server = await spawnHttpMcp(await reserveEphemeralPort())
    record.ownerPid = server.pid
    const client = new Client({ name: 'agent-qa-443-01-http', version: '0.0.0' })
    try {
      const port = /listening on http:\/\/[^:]+:(\d+)/u.exec(server.stderr())?.[1]
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${String(port)}/mcp`)))
      const result = await client.callTool(
        { name: 'agent_qa_start_run', arguments: { patterns: [testPathOf(row)] } },
        { timeout: RUN_FINISH_BUDGET_MS },
      )
      record.answer = toolAnswer(result).text
      record.runId = runIdFromTool(result)
      await waitForRunFinished(record)
    } finally {
      await client.close().catch(() => undefined)
      await server.stop()
    }
  },
  'agent-qa fn': async (row, record) => {
    await inProcess(async () => {
      record.answer = await commander([
        'fn', 'runs.start', '--input', JSON.stringify({ patterns: [testPathOf(row)] }), '--json',
      ])
      record.runId = onlyRunId(record.answer)
      await waitForRunFinished(record)
    })
  },
  'agent-qa ask': async (row, record) => {
    await inProcess(async () => {
      record.answer = await commander(['ask', genericFnClause('runs.start', { patterns: [testPathOf(row)] })])
      record.runId = onlyRunId(record.answer)
      await waitForRunFinished(record)
    })
  },
  'agent-qa chat': async (row, record) => {
    await inProcess(async () => {
      const observed = await driveChatLines(
        [genericFnClause('runs.start', { patterns: [testPathOf(row)] })],
        'ci',
        { configPath: project.configPath },
      )
      record.answer = observed.stdout
      const earlier = new Set(records.map((other) => other.runId))
      const started = observed.results
        .filter((result) => result.functionId === 'runs.start')
        .map((result) => (result.payload as { runId?: unknown } | undefined)?.runId)
        .filter((runId): runId is string => typeof runId === 'string' && !earlier.has(runId))
      record.runId = started.length === 1 ? started[0] : onlyRunId(observed.stdout)
      await waitForRunFinished(record)
    })
  },
  'the daemon': async (row, record) => {
    const listeners = new Map<NodeJS.Signals, () => void>()
    const operations: Partial<DaemonHostOperations> = {
      setInterval: (_callback, intervalMs) => intervalMs as unknown as ReturnType<typeof setInterval>,
      clearInterval: () => undefined,
      onSignal: (signal, listener) => listeners.set(signal, listener),
      offSignal: (signal, listener) => { if (listeners.get(signal) === listener) listeners.delete(signal) },
      hardExit: (code) => { throw new Error(`unexpected daemon hard exit ${code}`) },
    }
    const jobModel: JobModelCapability = { modelId: 'test:443-01-doors', generate: () => Promise.resolve({ text: 'unused' }) }
    const config: ConfigReaderPort = {
      getMasked: () => Promise.resolve({ schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION, configPath: project.configPath, entries: [] }),
    }
    const knowledgeRoot = join(project.root, 'agent-qa-knowledge')
    await inProcess(async () => {
      let started = false
      let exitCode: number | undefined
      const logged: string[] = []
      const running = runDaemonHost({
        agentQaRoot: project.agentQaRoot,
        knowledgeRoot,
        configPath: project.configPath,
        config,
        model: () => jobModel,
        operations,
        logger: {
          info: (line: string) => { started = true; logged.push(`info: ${line}`) },
          error: (line: string) => { logged.push(`error: ${line}`) },
        },
      }).then((code) => { exitCode = code; return code })
      try {
        const deadline = Date.now() + 30_000
        while (!started && exitCode === undefined && Date.now() < deadline) await new Promise((tick) => setTimeout(tick, 50))
        if (!started) throw new Error(`the daemon did not start (exit ${String(exitCode)}): ${logged.join('\n')}`)
        const answer = await invokeViaDaemon({
          agentQaRoot: project.agentQaRoot,
          knowledgeRoot,
          functionId: 'runs.start',
          input: { patterns: [testPathOf(row)] },
        })
        record.answer = JSON.stringify(answer)
        const structured = answer as { runId?: unknown } | undefined
        record.runId = typeof structured?.runId === 'string' ? structured.runId : onlyRunId(record.answer)
        await waitForRunFinished(record)
      } finally {
        listeners.get('SIGTERM')?.()
        await running
      }
    })
  },
  'dashboard POST /run': async (row, record) => {
    await inProcess(async () => {
      const answer = await postJson('/run', { patterns: [testPathOf(row)] })
      record.answer = `${String(answer.status)} ${answer.text}`
      record.runId = typeof answer.json['runId'] === 'string' ? answer.json['runId'] : onlyRunId(answer.text)
      await waitForRunFinished(record)
    })
  },
  'the co-hosted MCP endpoint': async (row, record) => {
    const masking = composeMcpMasking({ configPath: project.configPath })
    const warnings: string[] = []
    const mount = await mountCoHostedMcp({
      server: createServer(createMcpHttpRequestListener({
        registry: scene!.registry,
        maskText: (text: string) => masking.mask(text),
        liveLink: { dashboardBaseUrl: () => scene!.origin },
      })),
      port: 0,
      warn: (line) => warnings.push(line),
    })
    const server: Server | undefined = mount.server
    if (server === undefined) throw new Error(`the co-hosted MCP endpoint did not mount: ${warnings.join('\n')}`)
    const client = new Client({ name: 'agent-qa-443-01-cohost', version: '0.0.0' })
    try {
      await inProcess(async () => {
        await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${String(mount.boundPort)}/mcp`)))
        const result = await client.callTool(
          { name: 'agent_qa_start_run', arguments: { patterns: [testPathOf(row)] } },
          { timeout: RUN_FINISH_BUDGET_MS },
        )
        record.answer = toolAnswer(result).text
        record.runId = runIdFromTool(result)
        await waitForRunFinished(record)
      })
    } finally {
      await client.close().catch(() => undefined)
      await new Promise<void>((closed) => server.close(() => closed()))
    }
  },
  'the dashboard Run control (control row)': async (row, record) => {
    await inProcess(async () => {
      const answer = await postJson('/api/runs/trigger', { file: testPathOf(row) })
      record.answer = `${String(answer.status)} ${answer.text}`
      record.runId = typeof answer.json['runId'] === 'string' ? answer.json['runId'] : onlyRunId(answer.text)
      await waitForRunFinished(record)
    })
  },
}

// the post-run tail appends curation events after runFinished.
function holdsRunFinished(runId: string): boolean {
  try {
    return runStoreEvents(project, runId).some((event) => event.type === 'runFinished')
  } catch {
    return false
  }
}

function lastEventType(runId: string): string | undefined {
  try {
    return runStoreEvents(project, runId).at(-1)?.type
  } catch {
    return undefined
  }
}

async function waitForRunFinished(record: DoorRecord): Promise<void> {
  if (record.runId === undefined) return
  const deadline = Date.now() + RUN_FINISH_BUDGET_MS
  for (;;) {
    record.lastEventType = lastEventType(record.runId)
    if (holdsRunFinished(record.runId)) {
      record.finished = true
      return
    }
    if (Date.now() >= deadline) {
      record.finished = false
      return
    }
    await new Promise((tick) => setTimeout(tick, 100))
  }
}

async function readCliOverview(runId: string): Promise<Read<OverviewDocument>> {
  const outcome = await spawnCliRun(project, ['runs', 'overview', runId, '--json'], { budgetMs: 60_000 })
  try {
    return { status: outcome.status, document: JSON.parse(outcome.stdout) as OverviewDocument }
  } catch {
    return { status: outcome.status, error: `exit ${String(outcome.status)}: ${outcome.stdout.slice(0, 1_000)} ${outcome.stderr.slice(0, 1_000)}` }
  }
}

async function readApi<T>(path: string): Promise<Read<T>> {
  try {
    const response = await fetch(`${scene!.origin}${path}`)
    const text = await response.text()
    try {
      return { status: response.status, document: JSON.parse(text) as T }
    } catch {
      return { status: response.status, error: text.slice(0, 1_000) }
    }
  } catch (error) {
    return { error: message(error) }
  }
}

async function readEverything(): Promise<void> {
  const transport = stdioTransport()
  const client = new Client({ name: 'agent-qa-443-01-reader', version: '0.0.0' })
  let mcpFailure: string | undefined
  try {
    await client.connect(transport)
  } catch (error) {
    mcpFailure = message(error)
  }
  try {
    for (const record of records) {
      const runId = record.runId
      if (runId === undefined) continue
      record.cliOverview = await readCliOverview(runId)
      if (mcpFailure !== undefined) {
        record.mcpOverview = { error: `the MCP reader did not connect: ${mcpFailure}` }
      } else {
        try {
          const answer = toolAnswer(await client.callTool({ name: 'agent_qa_get_run_overview', arguments: { runId } }, { timeout: 60_000 }))
          record.mcpOverview = answer.isError
            ? { error: answer.text.slice(0, 1_000) }
            : { document: answer.structured as OverviewDocument }
        } catch (error) {
          record.mcpOverview = { error: message(error) }
        }
      }
      const encoded = encodeURIComponent(runId)
      record.apiRun = await readApi(`/api/runs/${encoded}`)
      record.apiDetail = await readApi(`/api/runs/${encoded}/detail`)
      record.apiLogs = await readApi(`/api/runs/${encoded}/execution-logs`)
      const sha = cliShas(record)[0]
      if (sha !== undefined) {
        const response = await fetch(`${scene!.origin}/api/runs/${encoded}/artifacts/${sha}`).catch(() => undefined)
        await response?.arrayBuffer().catch(() => undefined)
        record.artifact = { sha, status: response?.status ?? 0 }
      }
    }
  } finally {
    await client.close().catch(() => undefined)
    await transport.close().catch(() => undefined)
  }
}

async function observePages(): Promise<void> {
  pageDashboard = await spawnDashboard(project.root, project.configPath, await reserveEphemeralPort(), 60_000, populatedRunSpawnEnv())
  if (!pageDashboard.ready) throw new Error(`the spawned dashboard never said it was listening: ${pageDashboard.stderr()}`)
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  for (const record of records) {
    if (record.runId === undefined) continue
    const page = await context.newPage()
    let waitFailure: string | undefined
    try {
      await page.goto(`${pageDashboard.origin}/runs/${encodeURIComponent(record.runId)}`)
      const notFound = page.getByText('Run not found', { exact: true })
      await notFound.or(page.locator('[data-step-id]')).first()
        .waitFor({ state: 'attached', timeout: PAGE_BUDGET_MS })
        .catch((error: unknown) => { waitFailure = message(error) })
      const text = await page.locator('body').innerText().catch(() => '')
      const title = await page.title().catch(() => '')
      record.page = {
        notFound: (await notFound.count()) > 0,
        nameShown: text.includes(nameOf(record.row)) || title.includes(nameOf(record.row)),
        ...(waitFailure === undefined ? {} : { waitFailure }),
        text: text.slice(0, 600),
      }
    } catch (error) {
      record.page = { notFound: false, nameShown: false, waitFailure: message(error), text: '' }
    } finally {
      await page.close().catch(() => undefined)
    }
  }
}

function overviewShas(document: OverviewDocument | undefined): string[] {
  const shas = (document?.tests ?? []).flatMap((test) => (test.steps ?? [])
    .flatMap((step) => (step.capture.screenshots ?? []).map((shot) => shot.sha)))
  return [...new Set(shas)].sort()
}

function cliShas(record: DoorRecord): string[] {
  return overviewShas(record.cliOverview?.document)
}

function detailShas(document: DetailDocument | undefined): string[] {
  const shas = (document?.subActions ?? []).flatMap((sub) => (sub.artifactRefs ?? [])
    .filter((ref) => ref.id.startsWith(SCREENSHOT_REF_PREFIX))
    .map((ref) => ref.sha))
  return [...new Set(shas)].sort()
}

function recordOf(label: string): DoorRecord {
  const record = records.find((candidate) => candidate.row.label === label)
  if (record === undefined) throw new Error(`no door was driven for "${label}"${setupFailure === undefined ? '' : `: ${setupFailure}`}`)
  return record
}

function describeRecord(record: DoorRecord): string {
  return JSON.stringify({ ...record, answer: record.answer?.slice(0, 1_500) }, null, 2)
}

function requireRun(record: DoorRecord): string {
  expect(record.error, `the door failed\n${describeRecord(record)}`).toBeUndefined()
  expect(record.runId, `the door returned no run id\n${describeRecord(record)}`).toBeDefined()
  return record.runId!
}

describe('a run through every door', () => {
  beforeAll(async () => {
    refuseWithoutRecordingTools()
    target = await startTargetPageServer()
    model = await startStubModelServer({ plannerOutcome: 'stepFailed', failOnlyStepText: POPULATED_FAILURE_STEP_MARKER })
    project = populatedRunFixtureProject('443-door-matrix', {
      modelBaseUrl: model.baseUrl,
      targetUrl: target.url,
    }, { secondStepText: POPULATED_FAILURE_STEP_TEXT })
    const config = JSON.parse(readFileSync(project.configPath, 'utf8')) as Record<string, any>
    config.services = { recording: { enabled: true } }
    config.registry.targets[POPULATED_TARGET_NAME].environment = 'production'
    writeFileSync(project.configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    const written = JSON.parse(readFileSync(project.configPath, 'utf8')) as {
      services?: { dashboard?: unknown }
      registry?: { targets?: Record<string, { environment?: string }> }
    }
    expect(written.services?.dashboard, 'the matrix project declares no dashboard block').toBeUndefined()
    expect(written.registry?.targets?.[POPULATED_TARGET_NAME]?.environment, 'the matrix target is declared production')
      .toBe('production')
    expect(project.secondTestId, 'the project has a failing test').toBeDefined()

    for (const row of ROWS) records.push({ row })
    // fn, ask and chat leave their hosts' knowledge writer lease held in
    // this process (a CLI process exits with it), which the daemon refuses, so the daemon goes first.
    const daemonFirst = [...ROWS].sort((a, b) => Number(b.label === 'the daemon') - Number(a.label === 'the daemon'))
    for (const row of daemonFirst) {
      const record = recordOf(row.label)
      drivenOrder.push(row.label)
      if (scene === undefined && row.label !== 'the daemon') scene = await openDashboardScene(project)
      try {
        const driver = DRIVERS[row.label]
        if (driver === undefined) throw new Error(`no driver for "${row.label}"`)
        const drive = async (): Promise<void> => {
          await driver(row, record)
          if (record.finished === undefined) await waitForRunFinished(record)
        }
        await (row.owner === 'self' ? refuseStdinReads(row.label, drive) : drive())
      } catch (error) {
        record.error = message(error)
        if (record.runId !== undefined && record.finished === undefined) await waitForRunFinished(record)
      }
    }
    try {
      await readEverything()
    } catch (error) {
      setupFailure = `the readers failed: ${message(error)}`
    }
    try {
      await observePages()
    } catch (error) {
      setupFailure = `${setupFailure ?? ''} the page pass failed: ${message(error)}`.trim()
    }
  }, MATRIX_BUDGET_MS)

  afterAll(async () => {
    await browser?.close().catch(() => undefined)
    await pageDashboard?.stop().catch(() => undefined)
    await scene?.close().catch(() => undefined)
    await model?.close().catch(() => undefined)
    await target?.close().catch(() => undefined)
    cleanupTempRoots()
  }, 120_000)

  it('every door ran once and returned an id, a pass and a fail among them', () => {
    expect(records.map((record) => record.row.label), setupFailure ?? 'the driven doors').toEqual(ROW_LABELS)
    expect([...drivenOrder].sort(), `every door was driven once: ${JSON.stringify(drivenOrder)}`).toEqual([...ROW_LABELS].sort())
    const ids = records.map((record) => record.runId)
    for (const record of records) {
      expect(record.runId, `${record.row.label} returned no run id\n${describeRecord(record)}`).toBeDefined()
    }
    expect(new Set(ids).size, `the run ids are distinct: ${JSON.stringify(ids)}`).toBe(ROWS.length)
    expect(ROWS.some((row) => row.outcome === 'passed')).toBe(true)
    expect(ROWS.some((row) => row.outcome === 'failed')).toBe(true)
    for (const record of records) {
      expect(record.finished, `${record.row.label}'s events.jsonl holds runFinished\n${describeRecord(record)}`).toBe(true)
    }
  })

  it.each(ROW_LABELS)('%s: the run has a runs.db row stamped with the process that ran it', (label) => {
    const record = recordOf(label)
    const runId = requireRun(record)
    const row = scene!.db.getRun(runId)
    expect(row, `runs.db holds no row for ${runId}\n${describeRecord(record)}`).toBeDefined()
    const expectedPid = record.row.owner === 'self' ? process.pid : record.ownerPid
    expect(expectedPid, 'the door reported the pid that ran it').toBeDefined()
    expect(scene!.db.readRunOwner(runId), `the owner stamp of ${runId}`).toMatchObject({
      pid: expectedPid,
      host: resolveRunOwnerHost(),
    })
  })

  it.each(ROW_LABELS)('%s: the row records its door in agent-qa.trigger', (label) => {
    const record = recordOf(label)
    const runId = requireRun(record)
    const row = scene!.db.getRun(runId)
    expect(row, `runs.db holds no row for ${runId}\n${describeRecord(record)}`).toBeDefined()
    expect(row!.attributes['agent-qa.trigger'], JSON.stringify(row!.attributes)).toBe(record.row.trigger)
  })

  it.each(ROW_LABELS)('%s: the CLI overview, the MCP overview and the dashboard agree on its member and verdict', (label) => {
    const record = recordOf(label)
    const runId = requireRun(record)
    const testId = testIdOf(record.row)
    for (const [reader, read] of [['CLI', record.cliOverview], ['MCP', record.mcpOverview]] as const) {
      expect(read?.error, `the ${reader} overview of ${runId}`).toBeUndefined()
      expect(read?.document, `the ${reader} overview of ${runId}`).toMatchObject({
        runId,
        aggregateVerdict: record.row.outcome,
        tests: [{ testId, outcome: record.row.outcome }],
      })
      expect(read?.document?.tests, `the ${reader} overview names one member`).toHaveLength(1)
    }
    expect(record.apiRun?.status, `GET /api/runs/${runId}: ${JSON.stringify(record.apiRun)}`).toBe(200)
    expect(record.apiRun?.document?.run?.status, 'the dashboard row status').toBe(record.row.outcome)
    expect(record.apiDetail?.status, `GET /api/runs/${runId}/detail: ${JSON.stringify(record.apiDetail)}`).toBe(200)
    expect(record.apiDetail?.document?.members, 'the dashboard detail members').toHaveLength(1)
    expect(record.apiDetail?.document?.members?.[0], 'the dashboard detail member').toMatchObject({ testId, outcome: record.row.outcome })
    expect(record.apiLogs?.status, `GET /api/runs/${runId}/execution-logs: ${JSON.stringify(record.apiLogs)}`).toBe(200)
  })

  it.each(ROW_LABELS)('%s: every reader shows the same decision screenshots', (label) => {
    const record = recordOf(label)
    const runId = requireRun(record)
    for (const [reader, read] of [['CLI', record.cliOverview], ['MCP', record.mcpOverview]] as const) {
      const steps = (read?.document?.tests ?? []).flatMap((test) => test.steps ?? [])
      expect(steps.length, `the ${reader} overview of ${runId} has steps: ${JSON.stringify(read)}`.slice(0, 2_000)).toBeGreaterThan(0)
      expect(steps.map((step) => step.capture.state), `the ${reader} overview's captures`).toEqual(steps.map(() => 'recorded'))
    }
    const cli = cliShas(record)
    expect(cli.length, `the CLI overview of ${runId} names a decision screenshot`).toBeGreaterThan(0)
    expect(overviewShas(record.mcpOverview?.document), 'the MCP overview shows the CLI overview\'s screenshots').toEqual(cli)
    expect(detailShas(record.apiDetail?.document), 'the dashboard detail shows the CLI overview\'s screenshots').toEqual(cli)
    expect(record.artifact, `the evidence route for ${cli[0] ?? '(none)'}`).toEqual({ sha: cli[0], status: 200 })
  })

  it('the run-detail page opens every door\'s run and never shows Run not found', () => {
    expect(records.map((record) => record.row.label), setupFailure ?? 'the driven doors').toEqual(ROW_LABELS)
    const pages = records.map((record) => ({ door: record.row.label, runId: record.runId, page: record.page }))
    expect(pages, setupFailure ?? 'the run-detail pages').toEqual(records.map((record) => ({
      door: record.row.label,
      runId: record.runId,
      page: expect.objectContaining({ notFound: false, nameShown: true }),
    })))
    for (const record of records) expect(record.runId, `${record.row.label} returned no run id`).toBeDefined()
  })

  it('no door reads stdin', () => {
    expect(records.filter((record) => record.row.owner === 'self').length, 'in-process doors were driven').toBeGreaterThan(0)
    expect(stdinReads).toEqual([])
  })

  it('the stdio MCP door\'s stdout stays JSON-RPC through its run', () => {
    const record = recordOf('agent-qa mcp over stdio')
    expect(stdioErrors, `the stdio client's error handler\n${describeRecord(record)}`).toEqual([])
    expect(stdioStartParsed, `the start answer parsed as a tool result\n${describeRecord(record)}`).toBe(true)
    requireRun(record)
    const written = stdioStdoutLog !== undefined && existsSync(stdioStdoutLog) ? readFileSync(stdioStdoutLog, 'utf8') : ''
    const lines = written.split('\n').filter((line) => line.trim() !== '')
    expect(lines.some((line) => isJson(line) && line.includes('"jsonrpc"')), 'the stdout instrument saw the JSON-RPC stream').toBe(true)
    expect(JSON.stringify(lines.filter((line) => !isJson(line))), 'stdout lines that are not JSON-RPC').toBe('[]')
  })
})
