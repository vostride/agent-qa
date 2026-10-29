// The listener reads no `Authorization` header, and a declared token block fails the strict parser.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createFunctionRegistry } from '@vostride/agent-qa-agent'
import type { FunctionDeps } from '@vostride/agent-qa-agent'
import * as schemaApi from '@vostride/agent-qa-schema'
import { AgentQaConfigSchema } from '@vostride/agent-qa-core'
import { afterEach, describe, expect, it } from 'vitest'

import * as mcpCommand from '../commands/mcp.js'
import { composeMcpMasking, createMcpHttpRequestListener, MCP_FUNCTION_CALLER } from '../commands/mcp.js'

/** The value that must never appear in any message, header or body this suite can reach. */
const PLANTED = 'zz-396-05-planted-credential-4f1c9a'
const PLANTED_VAR = 'AGENT_QA_396_MCP_CRED'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})

describe('the MCP bearer resolver is deleted, not bypassed', () => {
  it('the resolver module is gone and no CLI source imports it', () => {
    expect(existsSync(join(SRC, 'composition', 'mcp-token-resolution.ts'))).toBe(false)
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) { if (entry.name !== '__tests__') walk(path) }
        else if (entry.name.endsWith('.ts') && readFileSync(path, 'utf8').includes("mcp-token-resolution.js'")) {
          offenders.push(path)
        }
      }
    }
    walk(SRC)
    expect(offenders).toEqual([])
  })

  it('the command exports one tokenless caller and no grant, credential or sentinel', () => {
    for (const retired of ['MCP_DEFAULT_GRANTED_SCOPES', 'mcpFunctionCaller', 'MCP_AUTH_TOKEN_SENTINEL']) {
      expect(retired in mcpCommand, retired).toBe(false)
    }
    expect(MCP_FUNCTION_CALLER).toEqual({ surface: 'mcp', origin: 'agent' })
    expect(Object.isFrozen(MCP_FUNCTION_CALLER)).toBe(true)
  })
})

describe('every caller the composition roots mint is attribution only', () => {
  it('the MCP, run-service, daemon, CLI and dashboard mints carry exactly surface and origin', async () => {
    const { RUN_SERVICE_FUNCTION_CALLER, DASHBOARD_FUNCTION_CALLER } = await import('../commands/dashboard.js')
    const { DAEMON_FUNCTION_CALLER } = await import('../daemon/server.js')
    const { CLI_FUNCTION_CALLER } = await import('../composition/local-agent-host.js')
    const mints = {
      mcp: MCP_FUNCTION_CALLER,
      'run-service': RUN_SERVICE_FUNCTION_CALLER,
      daemon: DAEMON_FUNCTION_CALLER,
      cli: CLI_FUNCTION_CALLER,
      dashboard: DASHBOARD_FUNCTION_CALLER,
    }
    for (const [name, caller] of Object.entries(mints)) {
      expect(Object.keys(caller).sort(), name).toEqual(['origin', 'surface'])
    }
    expect(Object.values(mints).map((caller) => caller.surface).sort())
      .toEqual(['cli', 'daemon', 'dashboard', 'mcp', 'run-service'])
  })
})

describe('the listener reads no Authorization header', () => {
  async function listener(): Promise<URL> {
    const registry = createFunctionRegistry({
      deps: {} as unknown as FunctionDeps,
    })
    const root = mkdtempSync(join(tmpdir(), 'agent-qa-441-07-tokenless-'))
    cleanups.push(async () => rmSync(root, { recursive: true, force: true }))
    const configPath = join(root, 'agent-qa.config.yaml')
    writeFileSync(configPath, JSON.stringify(AgentQaConfigSchema.parse({
      workspace: {
        testMatch: ['tests/**/*.yaml'], suiteMatch: ['suites/**/*.suite.yaml'],
        hooksFile: 'hooks.yaml', envFile: '.env', secretsFile: '.env.secrets.local',
      },
      use: { mobile: { appState: 'preserve' } },
    })))
    writeFileSync(join(root, '.env.secrets.local'), '')
    const mask = composeMcpMasking({ configPath })
    const server: Server = createServer(createMcpHttpRequestListener({ registry, maskText: (text) => mask.mask(text) }))
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
    cleanups.push(() => new Promise<void>((closed) => server.close(() => closed())))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    return new URL(`http://127.0.0.1:${String(address.port)}/mcp`)
  }

  async function namesWith(url: URL, authorization: string | undefined, frames: string[]): Promise<string[]> {
    const client = new Client({ name: 'agent-qa-432-21-tokenless', version: '0.0.0' })
    cleanups.push(() => client.close())
    await client.connect(new StreamableHTTPClientTransport(url, {
      fetch: (async (input: URL | string, init?: RequestInit) => {
        const headers = new Headers(init?.headers)
        if (authorization !== undefined) headers.set('authorization', authorization)
        const response = await fetch(input, { ...init, headers })
        frames.push(await response.clone().text())
        return response
      }) as typeof fetch,
    }))
    return (await client.listTools()).tools.map((tool) => tool.name).sort()
  }

  it('absent, malformed and unmatched bearers list the identical catalogue', async () => {
    const url = await listener()
    const frames: string[] = []
    const absent = await namesWith(url, undefined, frames)
    expect(absent.length).toBeGreaterThan(0)
    expect(await namesWith(url, 'Basic not-a-bearer', frames)).toEqual(absent)
    expect(await namesWith(url, `Bearer ${PLANTED}`, frames)).toEqual(absent)
    const wire = frames.join('\n')
    expect(wire).not.toContain('invalid_token')
    expect(wire).not.toContain(PLANTED)
  })
})

// A token value reaches nothing, because no token block parses.
describe('services.mcp declares no token or stdio grant', () => {
  const base = {
    workspace: {
      testMatch: ['tests/**/*.yaml'],
      testPathIgnore: [],
      suiteMatch: ['suites/**/*.suite.yaml'],
      hooksFile: 'hooks.yaml',
      envFile: '.env',
      secretsFile: '.env.secrets.local',
    },
    use: { mobile: { appState: 'preserve' } },
  }

  it('the token entry and stdio grant vocabulary is gone from the schema package', () => {
    const names = Object.keys(schemaApi)
    expect(names.filter(name => /^McpTokenEntry|^McpStdioGrant/.test(name))).toEqual([])
  })

  it('an empty services.mcp block parses and materialises nothing', () => {
    const parsed = AgentQaConfigSchema.parse({ ...base, services: { mcp: {} } })
    expect(parsed.services?.mcp).toEqual({})
  })

  it('a declared token block or stdio grant is refused by name, never echoing a value', () => {
    for (const mcp of [
      { tokens: [{ name: 'ci', tokenEnvVar: PLANTED_VAR, scopes: ['read', 'config-write'] }] },
      { tokens: [{ name: 'ci', tokenEnvVar: PLANTED_VAR, token: PLANTED, scopes: ['read'] }] },
      { stdio: { grantConfigWrite: true } },
    ]) {
      const refused = AgentQaConfigSchema.safeParse({ ...base, services: { mcp } })
      expect(refused.success).toBe(false)
      if (refused.success) continue
      expect(refused.error.issues.map(issue => issue.code)).toEqual(['unrecognized_keys'])
      expect(refused.error.issues[0]!.path).toEqual(['services', 'mcp'])
      expect(JSON.stringify(refused.error.issues)).not.toContain(PLANTED)
    }
  })
})
