// A mark made while a live daemon holds the knowledge writer lease (quick 261002-mrk, closing
// 432-13 #1 and 432-09 #2).
//
// The mark's evidence step and its fix both write knowledge, so a CLI, dashboard or MCP mark used
// to stop at its evidence step with `Mark evidence writer lease held` whenever a daemon was
// running. The CLI host now hands the WHOLE `runs.mark` call to
// the lease holder over the existing `/invoke` socket, with the same registered op and the same
// input. The daemon runs it under the lease it already holds, and the caller answers the daemon's
// result unchanged. No op, endpoint or contract is added.
//
// The identity a retry carries is the mark's own: the run's mark ledger holds the resumable intent
// and its operation id, and the daemon and the CLI read the same ledger. So a retry, from either
// process, resumes that intent or answers the first receipt.
//
// These cells start the SHIPPED daemon (`runDaemonHost`, with only the lifecycle-heavy operations
// stubbed exactly as `daemon-apply-authority.test.ts` stubs them) over a temp mark fixture, and
// mark through the SHIPPED CLI composition (`composeCliLocalAgent` → `invokeFunction`).
//
// OBSERVED RED against agent-qa 527739eb4 (before the delegation), 2026-10-02:
//
//   Error: Mark evidence writer lease held; no mark receipt appended
//
// Follow-up: a holder that is not a daemon is waited out, bounded, before any refusal.
// OBSERVED RED against agent-qa 749bd9c7a, before the wait:
//
//   C-MRK-HOLDER-RELEASES  DaemonNotRunningError: agent-qa daemon is not running (absent).
//   C-MRK-HOLDER-KEEPS     expected DaemonNotRunningError … to match object { name: 'MarkWriterLeaseBusyError', … }
//
// C-MRK-DELEGATED-ONCE and C-MRK-DAEMON-UNREACHABLE are the controls: a daemon holder is delegated
// to, or refused at once, exactly as before.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import type { ConfigReaderPort, JobModelCapability } from '@vostride/agent-qa-agent'
import { invokeFunction, RUNS_MARK_FUNCTION_ID } from '@vostride/agent-qa-agent'
import { LOCAL_CURATION_CAPABILITIES } from '@vostride/agent-qa-agent-local'
import { readWriterLease } from '@vostride/agent-qa-knowledge-local'
import { RunsMarkOutcomeSchema, type RunsMarkInput, type RunsMarkOutcome, MASKED_RESOLVED_CONFIG_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CLI_FUNCTION_CALLER,
  composeCliLocalAgent,
  delegateMarkViaDaemon,
} from '../composition/local-agent-host.js'
import { runDaemonHost, type DaemonHostOperations, type DaemonHostTraceStep } from '../daemon/host.js'
import { DAEMON_REGISTRATION_SCHEMA_VERSION, readDaemonRegistration, writeDaemonRegistration } from '../daemon/registration.js'
import type { WholeMarkDelegate } from '../gates/feedback-host.js'
import { bundles, canonicalKnowledge, files, markFixture, projectOutsideStores } from '../gates/__tests__/feedback-fixture.js'

type Fixture = ReturnType<typeof markFixture>

const roots: string[] = []

const MODEL: JobModelCapability = {
  modelId: 'test:mark-whole-delegation',
  generate: () => Promise.resolve({ text: 'unused' }),
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): Fixture {
  const f = markFixture()
  roots.push(f.root)
  return f
}

const hashes = (dir: string) =>
  files(dir).map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])

/** Blocks the ledger's one atomic append, so the mark fails after every effect and before its receipt. */
function blockReceipt(runDir: string): () => void {
  const staged = join(runDir, 'marks.jsonl.pending')
  mkdirSync(staged)
  return () => rmSync(staged, { recursive: true, force: true })
}

/** One mark through the CLI's own composition and function door, the host closed after. */
async function markThroughCli(f: Fixture, input: RunsMarkInput, wholeMarkDelegate?: WholeMarkDelegate): Promise<RunsMarkOutcome> {
  const host = composeCliLocalAgent({ configPath: f.configPath, agentQaRoot: f.agentQaRoot,
    ...(wholeMarkDelegate === undefined ? {} : { wholeMarkDelegate }) })
  try {
    return RunsMarkOutcomeSchema.parse(
      await invokeFunction(host.registry, RUNS_MARK_FUNCTION_ID, input, CLI_FUNCTION_CALLER),
    )
  } finally {
    await host.close()
  }
}

interface LiveDaemon {
  /** Signals the daemon and answers its exit (the code, or what it rejected with). */
  readonly stop: () => Promise<unknown>
}

/** The shipped daemon over the fixture project, resolved once its registration is on disk. */
async function startDaemon(f: Fixture): Promise<LiveDaemon> {
  // A short base keeps the unix socket inside the platform path budget.
  const socketRoot = mkdtempSync('/tmp/aq-mrk-')
  roots.push(socketRoot)
  const signals = new Map<NodeJS.Signals, () => void>()
  const traces: DaemonHostTraceStep[] = []
  const errors: string[] = []
  const operations = {
    trace: (step: DaemonHostTraceStep) => traces.push(step),
    setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
    clearInterval: () => undefined,
    setTimeout: () => 2 as unknown as ReturnType<typeof setTimeout>,
    clearTimeout: () => undefined,
    onSignal: (signal: NodeJS.Signals, listener: () => void) => { signals.set(signal, listener) },
    offSignal: (signal: NodeJS.Signals, listener: () => void) => {
      if (signals.get(signal) === listener) signals.delete(signal)
    },
    hardExit: (code: number) => { throw new Error(`unexpected hard exit ${code}`) },
    startHeartbeatSupervisor: () => Promise.resolve({ exited: Promise.resolve(), stop: () => Promise.resolve() }),
    composeJobRecovery: () => ({
      store: { adoptEpoch: () => Promise.resolve({ epoch: 1 }) },
      recoverAbandonedClaims: () => Promise.resolve({ recovered: 0 }),
      resumePending: () => Promise.resolve([]),
      close: vi.fn(),
    }),
    inspectDrainableCurationWork: () => ({ queuedCandidateIds: [], recoverableClaimedCandidateIds: [] }),
    countRemainingCurationWork: () => ({ queued: 0, claimedNonterminal: 0, quarantined: 0 }),
    listQueuedCandidates: () => [],
    drainQueue: () => Promise.resolve({ drained: 0 }),
    appendDrainSessionReceipt: () => undefined,
  } as unknown as Partial<DaemonHostOperations>
  const config: ConfigReaderPort = {
    getMasked: () => Promise.resolve({ schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION, configPath: f.configPath, entries: [] }),
  }
  const running = runDaemonHost({
    agentQaRoot: f.agentQaRoot,
    knowledgeRoot: f.knowledgeRoot,
    configPath: f.configPath,
    socketPath: join(socketRoot, 'd.sock'),
    config,
    model: () => MODEL,
    operations,
    logger: { info: vi.fn(), error: (message) => errors.push(message) },
  })
  const deadline = Date.now() + 30_000
  while (!traces.includes('registration-written')) {
    if (errors.length > 0) throw new Error(`daemon refused to start: ${errors.join(' | ')}`)
    if (Date.now() >= deadline) throw new Error('daemon never wrote its registration')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  // 2026-10-03 (quick-261003-tsr, IN-18): `stop()` answers the exit instead of asserting it, so a
  // cell that calls it from `finally` reports its own failure first and asserts the exit after.
  return {
    stop: async (): Promise<unknown> => {
      const listener = signals.get('SIGTERM')
      if (listener === undefined) throw new Error('SIGTERM listener was not installed')
      listener()
      return await running.then((code) => code, (error: unknown) => error)
    },
  }
}

/** A writer lease held in this process with no daemon registered: another agent-qa process's hold. */
function holdLease(f: Fixture) {
  const held = LOCAL_CURATION_CAPABILITIES.maintenance.acquireWriterLease(f.knowledgeRoot)
  if (held.kind !== 'acquired') throw new Error('fixture could not take the lease')
  let released = false
  return {
    leaseId: held.leaseId,
    release: () => {
      if (!released) LOCAL_CURATION_CAPABILITIES.maintenance.releaseLease({ knowledgeRoot: f.knowledgeRoot, leaseId: held.leaseId })
      released = true
    },
  }
}

/** The shipped delegate with a short injected wait budget. */
function shortBudget(f: Fixture, holderReleaseBudgetMs: number) {
  return delegateMarkViaDaemon({ agentQaRoot: f.agentQaRoot, resolveKnowledgeRoot: () => f.knowledgeRoot,
    holderReleaseBudgetMs, pollIntervalMs: 20 } as Parameters<typeof delegateMarkViaDaemon>[0])
}

function daemonLease(f: Fixture) {
  const lease = readWriterLease(f.knowledgeRoot)
  if (lease.kind !== 'parsed') throw new Error(`no daemon lease: ${lease.kind}`)
  return lease.lease
}

/** The marked record's evidence events for this mark: the effect a second application would repeat. */
function evidenceFor(f: Fixture, markId: string) {
  const victim = bundles(f.knowledgeRoot).find(row => row.id === f.published.id)!
  return victim.bundle.events.filter((event: { type: string; evidenceToken?: string }) =>
    event.type === 'confirmed' && event.evidenceToken === `mark:${markId}`)
}

function receiptLines(f: Fixture): number {
  return readFileSync(join(f.runDir, 'marks.jsonl'), 'utf8').trim().split('\n').length
}

describe('a mark under a lease-holding daemon is delegated whole', () => {
  it('C-MRK-DELEGATED-ONCE: a CLI mark under a live daemon lands once through the daemon, and the CLI never takes the lease', async () => {
    const f = fixture()
    const daemon = await startDaemon(f)
    let exit: unknown
    try {
      const before = daemonLease(f)
      expect(before.pid).toBe(process.pid)

      const result = await markThroughCli(f, { runId: f.handoff.runId, kind: 'false-fail' })

      expect(result).toMatchObject({ kind: 'marked', receipt: { ordinal: 1, evidence: { confirmed: 1 },
        disposition: { kind: 'applied', fix: 'fact' } } })
      if (result.kind !== 'marked') throw new Error('expected a mark')
      expect(evidenceFor(f, result.receipt.markId), 'evidence once').toHaveLength(1)
      const victim = bundles(f.knowledgeRoot).find(row => row.id === f.published.id)!
      expect(victim.bundle.events.filter((event: { type: string }) => event.type === 'superseded'),
        'the fix published once').toHaveLength(1)
      expect(receiptLines(f)).toBe(1)
      expect(existsSync(join(f.runDir, 'mark-intent.json')), 'no intent left behind').toBe(false)

      // The daemon's lease is untouched: the CLI neither took nor released it, and the daemon's
      // mark committed with the authority it already holds.
      const after = daemonLease(f)
      expect({ leaseId: after.leaseId, epoch: after.epoch, pid: after.pid })
        .toEqual({ leaseId: before.leaseId, epoch: before.epoch, pid: before.pid })
    } finally {
      exit = await daemon.stop()
    }
    expect(exit, 'the daemon did not exit cleanly').toBe(0)
  }, 90_000)

  it('C-MRK-DELEGATED-RETRY: an interrupted delegated mark, retried, resumes its intent and lands every effect once', async () => {
    const f = fixture()
    const daemon = await startDaemon(f)
    let exit: unknown
    try {
      const input: RunsMarkInput = { runId: f.handoff.runId, kind: 'false-fail' }
      const unblock = blockReceipt(f.runDir)
      await expect(markThroughCli(f, input)).rejects.toThrow()
      unblock()
      const intent = JSON.parse(readFileSync(join(f.runDir, 'mark-intent.json'), 'utf8')) as {
        stage: string; operationId: string
      }
      expect(intent.stage, 'the daemon reached its last checkpoint').toBe('applied')
      expect(existsSync(join(f.runDir, 'marks.jsonl')), 'no receipt before the retry').toBe(false)
      const outside = projectOutsideStores(f)
      const knowledge = canonicalKnowledge(f.knowledgeRoot)

      const retried = await markThroughCli(f, input)

      expect(retried).toMatchObject({ kind: 'marked', receipt: { ordinal: 1, evidence: { confirmed: 1 } } })
      if (retried.kind !== 'marked') throw new Error('expected a mark')
      const disposition = retried.receipt.disposition
      if (disposition.kind !== 'applied' || disposition.change.kind !== 'knowledge') {
        throw new Error('expected an applied knowledge fix')
      }
      // The retry carried the first attempt's operation identity: the fix it reports is the change
      // that identity already landed, and nothing was published or appended again.
      expect(disposition.change.changeId).toBe(`prop_${intent.operationId}`)
      expect(canonicalKnowledge(f.knowledgeRoot), 'no second publication or evidence').toEqual(knowledge)
      expect(projectOutsideStores(f), 'nothing outside the stores is written').toEqual(outside)
      expect(evidenceFor(f, retried.receipt.markId)).toHaveLength(1)
      expect(receiptLines(f)).toBe(1)

      // A further retry answers the first receipt, byte for byte.
      expect(await markThroughCli(f, input)).toEqual({ kind: 'already-marked', receipt: retried.receipt })
      expect(receiptLines(f)).toBe(1)
    } finally {
      exit = await daemon.stop()
    }
    expect(exit, 'the daemon did not exit cleanly').toBe(0)
  }, 120_000)

  it('C-MRK-NO-HOLDER-LOCAL: with no live holder the delegate answers nothing and the CLI mark runs locally', async () => {
    const f = fixture()
    const delegate = delegateMarkViaDaemon({ agentQaRoot: f.agentQaRoot, resolveKnowledgeRoot: () => f.knowledgeRoot })
    expect(await delegate({ runId: f.handoff.runId, kind: 'false-fail' }), 'no holder: run locally').toBeUndefined()

    const result = await markThroughCli(f, { runId: f.handoff.runId, kind: 'false-fail' })

    expect(result).toMatchObject({ kind: 'marked', receipt: { ordinal: 1, evidence: { confirmed: 1 },
      disposition: { kind: 'applied', fix: 'fact' } } })
    expect(readDaemonRegistration(f.agentQaRoot).kind, 'no daemon was involved').toBe('absent')
    // The local mark took the lease for its evidence and its fix, and released it.
    expect(readWriterLease(f.knowledgeRoot).kind).not.toBe('parsed')
    expect(receiptLines(f)).toBe(1)
  }, 60_000)

  // 2026-10-02 (261002-mrk follow-up): a lease held by another agent-qa process that is NOT a
  // daemon (a dashboard's post-run curation, another terminal's change) is waited out for a bounded
  // time, and only a holder that outlasts the budget refuses, by name. Short injected budgets here.
  it('C-MRK-HOLDER-RELEASES: a non-daemon holder that releases within the budget lets the mark land locally, once', async () => {
    const f = fixture()
    const holder = holdLease(f)
    const timer = setTimeout(holder.release, 150)
    try {
      const result = await markThroughCli(f, { runId: f.handoff.runId, kind: 'false-fail' }, shortBudget(f, 5_000))
      expect(result).toMatchObject({ kind: 'marked', receipt: { ordinal: 1, evidence: { confirmed: 1 },
        disposition: { kind: 'applied', fix: 'fact' } } })
      if (result.kind !== 'marked') throw new Error('expected a mark')
      expect(evidenceFor(f, result.receipt.markId), 'evidence once').toHaveLength(1)
      expect(receiptLines(f)).toBe(1)
      expect(readDaemonRegistration(f.agentQaRoot).kind, 'no daemon was involved').toBe('absent')
    } finally {
      clearTimeout(timer)
      holder.release()
    }
  }, 60_000)

  it('C-MRK-HOLDER-KEEPS: a non-daemon holder that outlasts the budget refuses by name, writes nothing, and a retry resumes', async () => {
    const f = fixture()
    const holder = holdLease(f)
    try {
      const before = hashes(f.root)
      const refusal = await markThroughCli(f, { runId: f.handoff.runId, kind: 'false-fail' }, shortBudget(f, 200))
        .then(() => undefined, (error: unknown) => error as Error & { holderPid?: number })
      expect(refusal).toMatchObject({ name: 'MarkWriterLeaseBusyError', holderPid: process.pid })
      // the holder is this very process, and the refusal says so.
      expect(refusal?.message).toContain(`This agent-qa process (pid ${process.pid}) is already writing`)
      expect(refusal?.message).not.toContain('Another agent-qa process')
      expect(refusal?.message).toContain('Retry the mark when it finishes')
      expect(hashes(f.root), 'nothing was written: no intent, no evidence').toEqual(before)
      const lease = readWriterLease(f.knowledgeRoot)
      expect(lease.kind === 'parsed' && lease.lease.leaseId, 'the holder keeps its lease').toBe(holder.leaseId)
      holder.release()

      const retried = await markThroughCli(f, { runId: f.handoff.runId, kind: 'false-fail' }, shortBudget(f, 200))
      expect(retried).toMatchObject({ kind: 'marked', receipt: { ordinal: 1, evidence: { confirmed: 1 },
        disposition: { kind: 'applied', fix: 'fact' } } })
      expect(receiptLines(f)).toBe(1)
    } finally {
      holder.release()
    }
  }, 60_000)

  it('C-MRK-DAEMON-UNREACHABLE: a lease that names a registered daemon nobody answers for refuses with DaemonNotRunningError at once', async () => {
    const f = fixture()
    const holder = holdLease(f)
    const socketRoot = mkdtempSync('/tmp/aq-mrk-')
    roots.push(socketRoot)
    writeDaemonRegistration(f.agentQaRoot, {
      schemaVersion: DAEMON_REGISTRATION_SCHEMA_VERSION,
      instanceId: '55555555-5555-4555-8555-555555555555',
      pid: process.pid,
      socketPath: join(socketRoot, 'gone.sock'),
      startedAtMs: Date.now(),
    })
    try {
      const before = hashes(f.knowledgeRoot)
      const started = Date.now()
      await expect(markThroughCli(f, { runId: f.handoff.runId, kind: 'false-fail' }, shortBudget(f, 30_000)))
        .rejects.toMatchObject({ name: 'DaemonNotRunningError' })
      expect(Date.now() - started, 'a daemon holder is not waited out').toBeLessThan(15_000)
      expect(hashes(f.knowledgeRoot)).toEqual(before)
      expect(existsSync(join(f.runDir, 'mark-intent.json'))).toBe(false)
    } finally {
      holder.release()
    }
  }, 60_000)
})
