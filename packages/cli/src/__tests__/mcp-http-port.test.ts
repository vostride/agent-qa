import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import type { Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AnalyticsCapturePayload } from '@vostride/agent-qa-analytics'
import { Command } from 'commander'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  MCP_HTTP_BIND_HOST,
  MCP_HTTP_DEFAULT_PORT,
  createMcpCommand,
  httpPort,
} from '../commands/mcp.js'
import { composeAnalyticsHost } from '../composition/analytics-host.js'
import type { ComposeAnalyticsHostInput } from '../composition/analytics-host.js'

describe('agent-qa mcp --http port', () => {
  it('binds the default port when --http has no value', () => {
    expect(httpPort(true)).toBe(MCP_HTTP_DEFAULT_PORT)
  })

  it('binds the decimal port it is given, with 0 meaning any free port', () => {
    expect(httpPort('0')).toBe(0)
    expect(httpPort('4000')).toBe(4000)
    expect(httpPort('65535')).toBe(65535)
  })

  it.each([
    '0x1f90', '0abc', '-0', '-1', '00', '08080', '65536', '99999', '1e3', '+80', '80.0', ' 80',
    '80 ', '',
  ])(
    'refuses %j rather than binding some other port',
    (value) => {
      expect(() => httpPort(value)).toThrow(
        `--http expects a decimal port between 0 and 65535, received ${value}`,
      )
    },
  )
})

interface McpInvocation {
  readonly exitCode: number | string | undefined
  readonly stderr: string
  readonly composed: number
  readonly sent: readonly AnalyticsCapturePayload[]
}

function projectConfig(roots: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-qa-mcp-http-'))
  roots.push(dir)
  const configPath = join(dir, 'agent-qa.config.yaml')
  writeFileSync(
    configPath,
    `${JSON.stringify({
      workspace: {
        testMatch: ['tests/**/*.test.yaml'],
        suiteMatch: ['suites/**/*.suite.yaml'],
        hooksFile: 'hooks.yaml',
        envFile: '.env',
        secretsFile: '.env.secrets.local',
      },
    })}\n`,
    'utf8',
  )
  writeFileSync(join(dir, '.env.secrets.local'), '', 'utf8')
  return configPath
}

// Opted in, with a transport that records what would have been sent.
async function runMcpHttp(configPath: string, value: string): Promise<McpInvocation> {
  const sent: AnalyticsCapturePayload[] = []
  let composed = 0
  const composeAnalytics = async (input: ComposeAnalyticsHostInput) => {
    composed += 1
    return composeAnalyticsHost({
      ...input,
      env: {},
      transportOverride: {
        capture: (payload) => {
          sent.push(payload)
        },
        flush: () => {},
        shutdown: () => {},
      },
      resolveIdentity: async () => ({
        distinctId: 'u_mcp-http-cell',
        runtimeContext: 'user' as const,
      }),
    })
  }
  const stderr: string[] = []
  const error = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
    stderr.push(values.map(String).join(' '))
  })
  const previousExitCode = process.exitCode
  process.exitCode = undefined
  try {
    const program = new Command()
      .option('--config <path>', 'config file path')
      .addCommand(createMcpCommand({ composeAnalytics }))
    program.exitOverride()
    await program.parseAsync(['node', 'agent-qa', '--config', configPath, 'mcp', '--http', value])
    return { exitCode: process.exitCode, stderr: stderr.join('\n'), composed, sent }
  } finally {
    process.exitCode = previousExitCode
    error.mockRestore()
  }
}

function holdLoopbackPort(): Promise<{ server: Server; port: number }> {
  return new Promise((listening, failed) => {
    const server = createServer()
    server.once('error', failed)
    server.listen(0, MCP_HTTP_BIND_HOST, () => {
      const address = server.address()
      if (typeof address !== 'object' || address === null) {
        failed(new Error('the held socket reported no port'))
        return
      }
      listening({ server, port: address.port })
    })
  })
}

describe('agent-qa mcp --http refusals', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('refuses a non-decimal port before composing anything, and sends no event', async () => {
    const result = await runMcpHttp(projectConfig(roots), '0x1f90')

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('--http expects a decimal port between 0 and 65535')
    expect(result.composed).toBe(0)
    expect(result.sent).toEqual([])
  })

  it('sends no lifecycle event when the port is already taken', async () => {
    const held = await holdLoopbackPort()
    try {
      const result = await runMcpHttp(projectConfig(roots), String(held.port))

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('EADDRINUSE')
      expect(result.composed).toBe(1)
      expect(result.sent.map((payload) => payload.event.name)).not.toContain(
        'agent-qa.mcp.server.lifecycle',
      )
    } finally {
      await new Promise<void>((closed) => held.server.close(() => closed()))
    }
  })
})
