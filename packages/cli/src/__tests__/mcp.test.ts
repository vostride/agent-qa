import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

const { mockStartMcpServer, mockFlushAnalytics, mockResolveConfig } = vi.hoisted(() => ({
  mockStartMcpServer: vi.fn(),
  mockFlushAnalytics: vi.fn(),
  mockResolveConfig: vi.fn(),
}))

vi.mock('@vostride/agent-qa-mcp', () => ({
  startMcpServer: mockStartMcpServer,
}))

vi.mock('@vostride/agent-qa-core', () => ({
  flushAnalytics: mockFlushAnalytics,
}))

vi.mock('../config.js', () => ({
  resolveConfig: mockResolveConfig,
}))

import { createMcpCommand } from '../commands/mcp.js'

let errorSpy: ReturnType<typeof vi.spyOn>
let exitSpy: ReturnType<typeof vi.spyOn>
let originalExitCode: typeof process.exitCode

beforeEach(() => {
  vi.clearAllMocks()
  mockResolveConfig.mockResolvedValue({})
  mockFlushAnalytics.mockResolvedValue(undefined)
  originalExitCode = process.exitCode
  process.exitCode = undefined
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit')
  }) as any)
})

afterEach(() => {
  errorSpy.mockRestore()
  exitSpy.mockRestore()
  process.exitCode = originalExitCode
})

describe('createMcpCommand', () => {
  it('creates a command named mcp', () => {
    const cmd = createMcpCommand()
    expect(cmd.name()).toBe('mcp')
  })

  it('starts stdio MCP by default', async () => {
    const config = { analytics: { privacy: true } }
    mockResolveConfig.mockResolvedValueOnce(config)
    const program = new Command()
    program.addCommand(createMcpCommand())

    await program.parseAsync(['node', 'agent-qa', 'mcp'])

    expect(mockStartMcpServer).toHaveBeenCalledOnce()
    expect(mockStartMcpServer).toHaveBeenCalledWith({ analyticsConfig: config })
    expect(mockFlushAnalytics).toHaveBeenCalledWith({ config })
    expect(process.exitCode).toBeUndefined()
  })

  it('does not fail stdio MCP when analytics flush rejects', async () => {
    mockFlushAnalytics.mockRejectedValueOnce(new Error('phase245 analytics failure'))
    const program = new Command()
    program.addCommand(createMcpCommand())

    await program.parseAsync(['node', 'agent-qa', 'mcp'])

    expect(mockStartMcpServer).toHaveBeenCalledOnce()
    expect(mockFlushAnalytics).toHaveBeenCalledWith({ config: {} })
    expect(process.exitCode).toBeUndefined()
  })

  it('does not expose a transport selector', () => {
    expect(createMcpCommand().helpInformation()).not.toContain('--transport')
  })

  it('rejects removed transport selector as an unknown option', async () => {
    const program = new Command()
    const cmd = createMcpCommand()
    cmd.configureOutput({ writeErr: (message) => errorSpy(message.trimEnd()) })
    program.addCommand(cmd)

    try {
      await program.parseAsync(['node', 'agent-qa', 'mcp', '--transport', 'http'])
    } catch (err) {
      if ((err as Error).message !== 'process.exit') throw err
    }

    expect(mockStartMcpServer).not.toHaveBeenCalled()
    expect(mockResolveConfig).not.toHaveBeenCalled()
    expect(mockFlushAnalytics).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("unknown option '--transport'"))
    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})
