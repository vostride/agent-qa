import { rebuildAuthorizedIndex as rebuildIndex } from './fixtures/authorized-rebuild.js'
import { rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BundleOutcomeEventSchema,
  asRecordId,
  type Anchor,
  type BundleOutcomeEvent,
  type BundleRelation,
  type OriginClass,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  appendRelation,
  openKnowledgeReader,
  type BundleStoreConfig,
  type PublishBundleInput,
  type PublishBundleOutcome,
} from '../index.js'
import { publishBundle } from '../bundle-publish.test-helper.js'
import { retrieve } from '../retrieve.js'
import { EXPANSION_FRACTION_F } from '../retrieval/constants.js'
import {
  makeBundleDraftFixture,
  makeScreenStateFixture,
  scaffoldKnowledgeRoot,
} from './fixtures/bundle-fixture.js'

type PublishedBundle = Extract<PublishBundleOutcome, { kind: 'published' }>

interface FactInput {
  anchor: Anchor
  identity: string
  createdAtOrdinal: number
  originClass?: OriginClass
  summary?: string
  initialEvents?: BundleOutcomeEvent[]
  relations?: BundleRelation[]
}

const PRODUCT = 'retrieve-storefront'
const SIBLING_PRODUCT = 'retrieve-payments'

function event(
  type: 'confirmed' | 'window-close',
  identity: string,
  ordinal: number,
): BundleOutcomeEvent {
  return BundleOutcomeEventSchema.parse(
    type === 'window-close'
      ? {
          type,
          evidenceToken: `${identity}-window-close`,
          curationJobId: `${identity}-window-close-job`,
          buildOrdinal: ordinal,
          closedAtOrdinal: ordinal,
        }
      : {
          type,
          evidenceToken: `${identity}-confirmed-${ordinal}`,
          curationJobId: `${identity}-confirmed-${ordinal}-job`,
          buildOrdinal: ordinal,
          origin: 'agent-verified',
        },
  )
}

describe('composed retrieval pipeline', () => {
  let root: string
  let knowledgeRoot: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'knowledge-retrieve-pipeline-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    scaffoldKnowledgeRoot(knowledgeRoot)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function config(product = PRODUCT): BundleStoreConfig {
    return {
      knowledgeRoot,
      productKey: product,
    }
  }

  function factInput(input: FactInput): PublishBundleInput {
    return {
      draft: makeBundleDraftFixture({
        anchors: [input.anchor, { t: 'platform', platform: 'web' }],
        scope: { tier: 'product', key: PRODUCT },
        summary: input.summary ?? `${input.identity} retrieval fixture`,
        body: `${input.identity} records deterministic retrieval behavior.`,
      }),
      discriminant: {
        kind: 'fact',
        subtype: 'selector',
        elementRef: { role: 'fixture', name: input.identity },
      },
      originClass: input.originClass ?? 'agent-verified',
      createdAtOrdinal: input.createdAtOrdinal,
      screenStates: [makeScreenStateFixture(input.createdAtOrdinal % 3)],
      initialEvents: input.initialEvents ?? [],
      relations: input.relations ?? [],
      provenance: {
        mode: 'run-linked',
        runId: 'retrieve-pipeline-run',
        testId: `retrieve-${input.identity}`,
        stepIndex: input.createdAtOrdinal,
      },
      artifacts: [],
    }
  }

  function publishFact(input: FactInput, product = PRODUCT): PublishedBundle {
    const outcome = publishBundle(config(product), factInput(input))
    expect(outcome.kind).toBe('published')
    if (outcome.kind !== 'published') {
      throw new Error(`expected ${input.identity} publication, got ${outcome.kind}`)
    }
    return outcome
  }

  function relation(targetId: string, identity: string, ordinal: number): BundleRelation {
    return {
      type: 'relates-to',
      targetId,
      addedAtOrdinal: ordinal,
      curationJobId: `${identity}-relation-job`,
    }
  }

  it('applies admission, validity, collapse, diversity, and deterministic ordering', async () => {
    const anchor = { t: 'el', role: 'button', name: 'Checkout primary' } satisfies Anchor
    const agentOld = publishFact({
      anchor,
      identity: 'agent-old',
      createdAtOrdinal: 10,
      initialEvents: [event('confirmed', 'agent-old-a', 11), event('confirmed', 'agent-old-b', 12)],
    })
    const agentNew = publishFact({
      anchor,
      identity: 'agent-new',
      createdAtOrdinal: 20,
      initialEvents: [
        event('confirmed', 'agent-new-a', 21),
        event('confirmed', 'agent-new-b', 22),
        event('confirmed', 'agent-new-current', 100),
        BundleOutcomeEventSchema.parse({
          type: 'promoted',
          evidenceToken: 'agent-new-promoted-100',
          curationJobId: 'agent-new-promoted-100-job',
          buildOrdinal: 100,
        }),
      ],
    })
    const userNew = publishFact({
      anchor,
      identity: 'user-new',
      createdAtOrdinal: 8,
      originClass: 'user',
    })
    const userOld = publishFact({
      anchor,
      identity: 'user-old',
      createdAtOrdinal: 7,
      originClass: 'user',
    })
    const closed = publishFact({
      anchor,
      identity: 'closed-window',
      createdAtOrdinal: 1,
      initialEvents: [event('window-close', 'closed-window', 30)],
    })
    const sibling = publishFact(
      { anchor, identity: 'sibling-product', createdAtOrdinal: 50 },
      SIBLING_PRODUCT,
    )
    const lexicalOnly = publishFact({
      anchor: { t: 'page', route: '/lexical-only' },
      identity: 'lexical-below-floor',
      createdAtOrdinal: 60,
      originClass: 'import',
      summary: 'Checkout primary button lexical-only noise',
    })

    await rebuildIndex({ knowledgeRoot })
    const reader = openKnowledgeReader(knowledgeRoot)
    try {
      const options = { n: 12, product: PRODUCT, asOfBuild: 100 } as const
      const first = await retrieve(reader, { intent: '', anchors: [anchor] }, options)
      const second = await retrieve(reader, { intent: '', anchors: [anchor] }, options)
      const ids = first.map(({ id }) => id)

      expect(second.map(({ id }) => id)).toEqual(ids)
      expect(ids).toEqual([agentNew.id, userNew.id])
      expect(ids).not.toEqual(expect.arrayContaining([
        agentOld.id,
        userOld.id,
        closed.id,
        sibling.id,
        lexicalOnly.id,
      ]))
      expect(first).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: agentNew.id,
            servedAs: 'current',
            validity: 'current',
          }),
          expect.objectContaining({ id: userNew.id, servedAs: 'current' }),
        ]),
      )
    } finally {
      reader.close()
    }
  })

  it(
    'applies N after validity so a future fused leader cannot crowd out current truth',
    async () => {
      const anchor = { t: 'el', role: 'button', name: 'Budget ordering' } satisfies Anchor
      const trailingAnchor = { t: 'page', route: '/budget-trailing' } satisfies Anchor
      const future = publishFact({
        anchor,
        identity: 'budget-future-leader',
        createdAtOrdinal: 30,
      })
      const current = publishFact({
        anchor,
        identity: 'budget-current-tail',
        createdAtOrdinal: 10,
      })
      const trailing = publishFact({
        anchor: trailingAnchor,
        identity: 'budget-valid-trailing',
        createdAtOrdinal: 5,
      })

      expect([future.id, current.id, trailing.id].sort()).toEqual([
        future.id,
        current.id,
        trailing.id,
      ])

      await rebuildIndex({ knowledgeRoot })
      const reader = openKnowledgeReader(knowledgeRoot)
      try {
        const result = await retrieve(
          reader,
          { intent: '', anchors: [anchor, trailingAnchor] },
          { n: 1, product: PRODUCT, asOfBuild: 20 },
        )

        expect(result.map(({ id }) => id)).toEqual([current.id])
        expect(result.some(({ id }) => id === future.id)).toBe(false)
      } finally {
        reader.close()
      }
    },
  )

  it('adds one-hop results at the discounted, count-capped expansion rung', async () => {
    const seedAnchor = { t: 'el', role: 'button', name: 'Graph seed only' } satisfies Anchor
    const seed = publishFact({
      anchor: seedAnchor,
      identity: 'graph-seed',
      createdAtOrdinal: 10,
    })
    const olderNeighbor = publishFact({
      anchor: { t: 'page', route: '/older-neighbor' },
      identity: 'older-neighbor',
      createdAtOrdinal: 20,
      relations: [relation(seed.id, 'older-neighbor', 20)],
    })
    const newerNeighbor = publishFact({
      anchor: { t: 'page', route: '/newer-neighbor' },
      identity: 'newer-neighbor',
      createdAtOrdinal: 30,
      relations: [relation(seed.id, 'newer-neighbor', 30)],
    })

    await rebuildIndex({ knowledgeRoot })
    const reader = openKnowledgeReader(knowledgeRoot)
    try {
      const n = 4
      const result = await retrieve(
        reader,
        { intent: '', anchors: [seedAnchor] },
        { n, product: PRODUCT, asOfBuild: 40 },
      )
      const ids = result.map(({ id }) => id)
      const expandedIds = new Set([olderNeighbor.id, newerNeighbor.id])

      expect(ids).toContain(seed.id)
      expect(ids).toContain(newerNeighbor.id)
      expect(ids).not.toContain(olderNeighbor.id)
      expect(ids).toHaveLength(2)
      expect(result.length).toBeLessThanOrEqual(n)
      expect(ids.filter((id) => expandedIds.has(id))).toHaveLength(
        Math.ceil(EXPANSION_FRACTION_F * n),
      )
    } finally {
      reader.close()
    }
  })

  it('keeps serving withdrawn facts out while audit modes return full typed truth', async () => {
    const anchor = { t: 'flow', name: 'Audit checkout flow' } satisfies Anchor
    const activeOld = publishFact({
      anchor,
      identity: 'audit-active-old',
      createdAtOrdinal: 10,
    })
    const activeNew = publishFact({
      anchor,
      identity: 'audit-active-new',
      createdAtOrdinal: 20,
    })
    const superseded = publishFact({
      anchor,
      identity: 'audit-superseded',
      createdAtOrdinal: 5,
      initialEvents: [
        BundleOutcomeEventSchema.parse({
          type: 'superseded',
          evidenceToken: 'audit-superseded-event',
          curationJobId: 'audit-superseded-job',
          buildOrdinal: 30,
          byRecordId: asRecordId(activeNew.id),
        }),
      ],
    })

    await rebuildIndex({ knowledgeRoot })
    const reader = openKnowledgeReader(knowledgeRoot)
    try {
      const query = { intent: '', anchors: [anchor] } as const
      const serving = await retrieve(reader, query, {
        n: 10,
        product: PRODUCT,
        asOfBuild: 40,
      })
      const includeSuperseded = await retrieve(reader, query, {
        n: 10,
        product: PRODUCT,
        asOfBuild: 40,
        includeSuperseded: true,
      })
      const ranged = await retrieve(reader, query, {
        n: 10,
        product: PRODUCT,
        asOfBuild: 40,
        includeSuperseded: true,
        asOfRange: { lo: 1, hi: 40 },
      })

      expect(serving.map(({ id }) => id)).toEqual([activeNew.id])
      expect(serving.some(({ id }) => id === superseded.id)).toBe(false)
      for (const audit of [includeSuperseded, ranged]) {
        expect(audit.map(({ id }) => id)).toEqual(
          expect.arrayContaining([activeOld.id, activeNew.id, superseded.id]),
        )
        expect(audit).toHaveLength(3)
        expect(audit.every((entry) => entry.audit !== undefined)).toBe(true)
        expect(audit.find(({ id }) => id === superseded.id)).toMatchObject({
          status: 'superseded',
          audit: {
            status: 'superseded',
            openedAtOrdinal: 5,
            closedAtOrdinal: null,
          },
        })
      }
    } finally {
      reader.close()
    }
  })

  it('serves the most recent closed fact as a flagged fresh-build hypothesis', async () => {
    const anchor = { t: 'el', role: 'button', name: 'Fresh build fallback' } satisfies Anchor
    const older = publishFact({
      anchor,
      identity: 'fallback-older',
      createdAtOrdinal: 1,
      initialEvents: [event('window-close', 'fallback-older', 5)],
    })
    const newer = publishFact({
      anchor,
      identity: 'fallback-newer',
      createdAtOrdinal: 2,
      initialEvents: [event('window-close', 'fallback-newer', 10)],
    })

    await rebuildIndex({ knowledgeRoot })
    const reader = openKnowledgeReader(knowledgeRoot)
    try {
      const result = await retrieve(
        reader,
        { intent: '', anchors: [anchor] },
        { n: 10, product: PRODUCT, asOfBuild: 20 },
      )

      expect(result).toMatchObject([
        {
          id: newer.id,
          servedAs: 'prior-build-hypothesis',
          validity: 'prior-build-hypothesis',
        },
      ])
      expect(result.some(({ id }) => id === older.id)).toBe(false)
    } finally {
      reader.close()
    }
  })

  it(
    'preserves and annotates both MintUnknown peers while keeping the unknown ordinary',
    async () => {
      const anchor = { t: 'page', route: '/mint-unknown' } satisfies Anchor
      const left = publishFact({ anchor, identity: 'conflict-left', createdAtOrdinal: 10 })
      const right = publishFact({ anchor, identity: 'conflict-right', createdAtOrdinal: 11 })
      const unknownOutcome = publishBundle(config(), {
        draft: makeBundleDraftFixture({
          kind: 'unknown',
          anchors: [anchor, { t: 'platform', platform: 'web' }],
          scope: { tier: 'product', key: PRODUCT },
          summary: 'MintUnknown conflict remains unresolved',
          body: 'The conflicting observations await deterministic resolution.',
        }),
        discriminant: { kind: 'unknown', conflictRecordIds: [left.id, right.id] },
        originClass: 'agent-verified',
        createdAtOrdinal: 12,
        screenStates: [makeScreenStateFixture()],
        initialEvents: [],
        relations: [],
        provenance: {
          mode: 'run-linked',
          runId: 'retrieve-pipeline-run',
          testId: 'retrieve-mint-unknown',
          stepIndex: 12,
        },
        artifacts: [],
      })
      expect(unknownOutcome.kind).toBe('published')
      if (unknownOutcome.kind !== 'published') throw new Error('expected unknown publication')
      const unknown = unknownOutcome

      for (const peer of [left, right]) {
        expect(
          appendRelation(config(), peer.id, {
            type: 'conflicts-with',
            targetId: unknown.id,
            addedAtOrdinal: 13,
            curationJobId: `${peer.id}-conflict-job`,
          }),
        ).toEqual({ kind: 'appended' })
      }

      await rebuildIndex({ knowledgeRoot })
      const reader = openKnowledgeReader(knowledgeRoot)
      try {
        const result = await retrieve(
          reader,
          { intent: '', anchors: [anchor] },
          { n: 10, product: PRODUCT, asOfBuild: 20 },
        )
        const leftEntry = result.find(({ id }) => id === left.id)
        const rightEntry = result.find(({ id }) => id === right.id)
        const unknownEntry = result.find(({ id }) => id === unknown.id)

        expect(leftEntry?.conflict).toEqual({
          peerRecordId: right.id,
          unknownRecordId: unknown.id,
        })
        expect(rightEntry?.conflict).toEqual({
          peerRecordId: left.id,
          unknownRecordId: unknown.id,
        })
        expect(unknownEntry).toMatchObject({ kind: 'unknown' })
        expect(unknownEntry?.conflict).toBeUndefined()
      } finally {
        reader.close()
      }
    },
  )

  it('uses deterministic lexical-plus-anchor RRF in scan mode and never expands', async () => {
    const anchor = { t: 'el', role: 'button', name: 'Scan seed (3)' } satisfies Anchor
    const seed = publishFact({ anchor, identity: 'scan-seed', createdAtOrdinal: 10 })
    const closed = publishFact({
      anchor,
      identity: 'scan-closed',
      createdAtOrdinal: 5,
      initialEvents: [event('window-close', 'scan-closed', 15)],
    })
    const superseded = publishFact({
      anchor,
      identity: 'scan-superseded',
      createdAtOrdinal: 6,
      initialEvents: [
        BundleOutcomeEventSchema.parse({
          type: 'superseded',
          evidenceToken: 'scan-superseded-event',
          curationJobId: 'scan-superseded-job',
          buildOrdinal: 16,
          byRecordId: asRecordId(seed.id),
        }),
      ],
    })
    const neighbor = publishFact({
      anchor: { t: 'page', route: '/scan-neighbor' },
      identity: 'scan-neighbor',
      createdAtOrdinal: 20,
      relations: [relation(seed.id, 'scan-neighbor', 20)],
    })

    const reader = openKnowledgeReader(knowledgeRoot)
    try {
      expect(reader.source).toBe('scan')
      const query = {
        intent: '',
        anchors: [{ t: 'el', role: ' BUTTON ', name: ' scan seed (9) ' }],
      } as const
      const options = { n: 5, product: PRODUCT, asOfBuild: 20 } as const
      const first = await retrieve(reader, query, options)
      const second = await retrieve(reader, query, options)
      const audit = await retrieve(reader, query, {
        n: 10,
        product: PRODUCT,
        asOfBuild: 20,
        includeSuperseded: true,
        asOfRange: { lo: 1, hi: 20 },
      })

      expect(first.map(({ id }) => id)).toEqual([seed.id])
      expect(second.map(({ id }) => id)).toEqual([seed.id])
      expect(first.some(({ id }) => id === neighbor.id)).toBe(false)
      expect(audit.map(({ id }) => id)).toEqual(
        expect.arrayContaining([seed.id, closed.id, superseded.id]),
      )
      expect(audit).toHaveLength(3)
      expect(audit.every((entry) => entry.audit !== undefined)).toBe(true)
    } finally {
      reader.close()
    }
  })
})
