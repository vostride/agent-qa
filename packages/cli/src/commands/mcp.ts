// Host, then Origin, then the handler: a request failing either never reaches a server build.

import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { serveStdio } from '@modelcontextprotocol/server/stdio'
import {
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  validateHostHeader,
  validateOriginHeader,
} from '@modelcontextprotocol/server'
import { buildAgentQaMcpServer, createAgentQaMcpNodeHandler } from '@vostride/agent-qa-mcp'
import type { LiveLinkSupplier } from '@vostride/agent-qa-mcp'
import { reserveStdoutForData } from '@vostride/agent-qa-core/run-text-output'
import type { FunctionCaller } from '@vostride/agent-qa-schema'
import { Command } from 'commander'
import pc from 'picocolors'
import { dirname, resolve } from 'node:path'

import { analyticsEvent, composeAnalyticsHost } from '../composition/analytics-host.js'
import { createDeclaredSecretMask } from '../composition/declared-secrets.js'
import type { DeclaredSecretMask } from '../composition/declared-secrets.js'
import { composeCliLocalAgent, withRunDoor } from '../composition/local-agent-host.js'
import { readAnalyticsPrivacyDeclaration, resolveConfig } from '../config.js'

/** The one line the stdio host prints, on stderr, once the server is listening. */
export const MCP_STDIO_STARTUP_MESSAGE =
  'agent-qa MCP server running over stdio. Waiting for MCP client messages on stdin. '
  + 'Stdout is reserved for MCP protocol traffic.'

/** The only interface the HTTP face is ever bound to. */
export const MCP_HTTP_BIND_HOST = '127.0.0.1'

/** The default port for `--http` with no argument. */
export const MCP_HTTP_DEFAULT_PORT = 3471

// `origin: 'agent'` because nobody typed an MCP request; the receipts record it.
export const MCP_FUNCTION_CALLER: FunctionCaller = Object.freeze({
  surface: 'mcp',
  origin: 'agent',
})

/** How a request was refused before it reached any server instance. */
export type McpHttpRefusal = 'host' | 'origin'

// Only the project's declared secrets are masked, never the environment; every MCP face uses it.
export function composeMcpMasking(input: { configPath: string }): DeclaredSecretMask {
  return createDeclaredSecretMask(input.configPath)
}

// The one place deps are composed, so stdio and HTTP build identical servers.
function mcpServerDeps(input: {
  registry: Parameters<typeof buildAgentQaMcpServer>[0]['registry']
  maskText: (text: string) => string
  // Threaded only through here, so stdio and HTTP results carry the same links.
  liveLink?: LiveLinkSupplier
}) {
  return {
    registry: input.registry,
    caller: MCP_FUNCTION_CALLER,
    maskText: input.maskText,
    // Absent stays ABSENT rather than becoming a present `undefined`: the house rule for an
    // optional member, and the two are the same posture to the builder either way.
    ...(input.liveLink === undefined ? {} : { liveLink: input.liveLink }),
  }
}

// Exported so tests drive this exact guard order over a real socket; `onRefusal` is test-only.
export function createMcpHttpRequestListener(input: {
  registry: Parameters<typeof buildAgentQaMcpServer>[0]['registry']
  maskText: (text: string) => string
  onRefusal?: (refusal: McpHttpRefusal) => void
  // Exported so the dashboard's co-hosted mount binds the same guard order with its own origin.
  liveLink?: LiveLinkSupplier
}): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    // (1) DNS-rebinding guard. A browser page on any origin can resolve a name it controls to
    // 127.0.0.1; what it cannot do is change the `Host` header it sends. The SDK's own validator is
    // used rather than a regexp here, so the parsing of ports and IPv6 brackets is the protocol
    // library's problem and not a second reading of the same grammar.
    const host = validateHostHeader(req.headers.host, localhostAllowedHostnames())
    if (!host.ok) {
      input.onRefusal?.('host')
      // The refusal names the CLASS and echoes nothing the caller sent: a 403 body that quoted the
      // rejected header back would make this endpoint a reflector.
      return refuse(res, 403, 'forbidden_host')
    }

    // (2) Origin guard. Absent is allowed — non-browser MCP clients do not send one — and a present
    // value that is not a localhost form is refused, which is the case that matters: a page.
    const origin = validateOriginHeader(req.headers.origin, localhostAllowedOrigins())
    if (!origin.ok) {
      input.onRefusal?.('origin')
      return refuse(res, 403, 'forbidden_origin')
    }

    // Every request past the two guards is served by the same caller, so none can donate authority.
    const nodeHandler = createAgentQaMcpNodeHandler(() => mcpServerDeps({
      registry: input.registry,
      maskText: input.maskText,
      ...(input.liveLink === undefined ? {} : { liveLink: input.liveLink }),
    }))
    // A run this request starts records `mcp`, on whichever host serves it.
    withRunDoor('mcp', () => { void nodeHandler(req, res) })
  }
}

function refuse(res: ServerResponse, status: number, error: string): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error }))
}

export interface McpCommandDeps {
  composeAnalytics?: typeof composeAnalyticsHost
}

export function createMcpCommand(deps: McpCommandDeps = {}): Command {
  const cmd = new Command('mcp')
    .description('Start MCP (Model Context Protocol) server over stdio, or over loopback HTTP')
    .option(
      '--http [port]',
      `serve over stateless HTTP bound to ${MCP_HTTP_BIND_HOST} instead of stdio`,
    )
    .action(async (options: { http?: string | boolean }, command: Command) => {
      try {
        const program = command.parent
        const globalOpts = program?.opts<{ config?: string }>() ?? {}
        // Tolerant and plugin-free; read only for analytics and the dashboard base.
        let config: Awaited<ReturnType<typeof resolveConfig>> | undefined
        try {
          config = await resolveConfig({ configPath: globalOpts.config, loadAuthPlugins: false })
        } catch {
          config = undefined
        }

        const configPath = resolve(globalOpts.config ?? 'agent-qa.config.yaml')
        const agentQaRoot = resolve(dirname(configPath), '.agent-qa')

        // Unmasked because the base becomes a followed link; absent means a named absence, no URL.
        const configuredDashboardBase = typeof config?.services?.dashboard?.baseUrl === 'string'
          && config.services.dashboard.baseUrl.trim() !== ''
          ? config.services.dashboard.baseUrl.trim()
          : undefined
        const liveLink = { dashboardBaseUrl: () => configuredDashboardBase }

        // See `composeMcpMasking` — the one masker both transports and the analytics port share.
        const declared = composeMcpMasking({ configPath })
        const maskText = declared.mask

        // An invalid config's privacy flag is read raw, as in chat.
        const analyticsConfig = config ?? await readAnalyticsPrivacyDeclaration(globalOpts.config)
        const analytics = await (deps.composeAnalytics ?? composeAnalyticsHost)({
          surface: 'mcp',
          ...(analyticsConfig === undefined ? {} : { config: analyticsConfig }),
          maskingContext: { mask: maskText },
        })

        const host = composeCliLocalAgent({
          // The host and the transport share one declared-secret loader.
          declaredSecrets: declared,
          // Explain counter hooks bind to this port, so `agent.explain` counts over MCP as in chat.
          analytics,
          agentQaRoot,
          configPath,
          runTrigger: 'mcp',
          // No `knowledgeChangeDelegate`: the default hands lease-needing changes to the daemon.
        })

        const overHttp = options.http !== undefined && options.http !== false
        const mcpTransport = overHttp ? 'http' as const : 'stdio' as const
        // The lifecycle pair is emitted from ONE place for each half, and `onServing` is what makes
        // the `started` half a fact rather than an intention: it fires where each serving entry
        // writes its own startup line — after the socket is bound / the stdio entry is live — so an
        // `agent-qa mcp` that failed to bind reports nothing rather than a server that never was.
        const emitLifecycle = (state: 'started' | 'stopped'): void => {
          analytics.port.capture(analyticsEvent(analytics, 'agent-qa.mcp.server.lifecycle', {
            mcp_server_state: state,
            mcp_transport: mcpTransport,
            // `mcp_tool_count` is absent: HTTP builds a server per request, so no one count exists.
          }))
        }

        try {
          if (overHttp) {
            await serveOverHttp({
              port: httpPort(options.http as string | boolean),
              registry: host.registry,
              maskText,
              liveLink,
              onServing: () => emitLifecycle('started'),
            })
          } else {
            await serveOverStdio({
              registry: host.registry,
              maskText,
              liveLink,
              onServing: () => emitLifecycle('started'),
            })
          }
        } finally {
          emitLifecycle('stopped')
          await host.close().catch(() => {})
          // Drains the port this command composed and releases its timers, so the process can exit.
          await analytics.shutdown()
        }
      } catch (err) {
        console.error(
          pc.red('Failed to start MCP server:'),
          err instanceof Error ? err.message : String(err),
        )
        process.exitCode = 1
      }
    })

  return cmd
}

/** No value is the default port, `--http 4000` is that port and `--http 0` is any free one. */
function httpPort(value: string | boolean): number {
  if (value === true) return MCP_HTTP_DEFAULT_PORT
  const parsed = Number.parseInt(String(value), 10)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`--http expects a port between 0 and 65535, received ${String(value)}`)
  }
  return parsed
}

async function serveOverStdio(input: {
  registry: Parameters<typeof buildAgentQaMcpServer>[0]['registry']
  maskText: (text: string) => string
  // The base supplier, the same object the HTTP face is handed.
  liveLink?: LiveLinkSupplier
  /** Fired once the entry is live — see the lifecycle note at the call site. */
  onServing?: () => void
}): Promise<void> {
  const releaseStdout = reserveStdoutForData()
  try {
    const handle = serveStdio(() =>
      buildAgentQaMcpServer(
        mcpServerDeps({
          registry: input.registry,
          maskText: input.maskText,
          ...(input.liveLink === undefined ? {} : { liveLink: input.liveLink }),
        }),
      ),
    )
    // stderr, never stdout — see the file header. Written after the serving entry is live so the
    // line is a fact about a running server rather than an intention.
    process.stderr.write(`${MCP_STDIO_STARTUP_MESSAGE}\n`)
    input.onServing?.()
    // The process serves until its stdin closes, which is how a spawning client stops it.
    await new Promise<void>((settle) => {
      process.stdin.once('end', () => settle())
      process.stdin.once('close', () => settle())
    })
    await handle.close()
  } finally {
    releaseStdout()
  }
}

async function serveOverHttp(input: {
  port: number
  registry: Parameters<typeof buildAgentQaMcpServer>[0]['registry']
  maskText: (text: string) => string
  // The base supplier, the same object the stdio face is handed.
  liveLink?: LiveLinkSupplier
  /** Fired once the socket is bound — see the lifecycle note at the call site. */
  onServing?: () => void
}): Promise<void> {
  const server = createServer(
    createMcpHttpRequestListener({
      registry: input.registry,
      maskText: input.maskText,
      ...(input.liveLink === undefined ? {} : { liveLink: input.liveLink }),
    }),
  )
  await new Promise<void>((listening, failed) => {
    server.once('error', failed)
    // The bind address is the constant MCP_HTTP_BIND_HOST and never a config value: an operator
    // who could widen it to `0.0.0.0` through configuration would be one typo from exposing an
    // ungated function registry to their network.
    server.listen(input.port, MCP_HTTP_BIND_HOST, () => listening())
  })
  // stderr, and the bound address as the OS reports it rather than as it was requested — a message
  // naming a port the server did not get is worse than no message.
  const address = server.address()
  const bound = typeof address === 'object' && address !== null ? address.port : input.port
  process.stderr.write(
    `agent-qa MCP server listening on http://${MCP_HTTP_BIND_HOST}:${bound}/. `
    + `Stateless: one server instance per request, no session id.\n`,
  )
  input.onServing?.()
  await new Promise<void>((settle) => {
    process.once('SIGINT', () => settle())
    process.once('SIGTERM', () => settle())
    server.once('close', () => settle())
  })
  await new Promise<void>((closed) => server.close(() => closed()))
}
