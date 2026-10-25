import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  drainQueue,
  openIndexWriter,
} from '@vostride/agent-qa-knowledge-local'
import type { KnowledgeHintReader } from '@vostride/agent-qa-runner'
import { RUNS_SUBDIR, slugBranch } from '@vostride/agent-qa-runner-local'
import { CURRENT_HANDOFF_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type { CompletedRunHandoff } from '@vostride/agent-qa-schema'
import { expect } from 'vitest'

import {
  readCurationTailReceipt,
  runCurationTail,
  type RunCurationTailOptions,
} from '../../curation/curation-tail.js'
import {
  FIXTURE_RUN_ID,
  createScriptedAuthor,
  emitReportForFixture,
  enqueueFixtureBytes,
  readFixture,
} from './fixtures.js'
import { canonicalBundleTree, orderedLogicalDump, readStoreSequence } from './logical-dump.js'
import { DUAL_HOST_ENV, type LegReport } from './spawn-helpers.js'

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`missing ${name}`)
  return value
}

export async function runOneShotLeg(): Promise<void> {
  const root = requiredEnv(DUAL_HOST_ENV.root)
  const fixture = readFixture(requiredEnv(DUAL_HOST_ENV.fixture))
  const reportFile = requiredEnv(DUAL_HOST_ENV.report)
  const markerFile = requiredEnv(DUAL_HOST_ENV.marker)
  const agentQaRoot = join(root, '.agent-qa')
  const knowledgeRoot = join(root, 'agent-qa-knowledge')
  const runDir = join(agentQaRoot, RUNS_SUBDIR, slugBranch(FIXTURE_RUN_ID))
  mkdirSync(runDir, { recursive: true })
  openIndexWriter(knowledgeRoot).close()

  const authorOrder: string[] = []
  const author = createScriptedAuthor(fixture, authorOrder)
  let observedDrain: Awaited<ReturnType<typeof drainQueue>> | undefined
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
      // Compare the two hosts at the drain boundary; daemon maintenance runs on a later cadence.
      drainQueue: async (options) => {
        observedDrain = await drainQueue({ ...options, maintenance: 'skip' })
        return observedDrain
      },
    },
  })
  if (warnings.length > 0) {
    throw new Error(`${warnings.join('\n')}\nDrain report: ${JSON.stringify(observedDrain)}`)
  }
  const receipt = readCurationTailReceipt(runDir)
  expect(receipt).toBeDefined()
  const sequence = readStoreSequence(knowledgeRoot)
  const report: LegReport = {
    failed: false,
    pid: process.pid,
    host: 'one-shot',
    variant: fixture.variant,
    candidateIds: fixture.candidates.map(({ candidateId }) => candidateId),
    bundleTree: canonicalBundleTree(knowledgeRoot),
    logicalDump: orderedLogicalDump(knowledgeRoot),
    epoch: Number(readFileSync(join(knowledgeRoot, '.epoch'), 'utf8').trim()),
    ...sequence,
    authorOrder,
    runReceipt: receipt as unknown as Record<string, unknown>,
    sessionReceipts: [],
    daemonEvents: [],
  }
  writeFileSync(reportFile, `${JSON.stringify(report)}\n`, 'utf8')
  writeFileSync(markerFile, `${JSON.stringify({ complete: true })}\n`, 'utf8')
}
