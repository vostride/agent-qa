// Starts the real daemon entry over a temp project, so the shipped daemon's composition is tested.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ConfigReaderPort, JobModelCapability } from '@vostride/agent-qa-agent'
import { readWriterLease } from '@vostride/agent-qa-knowledge-local'
import type { KnowledgeChangeOutput } from '@vostride/agent-qa-schema'
import { MASKED_RESOLVED_CONFIG_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { filePre432KnowledgeProposal } from '../composition/__tests__/pre-432-knowledge-proposal.js'
import { invokeViaDaemon } from '../daemon/client.js'
import {
  runDaemonHost,
  type DaemonHostOperations,
  type DaemonHostTraceStep,
} from '../daemon/host.js'

const temporaryRoots: string[] = []

const TEST_CONFIG: ConfigReaderPort = {
  getMasked: () => Promise.resolve({
    schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
    configPath: '/tmp/agent-qa.config.yaml',
    entries: [],
  }),
}

const TEST_MODEL: JobModelCapability = {
  modelId: 'test:daemon-apply-authority',
  generate: () => Promise.resolve({ text: 'unused' }),
}

interface Paths {
  readonly root: string
  readonly agentQaRoot: string
  readonly knowledgeRoot: string
  readonly socketPath: string
}

function makePaths(label: string): Paths {
  // A short base keeps the unix socket inside the platform path budget.
  const base = process.platform === 'win32' ? tmpdir() : '/tmp'
  const root = mkdtempSync(join(base, `aq-apply-auth-${label}-`))
  temporaryRoots.push(root)
  const paths: Paths = {
    root,
    agentQaRoot: join(root, '.agent-qa'),
    knowledgeRoot: join(root, 'agent-qa-knowledge'),
    socketPath: join(root, 'd.sock'),
  }
  mkdirSync(paths.agentQaRoot, { recursive: true })
  mkdirSync(paths.knowledgeRoot, { recursive: true })
  return paths
}

/** Seed one committed bundle through the layer's own publish helper, BEFORE the daemon starts. */
async function seedRecord(where: Paths): Promise<string> {
  const { publishBundleForTest } = await import('@vostride/agent-qa-knowledge-local')
  const outcome = publishBundleForTest(
    {
      knowledgeRoot: where.knowledgeRoot,
      productKey: 'Daemon Authority Product',
    },
    {
      draft: {
        kind: 'fact',
        subtype: 'selector',
        anchors: [{ t: 'el', role: 'Button', name: 'Checkout' }],
        scope: { tier: 'product', key: 'daemon-authority' },
        summary: 'checkout button',
        body: 'Selecting Checkout advances to the payment page.',
        distilledEvidenceRef: { id: 'daemon-authority-evidence', sha: 'c'.repeat(64) },
        originStage: 'run-curation',
      },
      discriminant: {
        kind: 'fact',
        subtype: 'selector',
        elementRef: { role: 'Button', name: 'Checkout' },
      },
      originClass: 'agent-verified',
      createdAtOrdinal: 4,
      screenStates: [],
      initialEvents: [],
      relations: [],
      provenance: { mode: 'run-linked', runId: 'daemon-authority', testId: 't', stepIndex: 0 },
      artifacts: [],
    },
  )
  if (outcome.kind !== 'published') throw new Error(`fixture publish failed: ${outcome.kind}`)
  return outcome.id
}

interface LiveDaemon {
  readonly stop: () => Promise<void>
}

/**
 * Start the shipped daemon over `paths` and resolve once its registration is on disk.
 *
 * What is stubbed here is exactly what `daemon-host.test.ts`'s own harness stubs for hermeticity —
 * the heartbeat supervisor child, job recovery, the curation drain (whose absence also pins the
 * embedder-worker lifecycle off), the timers and the signal table. `composeLocalAgent` and
 * `startInvokeServer` are deliberately NOT stubbed: they are the subject.
 */
async function startDaemon(paths: Paths): Promise<LiveDaemon> {
  const signals = new Map<NodeJS.Signals, () => void>()
  const traces: DaemonHostTraceStep[] = []
  const errors: string[] = []

  const operations = {
    trace: (step: DaemonHostTraceStep) => traces.push(step),
    setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
    clearInterval: () => undefined,
    setTimeout: () => 2 as unknown as ReturnType<typeof setTimeout>,
    clearTimeout: () => undefined,
    onSignal: (signal: NodeJS.Signals, listener: () => void) => {
      signals.set(signal, listener)
    },
    offSignal: (signal: NodeJS.Signals, listener: () => void) => {
      if (signals.get(signal) === listener) signals.delete(signal)
    },
    hardExit: (code: number) => {
      throw new Error(`unexpected hard exit ${code}`)
    },
    startHeartbeatSupervisor: () => Promise.resolve({
      exited: Promise.resolve(),
      stop: () => Promise.resolve(),
    }),
    composeJobRecovery: () => ({
      store: { adoptEpoch: () => Promise.resolve({ epoch: 1 }) },
      recoverAbandonedClaims: () => Promise.resolve({ recovered: 0 }),
      resumePending: () => Promise.resolve([]),
      close: vi.fn(),
    }),
    inspectDrainableCurationWork: () => ({
      queuedCandidateIds: [],
      recoverableClaimedCandidateIds: [],
    }),
    countRemainingCurationWork: () => ({ queued: 0, claimedNonterminal: 0, quarantined: 0 }),
    listQueuedCandidates: () => [],
    drainQueue: () => Promise.resolve({ drained: 0 }),
    appendDrainSessionReceipt: () => undefined,
  } as unknown as Partial<DaemonHostOperations>

  const running = runDaemonHost({
    agentQaRoot: paths.agentQaRoot,
    knowledgeRoot: paths.knowledgeRoot,
    socketPath: paths.socketPath,
    config: TEST_CONFIG,
    model: () => TEST_MODEL,
    operations,
    logger: { info: vi.fn(), error: (message) => errors.push(message) },
  })

  const deadline = Date.now() + 30_000
  while (!traces.includes('registration-written')) {
    if (errors.length > 0) throw new Error(`daemon refused to start: ${errors.join(' | ')}`)
    if (Date.now() >= deadline) throw new Error('daemon never wrote its registration')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  return {
    stop: async () => {
      const listener = signals.get('SIGTERM')
      if (listener === undefined) throw new Error('SIGTERM listener was not installed')
      listener()
      await expect(running).resolves.toBe(0)
    },
  }
}

// Plants the old standing-approval bytes; nothing reads them, so the daemon answers the same.
function grantApply(where: Paths): void {
  mkdirSync(where.knowledgeRoot, { recursive: true })
  writeFileSync(
    join(where.knowledgeRoot, 'grants.jsonl'),
    '{"schemaVersion":1,"kind":"grant","at":"2026-08-07T12:00:00.000Z","grantId":"grant_daemon_apply_authority",'
      + '"actionClass":"fn:knowledge.proposal.apply","scope":{"project":"local-workspace"}}\n',
    'utf8',
  )
}

function callDaemon(where: Paths, functionId: string, input: unknown): Promise<unknown> {
  return invokeViaDaemon({
    agentQaRoot: where.agentQaRoot,
    knowledgeRoot: where.knowledgeRoot,
    functionId,
    input,
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('the daemon commits its own applies in process', () => {
  it('applies a forget through the real daemon entry while holding the writer lease', async () => {
    const paths = makePaths('held')
    const recordId = await seedRecord(paths)
    grantApply(paths)
    const daemon = await startDaemon(paths)

    try {
      // The lease this daemon acquired at startup. Every assertion below is about THIS lease
      // staying exactly where it is: the holder's apply neither releases nor re-acquires.
      const leaseBefore = readWriterLease(paths.knowledgeRoot)
      // `readWriterLease` answers with an OUTCOME, not a lease. Unwrapping it by discriminant
      // rather than reaching through an optional chain is what keeps the assertions below
      // falsifiable: `leaseBefore?.pid` is `undefined` on the outcome shape, so an optional-chain
      // form would have asserted nothing about a lease that was never read.
      if (leaseBefore.kind !== 'parsed') throw new Error(`no daemon lease: ${leaseBefore.kind}`)
      expect(leaseBefore.lease.pid).toBe(process.pid)

      // The forget is the direct change op, applied in the call by the daemon under its own lease.
      const operationId = 'e1d2c3b4-a596-4877-8695-a4b3c2d1e0f9'
      const applied = await callDaemon(
        paths,
        'knowledge.forget',
        { target: { grain: 'record', recordId }, operationId },
      ) as KnowledgeChangeOutput

      if (applied.outcome !== 'applied') throw new Error(`expected an applied forget, got ${applied.outcome}`)
      expect(applied.operationId).toBe(operationId)
      expect(applied.forgetReceipt?.proposalId).toBe(`prop_${operationId}`)
      expect(applied.forgetReceipt?.tombstonedRecords.map((row) => row.recordId))
        .toEqual([recordId])
      // Nothing was filed: the change is the call.
      const { existsSync } = await import('node:fs')
      expect(existsSync(join(paths.agentQaRoot, 'proposals'))).toBe(false)

      // The commit really landed in the store the daemon serves from.
      const rows = await callDaemon(paths, 'knowledge.bundles.list', {}) as { status: string }[]
      expect(rows.map((row) => row.status)).toEqual(['deprecated'])

      // The store fences epoch and lease id independently, so a foreign authority cannot commit.
      const leaseAfter = readWriterLease(paths.knowledgeRoot)
      if (leaseAfter.kind !== 'parsed') throw new Error(`lease vanished: ${leaseAfter.kind}`)
      expect(leaseAfter.lease.leaseId).toBe(leaseBefore.lease.leaseId)
      expect(leaseAfter.lease.epoch).toBe(leaseBefore.lease.epoch)
      expect(leaseAfter.lease.pid).toBe(leaseBefore.lease.pid)
    } finally {
      await daemon.stop()
    }
  }, 60_000)

  it('leaves an older proposal already on disk unapplied and unread through the daemon entry', async () => {
    const paths = makePaths('pre432')
    const recordId = await seedRecord(paths)
    grantApply(paths)
    const proposalId = await filePre432KnowledgeProposal({
      agentQaRoot: paths.agentQaRoot,
      knowledgeRoot: paths.knowledgeRoot,
      verb: 'forget',
      target: { grain: 'record', recordId },
    })
    const planted = join(paths.agentQaRoot, 'proposals', `${proposalId}.json`)
    const bytes = readFileSync(planted)
    const daemon = await startDaemon(paths)
    try {
      await expect(callDaemon(paths, 'knowledge.proposal.apply', { proposalId })).rejects.toThrow()
      const rows = await callDaemon(paths, 'knowledge.bundles.list', {}) as { status: string }[]
      expect(rows.map((row) => row.status)).not.toContain('deprecated')
      expect(readFileSync(planted)).toEqual(bytes)
    } finally {
      await daemon.stop()
    }
  }, 60_000)
})
