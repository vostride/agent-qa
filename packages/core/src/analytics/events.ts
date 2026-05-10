import { z } from 'zod'
import {
  type AnalyticsEventInput,
  type BuiltAnalyticsEvent,
  type BuiltAnalyticsEventProperties,
} from './types.js'
import { getAgentQaVersion } from '../version.js'

export type {
  AnalyticsEventInput,
  AnalyticsEventName,
  AnalyticsEventProperties,
  AnalyticsSurface,
  AnalyticsTransportKind,
  BuiltAnalyticsEvent,
  BuiltAnalyticsEventProperties,
} from './types.js'

export const ANALYTICS_EVENT_NAMES = [
  'agent-qa.analytics.initialized',
  'agent-qa.analytics.test_event',
  'agent-qa.test_run.completed',
  'agent-qa.suite_run.completed',
  'agent-qa.dashboard.opened',
  'agent-qa.dashboard.live_mode.started',
  'agent-qa.dashboard.entity.created',
  'agent-qa.mcp.server.lifecycle',
  'agent-qa.mcp.tool.invoked',
] as const

export const ANALYTICS_SURFACES = [
  'core',
  'cli',
  'dashboard-server',
  'dashboard-ui',
  'mcp',
] as const

export const ANALYTICS_RUNTIME_CONTEXTS = ['user', 'ci', 'agent'] as const

export const ANALYTICS_AGENT_PRODUCTS = [
  'claude_code',
  'cursor',
  'gemini_cli',
  'augment',
  'goose',
  'opencode',
  'codex',
  'cline',
  'amp',
] as const

export const ANALYTICS_TRANSPORT_KINDS = ['posthog', 'noop', 'mock'] as const
export const ANALYTICS_TRIGGER_SOURCES = ['cli', 'dashboard', 'api', 'mcp', 'unknown'] as const
export const ANALYTICS_RUNNERS = ['local', 'browserstack', 'unknown'] as const
export const ANALYTICS_PLATFORMS = ['web', 'android', 'ios', 'unknown'] as const
export const ANALYTICS_DASHBOARD_ENTITY_TYPES = ['test', 'suite', 'hook', 'unknown'] as const
export const ANALYTICS_DASHBOARD_OUTCOMES = ['created'] as const
export const ANALYTICS_RUN_STATUSES = ['passed', 'failed', 'skipped', 'cancelled', 'timeout', 'unknown'] as const
export const ANALYTICS_MCP_SERVER_STATES = ['started', 'disabled'] as const
export const ANALYTICS_MCP_TRANSPORTS = ['stdio', 'http'] as const
export const ANALYTICS_MCP_HOST_KINDS = ['loopback', 'other'] as const
export const ANALYTICS_MCP_PORT_KINDS = ['default', 'custom'] as const
export const ANALYTICS_MCP_PATH_KINDS = ['default', 'custom'] as const
export const ANALYTICS_MCP_TOOL_CATEGORIES = [
  'discovery',
  'schema',
  'id',
  'authoring',
  'hook',
  'run',
  'triage',
  'unknown',
] as const
export const ANALYTICS_MCP_TOOL_STATUSES = ['success', 'error'] as const
export const ANALYTICS_MCP_ERROR_CATEGORIES = [
  'validation',
  'dashboard_unavailable',
  'dashboard_error',
  'config',
  'tool_error',
  'unknown',
] as const
export const ANALYTICS_FAILURE_CATEGORIES = [
  'assertion',
  'timeout',
  'cancelled',
  'setup',
  'hook',
  'appium',
  'browser_install',
  'llm_context',
  'llm_provider',
  'memory',
  'framework',
  'unknown',
] as const
export const ANALYTICS_SUITE_EXECUTION_MODES = ['sequential', 'parallel', 'unknown'] as const

const AnalyticsEventNameSchema = z.enum(ANALYTICS_EVENT_NAMES)

const NonNegativeIntegerSchema = z.number().int().min(0)
const NonNegativeNumberSchema = z.number().min(0)

const AnalyticsBasePropertiesSchema = z.object({
  agent_qa_version: z.string().min(1).optional(),
  surface: z.enum(ANALYTICS_SURFACES).optional(),
  runtime_context: z.enum(ANALYTICS_RUNTIME_CONTEXTS).optional(),
  agent_product: z.enum(ANALYTICS_AGENT_PRODUCTS).optional(),
  transport: z.enum(ANALYTICS_TRANSPORT_KINDS).optional(),
  privacy_enabled: z.boolean().optional(),
  posthog_key_present: z.boolean().optional(),
  $process_person_profile: z.literal(false).optional(),
}).strip()

const AnalyticsRunPropertiesSchema = AnalyticsBasePropertiesSchema.extend({
  trigger_source: z.enum(ANALYTICS_TRIGGER_SOURCES).optional(),
  runner: z.enum(ANALYTICS_RUNNERS).optional(),
  platform: z.enum(ANALYTICS_PLATFORMS).optional(),
  status: z.enum(ANALYTICS_RUN_STATUSES).optional(),
  duration_ms: NonNegativeNumberSchema.optional(),
  run_id: z.string().min(1).optional(),
  parent_run_id: z.string().min(1).optional(),
  test_id: z.string().min(1).optional(),
  suite_id: z.string().min(1).optional(),
  model_name: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  provider_mode: z.string().min(1).optional(),
  planner_model: z.string().min(1).optional(),
  verifier_model: z.string().min(1).optional(),
  input_tokens: NonNegativeIntegerSchema.optional(),
  output_tokens: NonNegativeIntegerSchema.optional(),
  total_tokens: NonNegativeIntegerSchema.optional(),
  planner_call_count: NonNegativeIntegerSchema.optional(),
  verifier_call_count: NonNegativeIntegerSchema.optional(),
  step_count: NonNegativeIntegerSchema.optional(),
  passed_step_count: NonNegativeIntegerSchema.optional(),
  failed_step_count: NonNegativeIntegerSchema.optional(),
  skipped_step_count: NonNegativeIntegerSchema.optional(),
  subaction_count: NonNegativeIntegerSchema.optional(),
  cached_subaction_count: NonNegativeIntegerSchema.optional(),
  failed_subaction_count: NonNegativeIntegerSchema.optional(),
  healing_attempt_count: NonNegativeIntegerSchema.optional(),
  hook_count: NonNegativeIntegerSchema.optional(),
  failed_hook_count: NonNegativeIntegerSchema.optional(),
  retry_count: NonNegativeIntegerSchema.optional(),
  is_flaky: z.boolean().optional(),
  cancelled: z.boolean().optional(),
  timed_out: z.boolean().optional(),
  failure_category: z.enum(ANALYTICS_FAILURE_CATEGORIES).optional(),
  browser_name: z.string().min(1).optional(),
  mobile_transport: z.string().min(1).optional(),
  mobile_provider: z.string().min(1).optional(),
  app_state: z.string().min(1).optional(),
  execution_destination: z.string().min(1).optional(),
  memory_enabled: z.boolean().optional(),
  memory_injected_observation_count: NonNegativeIntegerSchema.optional(),
  memory_curator_input_tokens: NonNegativeIntegerSchema.optional(),
  memory_curator_output_tokens: NonNegativeIntegerSchema.optional(),
  memory_curator_total_tokens: NonNegativeIntegerSchema.optional(),
  memory_added_count: NonNegativeIntegerSchema.optional(),
  memory_confirmed_count: NonNegativeIntegerSchema.optional(),
  memory_deprecated_count: NonNegativeIntegerSchema.optional(),
  memory_deleted_count: NonNegativeIntegerSchema.optional(),
  memory_error_count: NonNegativeIntegerSchema.optional(),
  suite_child_count: NonNegativeIntegerSchema.optional(),
  suite_passed_count: NonNegativeIntegerSchema.optional(),
  suite_failed_count: NonNegativeIntegerSchema.optional(),
  suite_skipped_count: NonNegativeIntegerSchema.optional(),
  suite_execution_mode: z.enum(ANALYTICS_SUITE_EXECUTION_MODES).optional(),
  mcp_tool_count: NonNegativeIntegerSchema.optional(),
}).strip()

const AnalyticsDashboardOpenedPropertiesSchema = AnalyticsBasePropertiesSchema

const AnalyticsDashboardLiveModeStartedPropertiesSchema = AnalyticsBasePropertiesSchema.extend({
  platform: z.enum(ANALYTICS_PLATFORMS).optional(),
  entity_type: z.enum(['test', 'suite', 'unknown']).optional(),
}).strip()

const AnalyticsDashboardEntityCreatedPropertiesSchema = AnalyticsBasePropertiesSchema.extend({
  entity_type: z.enum(['test', 'suite', 'hook']).optional(),
  outcome: z.enum(ANALYTICS_DASHBOARD_OUTCOMES).optional(),
}).strip()

const AnalyticsMcpServerLifecyclePropertiesSchema = AnalyticsBasePropertiesSchema.extend({
  mcp_server_state: z.enum(ANALYTICS_MCP_SERVER_STATES).optional(),
  mcp_transport: z.enum(ANALYTICS_MCP_TRANSPORTS).optional(),
  mcp_host_kind: z.enum(ANALYTICS_MCP_HOST_KINDS).optional(),
  mcp_port_kind: z.enum(ANALYTICS_MCP_PORT_KINDS).optional(),
  mcp_path_kind: z.enum(ANALYTICS_MCP_PATH_KINDS).optional(),
}).strip()

const AnalyticsMcpToolInvokedPropertiesSchema = AnalyticsBasePropertiesSchema.extend({
  tool_name: z.string().min(1).optional(),
  mcp_tool_category: z.enum(ANALYTICS_MCP_TOOL_CATEGORIES).optional(),
  mcp_tool_status: z.enum(ANALYTICS_MCP_TOOL_STATUSES).optional(),
  duration_ms: NonNegativeNumberSchema.optional(),
  mcp_error_category: z.enum(ANALYTICS_MCP_ERROR_CATEGORIES).optional(),
  mcp_transport: z.enum(ANALYTICS_MCP_TRANSPORTS).optional(),
  run_id: z.string().min(1).optional(),
}).strip()

const AnalyticsEventPropertiesSchemaByName = {
  'agent-qa.analytics.initialized': AnalyticsRunPropertiesSchema,
  'agent-qa.analytics.test_event': AnalyticsRunPropertiesSchema,
  'agent-qa.test_run.completed': AnalyticsRunPropertiesSchema,
  'agent-qa.suite_run.completed': AnalyticsRunPropertiesSchema,
  'agent-qa.dashboard.opened': AnalyticsDashboardOpenedPropertiesSchema,
  'agent-qa.dashboard.live_mode.started': AnalyticsDashboardLiveModeStartedPropertiesSchema,
  'agent-qa.dashboard.entity.created': AnalyticsDashboardEntityCreatedPropertiesSchema,
  'agent-qa.mcp.server.lifecycle': AnalyticsMcpServerLifecyclePropertiesSchema,
  'agent-qa.mcp.tool.invoked': AnalyticsMcpToolInvokedPropertiesSchema,
} satisfies Record<typeof ANALYTICS_EVENT_NAMES[number], z.ZodType<BuiltAnalyticsEventProperties>>

export function buildAnalyticsEvent(input: AnalyticsEventInput): BuiltAnalyticsEvent {
  const name = AnalyticsEventNameSchema.parse(input.name)
  const properties = AnalyticsEventPropertiesSchemaByName[name].parse({
    agent_qa_version: getAgentQaVersion(),
    ...(input.properties ?? {}),
    $process_person_profile: false,
  }) as BuiltAnalyticsEventProperties

  return { name, properties }
}
