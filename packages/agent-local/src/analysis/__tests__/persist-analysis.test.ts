// The write helper owns durability and the composition root owns the path; each fails differently.

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { chainJobIdsForRun } from '@vostride/agent-qa-agent'
import type { ClockPort, ConfigReaderPort, JobModelCapability } from '@vostride/agent-qa-agent'
import { HANDOFF_FILE, RUNS_SUBDIR, slugBranch } from '@vostride/agent-qa-runner-local'
import {
  ANALYSIS_FILE,
  asRunId,
  canonicalJson,
  CURRENT_ANALYSIS_SCHEMA_VERSION,
  CURRENT_HANDOFF_SCHEMA_VERSION,
  guardRunAnalysisArtifact,
  sha256hex,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type { CompletedRunHandoff, RunAnalysisArtifact, Verdict } from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it } from 'vitest'

import { composeLocalAgent, DIGEST_JOB_ID_SOURCE } from '../../composition/compose-local-agent.js'
import type { LocalAgentHost, LocalAgentJobs } from '../../composition/compose-local-agent.js'
import { writeAnalysisArtifact } from '../persist-analysis.js'

// Passthrough: this fixture already speaks canonical workspace-relative bytes.
const MINT_IDENTITY = (filePath: string): string => filePath

const RUN_ID = 'run-389-persist'

function artifactFor(runId: string, rationale: string): RunAnalysisArtifact {
  const verdict: Verdict = {
    class: 'unknown',
    producer: 'deterministic-classifier',
    confidence: 0,
    evidence: { citedSteps: [], citedAnchors: [], citedArtifacts: [], rationale },
    memoryMisdirectionRuledOut: true,
    perTest: 0,
  }
  return {
    schemaVersion: CURRENT_ANALYSIS_SCHEMA_VERSION,
    runId,
    verdicts: [verdict],
    parts: [
      {
        perTest: 0,
        groundingQuote: { source: 'test-outcome', quote: 'failed' },
        discriminator: 'root cause undetermined',
        nextAction: 'inspect the run manually',
        links: [],
      },
    ],
  }
}

const roots: string[] = []
const hosts: LocalAgentHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

describe('writeAnalysisArtifact: the fsynced temp-rename write helper', () => {
  it('lands canonical bytes plus newline at mode 0o600 with no staged residue', () => {
    const dir = tempDir('agent-qa-persist-analysis-')
    const file = join(dir, ANALYSIS_FILE)
    const artifact = artifactFor(RUN_ID, 'no deterministic signal matched')

    writeAnalysisArtifact(file, artifact)

    expect(readFileSync(file, 'utf8')).toBe(`${canonicalJson(artifact)}\n`)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    // The staged `.tmp` is removed in a finally — success leaves exactly one entry.
    expect(readdirSync(dir)).toEqual([ANALYSIS_FILE])
    // Read-back through the one guard: what the helper writes, every reader admits.
    expect(guardRunAnalysisArtifact(JSON.parse(readFileSync(file, 'utf8')))).toEqual(artifact)
  })

  it('is idempotent per path: last write wins, one file, no .tmp residue', () => {
    const dir = tempDir('agent-qa-persist-analysis-')
    const file = join(dir, ANALYSIS_FILE)

    writeAnalysisArtifact(file, artifactFor(RUN_ID, 'first write'))
    const second = artifactFor(RUN_ID, 'second write')
    writeAnalysisArtifact(file, second)

    expect(readdirSync(dir)).toEqual([ANALYSIS_FILE])
    expect(readFileSync(file, 'utf8')).toBe(`${canonicalJson(second)}\n`)
  })
})

// ————— the composition-root binding, driven through the REAL chain —————

// Unparseable text degrades the author per test to the deterministic floor; the artifact persists.
const CALLER_MODEL: JobModelCapability = {
  modelId: 'test:persist-analysis',
  generate: async () => ({ text: 'not an author payload' }),
}

const TEST_CONFIG: ConfigReaderPort = {
  getMasked: () => Promise.resolve({
    schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
    configPath: '/tmp/persist-analysis.config.yaml',
    entries: [],
  }),
}

function steppingClock(): ClockPort {
  let tick = 0
  return {
    now() {
      const stamp = `2026-08-04T00:00:${String(tick % 60).padStart(2, '0')}.000Z`
      tick += 1
      return stamp
    },
  }
}

function fixtureHandoff(runId: string): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: asRunId(runId),
    scope: { tier: 'product', key: 'persist-analysis' },
    buildOrdinal: 1,
    executionContext: 'local-headless',
    aggregateVerdict: 'failed',
    configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
    startedAt: 1,
    endedAt: 2,
    tests: [
      {
        testId: 't_failed',
        testName: 'a member that failed',
        filePath: 'tests/failed.yaml',
        testIndex: 0,
        outcome: 'failed',
        steps: [],
      },
    ],
  }
}

async function pump(jobs: LocalAgentJobs, fence: { epoch: number }): Promise<void> {
  for (let pumped = 0; pumped < 24; pumped += 1) {
    const outcome = await jobs.queue.runNextJob({ fence })
    if (!outcome.ran) return
  }
  throw new Error('the post-run chain did not drain within the pump bound')
}

describe('postRunCapabilities binds persistAnalysis at the run analysis path', () => {
  it('lands the artifact at runs/<slug(runId)>/analysis.json under the real chain', async () => {
    const agentQaRoot = tempDir('agent-qa-persist-binding-')
    const handoff = fixtureHandoff(RUN_ID)
    const runDir = join(agentQaRoot, RUNS_SUBDIR, slugBranch(RUN_ID))
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, HANDOFF_FILE), `${JSON.stringify(handoff)}\n`, 'utf8')

    const host = composeLocalAgent({
      mask: (text) => text,
      mintQuarantineIdentityPath: MINT_IDENTITY,
      agentQaRoot,
      config: TEST_CONFIG,
      knowledgeRoot: () => join(agentQaRoot, 'knowledge'),
      model: () => CALLER_MODEL,
      clock: steppingClock(),
      postRun: {
        curateRun: async () => ({ curated: 0, deprecated: 0, complete: true }),
        candidateProse: 'masker-active',
      },
    })
    hosts.push(host)
    const jobs = await host.jobs()

    const fence = await jobs.store.adoptEpoch(1)
    await jobs.queue.recoverAbandonedClaims({ fence })
    await jobs.queue.enqueue(
      'analyze-run',
      {
        runId: RUN_ID,
        handoffDigest: sha256hex(canonicalJson(handoff)),
        handoffSchemaVersion: handoff.schemaVersion,
        executionContext: handoff.executionContext,
      },
      RUN_ID,
    )
    await pump(jobs, fence)

    // The path is DERIVED from runId through slugBranch — the same law as the handoff read
    // binding directly above it, never a payload-supplied path.
    const artifactPath = join(agentQaRoot, RUNS_SUBDIR, slugBranch(RUN_ID), ANALYSIS_FILE)
    const artifact = guardRunAnalysisArtifact(JSON.parse(readFileSync(artifactPath, 'utf8')))
    expect(artifact.runId).toBe(RUN_ID)
    expect(artifact.verdicts).toHaveLength(1)
    expect(artifact.parts).toHaveLength(1)
    // No staged residue in the run directory either.
    expect(readdirSync(runDir).sort()).toEqual([ANALYSIS_FILE, HANDOFF_FILE].sort())

    // And the chain still landed its frozen checkpoint — the artifact rode BEFORE it.
    const ids = chainJobIdsForRun(RUN_ID, DIGEST_JOB_ID_SOURCE)
    const recorded = await jobs.store.readCheckpoint(ids.analyzeRun, 'verdicts-authored')
    expect(recorded.found).toBe(true)
  })
})
