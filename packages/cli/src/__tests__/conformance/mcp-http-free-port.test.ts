import { spawn } from 'node:child_process'

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, describe, expect, it } from 'vitest'

import {
  ANCHORED_BUILDS,
  CLI_ENTRY,
  REBUILD_INSTRUCTION,
  buildFreshness,
  cleanupTempRoots,
  dashboardFixtureProject,
  hermeticEnv,
} from './spawned-chat.js'

const LISTENING_LINE = /agent-qa MCP server listening on http:\/\/127\.0\.0\.1:(\d+)\//u

afterAll(() => {
  cleanupTempRoots()
})

describe('agent-qa mcp --http 0', () => {
  it('binds a free loopback port and names that port in its listening line', async () => {
    expect(buildFreshness(ANCHORED_BUILDS), REBUILD_INSTRUCTION)
      .toEqual({ missing: [], stale: [] })
    const project = dashboardFixtureProject('mcp-http-free-port')
    const child = spawn(
      process.execPath,
      [CLI_ENTRY, '--config', project.configPath, 'mcp', '--http', '0'],
      { cwd: project.root, env: hermeticEnv(project.root), stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stderr = ''
    let exited = false
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.stdout.resume()
    const closed = new Promise<void>((settle) => {
      child.once('close', () => { exited = true; settle() })
    })
    const client = new Client({ name: 'agent-qa-http-free-port', version: '0.0.0' })
    try {
      const deadline = Date.now() + 60_000
      while (!LISTENING_LINE.test(stderr) && !exited && Date.now() < deadline) {
        await new Promise((tick) => setTimeout(tick, 50))
      }
      const port = Number(LISTENING_LINE.exec(stderr)?.[1])
      expect(port, `the listening line names the bound port: ${stderr}`).toBeGreaterThan(0)
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${String(port)}/mcp`)),
      )
      const tools = (await client.listTools()).tools.map((tool) => tool.name)
      expect(tools, 'the server on that port is the agent-qa MCP server')
        .toContain('agent_qa_start_run')
    } finally {
      await client.close().catch(() => undefined)
      if (!exited) {
        child.kill('SIGTERM')
        setTimeout(() => { child.kill('SIGKILL') }, 5_000).unref()
      }
      await closed
    }
  }, 90_000)
})
