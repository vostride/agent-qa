import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { reserveStdoutForData } from '@vostride/agent-qa-core/run-text-output'
import { CURRENT_BUS_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type {
  RunEventEnvelope,
  RunEventType,
  RunStartedPayload,
  TestStartedPayload,
} from '@vostride/agent-qa-schema'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { pinProcessTmpdir, removeTempRoots } from '../../__tests__/temp-roots.js'
import type { PinnedTmpdir } from '../../__tests__/temp-roots.js'
import { produceMembersFromPatterns, resolveRunInvocationInputs } from '../../commands/run.js'
import type { KnowledgeSummary } from '../../curation/knowledge-summary.js'
import { runInProcessCliRun } from '../in-process-run-execution.js'
import type { RunSubscriberAttachInput, RunMemberProducer } from '../in-process-run-execution.js'
import { composeDoorOutput } from '../local-agent-host.js'
import {
  CountingTarget,
  closeTestRunRecords,
  createInProcessFixture,
  removeInProcessFixtures,
  testRunRecord,
} from './in-process-run-fixture.js'
import type { InProcessFixture } from './in-process-run-fixture.js'

const RUN_ID = 'run-fixture-1'
const SUMMARY: KnowledgeSummary = { runId: RUN_ID, learned: 2, held: 1, proposed: 0, items: [] }
const TIME_AND_TAG = (tag: string): string => `^\\d\\d:\\d\\d:\\d\\d {2}${tag} +`

function plain(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

function envelope(type: RunEventType, payload: unknown): RunEventEnvelope {
  return { seq: 0, ts: 1_000, runId: RUN_ID, type, payload } as RunEventEnvelope
}

function runStart(): RunEventEnvelope[] {
  const started: RunStartedPayload = {
    busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION,
    scope: { tier: 'test', key: 'cart' },
    executionContext: 'local-headless',
    buildOrdinal: 1,
    configDigests: { suiteConfigDigest: 'aaaa', testConfigDigest: 'bbbb' },
    memberTestCount: 1,
  }
  const test: TestStartedPayload = {
    testId: 't0',
    testIndex: 0,
    name: 'Cart total',
    filePath: 'tests/cart.yaml',
  }
  return [envelope('runStarted', started), envelope('testStarted', test)]
}

interface Captured {
  readonly consoleLog: string[]
  readonly consoleWarn: string[]
  readonly consoleError: string[]
  readonly stdout: string[]
  readonly stderr: string[]
}

function capture(): Captured {
  const captured: Captured = {
    consoleLog: [],
    consoleWarn: [],
    consoleError: [],
    stdout: [],
    stderr: [],
  }
  vi.spyOn(console, 'log').mockImplementation((value: unknown) => {
    captured.consoleLog.push(plain(String(value)))
  })
  vi.spyOn(console, 'warn').mockImplementation((value: unknown) => {
    captured.consoleWarn.push(plain(String(value)))
  })
  vi.spyOn(console, 'error').mockImplementation((value: unknown) => {
    captured.consoleError.push(plain(String(value)))
  })
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    captured.stdout.push(plain(String(chunk)))
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    captured.stderr.push(plain(String(chunk)))
    return true
  })
  return captured
}

function consoleCalls(captured: Captured): number {
  return captured.consoleLog.length + captured.consoleWarn.length + captured.consoleError.length
}

function expectOneGuardedBlock(written: readonly string[], body: RegExp): void {
  expect(written, JSON.stringify(written)).toHaveLength(1)
  const block = written[0]!
  const token = /^::stop-commands::([0-9a-f]+)\n/u.exec(block)?.[1]
  expect(token, block).toBeDefined()
  expect(block.endsWith(`::${token}::\n`), block).toBe(true)
  expect(block.split('\n').slice(1, -2).join('\n'), block).toMatch(body)
}

let pinnedTmpdir: PinnedTmpdir | undefined
const tempDirs: string[] = []

beforeAll(() => {
  pinnedTmpdir = pinProcessTmpdir()
})

beforeEach(() => {
  vi.stubEnv('GITHUB_ACTIONS', '')
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  closeTestRunRecords()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

afterAll(() => {
  removeInProcessFixtures()
  pinnedTmpdir?.restore()
  if (pinnedTmpdir !== undefined) removeTempRoots([pinnedTmpdir.root])
})

describe('a door whose host did not ask for terminal lines', () => {
  it('prints its warnings and the plain Knowledge summary on stderr, and nothing on stdout', () => {
    const output = composeDoorOutput(undefined)
    const captured = capture()

    output.warn('The run record could not be opened')
    output.tailLog.summary?.(SUMMARY)
    output.tailLog.summary?.({
      ...SUMMARY,
      unfinished: { notWritten: 0, resume: 'resumes on a later local run' },
    })

    expect(captured.consoleWarn).toEqual([
      'The run record could not be opened',
      'Knowledge: learned 2, held 1',
      'Knowledge: learned 2, held 1\n  not finished, resumes on a later local run',
    ])
    expect(captured.consoleLog).toEqual([])
    expect(captured.stdout).toEqual([])
    expect('detail' in output.tailLog).toBe(false)
    expect(output.runLines).toBeUndefined()
  })

  it('under GitHub Actions, while stdout carries data, prints each as one guarded block on stderr', () => {
    vi.stubEnv('GITHUB_ACTIONS', 'true')
    const output = composeDoorOutput(undefined)
    const captured = capture()
    const release = reserveStdoutForData()

    try {
      output.warn('The run record could not be opened')
      expectOneGuardedBlock(captured.stderr.splice(0), /^The run record could not be opened$/u)
      output.tailLog.summary?.(SUMMARY)
      expectOneGuardedBlock(captured.stderr.splice(0), /^Knowledge: learned 2, held 1$/u)
    } finally {
      release()
    }

    expect(captured.stdout).toEqual([])
    expect(consoleCalls(captured)).toBe(0)
  })
})

describe('a door whose host asked for terminal lines', () => {
  it('tags its warnings run, prints the summary as a knowledge line, and gives run lines', () => {
    const output = composeDoorOutput({ logLevel: 'warn' })
    const captured = capture()

    output.warn('The run record could not be opened')
    output.tailLog.warn('A quarantined test is still failing')
    output.tailLog.detail?.('digest — run run-fixture-1', 'post-run')
    output.tailLog.summary?.(SUMMARY)
    const reporter = output.runLines?.({ platforms: ['ios'] })
    for (const event of runStart()) reporter?.handler(event)

    expect(captured.consoleWarn).toHaveLength(2)
    expect(captured.consoleWarn[0]).toMatch(
      new RegExp(`${TIME_AND_TAG('run')}The run record could not be opened$`, 'u'),
    )
    expect(captured.consoleWarn[1]).toMatch(
      new RegExp(`${TIME_AND_TAG('post-run')}A quarantined test is still failing$`, 'u'),
    )
    expect(captured.consoleLog).toHaveLength(2)
    expect(captured.consoleLog[0]).toMatch(
      new RegExp(`${TIME_AND_TAG('knowledge')}Learned 2, held 1 · run-fixture$`, 'u'),
    )
    expect(captured.consoleLog[1]).toMatch(
      new RegExp(`${TIME_AND_TAG('run')}▶ Cart total · ios · run-fixture$`, 'u'),
    )
  })

  it('prints the detail lines at debug', () => {
    const output = composeDoorOutput({ logLevel: 'debug' })
    const captured = capture()

    output.tailLog.detail?.('digest — run run-fixture-1', 'post-run')

    expect(captured.consoleLog).toHaveLength(1)
    expect(captured.consoleLog[0]).toMatch(
      new RegExp(`${TIME_AND_TAG('post-run')}digest — run run-fixture-1$`, 'u'),
    )
  })

  it('under GitHub Actions, prints each line as one guarded block and calls no console method', () => {
    vi.stubEnv('GITHUB_ACTIONS', 'true')
    const output = composeDoorOutput({ logLevel: 'warn' })
    const captured = capture()

    output.warn('The run record could not be opened')
    expectOneGuardedBlock(
      captured.stdout.splice(0),
      new RegExp(`${TIME_AND_TAG('run')}The run record could not be opened$`, 'u'),
    )
    output.tailLog.summary?.(SUMMARY)
    expectOneGuardedBlock(
      captured.stdout.splice(0),
      new RegExp(`${TIME_AND_TAG('knowledge')}Learned 2, held 1 · run-fixture$`, 'u'),
    )
    const reporter = output.runLines?.({ platforms: ['ios'] })
    for (const event of runStart()) reporter?.handler(event)
    expectOneGuardedBlock(
      captured.stdout.splice(0),
      new RegExp(`${TIME_AND_TAG('run')}▶ Cart total · ios · run-fixture$`, 'u'),
    )

    expect(consoleCalls(captured)).toBe(0)
  })
})

describe('the platforms a door is handed', () => {
  function fixtureOptions(fixture: InProcessFixture) {
    // An empty browsers root, so the member fails the same way on every machine.
    const browsersRoot = join(fixture.project, 'no-browsers')
    if (!existsSync(browsersRoot)) mkdirSync(browsersRoot, { recursive: true })
    vi.stubEnv('PLAYWRIGHT_BROWSERS_PATH', browsersRoot)
    return { configPath: fixture.configPath, agentQaRoot: fixture.agentQaRoot }
  }

  async function attachInputOf(
    fixture: InProcessFixture,
    produceMembers?: RunMemberProducer,
  ): Promise<RunSubscriberAttachInput | undefined> {
    let attached: RunSubscriberAttachInput | undefined
    try {
      await runInProcessCliRun(
        {
          runRecord: testRunRecord(),
          ...fixtureOptions(fixture),
          executionContext: 'local-headless',
          ...(produceMembers === undefined ? {} : { produceMembers }),
          subscribers: (input) => {
            attached = input
            return undefined
          },
        },
        { patterns: [fixture.testPattern] },
      )
    } catch {
      // The member's framework error on the empty browsers root.
    }
    return attached
  }

  it('hands the subscribers the run platforms when the producer knows them, and none when it does not', async () => {
    const dataHome = mkdtempSync(join(tmpdir(), 'agent-qa-door-lines-auth-'))
    tempDirs.push(dataHome)
    vi.stubEnv('XDG_DATA_HOME', dataHome)
    const target = new CountingTarget()
    await target.listen()
    try {
      const known = await attachInputOf(
        createInProcessFixture({ origin: target.origin, environment: 'local' }),
      )
      expect(known?.platforms).toEqual(['web'])

      const unknown = await attachInputOf(
        createInProcessFixture({ origin: target.origin, environment: 'local' }),
        async (context) => {
          const { platforms: _platforms, ...produced } = await produceMembersFromPatterns({
            inputs:
              context.inputs ??
              (await resolveRunInvocationInputs({
                configPath: context.configPath,
                ...(context.request.patterns === undefined
                  ? {}
                  : { patterns: context.request.patterns }),
              })),
            runId: context.runId,
          })
          return produced
        },
      )
      expect(unknown).toBeDefined()
      expect(unknown !== undefined && 'platforms' in unknown).toBe(false)
    } finally {
      await target.close()
    }
  }, 120_000)
})
