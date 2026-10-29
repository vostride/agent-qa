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
// 408 plan 03 (D-03, Open Question 4): the CO-HOSTED MCP endpoint reuses the standalone command's
// exported listener, masking composition and constants VERBATIM. A value edge from this command to
// that one, and the direction was measured before it was written: `commands/mcp.ts` reaches
// `composition/*` and two other command modules, none of which reaches back here, so nothing closes
// at module-evaluation time. Reusing them is the whole point of Pitfall 7 — the Host/Origin order
// is a security claim, and a second spelling of it here would be a second claim.
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

/** The dot-path 387 D-10's card `url` is read from, spelled here exactly as the producer reads it. */
export const DASHBOARD_BASE_URL_CONFIG_KEY = 'services.dashboard.baseUrl'

/**
 * The OTHER dot-path the same producer reads (400-10, gap 1 / WINDOWS #195).
 *
 * `readDashboardUrlBase` is an AND over two keys, not one: a base with no workspace cannot render
 * the pinned `/t/:workspace/:kind/:shortId/:slug` route, so either half alone yields no url base at
 * all. 400-01 supplied `baseUrl` and nothing in this build produced a workspace, which made the
 * whole overlay INERT — every card the dashboard's host rendered came back url-absent
 * while the overlay's own entry looked perfectly correct. Both halves or neither.
 */
export const DASHBOARD_WORKSPACE_CONFIG_KEY = 'services.dashboard.workspace'

/**
 * The caller the dashboard dispatches run-detail reads, marks and the Run button as (400-01, D-08;
 * 430 D-03).
 *
 * DERIVED FROM THE CLI'S OWN MINT, with the surface name — attribution only, never a permission
 * input — as the single difference. `origin` rides along unchanged and deliberately — a person
 * clicking in a browser this machine's own process is serving is the same fact the CLI mints
 * `human` for. 2026-10-01 (432-21, D-12): the CLI mint carries no scope set or safe-mode flag, so
 * neither does this one.
 */
export const DASHBOARD_FUNCTION_CALLER: FunctionCaller = Object.freeze({
  ...CLI_FUNCTION_CALLER,
  surface: 'dashboard',
})

// 2026-10-01 (432-14, D-15): `askingSessionOf` is deleted with the gate posture it fed. No
// invocation through this door enters a frame, so nothing reads who is asking.

/**
 * The composed host, as the dashboard's run-detail and mark routes consume it (400-01, D-01;
 * narrowed by 430 D-02 and 432-14 D-14).
 *
 * THE WHOLE OF THE COMPOSER, and it decides nothing. Every member is either a handle from the host
 * this function was handed or a function the `agent` package exports, bound. There is no op id
 * spelled here and no scope decided here — a composer that computed either would be a second
 * answer to a question the composition root has already answered, which is the shape
 * `chat/host.ts`'s header refuses at length.
 *
 * PUBLISHED rather than private because the conformance suite composes the host the same way the
 * command does. An adapter that assembled its own seam would be enumerating a door this product
 * does not ship (397 D-01's produced-enumeration law, applied to the composition itself).
 */
export function composeDashboardAgentHost(host: LocalAgentHost): AgentHost {
  return {
    registry: host.registry,
    caller: DASHBOARD_FUNCTION_CALLER,
    // 404-05 (D-16/D-18/D-22): the two ids the post-processing routes dispatch, PASSED as data.
    // `packages/dashboard-server` may not import this package (validate:arch), so the ids reach
    // it the only way an id can — as data from the composition that already knows them.
    runsPostProcessingFunctionId: RUNS_POST_PROCESSING_FUNCTION_ID,
    runsEventsFunctionId: RUNS_EVENTS_FUNCTION_ID,
    // 405-01 (D-03): the third id the run-service routes dispatch, on the same footing and for the
    // same reason. `packages/dashboard-server` may not import this package (validate:arch), so the
    // id reaches it the only way an id can — as data from the composition that already knows it.
    runsDetailFunctionId: RUNS_DETAIL_FUNCTION_ID,
    runsEvidenceFunctionId: RUNS_EVIDENCE_FUNCTION_ID,
    // 405-05 (D-12/D-13): the fourth id the run-service routes dispatch, on the same footing and
    // for the same reason — with the sharper one that this route serves BYTES, and the alternative
    // to an id is `packages/dashboard-server` constructing an evidence store from two URL segments.
    runsArtifactFunctionId: RUNS_ARTIFACT_FUNCTION_ID,
    // 406-01 (D-04): the fifth id, on the same footing and for the same reason. It is what the
    // failure view's read dispatches on both doors — `analysis.get` is the single producer of a
    // run's verdict sentences, and the dashboard package can only learn its name as data.
    analysisGetFunctionId: ANALYSIS_GET_FUNCTION_ID,
    // 407-01 (D-05): the sixth id, on the same footing and for the same reason. It is what the
    // Knowledge tab's read dispatches — `runs.knowledge` is the single producer of what a run used
    // and learned, and the dashboard package can only learn its name as data.
    runsKnowledgeFunctionId: RUNS_KNOWLEDGE_FUNCTION_ID,
    runsMarkFunctionId: RUNS_MARK_FUNCTION_ID,
    runsMarksHistoryFunctionId: RUNS_MARKS_HISTORY_FUNCTION_ID,
    runsMarkPreviewFunctionId: RUNS_MARK_PREVIEW_FUNCTION_ID,
    // 2026-10-01 (432-14, D-14/D-15): every invocation is the shipped `invokeFunction`, bound. It
    // used to run inside an asking-session frame the gate's context resolver and the confirm port
    // read; both are deleted, so there is no frame to enter and no op is special-cased.
    invokeFunction: (
      registry: AgentRegistryHandle,
      functionId: string,
      input: unknown,
      caller: FunctionCaller,
    ): Promise<unknown> => invokeFunction(registry as FunctionRegistry, functionId, input, caller),
  }
}

/**
 * The masked config reader, with the bound origin standing in for an UNSET dashboard base URL
 * (400-01, D-16 / 387 D-10).
 *
 * ONE MECHANISM, TWO SUPPLIERS. 387 D-10 made the entity card's `url` config-derived and absent by
 * default, read through the masker at `services.dashboard.baseUrl`; that knob stays THE mechanism
 * and is how a CLI or MCP host is pointed at somebody's dashboard. What this adds is the second
 * supplier: a dashboard host knows its own origin, so the cards it serves — to run detail and to
 * the co-hosted MCP endpoint — carry working links with no user setup at all.
 *
 * THE OPERATOR'S VALUE WINS, and the precedence is deliberate rather than incidental. A configured
 * base is somebody pointing at something — a reverse proxy, a tunnel, a path prefix — and
 * overwriting it with `http://localhost:<port>` would silently redirect every link away from the
 * address they chose. So the overlay fills an ABSENCE and never replaces a presence.
 *
 * `masked: false` because this value is not the operator's secret and was not reduced by the
 * masker: it is a loopback origin this process minted from the port it bound. The producer reads
 * that flag to decide whether a base is verbatim (`card-context.ts`), so a `true` here would make
 * the overlay contribute nothing — which is the failure mode this comment exists to prevent
 * somebody re-introducing.
 *
 * `source: 'default'` on the same reasoning: no config file, environment variable or flag carries
 * this value. It is what this host supplies when nothing else did.
 *
 * The origin is a FACTORY, not a string, because the server has not bound a port when the host is
 * composed — and an ephemeral port (`port: 0`) is a real posture, in this suite and in tests. A
 * value captured at composition time would be a guess; a factory read per invocation is the truth.
 *
 * BOTH HALVES, because the producer requires both (400-10, gap 1). The workspace segment is
 * supplied on identical rules — operator wins, `source: 'default'`, `masked: false` — and is
 * INDEPENDENT of the origin: it is overlaid whenever it is supplied, including while the server
 * has not bound a port yet, because the producer's own AND makes a lone workspace inert rather
 * than wrong. Gating it on the origin would be a second, invisible precondition on a value that
 * has none.
 */
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

      // An empty segment is left ABSENT rather than overlaid as `''`: `formatEntityUrl` refuses an
      // empty workspace, so an empty entry would be a base that reads as present and renders
      // nothing — the same inert state gap 1 was, one layer down.
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

// 2026-10-01 (432-14, D-14/D-15): the dashboard's gate posture machinery is deleted — the asking
// scope frame, `postureFor` and its reachability predicates, and the browser confirm factory that
// parked ask-tier questions in the run-confirm registry. Nothing through this door is asked, so
// there is no asker to name and no reachability to prove. The door answers one execution context
// for every call (`composeDashboardDoor` below).

/** Everything the door's composition needs that only its host knows. */
export interface DashboardDoorInput {
  /** The project's runtime root, i.e. `<configDir>/.agent-qa`. */
  readonly agentQaRoot: string
  /** The configuration file this door resolves against. */
  readonly configPath: string
  /**
   * The origin this server bound, read per configuration lookup (D-16).
   *
   * A FACTORY because the server has not bound a port when the door is composed, and an ephemeral
   * port is a real posture. Answering `undefined` leaves the operator's config knob — or its
   * absence, and therefore a `url`-absent card — exactly as it was.
   */
  readonly boundOrigin: () => string | undefined
  /**
   * An EXPLICIT OVERRIDE of the context this door's calls and runs are recorded under (D-05, spec
   * §2.2).
   *
   * 2026-10-01 (432-14, D-14/D-15): ABSENT MEANS `local-headless`, for every call. The per-scope
   * posture this used to be derived from — is a person reachable on a confirm channel for the scope
   * being gated — is deleted with the channel. What the value still does is travel: a run records
   * it, and the curation profile reads it (both local contexts drain alike, D-08). The door never
   * derived `local-interactive` without a live channel, so `local-headless` is the answer every
   * dashboard call already got; supplied is the spec's explicit-override rung, which is the
   * conformance suite's posture and unchanged.
   *
   * WHAT IS NOT DEFAULTED IS THE PROCESS. Neither arm ever falls back to TTY and CI markers, which
   * is the ambient reach this seam exists to remove.
   */
  readonly resolveExecutionContext?: () => ExecutionContext
  /**
   * What this door needs back from the runs it triggers (401-07, D-09 — INVK-01).
   *
   * PASSED STRAIGHT THROUGH to `composeCliLocalAgent`, and this composer decides nothing about it.
   * Absent (the conformance suite's posture, and any caller that triggers no run) composes exactly
   * what it composed before.
   */
  readonly runBridge?: ComposeCliLocalAgentInput['runBridge']
  /**
   * 403 D-03: the live-view mint seam `runs.liveurl` binds through.
   *
   * PASSED STRAIGHT THROUGH to `composeCliLocalAgent`, on the same rule as `runBridge` above — this
   * composer decides nothing about it. Absent (the conformance suite's posture, and any door with
   * no served origin) lists `runs.liveurl` `unbound` BY NAME.
   */
  readonly liveView?: ComposeCliLocalAgentInput['liveView']
  /**
   * 405 D-03: the durable run-detail projection read `runs.detail` binds through.
   *
   * PASSED STRAIGHT THROUGH to `composeCliLocalAgent`, on the same rule as `runBridge` and
   * `liveView` above — this composer decides nothing about it and constructs no database. Absent,
   * `composeCliLocalAgent` binds a reader over the configured or default runs database path whenever
   * the config parses; a read before that file exists answers not recorded in the runs database.
   */
  readonly runDetail?: ComposeCliLocalAgentInput['runDetail']
}

/** The composed door: the local host it owns, and the seam the routes consume. */
export interface DashboardDoor {
  readonly host: LocalAgentHost
  readonly agentHost: AgentHost
  // 441-21 (D-29): the mask the host and its config reader share, for the server's config editor.
  readonly declaredSecretMask: MaskFn
  // 2026-10-01 (432-14, D-14/D-15): the published posture measurement and the run-trigger scope
  // entry are deleted with the posture and the scope. The run door needs nothing back from this
  // composition but the host (`bindHost`).
}

/**
 * Compose the dashboard's host — ONE composer, for production and for the suites that measure it.
 *
 * 2026-09-28, 430 D-02: it composes no conversation. What it serves is run detail, the run
 * trigger, marks, the run-service door and the co-hosted MCP endpoint.
 *
 * PUBLISHED AND SINGULAR. The conformance fixtures compose the host through this function; if one
 * assembled its own host beside this one, the suite would be measuring a host this product does
 * not ship — the lookalike-assembly failure `spawned-chat.ts` names. So the command below calls
 * this, and so do the suites, and there is no third assembly to disagree with either.
 *
 * IT DECIDES NOTHING ITS CALLER HAS NOT SAID. Execution context and bound origin arrive as inputs;
 * what this function contributes is the wiring — the CLI port set, the base-URL overlay and the
 * injected-host seam — which is the part that must not be written twice.
 */
export function composeDashboardDoor(input: DashboardDoorInput): DashboardDoor {
  /**
   * The workspace half of the card url base: this workspace directory's own NAME (400-10, gap 1).
   *
   * IT IS THE ONLY WORKSPACE IDENTITY A LOCALLY-SERVED HOST HAS. This build carries no
   * workspace-name concept anywhere — `WorkspaceSchema` declares none and `resolveWorkspacePaths`
   * returns paths — so the directory the config file lives in is the one durable, human-recognisable
   * name available at composition time. It is a display segment in a route, never an identity a
   * decision is taken on, and `formatEntityUrl` percent-encodes it.
   *
   * THE OPERATOR'S CONFIGURED VALUE WINS, on the baseUrl half's own precedence: whoever names the
   * workspace their hosted dashboard serves has said something this process cannot know, and
   * overwriting it would point every card link at a workspace that host does not have. M5's hosted
   * naming therefore arrives through the existing knob with nothing here to change.
   *
   * Empty or `/`-degenerate is passed as `undefined`, because absence is the honest state:
   * `formatEntityUrl` refuses an empty workspace, so a blank segment would be a base that reads as
   * present and renders no link.
   */
  const workspaceSegment = ((): string | undefined => {
    const name = basename(dirname(resolve(input.configPath)))
    return name === '' || name === '/' || name === '.' ? undefined : name
  })()

  // 2026-10-01 (432-14, D-14/D-15): ONE CONTEXT FOR EVERY CALL. The door used to derive it per
  // invocation from the asking scope it entered and whether a confirm channel was live on it; the
  // scope, the channel and the confirm port it bound here are deleted. Without a live channel that
  // derivation always answered `local-headless`, so that is the answer, unless the caller
  // overrides it.
  const resolveExecutionContext = input.resolveExecutionContext
    ?? ((): ExecutionContext => 'local-headless')

  const declaredSecrets = createDeclaredSecretMask(input.configPath)
  const host = composeCliLocalAgent({
    agentQaRoot: input.agentQaRoot,
    configPath: input.configPath,
    declaredSecrets,
    // 403 D-03: forwarded untouched, conditionally spread — an absent port is an ABSENT field.
    ...(input.liveView === undefined ? {} : { liveView: input.liveView }),
    // 405 D-03: forwarded untouched, conditionally spread — an absent port is an ABSENT field.
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


// ---- The fourth door's RUN trigger (401-07, D-01/D-09/D-10 — INVK-01) ------------------------

/**
 * The dashboard's queue used to start a run by SPAWNING `agent-qa run` and reading the child's
 * stdout for `AGENT_QA_EVENT:` lines. `packages/dashboard-server` cannot compose the gated run
 * itself — it may not name `@vostride/agent-qa-agent*` — so the door is composed HERE, in the
 * process that runs that server, and injected. That is the same arrangement, and the same reason,
 * as `agentHost` two hundred lines below.
 *
 * D-10 — THE RUN BUTTON IS ONE MORE CALLER OF `runs.start`. The starter below invokes the composed
 * host's own registry through the shipped `invokeFunction`, so the receipt classification and the
 * ack-read-off-the-durable-record apply identically to a browser click and to a sentence typed at
 * `agent-qa chat`. There is no dashboard carve-out and no second spelling of "start a run".
 *
 * 2026-10-01 (432-14, D-14/D-15): ONE CLICK IS ONE CALL. From 401-09 this door minted a confirm
 * scope per queued run and ran the invocation inside it, so an ask-tier run could ask the browser
 * that triggered it. There is nothing left to ask (432-13 removed the gates), so the scope, its
 * entry and the posture it decided are deleted: every dashboard run is dispatched as it is, and the
 * only refusals on this road are the core's refusals of a request field or a run id.
 */
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
  /**
   * The composed host, or nothing if it has not been bound yet (402-01).
   *
   * PUBLISHED SO A SECOND DOOR IN THIS PROCESS CAN READ THE SAME STATE the run starter's own guard
   * throws on. `/ok`'s `hostComposed` fact and the invoke path's refusal are then two readings of
   * one box rather than two beliefs that can disagree.
   */
  resolveHost(): LocalAgentHost | undefined
  /**
   * Watch every `RunSession` this process's host starts, whichever door started it (402-01).
   *
   * WHY A FAN-OUT AND NOT A SECOND BRIDGE. `composeCliLocalAgent` takes ONE `runBridge`, so there
   * is exactly one place a started session becomes visible in this process. The queue's own routing
   * — by the session's id, into the entry the queue registered — cannot see a run the queue did not
   * enqueue, which is every run the remote service door starts. Rather than mint a second bridge
   * that the composition has no slot for, the one bridge notifies observers as well as routing, and
   * the service door registers one.
   *
   * Returns the unregister handle. An observer's throw is SWALLOWED, on the session fan-out's own
   * reasoning: this channel is downstream of a run that has already started, and nothing on it may
   * reach back and affect that run.
   */
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
  // 441-48 (D-01): the door holds no secrets of its own for masking. Its masking binder and store
  // set are deleted; a run masks the values its project declares and nothing a door minted.
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

/**
 * Split the queue's argv operands into request patterns and this door's own flags.
 *
 * THE QUEUE STILL SPEAKS ARGV because that is what its rows contain — `metadata.args` is persisted,
 * and rows enqueued before this change are still in the database. `RunsStartInput` has `patterns`
 * and nothing else, so the operands have to be read rather than forwarded.
 *
 * AN UNRECOGNISED FLAG IS REFUSED BY NAME, never passed through as a pattern. A `--something` that
 * silently became a glob would match no files and either disappear or fail as "no test files found"
 * — a person who asked for a behaviour would get a different run and no indication of it.
 */
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
  /**
   * The post-processing relay's `publish`, as the chip emitter's SECOND SINK (404-05, D-16).
   *
   * Threaded through the BRIDGE because that is the seam the tail is composed behind: the drain leg
   * `runs.start` starts (404-04) reads `runBridge.chipRelay` and hands it to
   * `composeCliPostRunTail` as `relay`, which hands it to the one `createChipEmitter` site. Passing
   * it to `startServer` alone would give the server a registry nothing publishes to.
   *
   * OPTIONAL, because the cells that compose this door to measure something else compose no relay,
   * and a door with no push channel is exactly today's behaviour.
   */
  readonly chipRelay?: (envelope: RunEventEnvelope) => void
}): Promise<DashboardRunDoor> {
  const { createInProcessExecutionBackend } = await import('@vostride/agent-qa-dashboard')

  const entries = new Map<string, DashboardRunEntry>()
  /** 402-01: everyone watching the ONE bridge this process's host publishes sessions through. */
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
    // 404-05 (D-16): the chip emitter's second sink, on the conditional-spread house rule — an
    // absent relay is an ABSENT field, so the drain leg's own `relay === undefined` arm decides.
    ...(input.chipRelay === undefined ? {} : { chipRelay: input.chipRelay }),
    // THE BRIDGE HOOK (D-09). Routed by the session's OWN id rather than by "the run in flight",
    // because this door runs as many at once as the queue has slots.
    onSession: (session: RunSession): void => {
      entries.get(session.id as unknown as string)?.onSession(session)
      // 402-01: and every watcher, whichever door started the run. See `observeSessions`.
      for (const observer of [...sessionObservers]) {
        try {
          observer(session)
        } catch { /* one watcher's failure is not another's, and never the run's */ }
      }
    },
    // 2026-10-17 (443-05, D-02/D-06): every run's record writes through this one handle when its
    // runs.db is this file, and a queued run keeps its routes' attributes.
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
    onPostRun: (_runId: string, settled: Promise<void>): void => { track(postRun, settled) },
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
          // THE ENQUEUED ROW'S ID IS THE RUN'S ID. `RunsStartInput.runId` is 401-03's additive
          // field, and this is the caller it was added for: the retiring port already chose the id
          // and handed it to a child, so "the door that starts the run chooses its id" is the
          // shipped trust level rather than a new one.
          runId: opts.runId as RunsStartInput['runId'],
          ...(patterns.length === 0 ? {} : { patterns }),
        }
        // THE SHIPPED DISPATCHER, NOT THE PORT UNDERNEATH IT. Going straight to the run execution
        // would skip the receipt classification and the ack law — which is the dashboard carve-out
        // D-10 exists to refuse. 2026-10-01 (432-14, D-14): dispatched as it is, inside no scope.
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


// ---- The run service's composition (402-01, D-01/D-02/D-04/D-05/D-06 — INVK-03) -----------------

// 2026-10-01 (432-21, D-12): `RUN_SERVICE_GRANTED_SCOPES` and `runServiceCallerFor(trustScope)` are
// deleted. The door's least-privilege scope list and the matched token's trust scope it carried into
// `FunctionCaller.credential` went with the run-service tokens: every caller can call every
// operation, and the door mints one caller for every request.

/** The surface id this door attributes its calls to. Attribution only, never a permission input. */
export const RUN_SERVICE_SURFACE = 'run-service'

/**
 * The caller this door dispatches as — one record, for every request (D-04, Pitfall 4).
 *
 * NOT `DASHBOARD_FUNCTION_CALLER`. That caller mints `origin: 'human'` for a person clicking in this
 * machine's own browser; a request on this door arrived from a client over a socket, and the honest
 * answer to "did a person decide this" is no, so `origin: 'agent'` (391 D-06). Since 432-20 nothing
 * reads `origin` to decide what may happen; the receipts that record it still read it.
 */
export const RUN_SERVICE_FUNCTION_CALLER: FunctionCaller = Object.freeze({
  surface: RUN_SERVICE_SURFACE,
  origin: 'agent',
})

/**
 * THE READINESS PREDICATE — ONE DECLARATION SITE, TWO DOORS (D-15).
 *
 * Exported rather than inlined into `composeRunServicePorts` because `/ok` is not the only place
 * this question is asked: the local door's preflight (402-05) serves the SAME answer, and D-15's
 * whole content is that there is one readiness spelling rather than two that agree today. A second
 * copy of these three facts is how the remote door and the dashboard start disagreeing about
 * whether this process can run anything.
 *
 * EVERY FIELD IS MEASURED, AND NOTHING IS PREDICTED. `hostComposed` reads the SAME box the run
 * starter's guard throws on — not a parallel flag — so `/ok` cannot say yes where `POST /run` says
 * no. 2026-10-01 (432-22, D-12): there is no `authConfigured` fact; no credential can be configured.
 * `contractVersion` is a constant, which is the point of it: a caller learns which route set it is
 * talking to without this process guessing anything.
 *
 * WHAT IS DELIBERATELY ABSENT is a `ready` verdict. Whether a run will succeed depends on a
 * browser, a model, a network and a target, none of which this predicate touched — and a field
 * that claimed otherwise would be the most useful-looking lie on the whole door. Deep diagnostics
 * are 407's `doctor`.
 */
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
  /**
   * The run door this process composed — the host box and the one session bridge.
   *
   * 2026-10-01 (432-21, D-12): no `entries` and no `env`. The declared run-service tokens this
   * composer dereferenced, and the environment it read them from, are deleted.
   */
  readonly door: Pick<DashboardRunDoor, 'resolveHost' | 'observeSessions'>
  /** How long a finished run stays attachable. Defaults to the registry's own window. */
  readonly retentionMs?: number
  /**
   * 403 D-14 (WINDOWS #264): the process's ALREADY-COMPOSED session registry, when there is one.
   *
   * The command hoists the registry above the door composition, because building the lookup only
   * inside this composer is precisely how the local run-stream door came to answer 503 for a run
   * this process was executing. Supplied ⇒ used as-is and `dispose` leaves it to its owner; absent ⇒
   * this composer builds and owns one, exactly as it did.
   */
  readonly sessions?: RunServiceSessionRegistry
  /**
   * 405-05 (D-12 / 402 D-16): the composed agent host the two READ rows dispatch through.
   *
   * PASSED STRAIGHT THROUGH, on `sessions`' own rule — this composer decides nothing about it and
   * composes no host of its own. It is the SAME `agentHost` the local door was handed: one
   * registry behind two front doors. Absent ⇒ both rows answer 503 `agent_host_unavailable`, in the
   * local door's own word, which is an honest fact about a composition with no function layer
   * behind it.
   */
  readonly agentHost?: RunServicePorts['agentHost']
}

export interface RunServiceComposition {
  /**
   * Handed to `startServer` as `runService`. 2026-10-01 (432-21, D-12): the composition carries no
   * `secretStore` and no `tokenCount` — there are no declared credentials to seed or count.
   */
  readonly ports: RunServicePorts
  /**
   * THE READINESS PREDICATE THIS COMPOSITION BUILT (402-05, D-15).
   *
   * PUBLISHED SO THE LOCAL DOOR CAN SERVE THE SAME FUNCTION OBJECT — not an equal one. `ports`
   * above carries it too, and they are the identical reference by construction; a cell pins that
   * identity, because "two doors agree today" and "there is one predicate" are different claims
   * and only the second one survives a later edit.
   */
  readonly readiness: () => RunServiceReadiness
  /** Unregister the session observer and drop every retained handle. */
  dispose(): void
}

/**
 * Compose the remote door's ports — ONE composer, for production and for the cells that measure it.
 *
 * PUBLISHED AND SINGULAR for `composeDashboardDoor`'s own reason: a cell that assembled its own
 * caller mint or starter beside this one would be measuring a door this product does not ship,
 * which is the lookalike-assembly failure the conformance suite refuses by name.
 *
 * 2026-10-01 (432-21, D-12): NO TOKENS ARE DEREFERENCED. The declared run-service credentials, the
 * startup refusal for an unset one and the store that seeded their values into the run masker are
 * deleted; this composer cannot refuse startup any more, and every request runs as
 * {@link RUN_SERVICE_FUNCTION_CALLER}.
 *
 * THE STARTER IS NAMED `invokeRunStart`-STYLE AND NOT `startRun`. `startRun` is the RUN SHELL's
 * entry point in `@vostride/agent-qa-runner`, and `run-door-invocation-census.test.ts` makes a
 * complete-set claim over this package that no file acquires it.
 */
export function composeRunServicePorts(input: RunServiceCompositionInput): RunServiceComposition {
  // THE ATTACHABLE-SESSION LOOKUP, in its own module. See that module's header for why the
  // retention timer may not live in this file. 403 D-14: the command hoists one and hands it in;
  // owning one here is the fallback for a caller that composed none.
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
    // THE SHIPPED DISPATCHER, NOT THE PORT UNDERNEATH IT (D-04). Going straight to the run
    // execution would skip the input validation, the core's refusals, the receipt
    // classification and the ack law — the carve-out the no-private-powers law refuses.
    // 2026-10-17 (443-06, D-24): this request's run records `api`; the queue and the co-hosted MCP
    // endpoint share the host and record their own.
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

  /**
   * THE MINT (403 D-03, Q3 · T-403-01).
   *
   * THE SAME HELPER THE LOCAL DOOR CALLS, by reference — see `mintLiveUrlThrough`. The two doors
   * differ in the `FunctionCaller`'s surface and origin and in nothing else. The minted token binds
   * its own subject (run, handle) and expiry, and the frame socket validates those independently of
   * which door minted it (D-13). 2026-10-01 (432-21, D-12): the verified bearer's trust scope this
   * mint ran under is deleted with the bearer.
   *
   * AN UNCOMPOSED HOST IS `live_view_unavailable`, NOT A CRASH. It is the same genuine host fact
   * `runs.liveurl` itself raises when no live-view port is bound, said in the same word, so a
   * caller cannot distinguish a host with no live view and a host not composed yet — which is
   * correct, because from where they stand those are the same situation.
   *
   * (The wording above deliberately avoids a quoted string immediately after a bare keyword:
   * `validate:arch` reads every `<keyword> '…'` in a file as a declared dependency, and a JSDoc
   * sentence shaped that way is reported as a phantom external dep. Measured live here; the same
   * false positive `handle-scope.ts` records at its own `handleRosterOf`.)
   */
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
    // 405-05: conditionally spread on the house rule an absent port follows everywhere in this
    // file — an absent host must be an ABSENT field, because the door reads exactly this record to
    // decide whether it can dispatch a read at all.
    ...(input.agentHost === undefined ? {} : { agentHost: input.agentHost }),
  }

  // 2026-10-01 (432-21, D-12): no store is bound here. Until then the declared run-service token
  // values were seeded into every run's masker from this line (402-06, WINDOWS #224); the tokens
  // are deleted, and since 441-48 (D-01) the door seeds no masker at all — a run masks the values
  // its project declares.
  return {
    ports,
    // THE SAME OBJECT `ports.readiness` HOLDS, deliberately — see the field's own doc.
    readiness,
    dispose: () => { if (ownsSessions) sessions.dispose() },
  }
}

/**
 * The co-hosted MCP endpoint's mount decision, as a value (408-09 WR-01 / WR-09).
 *
 * `mount` is the whole answer to "does this dashboard bind a second listener at all"; `port` is the
 * clamped port it would bind. 2026-10-01 (432-21, D-12): no `tokenCount` — the MCP token
 * declarations are no longer read.
 */
export interface McpCoHostMountPlan {
  readonly mount: boolean
  readonly port: number
}

/**
 * Decide whether `agent-qa dashboard` co-hosts an MCP endpoint, from the parsed config alone.
 *
 * TWO CONDITIONS, BOTH REQUIRED, and this function is the only place either is spelled.
 *
 * 1. A `services.mcp` block must be DECLARED. A project that declares none gets today's dashboard
 *    byte for byte: a second loopback listener is a surface somebody has to ask for.
 * 2. `services.mcp.enabled` must not be the literal `false`. **An ABSENT `enabled` means ENABLED** —
 *    the schema declares it `optional()`. Only an operator who writes `enabled: false` turns the
 *    surface off while keeping the block on file.
 *
 * 2026-10-01 (432-21, D-12): CONDITION 1 REPLACES "at least one token entry must be declared".
 * That condition read `services.mcp.tokens`, which is no longer read: the endpoint asks no caller for
 * a bearer, and the request a block declares is the request to serve the surface. What keeps the
 * endpoint off other machines and other websites is the loopback bind and the Host/Origin guards in
 * `createMcpHttpRequestListener` (D-13), not a credential count. A config that still declares
 * `services.mcp.tokens` fails strict validation (D-22), so it never reaches this decision; a project
 * with no block still gets none.
 *
 * Until 408-09 the `enabled` condition did not exist: it was declared in `McpConfigSchema` and read
 * NOWHERE (WR-01, T-408-18). A knob that reads as a control and controls nothing is the defect class
 * this function exists to prevent, which is why the decision is a FUNCTION a cell can drive over a
 * config record.
 *
 * Reads `unknown` on purpose: the caller holds a parsed record whose static type does not carry
 * `services.mcp`, and a cell must be able to hand this the shape of a defect as easily as the shape
 * of a correct config.
 */
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

/**
 * What binding the co-hosted MCP listener left behind (408-09 WR-01 / WR-02).
 *
 * `server` is the handle the CALLER should keep — `undefined` when the bind failed, which is what
 * makes "the dashboard survives a failed optional mount" observable rather than argued.
 */
export interface McpCoHostListenResult {
  readonly server: NodeHttpServer | undefined
  readonly boundPort: number | undefined
  readonly warning: string | undefined
}

/**
 * Bind the co-hosted MCP listener, scoping EVERY failure on it to itself (408-09, WR-02 · T-408-17).
 *
 * WHY THIS IS A FUNCTION AND NOT FOUR LINES AT THE MOUNT SITE. The mount runs AFTER `startServer`
 * has bound and the dashboard is already serving, and before 408-09 a bind failure here rejected a
 * promise whose rejection reached the command's outer `catch` and `process.exit(2)`. An optional
 * secondary listener took the primary surface down with it — reachable in the ordinary case,
 * because the default port is the same constant a concurrently running `agent-qa mcp --http` binds
 * — and the message an operator met (`listen EADDRINUSE :::3471`) never once said "MCP". Extracting
 * the bind is what lets a cell drive a REAL occupied port and observe a surviving process; the
 * dashboard composition itself needs a database and an execution backend to reach.
 *
 * TWO ERROR DOORS, AND THEY ARE DIFFERENT DOORS. The listen-time handler is registered by NAME and
 * REMOVED inside the `listen` callback before the promise settles; a durable `on('error')` is then
 * attached in its place. Before 408-09 the `once('error')` handler stayed attached after listen, so
 * a later runtime socket error resolved an already-settled promise and was discarded with no log at
 * all — a silent half of the same defect.
 *
 * The bind address is the CONSTANT the standalone face binds, never a config value: an operator who
 * could widen this to `0.0.0.0` through configuration would be one typo from exposing an ungated
 * function registry to their network.
 */
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

// 2026-10-01 (432-21, D-12): `McpCoHostCredentials` and `coHostedMcpCredentialsFor` are deleted.
// They dereferenced `services.mcp.tokens` after the mount decision (408-17, CR-01) and refused the
// mount when a declared variable was unset; with no token declarations read, the mount plan above
// is the whole decision, and there is no dereference left to fail.

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
      // 405-01 (D-03): the reader adapter over THIS server's one database handle. Built here
      // because the composition root that holds both the database and the function layer is this
      // command — `packages/dashboard-server` cannot reach the registry to bind itself.
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

    // ---- The dashboard's host (400-01, D-01/D-05/D-08/D-16; 430 D-02) --------------------------
    //
    // COMPOSED HERE AND HANDED OVER. The host lives in this process, which is the process
    // dashboard-server runs in — D-01's requirement, met without dashboard-server acquiring the
    // agent packages or re-assembling the port set this command already has. It is the SAME
    // `composeCliLocalAgent` the CLI composes, and it composes no conversation: nothing on the
    // dashboard takes a turn, so it binds no chat model.

    // The bound origin, written once the server has a port and read per configuration lookup. See
    // `overlayDashboardBaseUrl` for why this is a mutable box rather than a value.
    let boundOrigin: string | undefined

    // 2026-10-01 (432-14, D-14): no confirm registry is created. The run-confirm pair that served
    // it, and the composition's browser confirm that parked questions in it, are deleted.

    // ---- The run door (401-07, D-01/D-09/D-10) -------------------------------------------------
    //
    // COMPOSED BEFORE THE HOST AND BOUND AFTER IT, for the reason `composed` and `boundOrigin`
    // inside `composeDashboardDoor` are boxes: the bridge is an INPUT to the composition and the
    // starter needs the composition's registry, so one of the two has to be read at call time.
    // ---- The post-processing chip relay (404-05, D-16) ---------------------------------------
    //
    // ONE OBJECT, TWO HALVES, AND THEY HAVE TO BE THE SAME ONE. `publish` becomes the chip
    // emitter's second sink, down inside whatever tail this process's drain leg composes; the relay
    // itself becomes the stream door's subscription registry. Composed HERE, above both, for the
    // reason `sessions` is composed above both run-service arms: a relay built inside either half
    // would be a registry the other half never reaches, and the failure would look like a live
    // channel that heartbeats forever at a page whose chips are demonstrably moving.
    const postProcessingRelay = createPostProcessingRelay()

    const runDoor = await createDashboardRunDoor({
      db,
      chipRelay: postProcessingRelay.publish,
    })

    // ---- The live-view composition (403 D-03/D-14 — closes WINDOWS #264) -----------------------
    //
    // HOISTED ABOVE THE DOOR, AND UNCONDITIONAL. The attachable-session registry used to be built
    // inside `composeRunServicePorts`, which until 432-21 ran ONLY when `runServiceTokens` was
    // declared — so on the default zero-token dashboard nothing ever registered a session and the
    // local `/api/run-stream/:runId` door answered 503 about runs this very process was executing.
    // It is composed here, once, and the run service receives it rather than building a second.
    const sessions = createRunServiceSessionRegistry({ observeSessions: runDoor.observeSessions })
    // 428 D-07: the editor-subject registry, created once beside the run registry. The same object
    // is the function layer's editor lookup (through `composeLiveView`) and the server's (the
    // session manager registers into it, the frame socket attaches from it), so the mint and the
    // socket can never disagree about which editor sessions exist.
    const editorSubjects = createLiveEditorSubjects()
    // The signer, the mint port and the validator, joined once. 441-48 (D-01): it registers no
    // minted token for masking — a door-minted credential is not a declared secret.
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
      // 405 D-03: the SAME `db` the ingest writes through, read back through the function layer.
      // One handle, one writer, one process — and the page's read now crosses the registry
      // instead of reaching into SQLite from inside a route handler.
      runDetail: createDashboardRunDetailReader(db),
      // NO `resolveExecutionContext` (400-13): the door answers its own, which since 432-14 is
      // `local-headless` for every call. Nothing here reaches `setActiveExecutionContextResolver`
      // either: that setter is a process global and would re-answer the question for every
      // composition in this process (Pitfall 5).
      runBridge: runDoor.runBridge,
    })
    runDoor.bindHost(runHost)

    // ---- The run service (402-01, D-02/D-05/D-06 — INVK-03) -----------------------------------
    //
    // COMPOSED HERE FOR `agentHost`'s AND `executionBackend`'s OWN REASON: the ports name
    // `runs.start`, `invokeFunction` and the composed local host, none of which
    // `packages/dashboard-server` may import. The server mounts the module; this process supplies
    // everything it reaches through.
    //
    // 2026-10-01 (432-21, D-12/D-13): MOUNTED UNCONDITIONALLY, AND TOKENLESS. It used to mount only
    // when `services.dashboard.runServiceTokens` declared a credential, and an unset declared
    // variable refused startup here. That key is deleted (432-22): the door asks for no credential,
    // and what guards it is the same-site check above its route table and the loopback bind every
    // door in this process shares.
    const configuredHost = typeof servicesConfig.host === 'string' && servicesConfig.host.trim() !== ''
      ? (servicesConfig.host as string).trim()
      : undefined
    // 405-05 (D-12 / 402 D-16): the SAME host the local door serves through. Not a second
    // composition, which is what makes `/run/:runId/detail` and the local `/api/runs/:id/detail` one
    // capability behind two front doors rather than two implementations of one idea.
    const runService = composeRunServicePorts({ door: runDoor, sessions, agentHost })

    const { close, port: listeningPort } = await startServer({
      db,
      port,
      // 402-05 (D-07 — INVK-03): the interface this server binds. A non-loopback value is REFUSED
      // pre-listen, unconditionally — the credential count that once exempted it was deleted in
      // the phase-402 verification round, and the credentials themselves in 432-21 (D-12). The
      // config schema still does not refuse a non-loopback host at parse time, so the refusal reads
      // as a security decision rather than a config-shape error.
      ...(configuredHost === undefined ? {} : { host: configuredHost }),
      // 402-05 (D-15): the LOCAL readiness door — the identical function object the run service's
      // `/ok` serves. What is deliberately NOT here is a second copy of these three facts.
      runServiceReadiness: runService.readiness,
      // 403 D-14 (WINDOWS #264): the session lookup, read off the hoisted registry so the local
      // run-stream door and the frame socket can attach to a run this process is executing.
      runServiceAttach: sessions.attach,
      // 404-05 (D-16): the other half of the relay above — a run this process drains is a run this
      // process can push chips for.
      postProcessingRelay,
      // 403 D-03/D-06: the live-view seam, likewise on both arms. `validate` is the function
      // layer's own validator by reference; `mintLiveUrl` dispatches the op through the SHIPPED
      // dispatcher, so the mint pays the op-level gate and the receipt classification exactly as
      // `runs.start` does — a direct call to the port underneath would be the carve-out the
      // no-private-powers law refuses.
      liveView: {
        validate: liveView.validate,
        // 403-03 (D-03, Q3): THE SAME FUNCTION THE RUN SERVICE CALLS, by reference. Both doors mint
        // the identical credential through the identical dispatcher and differ only in the caller's
        // surface and origin — which is what makes the two-door parity corpus a claim about one
        // mint.
        mintLiveUrl: mintLiveUrlThrough(
          runHost.registry as FunctionRegistry,
          DASHBOARD_FUNCTION_CALLER,
        ),
        // 428 D-07: the same dispatcher, the same caller, the editor subject. `editor.liveurl` is
        // reached only through this door; it is unprojected from MCP by ruling.
        mintEditorLiveUrl: mintEditorLiveUrlThrough(
          runHost.registry as FunctionRegistry,
          DASHBOARD_FUNCTION_CALLER,
        ),
      },
      // 428 D-07: the registry `composeLiveView` reads above, handed to the server by reference.
      liveEditorSubjects: editorSubjects,
      uiDir,
      artifactsDir: resolve(configDir, artifactsDir),
      workspacePaths,
      configPath: configFilePath,
      declaredSecretMask,
      llmConfig: dashboardLLMConfig,
      authFetch,
      agentHost,
      // INVK-01: the queue executes through this, in this process, over `runs.start`. A dashboard
      // started without it would answer 503 from the execution routes — which is what an
      // unresolvable `agent-qa` binary used to produce, and the honest shape of the same absence.
      executionBackend: runDoor.backend,
      // 432-21 (D-12): always present — the run service mounts tokenlessly.
      runService: runService.ports,
    })

    // D-16: the second supplier, now that there is a port to name. Loopback rather than a hostname,
    // matching where this server binds.
    boundOrigin = `http://localhost:${String(listeningPort)}`

    // ---- The CO-HOSTED MCP endpoint (408 plan 03, D-03 / Open Question 4 · MCPA-01) -------------
    //
    // WHY IT IS HERE AND NOT IN `packages/dashboard-server`. 403 D-01 gives each process its own
    // live-view signing key, so a `liveUrl` minted in one process does not validate in another. The
    // App's whole promise — a host renders the run's live view — therefore holds only where the
    // mint and the frame proxy share a composition. RESEARCH measured the topology: this command is
    // the ONLY composition that binds `liveView` (`composeLiveView` above) and serves the embed
    // route and the frame socket. So the App is mounted where it can be honest, and the standalone
    // `agent-qa mcp` keeps the shipped floor — `runs.liveurl` unbound, no App registered at all,
    // and the link-out as its whole answer.
    //
    // A SECOND LOOPBACK LISTENER, NOT A DASHBOARD-SERVER ROUTE. `createAgentQaMcpNodeHandler` binds
    // nothing and returns a request function, so the cheap composition is a `node:http` server of
    // our own. That also settles criterion 3 structurally rather than carefully: no file under
    // `packages/dashboard-server/` is touched, so the measured route-order hazard (a new route
    // registered below the SPA arm renders the React app — 403 Pitfall 10) cannot be reached from
    // here at all.
    //
    // THE GUARD ORDER IS REUSED BY REFERENCE (Pitfall 7). `createMcpHttpRequestListener` is the
    // exported one — Host, then Origin, then the handler — so this endpoint refuses a rebound DNS
    // name and a page on another origin by exactly the code the standalone face does, and emits no
    // CORS header for the same reason it does not.
    //
    // 2026-10-01 (432-21, D-12): NO CREDENTIAL FAMILY. The `services.mcp.tokens` bearer this
    // endpoint used to require (Open Question 4: one credential family per surface) is deleted, so
    // the endpoint serves the same tokenless caller the standalone face does, and a run-service
    // bearer is not a thing either.
    //
    // THE MOUNT DECISION IS `mcpMountPlanFor`, AND IT IS THE ONLY PLACE ITS CONDITIONS ARE SPELLED
    // (408-09, WR-01 / WR-09 · T-408-18): a declared `services.mcp` block that does not say
    // `enabled: false`. Until 432-21 the second condition was "at least one token declared", and
    // 408-17 (CR-01) moved the token dereference that followed it behind the decision so an unset
    // `tokenEnvVar` could not take a serving dashboard down; with no dereference left, that ordering
    // hazard is gone with it.
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
          // THE LIVE-VIEW-BOUND REGISTRY — the one fact that makes this endpoint different from the
          // standalone one. `runHost.registry` is the registry `composeDashboardDoor` built over
          // `liveView.liveView`, so a by-reference `runs.liveurl` mint on a read of the App resource
          // is signed by the signer `liveView.validate` checks against, which is the same signer the
          // frame proxy above binds. D-03's invariant therefore holds BY COMPOSITION rather than by
          // configuration, and `registerAppResources`' binding gate registers the App here for
          // exactly that reason.
          registry: runHost.registry as FunctionRegistry,
          maskText: mcpMaskText,
          // D-08's overlay law, in the one order it may be written: the operator's configured base
          // is somebody pointing at a reverse proxy, a tunnel or a path prefix, so it WINS; the
          // bound origin fills an absence and never replaces a presence. Read per result rather
          // than captured, because `boundOrigin` is a box (see `overlayDashboardBaseUrl`).
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
      // THE OPTIONAL SURFACE CANNOT TAKE THE PRIMARY ONE DOWN (408-09, WR-02 · T-408-17). The
      // dashboard is already serving by the time this line runs, so a failure here costs the
      // operator a warning that NAMES the MCP endpoint and the port, not their dashboard. The
      // handle `mountCoHostedMcp` answers is the handle this command keeps: `undefined` on failure,
      // which is exactly the state the shutdown path's `mcpServer?.close()` already handles.
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
      exec(`${openCmd} http://localhost:${port}`)
    }

    let shuttingDown = false
    const shutdown = async () => {
      if (shuttingDown) return
      shuttingDown = true
      console.log(pc.dim(`\nShutting down ${labels.shutdown}...`))
      close()
      // 408 plan 03: the co-hosted MCP listener is this command's to close, beside the dashboard's
      // own — it is a socket this process bound, and a shutdown that left it listening would leave
      // an endpoint over a registry whose door is closing underneath it.
      mcpServer?.close()
      // 402-01: unregister the session observer and drop every retained handle. Without it the
      // run door's observer set keeps a closure alive that keeps this map alive that keeps every
      // finished run's bus alive.
      runService.dispose()
      // 403 D-14: the hoisted registry is the command's to dispose — `composeRunServicePorts`
      // leaves a registry it did not build alone.
      sessions.dispose()
      // 2026-08-17 (Phase 398 plan 10, D-18/D-20): THE DASHBOARD EMITS NO ANALYTICS, and the flush
      // that used to stand here is gone with the events it drained.
      //
      // The three v33 members — `dashboard.opened`, `dashboard.live_mode.started`,
      // `dashboard.entity.created` — are dropped rather than ported, because the dashboard is being
      // rebuilt: carrying the v1 answers forward would pre-decide what a rebuilt dashboard is worth
      // measuring. They are listed in the analytics package's `RETIRED_V33_EVENT_NAMES` so their
      // absence is a decision on the record rather than an omission, and a cell asserts that set is
      // disjoint from the live membership. M5 re-adds what it needs against the `AnalyticsPort`.
      //
      // Nothing replaces the flush either. This process captured nothing — the v1 call drained a
      // process-global service that other commands filled, which is exactly the ambient reach D-17
      // removed. A host that emits nothing has nothing to drain.
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
