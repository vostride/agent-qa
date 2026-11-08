// The MCP entry the installer writes, run through npx from a subfolder, serves the project.

import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { getAgentQaVersion } from '@vostride/agent-qa-core'
import { afterEach, describe, expect, it } from 'vitest'

import { CODING_AGENT_MCP_ARGS, CODING_AGENT_MCP_COMMAND } from '../commands/mcp-entries.js'
import { payloadOf } from './mcp-tool-payload.js'

const CLI_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist/cli.js')

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function folder(...parts: string[]): string {
  const path = join(...parts)
  mkdirSync(path, { recursive: true })
  return path
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function writeProjectConfig(dir: string): void {
  writeJson(join(dir, 'agent-qa.config.yaml'), {
    workspace: {
      testMatch: ['tests/**/*.yaml'],
      testPathIgnore: [],
      suiteMatch: ['suites/**/*.suite.yaml'],
      hooksFile: 'hooks.yaml',
      envFile: '.env',
      secretsFile: '.env.secrets.local',
    },
  })
  writeFileSync(join(dir, '.env.secrets.local'), '')
}

function linkBuiltCli(root: string): void {
  symlinkSync(CLI_ENTRY, join(folder(root, 'node_modules', '.bin'), 'agent-qa'))
}

// Built from scratch so no pnpm or npm setting of the test run, and nothing in the real home or
// npm cache, reaches npx.
function npxEnv(): Record<string, string> {
  const scratch = tempDir('agent-qa-npx-')
  const home = folder(scratch, 'home')
  const cache = folder(scratch, 'npm-cache')
  const userconfig = join(scratch, 'npmrc')
  writeFileSync(userconfig, '')
  return {
    PATH: process.env.PATH ?? '',
    HOME: home,
    USERPROFILE: home,
    npm_config_cache: cache,
    npm_config_logs_dir: join(cache, 'logs'),
    npm_config_userconfig: userconfig,
    npm_config_offline: 'true',
    npm_config_update_notifier: 'false',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
  }
}

async function serveThroughNpx(cwd: string): Promise<{
  version: string | undefined
  tools: string[]
  status: unknown
  isError: unknown
  stderr: string
}> {
  const transport = new StdioClientTransport({
    command: CODING_AGENT_MCP_COMMAND,
    args: [...CODING_AGENT_MCP_ARGS],
    cwd,
    env: npxEnv(),
    stderr: 'pipe',
  })
  let stderr = ''
  transport.stderr?.on('data', (chunk: Buffer | string) => {
    stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
  })
  const client = new Client({ name: 'agent-qa-npx-entry', version: '0.0.0' })
  try {
    await client.connect(transport)
    const tools = (await client.listTools()).tools.map((tool) => tool.name)
    const result = await client.callTool({ name: 'agent_qa_list_runs', arguments: {} })
    return {
      version: client.getServerVersion()?.version,
      tools,
      status: payloadOf(result.structuredContent).status,
      isError: result.isError,
      stderr,
    }
  } finally {
    await client.close().catch(() => {})
    await transport.close().catch(() => {})
  }
}

describe('the installed MCP entry run through npx', () => {
  it('serves a plain project from a subfolder', async () => {
    expect(
      existsSync(CLI_ENTRY),
      `the built CLI entry is missing at ${CLI_ENTRY}; run \`pnpm build\` first`,
    ).toBe(true)
    const root = tempDir('agent-qa-npx-plain-')
    mkdirSync(join(root, '.git'))
    writeJson(join(root, 'package.json'), { name: 'probe', private: true })
    writeProjectConfig(root)
    linkBuiltCli(root)

    const served = await serveThroughNpx(folder(root, 'tests'))
    expect(served.version, served.stderr).toBe(getAgentQaVersion().trim())
    expect(served.tools).toContain('agent_qa_list_runs')
    expect(served.status, served.stderr).not.toBe('not_initialized')
    expect(served.status, served.stderr).not.toBe('config_invalid')
    expect(served.isError, served.stderr).toBeFalsy()
  }, 90_000)

  it('serves an npm workspace member from its subfolder', async () => {
    expect(
      existsSync(CLI_ENTRY),
      `the built CLI entry is missing at ${CLI_ENTRY}; run \`pnpm build\` first`,
    ).toBe(true)
    const root = tempDir('agent-qa-npx-workspace-')
    mkdirSync(join(root, '.git'))
    writeJson(join(root, 'package.json'), {
      name: 'workspace-probe',
      private: true,
      workspaces: ['packages/*'],
    })
    const app = folder(root, 'packages', 'app')
    writeJson(join(app, 'package.json'), { name: 'app', private: true })
    writeProjectConfig(app)
    linkBuiltCli(root)
    symlinkSync(join('..', 'packages', 'app'), join(root, 'node_modules', 'app'))

    const served = await serveThroughNpx(folder(app, 'tests'))
    expect(served.version, served.stderr).toBe(getAgentQaVersion().trim())
    expect(served.tools).toContain('agent_qa_list_runs')
    expect(served.status, served.stderr).not.toBe('not_initialized')
    expect(served.status, served.stderr).not.toBe('config_invalid')
    expect(served.isError, served.stderr).toBeFalsy()
  }, 90_000)
})
