// A real daemon hands each warning to its logger's `warn`, or where it went before without one.

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const RUN_WARNING = vi.hoisted(() => 'a made-up warning of the run')

vi.mock('../../composition/in-process-run-execution.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../composition/in-process-run-execution.js')>()
  return {
    ...original,
    // The real run, after one warning through the seam its host gave it.
    runInProcessCliRun: (...args: Parameters<typeof original.runInProcessCliRun>) => {
      args[0].warn?.(RUN_WARNING)
      return original.runInProcessCliRun(...args)
    },
  }
})

import type { ConfigReaderPort, JobModelCapability } from '@vostride/agent-qa-agent'
import { MASKED_RESOLVED_CONFIG_SCHEMA_VERSION } from '@vostride/agent-qa-schema'

import { pinProcessTmpdir, removeTempRoots } from '../../__tests__/temp-roots.js'
import type { PinnedTmpdir } from '../../__tests__/temp-roots.js'
import {
  CountingTarget,
  closeTestRunRecords,
  createInProcessFixture,
  removeInProcessFixtures,
} from '../../composition/__tests__/in-process-run-fixture.js'
import { invokeViaDaemon } from '../client.js'
import { runDaemonHost } from '../host.js'
import type { DaemonHostLogger, DaemonHostOperations } from '../host.js'

const RECOVERY_WARNING = 'a made-up warning of the hand-off recovery'
const RUN_BUDGET_MS = 180_000

const TEST_MODEL: JobModelCapability = {
  modelId: 'test:daemon-warnings',
  generate: () => Promise.resolve({ text: 'unused' }),
}

const target = new CountingTarget()
const priorBrowsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH
let pinnedTmpdir: PinnedTmpdir | undefined

beforeAll(async () => {
  pinnedTmpdir = pinProcessTmpdir()
  await target.listen()
})
afterAll(async () => {
  await target.close()
  if (priorBrowsersPath === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH
  else process.env.PLAYWRIGHT_BROWSERS_PATH = priorBrowsersPath
  removeInProcessFixtures()
  pinnedTmpdir?.restore()
  if (pinnedTmpdir !== undefined) removeTempRoots([pinnedTmpdir.root])
})
afterEach(() => { closeTestRunRecords() })

type Line = readonly [message: string, tag: string | undefined]

interface Received {
  readonly info: Line[]
  readonly warn: Line[]
  readonly error: Line[]
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise((settle) => setTimeout(settle, 10))
  }
}

// One real daemon whose start-up recovery warns once, and which is handed one run that warns once.
async function linesOfAWarningDaemon(withWarn: boolean): Promise<Received> {
  const fixture = createInProcessFixture({ origin: target.origin, environment: 'local' })
  // No browser starts from an empty folder, so the run ends at once.
  const browsersRoot = join(fixture.project, 'no-browsers')
  mkdirSync(browsersRoot, { recursive: true })
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersRoot

  const listeners = new Map<NodeJS.Signals, () => void>()
  const operations: Partial<DaemonHostOperations> = {
    setInterval: (_callback, intervalMs) => intervalMs as unknown as ReturnType<typeof setInterval>,
    clearInterval: () => undefined,
    onSignal: (signal, listener) => listeners.set(signal, listener),
    offSignal: (signal, listener) => {
      if (listeners.get(signal) === listener) listeners.delete(signal)
    },
    hardExit: (code) => {
      throw new Error(`unexpected daemon hard exit ${code}`)
    },
    recoverPendingPostVerdictContinuations: async (input) => {
      input.log.warn(RECOVERY_WARNING)
      return []
    },
  }
  const received: Received = { info: [], warn: [], error: [] }
  const logger: DaemonHostLogger = {
    info: (message, tag) => { received.info.push([message, tag]) },
    error: (message, tag) => { received.error.push([message, tag]) },
    ...(withWarn
      ? { warn: (message: string, tag?: string) => { received.warn.push([message, tag]) } }
      : {}),
  }
  const config: ConfigReaderPort = {
    getMasked: () => Promise.resolve({
      schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
      configPath: fixture.configPath,
      entries: [],
    }),
  }
  const running = runDaemonHost({
    agentQaRoot: fixture.agentQaRoot,
    knowledgeRoot: join(fixture.project, 'agent-qa-knowledge'),
    configPath: fixture.configPath,
    config,
    model: () => TEST_MODEL,
    operations,
    logger,
  })
  const everyLine = (): Line[] => [...received.info, ...received.warn, ...received.error]
  try {
    await waitUntil(
      () => received.info.some(([message]) => message.startsWith('agent-qa daemon started')),
      'daemon did not finish starting',
    )
    await waitUntil(
      () => everyLine().some(([message]) => message === RECOVERY_WARNING),
      'the start-up recovery did not run',
    )
    await invokeViaDaemon({
      agentQaRoot: fixture.agentQaRoot,
      functionId: 'runs.start',
      input: { patterns: [fixture.testPattern] },
    })
  } finally {
    listeners.get('SIGTERM')?.()
    await running
  }
  return received
}

function made(lines: readonly Line[]): Line[] {
  return lines.filter(([message]) => message === RUN_WARNING || message === RECOVERY_WARNING)
}

describe('the warnings a daemon hands its logger', () => {
  it('go to warn, each under its own tag, when the logger has one', async () => {
    const received = await linesOfAWarningDaemon(true)

    expect(made(received.warn)).toEqual([
      [RECOVERY_WARNING, 'post-run'],
      [RUN_WARNING, 'run'],
    ])
    expect(made(received.info)).toEqual([])
    expect(made(received.error)).toEqual([])
  }, RUN_BUDGET_MS)

  it('go where they went before when the logger has no warn', async () => {
    const received = await linesOfAWarningDaemon(false)

    expect(made(received.info)).toEqual([[RUN_WARNING, 'run']])
    expect(made(received.error)).toEqual([[RECOVERY_WARNING, 'post-run']])
  }, RUN_BUDGET_MS)
})
