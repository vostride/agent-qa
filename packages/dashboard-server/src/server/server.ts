import { createServer, type Server } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join, extname, resolve } from 'node:path'
import { cpus } from 'node:os'
import type { DashboardDatabase } from '../db/database.js'
import { createRouter } from './routes.js'
import { TestRunner } from '../execution/test-runner.js'
import { JobQueue } from '../queue/job-queue.js'
import { TestFileManager } from '../tests/test-file-manager.js'
import { SuiteFileManager } from '../tests/suite-file-manager.js'
import { ConfigManager } from '../config/index.js'
import { AppiumManager } from '../execution/appium-manager.js'
import { WebSocketServer } from 'ws'
import { SessionManager } from '../live-editor/session-manager.js'
import { createSessionHandler } from '../live-editor/ws-handler.js'
import {
  buildAnalyticsEvent,
  captureAnalytics,
  resolveAnalyticsStandardProperties,
  type ModelConfig,
  type ResolvedWorkspacePaths,
} from '@vostride/agent-qa-core'
import {
  createLocalMcpHttpHandler,
  resolveLocalMcpEndpoint,
  resolveMcpEndpointShape,
  type LocalMcpEndpointConfig,
  type LocalMcpTransport,
} from '@vostride/agent-qa-mcp'

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

function isAnalyticsPrivacyEnabled(config: unknown): boolean {
  if (!config || typeof config !== 'object') return false
  const analytics = (config as { analytics?: unknown }).analytics
  return Boolean(analytics && typeof analytics === 'object'
    && (analytics as { privacy?: unknown }).privacy === true)
}

interface StartServerOptions {
  db: DashboardDatabase
  port?: number
  uiDir?: string
  artifactsDir?: string
  workspacePaths?: ResolvedWorkspacePaths
  configPath?: string
  mcp?: LocalMcpEndpointConfig
  llmConfig?: Pick<
    ModelConfig,
    'provider' | 'model' | 'apiKey' | 'authToken' | 'baseURL' | 'providerHeaders'
  > & {
    screenshotSize?: number
    effectiveResolution?: number
  }
  authFetch?: typeof globalThis.fetch
}

interface McpStartupInfo {
  enabled: boolean
  transport: LocalMcpTransport
  host?: string
  port?: number
  path?: string
  url?: string
}

export async function startServer(opts: StartServerOptions): Promise<{
  server: Server
  port: number
  mcp: McpStartupInfo
  close: () => void
}> {
  const { db, port = 3470, uiDir, artifactsDir, workspacePaths, configPath, mcp, llmConfig, authFetch } = opts

  const resolvedConfigPath = configPath ?? resolve('agent-qa.config.yaml')
  const configManager = new ConfigManager(resolvedConfigPath)

  // Read concurrency from config (defaults to os.cpus().length)
  const config = await configManager.read().catch(() => ({}))
  const concurrency = typeof (config as any).concurrency === 'number'
    ? (config as any).concurrency
    : cpus().length

  let testRunner: TestRunner | undefined

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

  // Resolve CLI binary once — used by TestRunner
  let cliBin: string | undefined
  try {
    cliBin = TestRunner.resolveCliBin()
  } catch {
    console.warn('Warning: Could not resolve agent-qa CLI binary. Execution will not work.')
  }

  // TestRunner for live test execution
  if (cliBin) {
    testRunner = new TestRunner({
      cliBin,
      onProcessClose: (runId, status) => {
        // If the child process exited but the DB row is still 'running',
        // update it so the dashboard doesn't show a stuck run.
        try {
          const run = db.getRun(runId)
          const handle = testRunner!.getHandle(runId)
          const isBrowserDisconnect = handle?.output.some(line =>
            line.includes('Target page, context or browser has been closed') ||
            line.includes('Browser closed by user')
          )
          if (run && (run.status === 'running' || run.status === 'cancelled')) {
            const duration = run.startedAt
              ? Date.now() - new Date(run.startedAt).getTime()
              : 0

            let dbStatus: string
            let failureSummary: string | undefined
            let errorLog: string | undefined
            const explicitCancellation = run.status === 'cancelled' || status === 'cancelled'
            if (explicitCancellation) {
              dbStatus = 'cancelled'
              failureSummary = undefined
            } else if (status === 'timeout') {
              dbStatus = 'failed'
              failureSummary = 'Test timed out -- process was killed'
            } else if (status === 'completed') {
              dbStatus = 'failed'
              failureSummary = 'Process exited before test completed'
            } else if (isBrowserDisconnect) {
              dbStatus = 'cancelled'
              failureSummary = 'Browser closed by user'
            } else {
              dbStatus = 'failed'
              const outputLines = handle?.output.map(l => l.replace(/\x1b\[[0-9;]*m/g, '')) ?? []
              const meaningfulLine = [...outputLines].reverse().find(l =>
                /error/i.test(l) || l.includes('Parse') || l.includes('not found') || l.includes('rejected')
              )
              failureSummary = meaningfulLine
                ? meaningfulLine.slice(0, 300)
                : 'Process exited before test completed'
            }

            if (dbStatus === 'failed' && handle?.output.length) {
              errorLog = handle.output
                .join('\n')
                .replace(/\x1b\[[0-9;]*m/g, '')
                .slice(-10000) || undefined
            }

            // Suite parent: derive status from child test runs
            if (run.suiteId && !run.parentRunId) {
              const children = db.getRunsByParent(runId)
              const incompleteChildStatus = dbStatus === 'cancelled' ? 'cancelled' : 'failed'
              const incompleteChildSummary = incompleteChildStatus === 'cancelled'
                ? 'Suite cancelled'
                : failureSummary ?? 'Suite process terminated'

              for (const child of children) {
                if (child.status === 'running' || child.status === 'pending') {
                  db.updateRun(child.id, {
                    status: incompleteChildStatus,
                    endedAt: new Date().toISOString(),
                    failureSummary: incompleteChildSummary,
                  })
                  finalizeRunArtifactBestEffort(
                    child.id,
                    'suite-process-close',
                    'process-close',
                    incompleteChildSummary,
                    { status: incompleteChildStatus, finalStatus: incompleteChildStatus, processStatus: status },
                  )
                }
              }

              const updatedChildren = db.getRunsByParent(runId)

              const statusPriority: Record<string, number> = {
                failed: 4,
                cancelled: 3,
                flaky: 2,
                passed: 1,
                skipped: 0,
                pending: 0,
                running: 0,
              }

              let worstStatus = 'passed'
              let worstPriority = 0
              for (const child of updatedChildren) {
                const p = statusPriority[child.status] ?? 0
                if (p > worstPriority) {
                  worstPriority = p
                  worstStatus = child.status
                }
              }

              if (updatedChildren.length === 0) {
                if (isBrowserDisconnect) {
                  worstStatus = 'cancelled'
                } else {
                  worstStatus = dbStatus
                }
              }

              db.updateRun(runId, {
                status: worstStatus,
                duration,
                endedAt: new Date().toISOString(),
                failureSummary: worstStatus === 'failed' ? 'Suite test(s) failed'
                  : worstStatus === 'cancelled' ? (isBrowserDisconnect ? 'Browser closed by user' : 'Suite cancelled')
                  : undefined,
              })
              finalizeRunArtifactBestEffort(
                runId,
                'suite-process-close',
                'process-close',
                worstStatus === 'cancelled' ? (isBrowserDisconnect ? 'Browser closed by user' : 'Suite cancelled') : 'Suite process closed',
                { status: worstStatus, finalStatus: worstStatus, processStatus: status, duration },
              )

              releaseMobileAppiumLease(runId, 'suite-process-close')
              jobQueue.onSlotFreed(runId)
              return
            }

            // Check for retry child runs and classify accordingly
            const childRuns = db.getRunsByParent(runId)
            if (childRuns.length > 0) {
              const incompleteChildStatus = dbStatus === 'cancelled' ? 'cancelled' : 'failed'
              const incompleteChildSummary = incompleteChildStatus === 'cancelled'
                ? 'Retry cancelled'
                : failureSummary ?? 'Retry process terminated'
              for (const child of childRuns) {
                if (child.status === 'running' || child.status === 'pending') {
                  db.updateRun(child.id, {
                    status: incompleteChildStatus,
                    endedAt: new Date().toISOString(),
                    failureSummary: incompleteChildSummary,
                  })
                  finalizeRunArtifactBestEffort(
                    child.id,
                    'retry-process-close',
                    'process-close',
                    incompleteChildSummary,
                    { status: incompleteChildStatus, finalStatus: incompleteChildStatus, processStatus: status },
                  )
                }
              }

              const updatedChildRuns = db.getRunsByParent(runId)
              const anyPassed = updatedChildRuns.some(r => r.status === 'passed')
              const firstPassed = updatedChildRuns[0]?.status === 'passed'
              if (anyPassed && !firstPassed) {
                dbStatus = 'flaky'
              } else if (anyPassed && firstPassed) {
                dbStatus = 'passed'
              } else if (dbStatus === 'cancelled' || updatedChildRuns.some(r => r.status === 'cancelled')) {
                dbStatus = 'cancelled'
              } else {
                dbStatus = 'failed'
              }
              const lastChild = updatedChildRuns[updatedChildRuns.length - 1]
              db.updateRun(runId, {
                status: dbStatus,
                duration,
                endedAt: new Date().toISOString(),
                failureSummary: dbStatus === 'failed' ? 'All retry attempts failed'
                  : dbStatus === 'cancelled' ? 'Retry cancelled'
                  : undefined,
              })
              finalizeRunArtifactBestEffort(
                runId,
                'retry-process-close',
                'process-close',
                dbStatus === 'failed' ? 'All retry attempts failed'
                  : dbStatus === 'cancelled' ? 'Retry cancelled'
                  : 'Retry process closed',
                { status: dbStatus, finalStatus: dbStatus, processStatus: status, duration },
              )
              db.updateRunRetryInfo(runId, {
                retryCount: updatedChildRuns.length,
                maxRetries: lastChild?.maxRetries ?? run.maxRetries,
              })
              releaseMobileAppiumLease(runId, 'retry-process-close')
              jobQueue.onSlotFreed(runId)
              return
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
              isBrowserDisconnect ? 'browser-disconnect' : 'process-close',
              'process-close',
              failureSummary ?? 'Process closed',
              { status: dbStatus, finalStatus: dbStatus, processStatus: status, duration },
            )
          }
        } catch { /* best-effort */ }

        releaseMobileAppiumLease(runId, status)
        jobQueue.onSlotFreed(runId)
      },
    })
  }

  // Clean up orphaned runs from previous server sessions — any run still
  // marked 'running' in the DB has no live process and should be failed.
  // Suite parents with active children are skipped (CLI process may still be running).
  const orphaned = db.getRuns({ status: 'running' })
  let cleaned = 0
  for (const run of orphaned) {
    if (run.suiteId && !run.parentRunId) {
      const children = db.getRunsByParent(run.id)
      if (children.some(c => c.status === 'running')) {
        continue
      }
    }
    const duration = run.startedAt
      ? Date.now() - new Date(run.startedAt).getTime()
      : 0
    db.updateRun(run.id, {
      status: 'failed',
      duration,
      endedAt: new Date().toISOString(),
      failureSummary: 'Process terminated unexpectedly (server restarted)',
    })
    finalizeRunArtifactBestEffort(run.id, 'server-restart', 'startup-cleanup', 'Process terminated unexpectedly (server restarted)', { status: 'failed', duration })
    cleaned++
  }
  if (cleaned > 0) {
    console.log(`Cleaned up ${cleaned} orphaned run(s) stuck in 'running' state`)
  }

  // Log any pending rows left from previous session (benign — picked up when queue starts)
  const pendingOrphans = db.getRuns({ status: 'pending' })
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

  // Persistent job queue — all triggers route through this
  const jobQueue = new JobQueue({ db, concurrency })
  console.log(`Job queue started with ${concurrency} concurrency slot(s)`)
  console.log('Appium lifecycle manager initialized (auto-start on first mobile test)')

  // Wire JobQueue 'execute' event to TestRunner
  jobQueue.on('execute', async (run) => {
    if (!testRunner) return

    const platform = run.platform ?? 'web'
    const isMobile = platform === 'ios' || platform === 'android'

    // Ensure Appium is running before mobile test execution
    if (isMobile) {
      try {
        await appiumManager.acquireLease({ runId: run.id, platform })
        mobileRuns.set(run.id, platform)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`Failed to start Appium for run ${run.id}: ${message}`)
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
    testRunner.execute({
      runId: run.id,
      args,
      source: meta.isSuite ? 'suite' : 'dashboard',
      attributes: run.attributes,
      timeout: meta.timeout as number | undefined,
      maxRetries: run.maxRetries,
      env: isMobile ? { AGENT_QA_APPIUM_URL: appiumManager.getUrl() } : undefined,
    })
  })

  // Wire cancellation — running jobs need process kill via TestRunner
  jobQueue.on('cancel-running', (runId: string) => {
    testRunner?.kill(runId)
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
  })

  const apiRouter = createRouter({
    db,
    artifactsDir,
    workspacePaths,
    testRunner,
    jobQueue,
    testFileManager,
    suiteFileManager,
    configManager,
    configPath: resolvedConfigPath,
    llmConfig,
    authFetch,
    sessionManager,
  })

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname

    // API routes
    if (path.startsWith('/api/')) {
      apiRouter(req, res)
      return
    }

    // OPTIONS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      })
      res.end()
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
            'Access-Control-Allow-Origin': '*',
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
          'Access-Control-Allow-Origin': '*',
        })
        res.end(content)
        return
      } catch {
        // No index.html available
      }
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not Found')
  })

  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname === '/api/live-editor/ws') {
      const sessionId = url.searchParams.get('sessionId')
      if (!sessionId) {
        socket.destroy()
        return
      }
      const session = sessionManager.getSession(sessionId)
      if (!session) {
        socket.destroy()
        return
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        session.clearIdleTimer()
        const handler = createSessionHandler(session, () => {
          sessionManager.terminateSession(sessionId)
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

  const configuredMcp = (mcp ?? (config as any).services?.mcp ?? {}) as LocalMcpEndpointConfig
  const effectiveMcpConfig = configuredMcp.port === undefined && port === 0
    ? { ...configuredMcp, port: 0 }
    : configuredMcp
  const resolvedMcp = resolveLocalMcpEndpoint(effectiveMcpConfig)
  let mcpHttpServer: Server | undefined
  let mcpInfo: McpStartupInfo
  const captureMcpLifecycle = async (
    properties: {
      mcp_server_state: 'started' | 'disabled'
      mcp_transport: LocalMcpTransport
      mcp_host_kind?: 'loopback' | 'other'
      mcp_port_kind?: 'default' | 'custom'
      mcp_path_kind?: 'default' | 'custom'
    },
  ): Promise<void> => {
    if (isAnalyticsPrivacyEnabled(config)) return

    try {
      const standardProperties = await resolveAnalyticsStandardProperties({ surface: 'dashboard-server' })
      await captureAnalytics(buildAnalyticsEvent({
        name: 'agent-qa.mcp.server.lifecycle',
        properties: {
          ...standardProperties,
          surface: 'dashboard-server',
          ...properties,
        },
      }), { config }).catch(() => {})
    } catch {
      // Dashboard MCP lifecycle analytics must not alter startup behavior.
    }
  }
  const cleanupRuntimeResources = () => {
    jobQueue.stop()
    if (testRunner) {
      testRunner.killAll()
    }
    releaseAllMobileAppiumLeases('server-startup-error')
    appiumManager.shutdown()
    sessionManager.cleanupAll()
    db.close()
  }

  if (!resolvedMcp.enabled) {
    mcpInfo = {
      enabled: false,
      transport: resolvedMcp.transport,
    }
    await captureMcpLifecycle({
      mcp_server_state: 'disabled',
      mcp_transport: resolvedMcp.transport,
    })
    console.log('MCP disabled by services.mcp.enabled: false')
  } else if (resolvedMcp.transport === 'stdio') {
    mcpInfo = {
      enabled: false,
      transport: 'stdio',
    }
    console.log('MCP stdio transport selected; start editor MCP with `agent-qa mcp`')
  } else {
    let mcpHttpHandler = createLocalMcpHttpHandler({
      endpoint: resolvedMcp,
      dashboardUrl: `http://localhost:${port}`,
      configPath: resolvedConfigPath,
      analyticsConfig: config,
    })
    mcpHttpServer = createServer((req, res) => {
      void mcpHttpHandler(req, res)
    })

    try {
      await new Promise<void>((resolveMcp, rejectMcp) => {
        const onError = (err: Error) => {
          rejectMcp(err)
        }
        mcpHttpServer!.once('error', onError)
        mcpHttpServer!.listen(resolvedMcp.port, resolvedMcp.host, () => {
          mcpHttpServer!.off('error', onError)
          resolveMcp()
        })
      })
    } catch (err) {
      mcpHttpServer.close()
      cleanupRuntimeResources()
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`Failed to start MCP endpoint at ${resolvedMcp.url}: ${message}`)
    }

    const mcpAddress = mcpHttpServer.address()
    const actualMcpPort = typeof mcpAddress === 'object' && mcpAddress
      ? mcpAddress.port
      : resolvedMcp.port
    const actualMcp = resolveLocalMcpEndpoint({
      ...resolvedMcp,
      port: actualMcpPort,
    })
    if (actualMcpPort !== resolvedMcp.port) {
      mcpHttpHandler = createLocalMcpHttpHandler({
        endpoint: actualMcp,
        dashboardUrl: `http://localhost:${port}`,
        configPath: resolvedConfigPath,
        analyticsConfig: config,
      })
    }

    mcpInfo = {
      enabled: true,
      transport: 'http',
      host: actualMcp.host,
      port: actualMcp.port,
      path: actualMcp.path,
      url: actualMcp.url,
    }
    await captureMcpLifecycle({
      mcp_server_state: 'started',
      mcp_transport: 'http',
      ...resolveMcpEndpointShape(actualMcp),
    })
    console.log(`MCP running locally at ${actualMcp.url} (Streamable HTTP, loopback only)`)
  }

  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      mcpHttpServer?.close()
      cleanupRuntimeResources()
      reject(err)
    }
    server.once('error', onError)
    server.listen(port, () => {
      server.off('error', onError)
      console.log(`Dashboard running at http://localhost:${port}`)
      resolve({
        server,
        port,
        mcp: mcpInfo,
        close: () => {
          jobQueue.stop()
          if (testRunner) {
            testRunner.killAll()
          }
          releaseAllMobileAppiumLeases('server-close')
          appiumManager.shutdown()
          sessionManager.cleanupAll()
          mcpHttpServer?.close()
          server.close()
          db.close()
        },
      })
    })
  })
}
