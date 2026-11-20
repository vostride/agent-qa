// A started run that ends on a framework error prints one line, masked with the run's secrets.

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const PLANTED = vi.hoisted(() => 'zq7-made-up-capability-token')

vi.mock('../in-process-run-execution.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../in-process-run-execution.js')>()
  return {
    ...original,
    // The real run, whose framework error then quotes the session request, as a driver's can.
    runInProcessCliRun: async (...args: Parameters<typeof original.runInProcessCliRun>) => {
      try {
        return await original.runInProcessCliRun(...args)
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message.split('\n')[0] : String(error)} `
          + `Session request: {"capabilities":{"accessKey":"${PLANTED}"}}`,
        )
      }
    },
  }
})

import { invokeFunction } from '@vostride/agent-qa-agent'
import type { ConfigReaderPort, JobModelCapability } from '@vostride/agent-qa-agent'
import { MASKED_RESOLVED_CONFIG_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type { RunStartAcknowledgement } from '@vostride/agent-qa-schema'

import { pinProcessTmpdir, removeTempRoots } from '../../__tests__/temp-roots.js'
import type { PinnedTmpdir } from '../../__tests__/temp-roots.js'
import { invokeViaDaemon } from '../../daemon/client.js'
import { runDaemonHost } from '../../daemon/host.js'
import type { DaemonHostOperations } from '../../daemon/host.js'
import { CLI_FUNCTION_CALLER, composeCliLocalAgent } from '../local-agent-host.js'
import {
  CountingTarget,
  PLANTED_SECRET_NAME,
  closeTestRunRecords,
  createInProcessFixture,
  removeInProcessFixtures,
} from './in-process-run-fixture.js'
import type { InProcessFixture } from './in-process-run-fixture.js'

const MARKER = `[secret:${PLANTED_SECRET_NAME}]`
const RUN_BUDGET_MS = 180_000

function plain(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
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
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  closeTestRunRecords()
})

// The project declares the secret, and its run ends on a framework error: no browser can start
// from an empty folder.
function projectWhoseFrameworkErrorQuotesItsSecret(): InProcessFixture {
  const fixture = createInProcessFixture({
    origin: target.origin,
    environment: 'local',
    plantedSecret: PLANTED,
  })
  const browsersRoot = join(fixture.project, 'no-browsers')
  mkdirSync(browsersRoot, { recursive: true })
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersRoot
  return fixture
}

interface Printed {
  readonly stdout: string[]
  readonly stderr: string[]
}

function capturePrinted(): Printed {
  const printed: Printed = { stdout: [], stderr: [] }
  vi.spyOn(console, 'log').mockImplementation((value: unknown) => {
    printed.stdout.push(plain(String(value)))
  })
  vi.spyOn(console, 'warn').mockImplementation((value: unknown) => {
    printed.stderr.push(plain(String(value)))
  })
  vi.spyOn(console, 'error').mockImplementation((value: unknown) => {
    printed.stderr.push(plain(String(value)))
  })
  return printed
}

async function startThroughDoor(
  fixture: InProcessFixture,
  terminalLines: { readonly logLevel: string } | undefined,
): Promise<RunStartAcknowledgement> {
  const composed = composeCliLocalAgent({
    agentQaRoot: fixture.agentQaRoot,
    configPath: fixture.configPath,
    ...(terminalLines === undefined ? {} : { runBridge: { terminalLines } }),
  })
  try {
    return await invokeFunction(
      composed.registry,
      'runs.start',
      { patterns: [fixture.testPattern] },
      CLI_FUNCTION_CALLER,
    ) as RunStartAcknowledgement
  } finally {
    await composed.close()
  }
}

function failedLines(lines: readonly string[]): string[] {
  return lines.filter((line) => line.includes(' failed: '))
}

describe('the run door\'s line for a started run that ends on a framework error', () => {
  it.each([
    ['a host that prints terminal lines', { logLevel: 'warn' }],
    ['a host with no terminal lines', undefined],
  ] as const)('prints the declared secret as its marker for %s', async (_, terminalLines) => {
    vi.stubEnv('GITHUB_ACTIONS', '')
    const fixture = projectWhoseFrameworkErrorQuotesItsSecret()
    const printed = capturePrinted()

    const { runId } = await startThroughDoor(fixture, terminalLines)

    const failed = failedLines(printed.stderr)
    expect(failed, JSON.stringify(printed)).toHaveLength(1)
    expect(failed[0]).toContain(`Run ${runId} failed: `)
    expect(failed[0]).toContain(`{"capabilities":{"accessKey":"${MARKER}"}}`)
    expect(JSON.stringify(printed)).not.toContain(PLANTED)
  }, RUN_BUDGET_MS)
})

const TEST_MODEL: JobModelCapability = {
  modelId: 'test:run-framework-error-line',
  generate: () => Promise.resolve({ text: 'unused' }),
}

interface DaemonLine {
  readonly level: 'info' | 'error'
  readonly tag: string | undefined
  readonly message: string
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise((settle) => setTimeout(settle, 10))
  }
}

// One real daemon that is handed one run, with every line its logger received.
async function daemonLinesOfDispatch(fixture: InProcessFixture): Promise<{
  readonly runId: string | undefined
  readonly lines: readonly DaemonLine[]
}> {
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
  }
  const lines: DaemonLine[] = []
  let started = false
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
      agentQaRoot: fixture.agentQaRoot,
      functionId: 'runs.start',
      input: { patterns: [fixture.testPattern] },
    })
    return { runId: (acknowledged as { runId?: string }).runId, lines }
  } finally {
    listeners.get('SIGTERM')?.()
    await running
  }
}

describe('the daemon\'s line for a dispatched run that ends on a framework error', () => {
  it('prints the declared secret as its marker on the run line', async () => {
    const fixture = projectWhoseFrameworkErrorQuotesItsSecret()

    const { runId, lines } = await daemonLinesOfDispatch(fixture)

    const failed = lines.filter((line) => line.message.includes(' failed: '))
    expect(failed, JSON.stringify(lines)).toHaveLength(1)
    expect(failed[0]).toMatchObject({ level: 'error', tag: 'run' })
    expect(failed[0]?.message).toContain(`Dispatched run ${runId} failed: `)
    expect(failed[0]?.message).toContain(`{"capabilities":{"accessKey":"${MARKER}"}}`)
    expect(JSON.stringify(lines)).not.toContain(PLANTED)
  }, RUN_BUDGET_MS)
})
