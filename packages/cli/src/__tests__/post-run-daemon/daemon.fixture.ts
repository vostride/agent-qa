// A real daemon; only the real `drainQueue` and a parking `curateRun` wrapper are injected.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ConfigReaderPort, JobModelCapability } from '@vostride/agent-qa-agent'
import { composeLocalAgent } from '@vostride/agent-qa-agent-local'
import type { ComposeLocalAgentInput, LocalAgentHost } from '@vostride/agent-qa-agent-local'
import { drainQueue } from '@vostride/agent-qa-knowledge-local'

import { DAEMON_EVENTS_FILE } from '../../daemon/events.js'
import { runDaemonHost, type DaemonHostOperations } from '../../daemon/host.js'
import { readDaemonRegistration } from '../../daemon/registration.js'
import { writeDurableJson } from '../fencing/spawn-helpers.js'
import { POST_RUN_DAEMON_ENV } from './spawn-helpers.js'
import { MASKED_RESOLVED_CONFIG_SCHEMA_VERSION } from '@vostride/agent-qa-schema'

const CONFIG: ConfigReaderPort = {
  getMasked: () => Promise.resolve({
    schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
    configPath: '/tmp/post-run-daemon.config.yaml',
    entries: [],
  }),
}

// Unparseable text makes the author degrade to the deterministic floor, so no provider is needed.
const MODEL: JobModelCapability = {
  modelId: 'post-run-daemon:degrading-stub',
  generate: async () => ({ text: 'not an author payload' }),
}

/** What the substituted fold reports, so a completed chain has honest, pinned counts. */
export const FIXTURE_CURATION_COUNTS = { curated: 2, deprecated: 1, complete: true } as const

/** The gate is polled rather than watched: a rename under a watcher is the flakier of the two. */
const POLL_MS = 25
/** Well past any leg's own budget. A fold that waits this long has been abandoned, not gated. */
const GATE_DEADLINE_MS = 240_000
const READY_DEADLINE_MS = 120_000

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`missing ${name}`)
  return value
}

function readEvents(agentQaRoot: string): Record<string, unknown>[] {
  const file = join(agentQaRoot, DAEMON_EVENTS_FILE)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

async function waitUntil(
  predicate: () => boolean,
  message: string,
  abort: () => unknown,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    const error = abort()
    if (error !== undefined) throw error instanceof Error ? error : new Error(String(error))
    if (Date.now() > deadline) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}

export async function runPostRunDaemonFixture(): Promise<void> {
  const root = requiredEnv(POST_RUN_DAEMON_ENV.root)
  const generation = requiredEnv(POST_RUN_DAEMON_ENV.generation)
  const readyMarker = requiredEnv(POST_RUN_DAEMON_ENV.readyMarker)
  const reportFile = requiredEnv(POST_RUN_DAEMON_ENV.report)
  const enteredMarker = requiredEnv(POST_RUN_DAEMON_ENV.enteredMarker)
  const gate = requiredEnv(POST_RUN_DAEMON_ENV.gate)
  const agentQaRoot = join(root, '.agent-qa')
  const knowledgeRoot = join(root, 'agent-qa-knowledge')

  let hostError: unknown
  let hostExitCode: number | undefined
  const errors: string[] = []
  const curationEntries: string[] = []

  const operations: Partial<DaemonHostOperations> = {
    drainQueue,
    composeLocalAgent: (input: ComposeLocalAgentInput): LocalAgentHost => composeLocalAgent({
      ...input,
      postRun: {
        // True of this substitute: it parks on the gate file before candidate emission.
        candidateProse: 'masker-active',
        curateRun: async ({ runId }) => {
          curationEntries.push(runId)
          writeDurableJson(enteredMarker, {
            runId,
            pid: process.pid,
            generation,
            enteredAtMs: Date.now(),
          })
          await waitUntil(
            () => existsSync(gate),
            `the curation gate never opened for ${runId}`,
            () => undefined,
            GATE_DEADLINE_MS,
          )
          return { ...FIXTURE_CURATION_COUNTS }
        },
      },
    }),
  }

  const host = runDaemonHost({
    agentQaRoot,
    knowledgeRoot,
    config: CONFIG,
    model: () => MODEL,
    operations,
    logger: {
      info: (message) => process.stderr.write(`[post-run-${generation}] ${message}\n`),
      error: (message) => {
        errors.push(message)
        process.stderr.write(`[post-run-${generation}] error: ${message}\n`)
      },
    },
  })
  void host.then(
    (code) => { hostExitCode = code },
    (error: unknown) => { hostError = error },
  )

  const writeReport = (failed: boolean, reason?: string): void => {
    writeDurableJson(reportFile, {
      failed,
      generation,
      pid: process.pid,
      exitCode: hostExitCode,
      errors,
      curationEntries,
      ...(reason === undefined ? {} : { reason }),
      events: readEvents(agentQaRoot),
    })
  }

  try {
    // Ready means registered; a refusing host never registers, so the wait aborts by name.
    await waitUntil(
      () => {
        const outcome = readDaemonRegistration(agentQaRoot)
        return outcome.kind === 'parsed' && outcome.registration.pid === process.pid
      },
      `the ${generation} daemon never published its own registration`,
      () => hostError ?? (
        hostExitCode === undefined
          ? undefined
          : new Error(`the ${generation} daemon exited ${hostExitCode} before readiness`)
      ),
      READY_DEADLINE_MS,
    )
    const published = readDaemonRegistration(agentQaRoot)
    if (published.kind !== 'parsed') throw new Error('registration vanished after publication')
    writeDurableJson(readyMarker, {
      ready: true,
      generation,
      pid: process.pid,
      instanceId: published.registration.instanceId,
      socketPath: published.registration.socketPath,
    })

    hostExitCode = await host
    writeReport(false)
  } catch (error) {
    writeReport(true, error instanceof Error ? error.message : String(error))
    throw error
  }
}

if (process.env[POST_RUN_DAEMON_ENV.role] === 'daemon') {
  void runPostRunDaemonFixture().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    )
    process.exitCode = 1
  })
}
