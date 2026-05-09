import type { AnalyticsAgentProduct, AnalyticsRuntimeContext } from './identity.js'

export type AnalyticsEventName =
  | 'agent-qa.analytics.initialized'
  | 'agent-qa.analytics.test_event'
  | 'agent-qa.test_run.completed'
  | 'agent-qa.suite_run.completed'
  | 'agent-qa.dashboard.opened'
  | 'agent-qa.dashboard.live_mode.started'
  | 'agent-qa.dashboard.entity.created'
  | 'agent-qa.mcp.server.lifecycle'
  | 'agent-qa.mcp.tool.invoked'

export type AnalyticsSurface =
  | 'core'
  | 'cli'
  | 'dashboard-server'
  | 'dashboard-ui'
  | 'mcp'

export type AnalyticsTransportKind = 'posthog' | 'noop' | 'mock'

export interface AnalyticsEventProperties {
  agent_qa_version?: string
  surface?: AnalyticsSurface
  runtime_context?: AnalyticsRuntimeContext
  agent_product?: AnalyticsAgentProduct
  transport?: AnalyticsTransportKind
  privacy_enabled?: boolean
  posthog_key_present?: boolean
  trigger_source?: 'cli' | 'dashboard' | 'api' | 'mcp' | 'unknown'
  runner?: 'local' | 'browserstack' | 'unknown'
  platform?: 'web' | 'android' | 'ios' | 'unknown'
  entity_type?: 'test' | 'suite' | 'hook' | 'unknown'
  outcome?: 'created'
  status?: 'passed' | 'failed' | 'skipped' | 'cancelled' | 'timeout' | 'unknown'
  duration_ms?: number
  run_id?: string
  parent_run_id?: string
  test_id?: string
  suite_id?: string
  model_name?: string
  provider?: string
  provider_mode?: string
  planner_model?: string
  verifier_model?: string
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  planner_call_count?: number
  verifier_call_count?: number
  step_count?: number
  passed_step_count?: number
  failed_step_count?: number
  skipped_step_count?: number
  subaction_count?: number
  cached_subaction_count?: number
  failed_subaction_count?: number
  healing_attempt_count?: number
  hook_count?: number
  failed_hook_count?: number
  retry_count?: number
  is_flaky?: boolean
  cancelled?: boolean
  timed_out?: boolean
  failure_category?:
    | 'assertion'
    | 'timeout'
    | 'cancelled'
    | 'setup'
    | 'hook'
    | 'appium'
    | 'browser_install'
    | 'llm_context'
    | 'llm_provider'
    | 'memory'
    | 'framework'
    | 'unknown'
  browser_name?: string
  mobile_transport?: string
  mobile_provider?: string
  app_state?: string
  execution_destination?: string
  memory_enabled?: boolean
  memory_injected_observation_count?: number
  memory_curator_input_tokens?: number
  memory_curator_output_tokens?: number
  memory_curator_total_tokens?: number
  memory_added_count?: number
  memory_confirmed_count?: number
  memory_deprecated_count?: number
  memory_deleted_count?: number
  memory_error_count?: number
  suite_child_count?: number
  suite_passed_count?: number
  suite_failed_count?: number
  suite_skipped_count?: number
  suite_execution_mode?: 'sequential' | 'parallel' | 'unknown'
  mcp_tool_count?: number
  mcp_server_state?: 'started' | 'disabled'
  mcp_transport?: 'stdio' | 'http'
  mcp_host_kind?: 'loopback' | 'other'
  mcp_port_kind?: 'default' | 'custom'
  mcp_path_kind?: 'default' | 'custom'
  tool_name?: string
  mcp_tool_category?: 'discovery' | 'schema' | 'id' | 'authoring' | 'hook' | 'run' | 'triage' | 'unknown'
  mcp_tool_status?: 'success' | 'error'
  mcp_error_category?: 'validation' | 'dashboard_unavailable' | 'dashboard_error' | 'config' | 'tool_error' | 'unknown'
  '$process_person_profile'?: false
}

export type BuiltAnalyticsEventProperties = Record<string, string | number | boolean | undefined>

export interface AnalyticsEventInput {
  name: AnalyticsEventName | string
  properties?: Record<string, unknown>
}

export interface BuiltAnalyticsEvent {
  name: AnalyticsEventName
  properties: BuiltAnalyticsEventProperties
}
