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

// Where this server binds when nothing says otherwise.
export const DEFAULT_DASHBOARD_HOST = '127.0.0.1'

interface StartServerOptions {
  db: DashboardDatabase
  port?: number
  /** Defaults to loopback; any other value is refused before anything listens. */
  host?: string
  uiDir?: string
  // Declared because it is a user-facing config key; this server serves nothing by path.
  artifactsDir?: string
  workspacePaths?: ResolvedWorkspacePaths
  configPath?: string
  // Every config read this server serves passes through the declared mask.
  declaredSecretMask: MaskFn
  llmConfig?: DashboardLLMConfig & {
    vision?: { screenshotSize?: number; effectiveResolution?: number }
  }
  authFetch?: typeof globalThis.fetch
  // Injected by `agent-qa dashboard` with the ports `agent-qa chat` uses; absent, chat answers 501.
  agentHost?: AgentHost
  // Injected because its implementation names agent vocabulary; absent, execution routes are 503.
  executionBackend?: ExecutionBackend
  // Injected because the ports name agent vocabulary; absent, `/run` falls through to the SPA.
  runService?: RunServicePorts
  // Separate from `runService`, so a mount without the service still answers readiness, not 404.
  runServiceReadiness?: () => RunServiceReadiness
  // Separate from `runService`, so the local stream door can attach without a run service mounted.
  runServiceAttach?: (runId: string) => RunSession | undefined
  // Absent means no live view: no embed route, the frame socket refuses, and live-url answers 503.
  liveView?: {
    validate(token: string, expect: { subject: LiveViewSubjectRef; now: number }): LiveUrlVerdict
    mintLiveUrl(runId: string, handle: number): Promise<RunsLiveUrlResult>
    // Absent means no editor view, and the editor live-url route answers 503 by name.
    mintEditorLiveUrl?(sessionId: string): Promise<EditorLiveUrlResult>
  }
  // `agent-qa dashboard` hands the same registry to the live-view composition and to this server.
  liveEditorSubjects?: LiveEditorSubjects
  // The same relay object the CLI's emitter publishes to; absent, the stream answers 503 by name.
  postProcessingRelay?: PostProcessingRelay
}

export async function startServer(opts: StartServerOptions): Promise<{
  server: Server
  port: number
  close: () => void
}> {
  const { db, port = 3470, uiDir, workspacePaths, configPath, llmConfig, authFetch, agentHost, executionBackend, runService, runServiceReadiness, liveView, liveEditorSubjects, postProcessingRelay } = opts
  // The explicit port wins; `runService.attach` is the fallback for callers that pass only that.
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

  // Reconciles a row still `running`, releases the Appium lease and frees the queue slot.
  executionBackend?.on('run-settled', (
    runId: string,
    status: RunSettledStatus,
    details: RunSettledDetails,
  ) => {
    // A row still `running` is updated so no run looks stuck; a finished row is never rewritten.
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
        // A refusal's neutral prose, preferred over the diagnostic lines for the `errorLog`.
        let refusalProse: string | undefined
        if (status === 'cancelled') {
          dbStatus = 'cancelled'
          failureSummary = undefined
        } else if (status === 'timeout') {
          dbStatus = 'failed'
          failureSummary = 'Test timed out -- process was killed'
        } else if (details.refusedBeforeStart) {
          // A refused run never ran, so its summary is its rejection message, not an exit.
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

  // Only runs whose owning process is provably gone are finalized.
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

  // The run queue, distinct from the curation queue and the agent job queue.
  const jobQueue = new JobQueue({
    db,
    concurrency,
    requestStop: (runId) => executionBackend?.kill(runId) ?? false,
  })
  console.log(`Run queue started with ${concurrency} concurrency slot(s)`)
  console.log('Appium lifecycle manager initialized (auto-start on first mobile test)')

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
      attributes: run.attributes,
      // The backend takes `opts.timeout ?? defaultTimeout`, so an unusable value falls back here.
      timeout: sanitizeQueuedExecutionTimeout(meta.timeout),
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
    // Each created session registers here, which is what the frame socket attaches.
    ...(liveEditorSubjects === undefined ? {} : { liveEditorSubjects }),
  })

  // The proxy dispatches on the token's signed kind, so a missing registry only answers nothing.
  const servesLiveView = liveView !== undefined
    && (runServiceAttach !== undefined || liveEditorSubjects !== undefined)

  const apiRouter = createRouter({
    db,
    workspacePaths,
    // Absent dependencies are absent fields, so the router's own 503 arm decides in one place.
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
    // Absent dependencies are absent fields, so the router's own 501 arm decides in one place.
    ...(agentHost === undefined ? {} : { agentHost }),
    ...(runServiceReadiness === undefined ? {} : { runServiceReadiness }),
    // Read off `runService` by default, so both doors attach to one session registry.
    ...(runServiceAttach === undefined ? {} : { runServiceAttach }),
    ...(liveView === undefined ? {} : { mintLiveUrl: liveView.mintLiveUrl }),
    ...(liveView?.mintEditorLiveUrl === undefined
      ? {}
      : { mintEditorLiveUrl: liveView.mintEditorLiveUrl }),
    ...(postProcessingRelay === undefined ? {} : { postProcessingRelay }),
  })

  // Absent ports mean no router, so the run-service path check below is skipped.
  const runServiceRouter = runService === undefined ? undefined : createRunServiceRoutes(runService)

  // Every request enters here: an unparseable line answers 400, and any throw becomes a 500.
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

      // Above the SPA fallback, which would otherwise answer `index.html` inside every embed frame.
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
    // The run id is the only query parameter; the token arrives in the first text message.
    if (url.pathname === LIVE_VIEW_WS_PATH) {
      const hostRefusal = refuseNonLoopbackHost(request)
      if (hostRefusal !== undefined) {
        socket.destroy()
        return
      }

      // Not a credential: the sandboxed embed sends `Origin: null`, so only a foreign host fails.
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
      // An upgrade is exempt from CORS, so the same-site guard runs first and refuses `null` too.
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
        // A session this process does not hold is refused by name, so the page says it ended.
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
      // Harnesses parse the port from this line; only a loopback bind names `localhost`.
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
