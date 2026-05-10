import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  ENTITY_ID_TYPES,
  generateCanonicalId,
  getEntityIdContracts,
} from '@vostride/agent-qa-ids'
import {
  getAgentQaVersion,
  type AnalyticsService,
  type BuiltAnalyticsEvent,
} from '@vostride/agent-qa-core'
import {
  AGENT_QA_SCHEMA_REFERENCES,
  classifyRunFailureFromDashboardData,
  createAgentQaMcpServer,
  resolveDashboardApiUrl,
  resolveLocalMcpEndpoint,
  resolveMcpEndpointShape,
  validateAgentQaDefinition,
} from '../index.js'

afterEach(() => {
  vi.restoreAllMocks()
})

async function callRegisteredTool(
  mcpServer: unknown,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const tools = (mcpServer as {
    _registeredTools: Record<string, { handler: (input: Record<string, unknown>, extra: unknown) => Promise<unknown> }>
  })._registeredTools
  return tools[name].handler(args, {})
}

function createAnalyticsRecorder(): {
  events: BuiltAnalyticsEvent[]
  service: AnalyticsService
} {
  const events: BuiltAnalyticsEvent[] = []
  return {
    events,
    service: {
      capture: vi.fn(async (event: BuiltAnalyticsEvent) => {
        events.push(event)
      }),
      flush: vi.fn(),
    },
  }
}

const canonicalRunId = 'r_alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india-juliet'
const phase245PrivacySentinels = [
  'phase245-prompt-secret',
  'phase245-yaml-secret',
  'phase245-artifact-secret',
  'phase245-log-secret',
  'phase245-memory-secret',
  'phase245-config-secret',
  'phase245-hook-secret',
  'phase245-error-secret',
  'https://phase245-secret.example',
  '/Users/phase245/private.yaml',
] as const

describe('agent-qa MCP schema references', () => {
  it('keeps ID references aligned with the shared id-agent contract', () => {
    expect(AGENT_QA_SCHEMA_REFERENCES.ids.contracts).toEqual(getEntityIdContracts())
    expect(AGENT_QA_SCHEMA_REFERENCES.ids.contracts.map(contract => contract.type)).toEqual(ENTITY_ID_TYPES)
  })

  it('keeps the local skills reference file aligned with the shared ID contract', () => {
    const reference = JSON.parse(readFileSync(new URL('../../references/agent-qa-contracts.json', import.meta.url), 'utf-8'))
    expect(reference.ids.contracts).toEqual(getEntityIdContracts())
  })

  it('validates definitions with core schemas and returns field paths', () => {
    const result = validateAgentQaDefinition('test', {
      name: 'Missing ID',
      target: 'web',
      steps: [],
    })

    expect(result.valid).toBe(false)
    expect(result.issues.some(issue => issue.path === 'test-id')).toBe(true)
    expect(result.issues.some(issue => issue.path === 'steps')).toBe(true)
  })

  it('accepts canonical IDs in test definitions', () => {
    const result = validateAgentQaDefinition('test', {
      'test-id': generateCanonicalId('test'),
      name: 'Valid test',
      target: 'web',
      steps: ['Navigate to https://example.com'],
    })

    expect(result).toEqual({
      valid: true,
      kind: 'test',
      issues: [],
    })
  })

  it('normalizes local endpoint defaults', () => {
    expect(resolveLocalMcpEndpoint({})).toMatchObject({
      enabled: true,
      transport: 'http',
      host: '127.0.0.1',
      port: 3471,
      path: '/mcp',
      url: 'http://127.0.0.1:3471/mcp',
    })
  })

  it('resolves MCP endpoint analytics shape without raw endpoint details', () => {
    expect(resolveMcpEndpointShape(resolveLocalMcpEndpoint({}))).toEqual({
      mcp_host_kind: 'loopback',
      mcp_port_kind: 'default',
      mcp_path_kind: 'default',
    })

    expect(resolveMcpEndpointShape(resolveLocalMcpEndpoint({
      host: '0.0.0.0',
      port: 9999,
      path: '/custom-mcp',
    }))).toEqual({
      mcp_host_kind: 'other',
      mcp_port_kind: 'custom',
      mcp_path_kind: 'custom',
    })
  })

  it('resolves dashboard API URLs without losing nested paths', () => {
    expect(resolveDashboardApiUrl('http://127.0.0.1:3470', '/api/tests')).toBe('http://127.0.0.1:3470/api/tests')
    expect(resolveDashboardApiUrl('http://127.0.0.1:3470/base/', 'api/hooks/h_123')).toBe('http://127.0.0.1:3470/base/api/hooks/h_123')
  })

  it('classifies timeout failures with evidence', () => {
    const result = classifyRunFailureFromDashboardData({
      runDetail: {
        run: {
          status: 'failed',
          failureSummary: 'Test timed out -- process was killed',
        },
      },
    })

    expect(result.category).toBe('timeout')
    expect(result.confidence).toBeGreaterThan(0.8)
    expect(result.evidence[0]).toContain('timed out')
  })

  it('classifies element lookup failures from logs', () => {
    const result = classifyRunFailureFromDashboardData({
      runDetail: { run: { status: 'failed' } },
      logs: { logs: [{ message: 'Locator not found for Login button' }] },
      recentRuns: { runs: [{ id: 'r_one' }, { id: 'r_two' }] },
    })

    expect(result.category).toBe('element_not_found')
    expect(result.recentRelatedCount).toBe(2)
  })

  it('creates the shared MCP server factory for stdio and HTTP transports', () => {
    const server = createAgentQaMcpServer({
      configPath: '/tmp/agent-qa.config.yaml',
      endpointUrl: 'http://127.0.0.1:3471/mcp',
    })

    expect(server).toBeDefined()
    expect(server.server).toBeDefined()
    expect((server.server as unknown as { _serverInfo?: { version?: string } })._serverInfo?.version)
      .toBe(getAgentQaVersion())
  })

  it('marks dashboard test enqueue requests as MCP-triggered', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ runId: 'r_mcp-test', status: 'queued' }), { status: 202 }),
    )
    const server = createAgentQaMcpServer({ dashboardUrl: 'http://127.0.0.1:3470' })

    await callRegisteredTool(server, 'agent_qa_enqueue_test_run', {
      file: 'tests/login.yaml',
      patterns: ['tests/smoke/*.yaml'],
      noCache: true,
      local: true,
    })

    const [, init] = fetchSpy.mock.calls[0]
    const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>
    expect(fetchSpy.mock.calls[0][0]).toBe('http://127.0.0.1:3470/api/runs/trigger')
    expect(body).toMatchObject({
      file: 'tests/login.yaml',
      patterns: ['tests/smoke/*.yaml'],
      noCache: true,
      local: true,
      triggerSource: 'mcp',
    })
  })

  it('marks dashboard suite enqueue requests as MCP-triggered', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ runId: 'r_mcp-suite', status: 'queued' }), { status: 202 }),
    )
    const server = createAgentQaMcpServer({ dashboardUrl: 'http://127.0.0.1:3470' })

    await callRegisteredTool(server, 'agent_qa_enqueue_suite_run', {
      file: 'suites/smoke.suite.yaml',
      noMemory: true,
      local: false,
    })

    const [, init] = fetchSpy.mock.calls[0]
    const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>
    expect(body).toMatchObject({
      file: 'suites/smoke.suite.yaml',
      noMemory: true,
      local: false,
      triggerSource: 'mcp',
    })
  })

  it('emits one generic MCP tool telemetry event with tool category and duration', async () => {
    const analytics = createAnalyticsRecorder()
    const server = createAgentQaMcpServer({
      analyticsService: analytics.service,
      analyticsStandardProperties: { surface: 'mcp', runtime_context: 'agent' },
      transport: 'http',
    })

    await callRegisteredTool(server, 'agent_qa_discover', {})
    await callRegisteredTool(server, 'agent_qa_schema_reference', { schema: 'config' })
    await callRegisteredTool(server, 'agent_qa_generate_id', { type: 'run' })

    expect(analytics.events).toHaveLength(3)
    expect(analytics.events.map(event => event.name)).toEqual([
      'agent-qa.mcp.tool.invoked',
      'agent-qa.mcp.tool.invoked',
      'agent-qa.mcp.tool.invoked',
    ])
    expect(analytics.events.map(event => event.properties.mcp_tool_category)).toEqual([
      'discovery',
      'schema',
      'id',
    ])
    expect(analytics.events[0].properties).toMatchObject({
      agent_qa_version: getAgentQaVersion(),
      tool_name: 'agent_qa_discover',
      mcp_tool_status: 'success',
      mcp_transport: 'http',
      surface: 'mcp',
      runtime_context: 'agent',
      $process_person_profile: false,
    })
    expect(analytics.events[0].properties.duration_ms).toEqual(expect.any(Number))
    expect(analytics.events[0].properties.duration_ms as number).toBeGreaterThanOrEqual(0)
  })

  it('categorizes dashboard-backed authoring, hook, run, and triage tools without leaking input or result content', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/api/hooks')) {
        return new Response(JSON.stringify({ ok: true, hookId: 'h_phase245-hook-secret', source: 'phase245-hook-secret' }), { status: 200 })
      }
      if (url.includes('/artifact')) {
        return new Response(JSON.stringify({ artifact: 'phase245-artifact-secret', memory: 'phase245-memory-secret' }), { status: 200 })
      }
      if (url.includes('/execution-logs') || url.includes('/logs')) {
        return new Response(JSON.stringify({ logs: ['phase245-log-secret'] }), { status: 200 })
      }
      if (url.includes('/api/runs?')) {
        return new Response(JSON.stringify({ runs: [{ id: canonicalRunId, name: 'phase245-prompt-secret' }] }), { status: 200 })
      }
      if (url.includes('/api/runs/')) {
        return new Response(JSON.stringify({
          run: {
            status: 'failed',
            failureSummary: 'phase245-error-secret',
            name: 'phase245-prompt-secret',
          },
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })
    const analytics = createAnalyticsRecorder()
    const server = createAgentQaMcpServer({
      dashboardUrl: 'http://127.0.0.1:3470',
      analyticsService: analytics.service,
      analyticsStandardProperties: { surface: 'mcp', runtime_context: 'agent' },
    })

    await callRegisteredTool(server, 'agent_qa_create_test', {
      dashboardUrl: 'https://phase245-secret.example',
      path: '/Users/phase245/private.yaml',
      content: 'phase245-yaml-secret phase245-prompt-secret phase245-memory-secret',
    })
    await callRegisteredTool(server, 'agent_qa_create_hook', {
      payload: { source: 'phase245-hook-secret', config: 'phase245-config-secret' },
    })
    await callRegisteredTool(server, 'agent_qa_get_run_artifact', { runId: canonicalRunId })
    await callRegisteredTool(server, 'agent_qa_get_run_logs', { runId: canonicalRunId, source: 'phase245-log-secret' })
    await callRegisteredTool(server, 'agent_qa_get_run_execution_logs', { runId: canonicalRunId, type: 'phase245-log-secret' })
    await callRegisteredTool(server, 'agent_qa_classify_failure', { runId: canonicalRunId })

    expect(analytics.events.map(event => event.properties.mcp_tool_category)).toEqual([
      'authoring',
      'hook',
      'run',
      'run',
      'run',
      'triage',
    ])
    const serializedEvents = JSON.stringify(analytics.events)
    for (const sentinel of phase245PrivacySentinels) {
      expect(serializedEvents).not.toContain(sentinel)
    }
  })

  it('attaches run_id only from explicit canonical runId or successful enqueue canonical response IDs', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ runId: canonicalRunId, testId: 't_phase245-secret' }), { status: 202 }))
    const analytics = createAnalyticsRecorder()
    const server = createAgentQaMcpServer({
      dashboardUrl: 'http://127.0.0.1:3470',
      analyticsService: analytics.service,
      analyticsStandardProperties: { surface: 'mcp', runtime_context: 'agent' },
    })

    await callRegisteredTool(server, 'agent_qa_get_run', { runId: canonicalRunId })
    await callRegisteredTool(server, 'agent_qa_enqueue_test_run', { file: 'tests/phase245-secret.yaml' })
    await callRegisteredTool(server, 'agent_qa_validate_id', { type: 'run', id: canonicalRunId })

    expect(analytics.events[0].properties.run_id).toBe(canonicalRunId)
    expect(analytics.events[1].properties.run_id).toBe(canonicalRunId)
    expect(analytics.events[2].properties.run_id).toBeUndefined()
    expect(JSON.stringify(analytics.events)).not.toContain('tests/phase245-secret.yaml')
    expect(JSON.stringify(analytics.events)).not.toContain('t_phase245-secret')
  })

  it('emits coarse error telemetry without exposing dashboard status text or messages', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ message: 'phase245-error-secret' }), {
        status: 500,
        statusText: 'phase245-status-secret',
      }),
    )
    const analytics = createAnalyticsRecorder()
    const server = createAgentQaMcpServer({
      dashboardUrl: 'http://127.0.0.1:3470',
      analyticsService: analytics.service,
      analyticsStandardProperties: { surface: 'mcp', runtime_context: 'agent' },
    })

    await callRegisteredTool(server, 'agent_qa_list_tests', {})

    expect(analytics.events).toHaveLength(1)
    expect(analytics.events[0].properties).toMatchObject({
      tool_name: 'agent_qa_list_tests',
      mcp_tool_status: 'error',
      mcp_tool_category: 'authoring',
      mcp_error_category: 'dashboard_error',
    })
    expect(JSON.stringify(analytics.events[0])).not.toContain('phase245-error-secret')
    expect(JSON.stringify(analytics.events[0])).not.toContain('phase245-status-secret')
  })

  it('emits error status for MCP error results with coarse categories only', async () => {
    const analytics = createAnalyticsRecorder()
    const server = createAgentQaMcpServer({
      analyticsService: analytics.service,
      analyticsStandardProperties: { surface: 'mcp', runtime_context: 'agent' },
    })

    await expect(callRegisteredTool(server, 'agent_qa_get_config', { configPath: '/Users/phase245/private.yaml' }))
      .rejects.toThrow()

    expect(analytics.events).toHaveLength(1)
    expect(analytics.events[0].properties).toMatchObject({
      tool_name: 'agent_qa_get_config',
      mcp_tool_status: 'error',
      mcp_error_category: 'tool_error',
    })
    expect(JSON.stringify(analytics.events[0])).not.toContain('/Users/phase245/private.yaml')
  })

  it('skips MCP tool telemetry when analytics privacy is enabled', async () => {
    const analytics = createAnalyticsRecorder()
    const server = createAgentQaMcpServer({
      analyticsService: analytics.service,
      analyticsConfig: { analytics: { privacy: true } },
      analyticsStandardProperties: { surface: 'mcp', runtime_context: 'agent' },
    })

    const result = await callRegisteredTool(server, 'agent_qa_discover', {})

    expect(JSON.stringify(result)).toContain('agent_qa_discover')
    expect(analytics.events).toHaveLength(0)
    expect(analytics.service.capture).not.toHaveBeenCalled()
  })

  it('returns the original MCP tool result when analytics capture rejects', async () => {
    const analyticsService: AnalyticsService = {
      capture: vi.fn(async () => {
        throw new Error('phase245 analytics failure')
      }),
      flush: vi.fn(),
    }
    const server = createAgentQaMcpServer({
      analyticsService,
      analyticsStandardProperties: { surface: 'mcp', runtime_context: 'agent' },
    })

    const result = await callRegisteredTool(server, 'agent_qa_discover', {})

    expect(JSON.stringify(result)).toContain('agent_qa_discover')
    expect(analyticsService.capture).toHaveBeenCalledOnce()
  })

  it('emits stdio lifecycle telemetry after connect without endpoint or config details', async () => {
    const connect = vi.fn(async (_transport: unknown) => {})
    vi.resetModules()
    vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
      StdioServerTransport: class MockStdioServerTransport {},
    }))
    vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
      McpServer: class MockMcpServer {
        server = {}

        registerTool() {
          return this
        }

        registerResource() {
          return this
        }

        registerPrompt() {
          return this
        }

        async connect(transport: unknown) {
          await connect(transport)
        }
      },
    }))

    try {
      const { startMcpServer } = await import('../server.js')
      const analytics = createAnalyticsRecorder()

      await startMcpServer({
        analyticsService: analytics.service,
        analyticsStandardProperties: { surface: 'mcp', runtime_context: 'agent' },
        configPath: '/Users/phase245/private.yaml',
        endpointUrl: 'https://phase245-secret.example',
      })

      expect(connect).toHaveBeenCalledOnce()
      expect(analytics.events).toHaveLength(1)
      expect(analytics.events[0]).toEqual(expect.objectContaining({
        name: 'agent-qa.mcp.server.lifecycle',
        properties: expect.objectContaining({
          surface: 'mcp',
          runtime_context: 'agent',
          mcp_server_state: 'started',
          mcp_transport: 'stdio',
          $process_person_profile: false,
        }),
      }))
      expect(analytics.events[0].properties).not.toHaveProperty('mcp_host_kind')
      expect(analytics.events[0].properties).not.toHaveProperty('mcp_port_kind')
      expect(analytics.events[0].properties).not.toHaveProperty('mcp_path_kind')
      const serializedEvents = JSON.stringify(analytics.events)
      expect(serializedEvents).not.toContain('https://phase245-secret.example')
      expect(serializedEvents).not.toContain('/Users/phase245/private.yaml')

      const rejectingAnalyticsService: AnalyticsService = {
        capture: vi.fn(async () => {
          throw new Error('phase245 analytics failure')
        }),
        flush: vi.fn(),
      }
      await expect(startMcpServer({
        analyticsService: rejectingAnalyticsService,
        analyticsStandardProperties: { surface: 'mcp', runtime_context: 'agent' },
      })).resolves.toBeUndefined()
      expect(connect).toHaveBeenCalledTimes(2)
      expect(rejectingAnalyticsService.capture).toHaveBeenCalledOnce()
    } finally {
      vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js')
      vi.doUnmock('@modelcontextprotocol/sdk/server/mcp.js')
      vi.resetModules()
    }
  })
})
