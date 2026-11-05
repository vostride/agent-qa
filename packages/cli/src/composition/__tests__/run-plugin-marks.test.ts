// A path plugin that declares started, end and every run fact learns how each of its sessions
// went before agent-qa releases it, and the run prints the link it returns as the test starts.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { Command } from 'commander'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import { DashboardDatabase } from '@vostride/agent-qa-dashboard'
import { writeScriptedPlugin } from '@vostride/agent-qa-plugin-kit/testing'

import { createRunCommand } from '../../commands/run.js'
import { pinProcessTmpdir, removeTempRoots } from '../../__tests__/temp-roots.js'
import type { PinnedTmpdir } from '../../__tests__/temp-roots.js'
import {
  POPULATED_DECLARED_SECRET_VALUE,
  POPULATED_MODEL_ID,
  POPULATED_PASSING_STEP_TEXT,
  startStubModelServer,
  startTargetPageServer,
} from '../../__tests__/conformance/populated-run-fixture.js'
import type { StubModelServerOptions } from '../../__tests__/conformance/populated-run-fixture.js'
import {
  createInProcessFixture,
  freshUpdateCheckHome,
  removeInProcessFixtures,
} from './in-process-run-fixture.js'
import type { InProcessFixture, InProcessFixtureInput } from './in-process-run-fixture.js'
import { refuseWithoutChromium, startRemoteBrowserEndpoint } from './remote-browser-endpoint.js'

const RUN_BUDGET_MS = 180_000
const REMOTE_NAME = 'lab-chrome'
const ENTRY_NAME = 'lab'
const LINK = 'https://lab.invalid/sessions/1'
const DIRECT_TEST_NAME = 'the standalone test'

type LedgerLine = Record<string, unknown> & { method: string }

let pinnedTmpdir: PinnedTmpdir | undefined
beforeAll(() => {
  refuseWithoutChromium()
  pinnedTmpdir = pinProcessTmpdir()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})
afterAll(() => {
  removeInProcessFixtures()
  pinnedTmpdir?.restore()
  if (pinnedTmpdir !== undefined) removeTempRoots([pinnedTmpdir.root])
})

function plain(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

// The fixture's url remote becomes a remote that names a path plugins entry under the same pick.
function placeOnPlugin(project: InProcessFixture, wsEndpoint: string): string {
  writeScriptedPlugin(join(project.project, 'tools', ENTRY_NAME), {
    methods: ['started', 'end'],
    runFacts: ['testName', 'runId', 'failure'],
  })
  const ledgerFile = join(project.project, 'plugin-ledger.jsonl')
  const config = parseYaml(readFileSync(project.configPath, 'utf8')) as {
    registry: { remotes?: unknown }
    plugins?: unknown
  }
  config.registry.remotes = [{ name: REMOTE_NAME, plugin: ENTRY_NAME }]
  config.plugins = [
    {
      name: ENTRY_NAME,
      path: `./tools/${ENTRY_NAME}`,
      options: {
        answer: { protocol: 'playwright', url: wsEndpoint },
        ledgerFile,
        recordProcess: true,
        recordParams: true,
        started: { link: LINK },
      },
    },
  ]
  writeFileSync(project.configPath, stringifyYaml(config))
  return ledgerFile
}

function ledgerOf(ledgerFile: string): LedgerLine[] {
  if (!existsSync(ledgerFile)) return []
  return readFileSync(ledgerFile, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as LedgerLine)
}

function lineOf(ledger: readonly LedgerLine[], method: string): LedgerLine | undefined {
  return ledger.find((line) => line.method === method)
}

interface StoredRun {
  id: string
  members: Array<{ outcome: unknown; failureSummary: string | null | undefined }>
}

function storedRuns(project: InProcessFixture): StoredRun[] {
  const db = new DashboardDatabase({ dbPath: join(project.agentQaRoot, 'runs.db') })
  try {
    return db.getRuns({}).map((run) => ({
      id: run.id,
      members: (db.readRunDetailRows(run.id)?.members ?? []).map((member) => ({
        outcome: member.outcome,
        failureSummary: member.failureSummary,
      })),
    }))
  } finally {
    db.close()
  }
}

interface MarkedRun {
  exitCode: unknown
  log: string
  printed: readonly string[]
  ledger: LedgerLine[]
  runs: StoredRun[]
}

async function runOnPlugin(
  pattern: (project: InProcessFixture) => string,
  knobs: Partial<InProcessFixtureInput> = {},
  model: StubModelServerOptions = {},
): Promise<MarkedRun> {
  const page = await startTargetPageServer()
  const stub = await startStubModelServer(model)
  const endpoint = await startRemoteBrowserEndpoint()
  try {
    const project = createInProcessFixture({
      origin: page.url,
      environment: 'local',
      stepText: POPULATED_PASSING_STEP_TEXT,
      model: { baseUrl: stub.baseUrl, id: POPULATED_MODEL_ID },
      remote: { name: REMOTE_NAME, protocol: 'playwright', url: endpoint.wsEndpoint },
      ...knobs,
    })
    const ledgerFile = placeOnPlugin(project, endpoint.wsEndpoint)
    vi.stubEnv('HOME', freshUpdateCheckHome())
    const printed: string[] = []
    let exited = false
    const keep = (...args: unknown[]): void => {
      if (!exited) printed.push(plain(args.map(String).join(' ')))
    }
    vi.spyOn(console, 'log').mockImplementation(keep)
    vi.spyOn(console, 'warn').mockImplementation(keep)
    vi.spyOn(console, 'error').mockImplementation(keep)
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      exited = true
      throw new Error('fixture command exit')
    })

    const program = new Command().option('--config <path>').addCommand(createRunCommand())
    await expect(
      program.parseAsync(['--config', project.configPath, 'run', pattern(project)], {
        from: 'user',
      }),
    ).rejects.toThrow('fixture command exit')

    const ledger = ledgerOf(ledgerFile)
    return {
      exitCode: exit.mock.calls[0]?.[0],
      log: `${JSON.stringify(ledger)}\n${printed.join('\n')}`,
      printed,
      ledger,
      runs: storedRuns(project),
    }
  } finally {
    await endpoint.close()
    await stub.close()
    await page.close()
  }
}

describe('a plugin that declares started, end and every run fact', () => {
  it("is told a passing test passed before its session is released, and the run prints the session's link as the test starts", async () => {
    const run = await runOnPlugin((project) => project.testPattern)

    expect(run.exitCode, run.log).toBe(0)
    expect(
      run.ledger.map((line) => line.method),
      run.log,
    ).toEqual(['initialize', 'acquire', 'started', 'end', 'release', 'shutdown'])
    const end = lineOf(run.ledger, 'end')
    expect(end?.outcome, run.log).toBe('passed')
    expect(end, run.log).not.toHaveProperty('reason')
    expect(lineOf(run.ledger, 'acquire')?.run, run.log).toEqual({ testName: DIRECT_TEST_NAME })
    expect(lineOf(run.ledger, 'acquire')?.session, run.log).toEqual({
      platform: 'web',
      engine: 'chromium',
      context: 'new',
    })
    expect(run.runs.map((stored) => stored.id), run.log).toHaveLength(1)
    expect(lineOf(run.ledger, 'initialize')?.runFacts, run.log).toEqual({
      runId: run.runs[0]?.id,
    })
    expect(
      run.printed.filter((line) => line.includes(`Remote ${REMOTE_NAME}: ${LINK}`)),
      run.log,
    ).toHaveLength(1)
  }, RUN_BUDGET_MS)

  it("is told a failing test failed, with the masked first line of the test's failure", async () => {
    const run = await runOnPlugin(
      (project) => project.testPattern,
      { plantedSecret: POPULATED_DECLARED_SECRET_VALUE },
      { plannerOutcome: 'stepFailed' },
    )

    expect(run.exitCode, run.log).toBe(1)
    const summary = run.runs[0]?.members[0]?.failureSummary ?? ''
    expect(summary, run.log).not.toBe('')
    const end = lineOf(run.ledger, 'end')
    expect(end?.outcome, run.log).toBe('failed')
    expect(end?.reason, run.log).toBe(summary.split(/\r?\n/, 1)[0]?.trim())
    expect(JSON.stringify(run.ledger), run.log).not.toContain(POPULATED_DECLARED_SECRET_VALUE)
    expect(
      run.ledger.map((line) => line.method),
      run.log,
    ).toEqual(['initialize', 'acquire', 'started', 'end', 'release', 'shutdown'])
  }, RUN_BUDGET_MS)
})
