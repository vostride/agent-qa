// Delegate-and-wait: a knowledge change is synchronous from the caller's seat in BOTH lease states
// (387-08, D-18 — the 386 D-14 drain contract).
//
// The lease-held case is the load-bearing one and it is run over a REAL unix socket: a real
// `startInvokeServer`, a real registration, a real `invokeViaDaemon`, the real `/invoke` route
// reaching the real op. No new daemon code exists for it to exercise — that is the claim, and the
// test is what makes it checkable rather than asserted.
//
// The structural-refusal half is what the case is really for. It is not enough that the delegating
// process ANSWERS; it must be shown never to have taken the lease, so the holder's lease id and
// epoch are read before and after and the delegator's own acquisition is asserted to be refused
// throughout.
//
// 2026-10-01, 432-16 (D-05/D-15): RE-SPELLED AS DIRECT CHANGES. The first describe used to hand a
// pre-432 forget PROPOSAL to `knowledge.proposal.apply`, record a standing approval first so the
// ask-tier apply would pass the gate, and route the proposal id through `applyDelegate`. The gate
// and the approval are gone and a change files no proposal, so each of its three claims is now
// measured on the direct `knowledge.forget` change: in-process when the lease is free, handed to
// the live holder with its operation identity when it is not, and bounded rather than hanging.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { invokeFunction } from '@vostride/agent-qa-agent'
import type { ConfigReaderPort, JobModelCapability } from '@vostride/agent-qa-agent'
import { composeLocalAgent } from '@vostride/agent-qa-agent-local'
import type { LocalAgentHost } from '@vostride/agent-qa-agent-local'
import type { FunctionCaller, KnowledgeChangeOutput } from '@vostride/agent-qa-schema'
import { MASKED_RESOLVED_CONFIG_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it } from 'vitest'

import { delegateKnowledgeChangeViaDaemon } from '../composition/local-agent-host.js'
import {
  DAEMON_IDENTITY_SCHEMA_VERSION,
  startInvokeServer,
  type InvokeServerHandle,
} from '../daemon/server.js'
import {
  DAEMON_REGISTRATION_SCHEMA_VERSION,
  writeDaemonRegistration,
} from '../daemon/registration.js'

/**
 * The composition's REQUIRED quarantine identity mint (390-12 / D-01). Passthrough here: this
 * fixture already speaks canonical workspace-relative bytes, and the recipe itself stays pinned
 * in core's `workspace-paths.test.ts` — what these hosts exercise is everything BUT quarantine.
 */
const MINT_IDENTITY = (filePath: string): string => filePath

const roots: string[] = []
const hosts: LocalAgentHost[] = []
const servers: InvokeServerHandle[] = []
const INSTANCE_ID = '44444444-4444-4444-8444-444444444444'

const MASKED_CONFIG = {
  schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION as typeof MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
  configPath: '/fixture/agent-qa.config.yaml',
  entries: [],
}
const CONFIG: ConfigReaderPort = { getMasked: () => Promise.resolve(MASKED_CONFIG) }
const MODEL: JobModelCapability = {
  modelId: 'test:apply-delegate',
  generate: () => Promise.resolve({ text: 'unused' }),
}

const CALLER: FunctionCaller = {
  surface: 'test',
  origin: 'agent',
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const host of hosts.splice(0)) await host.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface Fixture {
  readonly root: string
  readonly agentQaRoot: string
  readonly knowledgeRoot: string
  readonly socketPath: string
}

function fixture(label: string): Fixture {
  const base = process.platform === 'win32' ? tmpdir() : '/tmp'
  const root = mkdtempSync(join(base, `agent-qa-apply-delegate-${label}-`))
  roots.push(root)
  return {
    root,
    agentQaRoot: join(root, '.agent-qa'),
    knowledgeRoot: join(root, 'agent-qa-knowledge'),
    socketPath: join(root, 'daemon.sock'),
  }
}

function host(
  where: Fixture,
  extra: Partial<Parameters<typeof composeLocalAgent>[0]> = {},
): LocalAgentHost {
  const composed = composeLocalAgent({
    mask: (text) => text,
    mintQuarantineIdentityPath: MINT_IDENTITY,
    agentQaRoot: where.agentQaRoot,
    config: CONFIG,
    knowledgeRoot: () => where.knowledgeRoot,
    model: () => MODEL,
    ...extra,
  })
  hosts.push(composed)
  return composed
}

/** Seed one committed bundle by going through the layer's own publish helper. */
async function seedRecord(where: Fixture): Promise<string> {
  const { publishBundleForTest } = await import('@vostride/agent-qa-knowledge-local')
  const outcome = publishBundleForTest(
    {
      knowledgeRoot: where.knowledgeRoot,
      productKey: 'Delegate Product',
    },
    {
      draft: {
        kind: 'fact',
        subtype: 'selector',
        anchors: [{ t: 'el', role: 'Button', name: 'Checkout' }],
        scope: { tier: 'product', key: 'delegate' },
        summary: 'checkout button',
        body: 'Selecting Checkout advances to the payment page.',
        distilledEvidenceRef: { id: 'delegate-evidence', sha: 'b'.repeat(64) },
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
      provenance: { mode: 'run-linked', runId: 'delegate', testId: 't', stepIndex: 0 },
      artifacts: [],
    },
  )
  if (outcome.kind !== 'published') throw new Error(`fixture publish failed: ${outcome.kind}`)
  return outcome.id
}

/** The daemon registration and `/invoke` server a live lease holder answers on. */
async function serveHolder(where: Fixture, registry: LocalAgentHost['registry']): Promise<void> {
  writeDaemonRegistration(where.agentQaRoot, {
    schemaVersion: DAEMON_REGISTRATION_SCHEMA_VERSION,
    instanceId: INSTANCE_ID,
    pid: process.pid,
    socketPath: where.socketPath,
    startedAtMs: Date.now(),
  })
  servers.push(await startInvokeServer({
    socketPath: where.socketPath,
    registry,
    identity: { schemaVersion: DAEMON_IDENTITY_SCHEMA_VERSION, instanceId: INSTANCE_ID, pid: process.pid },
  }))
}

describe('a knowledge change routes by lease state', () => {
  // RE-SPELLED 2026-10-01 (432-16): was the pre-432 forget proposal applied through
  // `knowledge.proposal.apply` after a recorded standing approval.
  it('commits in-process when no daemon holds the lease (one-shot posture)', async () => {
    const where = fixture('free')
    const recordId = await seedRecord(where)
    const agent = host(where)

    const applied = await invokeFunction(agent.registry, 'knowledge.forget', {
      target: { grain: 'record', recordId },
    }, CALLER) as KnowledgeChangeOutput

    expect(applied.outcome).toBe('applied')
    if (applied.outcome !== 'applied') throw new Error('unreachable')
    expect(applied.forgetReceipt?.tombstonedRecords.map((row) => row.recordId)).toEqual([recordId])

    const rows = await invokeFunction(agent.registry, 'knowledge.bundles.list', {}, CALLER) as {
      status: string
    }[]
    expect(rows.map((row) => row.status)).toEqual(['deprecated'])
  })

  // RE-SPELLED 2026-10-01 (432-16): the delegator used to be handed a proposal id through
  // `applyDelegate`; it now binds the CLI host's shipped change delegate and hands the change op and
  // its identity over.
  it('delegates over the daemon socket to a live holder and never takes the lease', async () => {
    const where = fixture('held')
    const recordId = await seedRecord(where)

    const { acquireWriterLease, releaseLease, readWriterLease } =
      await import('@vostride/agent-qa-knowledge-local')

    // The holder: a daemon-shaped composition that OWNS the lease and therefore commits in
    // process. It injects no delegate, which is what makes delegation recursion impossible.
    const held = acquireWriterLease(where.knowledgeRoot)
    if (held.kind !== 'acquired') throw new Error('fixture could not take the lease')
    const holderHost = host(where, {
      resolveWriterAuthority: () => ({ leaseId: held.leaseId, epoch: held.epoch }),
    })
    await serveHolder(where, holderHost.registry)

    // The delegating process: a second composition over the same roots, with the CLI's own
    // delegate. It holds no lease, no epoch and no store handle — nothing it could steal with.
    const shipped = delegateKnowledgeChangeViaDaemon({
      agentQaRoot: where.agentQaRoot,
      resolveKnowledgeRoot: () => where.knowledgeRoot,
    })
    const delegated: unknown[] = []
    const caller = host(where, {
      knowledgeChangeDelegate: async (delegation) => {
        delegated.push(delegation)
        return await shipped(delegation)
      },
    })
    const operationId = '2f6c1a8e-4b3d-4c5e-9a7f-0d1e2c3b4a59'
    const leaseBefore = readWriterLease(where.knowledgeRoot)

    const applied = await invokeFunction(caller.registry, 'knowledge.forget', {
      target: { grain: 'record', recordId }, operationId,
    }, CALLER) as KnowledgeChangeOutput

    // The receipt came back — the leaseholder's, produced on the other side of a real socket.
    expect(delegated).toEqual([{
      request: { verb: 'forget', input: { target: { grain: 'record', recordId } } },
      operationId,
    }])
    expect(applied.outcome).toBe('applied')
    if (applied.outcome !== 'applied') throw new Error('unreachable')
    expect(applied.operationId).toBe(operationId)
    expect(applied.forgetReceipt?.tombstonedRecords.map((row) => row.recordId)).toEqual([recordId])

    // STRUCTURAL REFUSAL: the lease is byte-identical, so nothing about delegating took,
    // reclaimed, bumped or re-minted it — and the delegator's own acquisition is still refused.
    expect(readWriterLease(where.knowledgeRoot)).toEqual(leaseBefore)
    expect(acquireWriterLease(where.knowledgeRoot).kind).toBe('held')

    // …and the change really landed, on the holder's side.
    const rows = await invokeFunction(holderHost.registry, 'knowledge.bundles.list', {}, CALLER) as {
      status: string
    }[]
    expect(rows.map((row) => row.status)).toEqual(['deprecated'])

    // 432-16 task 2: the retry edge. The same identity delegated again lands once — the same
    // records answered, the same one deprecated record — and the lease is still the holder's.
    // 2026-10-02 (quick 261002-lse, 432-16 #3): and it answers the FIRST receipt byte for byte; it
    // used to re-mint `forgottenAt` and an empty scrub list on the holder's side.
    const retried = await invokeFunction(caller.registry, 'knowledge.forget', {
      target: { grain: 'record', recordId }, operationId,
    }, CALLER) as KnowledgeChangeOutput
    expect(retried.outcome).toBe('applied')
    if (retried.outcome !== 'applied') throw new Error('unreachable')
    expect(retried).toMatchObject({ verb: 'forget', operationId, recordIds: applied.recordIds })
    expect(retried.forgetReceipt?.tombstonedRecords).toEqual(applied.forgetReceipt?.tombstonedRecords)
    expect(applied.forgetReceipt?.projectionsScrubbed).toEqual(['fts', 'vec', 'graph'])
    expect(retried.forgetReceipt).toEqual(applied.forgetReceipt)
    expect(JSON.stringify(retried)).toBe(JSON.stringify(applied))
    expect(delegated).toHaveLength(2)
    expect((await invokeFunction(holderHost.registry, 'knowledge.bundles.list', {}, CALLER) as {
      status: string
    }[]).map((row) => row.status)).toEqual(['deprecated'])
    expect(readWriterLease(where.knowledgeRoot)).toEqual(leaseBefore)

    releaseLease({ knowledgeRoot: where.knowledgeRoot, leaseId: held.leaseId })
  })

  // RE-SPELLED 2026-10-01 (432-16): the unresponsive holder was an `applyDelegate` that never
  // answered a proposal id; it is now a change delegate that never answers.
  it('refuses at the bound rather than hanging on an unresponsive holder', async () => {
    const where = fixture('wedged')
    const recordId = await seedRecord(where)

    const { acquireWriterLease, releaseLease, ApplyDelegateTimeoutError } =
      await import('@vostride/agent-qa-knowledge-local')

    const held = acquireWriterLease(where.knowledgeRoot)
    if (held.kind !== 'acquired') throw new Error('fixture could not take the lease')

    const caller = host(where, { knowledgeChangeDelegate: () => new Promise(() => {}) })

    const started = Date.now()
    await expect(
      Promise.race([
        invokeFunction(caller.registry, 'knowledge.forget', {
          target: { grain: 'record', recordId },
        }, CALLER),
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error('BOUNDED-WAIT-NOT-REACHED')), 250),
        ),
      ]),
    ).rejects.toThrow(/BOUNDED-WAIT-NOT-REACHED/)
    // The change did NOT resolve and did NOT take the lease while waiting.
    // `ApplyDelegateTimeoutError` is the refusal it raises at the pinned bound, exported so a
    // surface can name it rather than string-match a message.
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(ApplyDelegateTimeoutError.name).toBe('ApplyDelegateTimeoutError')
    expect(acquireWriterLease(where.knowledgeRoot).kind).toBe('held')

    releaseLease({ knowledgeRoot: where.knowledgeRoot, leaseId: held.leaseId })
  })
})

// 2026-09-30, 432-12 (D-05): a DIRECT knowledge change takes the same lease routing, with no
// proposal id to hand over. The live holder receives the change op and the change's own identity
// over the same socket, applies with its authority, and nothing is filed or claimed anywhere.
describe('a direct knowledge change routes by lease state', () => {
  it('delegates the change op and its identity to a live holder over the daemon socket, filing nothing and never taking the lease', async () => {
    const where = fixture('direct-held')
    const recordId = await seedRecord(where)

    const { acquireWriterLease, releaseLease, readWriterLease } =
      await import('@vostride/agent-qa-knowledge-local')
    const { existsSync } = await import('node:fs')

    const held = acquireWriterLease(where.knowledgeRoot)
    if (held.kind !== 'acquired') throw new Error('fixture could not take the lease')
    const holderHost = host(where, {
      resolveWriterAuthority: () => ({ leaseId: held.leaseId, epoch: held.epoch }),
    })
    writeDaemonRegistration(where.agentQaRoot, {
      schemaVersion: DAEMON_REGISTRATION_SCHEMA_VERSION,
      instanceId: INSTANCE_ID,
      pid: process.pid,
      socketPath: where.socketPath,
      startedAtMs: Date.now(),
    })
    const server = await startInvokeServer({
      socketPath: where.socketPath,
      registry: holderHost.registry,
      identity: { schemaVersion: DAEMON_IDENTITY_SCHEMA_VERSION, instanceId: INSTANCE_ID, pid: process.pid },
    })
    servers.push(server)

    // The delegating process binds the CLI host's own shipped delegate, over the same roots.
    const shipped = delegateKnowledgeChangeViaDaemon({
      agentQaRoot: where.agentQaRoot,
      resolveKnowledgeRoot: () => where.knowledgeRoot,
    })
    const delegated: unknown[] = []
    const caller = host(where, {
      knowledgeChangeDelegate: async (delegation) => {
        delegated.push(delegation)
        return await shipped(delegation)
      },
    })
    const operationId = '9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
    const leaseBefore = readWriterLease(where.knowledgeRoot)

    const applied = await invokeFunction(caller.registry, 'knowledge.reject', {
      target: { grain: 'record', recordId }, reason: 'the button moved', operationId,
    }, CALLER) as KnowledgeChangeOutput

    expect(delegated).toEqual([{
      request: { verb: 'reject', input: { target: { grain: 'record', recordId }, reason: 'the button moved' } },
      operationId,
    }])
    expect(applied).toEqual({ outcome: 'applied', verb: 'reject', operationId, recordIds: [recordId] })

    // The lease is untouched and still refused to the delegator; nothing was filed or claimed.
    expect(readWriterLease(where.knowledgeRoot)).toEqual(leaseBefore)
    expect(acquireWriterLease(where.knowledgeRoot).kind).toBe('held')
    expect(existsSync(join(where.agentQaRoot, 'proposals'))).toBe(false)

    // The change landed on the holder's side, and a retry of the same identity lands nothing more.
    const rows = await invokeFunction(holderHost.registry, 'knowledge.bundles.list', {}, CALLER) as {
      status: string
    }[]
    expect(rows.map((row) => row.status)).toEqual(['deprecated'])
    const retried = await invokeFunction(caller.registry, 'knowledge.reject', {
      target: { grain: 'record', recordId }, reason: 'the button moved', operationId,
    }, CALLER) as KnowledgeChangeOutput
    expect(retried).toEqual(applied)

    releaseLease({ knowledgeRoot: where.knowledgeRoot, leaseId: held.leaseId })
  })
})

// 2026-10-02 (quick 261002-hyg, the 432-13 #1 knowledge-change note): a change that meets a fresh
// writer lease held by another agent-qa process that is NOT a registered daemon (a dashboard's
// post-run curation, another terminal's change) used to answer `DaemonNotRunningError` ("Start
// agent-qa daemon"). The holder is a process that is writing, not a missing daemon, so the CLI's
// delegate now refuses by name with the holder's pid and the mark's wording. A registered daemon
// nobody answers for keeps `DaemonNotRunningError`. Nothing is written in either case.
describe('a knowledge change under a holder that is not a live daemon', () => {
  async function snapshot(where: Fixture): Promise<string> {
    const { readdirSync, readFileSync, statSync } = await import('node:fs')
    const lines: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir).sort()) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else lines.push(`${path}\t${readFileSync(path).toString('base64')}`)
      }
    }
    walk(where.knowledgeRoot)
    return lines.join('\n')
  }

  it('C-HYG-KNOWLEDGE-HOLDER-BUSY: refuses by name with the holder pid, changes nothing, and a retry after release applies', async () => {
    const where = fixture('busy')
    const recordId = await seedRecord(where)
    const { acquireWriterLease, releaseLease, readWriterLease } =
      await import('@vostride/agent-qa-knowledge-local')
    const held = acquireWriterLease(where.knowledgeRoot)
    if (held.kind !== 'acquired') throw new Error('fixture could not take the lease')

    const caller = host(where, {
      knowledgeChangeDelegate: delegateKnowledgeChangeViaDaemon({
        agentQaRoot: where.agentQaRoot,
        resolveKnowledgeRoot: () => where.knowledgeRoot,
      }),
    })
    const operationId = '7d6c5b4a-3e2f-4a1b-9c8d-7e6f5a4b3c2d'
    const before = await snapshot(where)
    const leaseBefore = readWriterLease(where.knowledgeRoot)

    const refusal = await invokeFunction(caller.registry, 'knowledge.forget', {
      target: { grain: 'record', recordId }, operationId,
    }, CALLER).then(() => undefined, (error: unknown) => error as Error & { holderPid?: number })

    expect(refusal).toMatchObject({ name: 'KnowledgeWriterLeaseBusyError', holderPid: process.pid })
    // 2026-10-03 (261003-lgd, IN-11): the fixture holds the lease in this very process, so the
    // refusal must say so instead of naming it "another" process.
    expect(refusal?.message).toContain(`This agent-qa process (pid ${process.pid}) is already writing`)
    expect(refusal?.message).not.toContain('Another agent-qa process')
    expect(refusal?.message).toContain('nothing was changed')
    expect(refusal?.message).toContain('Retry the change when it finishes')
    expect(refusal?.message).not.toContain('agent-qa daemon')
    expect(await snapshot(where), 'nothing was written').toBe(before)
    expect(readWriterLease(where.knowledgeRoot), 'the holder keeps its lease').toEqual(leaseBefore)

    releaseLease({ knowledgeRoot: where.knowledgeRoot, leaseId: held.leaseId })
    const applied = await invokeFunction(caller.registry, 'knowledge.forget', {
      target: { grain: 'record', recordId }, operationId,
    }, CALLER) as KnowledgeChangeOutput
    expect(applied).toMatchObject({ outcome: 'applied', verb: 'forget', operationId, recordIds: [recordId] })
  })

  it('C-HYG-KNOWLEDGE-HOLDER-GONE: a holder that released before the delegate looked refuses with no pid', async () => {
    const where = fixture('gone')
    const delegate = delegateKnowledgeChangeViaDaemon({
      agentQaRoot: where.agentQaRoot,
      resolveKnowledgeRoot: () => where.knowledgeRoot,
    })
    const refusal = await delegate({
      request: { verb: 'forget', input: { target: { grain: 'record', recordId: 'r' } } },
      operationId: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    }).then(() => undefined, (error: unknown) => error as Error & { holderPid?: number })
    expect(refusal).toMatchObject({ name: 'KnowledgeWriterLeaseBusyError', holderPid: undefined })
    expect(refusal?.message).toContain('has just finished; nothing was changed. Retry the change.')
  })

  it('C-HYG-KNOWLEDGE-DAEMON-UNREACHABLE: a lease naming a registered daemon nobody answers for keeps DaemonNotRunningError', async () => {
    const where = fixture('unreachable')
    const recordId = await seedRecord(where)
    const { acquireWriterLease, releaseLease } = await import('@vostride/agent-qa-knowledge-local')
    const held = acquireWriterLease(where.knowledgeRoot)
    if (held.kind !== 'acquired') throw new Error('fixture could not take the lease')
    writeDaemonRegistration(where.agentQaRoot, {
      schemaVersion: DAEMON_REGISTRATION_SCHEMA_VERSION,
      instanceId: INSTANCE_ID,
      pid: process.pid,
      socketPath: join(where.root, 'gone.sock'),
      startedAtMs: Date.now(),
    })
    const caller = host(where, {
      knowledgeChangeDelegate: delegateKnowledgeChangeViaDaemon({
        agentQaRoot: where.agentQaRoot,
        resolveKnowledgeRoot: () => where.knowledgeRoot,
      }),
    })
    const before = await snapshot(where)

    await expect(invokeFunction(caller.registry, 'knowledge.forget', {
      target: { grain: 'record', recordId },
    }, CALLER)).rejects.toMatchObject({ name: 'DaemonNotRunningError' })
    expect(await snapshot(where)).toBe(before)

    releaseLease({ knowledgeRoot: where.knowledgeRoot, leaseId: held.leaseId })
  })
})
