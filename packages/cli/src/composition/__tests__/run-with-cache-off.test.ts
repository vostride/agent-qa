// A step must start and finalize for its cache status to be recorded, so these cells need a real
// browser and run in a file of their own: `in-process-run-execution.test.ts` pins
// PLAYWRIGHT_BROWSERS_PATH to an empty root, and playwright-core reads it once per process. The
// member then fails on the fixture's unreachable model, and its step still finalizes.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, afterEach, describe, expect, it } from 'vitest'

import type { RunEventEnvelope, StepFinalizedPayload } from '@vostride/agent-qa-schema'

import { runInProcessCliRun } from '../in-process-run-execution.js'
import type { InProcessCliRunExecutionOptions } from '../in-process-run-execution.js'
import {
  CountingTarget,
  closeTestRunRecords,
  createInProcessFixture,
  removeInProcessFixtures,
  runDirs,
  testRunRecord,
} from './in-process-run-fixture.js'

afterEach(() => { closeTestRunRecords() })
afterAll(() => { removeInProcessFixtures() })

function finalizedCacheStatuses(fixture: { project: string }): StepFinalizedPayload['cacheStatus'][] {
  return runDirs(fixture as never).flatMap((dir) => {
    const path = join(dir, 'events.jsonl')
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as RunEventEnvelope)
      .filter((event) => event.type === 'stepFinalized')
      .map((event) => (event.payload as StepFinalizedPayload).cacheStatus)
  })
}

async function runCacheStatuses(
  input: { cacheOff?: boolean },
  options: Partial<InProcessCliRunExecutionOptions> = {},
): Promise<StepFinalizedPayload['cacheStatus'][]> {
  const target = new CountingTarget()
  await target.listen()
  try {
    const fixture = createInProcessFixture({ origin: target.origin, environment: 'local', ...input })
    try {
      await runInProcessCliRun(
        {
          runRecord: testRunRecord(),
          configPath: fixture.configPath,
          agentQaRoot: fixture.agentQaRoot,
          executionContext: 'local-headless',
          ...options,
        },
        { patterns: [fixture.testPattern] },
      )
    } catch { /* a framework error still leaves the started run's log */ }
    return finalizedCacheStatuses(fixture)
  } finally {
    await target.close()
  }
}

describe('a run with the cache off records its steps as disabled', () => {
  it("a run whose config sets use.cache false records every step's cache as disabled", async () => {
    const statuses = await runCacheStatuses({ cacheOff: true })
    expect(statuses.length).toBeGreaterThan(0)
    expect(new Set(statuses)).toEqual(new Set(['disabled']))
  }, 120_000)

  it("a run started with the cache disabled by flag records every step's cache as disabled", async () => {
    const statuses = await runCacheStatuses({}, { resolveRunFlags: () => ({ disableCache: true }) })
    expect(statuses.length).toBeGreaterThan(0)
    expect(new Set(statuses)).toEqual(new Set(['disabled']))
  }, 120_000)

  it('the same test with the cache on records a miss', async () => {
    const statuses = await runCacheStatuses({})
    expect(statuses.length).toBeGreaterThan(0)
    expect(new Set(statuses)).toEqual(new Set(['miss']))
  }, 120_000)
})
