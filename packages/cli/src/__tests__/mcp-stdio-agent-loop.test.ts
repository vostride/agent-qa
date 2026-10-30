// The shipped MCP door over stdio, tokenless, doing the whole loop.
//
// WHAT THIS ADDS TO `mcp-stdio-smoke.test.ts`. The smoke cell lists tools. This file spawns the
// SAME built binary in a project that has a recorded failing run and live knowledge, and drives the
// loop a coding agent drives: list the catalogue with no token, change the config in one call, mark
// the run in one call, and read the knowledge the NEXT run's brief serves. No caller presents a
// token, a scope or a confirmation, and nothing elicits.
//
// BUILD PREREQUISITE (the stale-dist law): the child is `packages/cli/dist/cli.js`. The CLI's test
// task depends on its build; a focused run needs `pnpm build` first, and the guard below says so.
//
// Every fixture lives in a temporary directory (the mark fixture's own `mkdtemp` root).

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { openKnowledgeReader, rebuildIndex } from '@vostride/agent-qa-knowledge-local'
import { RunsMarkOutcomeSchema } from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it } from 'vitest'

import { bundles, markFixture } from '../gates/__tests__/feedback-fixture.js'

const CLI_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist/cli.js')

/** The fixture's knowledge lives in the `storefront` product (the promotion-floor fixture). */
const PRODUCT = 'storefront'
const SCOPE = { tier: 'product', key: PRODUCT } as const

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface StdioSession {
  readonly client: Client
  readonly stderr: () => string
  readonly close: () => Promise<void>
}

async function openStdio(cwd: string): Promise<StdioSession> {
  expect(existsSync(CLI_ENTRY), `the built CLI entry is missing at ${CLI_ENTRY}; run \`pnpm build\` first`).toBe(true)
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI_ENTRY, 'mcp'],
    cwd,
    stderr: 'pipe',
    // No token variable of any name is set for the child: the door is tokenless by construction.
    env: Object.fromEntries(Object.entries(process.env)
      .filter((entry): entry is [string, string] => entry[1] !== undefined && !/TOKEN/u.test(entry[0]))),
  })
  let captured = ''
  transport.stderr?.on('data', (chunk: Buffer | string) => {
    captured += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
  })
  const client = new Client({ name: 'agent-qa-stdio', version: '0.0.0' })
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

interface ToolAnswer {
  readonly isError: boolean
  readonly text: string
  readonly structured: Record<string, unknown> | undefined
}

async function call(session: StdioSession, name: string, args: Record<string, unknown>): Promise<ToolAnswer> {
  const result = await session.client.callTool({ name, arguments: args }) as {
    content?: readonly { type: string; text?: string }[]
    structuredContent?: Record<string, unknown>
    isError?: boolean
  }
  return {
    isError: result.isError === true,
    text: (result.content ?? []).map((entry) => entry.text ?? '').join('\n'),
    structured: result.structuredContent,
  }
}

/** The record ids the next run's brief serves for the fixture's product scope. */
async function nextBriefIds(knowledgeRoot: string): Promise<string[]> {
  await rebuildIndex({ knowledgeRoot })
  const { brief } = openKnowledgeReader({ knowledgeRoot, product: PRODUCT }).getRunBrief(SCOPE, 4_000)
  return brief.lines.map(({ id }) => String(id))
}

function project(): ReturnType<typeof markFixture> {
  const fixture = markFixture()
  roots.push(fixture.root)
  // The MCP masker reads this project's declared secrets.
  writeFileSync(join(fixture.root, '.env.secrets.local'), '')
  return fixture
}

describe('a tokenless stdio caller sees the catalogue', () => {
  it('the spawned binary lists the change, mark and start tools to a caller with no token', async () => {
    const fixture = project()
    const session = await openStdio(fixture.root)
    try {
      const names = (await session.client.listTools()).tools.map((tool) => tool.name).sort()
      for (const kept of ['agent_qa_change_knowledge', 'agent_qa_change_config', 'agent_qa_mark_run', 'agent_qa_start_run']) {
        expect(names).toContain(kept)
      }
      expect(session.stderr()).not.toMatch(/token|scope|credential/iu)
    } finally {
      await session.close()
    }
  }, 60_000)
})

describe('one call each over stdio, served next run', () => {
  it('a tokenless stdio caller changes the config in one call', async () => {
    const fixture = project()
    const session = await openStdio(fixture.root)
    try {
      const answer = await call(session, 'agent_qa_change_config', {
        action: 'config.field.set', path: 'use.workers', value: 2,
      })
      expect(answer.isError, answer.text).toBe(false)
      expect(answer.structured?.['outcome'], answer.text).toBe('applied')
      expect(readFileSync(fixture.configPath, 'utf8'), 'the change is not on disk after one call').toContain('workers: 2')
    } finally {
      await session.close()
    }
  }, 60_000)

  it('a tokenless stdio mark lands its knowledge fix in the call, and the next brief serves the changed record instead of the replaced one', async () => {
    const fixture = project()
    // Before the mark the fixture's record is a HELD candidate, so the product brief serves nothing
    // the mark is about to change.
    const servedBefore = await nextBriefIds(fixture.knowledgeRoot)

    const session = await openStdio(fixture.root)
    let answer: ToolAnswer
    try {
      answer = await call(session, 'agent_qa_mark_run', { runId: fixture.handoff.runId, kind: 'false-fail' })
    } finally {
      await session.close()
    }
    expect(answer.isError, answer.text).toBe(false)
    const outcome = RunsMarkOutcomeSchema.parse(answer.structured)
    expect(outcome).toMatchObject({ kind: 'marked', receipt: { disposition: { kind: 'applied', change: { kind: 'knowledge' } } } })
    if (outcome.kind !== 'marked' || outcome.receipt.disposition.kind !== 'applied') throw new Error('unreachable')
    const change = outcome.receipt.disposition.change
    if (change.kind !== 'knowledge') throw new Error('unreachable')
    expect(change.recordIds.length, 'the receipt names no changed record').toBeGreaterThan(0)

    // Gold, evidence and the receipt landed in the one call.
    expect(readFileSync(join(fixture.runDir, 'marks.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1)
    expect(bundles(fixture.knowledgeRoot).map((row) => row.id)).toEqual(expect.arrayContaining(change.recordIds.map(String)))

    // The NEXT run is served the change: a changed record is in the brief and the replaced one is not.
    const servedAfter = await nextBriefIds(fixture.knowledgeRoot)
    expect(change.recordIds.map(String).some((id) => servedAfter.includes(id)),
      `the next brief serves none of ${change.recordIds.join(', ')}: ${servedAfter.join(', ')}`).toBe(true)
    expect(change.recordIds.map(String).filter((id) => servedBefore.includes(id)),
      'a changed record was already served before the mark, so serving it proves nothing').toEqual([])
    if (!change.recordIds.map(String).includes(fixture.published.id)) {
      expect(servedAfter, 'the replaced record is still served').not.toContain(fixture.published.id)
    }
  }, 120_000)
})
