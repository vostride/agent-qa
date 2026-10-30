// The shipped `agent-qa mcp` binary's stdio instructions forbid every path init's guide forbids.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { AGENT_QA_MCP_INSTRUCTIONS } from '@vostride/agent-qa-mcp'
import { afterEach, describe, expect, it } from 'vitest'

import {
  AGENT_QUESTION_MAP,
  buildAgentInstructionPointer,
  buildKnowledgeAgentGuide,
} from '../commands/knowledge-guide.js'

const CLI_ENTRY = process.env['AGENT_QA_PARITY_CLI']
  ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../dist/cli.js')

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function childEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries({ ...process.env, CI: 'true' })
    .filter((entry): entry is [string, string] => entry[1] !== undefined && !/TOKEN|SECRET/u.test(entry[0])))
}

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-433-33-'))
  roots.push(root)
  return root
}

function init(dir: string, ...extra: string[]): void {
  expect(existsSync(CLI_ENTRY), `the built CLI entry is missing at ${CLI_ENTRY}; run \`pnpm build\` first`).toBe(true)
  const result = spawnSync(process.execPath, [CLI_ENTRY, 'init', '--dir', dir, '--platform', 'web', ...extra], {
    cwd: dir, env: childEnv(), input: '', encoding: 'utf8', timeout: 120_000,
  })
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
}

async function stdioInstructions(cwd: string): Promise<string | undefined> {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [CLI_ENTRY, 'mcp'], cwd, stderr: 'pipe', env: childEnv(),
  })
  const client = new Client({ name: 'agent-qa-433-33-stdio', version: '0.0.0' })
  try {
    await client.connect(transport)
    return client.getInstructions()
  } finally {
    await client.close().catch(() => {})
    await transport.close().catch(() => {})
  }
}

describe('the stdio server instructions match the init guide', () => {
  it('the shipped stdio server answers the instructions', async () => {
    const dir = tempDir()
    init(dir)
    const answered = await stdioInstructions(dir)
    expect(typeof answered, 'the stdio server sent no instructions').toBe('string')
    expect(answered).toBe(AGENT_QA_MCP_INSTRUCTIONS)
  }, 180_000)

  it('every path the init guide forbids, the server forbids', () => {
    const guide = buildKnowledgeAgentGuide()
    for (const path of ['memory/index/', 'memory/queue/', '.lease', '.epoch', 'SQLite']) {
      expect(guide, `the guide no longer names ${path}`).toContain(path)
      expect(AGENT_QA_MCP_INSTRUCTIONS, path).toContain(path)
    }
    expect(buildAgentInstructionPointer().join('\n')).toContain('.agent-qa/')
    expect(AGENT_QA_MCP_INSTRUCTIONS).toContain('.agent-qa/')
  })

  it('the first reads match the guide\'s map', () => {
    const mcpTools = AGENT_QUESTION_MAP.map((row) => row.mcp)
    for (const tool of ['agent_qa_list_runs', 'agent_qa_get_run_overview']) {
      expect(mcpTools, tool).toContain(tool)
      expect(AGENT_QA_MCP_INSTRUCTIONS, tool).toContain(tool)
    }
  })

  it('init writes no CLAUDE.md', () => {
    const fresh = tempDir()
    init(fresh, '--write-agent-instructions')
    expect(existsSync(join(fresh, 'AGENTS.md')), 'the pointer was not written to AGENTS.md').toBe(true)
    expect(existsSync(join(fresh, 'CLAUDE.md'))).toBe(false)
    expect(existsSync(join(fresh, 'agent-qa-knowledge', 'CLAUDE.md'))).toBe(false)

    const owned = tempDir()
    const before = Buffer.from('# Working agreements\n\nKeep this file as it is.\n', 'utf8')
    writeFileSync(join(owned, 'CLAUDE.md'), before)
    init(owned, '--write-agent-instructions')
    expect(readFileSync(join(owned, 'CLAUDE.md')).equals(before)).toBe(true)
    expect(existsSync(join(owned, 'agent-qa-knowledge', 'CLAUDE.md'))).toBe(false)
  }, 240_000)
})
