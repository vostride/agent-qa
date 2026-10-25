import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ConfigReaderPort, FunctionRegistry, JobModelCapability } from '@vostride/agent-qa-agent'
import type {
  ComposeJobRecoveryInput,
  ComposeLocalAgentInput,
  JobRecoveryHost,
  LocalAgentHost,
} from '@vostride/agent-qa-agent-local'
import {
  countPendingCurationJobs,
  drainQueue,
  openIndexWriter,
} from '@vostride/agent-qa-knowledge-local'
import type { KnowledgeHintReader } from '@vostride/agent-qa-runner'
import { RUNS_SUBDIR, slugBranch } from '@vostride/agent-qa-runner-local'
import { CURRENT_HANDOFF_SCHEMA_VERSION, MASKED_RESOLVED_CONFIG_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type { CompletedRunHandoff } from '@vostride/agent-qa-schema'
import { expect } from 'vitest'

import {
  readCurationTailReceipt,
  runCurationTail,
  type RunCurationTailOptions,
} from '../../curation/curation-tail.js'
import { nudgeDaemon } from '../../daemon/client.js'
import { readDrainSessionReceipts } from '../../daemon/drain-receipts.js'
import { DAEMON_EVENTS_FILE } from '../../daemon/events.js'
import { runDaemonHost, type DaemonHostOperations } from '../../daemon/host.js'
import { DAEMON_REGISTRATION_FILE } from '../../daemon/registration.js'
import {
  FIXTURE_RUN_ID,
  createScriptedAuthor,
  emitReportForFixture,
  enqueueFixtureBytes,
  readFixture,
} from './fixtures.js'
import { canonicalBundleTree, orderedLogicalDump, readStoreSequence } from './logical-dump.js'
import { DUAL_HOST_ENV, type LegReport } from './spawn-helpers.js'

const CONFIG: ConfigReaderPort = {
  getMasked: () => Promise.resolve({
    schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
    configPath: '/tmp/dual-host.config.yaml',
    entries: [],
  }),
}
const MODEL: JobModelCapability = {
  modelId: 'dual-host:unused',
  generate: () => Promise.resolve({ text: 'unused' }),
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`missing ${name}`)
  return value
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 120_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function trace(message: string): void {
  process.stderr.write(`[dual-host-daemon] ${message}\n`)
}

function fakeRecovery(): JobRecoveryHost {
  return {
    store: { adoptEpoch: () => Promise.resolve({ epoch: 1 }) },
    recoverAbandonedClaims: () => Promise.resolve({ recovered: 0 }),
    resumePending: () => Promise.resolve([]),
    close() {},
  } as unknown as JobRecoveryHost
}

function fakeLocalAgent(): LocalAgentHost {
  return {
    registry: {} as FunctionRegistry,
    jobs: () => Promise.resolve({
      queue: { runNextJob: () => Promise.resolve({ ran: false, reason: 'no-job' }) },
    }),
    close() {},
  } as unknown as LocalAgentHost
}

function readEvents(agentQaRoot: string): Record<string, unknown>[] {
  const file = join(agentQaRoot, DAEMON_EVENTS_FILE)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').trim().split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

export async function runDaemonLeg(): Promise<void> {
  const root = requiredEnv(DUAL_HOST_ENV.root)
  const fixture = readFixture(requiredEnv(DUAL_HOST_ENV.fixture))
  const reportFile = requiredEnv(DUAL_HOST_ENV.report)
  const markerFile = requiredEnv(DUAL_HOST_ENV.marker)
  const progress = (stage: string): void => {
    trace(stage)
    writeFileSync(reportFile, `${JSON.stringify({ progress: stage })}\n`, 'utf8')
  }
  const agentQaRoot = join(root, '.agent-qa')
  const knowledgeRoot = join(root, 'agent-qa-knowledge')
  const runDir = join(agentQaRoot, RUNS_SUBDIR, slugBranch(FIXTURE_RUN_ID))
  mkdirSync(runDir, { recursive: true })
  openIndexWriter(knowledgeRoot).close()

  const authorOrder: string[] = []
  const author = createScriptedAuthor(fixture, authorOrder)
  const signals = new Map<NodeJS.Signals, () => void>()
  const errors: string[] = []
  let startupError: unknown
  progress('before-host')
  const host = runDaemonHost({
    agentQaRoot,
    knowledgeRoot,
    config: CONFIG,
    model: () => MODEL,
    author: () => author,
    operations: {
      // Supplying the production drainer disables only the orthogonal embedder child lifecycle.
      drainQueue,
      composeJobRecovery: (_input: ComposeJobRecoveryInput) => fakeRecovery(),
      composeLocalAgent: (_input: ComposeLocalAgentInput) => fakeLocalAgent(),
      onSignal: (signal, listener) => signals.set(signal, listener),
      offSignal: (signal, listener) => {
        if (signals.get(signal) === listener) signals.delete(signal)
      },
    } satisfies Partial<DaemonHostOperations>,
    logger: {
      info: (message) => trace(message),
      error: (message) => {
        errors.push(message)
        trace(`error: ${message}`)
      },
    },
  })
  void host.catch((error: unknown) => {
    startupError = error
    progress(`host-rejected:${error instanceof Error ? error.message : String(error)}`)
  })
  progress('host-promise-created')
  await waitUntil(
    () => existsSync(join(agentQaRoot, DAEMON_REGISTRATION_FILE)) || startupError !== undefined,
    'daemon registration was not written',
  )
  if (startupError !== undefined) throw startupError
  progress('registration-ready')

  const handoff = {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: FIXTURE_RUN_ID,
    executionContext: 'local-interactive',
  } as unknown as CompletedRunHandoff
  const warnings: string[] = []
  await runCurationTail({
    runId: FIXTURE_RUN_ID,
    agentQaRoot,
    knowledgeConfig: { dir: knowledgeRoot },
    configDir: root,
    modelDeps: {} as NonNullable<RunCurationTailOptions['modelDeps']>,
    log: { warn: (message) => warnings.push(message) },
    operations: {
      loadCompletedRunHandoff: () => handoff,
      resolveKnowledgeRoot: () => knowledgeRoot,
      runSafetyScope: (_options, body) => body(),
      emitCurationCandidates: () => {
        enqueueFixtureBytes(knowledgeRoot, fixture)
        return emitReportForFixture(fixture)
      },
      openKnowledgeReader: () => ({
        emitCanaryOutcome() {},
      }) as unknown as KnowledgeHintReader,
      emitCanaryOutcomes: async () => ({
        emitted: 0,
        refused: 0,
        unresolved: 0,
        canary: { rideAlongUncredited: 0, rerunExcluded: 0, nonSignal: { environment: 0, timeout: 0, flake: 0 } },
        procedure: { emitted: 0, refused: 0, unresolved: 0 },
        details: [],
      }),
      foldRunOutcomes: () => ({
          kind: 'applied',
          tests: 0,
          // 390 D-08: this stub asks for no detection, so the fold declares it skipped.
          quarantine: { kind: 'not-evaluated', reason: 'not-requested' },
        }),
      buildCuratorAuthor: () => author,
    },
  })
  progress('tail-returned')
  // 418-12: this contender must not rebuild under the standing daemon's lease. The daemon
  // already reconciled at acquisition; the tail discloses its typed skip and hands off.
  expect(warnings).toEqual(['curation: run-outcome projection not reconciled (no writer authority)'])
  await nudgeDaemon(agentQaRoot)
  progress('explicit-nudge-returned')
  await waitUntil(
    () => countPendingCurationJobs(knowledgeRoot) === 0,
    'daemon did not drain the candidate queue',
  )
  progress('queue-empty')
  if (fixture.candidates.length > 0) {
    await waitUntil(
      () => readDrainSessionReceipts(agentQaRoot).length > 0,
      'daemon drain session receipt was not written',
    )
    progress('session-receipt-ready')
  }
  const stop = signals.get('SIGTERM')
  if (stop === undefined) throw new Error('daemon SIGTERM handler was not installed')
  stop()
  progress('sigterm-dispatched')
  await expect(host).resolves.toBe(0)
  progress('host-stopped')
  expect(errors).toEqual([])

  const receipt = readCurationTailReceipt(runDir)
  expect(receipt).toBeDefined()
  const sequence = readStoreSequence(knowledgeRoot)
  const report: LegReport = {
    failed: false,
    pid: process.pid,
    host: 'daemon',
    variant: fixture.variant,
    candidateIds: fixture.candidates.map(({ candidateId }) => candidateId),
    bundleTree: canonicalBundleTree(knowledgeRoot),
    logicalDump: orderedLogicalDump(knowledgeRoot),
    epoch: Number(readFileSync(join(knowledgeRoot, '.epoch'), 'utf8').trim()),
    ...sequence,
    authorOrder,
    runReceipt: receipt as unknown as Record<string, unknown>,
    sessionReceipts: readDrainSessionReceipts(agentQaRoot),
    daemonEvents: readEvents(agentQaRoot),
  }
  writeFileSync(reportFile, `${JSON.stringify(report)}\n`, 'utf8')
  writeFileSync(markerFile, `${JSON.stringify({ complete: true })}\n`, 'utf8')
}
