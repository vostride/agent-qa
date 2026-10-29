// A run that ended without a verdict gets a plain sentence; the lists keep only completed runs.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { DashboardDatabase } from '@vostride/agent-qa-dashboard'
import { generateRunId } from '@vostride/agent-qa-ids'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  dashboardDbPath,
  recordedDoorProject,
  runStoreIds,
  spawnCliRun,
  type CliRunOutcome,
  type RecordedDoorProject,
} from './run-doors-fixture.js'
import { populatedRunSpawnEnv } from './populated-run-fixture.js'
import { CLI_ENTRY, cleanupTempRoots, hermeticEnv } from './spawned-chat.js'
import { CURRENT_BUS_SCHEMA_VERSION } from '@vostride/agent-qa-schema'

const BUDGET_MS = 300_000

const LIST_HINT = 'agent-qa runs list'

let project: RecordedDoorProject
let passed: CliRunOutcome
let passedRunId: string
let verdictlessRunId: string
let client: Client | undefined
let transport: StdioClientTransport | undefined

function ended(runId: string): string {
  return `Run ${runId} ended before it reached a verdict. Its record is in the dashboard.`
}

function transcript(outcome: CliRunOutcome): string {
  return `exit ${String(outcome.status)}\n--- stdout ---\n${outcome.stdout}\n--- stderr ---\n${outcome.stderr}`
}

function seedVerdictlessRun(): string {
  const db = new DashboardDatabase({ dbPath: dashboardDbPath(project) })
  const startedAt = new Date(Date.now() - 60_000).toISOString()
  let id: string
  try {
    id = db.insertRun({
      id: generateRunId(),
      name: 'A run that ended before its verdict',
      status: 'failed',
      duration: 0,
      startedAt,
      endedAt: startedAt,
      failureSummary: 'The run ended before it reached a verdict.',
    })
  } finally {
    db.close()
  }
  const directory = join(project.agentQaRoot, 'runs', id)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'events.jsonl'), `${JSON.stringify({
    seq: 1,
    ts: Date.parse(startedAt),
    runId: id,
    type: 'runStarted',
    payload: { busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION, memberTestCount: 1 },
  })}\n`, 'utf8')
  return id
}

function stdioEnv(): Record<string, string> {
  const env: NodeJS.ProcessEnv = {
    ...hermeticEnv(project.root),
    ...populatedRunSpawnEnv(),
    CI: 'true',
    NO_COLOR: '1',
  }
  delete env.AGENT_QA_RUN_ID
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

async function callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean; structured: unknown }> {
  if (client === undefined) throw new Error('the stdio MCP client did not connect')
  const result = await client.callTool({ name, arguments: args }, { timeout: 60_000 }) as {
    content?: ReadonlyArray<{ text?: string }>
    isError?: boolean
    structuredContent?: unknown
  }
  return {
    text: (result.content ?? []).map((entry) => entry.text ?? '').join('\n'),
    isError: result.isError === true,
    structured: result.structuredContent,
  }
}

describe('reads of a run with no verdict', () => {
  beforeAll(async () => {
    if (process.platform === 'win32') throw new Error('POSIX run lifecycle required; never skip')
    project = await recordedDoorProject('444-verdictless-reads')
    passed = await spawnCliRun(project, ['run', project.testPath])
    const stored = runStoreIds(project)
    if (stored.length !== 1) throw new Error(`the baseline run left ${String(stored.length)} run directories\n${transcript(passed)}`)
    passedRunId = stored[0]!
    verdictlessRunId = seedVerdictlessRun()
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_ENTRY, '--config', project.configPath, 'mcp'],
      cwd: project.root,
      stderr: 'pipe',
      env: stdioEnv(),
    })
    const connecting = new Client({ name: 'agent-qa-444-13-stdio', version: '0.0.0' })
    await connecting.connect(transport)
    client = connecting
  }, BUDGET_MS)

  afterAll(async () => {
    await client?.close().catch(() => undefined)
    await transport?.close().catch(() => undefined)
    await project?.close()
    cleanupTempRoots()
  }, 60_000)

  it('agent-qa runs overview answers a verdictless run with the sentence and exit 1', async () => {
    const outcome = await spawnCliRun(project, ['runs', 'overview', verdictlessRunId], { budgetMs: 60_000 })
    expect(outcome.status, transcript(outcome)).toBe(1)
    expect(outcome.stdout, transcript(outcome)).toBe('')
    expect(outcome.stderr.trim(), transcript(outcome)).toBe(`agent-qa runs overview: ${ended(verdictlessRunId)}`)
    expect(outcome.stderr).not.toContain(LIST_HINT)

    const unknown = generateRunId()
    const missing = await spawnCliRun(project, ['runs', 'overview', unknown], { budgetMs: 60_000 })
    expect(missing.status, transcript(missing)).toBe(1)
    expect(missing.stderr, transcript(missing)).toContain(`No completed run recorded for id: ${unknown}`)
    expect(missing.stderr, transcript(missing)).toContain(LIST_HINT)
  })

  it('agent_qa_get_run_overview answers a verdictless run with the sentence', async () => {
    const answer = await callTool('agent_qa_get_run_overview', { runId: verdictlessRunId })
    expect(answer.isError, answer.text).toBe(true)
    expect(answer.text).toBe(ended(verdictlessRunId))
  })

  it('agent_qa_get_run_digest answers a verdictless run with the sentence', async () => {
    const answer = await callTool('agent_qa_get_run_digest', { runId: verdictlessRunId })
    expect(answer.isError, answer.text).toBe(true)
    expect(answer.text).toBe(ended(verdictlessRunId))
  })

  it('agent-qa digest answers a verdictless run with the sentence', async () => {
    const outcome = await spawnCliRun(project, ['digest', verdictlessRunId], { budgetMs: 60_000 })
    expect(outcome.status, transcript(outcome)).toBe(1)
    expect(outcome.stdout, transcript(outcome)).toBe('')
    expect(outcome.stderr.trim(), transcript(outcome))
      .toBe(`Digest error [RunEndedWithoutVerdictError]: ${ended(verdictlessRunId)}`)
  })

  it('the CLI and MCP lists do not list a verdictless run', async () => {
    expect(passed.status, transcript(passed)).toBe(0)
    const listed = await spawnCliRun(project, ['runs', 'list', '--json'], { budgetMs: 60_000 })
    expect(listed.status, transcript(listed)).toBe(0)
    const cliIds = (JSON.parse(listed.stdout) as Array<{ runId: string }>).map((row) => row.runId)
    expect(cliIds, 'the CLI list holds the passed baseline run').toEqual([passedRunId])
    expect(cliIds).not.toContain(verdictlessRunId)

    const answer = await callTool('agent_qa_list_runs', {})
    expect(answer.isError, answer.text).toBe(false)
    const mcpListed = JSON.stringify(answer.structured)
    expect(mcpListed, 'the MCP list holds the passed baseline run').toContain(passedRunId)
    expect(mcpListed).not.toContain(verdictlessRunId)
    expect(answer.text).not.toContain(verdictlessRunId)
  })
})
