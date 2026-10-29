// A cold host masks the stored text `runs.overview` returns, and refuses if secrets are unreadable.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { invokeFunction } from '@vostride/agent-qa-agent'
import { SecretRedactor, SecretStore } from '@vostride/agent-qa-runner'
import { FsHandoffStore } from '@vostride/agent-qa-runner-local'
import {
  CURRENT_HANDOFF_SCHEMA_VERSION,
  RunOverviewProjectionSchema,
  RunsListOutputSchema,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type {
  CompletedRunHandoff,
  FunctionCaller,
  MaskFn,
  RunDetailRows,
  RunId,
  RunOverviewProjection,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { composeLocalAgent } from '../compose-local-agent.js'

const RUN_ID = 'run-431-overview-cold'
const SENTINEL = 'T431-overview-cold-sentinel-not-a-real-credential'
const REDACTED = '[secret:OVERVIEW_PASSWORD]'
const UNREADABLE = 'synthetic: workspace.secretsFile cannot be read'

const READER: FunctionCaller = {
  surface: 'test',
  origin: 'agent',
}

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-qa-431-overview-cold-'))
  const handoff: CompletedRunHandoff = {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: RUN_ID as RunId,
    scope: { tier: 'product', key: 'shop' },
    buildOrdinal: 3,
    executionContext: 'local-headless',
    aggregateVerdict: 'failed',
    configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
    startedAt: 10,
    endedAt: 20,
    tests: [{
      testId: 'test-login',
      testName: `Login as ${SENTINEL}`,
      filePath: 'tests/login.yaml',
      testIndex: 0,
      outcome: 'failed',
      steps: [{
        stepIndex: 0,
        stepText: `Type ${SENTINEL} into the password field`,
        cacheStatus: 'miss',
        servedBrief: {
          scope: { tier: 'product', key: 'shop' },
          asOfBuild: 3,
          budget: 400,
          truncation: '',
          channel1: [{ id: 'rec-login' as never, kind: 'fact', summary: `password is ${SENTINEL}`,
            trust: 0.5, status: 'active', servedAsCanary: false, tier: 'context' }],
          channel2: [],
          channel3: [],
          briefDigest: 'brief-0',
        },
        subActions: [],
        verifierVerdict: { pass: false, reasoning: 'recorded reasoning' },
      }],
    }],
  }
  new FsHandoffStore({ root: join(root, '.agent-qa'), runId: RUN_ID }).save(handoff)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const rows: RunDetailRows = {
  runId: RUN_ID,
  members: [{ testIndex: 0, testId: 'test-login', attempts: 1 }],
  steps: [{ testIndex: 0, stepIndex: 0, stepText: `Type ${SENTINEL} into the password field`,
    cacheStatus: 'miss', verifierVerdict: { pass: false, reasoning: 'recorded reasoning' },
    selfHealOccurred: false, briefDigest: 'brief-0', status: 'failed' }],
  subActions: [],
}

function host(mask: MaskFn) {
  return composeLocalAgent({
    mask,
    agentQaRoot: join(root, '.agent-qa'),
    mintQuarantineIdentityPath: (path) => path,
    config: { getMasked: async () => ({ schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION, configPath: 'agent-qa.config.yaml', entries: [] }) },
    knowledgeRoot: () => join(root, 'knowledge'),
    model: () => { throw new Error('an overview read must not resolve a model') },
    resolveExecutionContext: () => 'local-headless',
    runDetail: { read: async () => rows },
  })
}

const redactor = new SecretRedactor(new SecretStore({ OVERVIEW_PASSWORD: SENTINEL }))
const declared: MaskFn = text => redactor.redactString(text)
const unreadable: MaskFn = () => { throw new Error(UNREADABLE) }

async function overviewThrough(composed: ReturnType<typeof host>): Promise<RunOverviewProjection> {
  return RunOverviewProjectionSchema.parse(
    await invokeFunction(composed.registry, 'runs.overview', { runId: RUN_ID }, READER))
}

function storedText(overview: RunOverviewProjection) {
  const [test] = overview.tests
  const [step] = test?.steps ?? []
  const records = step?.knowledge.state === 'recorded' ? step.knowledge.records : []
  return { name: test?.name.text, label: step?.label?.text, summary: records[0]?.summary?.text }
}

describe('OVERVIEW-COLD-SCOPE: runs.overview reads stored text under the cold read scope', () => {
  it('masks declared secrets in the cold overview and keeps the rest readable', async () => {
    const composed = host(declared)
    try {
      const overview = await overviewThrough(composed)
      expect(storedText(overview)).toEqual({
        name: `Login as ${REDACTED}`,
        label: `Type ${REDACTED} into the password field`,
        summary: `password is ${REDACTED}`,
      })
      expect(JSON.stringify(overview)).not.toContain(SENTINEL)
    } finally {
      await composed.close()
    }
    const cold = host(unreadable)
    try {
      await expect(overviewThrough(cold)).rejects.toThrow(UNREADABLE)
    } finally {
      await cold.close()
    }
  })

  it('masks the run list test names and never matches the title filter on a masked span', async () => {
    const listed = async (composed: ReturnType<typeof host>, input: Record<string, unknown>) =>
      RunsListOutputSchema.parse(await invokeFunction(composed.registry, 'runs.list', input, READER))
    const composed = host(declared)
    try {
      const rows = await listed(composed, {})
      expect(rows.map((row) => row.tests.map((test) => test.testName))).toEqual([[`Login as ${REDACTED}`]])
      expect(JSON.stringify(rows)).not.toContain(SENTINEL)
      expect(await listed(composed, { test: SENTINEL.slice(0, 12) })).toEqual([])
      expect((await listed(composed, { test: 'login as' })).map((row) => row.runId)).toEqual([RUN_ID])
    } finally {
      await composed.close()
    }
    const cold = host(unreadable)
    try {
      for (const input of [{}, { test: 'login' }, { test: SENTINEL.slice(0, 12) }, { test: 'test-login' }]) {
        await expect(listed(cold, input)).rejects.toThrow(UNREADABLE)
      }
    } finally {
      await cold.close()
    }
  })
})
