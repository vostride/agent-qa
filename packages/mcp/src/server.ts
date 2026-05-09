import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  buildAnalyticsEvent,
  captureAnalytics,
  resolveAnalyticsStandardProperties,
} from '@vostride/agent-qa-core'
import { createAgentQaMcpServer, type AgentQaMcpServerOptions } from './agent-qa-server.js'

export function createMcpServer(options: AgentQaMcpServerOptions = {}) {
  return createAgentQaMcpServer(options)
}

export async function startMcpServer(options: AgentQaMcpServerOptions = {}): Promise<void> {
  const server = createMcpServer({ ...options, transport: 'stdio' })
  const transport = new StdioServerTransport()
  await server.connect(transport)
  try {
    if (options.analyticsConfig?.analytics?.privacy !== true) {
      const standardProperties = options.analyticsStandardProperties
        ?? await resolveAnalyticsStandardProperties({ surface: 'mcp' })
      const event = buildAnalyticsEvent({
        name: 'agent-qa.mcp.server.lifecycle',
        properties: {
          ...standardProperties,
          surface: standardProperties.surface ?? 'mcp',
          mcp_server_state: 'started',
          mcp_transport: 'stdio',
        },
      })
      if (options.analyticsService) {
        await options.analyticsService.capture(event).catch(() => {})
      } else {
        await captureAnalytics(event, {
          config: options.analyticsConfig,
          surface: 'mcp',
        }).catch(() => {})
      }
    }
  } catch {
    // MCP startup analytics is intentionally best-effort.
  }
}
