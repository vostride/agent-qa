// The list verbs are live D-01 sighting sites (Phase 387 plan 06).
//
// D-01 names four places an entity gets its permanent address the first time something
// surfaces it — a resolver hit, a card render, verdict authoring, and a LIST VERB. 387-01 wired
// the first; this file proves the fourth. Nothing is stubbed: a real bundle is published to a
// temp knowledge root, the real registry dispatches, and the addressing ledger is a real sqlite
// file on disk.
//
// THE VACUITY TRAP THIS FILE IS BUILT AROUND. The obvious way to check that an address was
// minted is to ask `entities.resolve` for it. That check cannot fail: `resolve` sights, and
// sighting mints, so it would create the very row it went looking for and would pass identically
// against a composition whose list verbs sighted nothing at all. Every mint assertion below
// therefore opens the ledger DIRECTLY and reads it, and the ledger is opened only after the list
// verb has run — so the row it finds can only have come from the verb.
//
// The counterfactual is asserted too, and it is what makes the positive case mean something: a
// verb that surfaces NO entity mints nothing, and the ledger file does not even come into
// existence. Without that half, "the ledger has a row" would be consistent with a composition
// that minted on every call regardless of what it saw.

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { invokeFunction } from '@vostride/agent-qa-agent'
import {
  ADDRESSING_LEDGER_DB_FILE,
  openAddressingLedger,
  publishBundleForTest,
  purgeRecord,
  type BundleStoreConfig,
  type EntityAddress,
  type PublishBundleInput,
} from '@vostride/agent-qa-knowledge-local'
import {
  asRecordId,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type {
  BundleDiscriminant,
  BundleDraft,
  FunctionCaller,
  KnowledgeRecordShowResult,
  KnowledgeRecordsDiffOutput,
  KnowledgeRecordsInspectOutput,
  MaskedResolvedConfig,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { composeLocalAgent } from '../compose-local-agent.js'
import type { LocalAgentHost } from '../compose-local-agent.js'

/**
 * The composition's REQUIRED quarantine identity mint (390-12 / D-01). Passthrough here: this
 * fixture already speaks canonical workspace-relative bytes, and the recipe itself stays pinned
 * in core's `workspace-paths.test.ts` — what these hosts exercise is everything BUT quarantine.
 */
const MINT_IDENTITY = (filePath: string): string => filePath

const PRODUCT = 'shop'

const CALLER: FunctionCaller = {
  surface: 'cli',
  origin: 'agent',
}

const MASKED_CONFIG: MaskedResolvedConfig = {
  schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
  configPath: '/fixture/agent-qa.config.yaml',
  entries: [],
}

function bundleInput(name: string, createdAtOrdinal: number): PublishBundleInput {
  const draft: BundleDraft = {
    kind: 'fact',
    subtype: 'selector',
    anchors: [{ t: 'el', role: 'button', name }],
    scope: { tier: 'product', key: PRODUCT },
    summary: `${name} summary`,
    body: `${name} body`,
    distilledEvidenceRef: { id: `${name}-evidence`, sha: 'a'.repeat(64) },
    originStage: 'run-curation',
  }
  const discriminant: BundleDiscriminant = {
    kind: 'fact',
    subtype: 'selector',
    elementRef: { role: 'button', name },
  }
  return {
    draft,
    discriminant,
    originClass: 'agent-verified',
    createdAtOrdinal,
    screenStates: [],
    initialEvents: [],
    relations: [],
    provenance: {
      mode: 'run-linked',
      runId: `list-sighting-${name}`,
      testId: 'list-sighting',
      stepIndex: 0,
      sourceBuildOrdinal: createdAtOrdinal,
    },
    artifacts: [],
  }
}

describe('a list verb sights every entity it surfaces', () => {
  let root: string
  let agentQaRoot: string
  let knowledgeRoot: string
  let host: LocalAgentHost

  function compose(): LocalAgentHost {
    return composeLocalAgent({
      mask: (text) => text,
      mintQuarantineIdentityPath: MINT_IDENTITY,
      agentQaRoot,
      config: { getMasked: () => Promise.resolve(MASKED_CONFIG) },
      knowledgeRoot: () => knowledgeRoot,
      model: () => {
        throw new Error('the list-sighting fixture never authors with a model')
      },
    })
  }

  function seedBundle(name: string, createdAtOrdinal: number): string {
    const config: BundleStoreConfig = {
      knowledgeRoot,
      productKey: PRODUCT,
    }
    const outcome = publishBundleForTest(config, bundleInput(name, createdAtOrdinal))
    expect(outcome.kind).toBe('published')
    if (outcome.kind !== 'published') throw new Error('fixture bundle did not publish')
    return outcome.id
  }

  /**
   * Read the ledger DIRECTLY, never through `entities.resolve`.
   *
   * A read-only question, and it stays read-only by construction: `lookup` is the ledger's
   * non-minting verb. Opening the ledger does create the file, so every case that asserts a
   * mint did NOT happen checks for the file's absence BEFORE calling this at all.
   */
  function ledgerLookup(machineId: string): EntityAddress | undefined {
    const ledger = openAddressingLedger({
      path: join(agentQaRoot, ADDRESSING_LEDGER_DB_FILE),
    })
    try {
      return ledger.lookup('MEM', machineId)
    } finally {
      ledger.close()
    }
  }

  function ledgerRowCount(): number {
    const ledger = openAddressingLedger({
      path: join(agentQaRoot, ADDRESSING_LEDGER_DB_FILE),
    })
    try {
      return ledger.listAddresses().length
    } finally {
      ledger.close()
    }
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-qa-list-sighting-'))
    agentQaRoot = join(root, '.agent-qa')
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    mkdirSync(agentQaRoot, { recursive: true })
    host = compose()
  })

  afterEach(async () => {
    await host.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('mints (MEM, bundleId) when knowledge.bundles.list surfaces a never-seen bundle',
    async () => {
      const bundleId = seedBundle('Checkout', 5)
      // The ledger is durable and D-01 says nothing touches it until an entity is SIGHTED.
      // Composing the host and publishing a bundle are both such nothings.
      expect(existsSync(join(agentQaRoot, ADDRESSING_LEDGER_DB_FILE))).toBe(false)

      await invokeFunction(host.registry, 'knowledge.bundles.list', {}, CALLER)

      const address = ledgerLookup(bundleId)
      expect(address?.kind).toBe('MEM')
      expect(address?.shortId).toBe('MEM-001')
      expect(address?.machineId).toBe(bundleId)
    })

  it('does not re-mint on a second list: same ordinal, one row', async () => {
    const bundleId = seedBundle('Checkout', 5)

    await invokeFunction(host.registry, 'knowledge.bundles.list', {}, CALLER)
    const first = ledgerLookup(bundleId)
    await invokeFunction(host.registry, 'knowledge.bundles.list', {}, CALLER)
    const second = ledgerLookup(bundleId)

    expect(second).toEqual(first)
    expect(second?.shortId).toBe('MEM-001')
    // The row count is the half a `lookup` comparison cannot see: a second mint under a second
    // ordinal would leave `lookup` answering with the first row while the ledger held two.
    expect(ledgerRowCount()).toBe(1)
  })

  it('mints every bundle a listing surfaces, in first-mention order', async () => {
    // Published out of alphabetical order so "first-mention order" is distinguishable from
    // "publication order" — the listing is sorted by product then bundle id, so the ordinals
    // must follow the LISTING, which is what D-01's "first mention" means for a batch.
    seedBundle('Zulu', 5)
    seedBundle('Alpha', 6)

    await invokeFunction(host.registry, 'knowledge.bundles.list', {}, CALLER)

    const ledger = openAddressingLedger({
      path: join(agentQaRoot, ADDRESSING_LEDGER_DB_FILE),
    })
    try {
      const addresses = ledger.listAddresses()
      expect(addresses).toHaveLength(2)
      expect(addresses.map((address) => address.shortId).sort())
        .toEqual(['MEM-001', 'MEM-002'])
    } finally {
      ledger.close()
    }
  })

  it('mints from knowledge.records.inspect too', async () => {
    const bundleId = seedBundle('Checkout', 5)
    expect(existsSync(join(agentQaRoot, ADDRESSING_LEDGER_DB_FILE))).toBe(false)

    const result = await invokeFunction(
      host.registry,
      'knowledge.records.inspect',
      { filter: {} },
      CALLER,
    ) as KnowledgeRecordsInspectOutput

    // The verb really surfaced the record — otherwise a mint assertion would be checking that
    // nothing was minted for something that was never shown.
    expect(result.records.map((record) => record.recordId)).toEqual([bundleId])
    expect(ledgerLookup(bundleId)?.shortId).toBe('MEM-001')
  })

  it('mints from knowledge.record.show too', async () => {
    const bundleId = seedBundle('Checkout', 5)
    expect(existsSync(join(agentQaRoot, ADDRESSING_LEDGER_DB_FILE))).toBe(false)

    const result = await invokeFunction(
      host.registry,
      'knowledge.record.show',
      { recordId: bundleId },
      CALLER,
    ) as KnowledgeRecordShowResult

    expect(result.kind).toBe('found')
    expect(ledgerLookup(bundleId)?.shortId).toBe('MEM-001')
  })

  it('mints NOTHING when a verb surfaces no entity — the ledger never comes into existence',
    async () => {
      // No bundle is seeded at all. The counterfactual matters: without it, every assertion
      // above is consistent with a composition that minted unconditionally on each call.
      const rows = await invokeFunction(host.registry, 'knowledge.bundles.list', {}, CALLER)
      expect(rows).toEqual([])

      const miss = await invokeFunction(
        host.registry,
        'knowledge.record.show',
        { recordId: 'rec-nobody-committed' },
        CALLER,
      ) as KnowledgeRecordShowResult
      expect(miss.kind).toBe('not-found')

      expect(existsSync(join(agentQaRoot, ADDRESSING_LEDGER_DB_FILE))).toBe(false)
    })

  it('never mints an address for a record id no source recognises', async () => {
    // THE CORPUS CASE THIS TEST EXISTS FOR. A diff names records by id including ones whose
    // bundle is GONE — a purge change — and that is the only input under which "the id was
    // surfaced" and "a source recognises it" come apart. An earlier version of this case
    // seeded one live bundle and asserted a made-up id was absent; a hook that minted every id
    // it was handed passed it, because nothing in the input domain violated the claim. The
    // purged record is what makes the assertion capable of failing.
    //
    // Minting here would put a permanent address on something no store can describe, and an
    // address that resolves to nothing is exactly the dead link D-04 forbids.
    const liveId = seedBundle('Checkout', 5)
    const doomedId = seedBundle('Doomed', 6)

    const purged = purgeRecord({
      knowledgeRoot,
      recordId: asRecordId(doomedId),
      initiator: 'list-sighting-fixture',
      purgedAtOrdinal: 21,
    })
    expect(purged.kind).toBe('purged')

    const changes = await invokeFunction(
      host.registry,
      'knowledge.records.diff',
      { sinceOrdinal: 0 },
      CALLER,
    ) as KnowledgeRecordsDiffOutput

    // The verb really surfaced the purged id — without this the mint assertion below would be
    // checking that nothing was minted for something that was never shown.
    expect(changes.changes.map((row) => row.recordId)).toContain(doomedId)

    expect(ledgerLookup(doomedId)).toBeUndefined()
    // The live record IS sighted by the same call, so the hook demonstrably ran.
    expect(ledgerLookup(liveId)?.shortId).toBe('MEM-001')
    expect(ledgerRowCount()).toBe(1)
  })

  it('the sighting is a side effect on the ledger and never on the answer', async () => {
    const bundleId = seedBundle('Checkout', 5)

    const first = await invokeFunction(host.registry, 'knowledge.bundles.list', {}, CALLER)
    const second = await invokeFunction(host.registry, 'knowledge.bundles.list', {}, CALLER)

    // The first call minted and the second did not. If sighting leaked into the projection,
    // the two answers would differ — which is the wiring-parity claim stated where it can
    // actually be violated.
    expect(second).toEqual(first)
    expect(ledgerLookup(bundleId)?.shortId).toBe('MEM-001')
  })
})
