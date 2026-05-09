import type { IncomingMessage, ServerResponse } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createAgentQaMcpServer, type AgentQaMcpServerOptions } from './agent-qa-server.js'

export const DEFAULT_MCP_HOST = '127.0.0.1'
export const DEFAULT_MCP_PORT = 3471
export const DEFAULT_MCP_PATH = '/mcp'

export type LocalMcpTransport = 'http' | 'stdio'

export interface LocalMcpEndpointConfig {
  enabled?: boolean
  transport?: LocalMcpTransport
  host?: string
  port?: number
  path?: string
}

export interface LocalMcpEndpoint {
  enabled: boolean
  transport: LocalMcpTransport
  host: string
  port: number
  path: string
  url: string
}

export interface McpHttpHandlerOptions {
  endpoint?: Partial<LocalMcpEndpoint>
  dashboardUrl?: string
  configPath?: string
  analyticsConfig?: AgentQaMcpServerOptions['analyticsConfig']
}

export interface LocalMcpEndpointShape {
  mcp_host_kind: 'loopback' | 'other'
  mcp_port_kind: 'default' | 'custom'
  mcp_path_kind: 'default' | 'custom'
}

function normalizePath(path: string | undefined): string {
  if (!path) return DEFAULT_MCP_PATH
  return path.startsWith('/') ? path : `/${path}`
}

function jsonRpcError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  })
  res.end(JSON.stringify({
    jsonrpc: '2.0',
    error: {
      code: -32000,
      message,
    },
    id: null,
  }))
}

export function resolveLocalMcpEndpoint(config: LocalMcpEndpointConfig = {}): LocalMcpEndpoint {
  const transport = config.transport ?? 'http'
  const host = config.host ?? DEFAULT_MCP_HOST
  const port = config.port ?? DEFAULT_MCP_PORT
  const path = normalizePath(config.path)
  const displayHost = host === '::1' ? '[::1]' : host

  return {
    enabled: config.enabled !== false,
    transport,
    host,
    port,
    path,
    url: `http://${displayHost}:${port}${path}`,
  }
}

export function resolveMcpEndpointShape(
  endpoint: Pick<LocalMcpEndpoint, 'host' | 'port' | 'path'>,
): LocalMcpEndpointShape {
  return {
    mcp_host_kind: ['127.0.0.1', 'localhost', '::1'].includes(endpoint.host) ? 'loopback' : 'other',
    mcp_port_kind: endpoint.port === DEFAULT_MCP_PORT ? 'default' : 'custom',
    mcp_path_kind: endpoint.path === DEFAULT_MCP_PATH ? 'default' : 'custom',
  }
}

export function createLocalMcpHttpHandler(options: McpHttpHandlerOptions = {}) {
  const endpoint = resolveLocalMcpEndpoint(options.endpoint)
  const baseHost = endpoint.host === '::1' ? '[::1]' : endpoint.host

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const requestUrl = new URL(req.url ?? '/', `http://${baseHost}:${endpoint.port}`)
    if (requestUrl.pathname !== endpoint.path) {
      jsonRpcError(res, 404, `MCP endpoint is available at ${endpoint.path}`)
      return
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, MCP-Protocol-Version, mcp-session-id',
      })
      res.end()
      return
    }

    const server = createAgentQaMcpServer({
      configPath: options.configPath,
      dashboardUrl: options.dashboardUrl,
      endpointUrl: endpoint.url,
      analyticsConfig: options.analyticsConfig,
      transport: 'http',
    })
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    })

    try {
      await server.connect(transport)
      await transport.handleRequest(req, res)
      res.on('close', () => {
        void transport.close()
        void server.close()
      })
    } catch (err) {
      void transport.close()
      void server.close()
      if (!res.headersSent) {
        jsonRpcError(
          res,
          500,
          err instanceof Error ? err.message : 'Internal MCP server error',
        )
      }
    }
  }
}
