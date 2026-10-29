import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { chainJobIdsForRun, invokeFunction } from '@vostride/agent-qa-agent'
import { composeLocalAgent, DIGEST_JOB_ID_SOURCE } from '@vostride/agent-qa-agent-local'
import type { LocalAgentHost } from '@vostride/agent-qa-agent-local'
import { generateRunId } from '@vostride/agent-qa-ids'
import { HANDOFF_FILE, RUNS_SUBDIR, slugBranch } from '@vostride/agent-qa-runner-local'
import { CURRENT_HANDOFF_SCHEMA_VERSION, CurationSnapshotSchema, sha256hex, MASKED_RESOLVED_CONFIG_SCHEMA_VERSION, RECORD_CHANGE_SCHEMA_VERSION, CURATION_SNAPSHOT_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type { CurationSnapshot, PostProcessingStatus } from '@vostride/agent-qa-schema'

import { CLI_FUNCTION_CALLER, composeCliLocalAgent } from '../local-agent-host.js'
import { resolveConfig } from '../../config.js'

const roots: string[] = []
const hosts: LocalAgentHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function project() {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-423-cold-read-'))
  roots.push(root)
  const configPath = join(root, 'agent-qa.config.yaml')
  const agentQaRoot = join(root, '.agent-qa')
  const secretFile = join(root, '.env.secrets.local')
  const config = {
    workspace: { testMatch: ['tests/**/*.yaml'], suiteMatch: ['suites/**/*.yaml'],
      hooksFile: 'hooks.yaml', envFile: '.env', secretsFile: '.env.secrets.local' },
    knowledge: { dir: 'agent-qa-knowledge' },
    registry: { llms: [{ name: 'unused', provider: 'openai-compatible', model: 'unused',
      baseURL: 'http://127.0.0.1:1/v1' }],
      targets: { local: { platform: 'web', url: 'http://127.0.0.1:1' } } },
    use: { llm: 'unused', mobile: { appState: 'preserve' } },
  }
  writeFileSync(configPath, JSON.stringify(config))
  writeFileSync(secretFile, '')
  return { root, configPath, agentQaRoot, secretFile, config, runId: generateRunId() }
}

function snapshot(runId: string, evidenceTokens = [sha256hex('first-event'), sha256hex('second-event')]) {
  return CurationSnapshotSchema.parse({
    schemaVersion: CURATION_SNAPSHOT_SCHEMA_VERSION,
    rows: [{ recordId: 'confirmed-record', bucket: 'confirmed',
      changes: evidenceTokens.map((evidenceToken, index) => ({ bucket: 'confirmed', change: {
        schemaVersion: RECORD_CHANGE_SCHEMA_VERSION, recordId: 'confirmed-record', change: 'confirmed', atOrdinal: 1,
        evidenceToken, sourceRunId: runId,
        observationId: index === 0 ? `${runId}:test0:step0` : `knowledge-port:${sha256hex('port-event')}`,
      } })),
    }],
    breakdown: { added: 0, confirmed: 1, superseded: 0, deprecated: 0, proposed: 0 },
  })
}

async function publish(p: ReturnType<typeof project>, completed?: CurationSnapshot) {
  await resolveConfig({ configPath: p.configPath, loadAuthPlugins: false })
  const writer = composeLocalAgent({
    mask: (text) => text,
    agentQaRoot: p.agentQaRoot,
    mintQuarantineIdentityPath: path => path,
    config: { getMasked: async () => ({ schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION, configPath: p.configPath, entries: [] }) },
    knowledgeRoot: () => join(p.root, 'agent-qa-knowledge'),
    model: () => ({ modelId: 'never-called', generate: async () => { throw new Error('unexpected model') } }),
    postRun: { candidateProse: 'masker-active', curateRun: async () => ({
      curated: 7, deprecated: 3, complete: true,
      ...(completed === undefined ? {} : { snapshot: completed }),
    }) },
  })
  hosts.push(writer)
  const jobs = await writer.jobs()
  const fence = await jobs.store.adoptEpoch(1)
  const ids = chainJobIdsForRun(p.runId, DIGEST_JOB_ID_SOURCE)
  await jobs.queue.enqueue('curate-memory', { runId: p.runId }, `${ids.analyzeRun}->curate-memory`)
  expect(await jobs.queue.runNextJob({ fence })).toMatchObject({ ran: true, disposition: 'completed' })
  await writer.close()
  hosts.splice(hosts.indexOf(writer), 1)
  const runDir = join(p.agentQaRoot, RUNS_SUBDIR, slugBranch(p.runId))
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, HANDOFF_FILE), JSON.stringify({
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION, runId: p.runId,
    scope: { tier: 'product', key: 'cold-read' }, buildOrdinal: 1,
    executionContext: 'local-headless', aggregateVerdict: 'passed',
    configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
    startedAt: 1, endedAt: 2, tests: [],
  }))
}

function cold(p: ReturnType<typeof project>) {
  const host = composeCliLocalAgent({ agentQaRoot: p.agentQaRoot, configPath: p.configPath })
  hosts.push(host)
  vi.spyOn(host, 'jobs').mockImplementation(async () => { throw new Error('cold read opened jobs') })
  return {
    host,
    read: () => invokeFunction(
      host.registry, 'runs.postprocessing', { runId: p.runId }, CLI_FUNCTION_CALLER,
    ) as Promise<PostProcessingStatus>,
  }
}

describe('cold read masking recovery', () => {
  it('COLD-TWO-EVENTS reads one confirmed record with both actual checkpoint events intact', async () => {
    const p = project()
    const recorded = snapshot(p.runId)
    await publish(p, recorded)
    const read = cold(p)
    await expect(read.read()).resolves.toMatchObject({ curationSnapshot: recorded })
    expect(read.host.jobs).not.toHaveBeenCalled()
  })

  it('COLD-KNOWLEDGE keeps the nested checkpoint read successful on the same cold registry', async () => {
    const p = project()
    await publish(p, snapshot(p.runId))
    const read = cold(p)
    await expect(invokeFunction(read.host.registry, 'runs.knowledge', { runId: p.runId }, CLI_FUNCTION_CALLER))
      .resolves.toMatchObject({ kind: 'ready', curation: { status: 'complete' } })
    expect(read.host.jobs).not.toHaveBeenCalled()
  })

  // 2026-10-14 (441-16, E3): an unreadable secrets file now refuses the knowledge read, so the
  // withheld snapshot is the projection refusal, a raw value colliding with its recorded marker.
  it('COLD-KNOWLEDGE-WITHHELD keeps the knowledge read ready and names the withheld snapshot', async () => {
    const p = project()
    const first = 'first-sensitive-event'
    const recorded = snapshot(p.runId, [first, '[secret:FIRST]'])
    recorded.rows[0]!.changes[1]!.change.observationId = recorded.rows[0]!.changes[0]!.change.observationId
    writeFileSync(p.secretFile, `FIRST=${first}\n`)
    await publish(p, recorded)
    const read = cold(p)
    const knowledge = await invokeFunction(
      read.host.registry, 'runs.knowledge', { runId: p.runId }, CLI_FUNCTION_CALLER,
    ) as { kind: string, learned: Record<string, unknown> }
    expect(knowledge.kind).toBe('ready')
    expect(knowledge.learned.curationSnapshotWithheld).toEqual({ reason: 'projection-refused' })
    expect(knowledge.learned).not.toHaveProperty('curationSnapshot')
    expect(knowledge.learned).not.toHaveProperty('sinceThen')
    expect(read.host.jobs).not.toHaveBeenCalled()
  })

  it('COLD-HISTORICAL retains absent snapshot and missing-directory behavior with unavailable sources', async () => {
    const p = project()
    rmSync(p.secretFile)
    const read = cold(p)
    expect(await read.read()).not.toHaveProperty('curationSnapshot')
    expect(existsSync(join(p.agentQaRoot, 'agent-jobs.db'))).toBe(false)
    expect(existsSync(join(p.agentQaRoot, 'job-checkpoints'))).toBe(false)
    await publish(p)
    expect(await read.read()).not.toHaveProperty('curationSnapshot')
  })

  it.each(['missing', 'invalid', 'unreadable'] as const)('COLD-SOURCE-REFUSAL %s sources retain the existing fail-closed context', async kind => {
    const p = project()
    await publish(p, snapshot(p.runId))
    if (kind === 'missing') rmSync(p.secretFile)
    if (kind === 'invalid') writeFileSync(p.secretFile, 'INVALID-NAME=synthetic-value\n')
    if (kind === 'unreadable') { rmSync(p.secretFile); mkdirSync(p.secretFile) }
    const read = cold(p)
    const withheld = await read.read()
    expect(withheld).toHaveProperty('curationSnapshotWithheld', { reason: 'masking-unavailable' })
    expect(withheld).not.toHaveProperty('curationSnapshot')
    await expect(invokeFunction(read.host.registry, 'runs.knowledge', { runId: p.runId }, CLI_FUNCTION_CALLER))
      .rejects.toThrow(/Secrets file (not found|is invalid|could not be read)/)
  })

  // declared values mask to distinct names, so the duplicate is a raw
  // value beside a recorded copy of its own marker.
  it('COLD-COLLISION refuses genuinely masked duplicate events without deleting history', async () => {
    const p = project()
    const first = 'first-sensitive-event'
    const recorded = snapshot(p.runId, [first, '[secret:FIRST]'])
    // Only the evidence distinguishes these historical identities.
    recorded.rows[0]!.changes[1]!.change.observationId = recorded.rows[0]!.changes[0]!.change.observationId
    writeFileSync(p.secretFile, `FIRST=${first}\n`)
    await publish(p, recorded)
    const withheld = await cold(p).read()
    expect(withheld).toHaveProperty('curationSnapshotWithheld', { reason: 'projection-refused' })
    expect(withheld).not.toHaveProperty('curationSnapshot')
    expect(JSON.stringify(withheld)).not.toContain(first)
    expect(recorded.rows[0]!.changes).toHaveLength(2)
  })
})
