// The mutating review verbs, end to end through the function layer.
//
// Two registries over ONE knowledge root, differing in exactly one field of the deps record: one
// supplies `knowledgeReview`, the other does not. That is the whole experiment, and it is what
// makes "a read-only host reports the mutating verbs as unbound BY NAME" a measured fact about a
// composition rather than a sentence in a doc comment — the same four ids, the same caller, the
// same store, two different honest answers.
//
// Nothing is stubbed on the write path: since 432-12 each change really takes the writer
// lease through the explicit writer and really reaches the Curator's `commit()` in the call, and
// the store is really re-read afterwards. No proposal is minted; the pre-432 apply is measured over
// a record already on disk.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  FunctionNotBoundError,
  UnknownFunctionError,
  createFunctionRegistry,
  invokeFunction,
} from '@vostride/agent-qa-agent'
import type { EntityDirectoryPort, FunctionRegistry } from '@vostride/agent-qa-agent'
import {
  acquireWriterLease,
  releaseLease,
  publishBundleForTest,
  type BundleStoreConfig,
} from '@vostride/agent-qa-knowledge-local'
import { MASKED_RESOLVED_CONFIG_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type {
  Anchor,
  EntityCard,
  EntityCardResolution,
  FunctionCaller,
  ForgetReceiptV1,
  KnowledgeChangeOutput,
  MaskedResolvedConfig,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createEntityDirectory,
  createKnowledgeReader,
  createKnowledgeReview,
  createRunsReader,
} from '../compose-local-agent.js'
import { filePre432KnowledgeProposal } from '../../__tests__/pre-432-knowledge-proposal.js'


/**
 * The ids the write half owns. Written out so an id that stopped registering is visible.
 * the three changes apply in the call. 2026-10-01: the pre-432
 * `knowledge.proposal.apply` is deleted with the inbox, so the write half is these three.
 */
const MUTATING_FUNCTION_IDS = [
  'knowledge.accept',
  'knowledge.forget',
  'knowledge.reject',
] as const

const MASKED_CONFIG: MaskedResolvedConfig = {
  schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
  configPath: '/fixture/agent-qa.config.yaml',
  entries: [],
}

/**
 * A refusal below can only ever be about BINDING. 2026-10-01: the retired
 * `grantedScopes` and `safeMode` caller fields are dropped (no scope exists to grant), and the
 * retired `resolveExecutionContext` registry option is dropped from both registries below; nothing
 * read them. `createKnowledgeReview`'s own `resolveExecutionContext` is the context a change is
 * recorded under, not the registry option, and stays.
 */
const CALLER: FunctionCaller = {
  surface: 'test',
  origin: 'agent',
}

describe('the mutating review verbs bind, refuse and commit by name', () => {
  let root: string
  let knowledgeRoot: string
  let agentQaRoot: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'review-verbs-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    agentQaRoot = join(root, '.agent-qa')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function storeConfig(): BundleStoreConfig {
    return {
      knowledgeRoot,
      productKey: 'Review Verbs Product',
    }
  }

  function publish(name = 'Checkout'): string {
    const anchor: Anchor = { t: 'el', role: 'Button', name }
    const outcome = publishBundleForTest(storeConfig(), {
      draft: {
        kind: 'fact',
        subtype: 'selector',
        anchors: [anchor],
        scope: { tier: 'product', key: 'review-verbs' },
        summary: `${name.toLowerCase()} button`,
        body: 'Selecting Checkout advances to the payment page.',
        distilledEvidenceRef: { id: 'review-verbs-evidence', sha: 'a'.repeat(64) },
        originStage: 'run-curation',
      },
      discriminant: {
        kind: 'fact',
        subtype: 'selector',
        elementRef: { role: 'Button', name },
      },
      originClass: 'agent-verified',
      createdAtOrdinal: 9,
      screenStates: [],
      initialEvents: [],
      relations: [],
      provenance: { mode: 'run-linked', runId: 'review-verbs', testId: 't', stepIndex: 0 },
      artifacts: [],
    })
    if (outcome.kind !== 'published') throw new Error(`fixture publish failed: ${outcome.kind}`)
    return outcome.id
  }

  /**
   * Store state read through the layer's OWN read verb rather than through a direct store call.
   *
   * Deliberate: the claim under test is what a SURFACE observes after a review verb runs, and a
   * direct import would be a second way of looking at the store that could agree with the verbs
   * while the catalogue disagreed.
   */
  async function statuses(host: FunctionRegistry): Promise<string[]> {
    const rows = await invokeFunction(host, 'knowledge.bundles.list', {}, CALLER) as {
      status: string
    }[]
    return rows.map((row) => row.status)
  }

  /**
   * The stub directory the binding experiment uses: it answers `none` for everything, so a
   * refusal below can never be an entity lookup succeeding by accident.
   */
  const STUB_ENTITIES: EntityDirectoryPort = {
    resolve: () => Promise.resolve({ kind: 'none' as const, reason: 'no-match' as const }),
    get: () => Promise.resolve(undefined),
  }

  function registry(withReview: boolean, entities: EntityDirectoryPort = STUB_ENTITIES): FunctionRegistry {
    return createFunctionRegistry({
      deps: {
        runs: createRunsReader(agentQaRoot),
        knowledge: createKnowledgeReader(() => knowledgeRoot),
        config: { getMasked: () => Promise.resolve(MASKED_CONFIG) },
        entities,
        // THE one field that differs between the two registries.
        ...(withReview
          ? {
              knowledgeReview: createKnowledgeReview({
                agentQaRoot,
                resolveKnowledgeRoot: () => knowledgeRoot,
              }),
            }
          : {}),
      },
    })
  }

  /**
   * A no-op kept so the three binding cases keep their call shape (re-spelled 2026-10-02, 432-42).
   *
   * It recorded a standing approval for the pre-432 ask-tier apply (391, D-02/D-04). The apply is
   * deleted and nothing reads an approval, so the binding is again the only
   * thing that can refuse these calls — the claim the three cases are about.
   */
  function approveApply(host: FunctionRegistry): void {
    // RE-SPELLED 2026-10-01: the ask-tier apply this approval was for is deleted, and since
    // 432-13 no gate reads a standing approval. Nothing is recorded; the call sites keep their shape.
    void host
  }

  // RE-SPELLED 2026-10-01: four became three with the pre-432 apply's deletion.
  it('lists all three as UNBOUND by name and refuses each by name without a review port', async () => {
    const recordId = publish()
    const readOnly = registry(false)
    approveApply(readOnly)

    const listed = readOnly.list(CALLER)
    const byId = new Map(listed.map((declaration) => [declaration.id, declaration]))
    for (const id of MUTATING_FUNCTION_IDS) {
      // LISTED, not omitted: a capability absent from a catalogue is indistinguishable from one
      // that never existed, and the two are different facts about a host.
      expect(byId.get(id)?.bindingStatus, `${id} must be listed unbound`).toBe('unbound')
      // no `knowledge-write` scope column; the write claim is the risk's.
      expect(Object.keys(byId.get(id) ?? {})).not.toContain('requiredScopes')
      expect(byId.get(id)?.risk.readOnly).toBe(false)
    }

    for (const [id, input] of [
      ['knowledge.accept', { target: { grain: 'record', recordId } }],
      ['knowledge.reject', { target: { grain: 'record', recordId }, reason: 'no' }],
      ['knowledge.forget', { target: { grain: 'record', recordId } }],
    ] as const) {
      // The inputs PARSE, so this refusal cannot be a contract refusal wearing a binding
      // refusal's clothes — `invokeFunction` validates before it consults the binding.
      await expect(invokeFunction(readOnly, id, input, CALLER), id)
        .rejects.toBeInstanceOf(FunctionNotBoundError)
    }

    // …and nothing was written by any of the four refusals.
    expect(await statuses(readOnly)).toEqual(['candidate'])
  })

  it('the SAME four ids are bound and reach the store when a review port is supplied', async () => {
    const recordId = publish()
    const host = registry(true)
    approveApply(host)

    for (const id of MUTATING_FUNCTION_IDS) {
      expect(
        host.list(CALLER).find((declaration) => declaration.id === id)?.bindingStatus,
        `${id} must be bound where a review port exists`,
      ).toBe('bound')
    }

    // the forget applies in the call. Nothing is proposed first.
    const operationId = '3d2c1b0a-9f8e-4d7c-8b6a-5f4e3d2c1b0a'
    const applied = await invokeFunction(
      host,
      'knowledge.forget',
      { target: { grain: 'record', recordId }, operationId },
      CALLER,
    ) as KnowledgeChangeOutput

    if (applied.outcome !== 'applied') throw new Error(`expected an applied forget, got ${applied.outcome}`)
    const receipt = applied.forgetReceipt as ForgetReceiptV1
    expect(receipt.tombstonedRecords.map((row) => row.recordId)).toEqual([recordId])
    // Tombstoned, never destroyed — the record is still enumerable, saying what happened to it.
    expect(await statuses(host)).toEqual(['deprecated'])

    // And the retry of the same identity is the same change, carrying the FIRST receipt's records.
    const again = await invokeFunction(
      host,
      'knowledge.forget',
      { target: { grain: 'record', recordId }, operationId },
      CALLER,
    ) as KnowledgeChangeOutput
    expect(again).toMatchObject({ outcome: 'applied', operationId, recordIds: applied.recordIds })
    expect(await statuses(host)).toEqual(['deprecated'])

    // RE-SPELLED 2026-10-01: a pre-432 forget on disk is no longer applicable.
    // The apply op is an unknown function, the record it named stays as it was, and the file is
    // left exactly as it was found.
    const pending = publish('Payment')
    const proposalId = await filePre432KnowledgeProposal({
      agentQaRoot, knowledgeRoot, verb: 'forget', target: { grain: 'record', recordId: pending },
    })
    const planted = join(agentQaRoot, 'proposals', `${proposalId}.json`)
    const bytes = readFileSync(planted)
    await expect(invokeFunction(host, 'knowledge.proposal.apply', { proposalId }, CALLER))
      .rejects.toBeInstanceOf(UnknownFunctionError)
    expect(await statuses(host)).toEqual(['deprecated', 'candidate'])
    expect(readFileSync(planted)).toEqual(bytes)
  })

  /**
   * CR-04's reproduction, run forwards as a regression case.
   *
   * The whole point is the RESOLVER path: the second render passes NO forget receipt anywhere,
   * so `produceEntityCard`'s receipt override never fires and the card status IS whatever the
   * sighting source derived from the store. Before plan 387-11 that derivation was a private
   * three-member table which omitted `deprecated`, so this sequence handed one caller a receipt
   * saying `tombstoned` and, moments later, a card at the same permanent address saying
   * `active`. Both halves are asserted in one test because the defect IS the disagreement — an
   * assertion on the card alone could be satisfied by a receipt that had also gone wrong.
   */
  it('renders an HONEST card on the resolver path after a forget — receipt and card agree', async () => {
    const recordId = publish()
    const host = registry(
      true,
      createEntityDirectory({ agentQaRoot, resolveKnowledgeRoot: () => knowledgeRoot }),
    )
    approveApply(host)

    // BEFORE. This is also the mint: resolving the bundle id is what gives the entity its
    // permanent MEM address, and every later render below goes through that address.
    const before = await invokeFunction(
      host,
      'entities.resolve',
      { ref: recordId },
      CALLER,
    ) as EntityCardResolution
    if (before.kind !== 'resolved') throw new Error(`expected a resolved card, got ${before.kind}`)
    expect(before.card.kind).toBe('MEM')
    expect(before.card.status).toBe('active')
    const address = before.card.id

    // the forget applies in the call.
    const applied = await invokeFunction(
      host,
      'knowledge.forget',
      { target: { grain: 'record', recordId } },
      CALLER,
    ) as KnowledgeChangeOutput
    if (applied.outcome !== 'applied') throw new Error(`expected an applied forget, got ${applied.outcome}`)
    const receipt = applied.forgetReceipt as ForgetReceiptV1

    // Half one: what the operation TOLD this caller.
    expect(receipt.resultingBundleStatus).toBe('tombstoned')

    // Half two: what the same caller sees at the permanent address afterwards, with no receipt
    // in hand. OBSERVED RED against the pre-387-11 `knowledge-local` build — the
    // real prior production code, reached because agent-local consumes that package through its
    // dist and the dist had not yet been rebuilt:
    //   AssertionError: expected 'active' to be 'tombstoned' // Object.is equality
    //   - Expected: "tombstoned"   + Received: "active"
    // raised on the FIRST assertion below and aborting the test there. The receipt assertion one
    // line above had already passed, so what the run showed is precisely the disagreement: the
    // same caller, the same operation, `tombstoned` on the receipt and `active` on the card.
    const got = await invokeFunction(host, 'entities.get', { ref: address }, CALLER) as EntityCard
    expect(got.status).toBe('tombstoned')
    expect(got.status).not.toBe('active')
    expect(got.status).toBe(receipt.resultingBundleStatus)

    // …and the resolve path agrees with the get path. Two entries, one honest answer.
    const after = await invokeFunction(
      host,
      'entities.resolve',
      { ref: recordId },
      CALLER,
    ) as EntityCardResolution
    if (after.kind !== 'resolved') throw new Error(`expected a resolved card, got ${after.kind}`)
    expect(after.card.id).toBe(address)
    expect(after.card.status).toBe('tombstoned')
    expect(after.card.status).not.toBe('active')
  })

  // ---- 432-12: the direct change, bound over the explicit writer ---------------

  const EXECUTION_CONTEXTS = ['local-interactive', 'local-headless', 'ci', 'cloud'] as const

  /** The same composition, with the context and delegation a host would hand it. */
  function directRegistry(
    context: (typeof EXECUTION_CONTEXTS)[number],
    extra: Record<string, unknown> = {},
  ): FunctionRegistry {
    return createFunctionRegistry({
      deps: {
        runs: createRunsReader(agentQaRoot),
        knowledge: createKnowledgeReader(() => knowledgeRoot),
        config: { getMasked: () => Promise.resolve(MASKED_CONFIG) },
        entities: STUB_ENTITIES,
        knowledgeReview: createKnowledgeReview({
          agentQaRoot,
          resolveKnowledgeRoot: () => knowledgeRoot,
          resolveExecutionContext: () => context,
          ...extra,
        } as Parameters<typeof createKnowledgeReview>[0]),
      },
    })
  }

  async function settle(call: Promise<unknown>): Promise<{ value?: unknown; error?: unknown }> {
    try {
      return { value: await call }
    } catch (error) {
      return { error }
    }
  }

  it('forget applies through the direct writer in all four contexts, filing nothing', async () => {
    for (const context of EXECUTION_CONTEXTS) {
      rmSync(root, { recursive: true, force: true })
      const recordId = publish()
      const host = directRegistry(context)

      const outcome = await settle(invokeFunction(
        host, 'knowledge.forget', { target: { grain: 'record', recordId } }, CALLER,
      ))

      expect(outcome.error, `forget in ${context}`).toBeUndefined()
      expect(outcome.value, context).toMatchObject({
        outcome: 'applied', verb: 'forget', recordIds: [recordId],
        forgetReceipt: { resultingBundleStatus: 'tombstoned' },
      })
      expect(await statuses(host), context).toEqual(['deprecated'])
      // No envelope, claim or inbox: the change is the call.
      expect(existsSync(join(agentQaRoot, 'proposals')), context).toBe(false)
    }
  })

  it('reject deprecates in the call and accept answers the records it changed', async () => {
    const rejected = publish()
    const host = directRegistry('ci')
    const reject = await settle(invokeFunction(host, 'knowledge.reject', {
      target: { grain: 'record', recordId: rejected }, reason: 'the button moved',
    }, CALLER))
    expect(reject.error).toBeUndefined()
    expect(reject.value).toMatchObject({ outcome: 'applied', verb: 'reject', recordIds: [rejected] })
    expect(await statuses(host)).toEqual(['deprecated'])

    const missing = await settle(invokeFunction(host, 'knowledge.accept', {
      target: { grain: 'record', recordId: 'rec-not-in-this-store' },
    }, CALLER))
    expect(missing.value).toMatchObject({
      outcome: 'target-not-found',
      target: { grain: 'record', recordId: 'rec-not-in-this-store' },
    })
    expect(existsSync(join(agentQaRoot, 'proposals'))).toBe(false)
  })

  it('a retried identity lands once and answers the same records', async () => {
    const recordId = publish()
    const host = directRegistry('local-headless')
    const operationId = '0b6e3c1d-9a24-4f5e-8c71-2d4f6a8b0c13'
    const input = { target: { grain: 'record', recordId }, operationId }

    const first = await settle(invokeFunction(host, 'knowledge.forget', input, CALLER))
    const retry = await settle(invokeFunction(host, 'knowledge.forget', input, CALLER))

    expect(first.error).toBeUndefined()
    expect(retry.error).toBeUndefined()
    expect(first.value).toMatchObject({ outcome: 'applied', operationId, recordIds: [recordId] })
    expect((retry.value as { recordIds?: unknown }).recordIds)
      .toEqual((first.value as { recordIds?: unknown }).recordIds)
    // 2026-10-02 (quick 261002-lse, 432-16 #3): the retry answers the first forget receipt byte for
    // byte, scrub list and `forgottenAt` included, as reject's retry already did.
    expect((first.value as { forgetReceipt?: ForgetReceiptV1 }).forgetReceipt?.projectionsScrubbed)
      .toEqual(['fts', 'vec', 'graph'])
    expect(JSON.stringify(retry.value)).toBe(JSON.stringify(first.value))
    expect(await statuses(host)).toEqual(['deprecated'])
  })

  it('a held lease hands the current writer the direct request, with no claimed file', async () => {
    const recordId = publish()
    const lease = acquireWriterLease(knowledgeRoot)
    if (lease.kind !== 'acquired') throw new Error(`fixture lease not acquired: ${lease.kind}`)
    try {
      const delegated: unknown[] = []
      const operationId = 'c6a1e2f3-4b5d-4e6f-8a7b-9c0d1e2f3a4b'
      const host = directRegistry('local-interactive', {
        knowledgeChangeDelegate: (delegation: unknown) => {
          delegated.push(delegation)
          return Promise.resolve({
            outcome: 'applied', verb: 'reject', changeId: `prop_${operationId}`, recordIds: [recordId],
          })
        },
      })

      const outcome = await settle(invokeFunction(host, 'knowledge.reject', {
        target: { grain: 'record', recordId }, reason: 'stale', operationId,
      }, CALLER))

      expect(outcome.error).toBeUndefined()
      expect(delegated).toEqual([{
        request: { verb: 'reject', input: { target: { grain: 'record', recordId }, reason: 'stale' } },
        operationId,
      }])
      expect(outcome.value).toEqual({
        outcome: 'applied', verb: 'reject', operationId, recordIds: [recordId],
      })
      // The holder commits, not this host: nothing moved here and nothing was filed or claimed.
      expect(await statuses(host)).toEqual(['candidate'])
      expect(existsSync(join(agentQaRoot, 'proposals'))).toBe(false)

      // With no delegate, a held lease refuses by name and is never stolen.
      const undelegated = await settle(invokeFunction(directRegistry('local-interactive'),
        'knowledge.reject', { target: { grain: 'record', recordId }, reason: 'stale' }, CALLER))
      expect((undelegated.error as Error | undefined)?.name).toBe('ApplyDelegateUnavailableError')
      expect(await statuses(host)).toEqual(['candidate'])
    } finally {
      releaseLease({ knowledgeRoot, leaseId: lease.leaseId })
    }
  })

  it('concurrent calls with one identity land once, and distinct changes all land', async () => {
    const shared = publish('Checkout')
    const other = publish('Payment')
    const host = directRegistry('local-headless')
    const operationId = '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a'

    // Two callers racing the SAME change: the lease serializes them and the identity makes the
    // second a replay. A distinct change beside them lands on its own.
    const [first, second, distinct] = await Promise.all([
      settle(invokeFunction(host, 'knowledge.forget', {
        target: { grain: 'record', recordId: shared }, operationId,
      }, CALLER)),
      settle(invokeFunction(host, 'knowledge.forget', {
        target: { grain: 'record', recordId: shared }, operationId,
      }, CALLER)),
      settle(invokeFunction(host, 'knowledge.reject', {
        target: { grain: 'record', recordId: other }, reason: 'the button moved',
      }, CALLER)),
    ])

    for (const outcome of [first, second, distinct]) expect(outcome.error).toBeUndefined()
    expect(first.value).toMatchObject({ outcome: 'applied', operationId, recordIds: [shared] })
    expect((second.value as { recordIds?: unknown }).recordIds)
      .toEqual((first.value as { recordIds?: unknown }).recordIds)
    expect(distinct.value).toMatchObject({ outcome: 'applied', verb: 'reject', recordIds: [other] })
    expect(await statuses(host)).toEqual(['deprecated', 'deprecated'])
    expect(existsSync(join(agentQaRoot, 'proposals'))).toBe(false)
  })

  it('an accept over a forgotten record refuses by type, and nothing moves', async () => {
    const recordId = publish()
    const host = directRegistry('local-interactive')
    const forgotten = await settle(invokeFunction(host, 'knowledge.forget', {
      target: { grain: 'record', recordId },
    }, CALLER))
    expect(forgotten.error).toBeUndefined()

    const accepted = await settle(invokeFunction(host, 'knowledge.accept', {
      target: { grain: 'record', recordId },
    }, CALLER))
    expect((accepted.error as Error | undefined)?.name).toBe('UserDeltaCitationIntegrityError')
    expect(await statuses(host)).toEqual(['deprecated'])
  })

  it('a caller holding only the local default grant changes knowledge with no standing approval', async () => {
    // No approval reader, no ledger entry and no credential: the direct change runs in every context
    // because nothing gates it. Re-spelled 2026-10-02: the title keeps the
    // pre-432 vocabulary as the record of what this cell replaced; the caller holds nothing.
    // the caller no longer carries the retired `grantedScopes` and
    // `safeMode`; no gate or grant is left, so it holds nothing at all and the change still applies.
    const recordId = publish()
    const tokenless: FunctionCaller = { surface: 'mcp', origin: 'agent' }
    const outcome = await settle(invokeFunction(directRegistry('ci'), 'knowledge.forget', {
      target: { grain: 'record', recordId },
    }, tokenless))
    expect(outcome.error).toBeUndefined()
    expect(outcome.value).toMatchObject({ outcome: 'applied', verb: 'forget', recordIds: [recordId] })
    expect(existsSync(join(knowledgeRoot, 'grants.jsonl'))).toBe(false)
  })

  it('answers a typed not-found through the function layer, never a throw', async () => {
    publish()
    const host = registry(true)

    const outcome = await invokeFunction(
      host,
      'knowledge.accept',
      { target: { grain: 'record', recordId: 'rec-not-in-this-store' } },
      CALLER,
    ) as KnowledgeChangeOutput

    // A result, not a rejection — and it survives the op's declared OUTPUT contract, which is
    // what makes "typed" mean something rather than "shaped like this today".
    expect(outcome).toEqual({
      outcome: 'target-not-found',
      verb: 'accept',
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      target: { grain: 'record', recordId: 'rec-not-in-this-store' },
    })
    expect(existsSync(join(agentQaRoot, 'proposals'))).toBe(false)
  })

  // the reader port's fifth member, bound over the `/reader` entry like the four
  // above it. The claim is not that the attribution join works — `canary-attribution.test.ts`
  // owns that — but that the COMPOSITION forwards what it was given: the run id, the tuples, and
  // a knowledge root resolved per call rather than captured once.
  it('binds canaryAttributions over the reader entry, forwarding the run and the tuples', async () => {
    const recordId = publish()
    let resolved = 0
    const port = createKnowledgeReader(() => {
      resolved += 1
      return knowledgeRoot
    })

    expect(port.canaryAttributions).toBeTypeOf('function')

    const tuples = [
      { candidateId: recordId, testId: 'checkout', testIndex: 0, stepIndex: 1 },
      { candidateId: recordId, testId: 'checkout', testIndex: 0, stepIndex: 2 },
    ]
    const answer = await port.canaryAttributions!({ runId: 'run-A', tuples })
    const rows = answer.rows

    // The binding forwards the walk's own partiality count verbatim (407-19, REVIEW WR-03). This
    // store is whole, so the honest answer is a count of zero — never an absent member the op
    // would have to treat as "probably fine".
    expect(answer.skippedBundles).toBe(0)

    // One row per tuple, in the order asked, each addressed back to the line it answers.
    expect(rows.map((row) => [row.candidateId, row.testIndex, row.stepIndex])).toEqual([
      [recordId, 0, 1],
      [recordId, 0, 2],
    ])
    for (const row of rows) {
      expect(row.observationId).toMatch(/^canary-outcome:[0-9a-f]{64}$/)
      // Nothing is committed against these ids, so the honest answer carries no outcome AT ALL —
      // an absent key, never a word a surface could print as a verdict.
      expect(Object.hasOwn(row, 'outcome')).toBe(false)
    }

    // The run id is really forwarded: the same tuples under a different run are different
    // observations, which is the whole reason the id is run-scoped.
    const other = (await port.canaryAttributions!({ runId: 'run-B', tuples })).rows
    expect(other.map((row) => row.observationId))
      .not.toEqual(rows.map((row) => row.observationId))

    // And the root is resolved PER CALL, like its four siblings.
    expect(resolved).toBe(2)
  })
})
