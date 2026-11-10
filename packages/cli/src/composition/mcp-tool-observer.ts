// One observer for every MCP tool call: it reports the error, records the tool span and, where the
// host composed analytics, emits the tool event.

import { FunctionInputError, UnknownFunctionError } from '@vostride/agent-qa-agent'
import { ANALYTICS_MCP_TOOL_NAMES } from '@vostride/agent-qa-analytics'

import { analyticsEvent } from './analytics-host.js'
import type { CliAnalyticsHost } from './analytics-host.js'
import { errorReporter } from './error-reporting.js'

// The MCP server's settle, declared here because the surface firewall keeps the MCP package to
// `commands/mcp.ts`, which hands this observer to the server: the compiler checks the two agree.
export interface SettledToolCall {
  readonly tool: string
  readonly durationMs: number
  readonly outcome: 'success' | 'error'
  readonly error?: unknown
}

export interface ToolSettledAnalytics {
  readonly host: CliAnalyticsHost
  readonly mcpTransport: 'stdio' | 'http'
}

export type McpErrorCategory = 'validation' | 'unknown_tool' | 'tool_error' | 'unknown'

const ANALYTICS_TOOL_NAMES: ReadonlySet<string> = new Set(ANALYTICS_MCP_TOOL_NAMES)

export function mcpErrorCategory(settled: SettledToolCall): McpErrorCategory {
  if (settled.error === undefined) return 'unknown'
  if (settled.error instanceof FunctionInputError) return 'validation'
  if (settled.error instanceof UnknownFunctionError) return 'unknown_tool'
  return 'tool_error'
}

// A tool call is a trace of its own, as a run is in a long-lived host.
export function createToolSettledObserver(
  input: { readonly analytics?: ToolSettledAnalytics } = {},
): (settled: SettledToolCall) => void {
  return (settled) => {
    try {
      const reporter = errorReporter()
      if (reporter !== undefined) {
        reporter
          .startSpan({
            op: 'agent_qa.mcp_tool',
            name: `tool ${settled.tool}`,
            newTrace: true,
            startTime: Date.now() - settled.durationMs,
            attributes: { 'agent_qa.tool': settled.tool, 'agent_qa.outcome': settled.outcome },
          })
          .end(settled.outcome === 'success' ? 'ok' : 'error')
        // A refusal is reported like a defect: sorting them is left to whoever reads the report.
        if (settled.error !== undefined) reporter.capture(settled.error)
      }
      const analytics = input.analytics
      if (analytics !== undefined) {
        analytics.host.port.capture(
          analyticsEvent(analytics.host, 'agent-qa.mcp.tool.invoked', {
            ...(ANALYTICS_TOOL_NAMES.has(settled.tool) ? { tool_name: settled.tool } : {}),
            mcp_tool_status: settled.outcome,
            mcp_transport: analytics.mcpTransport,
            duration_ms: settled.durationMs,
            ...(settled.outcome === 'error'
              ? { mcp_error_category: mcpErrorCategory(settled) }
              : {}),
          }),
        )
      }
    } catch {
      // Observing a tool call never changes what its caller reads.
    }
  }
}
