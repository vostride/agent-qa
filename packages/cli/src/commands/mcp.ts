// `agent-qa mcp` — the THIRD host over the function registry (Phase 396 plans 01 + 05, D-09 / D-10).
//
// WHY THIS FILE EXISTS IN THIS SHAPE. There are two hosts already: the interactive chat host and
// the daemon. Each composes the SAME registry through the SAME composition root and differs only in
// what it binds around it — who can be asked, what can be executed, who the caller is. This is the
// third, and the whole architectural claim of the phase is that being an MCP server is not a
// different KIND of thing: it is one more host, so this file composes and binds, and holds no
// capability of its own. The v1 server it replaces held thirty-three, and reached its data through
// the dashboard's REST API — a private power channel with no gate on it, which is exactly the shape
// the milestone abolishes.
//
// THE SPAWN MODEL IS PRESERVED DELIBERATELY. The command is still `mcp`, still stdio by default,
// because editor and client configurations out in the world encode `agent-qa mcp` and D-09 rates
// moving the server into the daemon as a costly reversal for precisely that reason.
//
// STDOUT IS THE PROTOCOL CHANNEL. Every diagnostic goes to stderr, and the stdio server reserves
// stdout while it serves so text wrapped under GitHub Actions stays on stderr too.
//
// TWO TRANSPORTS, ONE SERVER (D-10, plan 05). `--http` binds a stateless loopback endpoint beside
// the stdio default. Both reach `buildAgentQaMcpServer` through the same `mcpServerDeps` helper with
// the same caller, so the two transports cannot disagree about what a caller sees or can call.
// 2026-10-01 (432-21, D-12/D-13): they used to differ in exactly one thing, how a caller's scope
// set was resolved — a bearer header on HTTP, a config switch on stdio. Both are deleted, with the
// token declarations they read: every caller lists and calls every tool. What still differs is the
// network boundary, and only HTTP has one.
//
// THE ORDER OF THE HTTP GUARDS IS THE SECURITY CLAIM, and it is written as straight-line code
// rather than as middleware for that reason: Host, then Origin, then — and only then — the MCP
// handler. A request that fails either never reaches a factory, so a rebound DNS name or a page on
// another origin cannot reach a server build at all. The bearer rung that stood between them and
// the handler is deleted (432-21, D-12); the two guards and the loopback bind are what D-13 keeps.
//
// NO CORS HEADER IS EMITTED, ANYWHERE. The deleted v1 bridge answered every request and every
// preflight with `Access-Control-Allow-Origin: *`, which on a loopback JSON-RPC endpoint is an
// invitation to exactly the cross-origin reach the Origin guard above refuses. An acceptance grep
// counts occurrences of that header name in this file and requires zero, so the prohibition is
// pinned by something that fails rather than by this sentence.
//
// Protocol grounding: SEP-2575 (stateless — no `initialize` handshake, no session id; `serveStdio`
// owns era negotiation and serves 2025-era clients from the same factory, and the HTTP face builds
// one instance per REQUEST and holds nothing between them), SEP-2567 (list results no longer vary
// per connection; since 432-20/432-21 they do not vary per caller either),
// SEP-2243 (Host/Origin validation at the HTTP boundary for loopback endpoints).

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
import { reserveStdoutForData } from '@vostride/agent-qa-core'
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

/** The only interface the HTTP face is ever bound to (D-10). */
export const MCP_HTTP_BIND_HOST = '127.0.0.1'

/** The default port for `--http` with no argument. The v1 endpoint used the same one. */
export const MCP_HTTP_DEFAULT_PORT = 3471

// 2026-10-01 (432-21, D-12): `MCP_AUTH_TOKEN_SENTINEL` is deleted. It filled `AuthInfo.token` so a
// resolved bearer verdict could ride `req.auth` without the presented value; there is no verdict
// and no `req.auth` any more.

/**
 * The caller this host mints — one record, for every request on both transports.
 *
 * `origin: 'agent'` and not `'human'`: nobody typed an MCP request, so the composition root says an
 * agent is what it is (391 D-06). Since 432-20 nothing reads `origin` to decide what a caller may
 * do; it stays because the receipts that already record a caller's origin still read it.
 *
 * 2026-10-01 (432-21, D-12): no scope set, no safe-mode flag and no credential. The bearer header
 * that once chose a scope set, the stdio config switch that added `config-write`, and the
 * knowledge-write credential a declared bearer carried are all deleted. Every caller is this one.
 */
export const MCP_FUNCTION_CALLER: FunctionCaller = Object.freeze({
  surface: 'mcp',
  origin: 'agent',
})

/** How a request was refused before it reached any server instance. */
export type McpHttpRefusal = 'host' | 'origin'

// 2026-10-14 (441-07, D-01): only the project's declared secrets are masked, never the environment.
// 2026-10-14 (441-07, D-06): both transports and the dashboard's co-hosted endpoint mask with it.
export function composeMcpMasking(input: { configPath: string }): DeclaredSecretMask {
  return createDeclaredSecretMask(input.configPath)
}

/**
 * Bind the one caller to a registry and a masker.
 *
 * THE ONE PLACE deps are composed, so stdio and HTTP cannot drift into two different servers.
 * 2026-10-01 (432-21, D-12): a transport supplies nothing here any more — not a scope set, not a
 * credential — so both build the identical deps object.
 */
function mcpServerDeps(input: {
  registry: Parameters<typeof buildAgentQaMcpServer>[0]['registry']
  maskText: (text: string) => string
  /**
   * Which dashboard this process is pointed at (408 plan 03, D-08/D-09).
   *
   * THREADED THROUGH THIS FUNCTION AND NOWHERE ELSE, on this function's own stated law: the two
   * transports build one deps object. A supplier passed at
   * one of the two `buildAgentQaMcpServer` call sites and not the other would be a stdio server
   * whose results carry a working link and an HTTP server whose results do not — which is exactly
   * the per-transport policy the whole file is written to make impossible.
   */
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

/**
 * The loopback request listener: Host, Origin, handler — in that order (D-10, D-13).
 *
 * EXPORTED because a differential that drives anything other than this function is measuring a
 * second implementation of the guard order. MCPS-04's cells bind a real socket to this listener and
 * speak real `Host` and `Origin` headers over it, which is the only way to assert on the surface a
 * caller actually reads. 2026-10-01 (432-21, D-12): the bearer rung is deleted; an `Authorization`
 * header is neither required nor read.
 *
 * `onRefusal` exists so a test can tell WHICH wall answered without this function writing a
 * diagnostic that would then be a channel for the header it just refused. Nothing in production
 * passes it.
 */
export function createMcpHttpRequestListener(input: {
  registry: Parameters<typeof buildAgentQaMcpServer>[0]['registry']
  maskText: (text: string) => string
  onRefusal?: (refusal: McpHttpRefusal) => void
  /**
   * D-08's base supplier, passed straight through to the deps (408 plan 03).
   *
   * EXPORTED SURFACE, and that is the point of putting it here rather than only on the command: the
   * co-hosted mount inside `agent-qa dashboard` binds THIS listener — the same guard order, the
   * same factory — and it is the composition that actually knows an origin, because it is the one
   * that bound a port. A second listener written there to carry a base would be a second reading of
   * the Host/Origin discipline this function is exported to prevent (Pitfall 7).
   */
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

    // 2026-10-01 (432-21, D-12): no bearer rung. Every request that passed the two guards above
    // is served by the same caller, so no request can carry or donate authority to another, and
    // nothing a caller sends reaches `req.auth` or a protocol response.
    const nodeHandler = createAgentQaMcpNodeHandler(() => mcpServerDeps({
      registry: input.registry,
      maskText: input.maskText,
      ...(input.liveLink === undefined ? {} : { liveLink: input.liveLink }),
    }))
    // 2026-10-17 (443-06, D-24): a run this request starts records `mcp`, on whichever host serves it.
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
        // 2026-10-16 (442-08, D-18): tolerant, plugin-free; only analytics and the dashboard base.
        let config: Awaited<ReturnType<typeof resolveConfig>> | undefined
        try {
          config = await resolveConfig({ configPath: globalOpts.config, loadAuthPlugins: false })
        } catch {
          config = undefined
        }

        const configPath = resolve(globalOpts.config ?? 'agent-qa.config.yaml')
        const agentQaRoot = resolve(dirname(configPath), '.agent-qa')

        // 408 plan 03 (D-08/D-09 · D-03's floor): WHICH DASHBOARD THIS HOST IS POINTED AT.
        //
        // Read off this command's own resolved config,
        // at `services.dashboard.baseUrl`, which is the 387 D-10 knob and the shipped mechanism for
        // pointing a CLI or MCP host at somebody's dashboard. It is not read through the masked
        // config reader for the reason that reader exists: masking answers "what may this value be
        // shown as", and this value is not shown, it is COMPOSED INTO an address a person follows.
        // (The overlay's own note says the same thing from the other side — the base is
        // `masked: false` because a base URL is not the operator's secret.)
        //
        // ABSENT MEANS ABSENT. A standalone `agent-qa mcp` composes no live view — `runs.liveurl`
        // is declared-and-unbound here, so no App resource registers at all (plan 01's D-A gate) —
        // and it binds no HTTP origin worth linking to on stdio. With no configured base there is
        // nothing to point at, and every carrier result carries the NAMED ABSENCE rather than a
        // fabricated URL. That is D-03's ratified floor for this process, said in one line.
        const configuredDashboardBase = typeof config?.services?.dashboard?.baseUrl === 'string'
          && config.services.dashboard.baseUrl.trim() !== ''
          ? config.services.dashboard.baseUrl.trim()
          : undefined
        const liveLink = { dashboardBaseUrl: () => configuredDashboardBase }

        // See `composeMcpMasking` — the one masker both transports and the analytics port share.
        const declared = composeMcpMasking({ configPath })
        const maskText = declared.mask

        // 2026-10-21 (447-06, D-09): an invalid config's privacy flag is read raw, as in chat.
        const analyticsConfig = config ?? await readAnalyticsPrivacyDeclaration(globalOpts.config)
        const analytics = await (deps.composeAnalytics ?? composeAnalyticsHost)({
          surface: 'mcp',
          ...(analyticsConfig === undefined ? {} : { config: analyticsConfig }),
          maskingContext: { mask: maskText },
        })

        const host = composeCliLocalAgent({
          // 2026-10-14 (441-07, D-06): the host and the transport share one declared-secret loader.
          declaredSecrets: declared,
          // 398-10 (D-11/D-18): the explain counter hooks bind against this port inside the
          // composition root, so `agent.explain` is countable over MCP exactly as it is in chat.
          analytics,
          agentQaRoot,
          configPath,
          runTrigger: 'mcp',
          // 2026-10-01 (432-17, D-05): no minting surface — a change is written in the call and
          // nothing is filed for a later reader to attribute.
          // 432-16 (D-14): no confirm port exists to refuse. 396-01 D-09 passed `confirm: undefined`
          // here so the host would never write a prompt onto the JSON-RPC stdout; the host has no
          // prompt and no such field now.
          // `knowledgeChangeDelegate` is deliberately NOT passed. The composition root's own default
          // is already a closure over `invokeViaDaemon` — the same socket every other capability
          // crosses — so a change that needs a lease a running daemon holds is handed to that
          // daemon. Supplying one here would be a second transport for one job (D-09).
        })

        // 2026-08-17 (Phase 398 plan 10, D-18): `agent-qa.mcp.tool.invoked` HAS NO EMITTER YET, and
        // saying so here is more honest than a half-wired one.
        //
        // There is no seam this host can reach. A tool call is dispatched inside
        // `buildAgentQaMcpServer`, and the two things a host holds — the registry and the caller —
        // cannot observe it: the registry's internals are keyed by object identity in a `WeakMap`,
        // so a decorating wrapper is simply an object `invokeFunction` finds no specs on, and the
        // caller is a record rather than an invoke.
        //
        // WHAT IT NEEDS: an optional `onToolInvoked` observation on `AgentQaMcpServerDeps`, called
        // at the two `registerTool` sites with the tool name, a duration and a success/error verdict
        // — counts and closed vocabularies, nothing a caller supplied. This host then maps it onto
        // the union member and captures it through the port already composed above. That is a
        // change to `packages/mcp`, which this plan does not own; it is filed in
        // `.planning/.../deferred-items.md`.
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
            // `mcp_tool_count` is DELIBERATELY ABSENT and the field stays optional for this reason.
            // How many tools exist is decided inside `buildAgentQaMcpServer` by what this
            // composition registers — and under HTTP there is one instance per REQUEST, so there is
            // no single number for the process without a second census of that registration.
            // Retune: when the builder reports its own registered count, that number can ride here.
            // (Until 432-20 the count also varied per caller, by `visibleToCaller`; it no longer
            // does.)
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
          // The PORT's shutdown, not an ambient `flushAnalytics({ config })`. The v1 call drained a
          // process-global service this command never captured through; this one drains the object
          // this command composed, and releases the transport's timers so the process can exit.
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

/** `--http` with no value is the default port; `--http 4000` is that port. */
function httpPort(value: string | boolean): number {
  if (value === true) return MCP_HTTP_DEFAULT_PORT
  const parsed = Number.parseInt(String(value), 10)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`--http expects a port between 1 and 65535, received ${String(value)}`)
  }
  return parsed
}

async function serveOverStdio(input: {
  registry: Parameters<typeof buildAgentQaMcpServer>[0]['registry']
  maskText: (text: string) => string
  /** D-08's base supplier (408 plan 03) — the same object the HTTP face is handed. */
  liveLink?: LiveLinkSupplier
  /** Fired once the entry is live — see the lifecycle note at the call site. */
  onServing?: () => void
}): Promise<void> {
  // 2026-10-01 (432-21/432-22, D-12): no stdio grant. The `grantConfigWrite` opt-in that added
  // `config-write` to a stdio caller is deleted; a stdio caller is the HTTP caller.
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
  /** D-08's base supplier (408 plan 03) — the same object the stdio face is handed. */
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
