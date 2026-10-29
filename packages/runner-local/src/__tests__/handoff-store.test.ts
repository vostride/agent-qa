// `handoff.json` beside `events.jsonl`; a newer schema version is rejected with a typed error.
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FsHandoffStore, loadCompletedRunHandoff } from '../handoff-store.js'
import { slugBranch } from '../branch-resolver.js'
import { RUNS_SUBDIR } from '../event-log.js'
import { asRecordId, CURRENT_HANDOFF_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type {
  CompletedRunHandoff,
  StepPlanSource,
} from '@vostride/agent-qa-schema'

function makeHandoff(schemaVersion = CURRENT_HANDOFF_SCHEMA_VERSION): CompletedRunHandoff {
  return {
    schemaVersion,
    runId: 'run-1' as CompletedRunHandoff['runId'],
    scope: { tier: 'suite', key: 'checkout' },
    buildOrdinal: 1,
    executionContext: 'ci',
    aggregateVerdict: 'passed',
    configDigests: { suiteConfigDigest: 'suite-d', testConfigDigest: 'test-d' },
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_010_000,
    tests: [],
  }
}

function makeHandoffWithStep(): CompletedRunHandoff {
  const handoff = makeHandoff()
  handoff.tests = [{
    testId: 'local-form-1',
    testName: 'local form',
    filePath: 'suite/local-form.test.ts',
    testIndex: 0,
    outcome: 'passed',
    steps: [{
      stepIndex: 2,
      stepText: 'Verify the confirmation page',
      cacheStatus: 'miss',
      servedBrief: {
        scope: { tier: 'suite', key: 'checkout' },
        asOfBuild: 1,
        budget: 128,
        truncation: 'none',
        channel1: [],
        channel2: [],
        channel3: [],
        briefDigest: 'brief-digest',
      },
      subActions: [],
      verifierVerdict: { pass: true, reasoning: 'confirmation observed' },
    }],
  }]
  return handoff
}

const COMPLETE_REPLAY_SOURCE: StepPlanSource = {
  kind: 'procedure-replay',
  procedureId: asRecordId('procedure-flow-local-form'),
  guard: { checksPassed: 1, total: 1 },
  flow: { cursor: 1, length: 2 },
}

const PLAN_SOURCE_PERSISTENCE_CASES = [
  { name: 'omitted member', shape: 'absent', accepted: true },
  { name: 'complete procedure-replay member', shape: 'replay', accepted: true },
  { name: 'explicit JSON null', shape: 'null', accepted: false },
] as const

describe('FsHandoffStore + loadCompletedRunHandoff', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fs-handoff-store-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('save writes handoff.json beside events.jsonl and round-trips a v2 document', async () => {
    const store = new FsHandoffStore({ root, runId: 'run-1' })
    const handoff = makeHandoff()
    await store.save(handoff)

    const file = join(root, RUNS_SUBDIR, slugBranch('run-1'), 'handoff.json')
    const loaded = await loadCompletedRunHandoff(file)
    expect(loaded).toEqual(handoff)
  })

  it.each(PLAN_SOURCE_PERSISTENCE_CASES)(
    'planSource persistence matrix: $name',
    async ({ shape, accepted }) => {
      const store = new FsHandoffStore({ root, runId: 'run-1' })
      const handoff = makeHandoffWithStep()
      const step = handoff.tests[0]!.steps[0]!

      if (shape === 'replay') {
        step.planSource = COMPLETE_REPLAY_SOURCE
      } else if (shape === 'null') {
        const invalidStep = step as unknown as { planSource: null }
        invalidStep.planSource = null
      }

      await store.save(handoff)
      const file = join(root, RUNS_SUBDIR, slugBranch('run-1'), 'handoff.json')
      const serialized = JSON.parse(await readFile(file, 'utf8')) as CompletedRunHandoff
      const serializedStep = serialized.tests[0]!.steps[0]!

      expect(Object.hasOwn(serializedStep, 'planSource')).toBe(shape !== 'absent')
      if (shape === 'absent') {
        expect(serializedStep.planSource).toBeUndefined()
      } else if (shape === 'replay') {
        expect(serializedStep.planSource).toEqual(COMPLETE_REPLAY_SOURCE)
      } else {
        expect(serializedStep.planSource).toBeNull()
      }

      if (!accepted) {
        expect(() => loadCompletedRunHandoff(file)).toThrow(TypeError)
        expect(() => loadCompletedRunHandoff(file)).toThrow(
          'CompletedRunHandoff failed structural validation',
        )
        return
      }

      const loaded = await loadCompletedRunHandoff(file)
      const loadedStep = loaded.tests[0]!.steps[0]!
      expect(Object.hasOwn(loadedStep, 'planSource')).toBe(shape === 'replay')
      expect(loadedStep.planSource).toEqual(
        shape === 'replay' ? COMPLETE_REPLAY_SOURCE : undefined,
      )
    },
  )

  it('loadCompletedRunHandoff rejects a pre-instrumentation schemaVersion 1 document', async () => {
    const dir = join(root, RUNS_SUBDIR, slugBranch('run-1'))
    await mkdir(dir, { recursive: true })
    const file = join(dir, 'handoff.json')
    await writeFile(file, JSON.stringify(makeHandoff(1)), 'utf8')

    let thrown: unknown
    try {
      await loadCompletedRunHandoff(file)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeDefined()
    expect((thrown as { name: string }).name).toBe('HandoffVersionError')
    expect((thrown as { foundVersion: number }).foundVersion).toBe(1)
    expect((thrown as { supportedVersion: number }).supportedVersion).toBe(
      CURRENT_HANDOFF_SCHEMA_VERSION,
    )
  })
})
