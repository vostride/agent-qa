import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join, extname, resolve } from 'node:path'
import { cpus } from 'node:os'
import { format } from 'node:util'
import type { DashboardDatabase } from '../db/database.js'
import { classifyRunOwner } from '../db/run-owner.js'
import { createRouter, sanitizeQueuedExecutionTimeout } from './routes.js'
import {
  backstopServerError,
  refuseForeignHostPage,
  refuseUnparseableRequest,
  tryParseRequestUrl,
} from './request-url.js'
import type { ExecutionBackend, RunSettledDetails, RunSettledStatus } from '../execution/execution-backend.js'
import { JobQueue } from '../queue/job-queue.js'
import { TestFileManager } from '../tests/test-file-manager.js'
import { SuiteFileManager } from '../tests/suite-file-manager.js'
import { ConfigManager, readConfigValues } from '../config/index.js'
import { AppiumManager } from '../execution/appium-manager.js'
import { WebSocketServer } from 'ws'
import { SessionManager } from '../live-editor/session-manager.js'
import { createSessionHandler } from '../live-editor/ws-handler.js'
import { LIVE_EMBED_PATH_PREFIX, LIVE_VIEW_WS_PATH } from '../live-view/protocol.js'
import { renderLiveEmbedPage } from '../live-view/embed-page.js'
import { createFrameProxy } from '../live-view/frame-proxy.js'
import { refuseCrossSiteRequest, refuseNonLoopbackHost } from './cross-site.js'
import { LIVE_EDITOR_UNKNOWN_SESSION_CLOSE_CODE } from '../live-editor/types.js'
import type { LiveEditorSubjects } from '../live-view/editor-subjects.js'
import type {
  EditorLiveUrlResult,
  LiveUrlVerdict,
  LiveViewSubjectRef,
  MaskFn,
  RunSession,
  RunsLiveUrlResult,
} from '@vostride/agent-qa-schema'
import {
  isLoopbackHost,
  printRunText,
  type ResolvedWorkspacePaths,
} from '@vostride/agent-qa-core'
import type { DashboardLLMConfig } from '../llm-model-mapping.js'
import type { AgentHost } from '../chat/host.js'
import type { PostProcessingRelay } from '../execution/post-processing-relay.js'
import {
  createRunServiceRoutes,
  ownsRunServicePath,
  type RunServicePorts,
} from '../run-service/run-service-routes.js'
import type { RunServiceReadiness } from '@vostride/agent-qa-schema'
// the `@vostride/agent-qa-mcp` import is GONE, together with the MCP endpoint this
// server used to start beside the dashboard. The v2 server is composed per-caller by the CLI's own
// host (`agent-qa mcp`) over the function registry, so a dashboard that mounted its own copy would
// be a second composition root for the same surface — the private power the milestone abolishes.
// M5's dashboard rebuild decides whether it wants a mount back, via `/hono` and its own decision.
//
// THE HONO RESERVATION IS RETIRED. The question this file reserved
// ("would a framework earn its place here?") is answered: no. The run service mounted below is
// hand-rolled `node:http`, like the daemon server and the MCP listener — zero new dependencies at a
// network boundary, one routing idiom per process. A framework added later would
// have to argue against that, not inherit an open reservation.

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.webp': 'image/webp',
}

/**
 * The dashboard binds loopback only, because nothing it serves asks for a credential. The message
 * names the host and the config key and attaches no cause.
 */
export class DashboardRemoteBindRefusedError extends Error {
  constructor(readonly host: string, port: number) {
    const p = String(port === 0 ? 3470 : port)
    super(
      `The dashboard was asked to bind ${host}, which is not a loopback interface. Nothing this `
      + 'server serves — the run trigger, the queue enqueue, the run service, the artifact '
      + 'serving, the config reads — asks for a credential, so a non-loopback bind would publish '
      + 'an anonymous run trigger to the network. Leave '
      + `services.dashboard.host unset (it defaults to ${DEFAULT_DASHBOARD_HOST}). To use the `
      + `dashboard from another machine, forward its port with ssh -L ${p}:localhost:${p} <host> `
      + `and open http://localhost:${p}/.`,
    )
    this.name = 'DashboardRemoteBindRefusedError'
  }
}

/** Where this server binds when nothing says otherwise. BREAKING since v2. */
export const DEFAULT_DASHBOARD_HOST = '127.0.0.1'

interface StartServerOptions {
  db: DashboardDatabase
  port?: number
  /** Defaults to loopback; any other value is refused before anything listens. */
  host?: string
  uiDir?: string
  /**
   * Where this workspace writes run artifacts (`services.dashboard.artifactsDir`).
   *
   * ACCEPTED AND NOT READ BY THIS SERVER SINCE 405-07. It used to be resolved into a
   * screenshots and a videos root that two path-serving routes and the run-deletion sweep read.
   * Refs are the only artifact addressing now, and the bytes are reached through the
   * `runs.artifact` op over the evidence store's own layout. The option stays declared because it
   * is a user-facing config key the RECORDING path still writes under; the dashboard simply no
   * longer serves or deletes anything by path.
   */
  artifactsDir?: string
  workspacePaths?: ResolvedWorkspacePaths
  configPath?: string
  // every config read this server serves passes through the declared mask.
  declaredSecretMask: MaskFn
  llmConfig?: DashboardLLMConfig & {
    vision?: { screenshotSize?: number; effectiveResolution?: number }
  }
  authFetch?: typeof globalThis.fetch
  /**
   * The composed agent host the chat door dispatches through.
   *
   * INJECTED by whoever starts this server — in production `agent-qa dashboard`, which composes the
   * SAME port set `agent-qa chat` does and hands it over, so the two interactive doors have one
   * answer to "what can a conversation do". Absent leaves the chat routes answering 501 by
   * name: the door exists, this process was started without a host. See `chat/host.ts`.
   */
  agentHost?: AgentHost
  /**
   * The backend every dashboard run executes through.
   *
   * INJECTED, ON `agentHost`'s OWN IDIOM AND FOR ITS OWN REASON. The implementation that starts a
   * run names `runs.start`, `invokeFunction` and the composed local host — all of it
   * `@vostride/agent-qa-agent*` vocabulary this package may not import (validate:arch). So
   * `agent-qa dashboard` composes it in the process that runs this server and hands it over, which
   * is what makes the run button one more caller of the op chat already uses rather than a
   * dashboard carve-out around the gates.
   *
   * ABSENT DEGRADES BY NAME, exactly as it did when the CLI binary could not be resolved: the
   * execution routes answer 503 and the queue's execute handler does nothing. A dashboard started
   * without a run door is a dashboard that cannot run tests, and it says so.
   */
  executionBackend?: ExecutionBackend
  /**
   * The run service's ports.
   *
   * INJECTED, ON `agentHost`'s AND `executionBackend`'s OWN IDIOM AND FOR THEIR OWN REASON. The
   * implementations name `runs.start`, `invokeFunction` and the composed local host — all of it
   * vocabulary this package may not import (validate:arch). So `agent-qa dashboard` composes them
   * in the process that runs this server and hands them over, which is what makes the run service
   * a mountable module rather than a fourth process.
   *
   * ABSENT MEANS THE SERVICE IS NOT MOUNTED, and `/run` and its neighbours reach whatever the
   * static/SPA handling below does with an unknown path. 2026-10-01: `agent-qa
   * dashboard` supplies it unconditionally now. It used to mount only when a run-service credential
   * was declared, and those credentials are deleted; the door is guarded by the same-site check
   * and the loopback bind like every other door here. Absent is a bare in-process mount's posture.
   */
  runService?: RunServicePorts
  /**
   * The run service's readiness predicate, served WITHOUT a token on the local dashboard API
   * (402-05, D-15 — `GET /api/run-readiness`).
   *
   * SEPARATE FROM `runService` ABOVE AND NOT DERIVED FROM IT, because a mount without the service
   * still has a browser that needs an honest readiness answer rather than a 404. `agent-qa
   * dashboard` supplies the very same function object it put on `runService.readiness`: one
   * predicate, two doors. (Until 432-21 the service was absent whenever no credential was declared.)
   */
  runServiceReadiness?: () => RunServiceReadiness
  /**
   * The run id → live `RunSession` lookup, as a FIRST-CLASS option.
   *
   * SEPARATE FROM `runService` AND NOT DERIVED FROM IT, on `runServiceReadiness`'s exact argument
   * one field up. The derivation `runService?.attach` is what made the local run-stream door
   * answer 503 about runs this very process was executing: until 432-21 `composeRunServicePorts`
   * ran only when `runServiceTokens` were declared, so the DEFAULT zero-token dashboard composed no
   * registry at all and the local door had nothing to attach to. `agent-qa dashboard` supplies this
   * from a registry hoisted above the door.
   *
   * The legacy derivation still applies when this is absent, so an in-process caller that only
   * passes `runService` keeps working byte-for-byte.
   */
  runServiceAttach?: (runId: string) => RunSession | undefined
  /**
   * The live-view seam: the function layer's validator, by reference, and the
   * mint dispatched through the registry.
   *
   * ABSENT MEANS NO LIVE VIEW IS SERVED — the embed route is not registered, the frame socket
   * refuses the upgrade, and `GET /api/runs/:runId/live-url` answers 503 by name. This server
   * holds NO signing key and NO token parse of its own; both are the function layer's, handed in.
   */
  liveView?: {
    validate(token: string, expect: { subject: LiveViewSubjectRef; now: number }): LiveUrlVerdict
    mintLiveUrl(runId: string, handle: number): Promise<RunsLiveUrlResult>
    /**
     * The `editor.liveurl` mint, dispatched through the registry. ABSENT MEANS NO
     * EDITOR VIEW IS MINTED, and `GET /api/live-editor/sessions/:id/live-url` answers 503 by name.
     */
    mintEditorLiveUrl?(sessionId: string): Promise<EditorLiveUrlResult>
  }
  /**
   * The editor-subject registry: the session manager registers each live editor session
   * here and the frame socket attaches editor subjects through it.
   *
   * ABSENT MEANS NO EDITOR SUBJECT IS SERVED ON THE FRAME SOCKET. `agent-qa dashboard` creates one
   * registry and hands the same object to the live-view composition and to this server.
   */
  liveEditorSubjects?: LiveEditorSubjects
  /**
   * The in-process post-processing chip relay.
   *
   * INJECTED, ON `agentHost`'s OWN IDIOM AND FOR ITS OWN REASON. The PUBLISHER is the CLI's
   * post-run chip emitter, in this same process, and this package may not import it — so
   * `agent-qa dashboard` creates one relay, hands `relay.publish` to the run door's bridge as the
   * emitter's second sink and hands the relay itself here. It has to be the SAME object: a relay
   * built inside this function would be a registry nothing publishes to, and the stream door would
   * heartbeat forever at a page whose chips are demonstrably moving.
   *
   * ABSENT MEANS NO PUSH CHANNEL, and `GET /api/runs/:id/post-processing/stream` answers 503 by
   * name. The READ route needs none of this and keeps working: polling is the floor the whole
   * design rests on, and the stream is the optimisation over it.
   */
  postProcessingRelay?: PostProcessingRelay
}

export async function startServer(opts: StartServerOptions): Promise<{
  server: Server
  port: number
  close: () => void
}> {
  const { db, port = 3470, uiDir, workspacePaths, configPath, llmConfig, authFetch, agentHost, executionBackend, runService, runServiceReadiness, liveView, liveEditorSubjects, postProcessingRelay } = opts
  // the explicit port wins; the pre-403 derivation is the fallback for legacy callers.
  const runServiceAttach = opts.runServiceAttach ?? runService?.attach
  const host = opts.host?.trim() || DEFAULT_DASHBOARD_HOST

  // The bind guard runs before anything is opened or listens, so a refused host allocates nothing.
  // Membership is `isLoopbackHost`, so `localhost` and `::1` stay configurable.
  if (!isLoopbackHost(host)) {
    throw new DashboardRemoteBindRefusedError(host, port)
  }

  const resolvedConfigPath = configPath ?? resolve('agent-qa.config.yaml')
  const configManager = new ConfigManager(resolvedConfigPath, opts.declaredSecretMask)

  // Read concurrency from config (defaults to os.cpus().length)
  const config = await readConfigValues(configManager).catch(() => ({}))
  const concurrency = typeof (config as any).concurrency === 'number'
    ? (config as any).concurrency
    : cpus().length

  const finalizeRunArtifactBestEffort = (
    runId: string,
    code: string,
    phase: string,
    message: string,
    runtime: Record<string, unknown> = {},
  ): void => {
    try {
      const artifact = db.getRunArtifact(runId)
      if (!artifact || artifact.finalizedAt) return
      db.finalizeRunArtifact(runId, {
        runtime,
        errors: [{ code, phase, message }],
      } as any)
    } catch { /* best-effort cleanup */ }
  }

  // THE RUN'S TERMINAL STATE, RECONCILED WHERE THE CHILD'S EXIT USED TO BE.
  //
  // This body is the `onProcessClose` reconciliation, unchanged in what it writes. What changed is
  // where the facts come from: the status is the bus's own ground truth rather than an exit code
  // read through a scrape, and the diagnostic lines are the failure's OWN message rather than a
  // tail of the child's stderr. The three things it does — reconcile a db row still reading
  // `running`, release the run's Appium lease, free the queue slot — are the three things the
  // process exit was load-bearing for, and all three still need doing.
  executionBackend?.on('run-settled', (
    runId: string,
    status: RunSettledStatus,
    details: RunSettledDetails,
  ) => {
    // The run settled but the DB row is still 'running' — update it so the dashboard does not
    // show a stuck run. 2026-10-17: a row the run already finished is never rewritten.
    try {
      const run = db.getRun(runId)
      const output = details.output
      if (run && run.status === 'running') {
        const duration = run.startedAt
          ? Date.now() - new Date(run.startedAt).getTime()
          : 0

        let dbStatus: string
        let failureSummary: string | undefined
        let errorLog: string | undefined
        // the neutral prose a REFUSAL is carrying, held aside so the errorLog
        // composition below can prefer it over the diagnostic lines. Undefined on every other arm,
        // which is what keeps those arms byte-identical.
        let refusalProse: string | undefined
        if (status === 'cancelled') {
          dbStatus = 'cancelled'
          failureSummary = undefined
        } else if (status === 'timeout') {
          dbStatus = 'failed'
          failureSummary = 'Test timed out -- process was killed'
        } else if (details.refusedBeforeStart) {
          // A REFUSAL IS NOT A PROCESS EXIT.
          //
          // Branched on the FACT the settle carries, above the `completed` arm and above the regex
          // fallback, because both of those describe a run that ran. A run the gate refused before
          // anything started has no exit to report — and the summary is the line a runs list shows,
          // so it was the sentence a person read about every denied dashboard run.
          //
          // The prose is the rejection's own message (an unrecognised request field, an input
          // error), which names no surface's affordance. No remedy list rides it.
          dbStatus = 'failed'
          refusalProse = details.reason
          failureSummary = refusalProse
            ? `Refused before the run started: ${refusalProse}`.slice(0, 300)
            : 'Refused before the run started'
        } else if (status === 'completed') {
          dbStatus = 'failed'
          failureSummary = 'Process exited before test completed'
        } else {
          dbStatus = 'failed'
          const outputLines = output.map(l => l.replace(/\x1b\[[0-9;]*m/g, ''))
          const meaningfulLine = [...outputLines].reverse().find(l =>
            /error/i.test(l) || l.includes('Parse') || l.includes('not found') || l.includes('rejected')
          )
          failureSummary = meaningfulLine
            ? meaningfulLine.slice(0, 300)
            : 'Process exited before test completed'
        }

        if (refusalProse !== undefined) {
          // The refused run's ONLY record of why it never happened. The diagnostic lines it
          // replaces are the rejection's canonical message — the one carrying the CLI flag.
          errorLog = refusalProse.replace(/\x1b\[[0-9;]*m/g, '').slice(-10000) || undefined
        } else if (dbStatus === 'failed' && output.length) {
          errorLog = [...output]
            .join('\n')
            .replace(/\x1b\[[0-9;]*m/g, '')
            .slice(-10000) || undefined
        }

        // THE SUITE-PARENT STATUS FOLD IS RETIRED WITH THE
        // CHILDREN IT FOLDED — the same retirement, at the same site, as the retry-child block
        // below, for the same reason.
        //
        // ~75 lines stood here: force every `running`/`pending` child terminal, re-read them, and
        // derive the parent's status as the worst child status. A suite is now ONE run row with
        // member handles; nothing writes the run row's parent-link column, so the
        // fold's own `updatedChildren.length === 0` branch was the only branch it could still take,
        // and that is what the common path below does. What a suite run GAINS by falling through
        // is the diagnostic `failureSummary` and the captured `errorLog` the fold discarded in
        // favour of the constant sentence "Suite test(s) failed".
        //
        // HISTORICAL ROWS ARE UNAFFECTED: this fold only ever ran when a live process closed, and
        // no live process owns pre-402 children. The read side that renders them is untouched.

        db.updateRun(runId, {
          status: dbStatus,
          duration,
          endedAt: new Date().toISOString(),
          failureSummary,
          errorLog,
        })
        finalizeRunArtifactBestEffort(
          runId,
          'process-close',
          'process-close',
          failureSummary ?? 'Process closed',
          { status: dbStatus, finalStatus: dbStatus, processStatus: status, duration },
        )
      }
    } catch { /* best-effort */ }

    releaseMobileAppiumLease(runId, status)
    jobQueue.onSlotFreed(runId)
  })

  // only runs whose owning process is provably gone are finalized.
  let finalized = 0
  for (const { id, owner } of db.listRunningRunOwners()) {
    if (classifyRunOwner(owner, db.runOwnership) === 'gone' && db.finalizeOrphanRun(id, owner)) {
      finalized++
    }
  }
  if (finalized > 0) {
    console.log(`Finalized ${finalized} run(s) whose agent-qa process had ended`)
  }

  // Log any pending rows left from previous session (benign — picked up when queue starts)
  const pendingOrphans = db.getRuns({ statuses: ['pending'] })
  if (pendingOrphans.length > 0) {
    console.log(`Found ${pendingOrphans.length} pending run(s) from previous session — will be processed when queue starts`)
  }

  // Appium lifecycle manager — auto-starts Appium for mobile tests
  const appiumManager = new AppiumManager()
  const mobileRuns = new Map<string, 'android' | 'ios'>()

  const releaseMobileAppiumLease = (runId: string, reason: string): void => {
    const platform = mobileRuns.get(runId)
    if (!platform) return
    mobileRuns.delete(runId)
    appiumManager.releaseLease(runId, reason)
  }

  const releaseAllMobileAppiumLeases = (reason: string): void => {
    for (const runId of [...mobileRuns.keys()]) {
      releaseMobileAppiumLease(runId, reason)
    }
  }

  // The persistent RUN QUEUE — all run triggers route through this. Named per D-21: it is not
  // the curation queue and not the agent job queue. The `JobQueue` class name is v1 vocabulary
  // that D-21 leaves unrenamed; only what an operator reads carries the qualifier.
  const jobQueue = new JobQueue({
    db,
    concurrency,
    requestStop: (runId) => executionBackend?.kill(runId) ?? false,
  })
  console.log(`Run queue started with ${concurrency} concurrency slot(s)`)
  console.log('Appium lifecycle manager initialized (auto-start on first mobile test)')

  // Wire the run queue's 'execute' event to the injected execution backend.
  //
  // THE QUEUE ITSELF IS UNTOUCHED — its slots, its polling, its ordering and its cancel signal are
  // the same object they were, which is D-09's build-order pin in one line: what changed underneath
  // it is who executes, not who schedules.
  jobQueue.on('execute', async (run) => {
    if (!executionBackend) return

    const platform = run.platform ?? 'web'
    const isMobile = platform === 'ios' || platform === 'android'

    // Ensure Appium is running before mobile test execution
    if (isMobile) {
      try {
        await appiumManager.acquireLease({ runId: run.id, platform })
        mobileRuns.set(run.id, platform)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        printRunText(`Failed to start Appium for run ${run.id}: ${message}`, (text) =>
          console.error(text),
        )
        db.updateRun(run.id, {
          status: 'failed',
          failureSummary: `Appium server failed to start: ${message}`,
          endedAt: new Date().toISOString(),
        })
        finalizeRunArtifactBestEffort(run.id, 'appium-startup', 'appium-startup', `Appium server failed to start: ${message}`, { status: 'failed' })
        jobQueue.onSlotFreed(run.id)
        return
      }
    }

    const meta = (run.metadata ?? {}) as Record<string, unknown>
    const args = Array.isArray(meta.args)
      ? meta.args.filter((arg): arg is string => typeof arg === 'string')
      : []
    if (args.length === 0 && run.filePath) {
      args.push(run.filePath)
    }
    executionBackend.execute({
      runId: run.id,
      args,
      source: meta.isSuite ? 'suite' : 'dashboard',
      // no confirm scope is read off the row any more. The browser that
      // triggered a run is not asked anything, so nothing about it has to survive the wait.
      attributes: run.attributes,
      // a persisted row's timeout is VALIDATED at the seam that consumes it.
      // `in-process-backend.ts:211` reads `opts.timeout ?? defaultTimeout` and validates AFTER, so
      // any non-nullish nonsense here skips the default and leaves the run with no reclamation
      // timer at all. An unusable value falls back to the backend's default rather than a number
      // this call invented.
      timeout: sanitizeQueuedExecutionTimeout(meta.timeout),
      // THE LEASE ABOVE IS UNCHANGED; ONLY ITS DELIVERY IS. `acquireLease` still runs where it ran,
      // still keys on this run id and still owns the bundled Appium's lifecycle (design-of-record).
      // What used to ride `AGENT_QA_APPIUM_URL` in a child's environment now travels as an
      // argument, because there is no child to carry an environment.
      ...(isMobile ? { appiumUrl: appiumManager.getUrl() } : {}),
    })
  })

  // Start the queue polling loop
  jobQueue.start()

  // TestFileManager for test file CRUD
  const testFileManager = workspacePaths ? new TestFileManager(workspacePaths) : undefined

  const suiteFileManager = workspacePaths ? new SuiteFileManager(workspacePaths, testFileManager) : undefined

  const sessionManager = new SessionManager({
    appiumManager,
    configManager,
    configPath: resolvedConfigPath,
    // each created session registers here, which is what the frame socket attaches.
    ...(liveEditorSubjects === undefined ? {} : { liveEditorSubjects }),
  })

  // the embed route and the frame socket serve a live view when the seam is bound and at
  // least one subject registry is present. The proxy dispatches on the token's signed kind, so a
  // missing registry is only a lookup that answers nothing.
  const servesLiveView = liveView !== undefined
    && (runServiceAttach !== undefined || liveEditorSubjects !== undefined)

  const apiRouter = createRouter({
    db,
    workspacePaths,
    // conditionally spread on the same house rule `agentHost` follows — an absent
    // dependency is an ABSENT field, never a present `undefined`, so the router's own 503 arm is
    // what decides, in one place.
    ...(executionBackend === undefined ? {} : { executionBackend }),
    jobQueue,
    testFileManager,
    suiteFileManager,
    configManager,
    configPath: resolvedConfigPath,
    declaredSecretMask: opts.declaredSecretMask,
    llmConfig,
    authFetch,
    sessionManager,
    // conditionally spread on the house rule an absent dependency is an ABSENT field and
    // never a present `undefined` — the router's own 501 arm is what decides, in one place.
    ...(agentHost === undefined ? {} : { agentHost }),
    // the same conditional-spread house rule. Absent means a legacy mount rather
    // than an unconfigured service, and the router's own 503 arm is what decides, in one place.
    ...(runServiceReadiness === undefined ? {} : { runServiceReadiness }),
    // the LOCAL run-stream door's attach port, READ OFF `runService` rather than
    // composed again. That derivation is the "one session registry serves both doors" claim in its
    // structural form — there is no second wiring a composition root could forget or point
    // somewhere else, and the two doors cannot end up attached to different registries. Absent
    // `runService` means no registry exists at all, so the same conditional-spread house rule
    // applies and the router's own 503 arm decides.
    ...(runServiceAttach === undefined ? {} : { runServiceAttach }),
    // the mint route's port, on the same conditional-spread house rule — absent means
    // this host serves no live view and the route's own 503 arm decides, in one place.
    ...(liveView === undefined ? {} : { mintLiveUrl: liveView.mintLiveUrl }),
    // the editor mint, on the same house rule — absent means the editor mint route's own
    // 503 decides.
    ...(liveView?.mintEditorLiveUrl === undefined
      ? {}
      : { mintEditorLiveUrl: liveView.mintEditorLiveUrl }),
    // the same conditional-spread house rule — absent means this host serves no
    // post-processing push channel and the stream arm's own 503 decides, in one place.
    ...(postProcessingRelay === undefined ? {} : { postProcessingRelay }),
  })

  // composed once, at start, on `apiRouter`'s own idiom. Absent ports mean no router and
  // therefore no mount — the path check below is skipped entirely and this server behaves as today.
  const runServiceRouter = runService === undefined ? undefined : createRunServiceRoutes(runService)

  // THE PROCESS-LEVEL BACKSTOP AND THE GUARDED PARSE (400-16, gap 7). Every request enters here, so
  // this is the choke point: an unparseable request line is answered 400 before any frame below can
  // see it, and the whole body runs inside a `try` so a synchronous throw out of `apiRouter` — or a
  // rejection of anything awaited below — becomes a 500 instead of an unhandled rejection that ends
  // the process. `server.ts`'s listener is `async`, which is why the ONE `catch` covers both. The
  // full throw-path enumeration, and what each frame owns, lives in `./request-url.ts`.
  const server = createServer(async (req, res) => {
    try {
      const url = tryParseRequestUrl(req)
      if (url === undefined) {
        refuseUnparseableRequest(res)
        return
      }
      const path = url.pathname

      // Run-service paths go to their own router first, for every method. That router guards its
      // head before its route table and writes no cross-origin grant.
      if (runServiceRouter !== undefined && ownsRunServicePath(path)) {
        runServiceRouter(req, res)
        return
      }

      // API routes
      if (path.startsWith('/api/')) {
        apiRouter(req, res)
        return
      }

      // Pages answer only at a loopback Host, so a rebound name cannot load them.
      if (refuseNonLoopbackHost(req) !== undefined) {
        const address = server.address()
        const boundPort = typeof address === 'object' && address !== null ? address.port : port
        refuseForeignHostPage(res, boundPort)
        return
      }

      if (req.method === 'OPTIONS') {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('Not Found')
        return
      }

      // GET /live/:runId — THE SERVED EMBED PAGE.
      //
      // REGISTERED ABOVE THE STATIC/SPA ARM, and the ORDER IS THE MECHANISM (RESEARCH Pitfall 10).
      // The SPA fallback below answers `index.html` for ANY unknown path, so a `/live/` arm placed
      // after it would render the React dashboard inside every embedding iframe — a failure that
      // looks like a styling bug and is actually the contract being unreachable. `live-view-anchors`
      // and the tracer cell both assert this route's answer is a live-view document.
      //
      // NO `X-Frame-Options` — the whole point of this page is that a host embeds it. What replaces
      // it is a CSP that permits exactly one nonce'd inline script and nothing else, plus
      // `Referrer-Policy: no-referrer` so the fragment-carried token cannot ride a `Referer` out
      if (req.method === 'GET' && path.startsWith(LIVE_EMBED_PATH_PREFIX)) {
        if (!servesLiveView) {
          res.writeHead(503, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'live_view_unavailable' }))
          return
        }
        let embedRunId: string
        try {
          embedRunId = decodeURIComponent(path.slice(LIVE_EMBED_PATH_PREFIX.length))
        } catch {
          res.writeHead(404, { 'Content-Type': 'text/plain' })
          res.end('Not Found')
          return
        }
        if (embedRunId === '' || embedRunId.includes('/')) {
          res.writeHead(404, { 'Content-Type': 'text/plain' })
          res.end('Not Found')
          return
        }
        const nonce = randomBytes(16).toString('base64')
        const body = renderLiveEmbedPage({ runId: embedRunId, nonce })
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
          'Content-Security-Policy':
            `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; `
            + "connect-src 'self' ws: wss:; img-src blob: data:",
          'Content-Length': Buffer.byteLength(body),
        })
        res.end(body)
        return
      }

      // Static file serving
      if (uiDir) {
        const filePath = path === '/' ? join(uiDir, 'index.html') : join(uiDir, path)

        try {
          const fileStat = await stat(filePath)
          if (fileStat.isFile()) {
            const content = await readFile(filePath)
            const ext = extname(filePath)
            const contentType = MIME_TYPES[ext] || 'application/octet-stream'
            res.writeHead(200, {
              'Content-Type': contentType,
              'Content-Length': content.length,
            })
            res.end(content)
            return
          }
        } catch {
          // File not found — fall through to SPA fallback
        }

        // SPA fallback: serve index.html for non-file paths
        try {
          const indexPath = join(uiDir, 'index.html')
          const content = await readFile(indexPath)
          res.writeHead(200, {
            'Content-Type': 'text/html',
            'Content-Length': content.length,
          })
          res.end(content)
          return
        } catch {
          // No index.html available
        }
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not Found')
    } catch (error) {
      backstopServerError(res, req, error)
    }
  })

  // Bytes Node's own parser rejects never reach the listener above, and an unhandled `clientError`
  // is an uncaught error on the server. Answering it in fixed bytes keeps that class inside the
  // same posture as the rest of the enumeration.
  server.on('clientError', (_error, socket) => {
    if (socket.destroyed) return
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    socket.destroy()
  })

  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (request, socket, head) => {
    // SYNCHRONOUS, so a throw here is an uncaught EXCEPTION the listener's backstop cannot reach.
    // The guarded parse is the only thing standing between `GET //%` with an `Upgrade` header and a
    // dead process; `undefined` takes this handler's existing refusal idiom.
    const url = tryParseRequestUrl(request)
    if (url === undefined) {
      socket.destroy()
      return
    }
    // the frame socket. The run id is the ONLY query parameter — the token arrives in
    // the first text message and nowhere else, so a refused upgrade has never seen a credential.
    if (url.pathname === LIVE_VIEW_WS_PATH) {
      const hostRefusal = refuseNonLoopbackHost(request)
      if (hostRefusal !== undefined) {
        socket.destroy()
        return
      }

      // DEFENSE IN DEPTH, AND NOT THE CREDENTIAL — 403 gap round 1, T-403-21.
      //
      // A WebSocket upgrade is exempt from CORS entirely, so the mint door's same-site guard is not
      // inherited here. This rung refuses the ONE shape it can honestly refuse: a present `Origin`
      // that names another host. It is explicitly NOT a credential, and the reason is worth writing
      // down rather than rediscovering. The legitimate embed page runs in an iframe sandboxed
      // WITHOUT `allow-same-origin` (`live-preview.tsx`), so its upgrade carries the literal
      // `null` — and a sandboxed ATTACKER iframe sends exactly the same thing. Accepting `null` is
      // therefore mandatory for the real embed and worthless as a gate, and dropping the sandbox to
      // make this check "real" would hand the embed same-origin access to the dashboard, which is a
      // worse trade than the one this rung declines to make.
      //
      // THE CREDENTIAL REMAINS THE TOKEN validated in the first `hello` message, minted only by a
      // door that now refuses a cross-site caller. An absent `Origin` is the non-browser client and
      // is accepted, on the mint door's own reasoning.
      const upgradeOrigin = request.headers.origin
      if (typeof upgradeOrigin === 'string' && upgradeOrigin !== '' && upgradeOrigin !== 'null') {
        const upgradeHost = typeof request.headers.host === 'string' ? request.headers.host.toLowerCase() : ''
        let upgradeOriginHost = ''
        try {
          upgradeOriginHost = new URL(upgradeOrigin).host.toLowerCase()
        } catch {
          upgradeOriginHost = ''
        }
        // Hosts, not schemes — the same reasoning the mint door's guard records: the bound door
        // speaks `http` on loopback and an operator may put an `https` terminator in front of it.
        if (upgradeOriginHost === '' || upgradeHost === '' || upgradeOriginHost !== upgradeHost) {
          socket.destroy()
          return
        }
      }
      const liveRunId = url.searchParams.get('runId')
      if (liveRunId === null || liveRunId === '' || liveView === undefined || !servesLiveView) {
        socket.destroy()
        return
      }
      const proxy = createFrameProxy({
        validate: liveView.validate,
        attach: runServiceAttach ?? ((): undefined => undefined),
        ...(liveEditorSubjects === undefined ? {} : { attachEditor: liveEditorSubjects.attach }),
      })
      wss.handleUpgrade(request, socket, head, (ws) => { proxy(ws, liveRunId) })
      return
    }
    if (url.pathname === '/api/live-editor/ws') {
      // THE SAME-SITE GUARD, FIRST. This socket drives a browser, and a
      // WebSocket upgrade is exempt from CORS, so a page on another origin could otherwise open it.
      // Unlike the frame socket there is no sandboxed embed to admit, so the literal `null` is
      // refused with every other foreign origin. A refusal is a bare destroy: nothing is written
      // back to a cross-site caller, not even a status line.
      const crossSite = refuseCrossSiteRequest(request)
      if (crossSite !== undefined) {
        socket.destroy()
        return
      }
      const sessionId = url.searchParams.get('sessionId')
      if (!sessionId) {
        socket.destroy()
        return
      }
      const session = sessionManager.getSession(sessionId)
      if (!session) {
        // 428 P5: an admitted caller asking for a session this process does not hold is told so by
        // name, so the page can say the session ended instead of "Disconnected".
        wss.handleUpgrade(request, socket, head, (ws) => {
          ws.close(LIVE_EDITOR_UNKNOWN_SESSION_CLOSE_CODE, 'unknown_session')
        })
        return
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        session.clearIdleTimer()
        const handler = createSessionHandler(session, () => {
          void sessionManager.terminateSession(sessionId).catch((error: unknown) => {
            const line = `[live-editor] could not end session ${sessionId}`
            printRunText(format(line, error), () => console.error(line, error))
          })
        }, (event) => {
          db.insertTokenEvent(event)
        }, testFileManager)
        handler(ws)
      })
    } else {
      socket.destroy()
    }
  })

  const gracefulShutdown = () => {
    sessionManager.cleanupAll()
  }
  process.on('SIGTERM', gracefulShutdown)
  process.on('SIGINT', gracefulShutdown)

  const cleanupRuntimeResources = () => {
    jobQueue.stop()
    executionBackend?.killAll()
    releaseAllMobileAppiumLeases('server-startup-error')
    appiumManager.shutdown()
    sessionManager.cleanupAll()
    db.close()
  }

  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      cleanupRuntimeResources()
      reject(err)
    }
    server.once('error', onError)
    server.listen(port, host, () => {
      server.off('error', onError)
      // A LOOPBACK BIND PRINTS THE LINE IT ALWAYS PRINTED, BYTE FOR BYTE. That is not cosmetic
      // conservatism: this line is the readiness signal three shipped conformance harnesses parse
      // a port out of. The non-loopback arm is unreachable since the bind guard above lost its
      // credential exemption (402 verification); it is kept so the line never names a `localhost`
      // that is not where the server is.
      console.log(
        isLoopbackHost(host)
          ? `Dashboard running at http://localhost:${port}`
          : `Dashboard running at http://${host.includes(':') ? `[${host}]` : host}:${port}`,
      )
      resolve({
        server,
        port,
        close: () => {
          jobQueue.stop()
          executionBackend?.killAll()
          releaseAllMobileAppiumLeases('server-close')
          appiumManager.shutdown()
          sessionManager.cleanupAll()
          server.close()
          db.close()
        },
      })
    })
  })
}
