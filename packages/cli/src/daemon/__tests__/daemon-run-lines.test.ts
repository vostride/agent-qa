// A real daemon dispatches real runs that launch a browser, and names each one in its terminal.
// Its own file: importing the browser fixture fixes Playwright's browsers root for the whole module.

import { join } from 'node:path'

import type { ConfigReaderPort, JobModelCapability } from '@vostride/agent-qa-agent'
import { MASKED_RESOLVED_CONFIG_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  POPULATED_FAILURE_STEP_MARKER,
  POPULATED_FAILURE_STEP_TEXT,
  POPULATED_PASSING_STEP_TEXT,
  POPULATED_SECOND_TEST_PATH,
  populatedRunFixtureProject,
  populatedRunSpawnEnv,
  startStubModelServer,
  startTargetPageServer,
} from '../../__tests__/conformance/populated-run-fixture.js'
import type {
  FixtureServer,
  PopulatedRunProject,
  StubModelServer,
} from '../../__tests__/conformance/populated-run-fixture.js'
import { cleanupTempRoots } from '../../__tests__/conformance/spawned-chat.js'
import { pinProcessTmpdir, removeTempRoots } from '../../__tests__/temp-roots.js'
import type { PinnedTmpdir } from '../../__tests__/temp-roots.js'
import { closeTestRunRecords } from '../../composition/__tests__/in-process-run-fixture.js'
import { invokeViaDaemon } from '../client.js'
import { runDaemonHost } from '../host.js'
import type { DaemonHostOperations } from '../host.js'

let pinnedTmpdir: PinnedTmpdir | undefined
beforeAll(() => { pinnedTmpdir = pinProcessTmpdir() })
afterAll(() => {
  pinnedTmpdir?.restore()
  if (pinnedTmpdir !== undefined) removeTempRoots([pinnedTmpdir.root])
})
afterEach(() => { closeTestRunRecords() })

const TEST_MODEL: JobModelCapability = {
  modelId: 'test:daemon-run-lines',
  generate: () => Promise.resolve({ text: 'unused' }),
}

interface DaemonLine {
  readonly level: 'info' | 'error'
  readonly tag: string | undefined
  readonly message: string
}

function signalHarness(): {
  readonly operations: Partial<DaemonHostOperations>
  signal(signal: NodeJS.Signals): void
} {
  const listeners = new Map<NodeJS.Signals, () => void>()
  return {
    operations: {
      setInterval: (_callback, intervalMs) => (
        intervalMs as unknown as ReturnType<typeof setInterval>
      ),
      clearInterval: () => undefined,
      onSignal: (signal, listener) => listeners.set(signal, listener),
      offSignal: (signal, listener) => {
        if (listeners.get(signal) === listener) listeners.delete(signal)
      },
      hardExit: (code) => {
        throw new Error(`unexpected daemon hard exit ${code}`)
      },
    },
    signal(signal) {
      const listener = listeners.get(signal)
      if (listener === undefined) throw new Error(`${signal} listener was not installed`)
      listener()
    },
  }
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise((settle) => setTimeout(settle, 10))
  }
}

// One daemon with no analytics, dispatching one test, with every line its logger was handed.
async function daemonLinesOfDispatch(input: {
  readonly project: PopulatedRunProject
  readonly pattern: string
}): Promise<{ readonly runId: string | undefined; readonly lines: readonly DaemonLine[] }> {
  const signals = signalHarness()
  const lines: DaemonLine[] = []
  let started = false
  const config: ConfigReaderPort = {
    getMasked: () => Promise.resolve({
      schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
      configPath: input.project.configPath,
      entries: [],
    }),
  }
  const savedBrowsers = process.env.PLAYWRIGHT_BROWSERS_PATH
  const browsers = populatedRunSpawnEnv().PLAYWRIGHT_BROWSERS_PATH
  if (browsers !== undefined) process.env.PLAYWRIGHT_BROWSERS_PATH = browsers
  const running = runDaemonHost({
    agentQaRoot: input.project.agentQaRoot,
    knowledgeRoot: join(input.project.root, 'agent-qa-knowledge'),
    configPath: input.project.configPath,
    config,
    model: () => TEST_MODEL,
    operations: signals.operations,
    logger: {
      info: (message, tag) => {
        if (message.startsWith('agent-qa daemon started')) started = true
        lines.push({ level: 'info', tag, message })
      },
      error: (message, tag) => { lines.push({ level: 'error', tag, message }) },
    },
  })
  try {
    await waitUntil(() => started, 'daemon did not finish starting')
    const acknowledged = await invokeViaDaemon({
      agentQaRoot: input.project.agentQaRoot,
      functionId: 'runs.start',
      input: { patterns: [input.pattern] },
    })
    return { runId: (acknowledged as { runId?: string }).runId, lines }
  } finally {
    signals.signal('SIGTERM')
    await running
    if (savedBrowsers === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH
    else process.env.PLAYWRIGHT_BROWSERS_PATH = savedBrowsers
  }
}

function runLines(lines: readonly DaemonLine[]): DaemonLine[] {
  return lines.filter((line) => line.message.startsWith('▶ ') || /^[✓✗⊘] /u.test(line.message))
}

function shortIdOf(runId: string): string {
  return runId.split('-').slice(0, 2).join('-')
}

describe('the daemon terminal names each run it dispatches', () => {
  let target: FixtureServer | undefined
  let model: StubModelServer | undefined
  let project: PopulatedRunProject | undefined

  beforeAll(async () => {
    target = await startTargetPageServer()
    model = await startStubModelServer({
      plannerOutcome: 'stepFailed',
      failOnlyStepText: POPULATED_FAILURE_STEP_MARKER,
    })
    project = populatedRunFixtureProject(
      'daemon-run-lines',
      { modelBaseUrl: model.baseUrl, targetUrl: target.url },
      { stepText: POPULATED_PASSING_STEP_TEXT, secondStepText: POPULATED_FAILURE_STEP_TEXT },
    )
  })

  afterAll(async () => {
    await model?.close()
    await target?.close()
    cleanupTempRoots()
  })

  it('prints a start line and a passed result line under the run tag, with analytics off', async () => {
    const { runId, lines } = await daemonLinesOfDispatch({
      project: project!,
      pattern: project!.testPath,
    })

    expect(runId, JSON.stringify(lines)).toMatch(/^r_/)
    expect(runLines(lines), JSON.stringify(lines, null, 2)).toEqual([
      {
        level: 'info',
        tag: 'run',
        message: `▶ The populated run conformance probe · web · ${shortIdOf(runId!)}`,
      },
      {
        level: 'info',
        tag: 'run',
        message: expect.stringMatching(/^✓ The populated run conformance probe · passed · \S+$/u),
      },
    ])
  }, 180_000)

  it('prints a failed result line with the failed step and its error under it', async () => {
    const { runId, lines } = await daemonLinesOfDispatch({
      project: project!,
      pattern: POPULATED_SECOND_TEST_PATH,
    })

    expect(runId, JSON.stringify(lines)).toMatch(/^r_/)
    const printed = runLines(lines)
    expect(printed.map((line) => [line.level, line.tag]), JSON.stringify(lines, null, 2)).toEqual([
      ['info', 'run'],
      ['info', 'run'],
    ])
    expect(printed[0]?.message)
      .toBe(`▶ The populated run conformance second probe · web · ${shortIdOf(runId!)}`)
    const [result, detail, ...rest] = printed[1]?.message.split('\n') ?? []
    expect(result).toMatch(/^✗ The populated run conformance second probe · failed · \S+$/u)
    expect(detail).toMatch(/^step 1: \S/u)
    expect(rest).toEqual([])
  }, 180_000)
})
