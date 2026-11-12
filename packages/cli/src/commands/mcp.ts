// Host, then Origin, then the handler: a request failing either never reaches a server build.

import { stat } from 'node:fs/promises'
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
import type { AgentQaMcpPosture, LiveLinkSupplier } from '@vostride/agent-qa-mcp'
import { getAgentQaVersion } from '@vostride/agent-qa-core'
import { reserveStdoutForData } from '@vostride/agent-qa-core/run-text-output'
import type { FunctionCaller } from '@vostride/agent-qa-schema'
import { Command } from 'commander'
import pc from 'picocolors'
import { dirname, resolve } from 'node:path'

import { analyticsEvent, composeAnalyticsHost } from '../composition/analytics-host.js'
import {
  createDeclaredSecretMask,
  createEmptyDeclaredSecretMask,
  DeclaredSecretsUnavailableError,
} from '../composition/declared-secrets.js'
import type { DeclaredSecretMask } from '../composition/declared-secrets.js'
import { errorReporter, settleReporting } from '../composition/error-reporting.js'
import { composeCliLocalAgent, withRunDoor } from '../composition/local-agent-host.js'
import { createToolSettledObserver } from '../composition/mcp-tool-observer.js'
import type { ToolSettledAnalytics } from '../composition/mcp-tool-observer.js'
import { releaseRemoteSessions, REMOTE_RELEASE_BOUND_MS } from '../composition/remote-sessions.js'
import { readAnalyticsPrivacyDeclaration, resolveConfig } from '../config.js'
import { resolveMcpConfigPath } from './mcp-project.js'
import { projectHost } from './project-host.js'

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

const MCP_PROBLEM_MAX_LENGTH = 300

// One line only: a validation error lists every issue, and only its first is answered.
function firstProblemLine(err: unknown, configPath: string): string {
  const message = err instanceof DeclaredSecretsUnavailableError
    ? err.lines[0] ?? err.message
    : err instanceof Error ? err.message : String(err)
  const lines = message.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  const first = lines[0] === 'Config validation failed:' ? lines[1] : lines[0]
  const line = (first ?? 'the config could not be loaded')
    .replace(/^Error: /u, '')
    .replace(`${configPath}: `, '')
  return line.slice(0, MCP_PROBLEM_MAX_LENGTH)
}

// Decided before anything reads the config, so a missing or broken one never reaches a server.
export async function classifyMcpConfig(
  configPath: string,
): Promise<AgentQaMcpPosture | undefined> {
  try {
    await stat(configPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { state: 'not-initialized', configPath }
    }
    throw err
  }

  const declared = createDeclaredSecretMask(configPath)
  let failure: unknown
  try {
    await resolveConfig({ configPath, loadAuthPlugins: false })
  } catch (err) {
    failure = err
  }
  let mask: (text: string) => string = (text) => text
  try {
    const redactor = declared.redactor()
    mask = (text) => redactor.redactString(text)
  } catch (err) {
    failure ??= err
  }
  if (failure === undefined) return undefined
  return {
    state: 'config-invalid',
    configPath,
    problem: mask(firstProblemLine(failure, configPath)),
  }
}

// The one place deps are composed, so stdio and HTTP build identical servers.
function mcpServerDeps(input: {
  registry: Parameters<typeof buildAgentQaMcpServer>[0]['registry']
  maskText: (text: string) => string
  // Threaded only through here, so stdio and HTTP results carry the same links.
  liveLink?: LiveLinkSupplier
  posture?: AgentQaMcpPosture
  // Absent on the dashboard's mount, which composes none, so its tool calls report and trace only.
  analytics?: ToolSettledAnalytics
}) {
  return {
    registry: input.registry,
    caller: MCP_FUNCTION_CALLER,
    maskText: input.maskText,
    version: getAgentQaVersion().trim(),
    // Absent stays ABSENT rather than becoming a present `undefined`: the house rule for an
    // optional member, and the two are the same posture to the builder either way.
    ...(input.liveLink === undefined ? {} : { liveLink: input.liveLink }),
    ...(input.posture === undefined ? {} : { posture: input.posture }),
    onToolSettled: createToolSettledObserver(
      input.analytics === undefined ? {} : { analytics: input.analytics },
    ),
  }
}

// Exported so tests drive this exact guard order over a real socket; `onRefusal` is test-only.
export function createMcpHttpRequestListener(input: {
  registry: Parameters<typeof buildAgentQaMcpServer>[0]['registry']
  maskText: (text: string) => string
  onRefusal?: (refusal: McpHttpRefusal) => void
  // Exported so the dashboard's co-hosted mount binds the same guard order with its own origin.
  liveLink?: LiveLinkSupplier
  posture?: AgentQaMcpPosture
  analytics?: ToolSettledAnalytics
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
      ...(input.posture === undefined ? {} : { posture: input.posture }),
      ...(input.analytics === undefined ? {} : { analytics: input.analytics }),
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
  exit?: (code: number) => void
}

export interface McpSignalSource {
  once(signal: NodeJS.Signals, listener: () => void): unknown
  off(signal: NodeJS.Signals, listener: () => void): unknown
}

export interface McpStopSignal {
  /** Settles on the first SIGINT or SIGTERM. */
  readonly stopped: Promise<void>
  signalled(): boolean
  /** The remote release the signal started, bounded per session. */
  released(): Promise<void>
  detach(): void
}

// The first signal releases every remote session at once, as `agent-qa run` does, and stops
// serving; with no listener left, a second signal ends the process as it always did.
export function listenForStopSignal(
  signals: McpSignalSource = process,
  release: (boundMs: number) => Promise<void> = releaseRemoteSessions,
): McpStopSignal {
  let settle: () => void = () => undefined
  const stopped = new Promise<void>((done) => {
    settle = done
  })
  let releasing: Promise<void> | undefined
  const detach = (): void => {
    signals.off('SIGINT', onSignal)
    signals.off('SIGTERM', onSignal)
  }
  function onSignal(): void {
    if (releasing !== undefined) return
    detach()
    releasing = release(REMOTE_RELEASE_BOUND_MS).catch(() => undefined)
    settle()
  }
  signals.once('SIGINT', onSignal)
  signals.once('SIGTERM', onSignal)
  return {
    stopped,
    signalled: () => releasing !== undefined,
    released: () => releasing ?? Promise.resolve(),
    detach,
  }
}

export async function closeMcpHost(deps: {
  closeHost(): Promise<void>
  stopAppium(boundMs: number): Promise<void> | undefined
  settleReporting(): Promise<void>
}): Promise<void> {}

export function createMcpCommand(deps: McpCommandDeps = {}): Command {
  const cmd = new Command('mcp')
    .description('Start MCP (Model Context Protocol) server over stdio, or over loopback HTTP')
    .option(
      '--http [port]',
      `serve over stateless HTTP bound to ${MCP_HTTP_BIND_HOST} instead of stdio`,
    )
    .action(async (options: { http?: string | boolean }, command: Command) => {
      let restoreFolder: string | undefined
      try {
        // A refused port composes nothing: no config read, mask, analytics or agent host.
        const port = options.http === undefined || options.http === false
          ? undefined
          : httpPort(options.http)
        const program = command.parent
        const globalOpts = program?.opts<{ config?: string }>() ?? {}
        // Hosts start the server in their own folder, so the project is searched for upward.
        const location = await resolveMcpConfigPath({
          config: globalOpts.config ?? 'agent-qa.config.yaml',
          env: process.env,
          cwd: process.cwd(),
          host: projectHost(),
        })
        const configPath = location.configPath
        // Helpers below still read process.cwd(), so the server sees the project as if started there.
        if (location.found) {
          restoreFolder = process.cwd()
          process.chdir(location.projectDir)
        }
        const posture = await classifyMcpConfig(configPath)
        // Tolerant and plugin-free; read only for analytics and the dashboard base.
        let config: Awaited<ReturnType<typeof resolveConfig>> | undefined
        try {
          config = await resolveConfig({ configPath, loadAuthPlugins: false })
        } catch {
          config = undefined
        }

        const agentQaRoot = resolve(dirname(configPath), '.agent-qa')

        // Unmasked because the base becomes a followed link; absent means a named absence, no URL.
        const configuredDashboardBase = typeof config?.services?.dashboard?.baseUrl === 'string'
          && config.services.dashboard.baseUrl.trim() !== ''
          ? config.services.dashboard.baseUrl.trim()
          : undefined
        const liveLink = { dashboardBaseUrl: () => configuredDashboardBase }

        // See `composeMcpMasking` — the one masker both transports and the analytics port share.
        const declared = posture === undefined
          ? composeMcpMasking({ configPath })
          : createEmptyDeclaredSecretMask()
        const maskText = declared.mask

        // An invalid config's privacy flag is read raw, as in chat.
        const analyticsConfig = config ?? await readAnalyticsPrivacyDeclaration(configPath)
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

        const mcpTransport = port === undefined ? 'stdio' as const : 'http' as const
        // The lifecycle pair is emitted from ONE place for each half, and `onServing` is what makes
        // the `started` half a fact rather than an intention: it fires where each serving entry
        // writes its own startup line — after the socket is bound / the stdio entry is live — and
        // `stopped` follows only a `started`, so an `agent-qa mcp` that failed to bind reports
        // nothing rather than a server that never was.
        const emitLifecycle = (state: 'started' | 'stopped'): void => {
          analytics.port.capture(analyticsEvent(analytics, 'agent-qa.mcp.server.lifecycle', {
            mcp_server_state: state,
            mcp_transport: mcpTransport,
            // `mcp_tool_count` is absent: HTTP builds a server per request, so no one count exists.
          }))
        }
        let serving = false
        const onServing = (): void => {
          serving = true
          emitLifecycle('started')
        }

        const stop = listenForStopSignal()
        try {
          const serve = {
            registry: host.registry,
            maskText,
            liveLink,
            onServing,
            stopped: stop.stopped,
            analytics: { host: analytics, mcpTransport },
            ...(posture === undefined ? {} : { posture }),
          }
          if (port === undefined) {
            await serveOverStdio(serve)
          } else {
            await serveOverHttp({ port, ...serve })
          }
        } finally {
          stop.detach()
          if (serving) emitLifecycle('stopped')
          await host.close().catch(() => {})
          // Drains the port this command composed and releases its timers, so the process can exit.
          await settleReporting({ analytics })
        }
        if (stop.signalled()) {
          await stop.released()
          await settleReporting()
          ;(deps.exit ?? process.exit)(0)
        }
      } catch (err) {
        console.error(
          pc.red('Failed to start MCP server:'),
          err instanceof Error ? err.message : String(err),
        )
        errorReporter()?.capture(err)
        process.exitCode = 1
      } finally {
        // An in-process caller gets its working folder back once serving ends.
        if (restoreFolder !== undefined) process.chdir(restoreFolder)
      }
    })

  return cmd
}

/** No value is the default port, `--http 4000` is that port and `--http 0` is any free one. */
export function httpPort(value: string | boolean): number {
  if (value === true) return MCP_HTTP_DEFAULT_PORT
  const text = String(value)
  // Canonical decimal only, so a typo such as `0x1f90`, `-0` or `08080` is refused, never bound.
  const port = /^(?:0|[1-9]\d{0,4})$/u.test(text) ? Number(text) : Number.NaN
  if (!(port >= 0 && port <= 65535)) {
    throw new Error(`--http expects a decimal port between 0 and 65535, received ${text}`)
  }
  return port
}

async function serveOverStdio(input: {
  registry: Parameters<typeof buildAgentQaMcpServer>[0]['registry']
  maskText: (text: string) => string
  // The base supplier, the same object the HTTP face is handed.
  liveLink?: LiveLinkSupplier
  posture?: AgentQaMcpPosture
  analytics?: ToolSettledAnalytics
  /** Fired once the entry is live — see the lifecycle note at the call site. */
  onServing?: () => void
  stopped: Promise<void>
}): Promise<void> {
  const releaseStdout = reserveStdoutForData()
  try {
    const handle = serveStdio(
      () =>
        buildAgentQaMcpServer(
          mcpServerDeps({
            registry: input.registry,
            maskText: input.maskText,
            ...(input.liveLink === undefined ? {} : { liveLink: input.liveLink }),
            ...(input.posture === undefined ? {} : { posture: input.posture }),
            ...(input.analytics === undefined ? {} : { analytics: input.analytics }),
          }),
        ),
      {
        // The SDK answers a failed request with a bare -32603, so the cause goes to stderr.
        onerror: (error) => {
          const message = (error.message.split('\n')[0] ?? '').trim()
          let masked: string
          try {
            masked = input.maskText(message)
          } catch {
            // The mask itself can be what failed; an unmasked message is never written.
            masked = error.name
          }
          process.stderr.write(`agent-qa MCP server error: ${masked}\n`)
        },
      },
    )
    // stderr, never stdout — see the file header. Written after the serving entry is live so the
    // line is a fact about a running server rather than an intention.
    process.stderr.write(`${MCP_STDIO_STARTUP_MESSAGE}\n`)
    input.onServing?.()
    // The process serves until its stdin closes, which is how a spawning client stops it.
    await new Promise<void>((settle) => {
      process.stdin.once('end', () => settle())
      process.stdin.once('close', () => settle())
      void input.stopped.then(() => settle())
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
  posture?: AgentQaMcpPosture
  analytics?: ToolSettledAnalytics
  /** Fired once the socket is bound — see the lifecycle note at the call site. */
  onServing?: () => void
  stopped: Promise<void>
}): Promise<void> {
  const server = createServer(
    createMcpHttpRequestListener({
      registry: input.registry,
      maskText: input.maskText,
      ...(input.liveLink === undefined ? {} : { liveLink: input.liveLink }),
      ...(input.posture === undefined ? {} : { posture: input.posture }),
      ...(input.analytics === undefined ? {} : { analytics: input.analytics }),
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
    void input.stopped.then(() => settle())
    server.once('close', () => settle())
  })
  await new Promise<void>((closed) => server.close(() => closed()))
}
