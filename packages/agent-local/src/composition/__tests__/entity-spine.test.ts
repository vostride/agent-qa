// One unstubbed path through every layer: a published bundle, a real sqlite ledger, the registry.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { invokeFunction } from '@vostride/agent-qa-agent'
import {
  ADDRESSING_LEDGER_DB_FILE,
  publishBundleForTest,
  type BundleStoreConfig,
  type PublishBundleInput,
} from '@vostride/agent-qa-knowledge-local'
import { EntityCardSchema } from '@vostride/agent-qa-schema'
import type {
  BundleDiscriminant,
  BundleDraft,
  EntityCard,
  EntityCardResolution,
  FunctionCaller,
  MaskedResolvedConfig,
} from '@vostride/agent-qa-schema'
import { MASKED_RESOLVED_CONFIG_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { composeLocalAgent, sweepEntityIndexProjection } from '../compose-local-agent.js'
import type { LocalAgentHost } from '../compose-local-agent.js'

// Passthrough: this fixture already speaks canonical workspace-relative bytes.
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
      runId: `entity-spine-${name}`,
      testId: 'entity-spine',
      stepIndex: 0,
      sourceBuildOrdinal: createdAtOrdinal,
    },
    artifacts: [],
  }
}

describe('the entity spine through composeLocalAgent', () => {
  let root: string
  let agentQaRoot: string
  let knowledgeRoot: string
  let host: LocalAgentHost
  let bundleId: string

  function compose(): LocalAgentHost {
    return composeLocalAgent({
      mask: (text) => text,
      mintQuarantineIdentityPath: MINT_IDENTITY,
      agentQaRoot,
      config: { getMasked: () => Promise.resolve(MASKED_CONFIG) },
      knowledgeRoot: () => knowledgeRoot,
      model: () => {
        throw new Error('the entity spine never authors with a model')
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
    if (outcome.kind !== 'published') throw new Error('spine fixture bundle did not publish')
    return outcome.id
  }

  async function resolve(ref: string): Promise<EntityCardResolution> {
    return await invokeFunction(
      host.registry,
      'entities.resolve',
      { ref },
      CALLER,
    ) as EntityCardResolution
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-qa-entity-spine-'))
    agentQaRoot = join(root, '.agent-qa')
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    mkdirSync(agentQaRoot, { recursive: true })
    host = compose()
    bundleId = seedBundle('Checkout', 5)
  })

  afterEach(async () => {
    await host.close()
    rmSync(root, { recursive: true, force: true })
  })

  // ---- test 1: the sighting mints, and the card comes back rendered ----------------------

  it('resolves a committed bundle ref to a MEM card with a minted short-ID', async () => {
    // Nothing touches the ledger until an entity is sighted; composing and listing leave no file.
    expect(existsSync(join(agentQaRoot, ADDRESSING_LEDGER_DB_FILE))).toBe(false)

    const outcome = await resolve(bundleId)

    expect(outcome).toMatchObject({
      kind: 'resolved',
      score: 1,
      card: {
        kind: 'MEM',
        id: 'MEM-001',
        uri: 'agentqa://memory/MEM-001',
        status: 'active',
      },
    })
    expect(existsSync(join(agentQaRoot, ADDRESSING_LEDGER_DB_FILE))).toBe(true)

    // Rendered THROUGH the schema boundary, not assembled ad hoc: a card that failed its own
    // contract could still satisfy the shape assertion above.
    if (outcome.kind !== 'resolved') throw new Error('expected the resolved arm')
    expect(EntityCardSchema.safeParse(outcome.card).success).toBe(true)
    expect(outcome.card.title).toContain('Checkout')
    // No dashboard base URL is configured, so the field is absent rather than a dead link.
    expect(Object.hasOwn(outcome.card, 'url')).toBe(false)
  })

  // ---- test 2: minting is idempotent across calls AND across compositions ----------------

  it('re-sights the same bundle to the SAME short-ID, idempotently', async () => {
    const first = await resolve(bundleId)
    const second = await resolve(bundleId)

    expect(first).toEqual(second)

    // A second composition over the same runtime root reads the ledger the first one wrote.
    // An in-memory counter passes both assertions above and fails this one.
    const reopened = compose()
    try {
      const third = await invokeFunction(
        reopened.registry,
        'entities.resolve',
        { ref: bundleId },
        CALLER,
      ) as EntityCardResolution
      expect(third).toEqual(first)
    } finally {
      await reopened.close()
    }
  })

  // ---- test 3: tier (a) — the published address resolves, both spellings ------------------

  it('resolves the short-ID and the agentqa:// URI to the same entity at 1.0 (tier a)', async () => {
    const minted = await resolve(bundleId)
    if (minted.kind !== 'resolved') throw new Error('expected the resolved arm')

    const byShortId = await resolve('MEM-001')
    const byUri = await resolve('agentqa://memory/MEM-001')

    expect(byShortId).toEqual(minted)
    expect(byUri).toEqual(minted)

    // `entities.get` is the simple read path: the card alone, no resolution envelope.
    const card = await invokeFunction(
      host.registry,
      'entities.get',
      { ref: 'MEM-001' },
      CALLER,
    ) as EntityCard
    expect(card).toEqual(minted.card)
  })

  // ---- test 4: the never-guess floor ------------------------------------------------------

  it('answers free text through tier (b) once the entity has been sighted', async () => {
    // A sighted entity resolves free text by retrieval over the projection, not by a fallback.
    await resolve(bundleId)

    const outcome = await resolve('that bundle about checkout')

    expect(outcome).toMatchObject({ kind: 'resolved' })
    if (outcome.kind !== 'resolved') throw new Error('expected the resolved arm')
    expect(outcome.card.id).toBe('MEM-001')
    // A retrieval score, not tier (a)'s exactness.
    expect(outcome.score).toBeGreaterThan(0)
    expect(outcome.score).toBeLessThanOrEqual(1)
  })

  it('still refuses free text that no entity matches, and never offers the only one it has', async () => {
    // One checkout entity and an unrelated reference: answering with the only candidate is a guess.
    await resolve(bundleId)

    expect(await resolve('the flaky elephant migration')).toMatchObject({
      kind: 'none',
      reason: 'no-match',
    })
  })

  // ---- the maintenance-cadence sweep ------------------------------------------------

  it('sweeps the projection from the ledger without a lease and without writing it', async () => {
    await resolve(bundleId)
    const ledgerPath = join(agentQaRoot, ADDRESSING_LEDGER_DB_FILE)
    const ledgerBefore = readFileSync(ledgerPath)

    const report = await sweepEntityIndexProjection({
      agentQaRoot,
      resolveKnowledgeRoot: () => knowledgeRoot,
      // The acquisition ladder is stubbed OUT rather than left to the host: a test that
      // reached for a real model would be measuring this machine, not the sweep.
      acquireEmbedderCapability: async () => ({ kind: 'lexical-only' }),
    })

    // The entity is already current — it was projected when it was sighted — so a sweep over
    // unchanged sources examines it and writes nothing. That is the cadence being maintenance
    // rather than a periodic rebuild.
    expect(report).toEqual({ examined: 1, refreshed: 0, embedded: 0 })
    // The ledger is not a projection: the sweep reads it and leaves it byte-identical.
    expect(readFileSync(ledgerPath).equals(ledgerBefore)).toBe(true)
    // A sweep that took the writer lease could not run in a CLI process, and would leave its file.
    expect(existsSync(join(knowledgeRoot, 'memory', 'writer.lease'))).toBe(false)
  })

  // ---- the schema boundary, and the dispatch boundary --------------------------------------

  it('rejects a card whose status is not in its own kind closed union', () => {
    const valid: EntityCard = {
      kind: 'MEM',
      id: 'MEM-001',
      uri: 'agentqa://memory/MEM-001',
      title: 'Checkout summary',
      status: 'active',
      keyFacts: [],
      actions: [],
    }
    expect(EntityCardSchema.safeParse(valid).success).toBe(true)

    // `passed` is a REAL status in this vocabulary — it is RUN's. Borrowing another kind's
    // member is the failure a per-kind union exists to catch and a single flat status enum
    // would wave through.
    expect(EntityCardSchema.safeParse({ ...valid, status: 'passed' }).success).toBe(false)
    expect(EntityCardSchema.safeParse({ ...valid, status: 'invented' }).success).toBe(false)
  })

  it('publishes the two ops as declarations only — dispatch stays behind invokeFunction', async () => {
    const listed = host.registry.list(CALLER).map((entry) => entry.id)
    expect(listed).toContain('entities.resolve')
    expect(listed).toContain('entities.get')

    for (const entry of host.registry.list(CALLER)) {
      if (entry.id !== 'entities.resolve' && entry.id !== 'entities.get') continue
      expect(entry).toMatchObject({
        bindingStatus: 'bound',
        risk: { readOnly: true },
      })
      // A declaration is data: nothing runnable may be reachable off a listing.
      expect(Object.values(entry).some((value) => typeof value === 'function')).toBe(false)
    }

    const barrel = await import('@vostride/agent-qa-agent') as Record<string, unknown>
    for (const name of ['entitiesResolveSpec', 'entitiesGetSpec', 'produceEntityCard']) {
      expect(Object.hasOwn(barrel, name)).toBe(false)
    }
  })
})
