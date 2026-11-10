// Every tool call the CLI's MCP listener serves reports its error, leaves one span and, where the
// host composed analytics, emits one tool event.

import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import {
  createFunctionRegistry,
  FunctionInputError,
  UnknownFunctionError,
} from '@vostride/agent-qa-agent'
import type { FunctionDeps, FunctionRegistry } from '@vostride/agent-qa-agent'
import { AgentQaAnalyticsEventSchema } from '@vostride/agent-qa-analytics'
import type { AgentQaAnalyticsEvent, AnalyticsCapturePayload } from '@vostride/agent-qa-analytics'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createMcpCommand,
  createMcpHttpRequestListener,
  MCP_HTTP_BIND_HOST,
} from '../commands/mcp.js'
import * as analyticsHost from '../composition/analytics-host.js'
import type { CliAnalyticsHost } from '../composition/analytics-host.js'
import {
  closeErrorReporting,
  errorReporter,
  startErrorReporting,
} from '../composition/error-reporting.js'
import { createToolSettledObserver } from '../composition/mcp-tool-observer.js'
import {
  projectWithPrivacy,
  recordingReportTransport,
  removeReportProjects,
  serializedEnvelopes,
} from './error-report-recorder.js'
import type { RecordedEnvelope, RecordingReportTransport } from './error-report-recorder.js'

const INVENTED_DSN = 'http://key@127.0.0.1:9/1'
const DECLARED_SECRET = 'sk-live-mark-store-secret'

const MARK = { name: 'agent_qa_mark_run', arguments: { runId: 'run-alpha', kind: 'false-fail' } }
const RUN_NOT_FOUND = { kind: 'run-not-found', runId: 'run-alpha' } as const
const NOT_INITIALIZED = { state: 'not-initialized', configPath: '/p/agent-qa.config.yaml' } as const

const unmasked = (text: string) => text

const scratch: string[] = []
const servers: Server[] = []
const clients: Client[] = []

beforeEach(() => {
  // No cell reads the auth store in the real home folder.
  const authDir = mkdtempSync(join(tmpdir(), 'agent-qa-mcp-tool-auth-'))
  scratch.push(authDir)
  vi.stubEnv('XDG_DATA_HOME', authDir)
})

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {})
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((closed) => server.close(() => closed()))
  }
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await closeErrorReporting()
  removeReportProjects()
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// Only the mark port is bound; each cell decides what it answers or throws.
function markRegistry(mark: () => Promise<unknown>): FunctionRegistry {
  return createFunctionRegistry({
    deps: { feedback: { mark, marksFor: async () => [] } } as unknown as FunctionDeps,
  })
}

async function connectClient(port: number): Promise<Client> {
  const client = new Client({ name: 'agent-qa-tool-observer', version: '0.0.0' })
  clients.push(client)
  const url = new URL(`http://${MCP_HTTP_BIND_HOST}:${String(port)}/mcp`)
  await client.connect(new StreamableHTTPClientTransport(url))
  return client
}

// The listener on a real loopback socket, with a real client speaking to it.
async function serve(input: Parameters<typeof createMcpHttpRequestListener>[0]): Promise<Client> {
  const server = createServer(createMcpHttpRequestListener(input))
  servers.push(server)
  await new Promise<void>((listening) => server.listen(0, MCP_HTTP_BIND_HOST, () => listening()))
  return await connectClient((server.address() as AddressInfo).port)
}

interface RecordedAnalytics {
  readonly host: CliAnalyticsHost
  readonly sent: AnalyticsCapturePayload[]
}

// The shipped composition, opted in, over a transport that records and an identity stub.
function recordingCompose(
  sent: AnalyticsCapturePayload[],
): typeof analyticsHost.composeAnalyticsHost {
  return (input) =>
    analyticsHost.composeAnalyticsHost({
      ...input,
      env: {},
      transportOverride: {
        capture: (payload) => {
          sent.push(payload)
        },
        flush: () => {},
        shutdown: () => {},
      },
      resolveIdentity: async () => ({ distinctId: 'u_mcp-tool-cell', runtimeContext: 'user' }),
    })
}

async function recordingAnalytics(): Promise<RecordedAnalytics> {
  const sent: AnalyticsCapturePayload[] = []
  return { host: await recordingCompose(sent)({ surface: 'mcp' }), sent }
}

// The port the in-process server says it bound, with its stderr swallowed until then.
function boundPort(): Promise<number> {
  return new Promise((bound) => {
    const write = vi.spyOn(process.stderr, 'write')
    write.mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
      for (const part of rest) if (typeof part === 'function') part()
      const port = /MCP server listening on http:\/\/[^/]+:(\d+)\//u.exec(String(chunk))?.[1]
      if (port !== undefined) {
        write.mockRestore()
        bound(Number(port))
      }
      return true
    }) as typeof process.stderr.write)
  })
}

// A blank DSN is reporting off, as in a source checkout.
async function startReporting(dsn = INVENTED_DSN): Promise<RecordingReportTransport> {
  const recorder = recordingReportTransport()
  const project = projectWithPrivacy({ secrets: { MARK_STORE_TOKEN: DECLARED_SECRET } })
  await startErrorReporting({ configPath: project.configPath, dsn, transport: recorder.transport })
  return recorder
}

// Every capture the cell made reaches its recorder.
async function drain(analytics?: RecordedAnalytics): Promise<void> {
  await analytics?.host.flush()
  await errorReporter()?.flush(2_000)
}

type ToolInvoked = Extract<AgentQaAnalyticsEvent, { name: 'agent-qa.mcp.tool.invoked' }>

// Each event is parsed against the closed union, so one outside it fails the cell.
function toolEvents(sent: readonly AnalyticsCapturePayload[]): ToolInvoked['properties'][] {
  return sent
    .map((payload) => AgentQaAnalyticsEventSchema.parse(payload.event))
    .filter((event): event is ToolInvoked => event.name === 'agent-qa.mcp.tool.invoked')
    .map((event) => event.properties)
}

type EnvelopeItems = Array<[unknown, Array<[{ readonly type?: string }, unknown]>]>

function itemsOf(envelopes: readonly RecordedEnvelope[], type: string): unknown[] {
  return (JSON.parse(serializedEnvelopes(envelopes)) as EnvelopeItems)
    .flatMap(([, items]) => items)
    .filter(([header]) => header.type === type)
    .map(([, payload]) => payload)
}

interface ReportedError {
  readonly exception?: { readonly values?: ReadonlyArray<{ readonly value?: string }> }
}

// The message each error event reports, one entry per event, in a stable order.
function reportedErrors(envelopes: readonly RecordedEnvelope[]): string[] {
  return (itemsOf(envelopes, 'event') as ReportedError[])
    .map((event) => (event.exception?.values ?? []).map((value) => value.value ?? '').join('\n'))
    .sort()
}

interface ReportedSpan {
  readonly name?: string
  readonly trace_id?: string
  readonly parent_span_id?: string
  readonly status?: string
  readonly start_timestamp?: number
  readonly end_timestamp?: number
  readonly attributes?: Readonly<Record<string, { readonly value?: unknown }>>
}

function toolSpans(envelopes: readonly RecordedEnvelope[]): ReportedSpan[] {
  return (itemsOf(envelopes, 'span') as Array<{ readonly items?: ReportedSpan[] }>)
    .flatMap((payload) => payload.items ?? [])
    .filter((span) => span.attributes?.['sentry.op']?.value === 'agent_qa.mcp_tool')
}

function attributeOf(span: ReportedSpan | undefined, key: string): unknown {
  return span?.attributes?.[key]?.value
}

describe('the tool event', () => {
  it('is emitted once for a call that succeeds, naming the tool, success, http and its duration', async () => {
    const analytics = await recordingAnalytics()
    const client = await serve({
      registry: markRegistry(async () => RUN_NOT_FOUND),
      maskText: unmasked,
      analytics: { host: analytics.host, mcpTransport: 'http' },
    })

    const result = await client.callTool(MARK)
    await drain(analytics)

    expect(result.isError ?? false).toBe(false)
    expect(analytics.sent.map((payload) => payload.event.name)).toEqual([
      'agent-qa.mcp.tool.invoked',
    ])
    const [event] = toolEvents(analytics.sent)
    expect(event).toMatchObject({
      surface: 'mcp',
      tool_name: 'agent_qa_mark_run',
      mcp_tool_status: 'success',
      mcp_transport: 'http',
    })
    expect(event?.duration_ms).toBeGreaterThanOrEqual(0)
    expect(event).not.toHaveProperty('mcp_error_category')
  })

  it('names a FunctionInputError validation and an UnknownFunctionError unknown_tool', async () => {
    await startReporting()
    const analytics = await recordingAnalytics()
    const thrown = [
      new FunctionInputError('runs.mark', 'note: too long'),
      new UnknownFunctionError('runs.unmark'),
    ]
    const client = await serve({
      registry: markRegistry(() => Promise.reject(thrown.shift())),
      maskText: unmasked,
      analytics: { host: analytics.host, mcpTransport: 'http' },
    })

    await client.callTool(MARK)
    await client.callTool(MARK)
    await drain(analytics)

    const events = toolEvents(analytics.sent)
    expect(events.map((event) => [event.mcp_tool_status, event.mcp_error_category])).toEqual([
      ['error', 'validation'],
      ['error', 'unknown_tool'],
    ])
  })

  it('names an error result with nothing thrown unknown', async () => {
    const analytics = await recordingAnalytics()
    const client = await serve({
      registry: markRegistry(async () => RUN_NOT_FOUND),
      maskText: unmasked,
      posture: NOT_INITIALIZED,
      analytics: { host: analytics.host, mcpTransport: 'http' },
    })

    const result = await client.callTool(MARK)
    await drain(analytics)

    expect(result.isError).toBe(true)
    expect(toolEvents(analytics.sent)).toEqual([
      expect.objectContaining({ mcp_tool_status: 'error', mcp_error_category: 'unknown' }),
    ])
  })

  it('is emitted while reporting is off, and nothing is reported', async () => {
    const recorder = await startReporting('')
    expect(errorReporter()).toBeUndefined()
    const analytics = await recordingAnalytics()
    const client = await serve({
      registry: markRegistry(() => Promise.reject(new Error('a mark while reporting is off'))),
      maskText: unmasked,
      analytics: { host: analytics.host, mcpTransport: 'http' },
    })

    await client.callTool(MARK)
    await drain(analytics)

    expect(toolEvents(analytics.sent)).toEqual([
      expect.objectContaining({ mcp_tool_status: 'error', mcp_error_category: 'tool_error' }),
    ])
    expect(recorder.envelopes).toEqual([])
  })
})

describe('the tool error', () => {
  it('is reported when the op throws, masked, beside one event naming it tool_error', async () => {
    const recorder = await startReporting()
    const analytics = await recordingAnalytics()
    const client = await serve({
      registry: markRegistry(() =>
        Promise.reject(new Error(`the mark store refused ${DECLARED_SECRET}`)),
      ),
      maskText: unmasked,
      analytics: { host: analytics.host, mcpTransport: 'http' },
    })

    const result = await client.callTool(MARK)
    await drain(analytics)

    expect(result.isError).toBe(true)
    expect(toolEvents(analytics.sent)).toEqual([
      expect.objectContaining({
        tool_name: 'agent_qa_mark_run',
        mcp_tool_status: 'error',
        mcp_error_category: 'tool_error',
        mcp_transport: 'http',
      }),
    ])
    const reported = reportedErrors(recorder.envelopes)
    expect(reported).toHaveLength(1)
    expect(reported[0]).toMatch(/^the mark store refused /)
    expect(serializedEnvelopes(recorder.envelopes)).not.toContain(DECLARED_SECRET)
  })

  it('is reported for a refusal and a defect alike, and not for an error result', async () => {
    const recorder = await startReporting()
    const thrown = [
      new FunctionInputError('runs.mark', 'note: too long'),
      new UnknownFunctionError('runs.unmark'),
    ]
    const client = await serve({
      registry: markRegistry(() => Promise.reject(thrown.shift())),
      maskText: unmasked,
    })
    const posture = await serve({
      registry: markRegistry(async () => RUN_NOT_FOUND),
      maskText: unmasked,
      posture: NOT_INITIALIZED,
    })

    await client.callTool(MARK)
    await client.callTool(MARK)
    expect((await posture.callTool(MARK)).isError).toBe(true)
    await drain()

    expect(reportedErrors(recorder.envelopes)).toEqual([
      'Invalid input for runs.mark: note: too long',
      'Unknown function: runs.unmark',
    ])
  })

  it('is reported from a listener with no analytics, as the dashboard mounts it', async () => {
    const recorder = await startReporting()
    const composed = vi.spyOn(analyticsHost, 'composeAnalyticsHost')
    const built = vi.spyOn(analyticsHost, 'analyticsEvent')
    const client = await serve({
      registry: markRegistry(() => Promise.reject(new Error('a mark on the dashboard failed'))),
      maskText: unmasked,
    })

    const result = await client.callTool(MARK)
    await drain()

    expect(result.isError).toBe(true)
    expect(reportedErrors(recorder.envelopes)).toEqual(['a mark on the dashboard failed'])
    expect(toolSpans(recorder.envelopes)).toHaveLength(1)
    expect(composed).not.toHaveBeenCalled()
    expect(built).not.toHaveBeenCalled()
  })
})

describe('the tool span', () => {
  it('is one agent_qa.mcp_tool span per call, in a trace of its own, naming the tool and outcome', async () => {
    const recorder = await startReporting()
    const answers: Array<() => Promise<unknown>> = [
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 40))
        return RUN_NOT_FOUND
      },
      () => Promise.reject(new Error('the second mark failed')),
    ]
    const client = await serve({
      registry: markRegistry(() => answers.shift()!()),
      maskText: unmasked,
    })

    await client.callTool(MARK)
    await client.callTool(MARK)
    await drain()

    const spans = toolSpans(recorder.envelopes)
    const byOutcome = (outcome: string) =>
      spans.find((span) => attributeOf(span, 'agent_qa.outcome') === outcome)
    expect(spans).toHaveLength(2)
    for (const span of spans) {
      expect(span.name).toBe('tool agent_qa_mark_run')
      expect(attributeOf(span, 'agent_qa.tool')).toBe('agent_qa_mark_run')
      expect(span.parent_span_id).toBeUndefined()
    }
    expect([byOutcome('success')?.status, byOutcome('error')?.status]).toEqual(['ok', 'error'])
    expect(new Set(spans.map((span) => span.trace_id)).size).toBe(2)
    // The span starts when the call did: the op took 40 ms before the observer saw it settle.
    const succeeded = byOutcome('success')
    const seconds = (succeeded?.end_timestamp ?? 0) - (succeeded?.start_timestamp ?? 0)
    expect(seconds).toBeGreaterThan(0.03)
  })
})

describe('agent-qa mcp --http', () => {
  it('emits each tool event through the analytics it composed, naming http', async () => {
    const project = projectWithPrivacy()
    const sent: AnalyticsCapturePayload[] = []
    const exits: number[] = []
    const program = new Command().option('--config <path>').exitOverride()
    program.addCommand(
      createMcpCommand({
        composeAnalytics: recordingCompose(sent),
        exit: (code) => {
          exits.push(code)
        },
      }),
    )
    const exitCodeBefore = process.exitCode
    const signalled = new Set<unknown>(process.listeners('SIGINT'))
    const listening = boundPort()
    const args = ['--config', project.configPath, 'mcp', '--http', '0']
    const running = program.parseAsync(['node', 'agent-qa', ...args])

    let result: Awaited<ReturnType<Client['callTool']>>
    try {
      const client = await connectClient(await listening)
      result = await client.callTool({ name: 'agent_qa_list_runs', arguments: {} })
      await client.close()
    } finally {
      // As a Ctrl-C would: the listeners the server added stop it.
      for (const listener of process.listeners('SIGINT')) {
        if (!signalled.has(listener)) listener('SIGINT')
      }
      await running
      process.exitCode = exitCodeBefore
    }

    expect(result.isError ?? false).toBe(false)
    expect(exits).toEqual([0])
    expect(sent.map((payload) => payload.event.name)).toEqual([
      'agent-qa.mcp.server.lifecycle',
      'agent-qa.mcp.tool.invoked',
      'agent-qa.mcp.server.lifecycle',
    ])
    expect(toolEvents(sent)).toEqual([
      expect.objectContaining({
        tool_name: 'agent_qa_list_runs',
        mcp_tool_status: 'success',
        mcp_transport: 'http',
      }),
    ])
  })
})

describe('an observer that throws inside', () => {
  it('changes no tool result', async () => {
    await startReporting()
    const reached: string[] = []
    const analytics = await recordingAnalytics()
    const throwing: CliAnalyticsHost = {
      ...analytics.host,
      port: {
        capture: () => {
          reached.push('capture')
          throw new Error('the analytics port failed')
        },
        flush: async () => {},
        shutdown: async () => {},
      },
    }
    const observe = createToolSettledObserver({
      analytics: { host: throwing, mcpTransport: 'http' },
    })
    const settle = () => observe({ tool: 'agent_qa_mark_run', durationMs: 3, outcome: 'success' })
    expect(settle).not.toThrow()

    const registry = markRegistry(async () => RUN_NOT_FOUND)
    const plain = await (await serve({ registry, maskText: unmasked })).callTool(MARK)
    const observed = await (
      await serve({
        registry,
        maskText: unmasked,
        analytics: { host: throwing, mcpTransport: 'http' },
      })
    ).callTool(MARK)

    expect(JSON.stringify(observed)).toBe(JSON.stringify(plain))
    expect(reached).toEqual(['capture', 'capture'])
  })
})
