import { rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BundleOutcomeEventSchema,
  COLD_START_TRUST_DISCOUNT,
  supersessionKey,
  type Anchor,
  type BundleOutcomeEvent,
  type OriginClass,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  appendOutcomeEvent,
  openKnowledgeReader,
  rebuildIndex,
  retrieve,
  type BundleStoreConfig,
  type PublishBundleOutcome,
} from '../index.js'
import { publishBundle } from '../bundle-publish.test-helper.js'
import {
  makeBundleDraftFixture,
  makeScreenStateFixture,
  scaffoldKnowledgeRoot,
} from './fixtures/bundle-fixture.js'

type PublishedBundle = Extract<PublishBundleOutcome, { kind: 'published' }>

const PRODUCT = 'lifecycle-retrieve-storefront'
const PAGE_ANCHOR = { t: 'page', route: '/checkout' } satisfies Anchor
const PLATFORM_ANCHOR = { t: 'platform', platform: 'web' } satisfies Anchor

function event(
  type: 'confirmed' | 'promoted' | 'deprecated',
  identity: string,
  ordinal: number,
): BundleOutcomeEvent {
  return BundleOutcomeEventSchema.parse({
    type,
    evidenceToken: `${identity}-${type}-${ordinal}`,
    curationJobId: `${identity}-${type}-${ordinal}-job`,
    buildOrdinal: ordinal,
    ...(type === 'confirmed' ? { origin: 'agent-verified' } : {}),
    ...(type === 'deprecated' ? { reason: 'fixture-user-deprecated' } : {}),
  })
}

describe('379 read-side lifecycle treatments', () => {
  let root: string
  let knowledgeRoot: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'knowledge-lifecycle-retrieve-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    scaffoldKnowledgeRoot(knowledgeRoot)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function config(): BundleStoreConfig {
    return {
      knowledgeRoot,
      productKey: PRODUCT,
    }
  }

  function publishFact(input: {
    identity: string
    anchor: Anchor
    createdAtOrdinal: number
    events?: BundleOutcomeEvent[]
    originClass?: OriginClass
    withheld?: boolean
  }): PublishedBundle {
    const anchors = [input.anchor, PAGE_ANCHOR, PLATFORM_ANCHOR]
    const outcome = publishBundle(config(), {
      draft: makeBundleDraftFixture({
        anchors,
        scope: { tier: 'product', key: PRODUCT },
        summary: `${input.identity} lifecycle fact`,
        body: `${input.identity} records lifecycle serving behavior.`,
      }),
      discriminant: {
        kind: 'fact',
        subtype: 'selector',
        elementRef: { role: 'fixture', name: input.identity },
      },
      originClass: input.originClass ?? 'agent-verified',
      createdAtOrdinal: input.createdAtOrdinal,
      screenStates: [makeScreenStateFixture()],
      initialEvents: input.events ?? [],
      relations: [],
      provenance: {
        mode: 'run-linked',
        runId: 'lifecycle-retrieve-run',
        testId: `lifecycle-${input.identity}`,
        stepIndex: input.createdAtOrdinal,
        ...(input.withheld === true ? { withheld: true } : {}),
      },
      artifacts: [],
    })
    expect(outcome.kind).toBe('published')
    if (outcome.kind !== 'published') {
      throw new Error(`expected ${input.identity} publication, got ${outcome.kind}`)
    }
    return outcome
  }

  function publishThrashUnknown(
    factAnchors: readonly Anchor[],
    evidenceRecordIds: readonly string[],
    ordinal = 15,
  ): PublishedBundle {
    const marker = `thrash:${supersessionKey(factAnchors)}:window:10`
    const outcome = publishBundle(config(), {
      draft: makeBundleDraftFixture({
        kind: 'unknown',
        anchors: [{ t: 'flow', name: marker }],
        scope: { tier: 'product', key: PRODUCT },
        summary: 'Memory disabled for churning checkout anchor',
        body: JSON.stringify({
          kind: 'thrash',
          triggerKey: supersessionKey(factAnchors),
          evidenceRecordIds,
        }),
      }),
      discriminant: { kind: 'unknown', conflictRecordIds: [...evidenceRecordIds] },
      originClass: 'agent-verified',
      createdAtOrdinal: ordinal,
      screenStates: [],
      initialEvents: [event('confirmed', 'thrash-unknown', ordinal)],
      relations: evidenceRecordIds.map((targetId) => ({
        type: 'conflicts-with' as const,
        targetId,
        addedAtOrdinal: ordinal,
        curationJobId: `thrash-${targetId}-relation`,
      })),
      provenance: {
        mode: 'run-linked',
        runId: 'lifecycle-retrieve-run',
        testId: 'lifecycle-thrash-unknown',
        stepIndex: ordinal,
      },
      artifacts: [],
    })
    expect(outcome.kind).toBe('published')
    if (outcome.kind !== 'published') throw new Error('expected thrash unknown publication')
    return outcome
  }

  async function query(anchors: readonly Anchor[], audit = false) {
    const reader = openKnowledgeReader(knowledgeRoot)
    try {
      return await retrieve(
        reader,
        { intent: '', anchors },
        {
          n: 12,
          product: PRODUCT,
          asOfBuild: 20,
          ...(audit
            ? { includeSuperseded: true, asOfRange: { lo: 1, hi: 20 } }
            : {}),
        },
      )
    } finally {
      reader.close()
    }
  }

  it('suppresses an anchor group while its thrash unknown is unresolved and restores it on closure', async () => {
    const anchor = { t: 'el', role: 'button', name: 'Submit order' } satisfies Anchor
    const fact = publishFact({
      identity: 'suppressed-fact',
      anchor,
      createdAtOrdinal: 10,
      events: [event('confirmed', 'suppressed-fact', 10), event('promoted', 'suppressed-fact', 10)],
    })
    const factAnchors = [anchor, PAGE_ANCHOR, PLATFORM_ANCHOR]
    const unknown = publishThrashUnknown(factAnchors, [fact.id])

    await rebuildIndex({ knowledgeRoot })
    expect((await query([anchor])).map(({ id }) => id)).toEqual([unknown.id])

    expect(
      appendOutcomeEvent(config(), unknown.id, event('deprecated', 'thrash-closure', 20)),
    ).toEqual({ kind: 'appended' })
    await rebuildIndex({ knowledgeRoot })
    expect((await query([anchor])).map(({ id }) => id)).toEqual([fact.id])
  })

  it('keeps facts on other anchor groups of the same page', async () => {
    const unstableAnchor = {
      t: 'el',
      role: 'button',
      name: 'Submit order',
    } satisfies Anchor
    const stableAnchor = {
      t: 'el',
      role: 'button',
      name: 'Apply coupon',
    } satisfies Anchor
    const unstable = publishFact({
      identity: 'unstable-fact',
      anchor: unstableAnchor,
      createdAtOrdinal: 10,
      events: [event('confirmed', 'unstable-fact', 10), event('promoted', 'unstable-fact', 10)],
    })
    const stable = publishFact({
      identity: 'stable-fact',
      anchor: stableAnchor,
      createdAtOrdinal: 10,
      events: [event('confirmed', 'stable-fact', 10), event('promoted', 'stable-fact', 10)],
    })
    const unknown = publishThrashUnknown(
      [unstableAnchor, PAGE_ANCHOR, PLATFORM_ANCHOR],
      [unstable.id],
    )

    await rebuildIndex({ knowledgeRoot })
    const ids = (await query([unstableAnchor, stableAnchor])).map(({ id }) => id)
    expect(ids).toEqual(expect.arrayContaining([unknown.id, stable.id]))
    expect(ids).not.toContain(unstable.id)
  })

  it('attaches staleness and vetted-candidate annotations while leaving active truth clean', async () => {
    const staleAnchor = { t: 'el', role: 'button', name: 'Stale action' } satisfies Anchor
    const candidateAnchor = {
      t: 'el',
      role: 'button',
      name: 'Candidate action',
    } satisfies Anchor
    const activeAnchor = { t: 'el', role: 'button', name: 'Active action' } satisfies Anchor
    const stale = publishFact({
      identity: 'stale-active',
      anchor: staleAnchor,
      createdAtOrdinal: 10,
      events: [event('confirmed', 'stale-active', 10), event('promoted', 'stale-active', 10)],
    })
    const candidate = publishFact({
      identity: 'vetted-candidate',
      anchor: candidateAnchor,
      createdAtOrdinal: 16,
      events: [event('confirmed', 'vetted-candidate', 16)],
    })
    const active = publishFact({
      identity: 'recent-active',
      anchor: activeAnchor,
      createdAtOrdinal: 16,
      events: [event('confirmed', 'recent-active', 16), event('promoted', 'recent-active', 16)],
    })

    await rebuildIndex({ knowledgeRoot })
    const result = await query([staleAnchor, candidateAnchor, activeAnchor])
    const staleEntry = result.find(({ id }) => id === stale.id)
    const candidateEntry = result.find(({ id }) => id === candidate.id)
    const activeEntry = result.find(({ id }) => id === active.id)

    expect(staleEntry).toMatchObject({ unconfirmedSinceOrdinal: 10 })
    expect(candidateEntry).toMatchObject({
      unverified: true,
      trust: (activeEntry?.trust ?? 0) * COLD_START_TRUST_DISCOUNT,
    })
    expect(activeEntry).not.toHaveProperty('unconfirmedSinceOrdinal')
    expect(activeEntry).not.toHaveProperty('unverified')
  })

  it('bypasses memory-off suppression for audit reads', async () => {
    const anchor = { t: 'el', role: 'button', name: 'Audit suppressed' } satisfies Anchor
    const fact = publishFact({
      identity: 'audit-suppressed-fact',
      anchor,
      createdAtOrdinal: 10,
      events: [event('confirmed', 'audit-suppressed-fact', 10)],
    })
    publishThrashUnknown([anchor, PAGE_ANCHOR, PLATFORM_ANCHOR], [fact.id])

    await rebuildIndex({ knowledgeRoot })
    const audit = await query([anchor], true)
    expect(audit.find(({ id }) => id === fact.id)).toMatchObject({
      audit: { status: 'candidate' },
    })
  })

  it('never marks withheld or user-deprecated records as cold-start verified', async () => {
    const withheldAnchor = {
      t: 'el',
      role: 'button',
      name: 'Withheld action',
    } satisfies Anchor
    const deprecatedAnchor = {
      t: 'el',
      role: 'button',
      name: 'Deprecated action',
    } satisfies Anchor
    const withheld = publishFact({
      identity: 'withheld-candidate',
      anchor: withheldAnchor,
      createdAtOrdinal: 16,
      events: [event('confirmed', 'withheld-candidate', 16)],
      withheld: true,
    })
    const deprecated = publishFact({
      identity: 'user-deprecated',
      anchor: deprecatedAnchor,
      createdAtOrdinal: 16,
      originClass: 'user',
      events: [
        event('confirmed', 'user-deprecated', 16),
        event('deprecated', 'user-deprecated', 17),
      ],
    })

    await rebuildIndex({ knowledgeRoot })
    const serving = await query([withheldAnchor, deprecatedAnchor])
    const audit = await query([withheldAnchor, deprecatedAnchor], true)

    expect(serving.find(({ id }) => id === withheld.id)).not.toHaveProperty('unverified')
    expect(serving.some(({ id }) => id === deprecated.id)).toBe(false)
    expect(audit.find(({ id }) => id === deprecated.id)).not.toHaveProperty('unverified')
  })
})
