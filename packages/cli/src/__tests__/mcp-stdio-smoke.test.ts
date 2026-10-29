// A real MCP client spawns the SHIPPED binary (Phase 396 plan 01, D-09 / D-17's spirit).
//
// WHY A SECOND CELL WHEN THE TRACER ALREADY PASSES. The tracer drives the catalog in process. Every
// interesting thing about STDIO is invisible from there: whether the built artifact starts at all,
// whether the command still resolves, whether the era negotiation the serving entry owns actually
// completes over a pipe, and — the one that breaks every client in the field when it goes wrong —
// whether anything but JSON-RPC reaches stdout. None of those are provable against an in-process
// handler, and stdio is how every editor and desktop client will actually reach this server.
//
// THE STDOUT CLAIM IS PROVEN BY THE ROUND TRIP ITSELF, not by a string search. A stray byte on
// stdout ahead of a response is not a cosmetic blemish — it corrupts the framing and the transport
// fails outright — so a completed `tools/list` over this pipe IS the assertion that stdout carried
// protocol and nothing else. The startup line is asserted separately, on captured STDERR, which is
// the other half of the same law: the diagnostic exists AND it is not on the protocol channel.
//
// BUILD PREREQUISITE (the stale-dist law). These cells measure the BUILT artifact. Run
// `pnpm build` — or at minimum the schema, agent, mcp and cli filters in dependency order —
// before running them, or the binary spawned here is a previous revision wearing this one's name.
// The guard below refuses with that instruction rather than spawning something that does not exist.

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

/**
 * A real project on disk — produced, not a literal path handed to the child.
 *
 * `legacyTokens` (432-21, D-12/D-22) writes the pre-432 MCP credential block: one declared token
 * whose variable is set nowhere, and the stdio config-write switch off. Before 432-21 the unset
 * variable refused startup by name; now nothing reads the block, and since 432-22 both keys are
 * unknown to the strict schema.
 */
function fixtureProject(legacyTokens = false): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-396-01-stdio-'))
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
                  tokens: [{ name: 'legacy', tokenEnvVar: 'AGENT_QA_432_21_NEVER_SET_MCP_CRED', scopes: ['read'] }],
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
  // 2026-10-14 (441-07, D-06): the MCP masker reads this project's declared secrets.
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
  const client = new Client({ name: 'agent-qa-432-21-stdio-legacy', version: '0.0.0' })
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

    const client = new Client({ name: 'agent-qa-396-stdio-smoke', version: '0.0.0' })
    try {
      await client.connect(transport)
      const listed = await client.listTools()
      const names = listed.tools.map((entry) => entry.name)

      // (a) The catalog reached a client that spawned the shipped binary.
      // 432-12: `agent_qa_list_proposals` left with the proposal round; the run list stands in.
      expect(names).toContain('agent_qa_list_runs')

      // (b) RE-SPELLED 2026-10-01 (432-21, D-12) from D-07's default grant (every scope except
      // `config-write`, with a stdio opt-in for the last one). Neither the grant nor the opt-in
      // exists: a stdio caller with no switch set lists the config-write tool like every other.
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

  // 432-21 (D-12/D-22): the legacy credential block is left on disk and never read. Before 432-21 a
  // declared token whose variable was unset refused startup naming the variable; now the binary
  // starts and lists exactly what it lists for a project with no block at all. 432-22: the keys are
  // deleted, so the file fails strict validation; `agent-qa mcp`'s tolerant read serves anyway.
  it('a legacy token block with an unset variable refuses nothing and changes no listing', async () => {
    expect(existsSync(CLI_ENTRY), `the built CLI entry is missing at ${CLI_ENTRY}`).toBe(true)
    const plain = await listOverStdio(fixtureProject())
    const legacy = await listOverStdio(fixtureProject(true))
    expect(legacy.names).toEqual(plain.names)
    expect(legacy.names).toContain('agent_qa_change_config')
    expect(legacy.stderr()).not.toContain('AGENT_QA_432_21_NEVER_SET_MCP_CRED')
    expect(legacy.stderr()).not.toContain('Failed to start MCP server')
  }, 60_000)
})
