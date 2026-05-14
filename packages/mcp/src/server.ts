import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  buildAnalyticsEvent,
  captureAnalytics,
  resolveAnalyticsStandardProperties,
} from '@vostride/agent-qa-core'
import { createAgentQaMcpServer, type AgentQaMcpServerOptions } from './agent-qa-server.js'

export const MCP_STDIO_STARTUP_MESSAGE =
  'agent-qa MCP server running over stdio. Waiting for MCP client messages on stdin. Stdout is reserved for MCP protocol traffic.'

export interface StartMcpServerOptions extends AgentQaMcpServerOptions {
  startupOutput?: Pick<NodeJS.WritableStream, 'write'>
}

export function createMcpServer(options: AgentQaMcpServerOptions = {}) {
  return createAgentQaMcpServer(options)
}

export async function startMcpServer(options: StartMcpServerOptions = {}): Promise<void> {
  const { startupOutput, ...serverOptions } = options
  const server = createMcpServer({ ...serverOptions, transport: 'stdio' })
  const transport = new StdioServerTransport()
  await server.connect(transport)
  try {
    startupOutput?.write(`${MCP_STDIO_STARTUP_MESSAGE}\n`)
  } catch {
    // Startup visibility is best-effort; the MCP server is already connected.
  }
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
