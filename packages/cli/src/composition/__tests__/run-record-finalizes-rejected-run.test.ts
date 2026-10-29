// The record through the shipped drive and producer, on a lent handle as a long-lived host lends its
// own: a run that rejects after its session started, and a queued run whose routes' attributes win
// over the producer's.

import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { DashboardDatabase } from '@vostride/agent-qa-dashboard'

import {
  createRunRecord,
  doorRunAttributes,
  produceMembersFromPatterns,
  resolveRunInvocationInputs,
} from '../../commands/run.js'
import type { ProducedCliRunMembers, RunRecordHostBinding } from '../../commands/run.js'
import { runInProcessCliRun } from '../in-process-run-execution.js'
import { composeRunOwnership } from '../run-owner-probe.js'
import {
  CountingTarget,
  createInProcessFixture,
  removeInProcessFixtures,
} from './in-process-run-fixture.js'
import { pinProcessTmpdir, removeTempRoots } from '../../__tests__/temp-roots.js'
import type { PinnedTmpdir } from '../../__tests__/temp-roots.js'

let pinnedTmpdir: PinnedTmpdir | undefined
beforeAll(() => { pinnedTmpdir = pinProcessTmpdir() })
afterAll(() => {
  pinnedTmpdir?.restore()
  if (pinnedTmpdir !== undefined) removeTempRoots([pinnedTmpdir.root])
})

type Fixture = ReturnType<typeof createInProcessFixture>
type RunAttributes = ReturnType<typeof doorRunAttributes>
type RunAttributeTrigger = Parameters<typeof doorRunAttributes>[0]

const RUN_BUDGET_MS = 180_000
const INCOMPLETE = 'but its dashboard record is incomplete'

const target = new CountingTarget()
const priorBrowsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH

beforeAll(async () => { await target.listen() })
afterAll(async () => {
  await target.close()
  if (priorBrowsersPath === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH
  else process.env.PLAYWRIGHT_BROWSERS_PATH = priorBrowsersPath
  removeInProcessFixtures()
})

function posixOnly(): void {
  if (process.platform === 'win32') throw new Error('POSIX run lifecycle required; never skip')
}

function fixture(): Fixture {
  const created = createInProcessFixture({ origin: target.origin, environment: 'local' })
  const browsersRoot = join(created.project, 'no-browsers')
  mkdirSync(browsersRoot, { recursive: true })
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersRoot
  return created
}

function openRunsDb(project: Fixture): DashboardDatabase {
  return new DashboardDatabase({
    dbPath: join(project.project, '.agent-qa', 'runs.db'),
    runOwnership: composeRunOwnership(),
  })
}

function failingUpdateRun(real: DashboardDatabase): { db: DashboardDatabase; reached: () => boolean } {
  let thrown = false
  const db = new Proxy(real, {
    get(subject, property, receiver) {
      const value = Reflect.get(subject, property, receiver) as unknown
      if (property === 'updateRun' && typeof value === 'function') {
        return (...args: unknown[]) => {
          if (!thrown) {
            thrown = true
            throw new Error('disk I/O error')
          }
          return (value as (...rest: unknown[]) => unknown).apply(subject, args)
        }
      }
      return typeof value === 'function' ? (value as (...rest: unknown[]) => unknown).bind(subject) : value
    },
  })
  return { db, reached: () => thrown }
}

function overriding<K extends keyof ProducedCliRunMembers>(
  produced: ProducedCliRunMembers,
  key: K,
  value: (produced: ProducedCliRunMembers) => ProducedCliRunMembers[K],
): ProducedCliRunMembers {
  const answer = value(produced)
  return new Proxy(produced, {
    get(subject, property) {
      return property === key ? answer : Reflect.get(subject, property, subject)
    },
  })
}

interface DriveInput {
  readonly project: Fixture
  readonly door: RunAttributeTrigger
  readonly pattern: string
  readonly host: RunRecordHostBinding
  readonly override: (produced: ProducedCliRunMembers) => ProducedCliRunMembers
}

async function drive(input: DriveInput): Promise<{ runId?: string; error?: unknown; warned: string[] }> {
  const warned: string[] = []
  let runId: string | undefined
  const runRecord = createRunRecord({
    attributes: doorRunAttributes(input.door),
    host: input.host,
    warn: (line) => { warned.push(line) },
  })
  try {
    await runInProcessCliRun({
      runRecord,
      configPath: input.project.configPath,
      agentQaRoot: input.project.agentQaRoot,
      executionContext: 'local-headless',
      onSession: (session) => { runId = session.id },
      produceMembers: async (context) => input.override(await produceMembersFromPatterns({
        inputs: await resolveRunInvocationInputs({
          configPath: input.project.configPath,
          patterns: [input.pattern],
        }),
        runId: context.runId,
        runRecord,
      })),
    }, { patterns: [input.pattern] })
    return { ...(runId === undefined ? {} : { runId }), warned }
  } catch (error) {
    return { ...(runId === undefined ? {} : { runId }), error, warned }
  } finally {
    runRecord.close()
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function finishedVerdict(project: Fixture, runId: string): string | undefined {
  const events = readFileSync(join(project.agentQaRoot, 'runs', runId, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { type: string; payload?: { aggregateVerdict?: string } })
  return events.find((event) => event.type === 'runFinished')?.payload?.aggregateVerdict
}

function statusOf(verdict: string): string {
  if (verdict === 'passed' || verdict === 'healed') return 'passed'
  if (verdict === 'skipped' || verdict === 'cancelled') return verdict
  return 'failed'
}

function incompleteLines(warned: readonly string[]): string[] {
  return warned.flatMap((line) => line.split('\n')).filter((line) => line.includes(INCOMPLETE))
}

const rejectingFinalize = (): ProducedCliRunMembers['finalize'] => async () => {
  throw new Error('producer finalize failed')
}

const PRODUCER_SEED: RunAttributes = {
  'agent-qa.trigger': 'cli',
  'agent-qa.runner': 'local',
  team: 'checkout',
}

describe('C443-RECORD-FLUSH', () => {
  it('a run that rejects after its session started still finalizes its record', async () => {
    posixOnly()
    const project = fixture()
    const real = openRunsDb(project)
    try {
      const outcome = await drive({
        project,
        door: 'cli',
        pattern: project.testPattern,
        host: { db: real, queueRun: () => undefined },
        override: (produced) => overriding(produced, 'finalize', rejectingFinalize),
      })

      expect(messageOf(outcome.error)).toBe('producer finalize failed')
      expect(outcome.runId, 'the drive reported no session').toBeDefined()
      const verdict = finishedVerdict(project, outcome.runId!)
      expect(verdict, 'the run published no runFinished').toBeDefined()
      expect(real.getRun(outcome.runId!)?.status).toBe(statusOf(verdict!))
      expect(real.getRunArtifact(outcome.runId!)?.finalizedAt ?? undefined, 'the record was never finalized')
        .toBeDefined()
      expect(incompleteLines(outcome.warned), `incomplete-record lines: ${outcome.warned.join(' | ')}`)
        .toEqual([])
    } finally {
      real.close()
    }
  }, RUN_BUDGET_MS)

  it('a rejected run whose write failed leaves no running row it owns', async () => {
    posixOnly()
    const project = fixture()
    const real = openRunsDb(project)
    try {
      const failing = failingUpdateRun(real)
      const outcome = await drive({
        project,
        door: 'cli',
        pattern: project.testPattern,
        host: { db: failing.db, queueRun: () => undefined },
        override: (produced) => overriding(produced, 'finalize', rejectingFinalize),
      })

      expect(messageOf(outcome.error)).toBe('producer finalize failed')
      expect(outcome.runId, 'the drive reported no session').toBeDefined()
      expect(failing.reached(), 'the failing write was never reached').toBe(true)
      const verdict = finishedVerdict(project, outcome.runId!)
      expect(verdict, 'the run published no runFinished').toBeDefined()
      expect(real.getRun(outcome.runId!)?.status).toBe(statusOf(verdict!))
      expect(real.readRunOwner(outcome.runId!)?.pid, 'the row is not owned by this process').toBe(process.pid)
      const incomplete = incompleteLines(outcome.warned)
      expect(incomplete.length, `incomplete-record lines: ${outcome.warned.join(' | ')}`).toBe(1)
    } finally {
      real.close()
    }
  }, RUN_BUDGET_MS)
})

describe('C443-RECORD-RUNNER', () => {
  it("a queued run keeps its routes' attributes over the producer's", async () => {
    posixOnly()
    const project = fixture()
    const real = openRunsDb(project)
    const queued: RunAttributes = { 'agent-qa.trigger': 'dashboard', 'agent-qa.runner': 'local' }
    try {
      const outcome = await drive({
        project,
        door: 'mcp',
        pattern: project.suitePattern,
        host: { db: real, queueRun: () => ({ attributes: queued }) },
        override: (produced) => overriding(produced, 'subscriberSeed', (shipped) => ({
          ...shipped.subscriberSeed,
          attributes: PRODUCER_SEED,
        })),
      })

      expect(outcome.runId, `the drive reported no session: ${messageOf(outcome.error)}`).toBeDefined()
      expect(real.getRun(outcome.runId!)?.attributes).toEqual(queued)
    } finally {
      real.close()
    }
  }, RUN_BUDGET_MS)
})
