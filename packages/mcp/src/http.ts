// The loopback HTTP face of the same catalog.
//
// WHY THIS FILE EXISTS, AND WHY IT EXISTS NOW rather than with the plan that first mounts it. Two
// consumers need an HTTP face of this server and neither is a product feature: the conformance
// suite's `server` mode takes a URL and cannot spawn a stdio command (measured in this phase's
// research — D-17's stated shape is unrunnable as written), and any driver that wants to exercise
// the wire without a child process reaches for the same handler. Shipping the FACTORY here, with no
// socket and no lifecycle, is what lets plan 07 point `conformance server --url` at the shipped
// artifact instead of at something a CI script assembled.
//
// IT BINDS NOTHING. `createAgentQaMcpNodeHandler` returns a request FUNCTION. Creating a server,
// choosing a port, deciding which interface to listen on and validating Host/Origin are all the
// host's, which is what keeps this package free of every host API — it names no `node:` module, and
// neither does the adapter it calls, because the SDK's own adapter is duck-typed for exactly this.
//
// THE V1 WILDCARD CORS HEADER IS NOT CARRIED FORWARD, and this comment is where a future reader who
// goes looking for it finds out why. The deleted `local-http.ts` answered every request and every
// preflight with `Access-Control-Allow-Origin: *`, which on a loopback JSON-RPC endpoint invites the
// DNS-rebinding reach the v2 docs put host and origin guards in front of the handler to refuse.
// Nothing here emits a CORS header; a host that decides it needs one is deciding that on purpose.
//
// Protocol grounding: SEP-2575 (stateless — the factory below runs once per REQUEST, holds nothing
// between them, and there is no session id anywhere), SEP-2567 (list results no longer vary per
// connection). 2026-10-02: no list varies by caller either — every caller sees and
// calls the same twenty tools, with no token.

import { createMcpHandler } from '@modelcontextprotocol/server'
import type { McpRequestContext } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'

import { buildAgentQaMcpServer } from './catalog.js'
import type { AgentQaMcpServerDeps } from './catalog.js'

/**
 * How a host composes the server for one request.
 *
 * It takes the SDK's own construction context, so a per-request fact such as `era` arrives here
 * rather than being read back out of a header inside a tool handler. What it returns is the same
 * `deps` a stdio host composes, which is what keeps ONE `buildAgentQaMcpServer` shape across both
 * transports. 2026-10-02: nothing about the caller decides what it may see; the
 * shipped host passes one fixed tokenless caller.
 */
export type AgentQaMcpDepsResolver = (ctx: McpRequestContext) => AgentQaMcpServerDeps

/**
 * A Node request handler serving this catalog over stateless streamable HTTP.
 *
 * The factory is re-run per request, which is the SDK's own model and not an inefficiency to route
 * around: a per-request instance is what makes a caller's tool set a property of that caller rather
 * than of whoever connected first, and it is why absence stays structural on this transport too.
 *
 * IT TAKES A RESOLVER AND NOT A FIXED `deps` (plan 05). 2026-10-02: the
 * bearer check that once sat in front of this handler is deleted with MCP tokens; what
 * stays in front of it is the host's Host and Origin guard on the loopback listener. The resolver
 * receives the SDK context and builds the instance; it reads no header and verifies nothing.
 *
 * A host with one fixed caller passes `() => deps` — the static case is the degenerate resolver,
 * not a second signature to keep in step.
 */
export function createAgentQaMcpNodeHandler(resolveDeps: AgentQaMcpDepsResolver) {
  return toNodeHandler(createMcpHandler((ctx) => buildAgentQaMcpServer(resolveDeps(ctx))))
}
