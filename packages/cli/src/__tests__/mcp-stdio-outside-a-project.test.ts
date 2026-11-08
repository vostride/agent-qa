// The built `agent-qa mcp` outside a project lists its tools and answers each call with what to run.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/client'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { getAgentQaVersion } from '@vostride/agent-qa-core'
import { afterEach, describe, expect, it } from 'vitest'

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

function emptyRepository(): string {
  const root = tempDir('agent-qa-outside-')
  mkdirSync(join(root, '.git'))
  return root
}

function fixtureProject(): string {
  const root = tempDir('agent-qa-inside-')
  writeFileSync(
    join(root, 'agent-qa.config.yaml'),
    `${JSON.stringify({
      workspace: {
        testMatch: ['tests/**/*.yaml'],
        testPathIgnore: [],
        suiteMatch: ['suites/**/*.suite.yaml'],
        hooksFile: 'hooks.yaml',
        envFile: '.env',
        secretsFile: '.env.secrets.local',
      },
    }, null, 2)}\n`,
    'utf8',
  )
  writeFileSync(join(root, '.env.secrets.local'), '')
  mkdirSync(join(root, '.agent-qa'), { recursive: true })
  return root
}

function listing(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .sort()
}

interface Session {
  readonly client: Client
  readonly stderr: () => string
  close(): Promise<void>
}

async function connect(cwd: string, era: 'legacy' | 'auto'): Promise<Session> {
  const home = tempDir('agent-qa-outside-home-')
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI_ENTRY, 'mcp'],
    cwd,
    env: { ...getDefaultEnvironment(), HOME: home, USERPROFILE: home },
    stderr: 'pipe',
  })
  let captured = ''
  transport.stderr?.on('data', (chunk: Buffer | string) => {
    captured += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
  })
  const client = new Client(
    { name: `agent-qa-outside-${era}`, version: '0.0.0' },
    era === 'auto' ? { versionNegotiation: { mode: 'auto' as const } } : {},
  )
  await client.connect(transport)
  return {
    client,
    stderr: () => captured,
    close: async () => {
      await client.close().catch(() => {})
      await transport.close().catch(() => {})
    },
  }
}

// The 2025 codec wraps a result in `{ result }` when the tool's output schema is not an object.
function payloadOf(structuredContent: unknown): Record<string, unknown> {
  const record = (structuredContent ?? {}) as Record<string, unknown>
  const keys = Object.keys(record)
  return keys.length === 1 && keys[0] === 'result'
    ? record.result as Record<string, unknown>
    : record
}

async function toolNames(client: Client): Promise<string[]> {
  return (await client.listTools()).tools.map((tool) => tool.name).sort()
}

describe('agent-qa mcp outside a project', () => {
  it('lists the tools a project lists and answers every call not initialized', async () => {
    expect(
      existsSync(CLI_ENTRY),
      `the built CLI entry is missing at ${CLI_ENTRY}; run \`pnpm build\` first`,
    ).toBe(true)

    const project = await connect(fixtureProject(), 'legacy')
    let projectTools: string[]
    try {
      projectTools = await toolNames(project.client)
    } finally {
      await project.close()
    }
    expect(projectTools).toContain('agent_qa_list_runs')

    const folder = emptyRepository()
    const before = listing(folder)
    expect(before).toEqual(['.git'])

    for (const era of ['legacy', 'auto'] as const) {
      const session = await connect(folder, era)
      try {
        expect(session.client.getServerVersion()?.version, era).toBe(getAgentQaVersion().trim())
        expect(await toolNames(session.client), era).toEqual(projectTools)
        expect(session.client.getInstructions(), era).toContain('npx agent-qa init')

        const result = await session.client.callTool({ name: 'agent_qa_list_runs', arguments: {} })
        expect(result.isError, era).toBe(true)
        const payload = payloadOf(result.structuredContent)
        expect(payload.status, era).toBe('not_initialized')
        expect(payload.run, era).toBe('npx agent-qa init')
        expect(String(payload.configPath), era).toMatch(/agent-qa\.config\.yaml$/u)
        expect(session.stderr(), era).not.toContain('Failed to start MCP server')
      } finally {
        await session.close()
      }
    }

    expect(listing(folder)).toEqual(before)
  }, 90_000)
})
