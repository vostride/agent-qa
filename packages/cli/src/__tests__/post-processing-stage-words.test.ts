// One stage vocabulary everywhere: `complete`, and `skipped (<reason>)` for a chain never enqueued.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createMcpHandler } from '@modelcontextprotocol/server'
import {
  createFunctionRegistry,
  invokeFunction,
  RUNS_DIGEST_FUNCTION_ID,
  RUNS_POST_PROCESSING_FUNCTION_ID,
} from '@vostride/agent-qa-agent'
import type { FunctionDeps, PostProcessingChainState, ReplayedRunEvent } from '@vostride/agent-qa-agent'
import { DashboardDatabase } from '@vostride/agent-qa-dashboard'
import { generateRunId } from '@vostride/agent-qa-ids'
import {
  asJobId,
  CURRENT_RUN_NOTIFICATION_SCHEMA_VERSION,
  POST_PROCESSING_SKIP_REASON_WORDS,
  PostProcessingStatusSchema,
  RunDigestSchema,
  CURRENT_BUS_SCHEMA_VERSION,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type {
  CompletedRunHandoff,
  FunctionCaller,
  PostProcessingStatus,
  RunDigest,
  RunNotification,
} from '@vostride/agent-qa-schema'
import { buildAgentQaMcpServer } from '@vostride/agent-qa-mcp'
import { afterEach, describe, expect, it } from 'vitest'

import { composeCliLocalAgent } from '../composition/local-agent-host.js'
import { renderChainTerminalLine, renderPostProcessingSummaryLine } from '../curation/post-run-tail.js'

const RUN_ID = 'run-444-stage-words'

const CALLER: FunctionCaller = { surface: 'test', origin: 'agent' }

function depsWith(state: PostProcessingChainState | undefined, handoff?: CompletedRunHandoff): FunctionDeps {
  return {
    runs: {
      list: () => Promise.resolve([]),
      get: () => Promise.resolve(handoff),
      readEvents: () => Promise.resolve([]),
      readStepEvidence: () => Promise.resolve({ kind: 'run-not-recorded' } as const),
    },
    knowledge: {
      listBundles: () => Promise.resolve([]),
      inspectRecords: () => Promise.resolve([]),
      diffSince: () => Promise.resolve([]),
      showRecord: ({ recordId }) =>
        Promise.resolve({ kind: 'not-found', schemaVersion: 2, recordId } as const),
    },
    entities: {
      resolve: () => Promise.resolve({ kind: 'none' as const, reason: 'no-match' as const }),
      get: () => Promise.resolve(undefined),
    },
    config: {
      getMasked: () => Promise.resolve({ schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION, configPath: 'agent-qa.config.yaml', entries: [] }),
    },
    postProcessing: {
      idSource: { jobIdFor: (kind, key) => asJobId(`stage_words_${kind}_${key}`) },
      readChain: () => Promise.resolve(state),
    },
    secretMask: (text: string) => text,
  }
}

async function served(
  state: PostProcessingChainState | undefined,
  handoff?: CompletedRunHandoff,
): Promise<PostProcessingStatus> {
  return await invokeFunction(
    createFunctionRegistry({ deps: depsWith(state, handoff) }),
    RUNS_POST_PROCESSING_FUNCTION_ID,
    { runId: RUN_ID },
    CALLER,
  ) as PostProcessingStatus
}

function storedNotification(): RunNotification {
  return {
    schemaVersion: CURRENT_RUN_NOTIFICATION_SCHEMA_VERSION,
    runId: RUN_ID,
    outcome: 'done',
    verdictSummary: { total: 1, byClass: { app_bug: 1 } },
    stages: {
      analysis: { status: 'done' },
      curation: { status: 'done', curated: 2, deprecated: 0 },
    },
  }
}

function finishedChain(notification: RunNotification): PostProcessingChainState {
  return {
    analyzeRun: { status: 'done', claimed: false },
    curateMemory: { status: 'done', claimed: false },
    notification,
  }
}

const HANDOFF = { runId: RUN_ID } as unknown as CompletedRunHandoff
const GATE_RUN_HANDOFF = { runId: RUN_ID, gateRun: true } as unknown as CompletedRunHandoff
const OUTCOME_EXCLUDED_HANDOFF = { runId: RUN_ID, excludedFromOutcomes: true } as unknown as CompletedRunHandoff

const openClients: Client[] = []

afterEach(async () => {
  for (const client of openClients.splice(0)) await client.close()
})

async function mcpClient(deps: FunctionDeps): Promise<Client> {
  const registry = createFunctionRegistry({ deps })
  const caller: FunctionCaller = { surface: 'mcp', origin: 'agent' }
  const handler = createMcpHandler(() => buildAgentQaMcpServer({ registry, caller, maskText: (text: string) => text }))
  const client = new Client({ name: 'agent-qa-444-10', version: '0.0.0' })
  openClients.push(client)
  await client.connect(new StreamableHTTPClientTransport(new URL('http://stage-words.local/mcp'), {
    fetch: ((url: URL | string, init?: RequestInit) => handler.fetch(new Request(url, init))) as typeof fetch,
  }))
  return client
}

describe('complete is the finished stage word', () => {
  it('the CLI exit line prints complete', async () => {
    const status = await served({
      analyzeRun: { status: 'done', claimed: false },
      curateMemory: { status: 'done', claimed: false },
    })
    const line = renderPostProcessingSummaryLine(status, 'none')
    expect(line).toContain('analysis: complete · curation: complete')
    expect(line).not.toMatch(/\bdone\b/u)
  })

  it("the MCP digest tool's output carries complete", async () => {
    const client = await mcpClient(depsWith(finishedChain(storedNotification()), HANDOFF))
    const result = await client.callTool({ name: 'agent_qa_get_run_digest', arguments: { runId: RUN_ID } })
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
    const digest = result.structuredContent as RunDigest
    expect(digest.chain).toEqual({ analysis: 'complete', curation: 'complete', outcome: 'complete' })
    expect(digest.lines).toContain('chain — analysis: complete · curation: complete · chain complete')
    expect(JSON.stringify(result)).not.toMatch(/\bdone\b/u)
  })
})

describe('the served notification view', () => {
  it('the stored notification keeps done and the served view reads complete', async () => {
    const stored = storedNotification()
    const before = structuredClone(stored)
    const status = await served(finishedChain(stored))
    expect(status.notification).toEqual({
      ...before,
      outcome: 'complete',
      stages: {
        analysis: { status: 'complete' },
        curation: { status: 'complete', curated: 2, deprecated: 0 },
      },
    })
    expect(stored).toEqual(before)

    const failed: RunNotification = {
      ...storedNotification(),
      outcome: 'failed',
      stages: { analysis: { status: 'done' }, curation: { status: 'failed' } },
    }
    const failedView = (await served(finishedChain(failed))).notification
    expect(failedView?.outcome).toBe('failed')
    expect(failedView?.stages).toEqual({
      analysis: { status: 'complete' },
      curation: { status: 'failed' },
    })
  })

  it('the CLI chain terminal line prints complete', async () => {
    const status = await served(finishedChain(storedNotification()))
    const line = renderChainTerminalLine(status.notification!)
    expect(line.startsWith(`post-processing complete for ${RUN_ID} — `)).toBe(true)
    expect(line).toContain('analysis: complete')
    expect(line).toContain('curation: complete (2 curated, 0 deprecated)')
    expect(line).not.toMatch(/\bdone\b/u)
  })

  it("the digest's chain line prints complete", async () => {
    const digest = await invokeFunction(
      createFunctionRegistry({ deps: depsWith(finishedChain(storedNotification()), HANDOFF) }),
      RUNS_DIGEST_FUNCTION_ID,
      { runId: RUN_ID },
      CALLER,
    ) as RunDigest
    expect(digest.chain).toEqual({ analysis: 'complete', curation: 'complete', outcome: 'complete' })
    expect(digest.lines).toContain('chain — analysis: complete · curation: complete · chain complete')
    expect(digest.lines.join('\n')).not.toMatch(/\bdone\b/u)
  })

  it("the served output validates against the functions' output schema", async () => {
    const status = await served(finishedChain(storedNotification()))
    expect(PostProcessingStatusSchema.parse(status)).toEqual(status)
    expect(PostProcessingStatusSchema.safeParse({
      ...status,
      notification: { ...status.notification, outcome: 'done' },
    }).success).toBe(false)
    expect(PostProcessingStatusSchema.safeParse({
      ...status,
      notification: { ...status.notification, stages: { ...status.notification!.stages, analysis: { status: 'done' } } },
    }).success).toBe(false)
    const digest = await invokeFunction(
      createFunctionRegistry({ deps: depsWith(finishedChain(storedNotification()), HANDOFF) }),
      RUNS_DIGEST_FUNCTION_ID,
      { runId: RUN_ID },
      CALLER,
    ) as RunDigest
    expect(RunDigestSchema.parse(digest)).toEqual(digest)
    expect(RunDigestSchema.safeParse({ ...digest, chain: { ...digest.chain, outcome: 'done' } }).success)
      .toBe(false)
  })
})

describe('skipped stages of a never-enqueued run', () => {
  it("a gate run's read carries skipped with reason gate-run and no exclusion field", async () => {
    const status = await served(undefined, GATE_RUN_HANDOFF)
    expect(status.skipped).toEqual({ reason: 'gate-run' })
    expect(status).not.toHaveProperty('exclusion')
    expect(status.chips).toEqual({ analysis: 'pending', curation: 'pending' })
    expect(PostProcessingStatusSchema.parse(status)).toEqual(status)
    expect(PostProcessingStatusSchema.safeParse({ ...status, exclusion: { reason: 'gate-run' } }).success)
      .toBe(false)
    expect('skipped' in await served(undefined, HANDOFF)).toBe(false)
  })

  it('the CLI exit line prints skipped (gate run) for both stages', async () => {
    const line = renderPostProcessingSummaryLine(await served(undefined, GATE_RUN_HANDOFF), 'handed-off')
    expect(line).toContain('analysis: skipped (gate run) · curation: skipped (gate run)')
    expect(line).not.toContain('excluded')
    expect(line).not.toContain('daemon will drain')
  })

  it('the CLI exit line prints skipped (outcome-excluded) for an outcome-excluded run', async () => {
    const line = renderPostProcessingSummaryLine(
      await served(undefined, OUTCOME_EXCLUDED_HANDOFF),
      'handed-off',
    )
    expect(line).toContain('analysis: skipped (outcome-excluded) · curation: skipped (outcome-excluded)')
    expect(line).not.toMatch(/\bexcluded \(/u)
  })

  it("the digest's chain line prints skipped (gate run)", async () => {
    const digest = await invokeFunction(
      createFunctionRegistry({ deps: depsWith(undefined, GATE_RUN_HANDOFF) }),
      RUNS_DIGEST_FUNCTION_ID,
      { runId: RUN_ID },
      CALLER,
    ) as RunDigest
    expect(digest.chain).toEqual({ analysis: 'pending', curation: 'pending', skipped: { reason: 'gate-run' } })
    expect(digest.lines).toContain('chain — analysis: skipped (gate run) · curation: skipped (gate run)')
    expect(RunDigestSchema.parse(digest)).toEqual(digest)

    const client = await mcpClient(depsWith(undefined, GATE_RUN_HANDOFF))
    const result = await client.callTool({ name: 'agent_qa_get_run_digest', arguments: { runId: RUN_ID } })
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
    const served = result.structuredContent as RunDigest
    expect(served.chain).toEqual(digest.chain)
    expect(served.lines).toContain('chain — analysis: skipped (gate run) · curation: skipped (gate run)')
    expect(JSON.stringify(result)).not.toMatch(/\bexcluded \(/u)
  })
})

const STARTED_ONLY = [
  { seq: 1, ts: 1, runId: RUN_ID, type: 'runStarted', payload: { busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION } },
] as unknown as readonly ReplayedRunEvent[]

function noVerdictDeps(status: string): FunctionDeps {
  const base = depsWith(undefined)
  return {
    ...base,
    runs: { ...base.runs, readEvents: () => Promise.resolve(STARTED_ONLY) },
    runDetail: {
      read: () => Promise.resolve(undefined),
      readRecord: () => Promise.resolve({ status }),
    },
  }
}

describe('a run that ended with no verdict', () => {
  it('the CLI exit line prints skipped (no verdict)', async () => {
    const status = await invokeFunction(
      createFunctionRegistry({ deps: noVerdictDeps('failed') }),
      RUNS_POST_PROCESSING_FUNCTION_ID,
      { runId: RUN_ID },
      CALLER,
    ) as PostProcessingStatus
    expect(status.skipped).toEqual({ reason: 'no-verdict' })
    const line = renderPostProcessingSummaryLine(status, 'handed-off')
    expect(line).toContain('analysis: skipped (no verdict) · curation: skipped (no verdict)')
    expect(line).not.toContain('pending')
    expect(line).not.toContain('daemon will drain')

    const running = await invokeFunction(
      createFunctionRegistry({ deps: noVerdictDeps('running') }),
      RUNS_POST_PROCESSING_FUNCTION_ID,
      { runId: RUN_ID },
      CALLER,
    ) as PostProcessingStatus
    expect(renderPostProcessingSummaryLine(running, 'handed-off')).not.toContain('skipped')
  })

  it("the CLI host's reader answers a finished row and opens nothing before runs.db exists", async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-qa-444-no-verdict-'))
    const agentQaRoot = join(root, '.agent-qa')
    mkdirSync(agentQaRoot, { recursive: true })
    const configPath = join(root, 'agent-qa.config.yaml')
    writeFileSync(configPath, 'workspace:\n  testMatch: [tests/**/*.yaml]\n  suiteMatch: [suites/**/*.suite.yaml]\n'
      + '  hooksFile: hooks.yaml\n  envFile: .env\n  secretsFile: .env.secrets.local\nuse:\n  mobile:\n    appState: preserve\n')
    writeFileSync(join(root, 'hooks.yaml'), 'hooks: []\n')
    writeFileSync(join(root, '.env'), '')
    writeFileSync(join(root, '.env.secrets.local'), '')
    const runsDb = join(agentQaRoot, 'runs.db')
    const runId = generateRunId()
    const host = composeCliLocalAgent({ configPath, agentQaRoot })
    try {
      const read = async (): Promise<PostProcessingStatus> => await invokeFunction(
        host.registry, RUNS_POST_PROCESSING_FUNCTION_ID, { runId }, CALLER,
      ) as PostProcessingStatus
      const before = await read()
      expect('skipped' in before).toBe(false)
      expect(existsSync(runsDb), 'the read created runs.db').toBe(false)

      const db = new DashboardDatabase({ dbPath: runsDb })
      try {
        db.insertRun({
          id: runId, name: 'a run with no verdict', status: 'failed', duration: 0,
          startedAt: '2026-10-18T00:00:00.000Z', endedAt: '2026-10-18T00:00:01.000Z',
          failureSummary: 'The run ended before it reached a verdict.',
        })
      } finally { db.close() }
      const after = await read()
      expect(after.skipped).toEqual({ reason: 'no-verdict' })
      expect(renderPostProcessingSummaryLine(after, 'handed-off'))
        .toContain('analysis: skipped (no verdict) · curation: skipped (no verdict)')
    } finally {
      await host.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
