import { Command } from 'commander'
import { createServer } from 'node:http'
import type { Server as NodeHttpServer } from 'node:http'
import { basename, resolve, dirname } from 'node:path'
import { createRequire } from 'node:module'
import pc from 'picocolors'
import {
  ANALYSIS_GET_FUNCTION_ID,
  invokeFunction,
  LiveViewUnavailableError,
  RUNS_ARTIFACT_FUNCTION_ID,
  RUNS_DETAIL_FUNCTION_ID,
  RUNS_EVIDENCE_FUNCTION_ID,
  RUNS_EVENTS_FUNCTION_ID,
  RUNS_KNOWLEDGE_FUNCTION_ID,
  RUNS_MARK_FUNCTION_ID,
  RUNS_MARK_PREVIEW_FUNCTION_ID,
  RUNS_MARKS_HISTORY_FUNCTION_ID,
  RUNS_POST_PROCESSING_FUNCTION_ID,
  RUNS_START_FUNCTION_ID,
  type ConfigReaderPort,
  type FunctionRegistry,
} from '@vostride/agent-qa-agent'
import type { LocalAgentHost } from '@vostride/agent-qa-agent-local'
import { resolveWorkspacePaths } from '@vostride/agent-qa-core'
import { printRunText } from '@vostride/agent-qa-core/run-text-output'
import type { RunAttributes } from '@vostride/agent-qa-core'
import type {
  AgentHost,
  AgentRegistryHandle,
  MintLiveUrlInput,
  RunServicePorts,
  RunServiceStartInput,
} from '@vostride/agent-qa-dashboard'
import { resolveVisionConfig } from '@vostride/agent-qa-model'
import type {
  ExecutionContext,
  FunctionCaller,
  MaskedConfigEntry,
  MaskedResolvedConfig,
  MaskFn,
  RunEventEnvelope,
  RunServiceReadiness,
  RunSession,
  RunStartAcknowledgement,
  RunsLiveUrlResult,
  RunsStartInput,
} from '@vostride/agent-qa-schema'
import {
  RUN_SERVICE_CONTRACT_VERSION,
  RunStartAcknowledgementSchema,
} from '@vostride/agent-qa-schema'
import { createRunServiceSessionRegistry } from '../composition/run-service-session-registry.js'
import type { RunServiceSessionRegistry } from '../composition/run-service-session-registry.js'
import {
  composeLiveView,
  mintEditorLiveUrlThrough,
  mintLiveUrlThrough,
} from '../composition/live-view-composition.js'
import { resolveConfig } from '../config.js'
// Reuses `mcp.ts`'s listener so the Host and Origin check order has one spelling.
import {
  composeMcpMasking,
  createMcpHttpRequestListener,
  MCP_HTTP_BIND_HOST,
  MCP_HTTP_DEFAULT_PORT,
} from './mcp.js'
import {
  CLI_FUNCTION_CALLER,
  composeCliLocalAgent,
  createConfigReader,
  withRunDoor,
} from '../composition/local-agent-host.js'
import { createDeclaredSecretMask } from '../composition/declared-secrets.js'
import { composeRunOwnership } from '../composition/run-owner-probe.js'
import type { ComposeCliLocalAgentInput } from '../composition/local-agent-host.js'
import {
  applyResolvedAuthToModelConfig,
  resolveModelAuth,
  type LLMConfigLike,
} from '../llm-utils.js'
import { DEFAULT_ANTHROPIC_MODEL } from '../model-defaults.js'

// The dot-path the entity card's `url` is read from, spelled as the producer reads it.
export const DASHBOARD_BASE_URL_CONFIG_KEY = 'services.dashboard.baseUrl'

// The producer needs both this and the base URL; either alone yields no url base.
export const DASHBOARD_WORKSPACE_CONFIG_KEY = 'services.dashboard.workspace'

// The CLI's caller with the dashboard surface name; the surface attributes and grants nothing.
export const DASHBOARD_FUNCTION_CALLER: FunctionCaller = Object.freeze({
  ...CLI_FUNCTION_CALLER,
  surface: 'dashboard',
})

// Published so the conformance suite composes the host as the command does; it decides nothing.
export function composeDashboardAgentHost(host: LocalAgentHost): AgentHost {
  return {
    registry: host.registry,
    caller: DASHBOARD_FUNCTION_CALLER,
    // Ids reach `dashboard-server` as data, because it may not import this package.
    runsPostProcessingFunctionId: RUNS_POST_PROCESSING_FUNCTION_ID,
    runsEventsFunctionId: RUNS_EVENTS_FUNCTION_ID,
    runsDetailFunctionId: RUNS_DETAIL_FUNCTION_ID,
    runsEvidenceFunctionId: RUNS_EVIDENCE_FUNCTION_ID,
    runsArtifactFunctionId: RUNS_ARTIFACT_FUNCTION_ID,
    analysisGetFunctionId: ANALYSIS_GET_FUNCTION_ID,
    runsKnowledgeFunctionId: RUNS_KNOWLEDGE_FUNCTION_ID,
    runsMarkFunctionId: RUNS_MARK_FUNCTION_ID,
    runsMarksHistoryFunctionId: RUNS_MARKS_HISTORY_FUNCTION_ID,
    runsMarkPreviewFunctionId: RUNS_MARK_PREVIEW_FUNCTION_ID,
    // Every invocation is the shipped `invokeFunction`, bound; no op is special-cased.
    invokeFunction: (
      registry: AgentRegistryHandle,
      functionId: string,
      input: unknown,
      caller: FunctionCaller,
    ): Promise<unknown> => invokeFunction(registry as FunctionRegistry, functionId, input, caller),
  }
}

// The operator's configured base wins; the bound origin fills only an absent one, unmasked.
export function overlayDashboardBaseUrl(
  inner: ConfigReaderPort,
  boundOrigin: () => string | undefined,
  workspaceSegment: string | undefined,
): ConfigReaderPort {
  return {
    async getMasked() {
      const masked = await inner.getMasked()
      const supplied: MaskedConfigEntry[] = []

      const origin = boundOrigin()
      if (origin !== undefined && !hasVerbatim(masked, DASHBOARD_BASE_URL_CONFIG_KEY)) {
        supplied.push({
          key: DASHBOARD_BASE_URL_CONFIG_KEY,
          value: origin,
          source: 'default',
          masked: false,
        })
      }

      // An empty segment stays absent, because `formatEntityUrl` refuses an empty workspace.
      if (
        workspaceSegment !== undefined
        && workspaceSegment.trim() !== ''
        && !hasVerbatim(masked, DASHBOARD_WORKSPACE_CONFIG_KEY)
      ) {
        supplied.push({
          key: DASHBOARD_WORKSPACE_CONFIG_KEY,
          value: workspaceSegment,
          source: 'default',
          masked: false,
        })
      }

      if (supplied.length === 0) return masked
      const overlaidKeys = new Set(supplied.map((entry) => entry.key))
      return {
        ...masked,
        entries: [
          ...masked.entries.filter((entry) => !overlaidKeys.has(entry.key)),
          ...supplied,
        ],
      }
    },
  }
}

/**
 * Does the inner config already carry the operator's OWN value for this key?
 *
 * The `masked` flag is read rather than the value, on `card-context.ts`'s own reasoning: a masked
 * entry is not the operator's value, and treating it as a presence would leave the overlay refusing
 * to fill an absence that is, as far as the producer is concerned, exactly what it is.
 */
function hasVerbatim(masked: MaskedResolvedConfig, key: string): boolean {
  const entry = masked.entries.find((candidate) => candidate.key === key)
  return entry !== undefined && !entry.masked && entry.value.trim() !== ''
}

/** Everything the door's composition needs that only its host knows. */
export interface DashboardDoorInput {
  /** The project's runtime root, i.e. `<configDir>/.agent-qa`. */
  readonly agentQaRoot: string
  /** The configuration file this door resolves against. */
  readonly configPath: string
  // A factory, because the server binds its port after the door is composed.
  readonly boundOrigin: () => string | undefined
  // Absent means `local-headless` for every call; neither arm falls back to TTY or CI markers.
  readonly resolveExecutionContext?: () => ExecutionContext
  readonly runBridge?: ComposeCliLocalAgentInput['runBridge']
  // Absent lists `runs.liveurl` as `unbound`.
  readonly liveView?: ComposeCliLocalAgentInput['liveView']
  // Absent, the composer binds a reader over the configured or default runs database path.
  readonly runDetail?: ComposeCliLocalAgentInput['runDetail']
}

/** The composed door: the local host it owns, and the seam the routes consume. */
export interface DashboardDoor {
  readonly host: LocalAgentHost
  readonly agentHost: AgentHost
  // The mask the host and its config reader share, for the server's config editor.
  readonly declaredSecretMask: MaskFn
}

// One composer for production and the suites; execution context and bound origin arrive as inputs.
export function composeDashboardDoor(input: DashboardDoorInput): DashboardDoor {
  // The config directory's name is the only workspace segment a local host has; config wins.
  const workspaceSegment = ((): string | undefined => {
    const name = basename(dirname(resolve(input.configPath)))
    return name === '' || name === '/' || name === '.' ? undefined : name
  })()

  // Every call records `local-headless` unless the caller overrides the context.
  const resolveExecutionContext = input.resolveExecutionContext
    ?? ((): ExecutionContext => 'local-headless')

  const declaredSecrets = createDeclaredSecretMask(input.configPath)
  const host = composeCliLocalAgent({
    agentQaRoot: input.agentQaRoot,
    configPath: input.configPath,
    declaredSecrets,
    // An absent port is an absent field.
    ...(input.liveView === undefined ? {} : { liveView: input.liveView }),
    ...(input.runDetail === undefined ? {} : { runDetail: input.runDetail }),
    config: overlayDashboardBaseUrl(
      createConfigReader(input.configPath, declaredSecrets.mask),
      input.boundOrigin,
      workspaceSegment,
    ),
    resolveExecutionContext,
    ...(input.runBridge === undefined ? {} : { runBridge: input.runBridge }),
    runTrigger: 'dashboard',
  })
  return {
    host,
    agentHost: composeDashboardAgentHost(host),
    declaredSecretMask: declaredSecrets.mask,
  }
}

// `dashboard-server` may not name the agent packages, so the run door is composed here.
export interface DashboardRunDoor {
  /** Handed to `composeDashboardDoor` BEFORE the host exists — see `bindHost`. */
  readonly runBridge: NonNullable<ComposeCliLocalAgentInput['runBridge']>
  /** Handed to `startServer`. The queue calls `execute` on it and nothing else does. */
  readonly backend: DashboardExecutionBackend
  /**
   * Bind the composed host once it exists.
   *
   * A MUTABLE BOX BECAUSE THE ORDER CANNOT BE INVERTED, exactly as `boundOrigin` above: the bridge
   * is an INPUT to the composition, and the starter needs the composition's registry. Reading it at
   * call time is what makes both true at once.
   */
  bindHost(host: LocalAgentHost): void
  // Published so `/ok`'s `hostComposed` and the invoke guard read the same box.
  resolveHost(): LocalAgentHost | undefined
  // One bridge both routes sessions and notifies observers; an observer's throw is swallowed.
  observeSessions(observer: (session: RunSession) => void): () => void
  /**
   * Resolves once every run this door's host has started has finished, and every piece of detached
   * post-run work those runs started has settled, including runs and work that start while it
   * waits. A run counts from the moment its execution starts, so a run that has logged
   * `runFinished` but not yet started its post-run work is still waited for. `agent-qa dashboard`'s
   * own shutdown does not call it, so work still running at shutdown is left for the job queue to
   * resume.
   */
  postRunSettled(): Promise<void>
}

/** Structural, so this module names the dashboard package's own type without importing its value. */
type DashboardExecutionBackend = import('@vostride/agent-qa-dashboard').ExecutionBackend

/** What the door holds for a run between `runs.start` going in and the run coming out. */
interface DashboardRunEntry {
  readonly onSession: (session: RunSession) => void
  readonly appiumUrl?: string
  readonly flags: DashboardRunFlags
  readonly attributes?: RunAttributes
}

/** The queue's argv operands that are FLAGS rather than patterns. Exactly one today. */
export interface DashboardRunFlags {
  readonly disableCache?: boolean
}

// Persisted queue rows hold argv, so operands are parsed, and an unknown flag is refused by name.
export function partitionDashboardRunArgs(args: readonly string[]): {
  readonly patterns: string[]
  readonly flags: DashboardRunFlags
  readonly unsupported: string[]
} {
  const patterns: string[] = []
  const unsupported: string[] = []
  let disableCache: true | undefined
  for (const arg of args) {
    if (!arg.startsWith('-')) {
      patterns.push(arg)
      continue
    }
    if (arg === '--disable-cache') {
      disableCache = true
      continue
    }
    unsupported.push(arg)
  }
  return {
    patterns,
    flags: disableCache === undefined ? {} : { disableCache },
    unsupported,
  }
}

/**
 * Compose the run door — ONE composer, for production and for the cells that measure it.
 *
 * PUBLISHED AND SINGULAR for `composeDashboardDoor`'s own reason: a cell that assembled its own
 * starter beside this one would be measuring a door this product does not ship.
 *
 * ASYNC because the dashboard package is imported lazily throughout this command (so `agent-qa
 * --help` does not pay for a web server), and both of the values below live in it.
 */
export async function createDashboardRunDoor(input: {
  /** The dashboard database THIS SERVER holds. One connection, one writer, one process. */
  readonly db: unknown
  // Threaded through the bridge, because the drain leg reads `runBridge.chipRelay` for its emitter.
  readonly chipRelay?: (envelope: RunEventEnvelope) => void
}): Promise<DashboardRunDoor> {
  const { createInProcessExecutionBackend } = await import('@vostride/agent-qa-dashboard')

  const entries = new Map<string, DashboardRunEntry>()
  // Everyone watching the one bridge this process's host publishes sessions through.
  const sessionObservers = new Set<(session: RunSession) => void>()
  const executions = new Set<Promise<unknown>>()
  const postRun = new Set<Promise<void>>()
  // Each entry leaves its set once it settles, through `then(drop, drop)` so a rejection is
  // never unhandled.
  const track = <T>(set: Set<Promise<T>>, work: Promise<T>): void => {
    set.add(work)
    const drop = (): void => { set.delete(work) }
    void work.then(drop, drop)
  }
  let boundHost: LocalAgentHost | undefined

  const runBridge: NonNullable<ComposeCliLocalAgentInput['runBridge']> = {
    // An absent relay is an absent field, so the drain leg's `relay === undefined` arm decides.
    ...(input.chipRelay === undefined ? {} : { chipRelay: input.chipRelay }),
    // Routed by the session's own id, because the door runs as many at once as the queue has slots.
    onSession: (session: RunSession): void => {
      entries.get(session.id as unknown as string)?.onSession(session)
      // Every watcher too, whichever door started the run.
      for (const observer of [...sessionObservers]) {
        try {
          observer(session)
        } catch { /* one watcher's failure is not another's, and never the run's */ }
      }
    },
    // Every run's record writes through this one handle when its runs.db is this file.
    record: {
      db: input.db as never,
      queueRun: (runId: string) => {
        const entry = entries.get(runId)
        if (entry === undefined) return undefined
        return entry.attributes === undefined ? {} : { attributes: entry.attributes }
      },
    },
    resolveAppiumUrl: (runId: string): string | undefined => entries.get(runId)?.appiumUrl,
    resolveRunFlags: (runId: string): DashboardRunFlags | undefined => entries.get(runId)?.flags,
    onExecution: (execution: Promise<unknown>): void => { track(executions, execution) },
    onPostRun: (settled: Promise<void>): void => { track(postRun, settled) },
  }

  const backend = createInProcessExecutionBackend({
    invokeRun: async ({ opts, onSession }) => {
      const host = boundHost
      if (host === undefined) {
        throw new Error('The dashboard run door was asked to start a run before its host was composed.')
      }
      const { patterns, flags, unsupported } = partitionDashboardRunArgs(opts.args)
      if (unsupported.length > 0) {
        throw new Error(
          `The dashboard run door does not honour ${unsupported.join(', ')}. `
          + 'Queued run arguments now travel as `runs.start` patterns and a small set of named '
          + 'flags; an operand nobody reads would change the run without saying so.',
        )
      }

      entries.set(opts.runId, {
        onSession,
        ...(opts.appiumUrl === undefined ? {} : { appiumUrl: opts.appiumUrl }),
        flags,
        ...(opts.attributes === undefined ? {} : { attributes: opts.attributes }),
      })
      try {
        const request: RunsStartInput = {
          // The enqueued row's id is the run's id, so the door that starts the run chooses it.
          runId: opts.runId as RunsStartInput['runId'],
          ...(patterns.length === 0 ? {} : { patterns }),
        }
        // The shipped dispatcher, so receipt classification and the ack read apply to a click too.
        await invokeFunction(
          host.registry as FunctionRegistry,
          'runs.start',
          request,
          DASHBOARD_FUNCTION_CALLER,
        )
      } finally {
        entries.delete(opts.runId)
      }
    },
  }) as unknown as DashboardExecutionBackend

  return {
    runBridge,
    backend,
    bindHost: (host: LocalAgentHost): void => { boundHost = host },
    resolveHost: (): LocalAgentHost | undefined => boundHost,
    observeSessions: (observer): (() => void) => {
      sessionObservers.add(observer)
      return () => { sessionObservers.delete(observer) }
    },
    // A run's post-run work is handed over before its execution settles, so an execution leaving
    // its set always leaves its work behind in the other one for the next pass to wait on.
    postRunSettled: async (): Promise<void> => {
      while (executions.size + postRun.size > 0) {
        await Promise.allSettled([...executions, ...postRun])
      }
    },
  }
}


// The run service's composition.

/** The surface id this door attributes its calls to. Attribution only, never a permission input. */
export const RUN_SERVICE_SURFACE = 'run-service'

// `origin: 'agent'`, because a request on this door came from a socket client, not a person here.
export const RUN_SERVICE_FUNCTION_CALLER: FunctionCaller = Object.freeze({
  surface: RUN_SERVICE_SURFACE,
  origin: 'agent',
})

// One readiness predicate for `/ok` and the local preflight; it gives no `ready` verdict.
export function createRunServiceReadiness(input: {
  /** The composed-host box. Read at CALL time, because a host binds after this is built. */
  readonly resolveHost: () => LocalAgentHost | undefined
}): () => RunServiceReadiness {
  return () => ({
    service: 'up',
    hostComposed: input.resolveHost() !== undefined,
    contractVersion: RUN_SERVICE_CONTRACT_VERSION,
  })
}

export interface RunServiceCompositionInput {
  // The run door this process composed: the host box and the one session bridge.
  readonly door: Pick<DashboardRunDoor, 'resolveHost' | 'observeSessions'>
  /** How long a finished run stays attachable. Defaults to the registry's own window. */
  readonly retentionMs?: number
  // The command's hoisted registry; supplied means `dispose` leaves it to its owner.
  readonly sessions?: RunServiceSessionRegistry
  // Absent, both read rows answer 503 `agent_host_unavailable`.
  readonly agentHost?: RunServicePorts['agentHost']
}

export interface RunServiceComposition {
  readonly ports: RunServicePorts
  // Published so the local door serves the identical predicate object, not an equal one.
  readonly readiness: () => RunServiceReadiness
  /** Unregister the session observer and drop every retained handle. */
  dispose(): void
}

// Not named `startRun`: that is the runner shell's entry, and a census test refuses it here.
export function composeRunServicePorts(input: RunServiceCompositionInput): RunServiceComposition {
  // The command hoists one session lookup; owning one here is the fallback when none is handed in.
  const ownsSessions = input.sessions === undefined
  const sessions = input.sessions ?? createRunServiceSessionRegistry({
    observeSessions: input.door.observeSessions,
    ...(input.retentionMs === undefined ? {} : { retentionMs: input.retentionMs }),
  })

  const invokeRunStart = async (start: RunServiceStartInput): Promise<RunStartAcknowledgement> => {
    const host = input.door.resolveHost()
    if (host === undefined) {
      throw new Error('The run service was asked to start a run before its host was composed.')
    }
    // NO `runId`, NO `scope`, NO `executionContext` ON THE REQUEST. The door does not carry a
    // caller's claim about any of them, and it does not substitute a claim of its own: the core
    // mints the id, the config resolves the scope, and the context is this composition's own
    // default. The dashboard door legitimately forwards a pre-minted id because its queue chose one;
    // a run-service caller has chosen nothing.
    const request: RunsStartInput = start.patterns === undefined || start.patterns.length === 0
      ? {}
      : { patterns: [...start.patterns] }
    // The shipped dispatcher, so validation, refusals and receipts apply; this records `api`.
    const result = await withRunDoor('api', () => invokeFunction(
      host.registry as FunctionRegistry,
      RUNS_START_FUNCTION_ID,
      request,
      RUN_SERVICE_FUNCTION_CALLER,
    ))
    // PARSED, NOT CAST. The ack law says every field comes off the durable record; this is the
    // read side of it, and it is what makes the router's typed 202 a fact rather than a hope.
    return RunStartAcknowledgementSchema.parse(result)
  }

  // An uncomposed host answers `live_view_unavailable`, the same word an unbound live view uses.
  const mintLiveUrl = async (mint: MintLiveUrlInput): Promise<RunsLiveUrlResult> => {
    const host = input.door.resolveHost()
    if (host === undefined) {
      throw new LiveViewUnavailableError('the run service host is not composed yet')
    }
    return mintLiveUrlThrough(
      host.registry as FunctionRegistry,
      RUN_SERVICE_FUNCTION_CALLER,
    )(mint.runId, mint.handle)
  }

  // THE ONE PREDICATE, CALLED — not a second copy of it. See `createRunServiceReadiness`.
  const readiness = createRunServiceReadiness({ resolveHost: input.door.resolveHost })

  const ports: RunServicePorts = {
    invokeRunStart,
    attach: (runId) => sessions.attach(runId),
    readiness,
    mintLiveUrl,
    // An absent host is an absent field; the door reads this record to decide whether to dispatch.
    ...(input.agentHost === undefined ? {} : { agentHost: input.agentHost }),
  }

  return {
    ports,
    // THE SAME OBJECT `ports.readiness` HOLDS, deliberately — see the field's own doc.
    readiness,
    dispose: () => { if (ownsSessions) sessions.dispose() },
  }
}

// `mount` says whether to bind a second listener at all; `port` is the clamped port it would bind.
export interface McpCoHostMountPlan {
  readonly mount: boolean
  readonly port: number
}

// A declared `services.mcp` block mounts unless `enabled` is `false`; absent means enabled.
export function mcpMountPlanFor(config: unknown): McpCoHostMountPlan {
  const services = (config as { services?: unknown } | null | undefined)?.services
  const declared = (services as { mcp?: unknown } | null | undefined)?.mcp
  const blockDeclared = typeof declared === 'object' && declared !== null
  const block = (blockDeclared ? declared : {}) as {
    enabled?: unknown
    port?: unknown
  }

  const enabled = block.enabled !== false
  // The port clamp lives here so the port decision is drivable too. Anything that is not an integer
  // inside the schema's own 1..65535 range falls back to the constant the standalone face binds.
  const port = typeof block.port === 'number'
    && Number.isInteger(block.port)
    && block.port >= 1
    && block.port <= 65535
    ? block.port
    : MCP_HTTP_DEFAULT_PORT

  return { mount: blockDeclared && enabled, port }
}

// `server` is `undefined` when the bind failed, so the dashboard survives a failed optional mount.
export interface McpCoHostListenResult {
  readonly server: NodeHttpServer | undefined
  readonly boundPort: number | undefined
  readonly warning: string | undefined
}

// Every bind or socket error on this optional listener stays scoped to it, never exiting.
export async function mountCoHostedMcp(input: {
  readonly server: NodeHttpServer
  readonly port: number
  readonly warn?: (line: string) => void
}): Promise<McpCoHostListenResult> {
  const { server, port } = input
  const warn = input.warn
    ?? ((line: string) => printRunText(pc.yellow(line), (block) => console.error(block)))

  try {
    await new Promise<void>((listening, failed) => {
      const onListenError = (error: Error): void => failed(error)
      server.once('error', onListenError)
      server.listen(port, MCP_HTTP_BIND_HOST, () => {
        // Detached BEFORE the promise settles, so it cannot be reached again by a later socket
        // error and resolve something already resolved.
        server.off('error', onListenError)
        listening()
      })
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const warning = `MCP endpoint not mounted on ${MCP_HTTP_BIND_HOST}:${String(port)} — ${reason}. `
      + 'The dashboard is unaffected and keeps serving.'
    warn(warning)
    // Best effort: a server that never listened has nothing to close, and one that half-bound must
    // not be left holding a descriptor.
    try { server.close() } catch { /* nothing was bound */ }
    return { server: undefined, boundPort: undefined, warning }
  }

  const address = server.address()
  const boundPort = typeof address === 'object' && address !== null ? address.port : port
  // The durable door. Anything the socket raises from here on is an operator-visible line, never a
  // discarded event.
  server.on('error', (error: Error) => {
    warn(`MCP endpoint socket error on ${MCP_HTTP_BIND_HOST}:${String(boundPort)}: ${error.message}`)
  })
  return { server, boundPort, warning: undefined }
}

type DashboardCommandOptions = {
  port?: string
  db?: string
  open?: boolean
}

type ServiceCommandLabels = {
  error: string
  shutdown: string
}

async function startDashboardBackedServices(
  opts: DashboardCommandOptions,
  command: Command,
  labels: ServiceCommandLabels,
): Promise<void> {
  try {
    const program = command.parent!
    const globalOpts = program.opts<{ config?: string; verbose?: boolean }>()

    const config = await resolveConfig({
      configPath: globalOpts.config,
    })

    const configFilePath = resolve(globalOpts.config ?? 'agent-qa.config.yaml')
    const configDir = dirname(configFilePath)
    const workspacePaths = resolveWorkspacePaths({
      config,
      configPath: configFilePath,
      requireExistingFiles: true,
    })

    const servicesConfig = (config as any).services?.dashboard ?? {}
    const port = opts.port ? parseInt(opts.port, 10) : (servicesConfig.port || 3470)
    const configuredDbPath = opts.db ?? servicesConfig.dbPath
    const artifactsDir = servicesConfig.artifactsDir ?? '.agent-qa/artifacts'

    const registryLlms = (config as any).registry?.llms ?? []
    const useLlm = (config as any).use?.llm
    const defaultCfg = registryLlms.find((c: any) => c.name === useLlm) ?? {}
    const configName = defaultCfg.name ?? useLlm ?? ''
    const llmConfig: LLMConfigLike = {
      provider: defaultCfg.provider ?? 'anthropic-subscription',
      model: defaultCfg.model ?? DEFAULT_ANTHROPIC_MODEL,
      baseURL: defaultCfg.baseURL,
      providerHeaders: defaultCfg.providerHeaders,
      vision: defaultCfg.vision,
    }
    const resolvedAuth = await resolveModelAuth(configName, llmConfig)
    let authFetch: typeof globalThis.fetch | undefined
    let resolvedLLMConfig: LLMConfigLike = llmConfig
    if (resolvedAuth.kind !== 'missing') {
      const runtimeConfig = applyResolvedAuthToModelConfig(llmConfig, resolvedAuth)
      const { fetch, ...modelConfig } = runtimeConfig
      authFetch = fetch
      resolvedLLMConfig = modelConfig
    }
    const { vision: modelVision, ...serverLLMConfig } = resolvedLLMConfig
    const dashboardLLMConfig = {
      ...serverLLMConfig,
      vision: resolveVisionConfig((config as any).services?.vision),
      ...(typeof modelVision === 'boolean' ? { modelVision } : {}),
    }

    const {
      DashboardDatabase,
      // Built here because only this command holds both the database and the function layer.
      createDashboardRunDetailReader,
      createLiveEditorSubjects,
      createPostProcessingRelay,
      resolveDashboardDbPath,
      startServer,
    } = await import('@vostride/agent-qa-dashboard')

    const db = new DashboardDatabase({
      dbPath: resolveDashboardDbPath({ configDir, configuredDbPath }),
      runOwnership: composeRunOwnership(),
    })

    let uiDir: string | undefined
    try {
      const require = createRequire(import.meta.url)
      const pkgPath = require.resolve('@vostride/agent-qa-dashboard-ui/package.json')
      uiDir = resolve(dirname(pkgPath), 'dist')
    } catch {
      if (globalOpts.verbose) {
        console.log(pc.yellow('Warning: @vostride/agent-qa-dashboard-ui not found — API-only mode'))
      }
    }

    // The dashboard's host: the CLI's `composeCliLocalAgent`, with no chat model bound.

    // The bound origin, written once the server has a port and read per configuration lookup. See
    // `overlayDashboardBaseUrl` for why this is a mutable box rather than a value.
    let boundOrigin: string | undefined

    // One relay: `publish` feeds the chip emitter and the relay feeds the stream door.
    const postProcessingRelay = createPostProcessingRelay()

    const runDoor = await createDashboardRunDoor({
      db,
      chipRelay: postProcessingRelay.publish,
    })

    // Hoisted and unconditional, so the run-stream door can attach to runs this process executes.
    const sessions = createRunServiceSessionRegistry({ observeSessions: runDoor.observeSessions })
    // One editor-subject registry for the mint and the frame socket, so they agree on sessions.
    const editorSubjects = createLiveEditorSubjects()
    // The signer, mint port and validator, joined once; a minted token is not a declared secret.
    const liveView = composeLiveView({
      sessions,
      origin: () => boundOrigin,
      editorCapabilityOf: editorSubjects.capabilityOf,
    })

    const { agentHost, host: runHost, declaredSecretMask } = composeDashboardDoor({
      agentQaRoot: resolve(configDir, '.agent-qa'),
      configPath: configFilePath,
      boundOrigin: () => boundOrigin,
      liveView: liveView.liveView,
      // The same `db` the ingest writes, read back through the function layer.
      runDetail: createDashboardRunDetailReader(db),
      // `setActiveExecutionContextResolver` is a process global, so it is never set here.
      runBridge: runDoor.runBridge,
    })
    runDoor.bindHost(runHost)

    // The ports name agent packages `dashboard-server` may not import, so they are composed here.
    const configuredHost = typeof servicesConfig.host === 'string' && servicesConfig.host.trim() !== ''
      ? (servicesConfig.host as string).trim()
      : undefined
    // The same host the local door serves, so both detail routes are one capability.
    const runService = composeRunServicePorts({ door: runDoor, sessions, agentHost })

    const { close, port: listeningPort } = await startServer({
      db,
      port,
      // A non-loopback host is refused before listen, as a security decision, not a parse error.
      ...(configuredHost === undefined ? {} : { host: configuredHost }),
      // The identical readiness function object the run service's `/ok` serves.
      runServiceReadiness: runService.readiness,
      // Read off the hoisted registry so the run-stream door and frame socket attach to live runs.
      runServiceAttach: sessions.attach,
      // The relay's other half: a run this process drains is one it can push chips for.
      postProcessingRelay,
      // `mintLiveUrl` goes through the shipped dispatcher, like `runs.start`, never the port.
      liveView: {
        validate: liveView.validate,
        // The same function the run service calls, so both doors mint through one dispatcher.
        mintLiveUrl: mintLiveUrlThrough(
          runHost.registry as FunctionRegistry,
          DASHBOARD_FUNCTION_CALLER,
        ),
        // `editor.liveurl` is reached only through this door; MCP does not project it.
        mintEditorLiveUrl: mintEditorLiveUrlThrough(
          runHost.registry as FunctionRegistry,
          DASHBOARD_FUNCTION_CALLER,
        ),
      },
      // The registry `composeLiveView` reads above, handed to the server by reference.
      liveEditorSubjects: editorSubjects,
      uiDir,
      artifactsDir: resolve(configDir, artifactsDir),
      workspacePaths,
      configPath: configFilePath,
      declaredSecretMask,
      llmConfig: dashboardLLMConfig,
      authFetch,
      agentHost,
      // The queue executes through this over `runs.start`; without it execution routes answer 503.
      executionBackend: runDoor.backend,
      // Always present, because the run service mounts without tokens.
      runService: runService.ports,
    })

    // Loopback rather than a hostname, matching where this server binds.
    boundOrigin = `http://localhost:${String(listeningPort)}`

    // Co-hosted here because only this process binds `liveView`, so its minted links validate here.
    const mcpPlan = mcpMountPlanFor(config)
    let mcpServer: NodeHttpServer | undefined
    if (mcpPlan.mount) {
      // The MCP masker, composed exactly as `agent-qa mcp` composes it: the declared-secret loader
      // over this project's config. It masks what this endpoint writes.
      const mcpMaskText = composeMcpMasking({ configPath: configFilePath }).mask
      // Clamped inside `mcpMountPlanFor`, so the port a cell drives is the port this binds.
      const mcpPort = mcpPlan.port
      mcpServer = createServer(
        createMcpHttpRequestListener({
          // Built over `liveView`, so a minted `runs.liveurl` is signed by the validating signer.
          registry: runHost.registry as FunctionRegistry,
          maskText: mcpMaskText,
          // The configured base wins; read per result because `boundOrigin` is a box.
          liveLink: {
            dashboardBaseUrl: () => {
              const configured = servicesConfig.baseUrl
              return typeof configured === 'string' && configured.trim() !== ''
                ? configured.trim()
                : boundOrigin
            },
          },
        }),
      )
      // A failed optional mount warns naming the MCP port and keeps the serving dashboard up.
      const mcpMount = await mountCoHostedMcp({ server: mcpServer, port: mcpPort })
      mcpServer = mcpMount.server
      if (mcpMount.server !== undefined) {
        console.log(pc.dim(
          `MCP endpoint listening on http://${MCP_HTTP_BIND_HOST}:${String(mcpMount.boundPort)}/ `
          + '(live view attached).',
        ))
      }
    }

    if (opts.open) {
      const { exec } = await import('node:child_process')
      const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
      exec(`${openCmd} http://localhost:${listeningPort}`)
    }

    let shuttingDown = false
    const shutdown = async () => {
      if (shuttingDown) return
      shuttingDown = true
      console.log(pc.dim(`\nShutting down ${labels.shutdown}...`))
      close()
      // the co-hosted MCP listener is this command's to close, beside the dashboard's
      // own — it is a socket this process bound, and a shutdown that left it listening would leave
      // an endpoint over a registry whose door is closing underneath it.
      mcpServer?.close()
      // Unregisters the session observer, or the observer set keeps every finished run's bus alive.
      runService.dispose()
      // The hoisted registry is the command's to dispose; `composeRunServicePorts` leaves it alone.
      sessions.dispose()
      process.exit(0)
    }

    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    printRunText(pc.red(`${labels.error} error: ${message}`), (block) => console.error(block))
    process.exit(2)
  }
}

/**
 * The run-detail reader other CLI hosts bind over a project's existing runs database, so
 * `runs.detail`, `runs.overview` and `runs.evidence` answer outside the dashboard too.
 */
export async function openProjectRunDetailReader(dbPath: string) {
  const { DashboardDatabase, createDashboardRunDetailReader } = await import('@vostride/agent-qa-dashboard')
  const db = new DashboardDatabase({
    dbPath,
    runOwnership: composeRunOwnership(),
  })
  return { reader: createDashboardRunDetailReader(db), close: () => db.close() }
}

export function createDashboardCommand(): Command {
  const cmd = new Command('dashboard')
    .description('Start the dashboard web server')
    .option('--port <number>', 'server port (default: 3470)')
    .option('--db <path>', 'database file path')
    .option('--open', 'open browser after start')
    .action(async (opts: DashboardCommandOptions, command: Command) => {
      await startDashboardBackedServices(opts, command, {
        error: 'Dashboard',
        shutdown: 'dashboard',
      })
    })

  return cmd
}

export function createServeCommand(): Command {
  const cmd = new Command('serve')
    .description('Start configured local agent-qa services')
    .action(async (_opts: unknown, command: Command) => {
      await startDashboardBackedServices({}, command, {
        error: 'Serve',
        shutdown: 'local services',
      })
    })

  return cmd
}
