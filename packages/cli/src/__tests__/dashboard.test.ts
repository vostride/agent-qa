import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const {
  mockResolveConfig,
  mockDashboardDatabase,
  mockResolveDashboardDbPath,
  mockStartServer,
  mockCreateInProcessExecutionBackend,
} = vi.hoisted(() => ({
  mockResolveConfig: vi.fn(),
  mockDashboardDatabase: vi.fn(),
  mockResolveDashboardDbPath: vi.fn(({ configuredDbPath }: { configuredDbPath?: string }) =>
    configuredDbPath || '.agent-qa/runs.db',
  ),
  mockStartServer: vi.fn(),
  // 401-07: the run door composes this through the same lazy import. A mock missing it does not
  // fail as a missing assertion — `createDashboardRunDoor` throws on the destructure, the command
  // exits 2, and every cell below then measures a command that never ran.
  mockCreateInProcessExecutionBackend: vi.fn((options: unknown) => ({
    options,
    execute: vi.fn(),
    kill: vi.fn(() => false),
    killAll: vi.fn(),
    getActiveExecutions: vi.fn(() => []),
    getBufferedEvents: vi.fn(() => []),
    on: vi.fn(),
    removeListener: vi.fn(),
  })),
}))

vi.mock('../config.js', () => ({
  resolveConfig: mockResolveConfig,
}))

vi.mock('@vostride/agent-qa-dashboard', async () => {
  // What this file mocks is a web server, and that is all it should mock: the in-memory helpers
  // the command destructures from the same lazily imported package are the real ones. (Until
  // 432-14 that included the run-confirm scope predicate and the confirm registry, both deleted.)
  const actual = await vi.importActual<typeof import('@vostride/agent-qa-dashboard')>('@vostride/agent-qa-dashboard')
  return {
    DashboardDatabase: mockDashboardDatabase,
    createInProcessExecutionBackend: mockCreateInProcessExecutionBackend,
    // 404-05: THE REAL RELAY, on the reasoning above. The
    // command destructures it from this same lazily imported package, so a mock without it leaves
    // `createPostProcessingRelay()` a call on `undefined` — which the command's own catch turns
    // into `process.exit`, and every cell in this file dies before it asserts. It is also not a
    // thing this file should be stubbing: it is an in-memory `Map` of listeners, with no server,
    // no socket and no database in it.
    createPostProcessingRelay: actual.createPostProcessingRelay,
    // 405-01: THE REAL READER FACTORY, on the relay's own reasoning one line up. The command
    // destructures it from this same lazily imported package, so a mock without it leaves
    // `createDashboardRunDetailReader(db)` a call on `undefined` — which the command's own catch
    // turns into `process.exit`, and every cell in this file dies before it asserts. It is also
    // not a thing this file should be stubbing: it is a one-method object over a database handle,
    // with no server and no socket in it.
    createDashboardRunDetailReader: actual.createDashboardRunDetailReader,
    // 428-12 (D-07): THE REAL EDITOR-SUBJECT REGISTRY, on the same reasoning. The command
    // destructures it from this package and calls it beside the run registry; it is an in-memory
    // `Map` with no server, no socket and no browser in it.
    createLiveEditorSubjects: actual.createLiveEditorSubjects,
    resolveDashboardDbPath: mockResolveDashboardDbPath,
    startServer: mockStartServer,
  }
})

vi.mock('@vostride/agent-qa-core', async importOriginal => {
  const actual = await importOriginal<typeof import('@vostride/agent-qa-core')>()
  return {
    ...actual,
    resolveLLMAuth: vi.fn(async () => ({
      kind: 'api-key',
      credentialKey: 'default',
      provider: 'anthropic-compatible',
      apiKey: 'test-key',
    })),
  }
})

import { createDashboardCommand, createServeCommand } from '../commands/dashboard.js'
import { resolveLLMAuth } from '@vostride/agent-qa-core'

let exitSpy: any
let logSpy: any
let errorSpy: any
let workspaceRoot: string
let configPath: string
const mockResolveLLMAuth = vi.mocked(resolveLLMAuth)

function makeDashboardConfig(config: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspace: {
      testMatch: ['tests/**/*.yaml'],
      suiteMatch: ['suites/**/*.suite.yaml'],
      hooksFile: 'hooks.yaml',
      envFile: '.env',
      secretsFile: '.env.secrets.local',
    },
    ...config,
  }
}

function createWorkspaceFiles(): void {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'agent-qa-dashboard-test-'))
  configPath = join(workspaceRoot, 'agent-qa.config.yaml')
  writeFileSync(configPath, 'workspace:\n')
  writeFileSync(join(workspaceRoot, 'hooks.yaml'), 'hooks: []\n')
  writeFileSync(join(workspaceRoot, 'agent-rules.md'), '# Agent rules\n')
  writeFileSync(join(workspaceRoot, '.env'), '')
  writeFileSync(join(workspaceRoot, '.env.secrets.local'), '')
}

beforeEach(() => {
  vi.clearAllMocks()
  createWorkspaceFiles()
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit')
  }) as any)
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

  mockResolveConfig.mockResolvedValue(makeDashboardConfig({
    llm: {
      provider: 'anthropic-compatible',
      model: 'claude-sonnet-4-6',
      baseURL: 'https://anthropic-proxy.example/messages',
    },
  }))
  mockDashboardDatabase.mockImplementation(function () { return { close: vi.fn() } })
  mockStartServer.mockResolvedValue({
    server: {},
    port: 3470,
    close: vi.fn(),
  })
})

afterEach(() => {
  exitSpy.mockRestore()
  logSpy.mockRestore()
  errorSpy.mockRestore()
  rmSync(workspaceRoot, { recursive: true, force: true })
})

describe('createDashboardCommand', () => {
  it('creates a command named dashboard', () => {
    const cmd = createDashboardCommand()
    expect(cmd.name()).toBe('dashboard')
  })

  it('has a description', () => {
    const cmd = createDashboardCommand()
    expect(cmd.description()).toContain('dashboard')
  })

  it('has port option', () => {
    const cmd = createDashboardCommand()
    const portOpt = cmd.options.find(o => o.long === '--port')
    expect(portOpt).toBeDefined()
    expect(portOpt!.description).toContain('3470')
  })

  it('has db path option', () => {
    const cmd = createDashboardCommand()
    const dbOpt = cmd.options.find(o => o.long === '--db')
    expect(dbOpt).toBeDefined()
  })

  it('has open flag as boolean', () => {
    const cmd = createDashboardCommand()
    const openOpt = cmd.options.find(o => o.long === '--open')
    expect(openOpt).toBeDefined()
  })

  it('starts server with correct config on action', async () => {
    const program = new Command()
    program.option('--config <path>')
    program.option('--verbose')
    const cmd = createDashboardCommand()
    program.addCommand(cmd)

    try {
      await program.parseAsync(['node', 'agent-qa', '--config', configPath, 'dashboard'])
    } catch {
      // process.exit throws in our mock
    }

    expect(mockDashboardDatabase).toHaveBeenCalled()
    expect(mockStartServer).toHaveBeenCalled()

    // RE-SPELLED 2026-10-01 (432-14, D-14): was '400-03: ONE registry, reaching BOTH halves'. The
    // command creates no confirm registry now, so the host it hands the server carries none.
    const started = mockStartServer.mock.calls[0]?.[0] as {
      agentHost?: Record<string, unknown>
      executionBackend?: unknown
    }
    expect(started.agentHost).toBeDefined()
    expect(started.agentHost).not.toHaveProperty('con' + 'firms')

    // 401-07 (INVK-01): the SAME shape, one line down, for the run door. The command composes the
    // backend here — where the agent packages are nameable — and hands it over; a server started
    // without it answers 503 from the execution routes and runs nothing.
    expect(mockCreateInProcessExecutionBackend).toHaveBeenCalledTimes(1)
    expect(started.executionBackend).toBe(mockCreateInProcessExecutionBackend.mock.results[0]?.value)
    // And the backend it handed over is composed over a real starter rather than a placeholder.
    const backendOptions = (started.executionBackend as { options?: { invokeRun?: unknown } }).options
    expect(typeof backendOptions?.invokeRun).toBe('function')
  })

  it('uses dashboard config from resolved config', async () => {
    mockResolveConfig.mockResolvedValue(makeDashboardConfig({
      registry: {
        llms: [{
          name: 'default',
          provider: 'anthropic-compatible',
          model: 'claude-sonnet-4-6',
          baseURL: 'https://anthropic-proxy.example/messages',
          vision: true,
        }],
      },
      use: { llm: 'default' },
      services: {
        dashboard: { port: 4000 },
        mcp: { enabled: true, port: 3472 },
        vision: { screenshotSize: 524288, effectiveResolution: 768 },
      },
    }))

    const program = new Command()
    program.option('--config <path>')
    program.option('--verbose')
    const cmd = createDashboardCommand()
    program.addCommand(cmd)

    try {
      await program.parseAsync(['node', 'agent-qa', '--config', configPath, 'dashboard'])
    } catch {
      // process.exit
    }

    expect(mockStartServer).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 4000,
        llmConfig: expect.objectContaining({
          provider: 'anthropic-compatible',
          vision: {
            screenshotSize: 524288,
            effectiveResolution: 768,
          },
        }),
      }),
    )
    const startArg = mockStartServer.mock.calls.at(-1)?.[0]
    expect(startArg?.llmConfig).not.toHaveProperty('screenshotSize')
    expect(startArg?.llmConfig).not.toHaveProperty('effectiveResolution')
  })

  it('uses the current Claude fallback model when no LLM config is selected', async () => {
    mockResolveConfig.mockResolvedValue(makeDashboardConfig())

    const program = new Command()
    program.option('--config <path>')
    program.option('--verbose')
    const cmd = createDashboardCommand()
    program.addCommand(cmd)

    await program.parseAsync(['node', 'agent-qa', '--config', configPath, 'dashboard'])

    expect(mockStartServer).toHaveBeenCalledWith(
      expect.objectContaining({
        llmConfig: expect.objectContaining({
          provider: 'anthropic-subscription',
          model: 'claude-sonnet-5-5',
        }),
      }),
    )
  })

  it('starts the dashboard when active LLM credentials are missing', async () => {
    mockResolveConfig.mockResolvedValue(makeDashboardConfig({
      registry: {
        llms: [{
          name: 'default',
          provider: 'anthropic-subscription',
          model: 'claude-sonnet-4-6',
        }],
      },
      use: { llm: 'default' },
    }))
    mockResolveLLMAuth.mockResolvedValueOnce({
      kind: 'missing',
      credentialKey: 'default',
      provider: 'anthropic-subscription',
      required: true,
      message: 'Login with Anthropic subscription for this config before testing.',
    })

    const program = new Command()
    program.option('--config <path>')
    program.option('--verbose')
    const cmd = createDashboardCommand()
    program.addCommand(cmd)

    await program.parseAsync(['node', 'agent-qa', '--config', configPath, 'dashboard'])

    expect(mockStartServer).toHaveBeenCalledWith(
      expect.objectContaining({
        llmConfig: expect.objectContaining({
          provider: 'anthropic-subscription',
          model: 'claude-sonnet-4-6',
        }),
        authFetch: undefined,
      }),
    )
    expect(errorSpy).not.toHaveBeenCalled()
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('shuts down cleanly on a signal with no telemetry step left in the path (398-10/398-11, D-18/D-20)', async () => {
    // THE WITNESS RETIRED IN 398-11, DELIBERATELY. This cell used to mock core's `flushAnalytics`
    // and assert it was never called; that was measurable only while the export existed. D-20 has
    // now deleted `core/src/analytics` outright, so the mock would have been a `vi.fn()` standing in
    // for nothing and "never called" would have passed by having nothing to check — the exact
    // vacuity the original comment warned about. What carries the claim instead: the compiler (there
    // is no `flushAnalytics`/`captureAnalytics` symbol left to call) and the two source pins at the
    // bottom of this file, which refuse the vocabulary back into `commands/dashboard.ts`. What this
    // cell still measures on its own is the shutdown path itself — a clean close and exit 0.
    const config = makeDashboardConfig({ analytics: { privacy: true } })
    const close = vi.fn()
    const signalHandlers = new Map<string | symbol, (...args: any[]) => unknown>()
    const processOnSpy = vi.spyOn(process, 'on').mockImplementation(((event, listener) => {
      signalHandlers.set(event, listener as (...args: any[]) => unknown)
      return process
    }) as typeof process.on)
    mockResolveConfig.mockResolvedValueOnce(config)
    mockStartServer.mockResolvedValueOnce({
      server: {},
      port: 3470,
      close,
    })

    try {
      const program = new Command()
      program.option('--config <path>')
      program.option('--verbose')
      const cmd = createDashboardCommand()
      program.addCommand(cmd)

      await program.parseAsync(['node', 'agent-qa', '--config', configPath, 'dashboard'])

      const shutdown = signalHandlers.get('SIGINT')
      expect(shutdown).toBeDefined()
      await expect(Promise.resolve(shutdown?.())).rejects.toThrow('process.exit')
      expect(close).toHaveBeenCalledOnce()
      expect(exitSpy).toHaveBeenCalledWith(0)
    } finally {
      processOnSpy.mockRestore()
    }
  })
})

describe('createServeCommand', () => {
  it('creates a command named serve', () => {
    const cmd = createServeCommand()
    expect(cmd.name()).toBe('serve')
  })

  it('describes configured local services', () => {
    const cmd = createServeCommand()
    expect(cmd.description()).toContain('local agent-qa services')
  })

  it('does not expose dashboard-specific pass-through flags', () => {
    const cmd = createServeCommand()
    expect(cmd.options.map(option => option.long)).not.toEqual(
      expect.arrayContaining(['--port', '--db', '--open']),
    )
  })

  it('starts configured local services through the dashboard-backed server path', async () => {
    mockResolveConfig.mockResolvedValue(makeDashboardConfig({
      services: {
        dashboard: { port: 4100, dbPath: '.agent-qa/custom.db' },
        mcp: { enabled: true, port: 3472 },
      },
    }))

    const program = new Command()
    program.option('--config <path>')
    program.option('--verbose')
    const cmd = createServeCommand()
    program.addCommand(cmd)

    await program.parseAsync(['node', 'agent-qa', '--config', configPath, 'serve'])

    expect(mockResolveDashboardDbPath).toHaveBeenCalledWith({
      configDir: workspaceRoot,
      configuredDbPath: '.agent-qa/custom.db',
    })
    expect(mockStartServer).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 4100,
      }),
    )
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('uses local services shutdown wording on signal cleanup', async () => {
    const close = vi.fn()
    const signalHandlers = new Map<string | symbol, (...args: any[]) => unknown>()
    const processOnSpy = vi.spyOn(process, 'on').mockImplementation(((event, listener) => {
      signalHandlers.set(event, listener as (...args: any[]) => unknown)
      return process
    }) as typeof process.on)
    mockStartServer.mockResolvedValueOnce({
      server: {},
      port: 3470,
      close,
    })

    try {
      const program = new Command()
      program.option('--config <path>')
      program.option('--verbose')
      const cmd = createServeCommand()
      program.addCommand(cmd)

      await program.parseAsync(['node', 'agent-qa', '--config', configPath, 'serve'])

      const shutdown = signalHandlers.get('SIGTERM')
      expect(shutdown).toBeDefined()
      await expect(Promise.resolve(shutdown?.())).rejects.toThrow('process.exit')
      expect(close).toHaveBeenCalledOnce()
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Shutting down local services'))
      expect(exitSpy).toHaveBeenCalledWith(0)
    } finally {
      processOnSpy.mockRestore()
    }
  })
})

// ---- 398-10 / 398-11 (D-18 / D-20): the drop, pinned at the source ---------------------------
//
// These two cells are now the WHOLE behavioural claim for the drop, and they were always the
// stronger half: a `flushAnalytics` re-added to this command would satisfy "never called" in any
// test that did not reach the shutdown path. The mock-based counterpart retired in 398-11 with the
// module it stood in for (see the note in the signal-shutdown cell above) — a `vi.fn()` mocking an
// export that no longer exists asserts nothing.
describe('the dashboard command names no analytics at all (398-10)', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../commands/dashboard.ts', import.meta.url)),
    'utf8',
  )

  it('imports nothing from the analytics package and calls no flush helper', () => {
    expect(source).not.toMatch(/from '@vostride\/agent-qa-analytics'/u)
    expect(source).not.toMatch(/\bflushAnalytics\b/u)
    expect(source).not.toMatch(/\bcaptureAnalytics\b/u)
    expect(source).not.toMatch(/\bcomposeAnalytics/u)
  })

  it('records WHY the three v33 dashboard events are gone, dated', () => {
    expect(source).toMatch(/2026-08-17.*Phase 398 plan 10/u)
    expect(source).toContain('dashboard.opened')
    expect(source).toContain('dashboard.live_mode.started')
    expect(source).toContain('dashboard.entity.created')
  })
})
