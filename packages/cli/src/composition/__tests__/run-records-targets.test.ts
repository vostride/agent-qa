// A run records the targets its tests ran on, and listing runs by target finds it. A run must
// start and complete to leave a handoff, so these cells need a real browser and run in a file of
// their own: `in-process-run-execution.test.ts` pins PLAYWRIGHT_BROWSERS_PATH to an empty root, and
// playwright-core reads it once per process. The member then fails on the fixture's unreachable
// model, and the run still completes.

import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { afterAll, afterEach, describe, expect, it } from 'vitest'

import { createFunctionRegistry, invokeFunction } from '@vostride/agent-qa-agent'
import { createRunsReader } from '@vostride/agent-qa-agent-local'
import type { FunctionCaller, RunSummary } from '@vostride/agent-qa-schema'

import { runInProcessCliRun } from '../in-process-run-execution.js'
import {
  CountingTarget,
  IN_PROCESS_TARGET_NAME,
  closeTestRunRecords,
  createInProcessFixture,
  removeInProcessFixtures,
  runDirs,
  testRunRecord,
} from './in-process-run-fixture.js'
import type { InProcessFixture, InProcessFixtureInput } from './in-process-run-fixture.js'

afterEach(() => { closeTestRunRecords() })
afterAll(() => { removeInProcessFixtures() })

const READER: FunctionCaller = { surface: 'test', origin: 'agent' }

async function runFixture(
  input: Omit<InProcessFixtureInput, 'origin'>,
  pattern: (fixture: InProcessFixture) => string,
): Promise<InProcessFixture> {
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
        },
        { patterns: [pattern(fixture)] },
      )
    } catch { /* a framework error still leaves the completed run */ }
    return fixture
  } finally {
    await target.close()
  }
}

async function listedByTarget(fixture: InProcessFixture, target: string): Promise<string[]> {
  const registry = createFunctionRegistry({
    deps: {
      secretMask: (text: string) => text,
      runs: createRunsReader(fixture.agentQaRoot),
    } as never,
  })
  const rows = await invokeFunction(registry, 'runs.list', { target }, READER) as RunSummary[]
  return rows.map((row) => row.runId)
}

function onlyRun(fixture: InProcessFixture): { runId: string; artifactText: string } {
  const dirs = runDirs(fixture as never)
  expect(dirs).toHaveLength(1)
  return {
    runId: basename(dirs[0]!),
    artifactText: readFileSync(join(dirs[0]!, 'artifact.json'), 'utf8'),
  }
}

describe('a run records the targets its tests ran on', () => {
  it('a test run is found by the target it ran on, and its artifact holds the masked source and the target only', async () => {
    const planted = 'zq7-recorded-target-planted-secret'
    const fixture = await runFixture(
      { plantedSecret: planted, stepText: `Type ${planted} into the search box` },
      (made) => made.testPattern,
    )

    const { runId, artifactText } = onlyRun(fixture)
    expect(await listedByTarget(fixture, IN_PROCESS_TARGET_NAME)).toEqual([runId])
    expect(await listedByTarget(fixture, 'no-such-target')).toEqual([])

    const artifact = JSON.parse(artifactText) as Record<string, unknown>
    expect(Object.keys(artifact).sort()).toEqual(['finalizedAt', 'schemaVersion', 'source', 'targets'])
    expect(artifact.targets).toEqual([IN_PROCESS_TARGET_NAME])
    expect((artifact.source as { kind?: unknown }).kind).toBe('test')
    expect(artifactText).not.toContain(planted)
  }, 120_000)
})
