import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const {
  mockResolveConfig,
  mockDashboardDatabase,
  mockResolveDashboardDbPath,
  mockStartServer,
  mockFlushAnalytics,
} = vi.hoisted(() => ({
  mockResolveConfig: vi.fn(),
  mockDashboardDatabase: vi.fn(),
  mockResolveDashboardDbPath: vi.fn(({ configuredDbPath }: { configuredDbPath?: string }) =>
    configuredDbPath || '.agent-qa/runs.db',
  ),
  mockStartServer: vi.fn(),
  mockFlushAnalytics: vi.fn(),
}))

vi.mock('../config.js', () => ({
  resolveConfig: mockResolveConfig,
}))

vi.mock('@vostride/agent-qa-dashboard', () => ({
  DashboardDatabase: mockDashboardDatabase,
  resolveDashboardDbPath: mockResolveDashboardDbPath,
  startServer: mockStartServer,
}))

vi.mock('@vostride/agent-qa-core', async importOriginal => {
  const actual = await importOriginal<typeof import('@vostride/agent-qa-core')>()
  return {
    ...actual,
    flushAnalytics: mockFlushAnalytics,
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
      agentRules: 'agent-rules.md',
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
  mockFlushAnalytics.mockResolvedValue(undefined)
  mockStartServer.mockResolvedValue({
    server: {},
    port: 3470,
    mcp: { enabled: true, transport: 'http', url: 'http://127.0.0.1:3471/mcp' },
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
  })

  it('uses dashboard config from resolved config', async () => {
    mockResolveConfig.mockResolvedValue(makeDashboardConfig({
      registry: {
        llms: [{
          name: 'default',
          provider: 'anthropic-compatible',
          model: 'claude-sonnet-4-6',
          baseURL: 'https://anthropic-proxy.example/messages',
          screenshotSize: 1048576,
          effectiveResolution: 1568,
        }],
      },
      use: { llm: 'default' },
      services: {
        dashboard: { port: 4000 },
        mcp: { enabled: true, port: 3472, path: '/mcp' },
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
        mcp: { enabled: true, port: 3472, path: '/mcp' },
        llmConfig: expect.objectContaining({
          provider: 'anthropic-compatible',
          screenshotSize: 1048576,
          effectiveResolution: 1568,
        }),
      }),
    )
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
          model: 'claude-sonnet-4-6',
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

  it('flushes analytics best-effort during signal shutdown', async () => {
    const config = makeDashboardConfig({ analytics: { privacy: true } })
    const close = vi.fn()
    const signalHandlers = new Map<string | symbol, (...args: any[]) => unknown>()
    const processOnSpy = vi.spyOn(process, 'on').mockImplementation(((event, listener) => {
      signalHandlers.set(event, listener as (...args: any[]) => unknown)
      return process
    }) as typeof process.on)
    mockResolveConfig.mockResolvedValueOnce(config)
    mockFlushAnalytics.mockRejectedValueOnce(new Error('analytics flush failed'))
    mockStartServer.mockResolvedValueOnce({
      server: {},
      port: 3470,
      mcp: { enabled: true, transport: 'http', url: 'http://127.0.0.1:3471/mcp' },
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
      expect(mockFlushAnalytics).toHaveBeenCalledWith({ config })
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
        mcp: { enabled: true, port: 3472, path: '/mcp' },
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
        mcp: { enabled: true, port: 3472, path: '/mcp' },
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
      mcp: { enabled: true, transport: 'http', url: 'http://127.0.0.1:3471/mcp' },
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
      expect(mockFlushAnalytics).toHaveBeenCalled()
      expect(exitSpy).toHaveBeenCalledWith(0)
    } finally {
      processOnSpy.mockRestore()
    }
  })
})
