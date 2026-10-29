// A request function only: it binds no socket and emits no CORS header; stateless per SEP-2575.

import { createMcpHandler } from '@modelcontextprotocol/server'
import type { McpRequestContext } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'

import { buildAgentQaMcpServer } from './catalog.js'
import type { AgentQaMcpServerDeps } from './catalog.js'

// Takes the SDK's per-request context, so facts such as `era` arrive here, not from a header.
export type AgentQaMcpDepsResolver = (ctx: McpRequestContext) => AgentQaMcpServerDeps

// Reruns the factory per request; the host's Host and Origin guard sits in front of this handler.
export function createAgentQaMcpNodeHandler(resolveDeps: AgentQaMcpDepsResolver) {
  return toNodeHandler(createMcpHandler((ctx) => buildAgentQaMcpServer(resolveDeps(ctx))))
}
