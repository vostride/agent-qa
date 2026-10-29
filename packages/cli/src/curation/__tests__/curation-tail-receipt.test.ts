import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { chainJobIdsForRun } from '@vostride/agent-qa-agent'
import { composeLocalAgent, LOCAL_CURATION_CAPABILITIES, DIGEST_JOB_ID_SOURCE, type ComposeLocalAgentInput } from '@vostride/agent-qa-agent-local'
import { runSafetyScope } from '@vostride/agent-qa-safety-local'
import {
  asRecordId,
  asRunId,
  CURRENT_HANDOFF_SCHEMA_VERSION,
  CurationSnapshotSchema,
  type CompletedRunHandoff,
  CURRENT_BUS_SCHEMA_VERSION,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
  RECORD_CHANGE_SCHEMA_VERSION,
  CURATION_SNAPSHOT_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import * as tailModule from '../curation-tail.js'
import { emptyCanaryCreditCounters } from '../canary-credit.js'
import { defaultPostRunTailOperations, runPostRunTail, type PostRunTailHostInput, type PostRunTailOperations } from '../post-run-tail.js'
import { enqueueThroughTheStep } from '../../__tests__/post-run-step-harness.js'
import { runDaemonHost, type DaemonHostOperations } from '../../daemon/host.js'
import {
  createInProcessFixture,
  removeInProcessFixtures,
} from '../../composition/__tests__/in-process-run-fixture.js'

const roots: string[] = []
const RUN_ID = asRunId('synthetic-423-run')
const snapshot = CurationSnapshotSchema.parse({ schemaVersion: CURATION_SNAPSHOT_SCHEMA_VERSION,
  rows: ['added', 'confirmed', 'superseded', 'deprecated', 'proposed'].map((bucket, i) => ({
    recordId: `record-${i}`, bucket, ...(bucket === 'superseded' ? { byRecordId: 'replacement' } : {}),
    changes: [{ bucket, change: { schemaVersion: RECORD_CHANGE_SCHEMA_VERSION, recordId: `record-${i}`,
      change: bucket === 'proposed' ? 'added' : bucket, atOrdinal: 42,
      sourceRunId: RUN_ID, observationId: `observation-${i}`,
      ...(bucket === 'superseded' ? { byRecordId: 'replacement' } : {}) } }],
  })), breakdown: { added: 1, confirmed: 1, superseded: 1, deprecated: 1, proposed: 1 } })
const ZERO_SNAPSHOT = { schemaVersion: CURATION_SNAPSHOT_SCHEMA_VERSION, rows: [],
  breakdown: { added: 0, confirmed: 0, superseded: 0, deprecated: 0, proposed: 0 } }
const malformedSnapshot = { ...snapshot, breakdown: { ...snapshot.breakdown, added: 20 } }
function tempRoot() { const root = mkdtempSync(join(tmpdir(), '423-curation-tail-')); roots.push(root); return root }
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
afterAll(() => { removeInProcessFixtures() })

function fixture(over: Record<string, unknown> = {}) {
  const root = tempRoot()
  const info = vi.fn()
  const drainQueue = vi.fn(async () => ({ kind: 'drained', committed: 9, deprecated: 2,
    failures: 0, requeued: 0, remaining: 0, noops: 0, noopDetails: [], snapshot, ...over }))
  const canaryDetail = { candidateId: asRecordId('canary'), testId: 'test', testIndex: 0,
    stepIndex: 1, benefit: 'positive', outcome: { kind: 'emitted' } }
  const operations = {
    runSafetyScope: async (_options: unknown, body: () => Promise<void>) => body(),
    emitCurationCandidates: () => ({ details: [], refused: 0, capExceeded: 0 }),
    openKnowledgeReader: () => ({ emitCanaryOutcome: () => undefined }),
    emitCanaryOutcomes: async () => ({ refused: 0, unresolved: 0, canary: emptyCanaryCreditCounters(), details: [canaryDetail] }),
    foldRunOutcomes: () => ({ kind: 'folded', quarantine: { kind: 'not-evaluated' } }),
    drainQueue,
  } as unknown as Partial<tailModule.CurationTailOperations>
  const input = { runDir: root, handoff: { runId: RUN_ID, schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION, buildOrdinal: 42,
    executionContext: 'local-headless', scope: { tier: 'product', key: 'storefront' } },
    knowledgeRoot: join(root, 'knowledge'), agentQaRoot: root,
    authority: { leaseId: 'lease', epoch: 1 }, log: { warn: vi.fn(), info }, operations,
  } as unknown as tailModule.CurateCompletedRunInput
  return { root, input, drainQueue, info, canaryDetail }
}

describe('423 curation tail snapshot', () => {
  it('TAIL-SNAPSHOT-ROUNDTRIP persists exact rows and returns the immutable completed receipt after later effects', async () => {
    const f = fixture()
    const first = await tailModule.curateCompletedRun(f.input)
    expect(first).toHaveProperty('snapshot', snapshot)
    expect(tailModule.readCurationTailReceipt(f.root)).toHaveProperty('snapshot', snapshot)
    const before = readFileSync(join(f.root, tailModule.CURATION_TAIL_RECEIPT_FILE))
    f.drainQueue.mockImplementation(async () => { throw new Error('a completed run must not refold later effects') })
    const second = await tailModule.curateCompletedRun(f.input)
    expect(second).toHaveProperty('snapshot', snapshot)
    expect(f.drainQueue).toHaveBeenCalledTimes(1)
    expect(readFileSync(join(f.root, tailModule.CURATION_TAIL_RECEIPT_FILE)).equals(before)).toBe(true)
    expect(f.info).toHaveBeenCalledWith('curation: added 1, confirmed 1, superseded 1, deprecated 1, proposed 1')
  })

  it('TAIL-RECEIPT-COUNTS persists curated and deprecated so a rerun short-circuit returns them without draining', async () => {
    const f = fixture({ committed: 3, deprecated: 1 })
    expect(await tailModule.curateCompletedRun(f.input)).toMatchObject({ curated: 3, deprecated: 1, complete: true, snapshot })
    expect(tailModule.readCurationTailReceipt(f.root)).toMatchObject({ curated: 3, deprecated: 1, snapshot })
    const second = await tailModule.curateCompletedRun(f.input)
    expect(second).toEqual({ curated: 3, deprecated: 1, complete: true, drainKind: 'drained', snapshot })
    expect(f.drainQueue).toHaveBeenCalledTimes(1)
  })

  it('TAIL-ZERO-EFFECT-SNAPSHOT records the all-zero snapshot from the real drain and short-circuits a rerun on it', async () => {
    const f = fixture()
    mkdirSync(f.input.knowledgeRoot, { recursive: true })
    const drainQueue = vi.fn(LOCAL_CURATION_CAPABILITIES.drainQueue)
    const { authority: _fake, ...unleased } = f.input
    const input = { ...unleased,
      operations: { ...f.input.operations, drainQueue } } as tailModule.CurateCompletedRunInput
    const first = await tailModule.curateCompletedRun(input)
    expect(first).toMatchObject({ complete: true, drainKind: 'drained', curated: 0, deprecated: 0 })
    expect(first.snapshot).toEqual(ZERO_SNAPSHOT)
    expect(tailModule.readCurationTailReceipt(f.root)?.snapshot).toEqual(ZERO_SNAPSHOT)
    const before = readFileSync(join(f.root, tailModule.CURATION_TAIL_RECEIPT_FILE))
    const second = await tailModule.curateCompletedRun(input)
    expect(second.snapshot).toEqual(ZERO_SNAPSHOT)
    expect(drainQueue).toHaveBeenCalledTimes(1)
    expect(readFileSync(join(f.root, tailModule.CURATION_TAIL_RECEIPT_FILE)).equals(before)).toBe(true)
    expect(f.info).toHaveBeenCalledWith('curation: added 0, confirmed 0, superseded 0, deprecated 0, proposed 0')
  })

  it('TAIL-LEGACY-READ retains historical counters without minting a snapshot', async () => {
    const f = fixture({ snapshot: undefined })
    await tailModule.curateCompletedRun(f.input)
    const path = join(f.root, tailModule.CURATION_TAIL_RECEIPT_FILE)
    const legacy = { ...JSON.parse(readFileSync(path, 'utf8')), curated: 7, deprecated: 2 }
    delete legacy.snapshot
    writeFileSync(path, JSON.stringify(legacy))
    expect(tailModule.readCurationTailReceipt(f.root)).toMatchObject({ curated: 7, deprecated: 2 })
    expect(tailModule.readCurationTailReceipt(f.root)).not.toHaveProperty('snapshot')
  })

  it.each([{ failures: 1 }, { remaining: 1 }, { requeued: 1 }])('TAIL-INCOMPLETE with %j cannot publish completed counts', async (over) => {
    const f = fixture(over)
    expect(await tailModule.curateCompletedRun(f.input)).toMatchObject({ complete: false })
    expect(await tailModule.readCurationTailReceipt(f.root)).toBeUndefined()
  })

  it('TAIL-ATTRIBUTION passes exact run and emitted canary observation identities to the drain', async () => {
    const f = fixture()
    await tailModule.curateCompletedRun(f.input)
    expect(f.drainQueue).toHaveBeenCalledWith(expect.objectContaining({ sourceRunId: RUN_ID,
      observationIds: [LOCAL_CURATION_CAPABILITIES.canaryOutcomeObservationId({ ...f.canaryDetail, runId: RUN_ID })] }))
  })

  it('TAIL-VALIDATION omits a malformed supplied snapshot from the written receipt', async () => {
    const f = fixture({ snapshot: malformedSnapshot })
    await expect(tailModule.curateCompletedRun(f.input)).resolves.toMatchObject({ complete: true })
    const written = tailModule.readCurationTailReceipt(f.root)
    expect(written).toBeDefined()
    expect(written).not.toHaveProperty('snapshot')
    expect(readFileSync(join(f.root, tailModule.CURATION_TAIL_RECEIPT_FILE), 'utf8')).not.toContain('"snapshot"')
    const invalid = { ...written, snapshot: malformedSnapshot }
    expect(() => tailModule.defaultCurationTailOperations().writeCurationTailReceipt(f.root, invalid as never)).toThrow()
  })

  it.each([
    ['a malformed drain snapshot', { snapshot: malformedSnapshot }],
    ['a failed snapshot fold', { snapshot: undefined, snapshotFoldFailed: true }],
  ] as const)('TAIL-SNAPSHOT-DEGRADES completes on %s and records no snapshot', async (_label, over) => {
    const f = fixture(over)
    const writeCurationTailReceipt = vi.fn()
    const input = { ...f.input, operations: { ...f.input.operations,
      readCurationTailReceipt: () => undefined, writeCurationTailReceipt } } as tailModule.CurateCompletedRunInput
    const folded = tailModule.curateCompletedRun(input)
    await expect(folded).resolves.toMatchObject({ complete: true, drainKind: 'drained' })
    expect(await folded).not.toHaveProperty('snapshot')
    expect(writeCurationTailReceipt).toHaveBeenCalledTimes(1)
    expect(writeCurationTailReceipt.mock.calls[0]![1]).not.toHaveProperty('snapshot')
    const warn = f.input.log.warn as ReturnType<typeof vi.fn>
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      'curation snapshot could not be validated and was not recorded; committed bundles are unaffected')
    expect(String(warn.mock.calls[0]![0])).not.toMatch(/record-|observation-|replacement/)
  })

  it('CURATE-CAPABILITY-SNAPSHOT terminal preserves complete snapshot through the real tail adapter', async () => {
    const root = tempRoot()
    let bound: PostRunTailHostInput | undefined
    const folded = { curated: 9, deprecated: 2, complete: true, drainKind: 'drained' as const, snapshot }
    const operations = {
      loadCompletedRunHandoff: () => ({ runId: RUN_ID, schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION, executionContext: 'local-headless' }),
      resolveKnowledgeRoot: () => join(root, 'knowledge'),
      composeHost: (input: PostRunTailHostInput) => { bound = input; return {
        jobs: async () => ({ queue: { runNextJob: async () => ({ ran: false, reason: 'no-job' }),
          recoverAbandonedClaims: async () => ({ released: [] }) },
          store: { adoptEpoch: async () => ({ epoch: 7 }) }, idSource: DIGEST_JOB_ID_SOURCE }), close: async () => undefined } },
      acquireWriterLease: () => ({ kind: 'acquired', leaseId: 'lease-tail', epoch: 7 }),
      releaseLease: () => ({ kind: 'released' }), nudgeDaemon: async () => undefined,
      curateCompletedRun: async () => folded, runCurationTail: async () => undefined,
      createChipEmitter: () => ({ observe: () => undefined, finish: () => undefined }),
      readPostProcessingStatus: async () => ({ kind: 'ready' }), readRunDigest: async () => ({}), now: () => 1000,
    } as unknown as PostRunTailOperations
    await runPostRunTail({ runId: RUN_ID, agentQaRoot: root, configPath: join(root, 'agent-qa.config.yaml'),
      knowledgeConfig: { dir: 'knowledge' }, configDir: root,
      log: { warn: () => undefined }, operations } as never).drain()
    expect(await bound!.curateRun({ runId: RUN_ID, executionContext: 'local-headless' })).toHaveProperty('snapshot', snapshot)
  })

  it('CURATE-CAPABILITY-ZERO-EFFECT terminal checkpoints and serves the all-zero snapshot through the real tail adapter', async () => {
    const root = tempRoot()
    const zeroRun = 'run-427-04-zero-effect'
    const knowledge = join(root, 'knowledge')
    mkdirSync(knowledge, { recursive: true })
    mkdirSync(tailModule.completedRunDir(root, zeroRun), { recursive: true })
    writeFileSync(tailModule.completedRunHandoffPath(root, zeroRun), `${JSON.stringify(zeroEffectHandoff(zeroRun))}\n`, 'utf8')
    writeFileSync(tailModule.completedRunEventsPath(root, zeroRun), `${zeroEffectEvents(zeroRun)
      .map(line => JSON.stringify(line)).join('\n')}\n`, 'utf8')
    const hosts: ReturnType<typeof composeLocalAgent>[] = []
    // The tail's own `curateRun` is bound into the composition, so the fold is the shipped
    // curateCompletedRun over the real drain; nothing here hands it a snapshot.
    const composeHost = (input?: PostRunTailHostInput): never => {
      const host = composeLocalAgent({
        mask: (text: string) => text,
        mintQuarantineIdentityPath: (filePath: string) => filePath,
        agentQaRoot: root, config: TEST_CONFIG, knowledgeRoot: () => knowledge,
        model: () => ({ modelId: 'test:427-04-zero-effect', generate: async () => ({ text: 'not an author payload' }) }),
        idSource: DIGEST_JOB_ID_SOURCE,
        postRun: { curateRun: input?.curateRun ?? (async () => { throw new Error('the enqueue host never folds') }),
          candidateProse: 'masker-active' },
      } as unknown as ComposeLocalAgentInput)
      hosts.push(host)
      return host as never
    }
    const configPath = join(root, 'agent-qa.config.yaml')
    const served = await runSafetyScope({ executionContext: 'local-headless' }, async () => {
      await enqueueThroughTheStep({ runId: zeroRun, agentQaRoot: root, configPath, composeHost: () => composeHost() })
      const tail = runPostRunTail({ runId: zeroRun, agentQaRoot: root, configPath,
        knowledgeConfig: { dir: 'knowledge' }, configDir: root,
        log: { warn: () => undefined, info: () => undefined },
        operations: { resolveKnowledgeRoot: () => knowledge, runCurationTail: async () => undefined,
          composeHost } as unknown as PostRunTailOperations } as never)
      await tail.drain()
      await tail.finish()
      expect(tail.report().drain).toBe('drained')
      return await defaultPostRunTailOperations().readPostProcessingStatus(composeHost(), zeroRun)
    })
    for (const host of hosts) await host.close()
    expect(tailModule.readCurationTailReceipt(tailModule.completedRunDir(root, zeroRun))?.snapshot).toEqual(ZERO_SNAPSHOT)
    const db = new DatabaseSync(join(root, 'agent-jobs.db'), { readOnly: true })
    try {
      const row = db.prepare(`SELECT payload_json FROM job_checkpoints WHERE job_id = ? AND checkpoint_id = ?
        ORDER BY attempt DESC LIMIT 1`).get(String(chainJobIdsForRun(zeroRun, DIGEST_JOB_ID_SOURCE).curateMemory), 'bundle-committed')
      expect(row, 'no bundle-committed checkpoint').toBeDefined()
      expect(JSON.parse(String(row!.payload_json)).value).toEqual({ runId: zeroRun, curated: 0, deprecated: 0, curationSnapshot: ZERO_SNAPSHOT })
    } finally { db.close() }
    expect(served.chips.curation).toBe('complete')
    expect(served.curationSnapshot).toEqual(ZERO_SNAPSHOT)
    expect(served).not.toHaveProperty('curationSnapshotWithheld')
    expect(served.notification?.stages.curation.curationSnapshot).toEqual(ZERO_SNAPSHOT)
  })

  it('CURATE-CAPABILITY-SNAPSHOT daemon preserves complete snapshot through its real bound capability', async () => {
    const defaultOperations = tailModule.defaultCurationTailOperations()
    vi.spyOn(tailModule, 'defaultCurationTailOperations').mockReturnValue({ ...defaultOperations,
      loadCompletedRunHandoff: (() => ({ runId: RUN_ID, schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION, buildOrdinal: 42,
        executionContext: 'local-headless', scope: { tier: 'product', key: 'storefront' } })) as never })
    vi.spyOn(tailModule, 'curateCompletedRun').mockResolvedValue({ curated: 9, deprecated: 2,
      complete: true, drainKind: 'drained', snapshot } as never)
    const daemon = await startDaemon()
    try {
      expect(await daemon.postRun().curateRun({ runId: RUN_ID, executionContext: 'local-headless' })).toHaveProperty('snapshot', snapshot)
      expect(daemon.postRun().candidateProse).toBe('no-masker')
    } finally { await daemon.stop() }
  })
})

/** A passing run with no step to learn from: its fold files no curation candidate. */
function zeroEffectHandoff(runId: string): CompletedRunHandoff {
  return { schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION, runId: asRunId(runId),
    scope: { tier: 'product', key: 'zero-effect-storefront' }, buildOrdinal: 7, executionContext: 'local-headless',
    aggregateVerdict: 'passed', configDigests: { suiteConfigDigest: 'suite-digest', testConfigDigest: 'test-digest' },
    startedAt: 1, endedAt: 2,
    tests: [{ testId: 't_passed', testName: 'checks out', filePath: 'tests/checkout.yaml', testIndex: 0, outcome: 'passed', steps: [] }],
  } as unknown as CompletedRunHandoff
}
function zeroEffectEvents(runId: string) {
  return [
    { seq: 1, ts: 10, runId, type: 'runStarted', payload: { busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION } },
    { seq: 2, ts: 20, runId, type: 'verdict', payload: { verdict: 'passed' } },
    { seq: 3, ts: 30, runId, type: 'runFinished', payload: { aggregateVerdict: 'passed', disposition: 'detached', finalSeq: 3 } },
  ]
}

const DAEMON_LEASE = { leaseId: 'lease-daemon', epoch: 41 }
const TEST_CONFIG = { getMasked: async () => ({ schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION, configPath: '/tmp/423.config.yaml', entries: [] }) }
const TEST_MODEL = { modelId: 'synthetic:test', generate: async () => { throw new Error('no provider work') } }
async function startDaemon() {
  const fixture = createInProcessFixture({ origin: 'http://127.0.0.1:1', environment: 'local' })
  roots.push(fixture.project)
  const signals = new Map<NodeJS.Signals, () => void>()
  let composed: ComposeLocalAgentInput | undefined
  let started = false
  const operations = {
    acquireWriterLease: () => ({ kind: 'acquired', ...DAEMON_LEASE }),
    releaseLease: () => ({ kind: 'released' }),
    heartbeatLease: () => ({ kind: 'alive', holder: { ...DAEMON_LEASE, pid: process.pid } }),
    readWriterLease: () => ({ kind: 'free' }),
    composeJobRecovery: () => ({
      store: { adoptEpoch: async () => ({ epoch: DAEMON_LEASE.epoch }) },
      recoverAbandonedClaims: async () => ({ recovered: 0 }),
      close: vi.fn(),
    }),
    composeLocalAgent: (input: ComposeLocalAgentInput) => {
      composed = input
      return {
        registry: {},
        jobs: async () => ({
          queue: { runNextJob: async () => ({ ran: false, reason: 'no-job' }) },
        }),
        close: vi.fn(),
      }
    },
    reconcileRunOutcomesProjection: () => ({ kind: 'skipped' as const }),
    inspectDrainableCurationWork: () => ({
      queuedCandidateIds: [],
      recoverableClaimedCandidateIds: [],
    }),
    countRemainingCurationWork: () => ({ queued: 0, claimedNonterminal: 0, quarantined: 0 }),
    listQueuedCandidates: () => [],
    drainQueue: async () => ({ kind: 'drained', jobsProcessed: 0, committed: 0, failures: 0 }),
    runMaintenanceTail: async () => undefined,
    appendDrainSessionReceipt: () => undefined,
    setInterval: () => 1,
    clearInterval: () => undefined,
    setTimeout: () => 1,
    clearTimeout: () => undefined,
    onSignal: (signal: NodeJS.Signals, listener: () => void) => signals.set(signal, listener),
    offSignal: (signal: NodeJS.Signals) => signals.delete(signal),
    startHeartbeatSupervisor: async () => ({ exited: new Promise<void>(() => {}), stop: async () => undefined }),
    startInvokeServer: async (input: { socketPath: string }) => {
      started = true
      return { socketPath: input.socketPath, close: async () => undefined }
    },
  } as unknown as Partial<DaemonHostOperations>
  const running = runDaemonHost({
    agentQaRoot: fixture.agentQaRoot,
    knowledgeRoot: join(fixture.project, 'knowledge'),
    configPath: fixture.configPath,
    config: TEST_CONFIG,
    model: () => TEST_MODEL,
    author: () => async () => ({ kind: 'fallback-required' as const, reason: 'no-model' as const }),
    operations,
    logger: { info: () => undefined, error: () => undefined },
  } as unknown as Parameters<typeof runDaemonHost>[0])
  await vi.waitFor(() => expect(started).toBe(true))
  return {
    postRun: () => composed!.postRun!,
    async stop() {
      signals.get('SIGTERM')!()
      await running
    },
  }
}
