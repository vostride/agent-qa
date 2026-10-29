// G-428-2 (owner decision 2026-09-26 (2)): a recorded in-process run's testStarted carries the texts
// its member's steps are announced with.
//
// WHY A FILE OF ITS OWN. A step must START for stepStarted to be recorded, so this cell needs a real
// browser. `in-process-run-execution.test.ts` pins PLAYWRIGHT_BROWSERS_PATH to an empty root so its
// members fail before any step, and playwright-core reads that variable ONCE, when its registry
// module loads. A cell in that file cannot undo the pin; a file of its own runs in its own fork and
// resolves the machine's browsers. The member then fails on the fixture's unreachable model, which
// this cell does not read.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, afterEach, describe, expect, it } from 'vitest'

import type { RunEventEnvelope } from '@vostride/agent-qa-schema'

import { runInProcessCliRun } from '../in-process-run-execution.js'
import {
  CountingTarget,
  createInProcessFixture,
  runDirs,
  removeInProcessFixtures,
} from './in-process-run-fixture.js'
import { closeTestRunRecords, testRunRecord } from './in-process-run-fixture.js'

// every drive call carries a record; each cell closes the ones it opened.
afterEach(() => { closeTestRunRecords() })
afterAll(() => { removeInProcessFixtures() })

function eventEnvelopes(fixture: { project: string }): RunEventEnvelope[] {
  return runDirs(fixture as never).flatMap((dir) => {
    const path = join(dir, 'events.jsonl')
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as RunEventEnvelope)
  })
}

describe('the recorded run announces its step texts at testStarted', () => {
  it('STEP-TEXTS-RIDE-TESTSTARTED', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({ origin: target.origin, environment: 'local' })
      try {
        await runInProcessCliRun(
          { runRecord: testRunRecord(), configPath: fixture.configPath, agentQaRoot: fixture.agentQaRoot, executionContext: 'local-headless' },
          { patterns: [fixture.testPattern] },
        )
      } catch { /* a framework error still leaves the started run's log */ }

      const envelopes = eventEnvelopes(fixture)
      const testStarted = envelopes.filter((event) => event.type === 'testStarted')
      expect(testStarted).toHaveLength(1)
      const started = testStarted[0]!.payload as { testIndex: number; stepTexts?: readonly string[] }
      const announced = envelopes
        .filter((event) => event.type === 'stepStarted')
        .map((event) => event.payload as { testIndex: number; stepIndex: number; stepText: string })
        .filter((payload) => payload.testIndex === started.testIndex)
        .sort((a, b) => a.stepIndex - b.stepIndex)
        .map((payload) => payload.stepText)
      expect(announced.length).toBeGreaterThan(0)
      expect(started.stepTexts).toEqual(announced)
    } finally {
      await target.close()
    }
  }, 120_000)
})
