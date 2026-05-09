import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AnySchema, ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js'
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import {
  AgentQaConfigSchema,
  buildAnalyticsEvent,
  captureAnalytics,
  createAnalyticsService,
  getAgentQaVersion,
  resolveAnalyticsStandardProperties,
  type AnalyticsEventProperties,
  type AnalyticsService,
  type AnalyticsServiceConfig,
} from '@vostride/agent-qa-core'
import {
  ENTITY_ID_TYPES,
  generateCanonicalId,
  getEntityIdContract,
  getEntityIdContracts,
  isCanonicalId,
} from '@vostride/agent-qa-ids'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import {
  AGENT_QA_SCHEMA_REFERENCES,
  SCHEMA_REFERENCE_NAMES,
  VALIDATION_KINDS,
  validateAgentQaDefinition,
  type SchemaReferenceName,
  type ValidationKind,
} from './schema-reference.js'

export interface AgentQaMcpServerOptions {
  configPath?: string
  dashboardUrl?: string
  endpointUrl?: string
  analyticsService?: AnalyticsService
  analyticsConfig?: AnalyticsServiceConfig
  analyticsStandardProperties?: AnalyticsEventProperties
  transport?: 'stdio' | 'http'
}

type McpToolCategory = NonNullable<AnalyticsEventProperties['mcp_tool_category']>
type McpErrorCategory = NonNullable<AnalyticsEventProperties['mcp_error_category']>
type McpToolDefinition<
  OutputArgs extends ZodRawShapeCompat | AnySchema = ZodRawShapeCompat,
  InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined,
> = {
  title?: string
  description?: string
  inputSchema?: InputArgs
  outputSchema?: OutputArgs
  annotations?: ToolAnnotations
  _meta?: Record<string, unknown>
}

const DISCOVERY = {
  name: 'agent-qa',
  purpose: 'Author, validate, run, and triage agent-qa tests through local trusted MCP.',
  tools: [
    'agent_qa_discover',
    'agent_qa_get_config',
    'agent_qa_schema_reference',
    'agent_qa_validate_definition',
    'agent_qa_generate_id',
    'agent_qa_validate_id',
    'agent_qa_list_tests',
    'agent_qa_read_test',
    'agent_qa_validate_test',
    'agent_qa_create_test',
    'agent_qa_update_test',
    'agent_qa_delete_test',
    'agent_qa_list_suites',
    'agent_qa_read_suite',
    'agent_qa_validate_suite',
    'agent_qa_create_suite',
    'agent_qa_update_suite',
    'agent_qa_delete_suite',
    'agent_qa_list_hooks',
    'agent_qa_read_hook',
    'agent_qa_create_hook',
    'agent_qa_update_hook',
    'agent_qa_delete_hook',
    'agent_qa_run_hook',
    'agent_qa_enqueue_test_run',
    'agent_qa_enqueue_suite_run',
    'agent_qa_get_run',
    'agent_qa_get_run_steps',
    'agent_qa_get_run_logs',
    'agent_qa_get_run_execution_logs',
    'agent_qa_get_run_artifact',
    'agent_qa_cancel_run',
    'agent_qa_classify_failure',
  ],
  resources: SCHEMA_REFERENCE_NAMES.map(name => `agent-qa://schema/${name}`),
  prompts: ['agent_qa_authoring_context'],
  phases: {
    current: 'discovery-schema-id-contracts',
    next: ['authoring tools', 'run execution and triage tools'],
  },
}

function jsonContent(value: unknown) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(value, null, 2),
    }],
  }
}

function errorContent(message: string) {
  return {
    isError: true,
    content: [{
      type: 'text' as const,
      text: message,
    }],
  }
}

export function categorizeMcpTool(name: string): McpToolCategory {
  if (name === 'agent_qa_discover') return 'discovery'
  if (name.includes('schema') || name.includes('definition') || name.includes('config')) return 'schema'
  if (name.includes('_id')) return 'id'
  if (name.includes('_hook')) return 'hook'
  if (name.includes('classify')) return 'triage'
  if (name.includes('_run') || name.includes('_logs') || name.includes('_artifact') || name.includes('_fix') || name.includes('_failure')) return 'run'
  if (name.includes('_test') || name.includes('_suite')) return 'authoring'
  return 'unknown'
}

function isErrorResult(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && (value as { isError?: unknown }).isError === true)
}

function isDashboardErrorResult(value: unknown): boolean {
  const parsed = parseToolJsonContent(value)
  return Boolean(parsed && typeof parsed === 'object' && (parsed as Record<string, unknown>).ok === false)
}

function parseToolJsonContent(value: unknown): unknown {
  if (!value || typeof value !== 'object') return undefined
  const content = (value as { content?: unknown }).content
  if (!Array.isArray(content)) return undefined
  const firstText = content.find(item =>
    item && typeof item === 'object'
    && (item as { type?: unknown }).type === 'text'
    && typeof (item as { text?: unknown }).text === 'string'
  ) as { text: string } | undefined
  if (!firstText) return undefined
  try {
    return JSON.parse(firstText.text)
  } catch {
    return undefined
  }
}

export function categorizeMcpError(errOrResult: unknown): McpErrorCategory {
  if (errOrResult instanceof z.ZodError) return 'validation'
  const parsed = parseToolJsonContent(errOrResult)
  const candidate = parsed && typeof parsed === 'object'
    ? parsed as Record<string, unknown>
    : undefined
  if (candidate && candidate.ok === false) return 'dashboard_error'
  if (errOrResult instanceof Error) return 'tool_error'
  if (isErrorResult(errOrResult)) return 'tool_error'
  return 'unknown'
}

export function extractExplicitCanonicalRunId(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const runId = (input as Record<string, unknown>).runId
  return typeof runId === 'string' && isCanonicalId('run', runId) ? runId : undefined
}

export function extractSuccessfulEnqueueRunId(result: unknown): string | undefined {
  if (isErrorResult(result)) return undefined
  const parsed = parseToolJsonContent(result)
  const container = parsed && typeof parsed === 'object'
    ? parsed as Record<string, unknown>
    : undefined
  if (!container) return undefined
  const body = container.body && typeof container.body === 'object'
    ? container.body as Record<string, unknown>
    : container
  for (const key of ['runId', 'id', 'parentRunId']) {
    const value = body[key]
    if (typeof value === 'string' && isCanonicalId('run', value)) return value
  }
  return undefined
}

export function resolveDashboardApiUrl(dashboardUrl: string, apiPath: string): string {
  const base = dashboardUrl.endsWith('/') ? dashboardUrl : `${dashboardUrl}/`
  const normalizedPath = apiPath.startsWith('/') ? apiPath.slice(1) : apiPath
  return new URL(normalizedPath, base).toString()
}

function withQuery(path: string, query: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value))
  }
  const queryString = params.toString()
  return queryString ? `${path}?${queryString}` : path
}

async function callDashboardApi(input: {
  dashboardUrl: string
  path: string
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: unknown
}): Promise<{
  ok: boolean
  status: number
  body: unknown
}> {
  const response = await fetch(resolveDashboardApiUrl(input.dashboardUrl, input.path), {
    method: input.method ?? 'GET',
    headers: input.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  })
  const text = await response.text()
  let body: unknown = null
  if (text.length > 0) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }

  return {
    ok: response.ok,
    status: response.status,
    body,
  }
}

export type FailureCategory =
  | 'passed'
  | 'timeout'
  | 'appium_startup'
  | 'browser_disconnect'
  | 'element_not_found'
  | 'assertion_failure'
  | 'hook_failure'
  | 'infrastructure'
  | 'unknown_failure'

export interface FailureClassification {
  category: FailureCategory
  confidence: number
  evidence: string[]
  recentRelatedCount: number
}

function collectStrings(value: unknown, output: string[] = [], limit = 80): string[] {
  if (output.length >= limit) return output
  if (typeof value === 'string' && value.trim().length > 0) {
    output.push(value)
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output, limit)
  } else if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) collectStrings(child, output, limit)
  }
  return output
}

function classifyByNeedle(
  haystack: string,
  evidence: string[],
  needles: string[],
  category: FailureCategory,
  confidence: number,
): FailureClassification | null {
  const match = needles.find(needle => haystack.includes(needle))
  if (!match) return null
  const matchingEvidence = evidence.find(item => item.toLowerCase().includes(match)) ?? evidence[0] ?? match
  return {
    category,
    confidence,
    evidence: [matchingEvidence].filter(Boolean).slice(0, 5),
    recentRelatedCount: 0,
  }
}

export function classifyRunFailureFromDashboardData(input: {
  runDetail: unknown
  artifact?: unknown
  logs?: unknown
  executionLogs?: unknown
  recentRuns?: unknown
}): FailureClassification {
  const run = input.runDetail && typeof input.runDetail === 'object'
    ? (input.runDetail as Record<string, unknown>).run
    : undefined
  const status = run && typeof run === 'object'
    ? (run as Record<string, unknown>).status
    : undefined
  const evidence = collectStrings([input.runDetail, input.artifact, input.logs, input.executionLogs])
  const haystack = evidence.join('\n').toLowerCase()
  const recentRelatedCount = Array.isArray((input.recentRuns as Record<string, unknown> | undefined)?.runs)
    ? ((input.recentRuns as Record<string, unknown>).runs as unknown[]).length
    : 0

  if (status && status !== 'failed') {
    return {
      category: 'passed',
      confidence: 0.95,
      evidence: [`Run status is ${String(status)}.`],
      recentRelatedCount,
    }
  }

  const checks: Array<[string[], FailureCategory, number]> = [
    [['timed out', 'timeout'], 'timeout', 0.9],
    [['appium server failed', 'appium'], 'appium_startup', 0.9],
    [['browser closed', 'target page, context or browser has been closed', 'browser disconnect'], 'browser_disconnect', 0.85],
    [['hook_not_runnable', 'hook failed', 'hook registry', 'hook'], 'hook_failure', 0.8],
    [['not found', 'no element', 'strict mode violation', 'selector'], 'element_not_found', 0.8],
    [['assert', 'expected', 'verify'], 'assertion_failure', 0.75],
    [['econnrefused', 'enotfound', 'network', 'docker'], 'infrastructure', 0.7],
  ]

  for (const [needles, category, confidence] of checks) {
    const result = classifyByNeedle(haystack, evidence, needles, category, confidence)
    if (result) return { ...result, recentRelatedCount }
  }

  return {
    category: 'unknown_failure',
    confidence: 0.3,
    evidence: evidence.slice(0, 5),
    recentRelatedCount,
  }
}

function maskSensitive(value: unknown, parentKey = ''): unknown {
  const lower = parentKey.toLowerCase()
  if (typeof value === 'string' && (
    lower.includes('key')
    || lower.includes('token')
    || lower.includes('secret')
    || lower.includes('password')
  )) {
    return value.length > 8 ? `${value.slice(0, 3)}****${value.slice(-4)}` : '****'
  }
  if (Array.isArray(value)) return value.map(item => maskSensitive(item, parentKey))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, maskSensitive(child, key)]),
    )
  }
  return value
}

async function readConfig(configPath?: string): Promise<{
  path: string
  raw: unknown
  valid: boolean
  issues: Array<{ path: string; message: string }>
  summary: Record<string, unknown>
}> {
  const path = resolve(configPath ?? 'agent-qa.config.yaml')
  const content = await readFile(path, 'utf-8')
  const raw = parseYaml(content) ?? {}
  const validation = AgentQaConfigSchema.safeParse(raw)
  const record = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {}
  const registry = record.registry && typeof record.registry === 'object' && !Array.isArray(record.registry)
    ? record.registry as Record<string, unknown>
    : {}
  const services = record.services && typeof record.services === 'object' && !Array.isArray(record.services)
    ? record.services as Record<string, unknown>
    : {}

  return {
    path,
    raw: maskSensitive(raw),
    valid: validation.success,
    issues: validation.success
      ? []
      : validation.error.issues.map(issue => ({
          path: issue.path.map(String).join('.') || '(root)',
          message: issue.message,
        })),
    summary: {
      workspaceConfigured: Boolean(record.workspace),
      serviceKeys: Object.keys(services),
      targetNames: Object.keys((registry.targets as Record<string, unknown> | undefined) ?? {}),
      deviceNames: Object.keys((registry.devices as Record<string, unknown> | undefined) ?? {}),
      providerNames: Object.keys((registry.providers as Record<string, unknown> | undefined) ?? {}),
      llmNames: Array.isArray(registry.llms)
        ? registry.llms
            .map(llm => llm && typeof llm === 'object' ? (llm as Record<string, unknown>).name : undefined)
            .filter((name): name is string => typeof name === 'string')
        : [],
    },
  }
}

export function createAgentQaMcpServer(options: AgentQaMcpServerOptions = {}): McpServer {
  const server = new McpServer({
    name: 'agent-qa',
    version: getAgentQaVersion(),
  })
  const analyticsService = options.analyticsService ?? createAnalyticsService({ config: options.analyticsConfig })
  const analyticsTransport = options.transport ?? 'stdio'
  const registerAnalyticsTool = <
    OutputArgs extends ZodRawShapeCompat | AnySchema = ZodRawShapeCompat,
    InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined,
  >(
    name: string,
    definition: McpToolDefinition<OutputArgs, InputArgs>,
    handler: ToolCallback<InputArgs>,
  ) => server.registerTool(name, definition, (async (input: unknown, extra: unknown) => {
    const startedAt = Date.now()
    let result: unknown
    let thrown: unknown

    try {
      result = await (handler as (input: unknown, extra: unknown) => unknown | Promise<unknown>)(input, extra)
      return result
    } catch (err) {
      thrown = err
      throw err
    } finally {
      const isError = thrown !== undefined || isErrorResult(result) || isDashboardErrorResult(result)
      const explicitRunId = extractExplicitCanonicalRunId(input)
      const enqueueRunId = !isError && (name === 'agent_qa_enqueue_test_run' || name === 'agent_qa_enqueue_suite_run')
        ? extractSuccessfulEnqueueRunId(result)
        : undefined

      try {
        if (options.analyticsConfig?.analytics?.privacy !== true) {
          const standardProperties = options.analyticsStandardProperties
            ?? await resolveAnalyticsStandardProperties({ surface: 'mcp' })
          const event = buildAnalyticsEvent({
            name: 'agent-qa.mcp.tool.invoked',
            properties: {
              ...standardProperties,
              surface: standardProperties.surface ?? 'mcp',
              tool_name: name,
              mcp_tool_category: categorizeMcpTool(name),
              mcp_tool_status: isError ? 'error' : 'success',
              duration_ms: Math.max(0, Date.now() - startedAt),
              mcp_transport: analyticsTransport,
              ...(isError ? { mcp_error_category: categorizeMcpError(thrown ?? result) } : {}),
              ...(explicitRunId ?? enqueueRunId ? { run_id: explicitRunId ?? enqueueRunId } : {}),
            },
          })

          if (options.analyticsService) {
            await analyticsService.capture(event).catch(() => {})
          } else {
            await captureAnalytics(event, {
              config: options.analyticsConfig,
              surface: 'mcp',
            }).catch(() => {})
          }
        }
      } catch {
        // MCP analytics must never alter tool behavior.
      }
    }
  }) as ToolCallback<InputArgs>)
  const dashboardUrlField = z.string().url().optional().describe('Dashboard base URL; defaults to the MCP server dashboard URL.')
  const dashboardUrlFor = (inputUrl?: string): string => {
    const dashboardUrl = inputUrl ?? options.dashboardUrl
    if (!dashboardUrl) {
      throw new Error('dashboardUrl is required for authoring tools. Start MCP via `agent-qa dashboard` or pass dashboardUrl.')
    }
    return dashboardUrl
  }
  const dashboardTool = async (
    dashboardUrl: string | undefined,
    path: string,
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE',
    body?: unknown,
  ) => {
    try {
      const result = await callDashboardApi({
        dashboardUrl: dashboardUrlFor(dashboardUrl),
        path,
        method,
        body,
      })
      return jsonContent(result)
    } catch (err) {
      return errorContent(err instanceof Error ? err.message : String(err))
    }
  }

  registerAnalyticsTool(
    'agent_qa_discover',
    {
      title: 'Discover agent-qa MCP capabilities',
      description: 'Return structured metadata for agent-qa MCP tools, resources, prompts, and current rollout scope.',
      inputSchema: {},
    },
    async () => jsonContent({
      ...DISCOVERY,
      endpoint: options.endpointUrl,
      dashboard: options.dashboardUrl,
      configPath: options.configPath,
    }),
  )

  registerAnalyticsTool(
    'agent_qa_get_config',
    {
      title: 'Inspect agent-qa config',
      description: 'Read the active agent-qa config and return a masked raw config plus targets/devices/providers summary.',
      inputSchema: {
        configPath: z.string().optional().describe('Config path; defaults to the MCP server config path or agent-qa.config.yaml'),
        section: z.enum(['raw', 'summary']).optional().describe('Return full masked raw config or summary only'),
      },
    },
    async ({ configPath, section }) => {
      const config = await readConfig(configPath ?? options.configPath)
      return jsonContent(section === 'summary'
        ? { path: config.path, valid: config.valid, issues: config.issues, summary: config.summary }
        : config)
    },
  )

  registerAnalyticsTool(
    'agent_qa_schema_reference',
    {
      title: 'Get agent-qa schema reference',
      description: 'Return structured references for config, test YAML, suite YAML, hooks, or canonical IDs.',
      inputSchema: {
        schema: z.enum(SCHEMA_REFERENCE_NAMES).describe('Reference name to return'),
      },
    },
    async ({ schema }) => jsonContent(AGENT_QA_SCHEMA_REFERENCES[schema as SchemaReferenceName]),
  )

  registerAnalyticsTool(
    'agent_qa_validate_definition',
    {
      title: 'Validate agent-qa definition',
      description: 'Validate config/test/suite/hooks objects with the same core schemas agent-qa uses.',
      inputSchema: {
        kind: z.enum(VALIDATION_KINDS).describe('Definition kind'),
        definition: z.unknown().describe('Parsed config/test/suite/hooks object'),
      },
    },
    async ({ kind, definition }) => jsonContent(validateAgentQaDefinition(kind as ValidationKind, definition)),
  )

  registerAnalyticsTool(
    'agent_qa_generate_id',
    {
      title: 'Generate canonical agent-qa ID',
      description: 'Generate a canonical id-agent backed ID for a test, suite, hook, run, or observation.',
      inputSchema: {
        type: z.enum(ENTITY_ID_TYPES).describe('ID entity type'),
      },
    },
    async ({ type }) => {
      const idType = type as typeof ENTITY_ID_TYPES[number]
      return jsonContent({
        id: generateCanonicalId(idType),
        type: idType,
        contract: getEntityIdContract(idType),
      })
    },
  )

  registerAnalyticsTool(
    'agent_qa_validate_id',
    {
      title: 'Validate canonical agent-qa ID',
      description: 'Validate canonical id-agent backed IDs and return the expected contract.',
      inputSchema: {
        type: z.enum(ENTITY_ID_TYPES).describe('ID entity type'),
        id: z.string().describe('ID to validate'),
      },
    },
    async ({ type, id }) => {
      const idType = type as typeof ENTITY_ID_TYPES[number]
      const contract = getEntityIdContract(idType)
      const valid = isCanonicalId(idType, id)
      return jsonContent({
        valid,
        id,
        type: idType,
        contract,
        message: valid
          ? 'ID is canonical.'
          : `Expected ${contract.prefixWithSeparator} followed by ${contract.words} id-agent words.`,
      })
    },
  )

  registerAnalyticsTool(
    'agent_qa_list_tests',
    {
      title: 'List agent-qa tests',
      description: 'List tests through the dashboard API using dashboard workspace discovery.',
      inputSchema: { dashboardUrl: dashboardUrlField },
    },
    async ({ dashboardUrl }) => dashboardTool(dashboardUrl, '/api/tests'),
  )

  registerAnalyticsTool(
    'agent_qa_read_test',
    {
      title: 'Read agent-qa test',
      description: 'Read a test by canonical test ID through the dashboard API.',
      inputSchema: {
        dashboardUrl: dashboardUrlField,
        testId: z.string().describe('Canonical t_ test ID'),
      },
    },
    async ({ dashboardUrl, testId }) => dashboardTool(dashboardUrl, `/api/tests/${encodeURIComponent(testId)}`),
  )

  registerAnalyticsTool(
    'agent_qa_validate_test',
    {
      title: 'Validate agent-qa test YAML',
      description: 'Validate test YAML through the dashboard test-file manager.',
      inputSchema: {
        dashboardUrl: dashboardUrlField,
        content: z.string().describe('Test YAML content'),
        filePath: z.string().optional().describe('Optional file path for suite/test routing hints'),
      },
    },
    async ({ dashboardUrl, content, filePath }) => dashboardTool(dashboardUrl, '/api/tests/validate', 'POST', { content, filePath }),
  )

  registerAnalyticsTool(
    'agent_qa_create_test',
    {
      title: 'Create agent-qa test',
      description: 'Create a test file through the dashboard workspace-safe file manager.',
      inputSchema: {
        dashboardUrl: dashboardUrlField,
        path: z.string().describe('Workspace-relative test path matched by workspace.testMatch'),
        content: z.string().describe('Test YAML content'),
      },
    },
    async ({ dashboardUrl, path, content }) => dashboardTool(dashboardUrl, '/api/tests', 'POST', { path, content }),
  )

  registerAnalyticsTool(
    'agent_qa_update_test',
    {
      title: 'Update agent-qa test',
      description: 'Update a test by canonical test ID through the dashboard API.',
      inputSchema: {
        dashboardUrl: dashboardUrlField,
        testId: z.string().describe('Canonical t_ test ID'),
        content: z.string().describe('Replacement test YAML content'),
      },
    },
    async ({ dashboardUrl, testId, content }) => dashboardTool(dashboardUrl, `/api/tests/${encodeURIComponent(testId)}`, 'PUT', { content }),
  )

  registerAnalyticsTool(
    'agent_qa_delete_test',
    {
      title: 'Delete agent-qa test',
      description: 'Delete a test by canonical test ID through the dashboard API.',
      inputSchema: {
        dashboardUrl: dashboardUrlField,
        testId: z.string().describe('Canonical t_ test ID'),
      },
    },
    async ({ dashboardUrl, testId }) => dashboardTool(dashboardUrl, `/api/tests/${encodeURIComponent(testId)}`, 'DELETE'),
  )

  registerAnalyticsTool(
    'agent_qa_list_suites',
    {
      title: 'List agent-qa suites',
      description: 'List suites through the dashboard API using dashboard workspace discovery.',
      inputSchema: { dashboardUrl: dashboardUrlField },
    },
    async ({ dashboardUrl }) => dashboardTool(dashboardUrl, '/api/suites'),
  )

  registerAnalyticsTool(
    'agent_qa_read_suite',
    {
      title: 'Read agent-qa suite',
      description: 'Read a suite by canonical suite ID through the dashboard API.',
      inputSchema: {
        dashboardUrl: dashboardUrlField,
        suiteId: z.string().describe('Canonical s_ suite ID'),
      },
    },
    async ({ dashboardUrl, suiteId }) => dashboardTool(dashboardUrl, `/api/suites/${encodeURIComponent(suiteId)}`),
  )

  registerAnalyticsTool(
    'agent_qa_validate_suite',
    {
      title: 'Validate agent-qa suite YAML',
      description: 'Validate suite YAML through the dashboard suite-file manager.',
      inputSchema: {
        dashboardUrl: dashboardUrlField,
        content: z.string().describe('Suite YAML content'),
      },
    },
    async ({ dashboardUrl, content }) => dashboardTool(dashboardUrl, '/api/suites/validate', 'POST', { content }),
  )

  registerAnalyticsTool(
    'agent_qa_create_suite',
    {
      title: 'Create agent-qa suite',
      description: 'Create a suite file through the dashboard workspace-safe suite manager.',
      inputSchema: {
        dashboardUrl: dashboardUrlField,
        path: z.string().describe('Workspace-relative suite path matched by workspace.suiteMatch'),
        content: z.string().describe('Suite YAML content'),
      },
    },
    async ({ dashboardUrl, path, content }) => dashboardTool(dashboardUrl, '/api/suites', 'POST', { path, content }),
  )

  registerAnalyticsTool(
    'agent_qa_update_suite',
    {
      title: 'Update agent-qa suite',
      description: 'Update a suite by canonical suite ID through the dashboard API.',
      inputSchema: {
        dashboardUrl: dashboardUrlField,
        suiteId: z.string().describe('Canonical s_ suite ID'),
        content: z.string().describe('Replacement suite YAML content'),
      },
    },
    async ({ dashboardUrl, suiteId, content }) => dashboardTool(dashboardUrl, `/api/suites/${encodeURIComponent(suiteId)}`, 'PUT', { content }),
  )

  registerAnalyticsTool(
    'agent_qa_delete_suite',
    {
      title: 'Delete agent-qa suite',
      description: 'Delete a suite through the dashboard API. Prefer suiteId; path is supported for the dashboard delete route.',
      inputSchema: {
        dashboardUrl: dashboardUrlField,
        suiteId: z.string().optional().describe('Canonical s_ suite ID'),
        path: z.string().optional().describe('Workspace-relative suite path'),
      },
    },
    async ({ dashboardUrl, suiteId, path }) => {
      if (path) return dashboardTool(dashboardUrl, `/api/suites/${encodeURIComponent(path)}`, 'DELETE')
      if (!suiteId) return errorContent('Either suiteId or path is required.')
      let readResult: Awaited<ReturnType<typeof callDashboardApi>>
      try {
        readResult = await callDashboardApi({
          dashboardUrl: dashboardUrlFor(dashboardUrl),
          path: `/api/suites/${encodeURIComponent(suiteId)}`,
        })
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err))
      }
      if (!readResult.ok || !readResult.body || typeof readResult.body !== 'object') return jsonContent(readResult)
      const foundPath = (readResult.body as Record<string, unknown>).path
      if (typeof foundPath !== 'string') return errorContent('Suite read response did not include a path.')
      return dashboardTool(dashboardUrl, `/api/suites/${encodeURIComponent(foundPath)}`, 'DELETE')
    },
  )

  registerAnalyticsTool(
    'agent_qa_list_hooks',
    {
      title: 'List agent-qa hooks',
      description: 'List hooks through the dashboard hook registry API.',
      inputSchema: { dashboardUrl: dashboardUrlField },
    },
    async ({ dashboardUrl }) => dashboardTool(dashboardUrl, '/api/hooks'),
  )

  registerAnalyticsTool(
    'agent_qa_read_hook',
    {
      title: 'Read agent-qa hook',
      description: 'Read hook metadata and source by canonical hook ID.',
      inputSchema: {
        dashboardUrl: dashboardUrlField,
        hookId: z.string().describe('Canonical h_ hook ID'),
      },
    },
    async ({ dashboardUrl, hookId }) => dashboardTool(dashboardUrl, `/api/hooks/${encodeURIComponent(hookId)}`),
  )

  registerAnalyticsTool(
    'agent_qa_create_hook',
    {
      title: 'Create agent-qa hook',
      description: 'Create a hook through the dashboard hook registry API.',
      inputSchema: {
        dashboardUrl: dashboardUrlField,
        payload: z.record(z.string(), z.unknown()).describe('Dashboard HookMutationRequest payload'),
      },
    },
    async ({ dashboardUrl, payload }) => dashboardTool(dashboardUrl, '/api/hooks', 'POST', payload),
  )

  registerAnalyticsTool(
    'agent_qa_update_hook',
    {
      title: 'Update agent-qa hook',
      description: 'Update a hook through the dashboard hook registry API.',
      inputSchema: {
        dashboardUrl: dashboardUrlField,
        hookId: z.string().describe('Canonical h_ hook ID'),
        payload: z.record(z.string(), z.unknown()).describe('Dashboard HookMutationRequest payload'),
      },
    },
    async ({ dashboardUrl, hookId, payload }) => dashboardTool(dashboardUrl, `/api/hooks/${encodeURIComponent(hookId)}`, 'PUT', payload),
  )

  registerAnalyticsTool(
    'agent_qa_delete_hook',
    {
      title: 'Delete agent-qa hook',
      description: 'Delete a hook through the dashboard hook registry API.',
      inputSchema: {
        dashboardUrl: dashboardUrlField,
        hookId: z.string().describe('Canonical h_ hook ID'),
        force: z.boolean().optional().describe('Delete even when references exist'),
      },
    },
    async ({ dashboardUrl, hookId, force }) => dashboardTool(dashboardUrl, `/api/hooks/${encodeURIComponent(hookId)}${force ? '?force=true' : ''}`, 'DELETE'),
  )

  registerAnalyticsTool(
    'agent_qa_run_hook',
    {
      title: 'Run agent-qa hook',
      description: 'Run a hook through the dashboard hook execution API.',
      inputSchema: {
        dashboardUrl: dashboardUrlField,
        hookId: z.string().describe('Canonical h_ hook ID'),
        payload: z.record(z.string(), z.unknown()).optional().describe('Dashboard HookRunRequest payload'),
      },
    },
    async ({ dashboardUrl, hookId, payload }) => dashboardTool(dashboardUrl, `/api/hooks/${encodeURIComponent(hookId)}/run`, 'POST', payload ?? {}),
  )

  registerAnalyticsTool(
    'agent_qa_enqueue_test_run',
    {
      title: 'Enqueue agent-qa test run',
      description: 'Queue a test run through the dashboard run trigger API and return the canonical run ID.',
      inputSchema: {
        dashboardUrl: dashboardUrlField,
        file: z.string().optional().describe('Workspace-relative test file path'),
        patterns: z.array(z.string()).optional().describe('Optional test patterns'),
        noCache: z.boolean().optional(),
        noMemory: z.boolean().optional(),
        local: z.boolean().optional(),
      },
    },
    async ({ dashboardUrl, file, patterns, noCache, noMemory, local }) => dashboardTool(dashboardUrl, '/api/runs/trigger', 'POST', { file, patterns, noCache, noMemory, local, triggerSource: 'mcp' }),
  )

  registerAnalyticsTool(
    'agent_qa_enqueue_suite_run',
    {
      title: 'Enqueue agent-qa suite run',
      description: 'Queue a suite run through the dashboard run trigger API and return parent run context.',
      inputSchema: {
        dashboardUrl: dashboardUrlField,
        file: z.string().describe('Workspace-relative suite file path'),
        noCache: z.boolean().optional(),
        noMemory: z.boolean().optional(),
        local: z.boolean().optional(),
      },
    },
    async ({ dashboardUrl, file, noCache, noMemory, local }) => dashboardTool(dashboardUrl, '/api/runs/trigger', 'POST', { file, noCache, noMemory, local, triggerSource: 'mcp' }),
  )

  registerAnalyticsTool(
    'agent_qa_get_run',
    {
      title: 'Get agent-qa run',
      description: 'Get run detail, steps, attempts, and suite child context through the dashboard API.',
      inputSchema: {
        dashboardUrl: dashboardUrlField,
        runId: z.string().describe('Canonical r_ run ID'),
      },
    },
    async ({ dashboardUrl, runId }) => dashboardTool(dashboardUrl, `/api/runs/${encodeURIComponent(runId)}`),
  )

  registerAnalyticsTool(
    'agent_qa_get_run_steps',
    {
      title: 'Get agent-qa run steps',
      description: 'Get run steps through the dashboard API.',
      inputSchema: {
        dashboardUrl: dashboardUrlField,
        runId: z.string().describe('Canonical r_ run ID'),
      },
    },
    async ({ dashboardUrl, runId }) => dashboardTool(dashboardUrl, `/api/runs/${encodeURIComponent(runId)}/steps`),
  )

  registerAnalyticsTool(
    'agent_qa_get_run_logs',
    {
      title: 'Get agent-qa run logs',
      description: 'Get run log rows through the dashboard API.',
      inputSchema: {
        dashboardUrl: dashboardUrlField,
        runId: z.string().describe('Canonical r_ run ID'),
        stepId: z.string().optional(),
        level: z.string().optional(),
        source: z.string().optional(),
        limit: z.number().int().positive().optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    async ({ dashboardUrl, runId, stepId, level, source, limit, offset }) => dashboardTool(
      dashboardUrl,
      withQuery(`/api/runs/${encodeURIComponent(runId)}/logs`, { stepId, level, source, limit, offset }),
    ),
  )

  registerAnalyticsTool(
    'agent_qa_get_run_execution_logs',
    {
      title: 'Get agent-qa execution logs',
      description: 'Get structured execution logs through the dashboard API.',
      inputSchema: {
        dashboardUrl: dashboardUrlField,
        runId: z.string().describe('Canonical r_ run ID'),
        stepId: z.string().optional(),
        type: z.string().optional(),
      },
    },
    async ({ dashboardUrl, runId, stepId, type }) => dashboardTool(
      dashboardUrl,
      withQuery(`/api/runs/${encodeURIComponent(runId)}/execution-logs`, { stepId, type }),
    ),
  )

  registerAnalyticsTool(
    'agent_qa_get_run_artifact',
    {
      title: 'Get agent-qa run artifact bundle',
      description: 'Get sanitized run artifact bundle, child artifacts, and missing artifact sections.',
      inputSchema: {
        dashboardUrl: dashboardUrlField,
        runId: z.string().describe('Canonical r_ run ID'),
      },
    },
    async ({ dashboardUrl, runId }) => dashboardTool(dashboardUrl, `/api/runs/${encodeURIComponent(runId)}/artifact`),
  )

  registerAnalyticsTool(
    'agent_qa_cancel_run',
    {
      title: 'Cancel agent-qa run',
      description: 'Cancel a pending or running run through the dashboard queue.',
      inputSchema: {
        dashboardUrl: dashboardUrlField,
        runId: z.string().describe('Canonical r_ run ID'),
      },
    },
    async ({ dashboardUrl, runId }) => dashboardTool(dashboardUrl, `/api/runs/${encodeURIComponent(runId)}/cancel`, 'POST', {}),
  )

  registerAnalyticsTool(
    'agent_qa_classify_failure',
    {
      title: 'Classify agent-qa failure',
      description: 'Classify a failed run using dashboard run detail, artifacts, logs, execution logs, and recent related runs.',
      inputSchema: {
        dashboardUrl: dashboardUrlField,
        runId: z.string().describe('Canonical r_ run ID'),
      },
    },
    async ({ dashboardUrl, runId }) => {
      try {
        const baseUrl = dashboardUrlFor(dashboardUrl)
        const runDetail = await callDashboardApi({ dashboardUrl: baseUrl, path: `/api/runs/${encodeURIComponent(runId)}` })
        const artifact = await callDashboardApi({ dashboardUrl: baseUrl, path: `/api/runs/${encodeURIComponent(runId)}/artifact` })
        const logs = await callDashboardApi({ dashboardUrl: baseUrl, path: `/api/runs/${encodeURIComponent(runId)}/logs` })
        const executionLogs = await callDashboardApi({ dashboardUrl: baseUrl, path: `/api/runs/${encodeURIComponent(runId)}/execution-logs` })
        const runName = runDetail.body && typeof runDetail.body === 'object'
          && (runDetail.body as Record<string, unknown>).run
          && typeof (runDetail.body as { run?: { name?: unknown } }).run?.name === 'string'
          ? (runDetail.body as { run: { name: string } }).run.name
          : undefined
        const recentRuns = runName
          ? await callDashboardApi({ dashboardUrl: baseUrl, path: withQuery('/api/runs', { name: runName, limit: 5 }) })
          : { ok: true, status: 200, body: { runs: [] } }
        return jsonContent({
          runId,
          classification: classifyRunFailureFromDashboardData({
            runDetail: runDetail.body,
            artifact: artifact.body,
            logs: logs.body,
            executionLogs: executionLogs.body,
            recentRuns: recentRuns.body,
          }),
          sources: {
            run: { ok: runDetail.ok, status: runDetail.status },
            artifact: { ok: artifact.ok, status: artifact.status },
            logs: { ok: logs.ok, status: logs.status },
            executionLogs: { ok: executionLogs.ok, status: executionLogs.status },
            recentRuns: { ok: recentRuns.ok, status: recentRuns.status },
          },
        })
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err))
      }
    },
  )

  for (const schema of SCHEMA_REFERENCE_NAMES) {
    server.registerResource(
      `agent_qa.schema.${schema}`,
      `agent-qa://schema/${schema}`,
      {
        title: `agent-qa ${schema} schema reference`,
        description: `Structured agent-qa reference for ${schema}.`,
        mimeType: 'application/json',
      },
      async uri => ({
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(AGENT_QA_SCHEMA_REFERENCES[schema], null, 2),
        }],
      }),
    )
  }

  server.registerPrompt(
    'agent_qa_authoring_context',
    {
      title: 'agent-qa authoring context',
      description: 'Prompt context for agents writing agent-qa tests and suites.',
      argsSchema: {},
    },
    async () => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: [
            'Use agent-qa MCP tools before editing files.',
            'Call agent_qa_get_config to inspect targets/devices/providers.',
            'Call agent_qa_generate_id for test, suite, hook, run, and observation IDs.',
            'Call agent_qa_validate_definition before saving config, test, suite, or hooks YAML.',
            `Canonical ID contracts: ${JSON.stringify(getEntityIdContracts())}`,
          ].join('\n'),
        },
      }],
    }),
  )

  return server
}

export {
  AGENT_QA_SCHEMA_REFERENCES,
  validateAgentQaDefinition,
} from './schema-reference.js'
