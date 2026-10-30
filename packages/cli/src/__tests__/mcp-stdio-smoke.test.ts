// A completed `tools/list` over the pipe proves stdout carried only protocol; build first.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { afterEach, describe, expect, it } from 'vitest'

import { MCP_STDIO_STARTUP_MESSAGE } from '../commands/mcp.js'

const CLI_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist/cli.js')

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// `legacyTokens` writes an old MCP credential block that nothing reads and the schema rejects.
function fixtureProject(legacyTokens = false): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-stdio-'))
  roots.push(root)
  writeFileSync(
    join(root, 'agent-qa.config.yaml'),
    `${JSON.stringify(
      {
        workspace: {
          testMatch: ['tests/**/*.yaml'],
          testPathIgnore: [],
          suiteMatch: ['suites/**/*.suite.yaml'],
          hooksFile: 'hooks.yaml',
          envFile: '.env',
          secretsFile: '.env.secrets.local',
        },
        ...(legacyTokens
          ? {
              services: {
                mcp: {
                  tokens: [{ name: 'legacy', tokenEnvVar: 'AGENT_QA_NEVER_SET_TOKEN', scopes: ['read'] }],
                  stdio: { grantConfigWrite: false },
                },
              },
            }
          : {}),
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  // The MCP masker reads this project's declared secrets.
  writeFileSync(join(root, '.env.secrets.local'), '')
  mkdirSync(join(root, '.agent-qa'), { recursive: true })
  return root
}

/** Spawn the built binary over stdio in `cwd`, list its tools, and return them with captured stderr. */
async function listOverStdio(cwd: string): Promise<{ names: string[]; stderr: () => string }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI_ENTRY, 'mcp'],
    cwd,
    stderr: 'pipe',
  })
  let captured = ''
  transport.stderr?.on('data', (chunk: Buffer | string) => {
    captured += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
  })
  const client = new Client({ name: 'agent-qa-stdio-legacy', version: '0.0.0' })
  try {
    await client.connect(transport)
    const names = (await client.listTools()).tools.map((entry) => entry.name).sort()
    return { names, stderr: () => captured }
  } finally {
    await client.close().catch(() => {})
    await transport.close().catch(() => {})
  }
}

describe('agent-qa mcp over spawned stdio', () => {
  it('completes a tools/list round trip and keeps its startup line off stdout', async () => {
    expect(
      existsSync(CLI_ENTRY),
      `the built CLI entry is missing at ${CLI_ENTRY}; run \`pnpm build\` first (see this file's header)`,
    ).toBe(true)

    const cwd = fixtureProject()
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_ENTRY, 'mcp'],
      cwd,
      stderr: 'pipe',
    })

    let captured = ''
    const stderr = transport.stderr
    stderr?.on('data', (chunk: Buffer | string) => {
      captured += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    })

    const client = new Client({ name: 'agent-qa-stdio-smoke', version: '0.0.0' })
    try {
      await client.connect(transport)
      const listed = await client.listTools()
      const names = listed.tools.map((entry) => entry.name)

      // The catalog reached a client that spawned the shipped binary.
      expect(names).toContain('agent_qa_list_runs')

      // A stdio caller with no switch set lists the config-write tool like every other.
      expect(names).toContain('agent_qa_change_config')
      expect(names).toContain('agent_qa_mark_run')

      // (c) The diagnostic exists and it is on STDERR. Together with the round trip above — which
      // could not have completed had anything else been written to stdout — this pins the channel
      // discipline from both sides.
      await expect
        .poll(() => captured, { timeout: 5_000 })
        .toContain(MCP_STDIO_STARTUP_MESSAGE)
    } finally {
      await client.close().catch(() => {})
      await transport.close().catch(() => {})
    }
  }, 30_000)

  // The legacy block is never read, and `agent-qa mcp`'s tolerant read serves despite it.
  it('a legacy token block with an unset variable refuses nothing and changes no listing', async () => {
    expect(existsSync(CLI_ENTRY), `the built CLI entry is missing at ${CLI_ENTRY}`).toBe(true)
    const plain = await listOverStdio(fixtureProject())
    const legacy = await listOverStdio(fixtureProject(true))
    expect(legacy.names).toEqual(plain.names)
    expect(legacy.names).toContain('agent_qa_change_config')
    expect(legacy.stderr()).not.toContain('AGENT_QA_NEVER_SET_TOKEN')
    expect(legacy.stderr()).not.toContain('Failed to start MCP server')
  }, 60_000)
})
